import { types } from 'util'
import { constants, fstatSync, lstatSync, readdirSync, unlinkSync, type Stats } from 'fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'fs/promises'
import { join } from 'path'
import type { TrustedSmartModel } from './smart-models'
import type { SmartStateStore } from './smart-state-store'
import {
  smartStateDigest,
  smartStateKey,
  smartStateSchema,
  type SmartStateFileData,
  type SmartStatePath
} from './smart-state-schema'

export interface SmartLearningContext {
  readonly profileUUID: string
  readonly store: SmartStateStore
  // This is a separate session/restore lease, not the UI action generation.
  assertOwner(): void
  mayPersist(): boolean
}
export interface SmartLearningBinding {
  readonly profileUUID: string
  readonly key: string
  readonly collectCSV: boolean
}
export interface SmartLearningStopResult {
  readonly status: 'persisted' | 'retained'
  readonly retainedEvidence: true
  readonly revision?: string
  readonly cleanupFailed?: boolean
}
type Entry = {
  name: string
  file: FileHandle
  creator: Stats
  mutable: boolean
  sha256: string
  size: number
  sealed?: Stats
  removed?: boolean
}
type Snapshot = {
  files: SmartStateFileData[]
  facts: Map<Entry, Stats>
}
const invalid = (): Error => new Error('本次Smart学习状态身份、来源或保存条件变化；原件保留。')
const sameDirectory = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode
const sameIdentity = (a: Stats, b: Stats): boolean => sameDirectory(a, b) && a.nlink === b.nlink
const stable = (a: Stats, b: Stats): boolean =>
  sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

export function smartCollectCSV(parsed: Record<string, unknown>): boolean {
  const groups = parsed['proxy-groups']
  if (!Array.isArray(groups)) throw invalid()
  let collect = false
  for (const group of groups) {
    if (!group || typeof group !== 'object' || group.type !== 'smart') continue
    if (group.collectdata !== undefined && typeof group.collectdata !== 'boolean') throw invalid()
    collect ||= group.collectdata === true
  }
  return collect
}

// Ordinary-UID internal file owner. It grants no process or system authority.
// The caller invokes finish only after its held parser/main child is reaped.
export class SmartLearningRuntime {
  readonly binding: Readonly<SmartLearningBinding>
  private readonly entries = new Map<string, Entry>()
  private ready = false
  private finishing: Promise<SmartLearningStopResult> | undefined
  private closed = false
  private readonly previousRevision: string | null
  private constructor(
    private readonly directory: string,
    private readonly root: FileHandle,
    private readonly rootIdentity: Stats,
    private prepared: Awaited<ReturnType<SmartStateStore['prepare']>> | undefined,
    private readonly context: SmartLearningContext,
    collectCSV: boolean
  ) {
    this.binding = Object.freeze({
      profileUUID: context.profileUUID,
      key: smartStateKey(context.profileUUID),
      collectCSV
    })
    this.previousRevision = prepared?.receipt.previousRevision ?? null
  }
  static async prepare(
    directory: string,
    parsed: Record<string, unknown>,
    context: SmartLearningContext
  ): Promise<SmartLearningRuntime> {
    // Capture values and method references before the first await. This is a
    // session capability, not a pointer to a UI/current-profile DTO.
    const owner = Object.freeze({
      profileUUID: context.profileUUID,
      store: context.store,
      assertOwner: context.assertOwner,
      mayPersist: context.mayPersist
    })
    const key = smartStateKey(owner.profileUUID)
    const collectCSV = smartCollectCSV(parsed),
      prepared = await owner.store.prepare(owner.profileUUID, collectCSV)
    if (prepared.receipt.key !== key) throw invalid()
    const root = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    let runtime: SmartLearningRuntime | undefined
    try {
      runtime = new SmartLearningRuntime(
        directory,
        root,
        await root.stat(),
        prepared,
        owner,
        collectCSV
      )
      runtime.assertOwner()
      await runtime.checkRoot()
      await prepared.recheck()
      for (const item of prepared.copyFiles()) await runtime.create(item.path, item.bytes, true)
      await root.sync()
      return runtime
    } catch (error) {
      if (runtime) await runtime.closeFiles()
      else await root.close()
      throw error
    }
  }
  assertOwner(): void {
    if (this.closed) throw invalid()
    const returned: unknown = this.context.assertOwner()
    if (returned !== undefined) {
      if (types.isPromise(returned))
        void Promise.prototype.then.call(returned, undefined, () => undefined)
      throw invalid()
    }
  }
  private assertDirectory(info: Stats): void {
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o700 ||
      !sameDirectory(this.rootIdentity, info)
    )
      throw invalid()
  }
  private async checkRoot(): Promise<void> {
    this.assertDirectory(await this.root.stat())
    this.assertDirectory(await lstat(this.directory))
    if ((await realpath(this.directory)) !== this.directory) throw invalid()
  }
  private assertRegular(info: Stats): void {
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o600 ||
      info.nlink !== 1 ||
      info.size < 0 ||
      info.size > smartStateSchema.fileByteLimit
    )
      throw invalid()
  }
  private allowedAsset(name: string): boolean {
    return (
      name === 'config.yaml' || name === 'Model.bin' || /^reload-[a-f0-9-]{36}\.json$/u.test(name)
    )
  }
  registerModel(file: FileHandle, pin: TrustedSmartModel): void {
    this.register('Model.bin', file, pin.sha256, pin.size, false)
  }
  private register(
    name: string,
    file: FileHandle,
    sha256: string,
    size: number,
    mutable: boolean
  ): Entry {
    this.assertOwner()
    if (this.finishing) throw invalid()
    if (
      this.entries.has(name) ||
      (mutable ? !['cache.db', 'smart_weight_data.csv'].includes(name) : !this.allowedAsset(name))
    )
      throw invalid()
    const creator = fstatSync(file.fd)
    this.assertRegular(creator)
    if (creator.size !== 0 || !stable(creator, lstatSync(join(this.directory, name))))
      throw invalid()
    const entry = { name, file, creator, sha256, size, mutable }
    this.entries.set(name, entry)
    return entry
  }
  private async create(name: string, bytes: Buffer, mutable: boolean): Promise<void> {
    this.assertOwner()
    if (this.finishing) throw invalid()
    const file = await open(join(this.directory, name), 'wx+', 0o600)
    let transferred = false
    try {
      const entry = this.register(name, file, smartStateDigest(bytes), bytes.length, mutable)
      transferred = true
      await file.writeFile(bytes)
      await file.sync()
      const captured = await this.read(entry)
      if (
        captured.bytes.length !== bytes.length ||
        smartStateDigest(captured.bytes) !== entry.sha256
      )
        throw invalid()
      entry.sealed = captured.info
    } finally {
      if (!transferred) await file.close()
    }
  }
  async writeImmutable(name: string, bytes: Buffer): Promise<void> {
    await this.create(name, Buffer.from(bytes), false)
  }
  async sealPendingAssets(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.mutable || entry.sealed) continue
      if (this.ready) throw invalid()
      const captured = await this.read(entry)
      if (captured.bytes.length !== entry.size || smartStateDigest(captured.bytes) !== entry.sha256)
        throw invalid()
      entry.sealed = captured.info
    }
  }
  async verifyBeforeLaunch(): Promise<void> {
    this.assertOwner()
    // Only a launch freshness check; never reused as the stop/save lease.
    if (!this.prepared) throw invalid()
    await this.prepared.recheck()
    await this.sealPendingAssets()
    await this.snapshot()
    this.assertOwner()
  }
  markReady(): void {
    this.assertOwner()
    this.ready = true
    this.prepared = undefined
  }
  assertReload(profileUUID: string | undefined, parsed: Record<string, unknown>): void {
    this.assertOwner()
    if (
      profileUUID !== this.binding.profileUUID ||
      smartCollectCSV(parsed) !== this.binding.collectCSV
    )
      throw new Error('Smart学习状态绑定当前配置及采集开关；请明确停止后重新启动。')
  }
  private async read(entry: Entry): Promise<{ bytes: Buffer; info: Stats }> {
    const before = await entry.file.stat()
    this.assertRegular(before)
    if (
      !sameIdentity(entry.creator, before) ||
      !stable(before, await lstat(join(this.directory, entry.name))) ||
      (!entry.mutable && entry.sealed && !stable(entry.sealed, before))
    )
      throw invalid()
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < buffer.length) {
      const part = await entry.file.read(buffer, size, buffer.length - size, size)
      if (!part.bytesRead) break
      size += part.bytesRead
    }
    const after = await entry.file.stat()
    if (
      size !== before.size ||
      !stable(before, after) ||
      !stable(after, await lstat(join(this.directory, entry.name)))
    )
      throw invalid()
    const bytes = buffer.subarray(0, size)
    if (!entry.mutable && (size !== entry.size || smartStateDigest(bytes) !== entry.sha256))
      throw invalid()
    if (entry.name === 'smart_weight_data.csv') {
      if (
        size < smartStateSchema.csvHeaderBytes ||
        smartStateDigest(bytes.subarray(0, smartStateSchema.csvHeaderBytes)) !==
          smartStateSchema.csvHeaderSHA256
      )
        throw invalid()
    }
    return { bytes, info: after }
  }
  private assertNames(names: string[]): void {
    const expected = new Set(
      [...this.entries.values()].filter((entry) => !entry.removed).map((entry) => entry.name)
    )
    for (const name of names) {
      if (name === 'api.sock') {
        // This is a residual type/size constraint, not creator/peer adoption.
        // It is never read for state, registered as owned or unlinked here.
        const socket = lstatSync(join(this.directory, name))
        if (
          !socket.isSocket() ||
          socket.uid !== process.getuid?.() ||
          (socket.mode & 0o7777) !== 0o666
        )
          throw invalid()
      } else if (!expected.delete(name)) throw invalid()
    }
    if (expected.size) throw invalid()
  }
  private async snapshot(): Promise<Snapshot> {
    this.assertOwner()
    await this.checkRoot()
    this.assertNames(await readdir(this.directory))
    const facts = new Map<Entry, Stats>(),
      files: SmartStateFileData[] = []
    let total = 0
    for (const entry of this.entries.values()) {
      if (entry.removed) continue
      const captured = await this.read(entry)
      facts.set(entry, captured.info)
      if (entry.mutable) {
        total += captured.bytes.length
        if (total > smartStateSchema.totalByteLimit) throw invalid()
        files.push({ path: entry.name as SmartStatePath, bytes: captured.bytes })
      }
    }
    this.assertSnapshot({ files, facts })
    return { files, facts }
  }
  private assertSnapshot(snapshot: Snapshot): void {
    this.assertOwner()
    const current = [...this.entries.values()].filter((entry) => !entry.removed)
    if (
      current.length !== snapshot.facts.size ||
      current.some((entry) => !snapshot.facts.has(entry))
    )
      throw invalid()
    this.assertDirectory(fstatSync(this.root.fd))
    this.assertDirectory(lstatSync(this.directory))
    this.assertNames(readdirSync(this.directory))
    for (const [entry, expected] of snapshot.facts) {
      if (
        !stable(expected, fstatSync(entry.file.fd)) ||
        !stable(expected, lstatSync(join(this.directory, entry.name)))
      )
        throw invalid()
    }
  }
  finish(normalOwnedClose: boolean): Promise<SmartLearningStopResult> {
    this.finishing ??= this.finishOnce(normalOwnedClose)
    return this.finishing
  }
  private async finishOnce(normalOwnedClose: boolean): Promise<SmartLearningStopResult> {
    let report: SmartLearningStopResult = { status: 'retained', retainedEvidence: true }
    try {
      if (normalOwnedClose && this.ready && this.context.mayPersist()) {
        const snapshot = await this.snapshot()
        const revision = await this.context.store.commit(
          this.binding.key,
          this.previousRevision,
          snapshot.files,
          () => {
            if (!this.context.mayPersist()) throw invalid()
            this.assertSnapshot(snapshot)
          }
        )
        report = { status: 'persisted', retainedEvidence: true, revision }
        // Head ACK is known. Validate the whole current layout before the first
        // known unlink. Unknown/CAS/snapshot failures above delete nothing.
        this.assertSnapshot(snapshot)
        for (const [entry, expected] of snapshot.facts) {
          if (
            !stable(expected, fstatSync(entry.file.fd)) ||
            !stable(expected, lstatSync(join(this.directory, entry.name)))
          )
            throw invalid()
          unlinkSync(join(this.directory, entry.name))
          entry.removed = true
        }
        await this.root.sync()
      }
    } catch {
      if (report.status === 'persisted') report = { ...report, cleanupFailed: true }
    }
    if (!(await this.closeFiles())) report = { ...report, cleanupFailed: true }
    return Object.freeze(report)
  }
  private async closeFiles(): Promise<boolean> {
    this.closed = true
    let okay = true
    for (const file of [...this.entries.values()].map((entry) => entry.file).concat(this.root)) {
      try {
        await file.close()
      } catch {
        okay = false
      }
    }
    return okay
  }
}
