import { constants } from 'fs'
import { lstat, mkdir, open, opendir, realpath, type FileHandle } from 'fs/promises'
import { randomUUID } from 'crypto'
import { dirname, join, relative } from 'path'
import { SubscriptionFiles } from '../subscriptions/private-files'
import type { RelayStateContext } from '../context'
import type {
  RelayBackupRecoveryAction,
  RelayBackupRecoveryPlan,
  RelayBackupRecoveryRecord
} from '../../../shared/relay/backup'
import {
  BackupRecovery,
  type BackupRecoveryMoveRequest,
  type BackupFileRequest,
  type BackupFileReceipt,
  type BackupRecoveryPublishRequest
} from './recovery'
export type {
  BackupRecoveryMoveRequest,
  BackupRecoveryPublishRequest,
  BackupFileRequest,
  BackupFileReceipt
} from './recovery'
import type { RecoveryJournal, RecoveryIdentity } from './recovery-journal'
import {
  BACKUP_MAX_BYTES,
  BACKUP_MAX_FILES,
  backupDirectories,
  backupFiles,
  backupHash,
  backupPath,
  backupSnapshotSHA256,
  createBackupArchive,
  readBackupArchive,
  type BackupSnapshot,
  type BackupEntry
} from './archive'

export interface BackupRestorePlan {
  id: string
  baselineSHA256: string
  targetSHA256: string
  archiveSHA256: string
  files: number
  replacedFiles: number
  removedFiles: number
  containsSecrets: true
  preparedAt: number
}
interface StagedRestore {
  plan: BackupRestorePlan
  snapshot: BackupSnapshot
  baseline: BackupSnapshot
  directory: string
  directoryIdentity: Awaited<ReturnType<typeof lstat>>
  recovery?: RecoveryJournal
  phase: 'staged' | 'applying' | 'applied' | 'uncertain'
}
const roots: readonly string[] = [...backupDirectories, ...backupFiles]
const recheckMarker = 'recheck-pending'
const inRoot = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')

export class RelayBackupStore {
  private readonly files: SubscriptionFiles
  private readonly staged = new Map<string, StagedRestore>()
  private readonly recovery: BackupRecovery
  private readonly restoreIdentities = new Map<string, RecoveryIdentity>()
  constructor(
    private readonly context: RelayStateContext,
    private readonly adapters: {
      moveExclusive?(request: BackupRecoveryMoveRequest): Promise<void>
      publishExclusive?(request: BackupRecoveryPublishRequest): Promise<void>
      publishFile?(request: BackupFileRequest): Promise<BackupFileReceipt>
    } = {}
  ) {
    this.files = new SubscriptionFiles(context)
    this.recovery = new BackupRecovery(context, {
      snapshotAt: (directory) => this.snapshotAt(directory),
      snapshot: () => this.snapshot(),
      writeFile: (path, bytes, mode) => this.writeFile(path, bytes, mode),
      moveExclusive: adapters.moveExclusive,
      publishExclusive: adapters.publishExclusive,
      publishFile: adapters.publishFile
    })
  }
  async unresolved(): Promise<string[]> {
    return (await this.recovery.listRecoveryRecords())
      .filter(
        (record) => record.reason || !['staged', 'applied', 'rolled-back'].includes(record.phase)
      )
      .map((record) => 'restore-' + record.id)
  }
  listRecoveryRecords(): Promise<RelayBackupRecoveryRecord[]> {
    return this.recovery.listRecoveryRecords()
  }
  prepareRecovery(request: {
    id: string
    action: RelayBackupRecoveryAction
  }): Promise<RelayBackupRecoveryPlan> {
    return this.recovery.prepareRecovery(request)
  }
  commitRecovery(
    evidenceId: string,
    assertIdle: () => void
  ): Promise<'restored' | 'rolled-back' | 'uncertain'> {
    return this.recovery.commitRecovery(evidenceId, assertIdle)
  }
  discardRecovery(evidenceId?: string): void {
    this.recovery.discardRecovery(evidenceId)
  }
  async snapshot(): Promise<BackupSnapshot> {
    return this.snapshotAt(this.context.stateRoot)
  }
  private async snapshotAt(rootDirectory: string): Promise<BackupSnapshot> {
    const snapshot: BackupSnapshot = { directories: [], entries: [] }
    let bytes = 0
    if (!(await this.files.directory(rootDirectory))) return snapshot
    const visit = async (path: string): Promise<void> => {
      const relativePath = backupPath(relative(rootDirectory, path))
      const before = await lstat(path)
      if (
        before.isSymbolicLink() ||
        before.uid !== process.getuid?.() ||
        before.mode & 0o022 ||
        (await realpath(path)) !== path
      )
        throw new Error('备份数据路径或权限不安全。')
      if (snapshot.directories.length + snapshot.entries.length >= BACKUP_MAX_FILES)
        throw new Error('备份条目超限。')
      if (before.isDirectory()) {
        snapshot.directories.push(relativePath)
        for await (const child of await opendir(path)) {
          if (child.name.startsWith('.')) throw new Error('备份范围存在活动锁或未知隐藏条目。')
          await visit(join(path, child.name))
        }
      } else {
        if (!before.isFile() || before.nlink !== 1 || before.size > BACKUP_MAX_BYTES - bytes)
          throw new Error('备份文件类型或大小无效。')
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        )
        try {
          const opened = await handle.stat()
          if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
            throw new Error('备份文件已变化。')
          const chunks: Buffer[] = []
          const buffer = Buffer.alloc(65536)
          let length = 0
          while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
            if (!bytesRead) break
            length += bytesRead
            if (length > before.size) throw new Error('备份文件在读取期间增长。')
            chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
          }
          const content = Buffer.concat(chunks, length)
          const after = await handle.stat()
          if (
            content.length !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          )
            throw new Error('备份读取期间发生变化。')
          bytes += content.length
          snapshot.entries.push({
            path: relativePath,
            mode: before.mode & 0o111 ? 0o700 : 0o600,
            bytes: content
          })
        } finally {
          await handle.close()
        }
      }
      const after = await lstat(path)
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error('备份收集期间目录或文件已变化。')
    }
    for (const root of roots) {
      const path = join(rootDirectory, root)
      if (!(await this.files.directory(dirname(path)))) continue
      try {
        await lstat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      await visit(path)
    }
    return snapshot
  }
  async archive(): Promise<{
    bytes: Buffer
    sha256: string
    files: number
    containsSecrets: true
  }> {
    if ((await this.unresolved()).length)
      throw new Error('存在未完成或未知的恢复记录，不能将当前状态导出为完整备份。')
    const first = await this.snapshot()
    const before = backupSnapshotSHA256(first)
    if (backupSnapshotSHA256(await this.snapshot()) !== before)
      throw new Error('备份范围在采集期间变化，请重新准备。')
    const bytes = createBackupArchive(first)
    return { bytes, sha256: backupHash(bytes), files: first.entries.length, containsSecrets: true }
  }
  private async writeFile(path: string, bytes: Buffer, mode: BackupEntry['mode']): Promise<void> {
    const scoped = relative(join(this.context.stateRoot, 'ApplicationBackups'), path).split('/'),
      id = scoped.shift()?.replace(/^restore-/u, ''),
      directoryIdentity = id && this.restoreIdentities.get(id),
      publish = this.adapters.publishFile
    if (!id || !directoryIdentity || !publish) throw new Error('原子私有恢复文件发布尚未接通。')
    const receipt = await publish({
      namespace: 'recovery',
      id,
      directoryIdentity,
      name: scoped.join('/'),
      mode,
      bytes: bytes.toString('base64')
    })
    if (receipt.sha256 !== backupHash(bytes)) throw new Error('恢复私有文件发布摘要未确认。')
    await this.files.sync(dirname(path))
  }

  private async candidateDirectory(id: string, name: string): Promise<void> {
    const directoryIdentity = this.restoreIdentities.get(id),
      publish = this.adapters.publishFile
    if (!directoryIdentity || !publish) throw new Error('原子私有恢复目录发布尚未接通。')
    await publish({
      namespace: 'recovery',
      id,
      directoryIdentity,
      name,
      directory: true,
      mode: 0o700,
      bytes: ''
    })
  }
  private async journal(staged: StagedRestore, completed: readonly string[]): Promise<void> {
    await this.sameRestoreDirectory(staged)
    if (staged.recovery) {
      staged.recovery.phase = staged.phase
      staged.recovery.completed = [...completed]
      await this.recovery.persist(staged.directory, staged.recovery)
      return
    }
    throw new Error('旧恢复记录只读保留，不自动改写。')
  }

  private async sameRestoreDirectory(staged: StagedRestore): Promise<void> {
    await this.files.directory(staged.directory)
    const current = await lstat(staged.directory)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== staged.directoryIdentity.dev ||
      current.ino !== staged.directoryIdentity.ino ||
      current.uid !== process.getuid?.() ||
      (current.mode & 0o7777) !== 0o700 ||
      (await realpath(staged.directory)) !== staged.directory
    )
      throw new Error('本次恢复记录目录身份已变化。')
  }
  async stageRestore(bytes: Buffer, expectedBaselineSHA256?: string): Promise<BackupRestorePlan> {
    if (expectedBaselineSHA256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedBaselineSHA256))
      throw new Error('恢复基线摘要无效。')
    if ((await this.unresolved()).length)
      throw new Error('存在未完成或未知的恢复记录，请先人工核对。')
    if (this.staged.size >= 4) throw new Error('待恢复计划过多，请先结束已有恢复。')
    const { snapshot } = readBackupArchive(bytes)
    const baseline = await this.snapshot()
    if (
      expectedBaselineSHA256 !== undefined &&
      backupSnapshotSHA256(baseline) !== expectedBaselineSHA256
    )
      throw new Error('准备期间基线已变化，未接受旧的合并备份。')
    const id = randomUUID()
    const directory = join(this.context.stateRoot, 'ApplicationBackups', 'restore-' + id)
    await this.files.directory(join(this.context.stateRoot, 'ApplicationBackups'), true)
    await mkdir(directory, { mode: 0o700 })
    const directoryIdentity = await lstat(directory)
    await this.files.sync(dirname(directory))
    this.restoreIdentities.set(id, {
      dev: Number(directoryIdentity.dev),
      ino: Number(directoryIdentity.ino),
      uid: Number(directoryIdentity.uid),
      mode: Number(directoryIdentity.mode)
    })
    const candidate = join(directory, 'candidate')
    await this.candidateDirectory(id, 'candidate')
    for (const path of snapshot.directories) await this.candidateDirectory(id, 'candidate/' + path)
    for (const entry of snapshot.entries)
      await this.writeFile(join(candidate, entry.path), entry.bytes, entry.mode)
    const plan: BackupRestorePlan = {
      id,
      baselineSHA256: backupSnapshotSHA256(baseline),
      targetSHA256: backupSnapshotSHA256(snapshot),
      archiveSHA256: backupHash(bytes),
      files: snapshot.entries.length,
      replacedFiles: snapshot.entries.filter((entry) =>
        baseline.entries.some(
          (old) =>
            old.path === entry.path &&
            (old.mode !== entry.mode || backupHash(old.bytes) !== backupHash(entry.bytes))
        )
      ).length,
      removedFiles: baseline.entries.filter(
        (entry) => !snapshot.entries.some((next) => next.path === entry.path)
      ).length,
      containsSecrets: true,
      preparedAt: Date.now()
    }
    const staged: StagedRestore = {
      plan,
      snapshot,
      baseline,
      directory,
      directoryIdentity,
      phase: 'staged'
    }
    await this.writeFile(join(directory, 'archive.zip'), bytes, 0o600)
    staged.recovery = await this.recovery.initialize(
      plan,
      directory,
      {
        dev: Number(directoryIdentity.dev),
        ino: Number(directoryIdentity.ino),
        uid: Number(directoryIdentity.uid),
        mode: Number(directoryIdentity.mode)
      },
      baseline,
      snapshot
    )
    await this.journal(staged, [])
    if (backupSnapshotSHA256(await this.snapshot()) !== plan.baselineSHA256)
      throw new Error('准备期间基线已变化，未发布恢复凭据。')
    this.staged.set(id, staged)
    return structuredClone(plan)
  }
  async commitRestore(
    id: string,
    expectedBaseline: string,
    assertIdle: () => void
  ): Promise<'restored' | 'uncertain'> {
    if ((await this.unresolved()).length)
      throw new Error('存在未完成或未知的恢复记录，请先人工核对。')
    const staged = this.staged.get(id)
    if (
      !staged ||
      staged.phase !== 'staged' ||
      expectedBaseline !== staged.plan.baselineSHA256 ||
      Date.now() < staged.plan.preparedAt ||
      Date.now() - staged.plan.preparedAt > 60000
    )
      throw new Error('请重新准备本次私有数据恢复。')
    if (!staged.recovery) throw new Error('旧恢复计划不支持自动继续，请保留原件并核对。')
    this.recovery.requireExclusiveMove()
    assertIdle()
    if (backupSnapshotSHA256(await this.snapshot()) !== expectedBaseline)
      throw new Error('准备后出现未知修改，未覆盖当前数据。')
    if (
      backupSnapshotSHA256(await this.snapshotAt(join(staged.directory, 'candidate'))) !==
      staged.plan.targetSHA256
    )
      throw new Error('暂存恢复数据已变化，未覆盖当前数据。')
    const completed: string[] = []
    let mutated = false
    if (Date.now() < staged.plan.preparedAt || Date.now() - staged.plan.preparedAt > 60000)
      throw new Error('恢复准备凭据已过期。')
    try {
      await this.recovery.ensureMarker(
        staged.directory,
        staged.recovery,
        'recheck-pending',
        Buffer.from('v1\n')
      )
      staged.phase = 'applying'
      await this.journal(staged, completed)
      let expected = staged.baseline
      for (const root of roots) {
        assertIdle()
        if (backupSnapshotSHA256(await this.snapshot()) !== backupSnapshotSHA256(expected))
          throw new Error('恢复期间出现未知修改。')
        const remaining = {
          directories: staged.snapshot.directories.filter(
            (path) => !completed.some((done) => inRoot(path, done))
          ),
          entries: staged.snapshot.entries.filter(
            (entry) => !completed.some((done) => inRoot(entry.path, done))
          )
        }
        if (
          backupSnapshotSHA256(await this.snapshotAt(join(staged.directory, 'candidate'))) !==
          backupSnapshotSHA256(remaining)
        )
          throw new Error('暂存恢复数据已变化。')
        const target = join(this.context.stateRoot, root)
        const original = join(staged.directory, 'original', root)
        const oldExists =
          expected.directories.some((path) => path === root) ||
          expected.entries.some((entry) => entry.path === root)
        const newExists =
          staged.snapshot.directories.some((path) => path === root) ||
          staged.snapshot.entries.some((entry) => entry.path === root)
        if (oldExists || newExists) {
          await this.files.directory(dirname(target), true)
          await this.files.directory(dirname(original), true)
          if (oldExists) {
            await this.recovery.move(
              staged.directory,
              staged.recovery,
              root,
              'current',
              'original',
              'resume',
              assertIdle
            )
            mutated = true
          }
          if (newExists) {
            await this.recovery.move(
              staged.directory,
              staged.recovery,
              root,
              'candidate',
              'current',
              'resume',
              assertIdle
            )
            mutated = true
          }
          await this.files.sync(dirname(target))
          expected = {
            directories: [
              ...expected.directories.filter((path) => !inRoot(path, root)),
              ...staged.snapshot.directories.filter((path) => inRoot(path, root))
            ],
            entries: [
              ...expected.entries.filter((entry) => !inRoot(entry.path, root)),
              ...staged.snapshot.entries.filter((entry) => inRoot(entry.path, root))
            ]
          }
        }
        completed.push(root)
        await this.journal(staged, completed)
      }
      if (backupSnapshotSHA256(await this.snapshot()) !== staged.plan.targetSHA256)
        throw new Error('恢复后完整性未确认。')
      staged.phase = 'applied'
      if (staged.recovery) {
        staged.recovery.completed = [...completed]
        await this.recovery.finish(staged.directory, staged.recovery)
      } else await this.journal(staged, completed)
      this.staged.delete(id)
      return 'restored'
    } catch {
      const retainUncertain = async (): Promise<boolean> => {
        staged.phase = 'uncertain'
        try {
          await this.journal(staged, completed)
          return true
        } catch {
          // Keep staged archive, originals and any recheck marker for inspection.
          return false
        }
      }
      let marked = false
      let markerHandle: FileHandle | undefined,
        markerIdentity: Awaited<ReturnType<typeof lstat>> | undefined
      const binding = staged.recovery?.marker,
        markerPath = join(staged.directory, binding?.name ?? recheckMarker)
      let markerBytes = Buffer.from('v1\n')
      if (!mutated) {
        try {
          // Persist before publishing staged again: journal replacement can
          // succeed before its directory sync fails. This marker keeps that
          // ambiguous outcome blocking even after a new App/store instance.
          await this.sameRestoreDirectory(staged)
          if (binding) {
            markerHandle = await open(
              markerPath,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            )
            markerIdentity = await markerHandle.stat()
            if (
              markerIdentity.dev !== binding.identity.dev ||
              markerIdentity.ino !== binding.identity.ino ||
              markerIdentity.uid !== binding.identity.uid ||
              markerIdentity.mode !== binding.identity.mode ||
              !markerIdentity.isFile() ||
              markerIdentity.nlink !== 1 ||
              markerIdentity.size < 1 ||
              markerIdentity.size > 1024
            )
              throw new Error('恢复标记身份不符，未认领。')
            const bytes = Buffer.alloc(markerIdentity.size + 1),
              { bytesRead } = await markerHandle.read(bytes, 0, bytes.length, 0)
            if (
              bytesRead !== markerIdentity.size ||
              backupHash(bytes.subarray(0, bytesRead)) !== binding.sha256
            )
              throw new Error('恢复标记正文不符，未认领。')
            markerBytes = Buffer.from(bytes.subarray(0, bytesRead))
          } else throw new Error('恢复标记尚未绑定，保留阻塞记录。')
          marked = true
        } catch {
          /* Without a durable marker, do not attempt journal convergence. */
        }
      }
      const recorded = await retainUncertain()
      if (marked && recorded) {
        try {
          if (
            backupSnapshotSHA256(await this.snapshot()) !== staged.plan.baselineSHA256 ||
            backupSnapshotSHA256(await this.snapshotAt(join(staged.directory, 'candidate'))) !==
              staged.plan.targetSHA256
          )
            throw new Error('恢复前复核存在未知修改。')
          if (staged.recovery)
            await this.recovery.verifyUnchanged(staged.directory, staged.recovery)
          staged.phase = 'staged'
          await this.journal(staged, [])
          await this.sameRestoreDirectory(staged)
          if (!markerHandle || !markerIdentity) throw new Error('恢复复核标记未确认。')
          const current = await lstat(markerPath)
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.dev !== markerIdentity.dev ||
            current.ino !== markerIdentity.ino ||
            current.uid !== process.getuid?.() ||
            current.nlink !== 1 ||
            (current.mode & 0o7777) !== 0o600 ||
            current.size !== markerBytes.length ||
            current.mtimeMs !== markerIdentity.mtimeMs ||
            current.ctimeMs !== markerIdentity.ctimeMs
          )
            throw new Error('恢复复核标记身份已变化。')
          const checked = await open(
            markerPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          )
          try {
            const before = await checked.stat(),
              bytes = Buffer.alloc(markerBytes.length + 1),
              { bytesRead } = await checked.read(bytes, 0, bytes.length, 0),
              after = await checked.stat(),
              linked = await lstat(markerPath)
            if (
              before.dev !== markerIdentity.dev ||
              before.ino !== markerIdentity.ino ||
              !before.isFile() ||
              before.uid !== process.getuid?.() ||
              before.nlink !== 1 ||
              (before.mode & 0o7777) !== 0o600 ||
              before.size !== markerBytes.length ||
              before.mtimeMs !== markerIdentity.mtimeMs ||
              before.ctimeMs !== markerIdentity.ctimeMs ||
              after.mtimeMs !== before.mtimeMs ||
              after.ctimeMs !== before.ctimeMs ||
              linked.dev !== before.dev ||
              linked.ino !== before.ino ||
              linked.mtimeMs !== after.mtimeMs ||
              linked.ctimeMs !== after.ctimeMs ||
              bytesRead !== markerBytes.length ||
              !bytes.subarray(0, bytesRead).equals(markerBytes)
            )
              throw new Error('恢复复核标记正文或链接已变化。')
          } finally {
            await checked.close()
          }
          await this.sameRestoreDirectory(staged)
          // Preserve the owned marker: a pathname unlink cannot atomically
          // distinguish it from a concurrent replacement. Only an additional
          // receipt bound to this acknowledged journal releases the blocker.
          if (!staged.recovery) throw new Error('旧恢复标记不能自动收尾。')
          await this.recovery.settleMarker(staged.directory, staged.recovery)
        } catch {
          await retainUncertain()
        }
      }
      await markerHandle?.close().catch(() => {})
      this.staged.delete(id)
      if (!mutated) throw new Error('恢复前复核失败，当前数据未写入。')
      return 'uncertain'
    }
  }
  discard(id: string): void {
    const staged = this.staged.get(id)
    if (staged?.phase === 'staged') this.staged.delete(id)
  }
}
