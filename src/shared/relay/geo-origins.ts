import type {
  ResourceCheckResult,
  ResourceDescriptor,
  ResourceInfo,
  ResourcePreparation
} from './resources'
import type { RelayProfileSelection } from './runtime'
import { sourceSelection, type SourceSchedule } from './subscription-sources'

export const geoResourceKinds = ['geoip-dat', 'geosite-dat', 'country-mmdb', 'asn-mmdb'] as const
export type GeoResourceKind = (typeof geoResourceKinds)[number]
export type GeoResourceDescriptor = ResourceDescriptor & {
  kind: GeoResourceKind
  behavior: null
}
export interface GeoOriginDefinition {
  descriptor: GeoResourceDescriptor
  source: {
    kind: 'http'
    url: string
    proxyPort: number
    headers: Record<string, string>
  }
  expectedSHA256: string
  // Requested intent survives persistence. No runtime grant or active receipt
  // belongs in this definition or in a restored backup.
  autoIntent: { requested: boolean; schedule: SourceSchedule }
}
export interface GeoOriginSelection {
  id: string
  revision: string
}
interface GeoOriginHeadBase {
  resource: RelayProfileSelection
  originRevision: string
  acquiredAt: string
}
export type GeoOriginHead = GeoOriginHeadBase &
  (
    | { resourceRevision: string; receipt?: never }
    | { receipt: { version: 1; metadataSHA256: string }; resourceRevision?: never }
  )
export interface GeoOriginInfo extends GeoOriginSelection {
  originRevision: string
  descriptor: GeoResourceDescriptor
  origin: string
  proxyPort: number
  hasPrivateHeaders: boolean
  expectedSHA256: string
  autoIntent: GeoOriginDefinition['autoIntent']
  createdAt: string
  updatedAt: string
  head?: GeoOriginHead
}
// Private URL/header detail is returned only by an explicit selected read.
export interface GeoOriginRecord {
  info: GeoOriginInfo
  definition: GeoOriginDefinition
}
export interface GeoOriginInventory {
  origins: GeoOriginInfo[]
  incomplete: number
  warnings: string[]
}
export interface GeoOriginSaveRequest {
  origin: GeoOriginSelection | null
  definition: GeoOriginDefinition
}
export interface GeoOriginSavePlan {
  evidenceId: string
  previous?: GeoOriginSelection
  descriptor: GeoResourceDescriptor
  origin: string
  proxyPort: number
  privateHeaders: boolean
  expectedSHA256: string
  autoIntent: GeoOriginDefinition['autoIntent']
}
export interface GeoOriginFetchPlan {
  origin: GeoOriginInfo
  preparation: ResourcePreparation
}
export interface GeoOriginOperationResult {
  status: 'saved' | 'updated' | 'cancelled' | 'failed' | 'uncertain'
  origin?: GeoOriginInfo
  resource?: ResourceInfo
  check?: ResourceCheckResult
  warnings: string[]
}
export interface GeoOriginServiceState {
  pending: boolean
  // Background grants never expose their operation's cancellation ticket.
  automatic?: true
  phase:
    | 'idle'
    | 'reading'
    | 'confirmingDefinition'
    | 'savingDefinition'
    | 'confirmingDownload'
    | 'acquiring'
    | 'checking'
    | 'publishing'
  operationId?: string
  originId?: string
}
export function isGeoResourceKind(value: unknown): value is GeoResourceKind {
  return geoResourceKinds.some((kind) => kind === value)
}
export function geoOriginSelection(raw: unknown): GeoOriginSelection {
  return sourceSelection(raw)
}
