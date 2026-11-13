import { randomUUID } from 'crypto'
import { lstat, readdir, realpath } from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import {
  legacyRelayInspectRequest,
  legacyRelayPrepareRequest,
  type LegacyRelayInspection,
  type LegacyRelayMigrationReport
} from '../../../shared/relay/legacy-relay'
export type {
  LegacyRelayOrigin,
  LegacyRelayInspection,
  LegacyRelayMigrationReport
} from '../../../shared/relay/legacy-relay'
import {
  ProfileStore,
  type LegacyProfileInventory,
  type LegacyProfileSource
} from '../profiles/store'
import {
  BACKUP_ARCHIVE_MAX_BYTES,
  BACKUP_MAX_BYTES,
  backupHash,
  backupSnapshotSHA256,
  createBackupArchive,
  type BackupSnapshot
} from './archive'
import { RelayBackupStore } from './store'

export interface PreparedLegacyRelayMigration {
  archiveBytes: Buffer
  originalArchiveBytes: Buffer
  expectedBaselineSHA256: string
  report: LegacyRelayMigrationReport
}
interface InspectionProof {
  public: LegacyRelayInspection
  store: ProfileStore
  inventory: LegacyProfileInventory
}
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u

// Main owns `home` and must obtain explicit native consent before inspect().
// No renderer path, implicit directory scan, network or active-profile change.
export function createLegacyRelayMigration(input: { home: string; now?(): number }) {
  const sourceHome = input.home,
    now = input.now ?? Date.now,
    waiters: (() => void)[] = []
  // Constructor validation is pure: it does not read or create either root.
  new ProfileStore({
    home: sourceHome,
    stateRoot: join(sourceHome, 'Library/Application Support/Relay')
  })
  let proof: InspectionProof | undefined,
    pending = false,
    activeId: string | undefined,
    epoch = 0
  const begin = (): void => {
    if (pending) throw new Error('请等待本次旧Relay检查或转换结束。')
    pending = true
  }
  const end = (): void => {
    pending = false
    activeId = undefined
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const check = (signal: AbortSignal, operationEpoch: number, preparedAt: number): void => {
    if (signal.aborted || epoch !== operationEpoch) throw new Error('旧Relay迁移已取消。')
    if (now() < preparedAt || now() - preparedAt >= 60000)
      throw new Error('旧Relay检查已过期，请重新检查。')
  }
  return {
    isBusy: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    cancel(inspectionId?: string): void {
      if (
        inspectionId !== undefined &&
        (typeof inspectionId !== 'string' || !uuid.test(inspectionId))
      )
        throw new Error('旧Relay检查凭据无效。')
      if (
        inspectionId !== undefined &&
        inspectionId !== proof?.public.inspectionId &&
        inspectionId !== activeId
      )
        return
      epoch++
      proof = undefined
    },
    async inspect(raw: unknown, signal: AbortSignal): Promise<LegacyRelayInspection> {
      const { origin } = legacyRelayInspectRequest(raw)
      begin()
      proof = undefined
      const operationEpoch = ++epoch,
        preparedAt = now(),
        inspectionId = randomUUID()
      activeId = inspectionId
      try {
        check(signal, operationEpoch, preparedAt)
        const store = new ProfileStore({
            home: sourceHome,
            stateRoot: join(sourceHome, 'Library/Application Support', origin)
          }),
          inventory = await store.listLegacy()
        check(signal, operationEpoch, preparedAt)
        const result: LegacyRelayInspection = {
          inspectionId,
          origin,
          sourceSHA256: backupHash(Buffer.from(JSON.stringify({ origin, inventory }))),
          preparedAt,
          expiresAt: preparedAt + 60000,
          profiles: inventory.profiles.map(({ profile, revision }) => ({ ...profile, revision })),
          incomplete: inventory.incomplete,
          warnings: [...inventory.warnings]
        }
        proof = { public: result, store, inventory }
        return structuredClone(result)
      } finally {
        end()
      }
    },
    async prepare(
      raw: unknown,
      target: { baseline: BackupSnapshot; temporaryHome: string; signal: AbortSignal }
    ): Promise<PreparedLegacyRelayMigration> {
      const request = legacyRelayPrepareRequest(raw),
        current = proof,
        { baseline, temporaryHome, signal } = target
      if (!current || request.inspectionId !== current.public.inspectionId)
        throw new Error('旧Relay检查凭据已失效。')
      begin()
      proof = undefined
      activeId = request.inspectionId
      const operationEpoch = epoch,
        preparedAt = current.public.preparedAt,
        assertCurrent = (): void => check(signal, operationEpoch, preparedAt)
      try {
        assertCurrent()
        const expectedBaselineSHA256 = backupSnapshotSHA256(baseline),
          selections = request.profiles.map((selection) => {
            const known = current.inventory.profiles.find(
              ({ profile }) => profile.id === selection.id
            )
            if (
              !known ||
              known.profile.sha256 !== selection.sha256 ||
              known.revision !== selection.revision
            )
              throw new Error('所选旧配置不属于本次已验证来源。')
            return { selection, identity: known.identity }
          }),
          home = await lstat(temporaryHome)
        if (
          !home.isDirectory() ||
          home.isSymbolicLink() ||
          home.uid !== process.getuid?.() ||
          (home.mode & 0o7777) !== 0o700 ||
          (await realpath(temporaryHome)) !== temporaryHome ||
          (await readdir(temporaryHome)).length
        )
          throw new Error('旧Relay转换仅使用独占的空私有临时home。')
        assertCurrent()
        const selected: LegacyProfileSource[] = []
        let originalBytes = 0
        for (const { selection, identity } of selections) {
          const source = await current.store.readLegacy(selection, identity)
          assertCurrent()
          originalBytes += Buffer.byteLength(source.text) + Buffer.byteLength(source.metadata)
          if (originalBytes > BACKUP_MAX_BYTES) throw new Error('所选旧配置原件合计超限。')
          selected.push(source)
        }
        const context = {
            home: temporaryHome,
            stateRoot: join(temporaryHome, 'Library/Application Support/Relay')
          },
          profiles = new ProfileStore(context),
          originals = new AdmZip(),
          expectedGenerated = new Map<string, Buffer>(),
          report: LegacyRelayMigrationReport = {
            format: 'relay-legacy-profiles-v1',
            origin: current.public.origin,
            sourceSHA256: current.public.sourceSHA256,
            originalArchiveSHA256: '',
            containsSecrets: true,
            profiles: [],
            warnings: [...current.public.warnings]
          }
        for (const source of selected) {
          assertCurrent()
          const saved = await profiles.save(source.profile.name, source.text)
          assertCurrent()
          const directory = 'Configurations/' + saved.id
          if (
            baseline.entries.some((entry) => entry.path.startsWith(directory + '/')) ||
            baseline.directories.includes(directory)
          )
            throw new Error('新迁移UUID与当前配置冲突。')
          expectedGenerated.set(directory + '/profile.yaml', Buffer.from(source.text))
          expectedGenerated.set(
            directory + '/metadata.json',
            Buffer.from(JSON.stringify({ version: 1, ...saved }))
          )
          originals.addFile(
            'Profiles/' + source.profile.id + '/metadata.json',
            Buffer.from(source.metadata)
          )
          originals.addFile(
            'Profiles/' + source.profile.id + '/profile.yaml',
            Buffer.from(source.text)
          )
          report.profiles.push({
            legacyId: source.profile.id,
            legacySHA256: source.profile.sha256,
            legacyRevision: source.revision,
            profileId: saved.id,
            profileSHA256: saved.sha256
          })
        }
        originals.addFile(
          'source-manifest.json',
          Buffer.from(
            JSON.stringify({
              format: 'relay-legacy-profile-originals',
              version: 1,
              origin: report.origin,
              sourceSHA256: report.sourceSHA256,
              profiles: report.profiles.map(({ legacyId, legacySHA256, legacyRevision }) => ({
                id: legacyId,
                sha256: legacySHA256,
                revision: legacyRevision
              }))
            })
          )
        )
        const originalArchiveBytes = originals.toBuffer()
        if (originalArchiveBytes.length > BACKUP_ARCHIVE_MAX_BYTES)
          throw new Error('旧Relay原件归档超限，未截断或生成恢复候选。')
        report.originalArchiveSHA256 = backupHash(originalArchiveBytes)
        const generated = await new RelayBackupStore(context).snapshot(),
          allowedDirectories = new Set([
            'Configurations',
            ...report.profiles.map((profile) => 'Configurations/' + profile.profileId)
          ])
        assertCurrent()
        if (
          generated.entries.length !== expectedGenerated.size ||
          generated.entries.some(
            (entry) =>
              !expectedGenerated.get(entry.path)?.equals(entry.bytes) || entry.mode !== 0o600
          ) ||
          generated.directories.length !== allowedDirectories.size ||
          generated.directories.some((directory) => !allowedDirectories.has(directory))
        )
          throw new Error('旧Relay转换暂存存在未知或已改变的内容。')
        const entries = new Map<string, BackupSnapshot['entries'][number]>(
          baseline.entries.map((entry) => [
            entry.path,
            { ...entry, bytes: Buffer.from(entry.bytes) }
          ])
        )
        for (const entry of generated.entries) {
          if (entries.has(entry.path)) throw new Error('旧Relay迁移拒绝替换当前条目。')
          entries.set(entry.path, entry)
        }
        const afterHome = await lstat(temporaryHome)
        if (
          afterHome.dev !== home.dev ||
          afterHome.ino !== home.ino ||
          afterHome.uid !== home.uid ||
          (afterHome.mode & 0o7777) !== 0o700 ||
          (await realpath(temporaryHome)) !== temporaryHome
        )
          throw new Error('旧Relay转换home身份已变化。')
        for (const { selection, identity } of selections) {
          await current.store.readLegacy(selection, identity)
          assertCurrent()
        }
        if (backupSnapshotSHA256(baseline) !== expectedBaselineSHA256)
          throw new Error('旧Relay转换期间当前基线输入已变化。')
        const archiveBytes = createBackupArchive({
          directories: [...new Set([...baseline.directories, ...generated.directories])],
          entries: [...entries.values()]
        })
        assertCurrent()
        return { archiveBytes, originalArchiveBytes, expectedBaselineSHA256, report }
      } finally {
        end()
      }
    }
  }
}
