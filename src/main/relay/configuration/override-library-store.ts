import { randomUUID } from 'crypto'
import { constants, type Stats } from 'fs'
import { lstat, open } from 'fs/promises'
import { join } from 'path'
import {
  OVERRIDE_LIBRARY_MAX_BYTES,
  OVERRIDE_LIBRARY_MAX_ITEMS,
  overrideLibraryBodyRequest,
  overrideLibraryContent,
  overrideLibraryCreateRequest,
  overrideLibraryId,
  overrideLibraryIdFromRuntimeId,
  overrideLibraryMetadataRequest,
  overrideLibraryName,
  overrideLibraryReadRequest,
  overrideLibraryRemote,
  overrideLibraryRemoveRequest,
  overrideLibraryRevision,
  type OverrideLibraryInventory,
  type OverrideLibraryItem,
  type OverrideLibraryKind,
  type OverrideLibraryRecord,
  type OverrideLibraryRemote,
  type OverrideLibrarySummary,
  type OverrideLibraryType
} from '../../../shared/relay/override-library'
import { atomicWriteFile, KeyedWriteQueue } from '../../utils/safeFile'
import type { RelayStateContext } from '../context'
import { readConfigurationMap } from '../profiles/document'
import { profileHash, readProfileFile } from '../profiles/source'
import { SubscriptionFiles } from '../subscriptions/private-files'

const writes = new KeyedWriteQueue()
interface StoredItem {
  id: string
  name: string
  kind: OverrideLibraryKind
  type: OverrideLibraryType
  remote?: OverrideLibraryRemote
  createdAt: number
  metadataUpdatedAt: number
  content?: string
  bodyUpdatedAt?: number
  bodyOrigin?: 'manual' | 'remote'
  lastFetch?: { at: number; sourceFingerprint: string; sha256: string }
}
interface Loaded {
  items: StoredItem[]
  revision: string
  directory: Stats | null
  file: Stats | null
}
const sameDirectory = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode
const sameFile = (a: Stats, b: Stats): boolean =>
  sameDirectory(a, b) &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs
const timestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0
function fields(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !allowed.includes(k))
  )
    throw new Error('覆写库记录无效。')
  return raw as Record<string, unknown>
}
export function overrideLibrarySourceFingerprint(remote: OverrideLibraryRemote): string {
  return profileHash('relay-override-source-v1\0' + JSON.stringify(overrideLibraryRemote(remote)))
}
function body(content: unknown, kind: OverrideLibraryKind): string {
  const checked = overrideLibraryContent(content, kind)
  if (kind === 'yaml' && !readConfigurationMap(checked).data)
    throw new Error('YAML覆写须是有效的有界映射，不能直接使用加密正文。')
  return checked
}
function stored(raw: unknown): StoredItem {
  const value = fields(raw, [
    'id',
    'name',
    'kind',
    'type',
    'remote',
    'createdAt',
    'metadataUpdatedAt',
    'content',
    'bodyUpdatedAt',
    'bodyOrigin',
    'lastFetch'
  ])
  if (
    (value.kind !== 'yaml' && value.kind !== 'js') ||
    (value.type !== 'local' && value.type !== 'remote') ||
    !timestamp(value.createdAt) ||
    !timestamp(value.metadataUpdatedAt) ||
    value.metadataUpdatedAt < value.createdAt ||
    (value.type === 'local'
      ? Object.hasOwn(value, 'remote') || Object.hasOwn(value, 'lastFetch')
      : !Object.hasOwn(value, 'remote'))
  )
    throw new Error('覆写库来源或时间无效。')
  const item: StoredItem = {
    id: overrideLibraryId(value.id),
    name: overrideLibraryName(value.name),
    kind: value.kind,
    type: value.type,
    createdAt: value.createdAt,
    metadataUpdatedAt: value.metadataUpdatedAt,
    ...(value.type === 'remote' ? { remote: overrideLibraryRemote(value.remote) } : {})
  }
  if (item.remote && JSON.stringify(item.remote) !== JSON.stringify(value.remote))
    throw new Error('覆写来源不是规范格式。')
  if (Object.hasOwn(value, 'content')) {
    if (
      !timestamp(value.bodyUpdatedAt) ||
      value.bodyUpdatedAt < item.createdAt ||
      (value.bodyOrigin !== 'manual' && value.bodyOrigin !== 'remote') ||
      (item.type === 'local' && value.bodyOrigin !== 'manual')
    )
      throw new Error('覆写正文来源无效。')
    item.content = body(value.content, item.kind)
    item.bodyUpdatedAt = value.bodyUpdatedAt
    item.bodyOrigin = value.bodyOrigin
  } else if (['bodyUpdatedAt', 'bodyOrigin', 'lastFetch'].some((key) => Object.hasOwn(value, key)))
    throw new Error('缺少覆写正文。')
  if (Object.hasOwn(value, 'lastFetch')) {
    const fetched = fields(value.lastFetch, ['at', 'sourceFingerprint', 'sha256'])
    if (
      !timestamp(fetched.at) ||
      fetched.at < item.createdAt ||
      fetched.at > (item.bodyUpdatedAt ?? -1)
    )
      throw new Error('覆写获取时间无效。')
    item.lastFetch = {
      at: fetched.at,
      sourceFingerprint: overrideLibraryRevision(fetched.sourceFingerprint),
      sha256: overrideLibraryRevision(fetched.sha256)
    }
  }
  if (
    item.bodyOrigin === 'remote' &&
    (!item.lastFetch || item.lastFetch.sha256 !== profileHash(item.content ?? ''))
  )
    throw new Error('远端覆写缓存缺少匹配回执。')
  return item
}
function summary(item: StoredItem): OverrideLibrarySummary {
  const metadata = {
    id: item.id,
    name: item.name,
    kind: item.kind,
    type: item.type,
    ...(item.remote ? { remote: item.remote } : {})
  }
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    type: item.type,
    metadataRevision: profileHash(JSON.stringify(metadata)),
    bodyRevision: item.content === undefined ? '' : profileHash(item.content),
    bodyBytes: item.content === undefined ? 0 : Buffer.byteLength(item.content),
    bodyState:
      item.content === undefined
        ? 'missing'
        : item.type === 'local'
          ? 'local'
          : item.bodyOrigin === 'manual'
            ? 'manual'
            : item.remote &&
                item.lastFetch?.sourceFingerprint === overrideLibrarySourceFingerprint(item.remote)
              ? 'current'
              : 'stale',
    createdAt: item.createdAt,
    metadataUpdatedAt: item.metadataUpdatedAt,
    ...(item.bodyUpdatedAt !== undefined ? { bodyUpdatedAt: item.bodyUpdatedAt } : {}),
    ...(item.lastFetch ? { lastFetchedAt: item.lastFetch.at } : {})
  }
}
function detail(item: StoredItem): OverrideLibraryItem {
  return {
    ...summary(item),
    ...(item.remote
      ? {
          remote: { ...item.remote },
          sourceFingerprint: overrideLibrarySourceFingerprint(item.remote)
        }
      : {}),
    ...(item.content !== undefined ? { content: item.content } : {})
  }
}
export interface OverrideLibraryFetchedWrite {
  id: string
  expectedLibraryRevision: string
  expectedMetadataRevision: string
  expectedBodyRevision: string
  expectedSourceFingerprint: string
  content: string
  fetchedAt: number
}
export class OverrideLibraryWriteUncertain extends Error {
  constructor() {
    super('覆写库写入或同步未确认；旧资料或新文件均保留，请重新核对，不自动重试。')
  }
}
// Single-file process-local CAS. The shared keyed queue covers separate Store
// instances, not an atomic compare-and-rename against malicious same-UID code.
export class OverrideLibraryStore {
  readonly path: string
  private readonly directoryPath: string
  private readonly files: SubscriptionFiles
  private readonly now: () => number
  constructor(
    context: RelayStateContext,
    private readonly adapters: { now?(): number; write?: typeof atomicWriteFile } = {}
  ) {
    this.files = new SubscriptionFiles(context)
    this.directoryPath = join(context.stateRoot, 'Configuration')
    this.path = join(this.directoryPath, 'override-library.json')
    this.now = adapters.now ?? Date.now
  }
  private async directory(create: boolean): Promise<Stats | null> {
    if (!(await this.files.directory(this.directoryPath, create))) return null
    const linked = await lstat(this.directoryPath),
      file = await open(
        this.directoryPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
    try {
      const pinned = await file.stat()
      if (
        !sameDirectory(linked, pinned) ||
        !pinned.isDirectory() ||
        pinned.uid !== process.getuid?.() ||
        ![0o700, 0o755].includes(pinned.mode & 0o7777)
      )
        throw new Error('覆写私有目录身份或权限无效。')
      if ((pinned.mode & 0o7777) === 0o755) {
        // Only the fixed application Configuration directory has this known
        // legacy mode. Tighten the pinned inode, never a replacement by path.
        await file.chmod(0o700)
        await file.sync()
      }
      const after = await file.stat(),
        current = await lstat(this.directoryPath)
      if (
        after.dev !== pinned.dev ||
        after.ino !== pinned.ino ||
        after.uid !== pinned.uid ||
        (after.mode & 0o7777) !== 0o700 ||
        !sameDirectory(after, current)
      )
        throw new Error('覆写私有目录发生改变。')
      return after
    } finally {
      await file.close()
    }
  }
  private async load(): Promise<Loaded> {
    const directory = await this.directory(false)
    if (!directory) return { items: [], revision: '', directory: null, file: null }
    let file: Stats
    try {
      file = await lstat(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!sameDirectory(directory, await lstat(this.directoryPath)))
        throw new Error('覆写目录已变化。')
      return { items: [], revision: '', directory, file: null }
    }
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.size < 1 ||
      file.size > OVERRIDE_LIBRARY_MAX_BYTES ||
      file.uid !== process.getuid?.() ||
      file.nlink !== 1 ||
      (file.mode & 0o7777) !== 0o600
    )
      throw new Error('覆写库文件类型、大小或权限不安全。')
    const raw = await readProfileFile(this.path, true)
    let parsed: Record<string, unknown>
    try {
      parsed = fields(JSON.parse(raw), ['version', 'items'])
    } catch {
      throw new Error('覆写库格式损坏；未重置或覆盖原件。')
    }
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.items) ||
      parsed.items.length > OVERRIDE_LIBRARY_MAX_ITEMS
    )
      throw new Error('覆写库格式或条目预算无效。')
    const items = parsed.items.map(stored)
    if (
      new Set(items.map((item) => item.id)).size !== items.length ||
      !sameFile(file, await lstat(this.path)) ||
      !sameDirectory(directory, await lstat(this.directoryPath))
    )
      throw new Error('覆写库含重复ID或读取期间变化。')
    return { items, revision: profileHash(raw), directory, file }
  }
  private stamp(item?: StoredItem): number {
    const now = this.now()
    if (!timestamp(now)) throw new Error('覆写保存时间无效。')
    return Math.max(now, item?.metadataUpdatedAt ?? 0, item?.bodyUpdatedAt ?? 0)
  }
  private async persist(current: Loaded, items: StoredItem[]): Promise<Loaded> {
    if (items.length > OVERRIDE_LIBRARY_MAX_ITEMS) throw new Error('覆写库条目超过200项。')
    const checked = items.map(stored),
      raw = JSON.stringify({ version: 1, items: checked }, null, 2)
    if (Buffer.byteLength(raw) > OVERRIDE_LIBRARY_MAX_BYTES) throw new Error('覆写库JSON超过1MiB。')
    const directory = await this.directory(true),
      latest = await this.load()
    if (
      !directory ||
      !latest.directory ||
      (current.directory && !sameDirectory(current.directory, latest.directory)) ||
      current.revision !== latest.revision ||
      (current.file && (!latest.file || !sameFile(current.file, latest.file)))
    )
      throw new Error('覆写库身份或修订已变化，未覆盖。')
    try {
      await (this.adapters.write ?? atomicWriteFile)(this.path, raw, { mode: 0o600 })
      await this.files.sync(this.directoryPath)
      const saved = await this.load()
      if (
        !saved.directory ||
        !sameDirectory(directory, saved.directory) ||
        saved.revision !== profileHash(raw)
      )
        throw new Error()
      return saved
    } catch {
      throw new OverrideLibraryWriteUncertain()
    }
  }
  private record(loaded: Loaded, id: string): OverrideLibraryRecord {
    const item = loaded.items.find((item) => item.id === id)
    if (!item) throw new Error('覆写库项不存在。')
    return { revision: loaded.revision, item: detail(item) }
  }
  private check(current: Loaded, expected: string): void {
    if (current.revision !== expected) throw new Error('覆写库修订已变化；未覆盖草稿或当前资料。')
  }
  async list(): Promise<OverrideLibraryInventory> {
    const loaded = await this.load()
    return { revision: loaded.revision, exists: !!loaded.file, items: loaded.items.map(summary) }
  }
  async read(raw: unknown): Promise<OverrideLibraryRecord> {
    const request = overrideLibraryReadRequest(raw),
      loaded = await this.load()
    if (request.expectedLibraryRevision !== undefined)
      this.check(loaded, request.expectedLibraryRevision)
    return this.record(loaded, request.id)
  }
  async create(raw: unknown): Promise<OverrideLibraryRecord> {
    const request = overrideLibraryCreateRequest(raw)
    return writes.run(this.path, async () => {
      const current = await this.load()
      this.check(current, request.expectedLibraryRevision)
      const at = this.stamp(),
        item: StoredItem = {
          id: randomUUID(),
          name: request.name,
          kind: request.kind,
          type: request.type,
          createdAt: at,
          metadataUpdatedAt: at,
          ...(request.remote ? { remote: request.remote } : {}),
          ...(request.content !== undefined
            ? {
                content: body(request.content, request.kind),
                bodyOrigin: 'manual',
                bodyUpdatedAt: at
              }
            : {})
        }
      return this.record(await this.persist(current, [...current.items, item]), item.id)
    })
  }
  async saveMetadata(raw: unknown): Promise<OverrideLibraryRecord> {
    const request = overrideLibraryMetadataRequest(raw)
    return writes.run(this.path, async () => {
      const current = await this.load()
      this.check(current, request.expectedLibraryRevision)
      const item = current.items.find((item) => item.id === request.id)
      if (
        !item ||
        summary(item).metadataRevision !== request.expectedMetadataRevision ||
        (item.type === 'remote') !== !!request.remote
      )
        throw new Error('覆写元信息修订或来源类型已变化。')
      item.name = request.name
      item.metadataUpdatedAt = this.stamp(item)
      if (request.remote) item.remote = request.remote
      return this.record(await this.persist(current, current.items), item.id)
    })
  }
  async saveBody(raw: unknown): Promise<OverrideLibraryRecord> {
    const request = overrideLibraryBodyRequest(raw)
    return writes.run(this.path, async () => {
      const current = await this.load()
      this.check(current, request.expectedLibraryRevision)
      const item = current.items.find((item) => item.id === request.id)
      if (!item || summary(item).bodyRevision !== request.expectedBodyRevision)
        throw new Error('覆写正文修订已变化。')
      item.content = body(request.content, item.kind)
      item.bodyUpdatedAt = this.stamp(item)
      item.bodyOrigin = 'manual'
      return this.record(await this.persist(current, current.items), item.id)
    })
  }
  // Main-only commit after separately authorized fetch; not a renderer command.
  async saveFetched(raw: OverrideLibraryFetchedWrite): Promise<OverrideLibraryRecord> {
    const { expectedSourceFingerprint, content, fetchedAt, ...rest } = fields(raw, [
        'id',
        'expectedLibraryRevision',
        'expectedMetadataRevision',
        'expectedBodyRevision',
        'expectedSourceFingerprint',
        'content',
        'fetchedAt'
      ]),
      request = overrideLibraryRemoveRequest(rest)
    overrideLibraryRevision(expectedSourceFingerprint)
    if (!timestamp(fetchedAt)) throw new Error('覆写获取时间无效。')
    return writes.run(this.path, async () => {
      const current = await this.load()
      this.check(current, request.expectedLibraryRevision)
      const item = current.items.find((item) => item.id === request.id)
      if (
        !item?.remote ||
        summary(item).metadataRevision !== request.expectedMetadataRevision ||
        summary(item).bodyRevision !== request.expectedBodyRevision ||
        overrideLibrarySourceFingerprint(item.remote) !== expectedSourceFingerprint ||
        fetchedAt < item.createdAt ||
        fetchedAt > this.stamp(item)
      )
        throw new Error('远端覆写来源或修订已变化。')
      item.content = body(content, item.kind)
      item.bodyUpdatedAt = this.stamp(item)
      item.bodyOrigin = 'remote'
      item.lastFetch = {
        at: fetchedAt,
        sourceFingerprint: String(expectedSourceFingerprint),
        sha256: profileHash(item.content)
      }
      return this.record(await this.persist(current, current.items), item.id)
    })
  }
  async remove(raw: unknown): Promise<OverrideLibraryInventory> {
    const request = overrideLibraryRemoveRequest(raw)
    return writes.run(this.path, async () => {
      const current = await this.load()
      this.check(current, request.expectedLibraryRevision)
      const item = current.items.find((item) => item.id === request.id)
      if (
        !item ||
        summary(item).metadataRevision !== request.expectedMetadataRevision ||
        summary(item).bodyRevision !== request.expectedBodyRevision
      )
        throw new Error('覆写项修订已变化。')
      const saved = await this.persist(
        current,
        current.items.filter((item) => item.id !== request.id)
      )
      return { revision: saved.revision, exists: true, items: saved.items.map(summary) }
    })
  }
  async assertBindings(
    bindings: readonly { id: string; kind: OverrideLibraryKind }[]
  ): Promise<void> {
    const refs = bindings.flatMap((item) => {
      if (!item || typeof item.id !== 'string' || (item.kind !== 'yaml' && item.kind !== 'js'))
        throw new Error('覆写引用身份无效。')
      const id = overrideLibraryIdFromRuntimeId(item.id)
      return id ? [{ id, kind: item.kind }] : []
    })
    if (!refs.length) return
    const current = await this.load()
    for (const ref of refs)
      if (!current.items.some((item) => item.id === ref.id && item.kind === ref.kind))
        throw new Error('覆写库引用缺失或类型已变化。')
  }
}
