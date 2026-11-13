import { profileSelection, type RelayProfileSelection } from './runtime'

export type SourceSchedule =
  { kind: 'manual' } | { kind: 'interval'; minutes: number } | { kind: 'cron'; expression: string }
export interface SourceOptions {
  headers: Record<string, string>
  ageSecretKey: string
  redirects: 'none' | 'same-origin' | 'https'
  schedule: SourceSchedule
  useServerInterval: boolean
}
export const sourceRequestTimeoutSeconds = 15
export interface SourceRequestTuning {
  timeoutSeconds?: number
  userAgent?: string
}
export interface SourceMetadata {
  checkedAt: string
  status: 200 | 304
  resourceSHA256: string
  etag?: string
  lastModified?: string
  quota?: { upload?: number; download?: number; total?: number; expire?: number }
  intervalMinutes?: number
  filename?: string
  homeOrigin?: string
  homeURL?: string
}
export interface SourceTransferResult {
  status: 'downloaded' | 'notModified'
  text?: string
  metadata: SourceMetadata
}

export interface SubscriptionSourceSelection {
  id: string
  revision: string
}
export interface SubscriptionVersion {
  id: string
  createdAt: string
  action: 'update' | 'restore'
  profile: RelayProfileSelection
  restoredFrom?: string
}
export interface SubscriptionSourceInfo extends SubscriptionSourceSelection {
  name: string
  origin: string
  proxyPort: number
  createdAt: string
  versions: SubscriptionVersion[]
  locked: boolean
  schedule?: SourceSchedule
  redirectPolicy?: SourceOptions['redirects']
  hasPrivateHeaders?: boolean
  hasAgeIdentity?: boolean
  observation?: Omit<SourceMetadata, 'resourceSHA256' | 'etag' | 'lastModified' | 'homeURL'>
}
export interface SubscriptionSourceInventory {
  sources: SubscriptionSourceInfo[]
  incomplete: number
  warnings: string[]
}
export interface SubscriptionSourcePlan {
  evidenceId: string
  kind: 'register' | 'update' | 'restore' | 'commit'
  name: string
  origin: string
  proxyPort: number
  source?: SubscriptionSourceSelection
  profile?: RelayProfileSelection
  bytes?: number
  sha256?: string
  observationOnly?: boolean
  requestTuning?: { timeoutSeconds: number; customUserAgent: boolean }
  options?: Omit<SourceOptions, 'headers' | 'ageSecretKey'> & {
    privateHeaders: boolean
    ageIdentity: boolean
  }
}
export interface SourceSchedulerState {
  pending: boolean
  suspended?: boolean
  entries: {
    id: string
    name: string
    origin: string
    schedule: SourceSchedule
    enabled: boolean
    nextAt?: string
    lastStatus?: string
  }[]
}
export interface SubscriptionSourceResult {
  status: 'saved' | 'staged' | 'unchanged' | 'cancelled' | 'failed' | 'uncertain'
  source?: SubscriptionSourceInfo
  plan?: SubscriptionSourcePlan
  warnings: string[]
}
export interface SubscriptionSourceState {
  phase: 'idle' | 'reading' | 'confirming' | 'downloading' | 'saving'
  pending: boolean
  operationId?: string
  preparedId?: string
}
export function sourceSelection(raw: unknown): SubscriptionSourceSelection {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'id,revision'
  )
    throw new Error('只接受来源ID和修订，不接受地址或路径。')
  const value = raw as Record<string, unknown>
  const selected = profileSelection({ id: value.id, sha256: value.revision })
  return { id: selected.id, revision: selected.sha256 }
}
export function sourceRestoreRequest(raw: unknown): {
  source: SubscriptionSourceSelection
  versionId: string
} {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'source,versionId'
  )
    throw new Error('只接受来源选择与历史版本ID。')
  const value = raw as Record<string, unknown>
  return {
    source: sourceSelection(value.source),
    versionId: profileSelection({ id: value.versionId, sha256: '0'.repeat(64) }).id
  }
}
