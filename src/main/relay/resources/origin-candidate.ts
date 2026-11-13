import {
  geoOriginSelection,
  type GeoOriginHead,
  type GeoOriginInfo,
  type GeoResourceKind
} from '../../../shared/relay/geo-origins'
import type { DefaultGeoResourceBinding } from '../configuration/bindings'
import type { ResourceDescriptor } from '../../../shared/relay/resources'
import { checkResourceJob, type ResourceValidationJob } from './check-definition'
import type { ResourceOriginStore } from './origin-store'
import type { ResourceStore } from './store'

export interface GeoOriginCandidate {
  origin: GeoOriginInfo
  job: ResourceValidationJob
  recheck(): Promise<void>
}
const sameDescriptor = (a: ResourceDescriptor, b: ResourceDescriptor): boolean =>
  a.name === b.name && a.kind === b.kind && a.behavior === b.behavior && a.selector === b.selector

// A portable head binds exact immutable metadata bytes, while a legacy head
// retains its original path-bound interpretation. Neither replaces the current
// ResourceStore full read or an in-flight operation's dynamic revision pin.
export function matchesGeoOriginHeadReceipt(
  head: GeoOriginHead,
  resource: Pick<Awaited<ReturnType<ResourceStore['read']>>, 'revision' | 'metadataSHA256'>
): boolean {
  return head.receipt
    ? head.receipt.version === 1 && head.receipt.metadataSHA256 === resource.metadataSHA256
    : head.resourceRevision === resource.revision
}

// Resolve only an unpinned Geo dependency at generation time. The resulting
// candidate still pins one exact immutable resource and current origin head;
// explicit per-candidate bindings and historical snapshots keep their bytes.
export async function readDefaultGeoBinding(
  origins: Pick<ResourceOriginStore, 'list' | 'read'>,
  cache: Pick<ResourceStore, 'read'>,
  kind: GeoResourceKind
): Promise<DefaultGeoResourceBinding | undefined> {
  const inventory = await origins.list()
  if (inventory.incomplete) return undefined
  const matching = inventory.origins.filter((info) => info.descriptor.kind === kind)
  if (matching.length !== 1) return undefined
  const selected = geoOriginSelection({ id: matching[0].id, revision: matching[0].revision }),
    record = await origins.read(selected),
    head = record.info.head
  if (
    !head ||
    head.originRevision !== record.info.originRevision ||
    (record.definition.expectedSHA256 !== '' &&
      record.definition.expectedSHA256 !== head.resource.sha256)
  )
    return undefined
  const resource = await cache.read(head.resource)
  if (
    !matchesGeoOriginHeadReceipt(head, resource) ||
    !sameDescriptor(resource.info, record.definition.descriptor)
  )
    throw new Error('默认地理来源的缓存元数据与head不一致。')
  await origins.read(selected)
  return {
    selection: structuredClone(head.resource),
    revision: resource.revision,
    recheck: async () => {
      await origins.read(selected)
    }
  }
}

// A saved head is an immutable cache receipt, never an active-Core proof.
// Native's actual local prepare still validates the complete candidate bytes.
export async function readGeoOriginCandidate(
  origins: Pick<ResourceOriginStore, 'read'>,
  cache: Pick<ResourceStore, 'read'>,
  raw: unknown
): Promise<GeoOriginCandidate> {
  const selected = geoOriginSelection(raw),
    record = await origins.read(selected),
    head = record.info.head
  if (!head || head.originRevision !== record.info.originRevision)
    throw new Error('此来源尚无与当前定义一致的已检查缓存。')
  let resourceRevision: string | undefined
  const read = async (): Promise<ResourceValidationJob> => {
    const current = await origins.read(selected)
    if (
      current.info.originRevision !== record.info.originRevision ||
      current.info.head?.originRevision !== head.originRevision ||
      current.info.head.resource.id !== head.resource.id ||
      current.info.head.resource.sha256 !== head.resource.sha256 ||
      JSON.stringify(current.info.head) !== JSON.stringify(head)
    )
      throw new Error('地理来源或缓存head已变化。')
    const resource = await cache.read(head.resource)
    if (
      !matchesGeoOriginHeadReceipt(head, resource) ||
      (resourceRevision !== undefined && resource.revision !== resourceRevision) ||
      resource.info.id !== head.resource.id ||
      resource.info.sha256 !== head.resource.sha256 ||
      !sameDescriptor(resource.info, record.definition.descriptor) ||
      (record.definition.expectedSHA256 !== '' &&
        record.definition.expectedSHA256 !== resource.info.sha256)
    )
      throw new Error('地理来源缓存的元数据或期望摘要不匹配。')
    const job = {
      descriptor: structuredClone(record.definition.descriptor),
      bytes: Buffer.from(resource.bytes),
      sha256: resource.info.sha256
    }
    checkResourceJob(job)
    // Recheck the selected full record after the cache's awaited full read.
    await origins.read(selected)
    resourceRevision ??= resource.revision
    return job
  }
  const job = await read()
  return {
    origin: structuredClone(record.info),
    job,
    recheck: async () => {
      await read()
    }
  }
}
