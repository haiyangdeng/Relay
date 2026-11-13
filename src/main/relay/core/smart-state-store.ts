import { randomUUID } from 'crypto'
import { constants, fstatSync, lstatSync, readdirSync, renameSync, type Stats } from 'fs'
import { lstat, mkdir, open, readdir, type FileHandle } from 'fs/promises'
import { join, relative } from 'path'
import { types } from 'util'
import { KeyedWriteQueue } from '../../utils/safeFile'
import type { RelayStateContext } from '../context'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { parseTunHostFrame } from '../tun/wire-json'
import {
  smartStateCSVHeader,
  smartStateDigest,
  smartStateKey,
  smartStateSchema,
  type SmartStateFile,
  type SmartStateFileData,
  type SmartStatePath,
  type SmartStateSeedV1
} from './smart-state-schema'

const writes = new KeyedWriteQueue()
const metadataLimit = 16384
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const invalid = (): Error => new Error('Smart状态记录缺失、损坏或身份变化；原件保留。')
const sameDirectory = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode
const sameFile = (a: Stats, b: Stats): boolean =>
  sameDirectory(a, b) &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs
interface Fact {
  path: string
  info: Stats
  directory: boolean
}
interface Master {
  revision: string | null
  facts: Fact[]
  data: SmartStateFileData[]
  absentPath?: string
}
interface Held {
  fact: Fact
  file: FileHandle
}
export interface PreparedSmartState {
  readonly receipt: SmartStateSeedV1
  copyFiles(): SmartStateFileData[]
  recheck(): Promise<void>
}
export class SmartStateConflict extends Error {
  constructor() {
    super('Smart状态修订已变化；未覆盖旧状态。')
  }
}
export class SmartStateWriteUncertain extends Error {
  constructor(readonly attemptedRevision: string) {
    super('Smart状态写入或同步未确认；旧版本与本次记录均保留，不自动重试。')
  }
}
function fields(raw: unknown, names: string): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== names
  )
    throw invalid()
  return raw as Record<string, unknown>
}
function fileShape(info: Stats, maximum: number): void {
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    info.nlink !== 1 ||
    (info.mode & 0o7777) !== 0o600 ||
    info.size < 0 ||
    info.size > maximum
  )
    throw invalid()
}
function checkData(input: readonly SmartStateFileData[], copy: boolean): SmartStateFileData[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 2) throw invalid()
  let total = 0
  const names = new Set<string>()
  const result: SmartStateFileData[] = []
  for (const file of input) {
    if (!file || Object.keys(file).sort().join(',') !== 'bytes,path') throw invalid()
    const { path, bytes } = file
    if (
      !['cache.db', 'smart_weight_data.csv'].includes(path) ||
      names.has(path) ||
      !Buffer.isBuffer(bytes) ||
      bytes.length > smartStateSchema.fileByteLimit
    )
      throw invalid()
    names.add(path)
    total += bytes.length
    if (total > smartStateSchema.totalByteLimit) throw invalid()
    if (
      path === 'smart_weight_data.csv' &&
      (bytes.length < smartStateSchema.csvHeaderBytes ||
        smartStateDigest(bytes.subarray(0, smartStateSchema.csvHeaderBytes)) !==
          smartStateSchema.csvHeaderSHA256)
    )
      throw invalid()
    result.push({ path, bytes: copy ? Buffer.from(bytes) : bytes })
  }
  if (!names.has('cache.db')) throw invalid()
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
const metadata = (files: readonly SmartStateFileData[]): SmartStateFile[] =>
  files.map(({ path, bytes }) => ({ path, sha256: smartStateDigest(bytes), size: bytes.length }))
function expectedFiles(value: unknown): SmartStateFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throw invalid()
  let total = 0
  return value.map((raw: unknown, index) => {
    const v = fields(raw, 'path,sha256,size')
    if (
      v.path !== (index === 0 ? 'cache.db' : 'smart_weight_data.csv') ||
      !digest(v.sha256) ||
      !Number.isSafeInteger(v.size) ||
      Number(v.size) < (index === 0 ? 0 : smartStateSchema.csvHeaderBytes) ||
      Number(v.size) > smartStateSchema.fileByteLimit
    )
      throw invalid()
    total += Number(v.size)
    if (total > smartStateSchema.totalByteLimit) throw invalid()
    return { path: v.path as SmartStatePath, sha256: v.sha256, size: Number(v.size) }
  })
}

// Main-only storage. A shared queue covers separate instances in this process;
// the final held-identity fence is not an OS CAS against malicious other code.
// Only closed, caller-verified Buffer snapshots may be committed. This store
// does not prove child shutdown, host restoration, source permission or flush.
export class SmartStateStore {
  private readonly files: SubscriptionFiles
  private readonly directory: string
  constructor(private readonly context: RelayStateContext) {
    this.files = new SubscriptionFiles(context)
    this.directory = join(context.stateRoot, 'SmartState')
  }
  private root(key: string): string {
    if (!digest(key)) throw invalid()
    return join(this.directory, key)
  }
  private async directoryFact(path: string): Promise<Fact> {
    if (!(await this.files.directory(path))) throw invalid()
    const info = await lstat(path)
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o022 ||
      ((path === this.directory || path.startsWith(this.directory + '/')) &&
        (info.mode & 0o7777) !== 0o700)
    )
      throw invalid()
    return { path, info, directory: true }
  }
  private async parents(key: string): Promise<{ facts: Fact[]; absentPath?: string }> {
    const facts: Fact[] = []
    let path = this.context.home
    for (const part of ['', ...relative(path, this.root(key)).split('/')]) {
      if (part) path = join(path, part)
      try {
        await lstat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (path === this.context.home) throw invalid()
        return { facts, absentPath: path }
      }
      facts.push(await this.directoryFact(path))
    }
    return { facts }
  }
  private async read(path: string, maximum: number): Promise<{ bytes: Buffer; fact: Fact }> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await file.stat()
      fileShape(before, maximum)
      const buffer = Buffer.alloc(before.size + 1)
      let size = 0
      while (size < buffer.length) {
        const part = await file.read(buffer, size, buffer.length - size, size)
        if (!part.bytesRead) break
        size += part.bytesRead
      }
      if (size !== before.size) throw invalid()
      const bytes = buffer.subarray(0, size)
      const after = await file.stat()
      if (!sameFile(before, after) || !sameFile(after, await lstat(path))) throw invalid()
      return { bytes, fact: { path, info: after, directory: false } }
    } finally {
      await file.close()
    }
  }
  private async validateFacts(facts: Fact[]): Promise<void> {
    for (const fact of facts) {
      const current = await lstat(fact.path)
      if (!(fact.directory ? sameDirectory : sameFile)(fact.info, current)) throw invalid()
    }
  }
  private async load(key: string): Promise<Master> {
    const parents = await this.parents(key)
    if (parents.absentPath) return { ...parents, revision: null, data: [] }
    const root = this.root(key),
      names = (await readdir(root)).sort()
    if (names.join(',') !== 'head.json,versions') throw invalid()
    const facts = parents.facts,
      versions = join(root, 'versions')
    facts.push(await this.directoryFact(versions))
    const head = await this.read(join(root, 'head.json'), metadataLimit),
      h = fields(parseTunHostFrame(head.bytes, metadataLimit), 'key,revision,version')
    if (h.version !== 1 || h.key !== key || !digest(h.revision)) throw invalid()
    facts.push(head.fact)
    const versionRoot = join(versions, h.revision)
    facts.push(await this.directoryFact(versionRoot))
    const record = await this.read(join(versionRoot, 'manifest.json'), metadataLimit),
      v = fields(parseTunHostFrame(record.bytes, metadataLimit), 'files,id,key,parent,version')
    if (
      smartStateDigest(record.bytes) !== h.revision ||
      v.version !== 1 ||
      v.key !== key ||
      typeof v.id !== 'string' ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v.id) ||
      (v.parent !== null && !digest(v.parent))
    )
      throw invalid()
    facts.push(record.fact)
    const pins = expectedFiles(v.files),
      inventory = ['manifest.json', ...pins.map((pin) => pin.path)].sort()
    if ((await readdir(versionRoot)).sort().join(',') !== inventory.join(',')) throw invalid()
    const data: SmartStateFileData[] = []
    for (const pin of pins) {
      const file = await this.read(join(versionRoot, pin.path), smartStateSchema.fileByteLimit)
      if (file.bytes.length !== pin.size || smartStateDigest(file.bytes) !== pin.sha256)
        throw invalid()
      facts.push(file.fact)
      data.push({ path: pin.path, bytes: file.bytes })
    }
    checkData(data, false)
    await this.validateFacts(facts)
    if (
      (await readdir(root)).sort().join(',') !== names.join(',') ||
      (await readdir(versionRoot)).sort().join(',') !== inventory.join(',')
    )
      throw invalid()
    return { revision: h.revision, facts, data }
  }
  async prepare(profileUUID: string, collectCSV: boolean): Promise<PreparedSmartState> {
    const key = smartStateKey(profileUUID)
    if (typeof collectCSV !== 'boolean') throw invalid()
    return writes.run(this.root(key), async () => {
      const current = await this.load(key)
      const data: SmartStateFileData[] = [
        { path: 'cache.db', bytes: current.data[0]?.bytes ?? Buffer.alloc(0) }
      ]
      if (collectCSV)
        data.push({
          path: 'smart_weight_data.csv',
          bytes:
            current.data.find((v) => v.path === 'smart_weight_data.csv')?.bytes ??
            smartStateCSVHeader()
        })
      const receipt = Object.freeze({
        version: 1 as const,
        key,
        previousRevision: current.revision,
        files: Object.freeze(metadata(data).map((v) => Object.freeze(v)))
      })
      return Object.freeze({
        receipt,
        copyFiles: () => data.map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) })),
        recheck: () =>
          writes.run(this.root(key), async () => {
            const fresh = await this.load(key)
            if (
              fresh.revision !== current.revision ||
              fresh.absentPath !== current.absentPath ||
              fresh.facts.length !== current.facts.length ||
              current.facts.some(
                (v, i) =>
                  v.path !== fresh.facts[i].path ||
                  !(v.directory ? sameDirectory : sameFile)(v.info, fresh.facts[i].info)
              )
            )
              throw new SmartStateConflict()
          })
      })
    })
  }
  private async hold(facts: Fact[], held: Held[]): Promise<void> {
    for (const fact of facts) {
      if (held.some((item) => item.fact.path === fact.path)) continue
      const file = await open(
        fact.path,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (fact.directory ? constants.O_DIRECTORY : constants.O_NONBLOCK)
      )
      held.push({ fact, file })
      if (!(fact.directory ? sameDirectory : sameFile)(fact.info, await file.stat()))
        throw invalid()
    }
  }
  private async write(path: string, bytes: Buffer, held: Held[]): Promise<Fact> {
    const file = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    let info: Stats
    try {
      info = await file.stat()
    } catch (error) {
      await file.close()
      throw error
    }
    const entry: Held = { fact: { path, info, directory: false }, file }
    held.push(entry)
    await file.writeFile(bytes)
    await file.sync()
    entry.fact.info = await file.stat()
    fileShape(entry.fact.info, Math.max(bytes.length, metadataLimit))
    if (entry.fact.info.size !== bytes.length || !sameFile(entry.fact.info, await lstat(path)))
      throw invalid()
    return entry.fact
  }
  async commit(
    key: string,
    expectedRevision: string | null,
    input: readonly SmartStateFileData[],
    assertLive: () => void
  ): Promise<string> {
    const root = this.root(key)
    if (
      (expectedRevision !== null && !digest(expectedRevision)) ||
      typeof assertLive !== 'function'
    )
      throw invalid()
    const incoming = checkData(input, true)
    return writes.run(root, async () => {
      const current = await this.load(key)
      if (current.revision !== expectedRevision) throw new SmartStateConflict()
      const data = checkData(
        [
          ...incoming,
          ...(!incoming.some((v) => v.path === 'smart_weight_data.csv')
            ? current.data.filter((v) => v.path === 'smart_weight_data.csv')
            : [])
        ],
        false
      )
      const raw = Buffer.from(
          JSON.stringify({
            version: 1,
            key,
            id: randomUUID(),
            parent: expectedRevision,
            files: metadata(data)
          })
        ),
        revision = smartStateDigest(raw),
        held: Held[] = []
      let writing = false,
        committed = false,
        failure: unknown
      try {
        await this.hold(current.facts, held)
        if (current.absentPath) {
          writing = true
          await this.files.directory(this.directory, true)
          await mkdir(root, { mode: 0o700 })
          await mkdir(join(root, 'versions'), { mode: 0o700 })
          const parents = await this.parents(key)
          if (parents.absentPath) throw invalid()
          await this.hold(parents.facts, held)
          await this.hold([await this.directoryFact(join(root, 'versions'))], held)
          await this.files.sync(this.directory)
        }
        const versions = join(root, 'versions'),
          versionRoot = join(versions, revision)
        writing = true
        await mkdir(versionRoot, { mode: 0o700 })
        await this.hold([await this.directoryFact(versionRoot)], held)
        for (const file of data) await this.write(join(versionRoot, file.path), file.bytes, held)
        await this.write(join(versionRoot, 'manifest.json'), raw, held)
        const staged = await this.write(
          join(versionRoot, 'head-stage.json'),
          Buffer.from(JSON.stringify({ version: 1, key, revision })),
          held
        )
        await this.files.sync(versionRoot)
        await this.files.sync(versions)
        // The only caller callback is a synchronous generation/lease check.
        // No await separates it, held facts/current-head CAS and atomic rename.
        const guardResult: unknown = assertLive()
        if (guardResult !== undefined) {
          if (types.isPromise(guardResult))
            void Promise.prototype.then.call(guardResult, undefined, () => undefined)
          throw invalid()
        }
        for (const item of held) {
          const same = item.fact.directory ? sameDirectory : sameFile
          if (
            !same(item.fact.info, fstatSync(item.file.fd)) ||
            !same(item.fact.info, lstatSync(item.fact.path))
          )
            throw invalid()
        }
        const expectedRoot = expectedRevision === null ? ['versions'] : ['head.json', 'versions']
        if (readdirSync(root).sort().join(',') !== expectedRoot.join(',')) throw invalid()
        if (
          readdirSync(versionRoot).sort().join(',') !==
            ['manifest.json', 'head-stage.json', ...data.map((v) => v.path)].sort().join(',') ||
          (expectedRevision !== null &&
            readdirSync(join(versions, expectedRevision)).sort().join(',') !==
              ['manifest.json', ...current.data.map((v) => v.path)].sort().join(','))
        )
          throw invalid()
        if (expectedRevision === null) {
          try {
            lstatSync(join(root, 'head.json'))
            throw invalid()
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        renameSync(staged.path, join(root, 'head.json'))
        await this.files.sync(root)
        const saved = await this.load(key)
        if (saved.revision !== revision) throw invalid()
        const head = saved.facts.find((v) => v.path === join(root, 'head.json'))
        if (!head || !sameDirectory(staged.info, head.info) || head.info.nlink !== 1)
          throw invalid()
        committed = true
      } catch (error) {
        failure = writing ? new SmartStateWriteUncertain(revision) : error
      } finally {
        const closed = await Promise.allSettled(held.map(async ({ file }) => file.close()))
        if (closed.some((result) => result.status === 'rejected'))
          failure = new SmartStateWriteUncertain(revision)
      }
      if (failure) throw failure
      if (!committed) throw new SmartStateWriteUncertain(revision)
      return revision
    })
  }
}
