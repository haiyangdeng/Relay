import { isGeoResourceKind, type GeoResourceKind } from '../../../shared/relay/geo-origins'
import type { TunResourceEntry } from '../../../shared/relay/tun-resources'
import type { TunSessionBinding } from './service'
import type { TunRuntimeReadIO } from './runtime-channel'
import { tunHostFrameByteLimit } from './wire-json'
import { createTunAssetChannel } from './asset-channel'

export interface TunResourcesNativeSnapshot {
  configurationRevision: string
  generationSHA256: string
  resources: TunResourceEntry[]
}
export interface TunResourceBlobTicket {
  blobId: string
  kind: GeoResourceKind
  sha256: string
  bytes: number
  selector: string
}
export interface TunResourcesMutation {
  configurationRevision: string
  expectedGenerationSHA256: string
  kind: GeoResourceKind
  oldSHA256: string
  newSHA256: string
  blobId: string
  selector: string
  bytes: number
}
export type TunResourcesChannelResult =
  | { status: 'snapshot' | 'updated' | 'unchanged'; snapshot: TunResourcesNativeSnapshot }
  | {
      status:
        'busy' | 'cancelled' | 'uncertain' | 'stale' | 'expired' | 'unsupported' | 'unavailable'
    }
export interface TunResourcesIO extends TunRuntimeReadIO {
  // Capability failure closes only FD7/8; lifecycle and other pipes remain held.
  close(): void
}
export interface TunResourcesChannel {
  read(signal: AbortSignal, assertUI: () => void): Promise<TunResourcesChannelResult>
  replace(
    input: TunResourcesMutation,
    signal: AbortSignal,
    assertUI: () => void
  ): Promise<TunResourcesChannelResult>
  discardBlob(
    ticket: TunResourceBlobTicket
  ): Promise<'discarded' | 'absent' | 'busy' | 'unavailable'>
  cancel(): Promise<void>
  invalidate(): void
  isAvailable(): boolean
  isBusy(): boolean
  whenIdle(): Promise<void>
}

const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v),
  uuid = (v: unknown): v is string =>
    typeof v === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v),
  object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v),
  keys = (v: Record<string, unknown>, fields: string): boolean =>
    Object.keys(v).sort().join(',') === fields.split(',').sort().join(','),
  integer = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max,
  selector = (v: unknown): v is string =>
    typeof v === 'string' &&
    !!v &&
    v.trim() === v &&
    Buffer.byteLength(v) <= 256 &&
    Buffer.from(v, 'utf8').toString('utf8') === v &&
    !Array.from(v).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || character === ','
    })

export function tunResourceBlobTicket(raw: unknown): TunResourceBlobTicket {
  if (
    !object(raw) ||
    !keys(raw, 'blobId,kind,sha256,bytes,selector') ||
    !uuid(raw.blobId) ||
    !isGeoResourceKind(raw.kind) ||
    !hash(raw.sha256) ||
    !integer(raw.bytes, 1, 128 * 1024 * 1024) ||
    !selector(raw.selector)
  )
    throw new Error('地理资源暂存票据无效。')
  return {
    blobId: raw.blobId,
    kind: raw.kind,
    sha256: raw.sha256,
    bytes: raw.bytes,
    selector: raw.selector
  }
}
function mutation(raw: unknown): TunResourcesMutation {
  if (
    !object(raw) ||
    !keys(
      raw,
      'configurationRevision,expectedGenerationSHA256,kind,oldSHA256,newSHA256,blobId,selector,bytes'
    ) ||
    !hash(raw.configurationRevision) ||
    !hash(raw.expectedGenerationSHA256) ||
    !hash(raw.oldSHA256) ||
    !hash(raw.newSHA256)
  )
    throw new Error('地理资源替换范围无效。')
  const selected = tunResourceBlobTicket({
    blobId: raw.blobId,
    kind: raw.kind,
    sha256: raw.newSHA256,
    selector: raw.selector,
    bytes: raw.bytes
  })
  return {
    configurationRevision: raw.configurationRevision,
    expectedGenerationSHA256: raw.expectedGenerationSHA256,
    oldSHA256: raw.oldSHA256,
    newSHA256: selected.sha256,
    kind: selected.kind,
    blobId: selected.blobId,
    selector: selected.selector,
    bytes: selected.bytes
  }
}
function snapshot(raw: unknown): TunResourcesNativeSnapshot {
  if (
    !object(raw) ||
    !keys(raw, 'configurationRevision,generationSHA256,resources') ||
    !hash(raw.configurationRevision) ||
    !hash(raw.generationSHA256) ||
    !Array.isArray(raw.resources) ||
    raw.resources.length > 4
  )
    throw new Error('地理资源活动代际无效。')
  const resources: TunResourceEntry[] = []
  let bytes = 0
  for (const row of raw.resources) {
    if (
      !object(row) ||
      !keys(row, 'kind,sha256,bytes,active') ||
      !isGeoResourceKind(row.kind) ||
      !hash(row.sha256) ||
      !integer(row.bytes, 1, 128 * 1024 * 1024) ||
      typeof row.active !== 'boolean' ||
      resources.some((item) => item.kind === row.kind)
    )
      throw new Error('地理资源活动条目无效。')
    bytes += row.bytes
    if (bytes > 256 * 1024 * 1024) throw new Error('地理资源活动正文超过预算。')
    resources.push({ kind: row.kind, sha256: row.sha256, bytes: row.bytes, active: row.active })
  }
  // The Native/Core generation is opaque; never re-hash it using JS JSON.
  return {
    configurationRevision: raw.configurationRevision,
    generationSHA256: raw.generationSHA256,
    resources
  }
}

export function createTunResourcesChannel(
  io: TunResourcesIO,
  identity: TunSessionBinding & { launchClientSHA256: string; installationRevision: string },
  timeout = 30000
): TunResourcesChannel {
  return createTunAssetChannel<
    TunResourcesNativeSnapshot,
    TunResourcesMutation,
    TunResourceBlobTicket
  >(
    io,
    identity,
    {
      capability: 'runtime-resources-v1',
      frameByteLimit: tunHostFrameByteLimit,
      label: '地理资源',
      mutation,
      ticket: tunResourceBlobTicket,
      snapshot,
      verifyCommit(reply, selected, status) {
        const current = reply.resources.find((row) => row.kind === selected.kind)
        if (
          reply.configurationRevision !== selected.configurationRevision ||
          !current?.active ||
          current.sha256 !== selected.newSHA256 ||
          current.bytes !== selected.bytes ||
          (status === 'updated' &&
            (selected.oldSHA256 === selected.newSHA256 ||
              reply.generationSHA256 === selected.expectedGenerationSHA256)) ||
          (status === 'unchanged' &&
            (selected.oldSHA256 !== selected.newSHA256 ||
              reply.generationSHA256 !== selected.expectedGenerationSHA256))
        )
          throw new Error('地理资源提交回执范围不匹配。')
      }
    },
    timeout
  )
}
