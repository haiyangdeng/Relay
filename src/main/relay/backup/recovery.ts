import { constants } from 'fs'
import { lstat, open, opendir, realpath, type FileHandle } from 'fs/promises'
import { randomUUID } from 'crypto'
import { dirname, join, relative } from 'path'
import type { RelayStateContext } from '../context'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { readBinaryResource } from '../resources/source'
import type {
  RelayBackupRecoveryAction,
  RelayBackupRecoveryPlan,
  RelayBackupRecoveryRecord
} from '../../../shared/relay/backup'
import {
  BACKUP_ARCHIVE_MAX_BYTES,
  backupHash,
  backupSnapshotSHA256,
  createBackupArchive,
  readBackupArchive,
  type BackupSnapshot
} from './archive'
import type { BackupRestorePlan } from './store'
import {
  recoveryJournal,
  legacyRecoveryJournal,
  recoveryRoots,
  type RecoveryAsset,
  type RecoveryIdentity,
  type RecoveryIntent,
  type RecoveryJournal,
  type RecoveryMarker,
  type RecoveryRootState,
  type RecoverySlot
} from './recovery-journal'

const idPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const slots: readonly RecoverySlot[] = ['current', 'candidate', 'original', 'displaced']
const markers = ['recheck-pending', 'recovery-pending'] as const
const inRoot = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')
const hashJSON = (value: unknown): string => backupHash(Buffer.from(JSON.stringify(value)))
const identity = (stat: Awaited<ReturnType<typeof lstat>>): RecoveryIdentity => ({
  dev: Number(stat.dev),
  ino: Number(stat.ino),
  uid: Number(stat.uid),
  mode: Number(stat.mode)
})
const sameIdentity = (a: RecoveryIdentity, b: RecoveryIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode
const subset = (snapshot: BackupSnapshot, root: string): BackupSnapshot => ({
  directories: snapshot.directories.filter((path) => inRoot(path, root)),
  entries: snapshot.entries.filter((entry) => inRoot(entry.path, root))
})
const present = (snapshot: BackupSnapshot, root: string): boolean =>
  snapshot.directories.includes(root) || snapshot.entries.some((entry) => entry.path === root)
const initial = (root: RecoveryRootState): boolean =>
  root.baseline === (root.before ? 'current' : null) &&
  root.target === (root.after ? 'candidate' : null)
const applied = (root: RecoveryRootState): boolean =>
  root.baseline === (root.before ? 'original' : null) &&
  root.target === (root.after ? 'current' : null)
const rolledBack = (root: RecoveryRootState): boolean =>
  root.baseline === (root.before ? 'current' : null) && root.target !== 'current'

interface ObservedSlot {
  snapshot: BackupSnapshot
  identities: Map<string, RecoveryIdentity>
}
interface Loaded {
  directory: string
  journal: RecoveryJournal
  effective: RecoveryJournal
  recordSHA256: string
  fingerprint: string
  currentSHA256: string
  baseline: BackupSnapshot
  target: BackupSnapshot
}
interface RecoveryAdapters {
  snapshotAt(directory: string): Promise<BackupSnapshot>
  snapshot(): Promise<BackupSnapshot>
  writeFile(path: string, bytes: Buffer, mode: 0o600 | 0o700): Promise<void>
  moveExclusive?(request: BackupRecoveryMoveRequest): Promise<void>
  publishExclusive?(request: BackupRecoveryPublishRequest): Promise<void>
  publishFile?(request: BackupFileRequest): Promise<BackupFileReceipt>
}
export interface BackupFileRequest {
  namespace: 'recovery' | 'migration' | 'backup-account' | 'backup-receipt'
  directory?: true
  id: string
  directoryIdentity: RecoveryIdentity
  name: string
  mode: 0o600 | 0o700
  bytes: string
}
export interface BackupFileReceipt {
  identity: RecoveryIdentity
  sha256: string
}
export interface BackupRecoveryPublishRequest {
  id: string
  directoryIdentity: RecoveryIdentity
  revision: number
  parentSHA256: string | null
  bytes: string
}
export interface BackupRecoveryMoveRequest {
  journalRevision: number
  journalSHA256: string
  id: string
  root: string
  operation: 'park-original' | 'activate-candidate' | 'park-restored' | 'restore-original'
  directoryIdentity: RecoveryIdentity
  sourceIdentity: RecoveryIdentity
}

// Main-process private store capability. The renderer never supplies paths,
// snapshot bytes, root lists or a journal. Every recovery is a fresh proof.
export class BackupRecovery {
  private readonly files: SubscriptionFiles
  private readonly knownJournals = new Map<string, Set<string>>()
  private readonly proofs = new Map<
    string,
    { plan: RelayBackupRecoveryPlan; fingerprint: string }
  >()
  constructor(
    private readonly context: RelayStateContext,
    private readonly adapters: RecoveryAdapters
  ) {
    this.files = new SubscriptionFiles(context)
  }
  directory(id: string): string {
    if (!idPattern.test(id)) throw new Error('恢复记录ID无效。')
    return join(this.context.stateRoot, 'ApplicationBackups', 'restore-' + id)
  }
  requireExclusiveMove(): void {
    if (
      !this.adapters.moveExclusive ||
      !this.adapters.publishExclusive ||
      !this.adapters.publishFile
    )
      throw new Error('原子恢复移动尚未接通，未执行恢复。')
  }
  private slotDirectory(directory: string, slot: RecoverySlot): string {
    return slot === 'current' ? this.context.stateRoot : join(directory, slot)
  }
  async sameDirectory(directory: string, expected: RecoveryIdentity): Promise<void> {
    if (!(await this.files.directory(directory))) throw new Error('恢复目录缺失。')
    const current = await lstat(directory)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameIdentity(identity(current), expected) ||
      current.uid !== process.getuid?.() ||
      (current.mode & 0o7777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error('恢复记录目录身份已变化。')
  }
  private async chain(directory: string): Promise<{
    journal: RecoveryJournal
    revision: number
    sha256: string
    names: string[]
    history: Map<string, RecoveryJournal>
  }> {
    const names: string[] = []
    for await (const member of await opendir(directory)) {
      if (!member.name.startsWith('journal-')) continue
      if (!/^journal-[0-9]{6}\.json$/u.test(member.name) || !member.isFile())
        throw new Error('恢复修订文件名或类型无效。')
      names.push(member.name)
      if (names.length > 512) throw new Error('恢复修订数量超限。')
    }
    names.sort()
    let raw = await readBinaryResource(join(directory, 'journal.json'), true, 65536),
      journal = recoveryJournal(JSON.parse(raw.toString('utf8'))),
      sha256 = backupHash(raw),
      size = raw.length
    const history = new Map([[sha256, journal]])
    const anchor = hashJSON({
      plan: journal.plan,
      baselineArchiveSHA256: journal.baselineArchiveSHA256,
      directoryIdentity: journal.directoryIdentity,
      assets: journal.roots.map(({ root, before, after }) => ({ root, before, after }))
    })
    for (let i = 0; i < names.length; ++i) {
      if (names[i] !== 'journal-' + String(i + 1).padStart(6, '0') + '.json')
        throw new Error('恢复修订不连续。')
      raw = await readBinaryResource(join(directory, names[i]), true, 65536)
      size += raw.length
      if (size > 32 * 1024 * 1024) throw new Error('恢复修订字节超限。')
      const frame: unknown = JSON.parse(raw.toString('utf8'))
      if (!frame || typeof frame !== 'object' || Array.isArray(frame))
        throw new Error('恢复修订无效。')
      const item = frame as Record<string, unknown>
      if (
        Object.keys(item).sort().join(',') !== 'journal,parentSHA256,sequence,version' ||
        item.version !== 1 ||
        item.sequence !== i + 1 ||
        item.parentSHA256 !== sha256
      )
        throw new Error('恢复修订父摘要不符。')
      journal = recoveryJournal(item.journal)
      if (
        hashJSON({
          plan: journal.plan,
          baselineArchiveSHA256: journal.baselineArchiveSHA256,
          directoryIdentity: journal.directoryIdentity,
          assets: journal.roots.map(({ root, before, after }) => ({ root, before, after }))
        }) !== anchor
      )
        throw new Error('恢复修订改变了初始基线。')
      sha256 = backupHash(raw)
      history.set(sha256, journal)
    }
    const known = this.knownJournals.get(journal.plan.id)
    if (known && !known.has(sha256)) throw new Error('恢复日志出现未知修改。')
    return { journal, revision: names.length, sha256, names, history }
  }
  async persist(directory: string, value: RecoveryJournal): Promise<void> {
    const journal = recoveryJournal(value)
    await this.sameDirectory(directory, journal.directoryIdentity)
    let previous: Awaited<ReturnType<BackupRecovery['chain']>> | undefined
    try {
      previous = await this.chain(directory)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        this.knownJournals.has(journal.plan.id)
      )
        throw error
    }
    const revision = previous ? previous.revision + 1 : 0
    if (revision > 512) throw new Error('恢复修订数量超限。')
    const bytes = JSON.stringify(
        previous
          ? {
              version: 1,
              sequence: revision,
              parentSHA256: previous.sha256,
              journal
            }
          : journal
      ),
      nextSHA256 = backupHash(Buffer.from(bytes)),
      publish = this.adapters.publishExclusive
    if (!publish) throw new Error('原子恢复日志发布尚未接通，未执行恢复。')
    this.knownJournals.set(
      journal.plan.id,
      new Set(previous ? [previous.sha256, nextSHA256] : [nextSHA256])
    )
    // Native pins the owned record directory and uses openat(O_EXCL). No
    // mutable head, replace, rename, unlink or path-based fallback is allowed.
    await publish({
      id: journal.plan.id,
      directoryIdentity: journal.directoryIdentity,
      revision,
      parentSHA256: previous?.sha256 ?? null,
      bytes
    })
    await this.files.sync(directory)
    await this.sameDirectory(directory, journal.directoryIdentity)
    if ((await this.chain(directory)).sha256 !== nextSHA256) throw new Error('恢复日志发布未确认。')
    this.knownJournals.set(journal.plan.id, new Set([nextSHA256]))
  }
  async initialize(
    plan: BackupRestorePlan,
    directory: string,
    directoryIdentity: RecoveryIdentity,
    baseline: BackupSnapshot,
    target: BackupSnapshot
  ): Promise<RecoveryJournal> {
    const bytes = createBackupArchive(baseline)
    await this.adapters.writeFile(join(directory, 'baseline.zip'), bytes, 0o600)
    const roots: RecoveryRootState[] = []
    for (const root of recoveryRoots) {
      const asset = async (
        snapshot: BackupSnapshot,
        base: string
      ): Promise<RecoveryAsset | null> =>
        present(snapshot, root)
          ? {
              sha256: backupSnapshotSHA256(subset(snapshot, root)),
              identity: identity(await lstat(join(base, root)))
            }
          : null
      const before = await asset(baseline, this.context.stateRoot),
        after = await asset(target, join(directory, 'candidate'))
      roots.push({
        root,
        before,
        after,
        baseline: before ? 'current' : null,
        target: after ? 'candidate' : null
      })
    }
    return recoveryJournal({
      version: 2,
      plan,
      baselineArchiveSHA256: backupHash(bytes),
      directoryIdentity,
      phase: 'staged',
      direction: 'resume',
      roots,
      completed: []
    })
  }
  private async marker(
    directory: string,
    journal: RecoveryJournal
  ): Promise<RecoveryMarker | undefined> {
    let found: RecoveryMarker | undefined
    for (const name of markers) {
      const path = join(directory, name)
      try {
        const stat = await lstat(path),
          expected = journal.marker
        if (
          found ||
          !expected ||
          expected.name !== name ||
          !stat.isFile() ||
          stat.nlink !== 1 ||
          !sameIdentity(identity(stat), expected.identity) ||
          backupHash(await readBinaryResource(path, true, 1024)) !== expected.sha256
        )
          throw new Error('恢复阻塞标记不属于本次记录。')
        found = expected
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (journal.marker && !found) throw new Error('恢复阻塞标记缺失，未认领替代文件。')
    return found
  }
  private async receipt(
    directory: string,
    name: string,
    journal: RecoveryJournal,
    history?: Map<string, RecoveryJournal>
  ): Promise<void> {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readBinaryResource(join(directory, name), true, 8192)
      )
    )
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('恢复收尾回执无效。')
    const raw = value as Record<string, unknown>,
      historical =
        typeof raw.journalSHA256 === 'string'
          ? (history ?? (await this.chain(directory)).history).get(raw.journalSHA256)
          : undefined
    if (
      Object.keys(raw).sort().join(',') !== 'journalSHA256,marker,version' ||
      raw.version !== 1 ||
      typeof raw.journalSHA256 !== 'string' ||
      name !== 'settled-' + raw.journalSHA256 + '.json' ||
      !historical ||
      !['staged', 'applied', 'rolled-back'].includes(historical.phase) ||
      historical.intent ||
      !historical.marker ||
      !journal.marker ||
      hashJSON(historical.marker) !== hashJSON(journal.marker) ||
      hashJSON(recoveryJournal({ ...historical, marker: raw.marker }).marker) !==
        hashJSON(journal.marker)
    )
      throw new Error('恢复收尾回执与日志或阻塞标记不符。')
  }
  private async settled(
    directory: string,
    journal: RecoveryJournal,
    recordSHA256: string
  ): Promise<boolean> {
    if (!journal.marker || !['staged', 'applied', 'rolled-back'].includes(journal.phase))
      return false
    const name = 'settled-' + recordSHA256 + '.json'
    try {
      await lstat(join(directory, name))
      await this.receipt(directory, name, journal)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  private async recordInventory(directory: string, journal: RecoveryJournal): Promise<void> {
    const allowed = new Set([
      'journal.json',
      'archive.zip',
      'baseline.zip',
      ...slots.slice(1),
      ...markers
    ])
    const chain = await this.chain(directory)
    for (const name of chain.names) allowed.add(name)
    let count = 0
    for await (const member of await opendir(directory)) {
      if (++count > allowed.size + 64) throw new Error('恢复收尾回执过多。')
      if (/^settled-[a-f0-9]{64}\.json$/u.test(member.name))
        await this.receipt(directory, member.name, journal, chain.history)
      else if (!allowed.has(member.name)) throw new Error('恢复目录含未知内容。')
    }
  }
  private async observeSlot(directory: string, slot: RecoverySlot): Promise<ObservedSlot> {
    const base = this.slotDirectory(directory, slot)
    if (slot !== 'current' && (await this.files.directory(base))) {
      let count = 0
      const visit = async (path: string): Promise<void> => {
        for await (const child of await opendir(path)) {
          if (++count > 2100) throw new Error('恢复暂存条目过多。')
          const next = join(path, child.name),
            name = relative(base, next)
          if (
            child.isSymbolicLink() ||
            !recoveryRoots.some((root) => inRoot(name, root) || root.startsWith(name + '/'))
          )
            throw new Error('恢复暂存含未知路径。')
          if (child.isDirectory()) {
            if (!(await this.files.directory(next))) throw new Error()
            await visit(next)
          }
        }
      }
      await visit(base)
    }
    const snapshot = await this.adapters.snapshotAt(base),
      identities = new Map<string, RecoveryIdentity>()
    for (const root of recoveryRoots)
      if (present(snapshot, root)) identities.set(root, identity(await lstat(join(base, root))))
    return { snapshot, identities }
  }
  private matches(
    roots: RecoveryRootState[],
    observations: Map<RecoverySlot, ObservedSlot>,
    allowCurrentChanges = false
  ): boolean {
    for (const root of roots)
      for (const slot of slots) {
        if (slot === 'current' && allowCurrentChanges) continue
        const expected =
            root.baseline === slot ? root.before : root.target === slot ? root.after : null,
          observed = observations.get(slot)
        if (!observed) return false
        const actual = observed.identities.get(root.root)
        if (
          expected
            ? !actual ||
              !sameIdentity(actual, expected.identity) ||
              backupSnapshotSHA256(subset(observed.snapshot, root.root)) !== expected.sha256
            : !!actual
        )
          return false
      }
    return true
  }
  private moved(value: RecoveryJournal, intent: RecoveryIntent): RecoveryJournal {
    const next = structuredClone(value),
      root = next.roots.find((item) => item.root === intent.root)
    if (!root) throw new Error()
    if (root.baseline === intent.from && root.before) {
      if (intent.to !== 'current' && intent.to !== 'original') throw new Error()
      root.baseline = intent.to
    } else if (root.target === intent.from && root.after) {
      if (!['candidate', 'current', 'displaced'].includes(intent.to)) throw new Error()
      root.target = intent.to as typeof root.target
    } else throw new Error('恢复移动意图与角色不符。')
    delete next.intent
    return next
  }
  private async load(id: string, allowCurrentChanges = false): Promise<Loaded> {
    const directory = this.directory(id)
    if (!(await this.files.directory(directory))) throw new Error('恢复记录不存在。')
    const chain = await this.chain(directory),
      journal = chain.journal
    if (journal.plan.id !== id) throw new Error('恢复日志ID不符。')
    await this.sameDirectory(directory, journal.directoryIdentity)
    await this.recordInventory(directory, journal)
    const blocker = await this.marker(directory, journal)
    const archive = await readBinaryResource(
        join(directory, 'archive.zip'),
        true,
        BACKUP_ARCHIVE_MAX_BYTES
      ),
      baselineArchive = await readBinaryResource(
        join(directory, 'baseline.zip'),
        true,
        BACKUP_ARCHIVE_MAX_BYTES
      )
    if (
      backupHash(archive) !== journal.plan.archiveSHA256 ||
      backupHash(baselineArchive) !== journal.baselineArchiveSHA256
    )
      throw new Error('恢复归档摘要已变化。')
    const target = readBackupArchive(archive).snapshot,
      baseline = readBackupArchive(baselineArchive).snapshot
    if (
      backupSnapshotSHA256(target) !== journal.plan.targetSHA256 ||
      backupSnapshotSHA256(baseline) !== journal.plan.baselineSHA256
    )
      throw new Error('恢复归档与日志基线不符。')
    for (const root of journal.roots)
      for (const [asset, snapshot] of [
        [root.before, baseline],
        [root.after, target]
      ] as const)
        if (
          present(snapshot, root.root) !== !!asset ||
          (asset && asset.sha256 !== backupSnapshotSHA256(subset(snapshot, root.root)))
        )
          throw new Error('恢复根基线与归档不符。')
    const observations = new Map<RecoverySlot, ObservedSlot>()
    for (const slot of slots)
      observations.set(
        slot,
        allowCurrentChanges && slot === 'current'
          ? { snapshot: { directories: [], entries: [] }, identities: new Map() }
          : await this.observeSlot(directory, slot)
      )
    let effective = structuredClone(journal)
    if (!this.matches(journal.roots, observations, allowCurrentChanges)) {
      if (!journal.intent) throw new Error('当前恢复布局出现未知修改。')
      effective = this.moved(journal, journal.intent)
      if (!this.matches(effective.roots, observations, allowCurrentChanges))
        throw new Error('在途恢复步骤的实际布局不明确。')
    } else delete effective.intent
    await this.sameDirectory(directory, journal.directoryIdentity)
    if ((await this.chain(directory)).sha256 !== chain.sha256)
      throw new Error('读取期间恢复日志已变化。')
    const recordSHA256 = chain.sha256,
      known = this.knownJournals.get(id)
    if (known && !known.has(recordSHA256)) throw new Error('恢复日志出现未知修改。')
    this.knownJournals.set(id, new Set([recordSHA256]))
    const current = observations.get('current')
    if (!current) throw new Error('当前恢复布局缺失。')
    return {
      directory,
      journal,
      effective,
      recordSHA256,
      fingerprint: hashJSON({
        recordSHA256,
        directory: journal.directoryIdentity,
        marker: blocker ?? null,
        slots: slots.map((slot) => {
          const observed = observations.get(slot)
          if (!observed) throw new Error('恢复布局缺失。')
          return {
            slot,
            snapshot: backupSnapshotSHA256(observed.snapshot),
            identities: [...observed.identities]
          }
        })
      }),
      currentSHA256: backupSnapshotSHA256(current.snapshot),
      baseline,
      target
    }
  }
  async verifyUnchanged(directory: string, journal: RecoveryJournal): Promise<void> {
    const loaded = await this.load(journal.plan.id)
    if (loaded.directory !== directory || !loaded.effective.roots.every(initial))
      throw new Error('恢复已有移动。')
    Object.assign(journal, loaded.effective)
    delete journal.intent
  }
  async move(
    directory: string,
    journal: RecoveryJournal,
    rootName: string,
    from: RecoverySlot,
    to: RecoverySlot,
    action: RelayBackupRecoveryAction,
    assertIdle: () => void
  ): Promise<void> {
    const loaded = await this.load(journal.plan.id)
    if (loaded.directory !== directory || hashJSON(loaded.journal) !== hashJSON(journal))
      throw new Error('恢复日志修订已变化。')
    const root = journal.roots.find((item) => item.root === rootName),
      asset = root?.baseline === from ? root.before : root?.target === from ? root.after : null
    if (!root || !asset) throw new Error('恢复步骤来源缺失。')
    const source = join(this.slotDirectory(directory, from), rootName),
      destination = join(this.slotDirectory(directory, to), rootName)
    assertIdle()
    journal.direction = action
    journal.intent = {
      action,
      root: rootName,
      from,
      to,
      identity: asset.identity,
      sha256: asset.sha256
    }
    await this.persist(directory, journal)
    await this.load(journal.plan.id)
    assertIdle()
    try {
      await lstat(destination)
      throw new Error('恢复目标含未知内容，未覆盖。')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.sameDirectory(directory, journal.directoryIdentity)
    if (!sameIdentity(identity(await lstat(source)), asset.identity))
      throw new Error('恢复来源身份已变化。')
    const move = this.adapters.moveExclusive,
      operation =
        from === 'current' && to === 'original'
          ? 'park-original'
          : from === 'candidate' && to === 'current'
            ? 'activate-candidate'
            : from === 'current' && to === 'displaced'
              ? 'park-restored'
              : from === 'original' && to === 'current'
                ? 'restore-original'
                : undefined
    if (!move || !operation) throw new Error('原子恢复移动尚未接通。')
    const head = await this.chain(directory)
    await move(
      structuredClone({
        journalRevision: head.revision,
        journalSHA256: head.sha256,
        id: journal.plan.id,
        root: rootName,
        operation,
        directoryIdentity: journal.directoryIdentity,
        sourceIdentity: asset.identity
      })
    )
    await this.files.sync(dirname(source))
    if (dirname(source) !== dirname(destination)) await this.files.sync(dirname(destination))
    const next = this.moved(journal, journal.intent)
    // Verify the post-move layout before acknowledging the operation.
    const actual = await this.load(journal.plan.id)
    if (hashJSON(actual.effective.roots) !== hashJSON(next.roots))
      throw new Error('恢复移动未确认。')
    Object.assign(journal, next)
    delete journal.intent
    await this.persist(directory, journal)
  }
  async listRecoveryRecords(): Promise<RelayBackupRecoveryRecord[]> {
    const parent = join(this.context.stateRoot, 'ApplicationBackups')
    if (!(await this.files.directory(parent))) return []
    const result: RelayBackupRecoveryRecord[] = []
    for await (const member of await opendir(parent)) {
      if (!member.name.startsWith('restore-') || !idPattern.test(member.name.slice(8))) continue
      if (result.length >= 200) throw new Error('恢复记录过多。')
      const id = member.name.slice(8),
        record: RelayBackupRecoveryRecord = {
          id,
          version: 'unknown',
          phase: 'unknown',
          actions: [],
          containsSecrets: true
        }
      try {
        const directory = this.directory(id)
        if (!(await this.files.directory(directory))) throw new Error()
        const recordBytes = await readBinaryResource(join(directory, 'journal.json'), true, 65536),
          raw = JSON.parse(recordBytes.toString('utf8'))
        if (raw.version === 1) {
          record.version = 1
          const legacy = legacyRecoveryJournal(raw)
          if (legacy.plan.id !== id) throw new Error('旧恢复记录ID不符。')
          record.phase = legacy.phase
          if (['applying', 'uncertain'].includes(legacy.phase))
            record.reason = 'legacy-recovery-requires-review'
          for (const name of markers)
            try {
              await lstat(join(directory, name))
              record.reason = 'legacy-marker-requires-review'
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
        } else {
          const chain = await this.chain(directory),
            journal = chain.journal
          if (journal.plan.id !== id) throw new Error()
          record.version = 2
          record.phase = journal.phase
          await this.sameDirectory(directory, journal.directoryIdentity)
          await this.recordInventory(directory, journal)
          const marker = await this.marker(directory, journal)
          const pendingSettlement =
            (marker || ['applied', 'rolled-back'].includes(journal.phase)) &&
            !(await this.settled(directory, journal, chain.sha256))
          if (pendingSettlement) {
            record.reason = 'pending-recovery-settlement'
            // A terminal body without its acknowledged receipt is still an
            // interrupted operation, rather than an accepted terminal state.
            if (['staged', 'applied'].includes(journal.phase)) record.phase = 'uncertain'
            else if (journal.phase === 'rolled-back') record.phase = 'rolling-back'
          }
          // Completed data may be edited normally. Immutable archives and parked
          // slots must still match: an old receipt cannot hide a partial rollback.
          if (!pendingSettlement && ['staged', 'applied', 'rolled-back'].includes(journal.phase))
            await this.load(id, true)
          if (record.phase === 'staged') record.actions = ['resume']
          else if (record.phase === 'applied') record.actions = ['rollback']
          else if (
            record.phase === 'rolling-back' ||
            (record.phase === 'uncertain' && journal.direction === 'rollback')
          )
            record.actions = ['rollback']
          else if (['applying', 'uncertain'].includes(record.phase))
            record.actions = ['resume', 'rollback']
        }
      } catch {
        record.actions = []
        record.reason = 'record-integrity-unconfirmed'
      }
      result.push(record)
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  }
  private async otherUnresolved(id: string): Promise<void> {
    if (
      (await this.listRecoveryRecords()).some(
        (record) =>
          record.id !== id &&
          (record.reason || !['staged', 'applied', 'rolled-back'].includes(record.phase))
      )
    )
      throw new Error('还有其他未确认的恢复记录。')
  }
  async prepareRecovery(raw: {
    id: string
    action: RelayBackupRecoveryAction
  }): Promise<RelayBackupRecoveryPlan> {
    this.discardRecovery()
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join(',') !== 'action,id' ||
      !idPattern.test(raw.id) ||
      !['resume', 'rollback'].includes(raw.action)
    )
      throw new Error('恢复核对参数无效。')
    await this.otherUnresolved(raw.id)
    const record = (await this.listRecoveryRecords()).find((record) => record.id === raw.id)
    if (!record || record.version !== 2 || !record.actions.includes(raw.action))
      throw new Error('此记录不能执行所选恢复操作。')
    const loaded = await this.load(raw.id),
      preparedAt = Date.now(),
      plan: RelayBackupRecoveryPlan = {
        evidenceId: randomUUID(),
        id: raw.id,
        action: raw.action,
        recordSHA256: loaded.recordSHA256,
        baselineSHA256: loaded.journal.plan.baselineSHA256,
        targetSHA256: loaded.journal.plan.targetSHA256,
        currentSHA256: loaded.currentSHA256,
        files: (raw.action === 'resume' ? loaded.target : loaded.baseline).entries.length,
        containsSecrets: true,
        preparedAt,
        expiresAt: preparedAt + 60000
      }
    this.proofs.set(plan.evidenceId, { plan, fingerprint: loaded.fingerprint })
    return structuredClone(plan)
  }
  discardRecovery(evidenceId?: string): void {
    if (evidenceId) this.proofs.delete(evidenceId)
    else this.proofs.clear()
  }
  async ensureMarker(
    directory: string,
    journal: RecoveryJournal,
    name: RecoveryMarker['name'] = 'recovery-pending',
    bytes: Buffer = Buffer.from(randomUUID())
  ): Promise<void> {
    if (await this.marker(directory, journal)) return
    await this.sameDirectory(directory, journal.directoryIdentity)
    const publish = this.adapters.publishFile
    if (!publish) throw new Error('原子私有恢复文件发布尚未接通。')
    const receipt = await publish({
      namespace: 'recovery',
      id: journal.plan.id,
      directoryIdentity: journal.directoryIdentity,
      name,
      mode: 0o600,
      bytes: bytes.toString('base64')
    })
    if (receipt.sha256 !== backupHash(bytes)) throw new Error('恢复阻塞标记摘要未确认。')
    journal.marker = { name, identity: receipt.identity, sha256: receipt.sha256 }
    await this.persist(directory, journal)
  }

  async settleMarker(directory: string, journal: RecoveryJournal): Promise<void> {
    await this.sameDirectory(directory, journal.directoryIdentity)
    const marker = await this.marker(directory, journal)
    if (!marker) throw new Error('恢复阻塞标记未确认。')
    const chain = await this.chain(directory),
      recordSHA256 = chain.sha256,
      known = this.knownJournals.get(journal.plan.id)
    if (
      !known ||
      known.size !== 1 ||
      !known.has(recordSHA256) ||
      hashJSON(chain.journal) !== hashJSON(recoveryJournal(journal))
    )
      throw new Error('恢复日志尚未确认落盘。')
    const name = 'settled-' + recordSHA256 + '.json'
    if (!(await this.settled(directory, journal, recordSHA256))) {
      const publish = this.adapters.publishFile
      if (!publish) throw new Error('原子私有恢复文件发布尚未接通。')
      await publish({
        namespace: 'recovery',
        id: journal.plan.id,
        directoryIdentity: journal.directoryIdentity,
        name,
        mode: 0o600,
        bytes: Buffer.from(
          JSON.stringify({ version: 1, journalSHA256: recordSHA256, marker })
        ).toString('base64')
      })
    }
    await this.sameDirectory(directory, journal.directoryIdentity)
    await this.marker(directory, journal)
    await this.receipt(directory, name, journal)
  }
  async finish(directory: string, journal: RecoveryJournal): Promise<void> {
    let held: FileHandle | undefined
    try {
      await this.ensureMarker(directory, journal)
      const marker = await this.marker(directory, journal)
      if (!marker) throw new Error('恢复阻塞标记未确认。')
      held = await open(
        join(directory, marker.name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      const actual = await this.load(journal.plan.id),
        complete =
          journal.direction === 'resume'
            ? actual.effective.roots.every(applied)
            : actual.effective.roots.every(rolledBack),
        expected =
          journal.direction === 'resume' ? journal.plan.targetSHA256 : journal.plan.baselineSHA256
      if (!complete || actual.currentSHA256 !== expected) throw new Error('恢复最终基线未确认。')
      journal.phase = journal.direction === 'resume' ? 'applied' : 'rolled-back'
      delete journal.intent
      await this.persist(directory, journal)
      await this.sameDirectory(directory, journal.directoryIdentity)
      const current = await this.marker(directory, journal)
      if (!current || !sameIdentity(identity(await held.stat()), current.identity))
        throw new Error('恢复阻塞标记身份已变化。')
      await this.settleMarker(directory, journal)
    } finally {
      await held?.close()
    }
  }
  async commitRecovery(
    evidenceId: string,
    assertIdle: () => void
  ): Promise<'restored' | 'rolled-back' | 'uncertain'> {
    const proof = this.proofs.get(evidenceId)
    this.proofs.delete(evidenceId)
    if (!proof || Date.now() < proof.plan.preparedAt || Date.now() >= proof.plan.expiresAt)
      throw new Error('恢复核对凭据已失效。')
    this.requireExclusiveMove()
    assertIdle()
    await this.otherUnresolved(proof.plan.id)
    const loaded = await this.load(proof.plan.id)
    if (loaded.fingerprint !== proof.fingerprint) throw new Error('确认期间恢复数据或日志已变化。')
    if (Date.now() < proof.plan.preparedAt || Date.now() >= proof.plan.expiresAt)
      throw new Error('恢复核对凭据已失效。')
    const journal = loaded.effective,
      directory = loaded.directory,
      action = proof.plan.action
    journal.direction = action
    journal.phase = action === 'resume' ? 'applying' : 'rolling-back'
    try {
      await this.ensureMarker(directory, journal)
      await this.persist(directory, journal)
      const roots = action === 'resume' ? journal.roots : [...journal.roots].reverse()
      for (const item of roots) {
        assertIdle()
        if (action === 'resume') {
          if (item.baseline === 'current')
            await this.move(
              directory,
              journal,
              item.root,
              'current',
              'original',
              action,
              assertIdle
            )
          const root = journal.roots.find((root) => root.root === item.root)
          if (!root) throw new Error('恢复根缺失。')
          if (root.target === 'candidate')
            await this.move(
              directory,
              journal,
              item.root,
              'candidate',
              'current',
              action,
              assertIdle
            )
        } else {
          if (item.target === 'current')
            await this.move(
              directory,
              journal,
              item.root,
              'current',
              'displaced',
              action,
              assertIdle
            )
          const root = journal.roots.find((root) => root.root === item.root)
          if (!root) throw new Error('恢复根缺失。')
          if (root.baseline === 'original')
            await this.move(
              directory,
              journal,
              item.root,
              'original',
              'current',
              action,
              assertIdle
            )
        }
        if (action === 'resume')
          journal.completed = recoveryRoots.slice(0, recoveryRoots.indexOf(item.root) + 1)
        await this.persist(directory, journal)
      }
      assertIdle()
      await this.finish(directory, journal)
      return action === 'resume' ? 'restored' : 'rolled-back'
    } catch {
      journal.phase = 'uncertain'
      try {
        await this.persist(directory, journal)
      } catch {
        /* Preserve intent, archives and originals. */
      }
      return 'uncertain'
    }
  }
}
