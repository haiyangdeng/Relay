import { randomUUID } from 'crypto'
import { constants, type Stats } from 'fs'
import { lstat, open } from 'fs/promises'
import { join } from 'path'
import type {
  GeoOriginDefinition,
  GeoOriginHead,
  GeoOriginInfo,
  GeoOriginInventory,
  GeoOriginRecord,
  GeoOriginSelection
} from '../../../shared/relay/geo-origins'
import { geoOriginSelection } from '../../../shared/relay/geo-origins'
import { profileSelection } from '../../../shared/relay/runtime'
import { atomicWriteFile, KeyedWriteQueue } from '../../utils/safeFile'
import type { RelayStateContext } from '../context'
import { profileHash, readProfileFile } from '../profiles/source'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { geoOriginDefinition, geoOriginSaveRequest } from './origin-definition'
import type { ResourceStore } from './store'

const writes = new KeyedWriteQueue()
export const GEO_ORIGIN_STORE_MAX_BYTES = 1024 * 1024
interface StoredOrigin {
  id: string
  definition: GeoOriginDefinition
  originGeneration: string
  createdAt: string
  updatedAt: string
  head?: GeoOriginHead
}
interface Loaded {
  items: StoredOrigin[]
  revision: string
  directory: Stats | null
  file: Stats | null
}
export interface GeoOriginHeadCommit {
  origin: GeoOriginSelection
  originRevision: string
  resource: { id: string; sha256: string }
  resourceRevision: string
}
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const fields = (
  value: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => ![...required, ...optional].includes(key))
  )
    throw new Error('地理来源记录无效。')
  return value as Record<string, unknown>
}
const sameDirectory = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode
const sameFile = (a: Stats, b: Stats): boolean =>
  sameDirectory(a, b) &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs
function originRevision(item: StoredOrigin): string {
  return profileHash(
    'relay-geo-origin-v1\0' +
      item.id +
      '\0' +
      item.originGeneration +
      '\0' +
      JSON.stringify(item.definition)
  )
}
function stored(raw: unknown): StoredOrigin {
  const value = fields(
    raw,
    ['id', 'definition', 'originGeneration', 'createdAt', 'updatedAt'],
    ['head']
  )
  const id = profileSelection({ id: value.id, sha256: '0'.repeat(64) }).id
  const generation = profileSelection({ id: value.originGeneration, sha256: '0'.repeat(64) }).id
  if (
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  )
    throw new Error('地理来源时间无效。')
  const definition = geoOriginDefinition(value.definition)
  if (JSON.stringify(definition) !== JSON.stringify(value.definition))
    throw new Error('地理来源不是规范格式。')
  const item: StoredOrigin = {
    id,
    definition,
    originGeneration: generation,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
  if (Object.hasOwn(value, 'head')) {
    const head = fields(
      value.head,
      ['resource', 'originRevision', 'acquiredAt'],
      ['resourceRevision', 'receipt']
    )
    if (
      !digest(head.originRevision) ||
      !timestamp(head.acquiredAt) ||
      Date.parse(head.acquiredAt) < Date.parse(item.createdAt) ||
      Object.hasOwn(head, 'receipt') === Object.hasOwn(head, 'resourceRevision')
    )
      throw new Error('地理来源缓存回执无效。')
    let binding: { resourceRevision: string } | { receipt: { version: 1; metadataSHA256: string } }
    if (Object.hasOwn(head, 'receipt')) {
      const receipt = fields(head.receipt, ['version', 'metadataSHA256'])
      if (receipt.version !== 1 || !digest(receipt.metadataSHA256))
        throw new Error('地理来源缓存回执版本或摘要无效。')
      binding = { receipt: { version: 1, metadataSHA256: receipt.metadataSHA256 } }
    } else {
      if (!digest(head.resourceRevision)) throw new Error('地理来源缓存回执无效。')
      binding = { resourceRevision: head.resourceRevision }
    }
    item.head = {
      resource: profileSelection(head.resource),
      ...binding,
      originRevision: head.originRevision,
      acquiredAt: head.acquiredAt
    }
  }
  return item
}
export class GeoOriginWriteUncertain extends Error {
  constructor() {
    super('地理来源写入或同步未确认；保留原件与可能已发布的新记录，请重新读取，不自动重试。')
  }
}
// Reuse the library's single-file process-local CAS pattern. Separate instances
// share this queue; this is not atomic CAS against an external malicious writer.
// Persisted autoIntent never constitutes a session permission or active receipt.
export class ResourceOriginStore {
  readonly path: string
  private readonly directoryPath: string
  private readonly files: SubscriptionFiles
  private readonly now: () => number
  constructor(
    context: RelayStateContext,
    private readonly resources: Pick<ResourceStore, 'read'>,
    private readonly adapters: { now?(): number; write?: typeof atomicWriteFile } = {}
  ) {
    this.files = new SubscriptionFiles(context)
    this.directoryPath = join(context.stateRoot, 'Configuration')
    this.path = join(this.directoryPath, 'resource-origins.json')
    this.now = adapters.now ?? Date.now
  }
  private async directory(create: boolean): Promise<Stats | null> {
    if (!(await this.files.directory(this.directoryPath, create))) return null
    const linked = await lstat(this.directoryPath),
      fd = await open(
        this.directoryPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
    try {
      const pinned = await fd.stat()
      if (
        !sameDirectory(linked, pinned) ||
        !pinned.isDirectory() ||
        pinned.uid !== process.getuid?.() ||
        ![0o700, 0o755].includes(pinned.mode & 0o7777)
      )
        throw new Error('地理来源私有目录未确认。')
      // Configuration is shared with existing private stores. Keep its safe
      // legacy mode unchanged; reading or saving an origin does not chmod it.
      const after = await fd.stat(),
        current = await lstat(this.directoryPath)
      if (!sameDirectory(pinned, after) || !sameDirectory(after, current))
        throw new Error('地理来源目录已变化。')
      return after
    } finally {
      await fd.close()
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
        throw new Error('地理来源目录已变化。')
      return { items: [], revision: '', directory, file: null }
    }
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.uid !== process.getuid?.() ||
      file.nlink !== 1 ||
      (file.mode & 0o7777) !== 0o600 ||
      file.size < 1 ||
      file.size > GEO_ORIGIN_STORE_MAX_BYTES
    )
      throw new Error('地理来源文件权限、类型或预算无效。')
    const raw = await readProfileFile(this.path, true)
    const parsed = fields(JSON.parse(raw), ['version', 'origins'])
    if (parsed.version !== 1 || !Array.isArray(parsed.origins) || parsed.origins.length > 4)
      throw new Error('地理来源版本或数量无效。')
    const items = parsed.origins.map(stored)
    if (
      new Set(items.map((v) => v.id)).size !== items.length ||
      new Set(items.map((v) => v.definition.descriptor.kind)).size !== items.length ||
      !sameFile(file, await lstat(this.path)) ||
      !sameDirectory(directory, await lstat(this.directoryPath))
    )
      throw new Error('地理来源重复或读取期间变化。')
    return { items, revision: profileHash(raw), directory, file }
  }
  private record(loaded: Loaded, id: string): GeoOriginRecord {
    const item = loaded.items.find((v) => v.id === id)
    if (!item) throw new Error('地理来源不存在。')
    const info: GeoOriginInfo = {
      id: item.id,
      revision: profileHash('relay-geo-record-v1\0' + JSON.stringify(item)),
      originRevision: originRevision(item),
      descriptor: structuredClone(item.definition.descriptor),
      origin: new URL(item.definition.source.url).origin,
      proxyPort: item.definition.source.proxyPort,
      hasPrivateHeaders: Object.keys(item.definition.source.headers).length > 0,
      expectedSHA256: item.definition.expectedSHA256,
      autoIntent: structuredClone(item.definition.autoIntent),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(item.head ? { head: structuredClone(item.head) } : {})
    }
    return { info, definition: structuredClone(item.definition) }
  }
  private selected(loaded: Loaded, raw: unknown): GeoOriginRecord {
    const selected = geoOriginSelection(raw),
      record = this.record(loaded, selected.id)
    if (record.info.revision !== selected.revision) throw new Error('地理来源修订已变化，未覆盖。')
    return record
  }
  private stamp(item?: StoredOrigin): string {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime()))
      throw new Error('地理来源保存时间无效。')
    return new Date(
      Math.max(
        now,
        item ? Date.parse(item.updatedAt) : 0,
        item?.head ? Date.parse(item.head.acquiredAt) : 0
      )
    ).toISOString()
  }
  private async persist(current: Loaded, items: StoredOrigin[]): Promise<Loaded> {
    const checked = items.map(stored),
      raw = JSON.stringify({ version: 1, origins: checked }, null, 2)
    if (items.length > 4 || Buffer.byteLength(raw) > GEO_ORIGIN_STORE_MAX_BYTES)
      throw new Error('地理来源超过预算。')
    const directory = await this.directory(true),
      latest = await this.load()
    if (
      !directory ||
      !latest.directory ||
      (current.directory && !sameDirectory(current.directory, latest.directory)) ||
      current.revision !== latest.revision ||
      (current.file && (!latest.file || !sameFile(current.file, latest.file)))
    )
      throw new Error('地理来源身份或修订已变化，未覆盖。')
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
      throw new GeoOriginWriteUncertain()
    }
  }
  async list(): Promise<GeoOriginInventory> {
    try {
      const current = await this.load()
      return {
        origins: current.items.map((v) => this.record(current, v.id).info),
        incomplete: 0,
        warnings: []
      }
    } catch {
      return {
        origins: [],
        incomplete: 1,
        warnings: ['地理来源记录不完整、未知或权限不符；原件保留，未重置、获取或启用。']
      }
    }
  }
  async read(raw: unknown): Promise<GeoOriginRecord> {
    const selected = geoOriginSelection(raw)
    return this.selected(await this.load(), selected)
  }
  async readId(id: string): Promise<GeoOriginRecord> {
    profileSelection({ id, sha256: '0'.repeat(64) })
    return this.record(await this.load(), id)
  }
  async save(raw: unknown): Promise<GeoOriginRecord> {
    const request = geoOriginSaveRequest(raw)
    return writes.run(this.path, async () => {
      const current = await this.load()
      if (!request.origin) {
        if (
          current.items.some(
            (v) => v.definition.descriptor.kind === request.definition.descriptor.kind
          )
        )
          throw new Error('该地理类型已有来源，未创建重复定义。')
        const at = this.stamp(),
          item: StoredOrigin = {
            id: randomUUID(),
            definition: request.definition,
            originGeneration: randomUUID(),
            createdAt: at,
            updatedAt: at
          }
        return this.record(await this.persist(current, [...current.items, item]), item.id)
      }
      const record = this.selected(current, request.origin),
        index = current.items.findIndex((v) => v.id === record.info.id),
        old = current.items[index]
      if (old.definition.descriptor.kind !== request.definition.descriptor.kind)
        throw new Error('既有地理来源类型不可更改。')
      if (JSON.stringify(old.definition) === JSON.stringify(request.definition)) return record
      const items = current.items.slice()
      items[index] = {
        ...old,
        definition: request.definition,
        originGeneration: randomUUID(),
        updatedAt: this.stamp(old)
      }
      return this.record(await this.persist(current, items), old.id)
    })
  }
  // Main-only cache receipt. No renderer head setter and no format/active claim.
  async commitHead(raw: GeoOriginHeadCommit): Promise<GeoOriginRecord> {
    const input = fields(raw, ['origin', 'originRevision', 'resource', 'resourceRevision']),
      origin = geoOriginSelection(input.origin),
      resource = profileSelection(input.resource)
    if (!digest(input.originRevision) || !digest(input.resourceRevision))
      throw new Error('地理来源缓存选择无效。')
    const expectedOriginRevision = input.originRevision,
      expectedResourceRevision = input.resourceRevision
    return writes.run(this.path, async () => {
      const current = await this.load(),
        record = this.selected(current, origin)
      if (record.info.originRevision !== expectedOriginRevision)
        throw new Error('地理来源定义已变化。')
      const verified = await this.resources.read(resource)
      if (
        verified.info.id !== resource.id ||
        verified.info.sha256 !== resource.sha256 ||
        verified.revision !== expectedResourceRevision ||
        !digest(verified.metadataSHA256) ||
        JSON.stringify(record.definition.descriptor) !==
          JSON.stringify({
            name: verified.info.name,
            kind: verified.info.kind,
            behavior: verified.info.behavior,
            selector: verified.info.selector
          }) ||
        (record.definition.expectedSHA256 &&
          record.definition.expectedSHA256 !== verified.info.sha256)
      )
        throw new Error('私有资源摘要、类型或来源选择未确认。')
      const latest = await this.load(),
        fresh = this.selected(latest, origin)
      if (
        fresh.info.originRevision !== expectedOriginRevision ||
        latest.revision !== current.revision ||
        (current.directory &&
          (!latest.directory || !sameDirectory(current.directory, latest.directory)))
      )
        throw new Error('缓存读取期间地理来源已变化。')
      const item = current.items.find((v) => v.id === origin.id)
      if (!item) throw new Error('地理来源不存在。')
      const head: GeoOriginHead = {
        resource,
        // Keep the live root-bound revision as the admission CAS above. Only
        // this persisted metadata receipt may travel with exact backup bytes.
        receipt: { version: 1, metadataSHA256: verified.metadataSHA256 },
        originRevision: expectedOriginRevision,
        acquiredAt: this.stamp(item)
      }
      const items = current.items.map((v) => (v.id === origin.id ? { ...v, head } : v))
      return this.record(await this.persist(current, items), origin.id)
    })
  }
}
