import { profileSelection } from './runtime'
import { geoOriginSelection, type GeoOriginSelection, type GeoResourceKind } from './geo-origins'

export interface TunResourceReadRequest {
  sessionId: string
}
export interface TunResourceReplaceRequest extends TunResourceReadRequest {
  configurationRevision: string
  expectedGenerationSHA256: string
  origin: GeoOriginSelection
}
export interface TunResourceEntry {
  kind: GeoResourceKind
  sha256: string
  bytes: number
  active: boolean
}
export interface TunResourcesSnapshot {
  sessionId: string
  configurationRevision: string
  generationSHA256: string
  resources: TunResourceEntry[]
}
export type TunResourcesResult =
  | {
      status: 'snapshot' | 'updated' | 'unchanged'
      sessionId: string
      snapshot: TunResourcesSnapshot
    }
  | {
      status:
        'busy' | 'cancelled' | 'uncertain' | 'stale' | 'expired' | 'unsupported' | 'unavailable'
      sessionId: string
    }

function input(raw: unknown, fields: string): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== fields
  )
    throw new Error('活动地理资源操作只接受已读取的会话、代际和来源选择。')
  return raw as Record<string, unknown>
}
export function tunResourceReadRequest(raw: unknown): TunResourceReadRequest {
  const value = input(raw, 'sessionId'),
    sessionId = profileSelection({ id: value.sessionId, sha256: '0'.repeat(64) }).id
  return { sessionId }
}
export function tunResourceReplaceRequest(raw: unknown): TunResourceReplaceRequest {
  const value = input(raw, 'configurationRevision,expectedGenerationSHA256,origin,sessionId'),
    selected = profileSelection({ id: value.sessionId, sha256: value.configurationRevision }),
    generation = profileSelection({ id: selected.id, sha256: value.expectedGenerationSHA256 })
  return {
    sessionId: selected.id,
    configurationRevision: selected.sha256,
    expectedGenerationSHA256: generation.sha256,
    origin: geoOriginSelection(value.origin)
  }
}
