import type { RelayStoredProfile } from './profiles'

export type RelayPluginRoute = 'auto' | 'direct' | 'proxy'
export type RelayPluginStatus = 'needs-login' | 'active' | 'needs-reauth' | 'uncertain'
export interface RelayPluginRecord {
  id: string
  descriptor: IPluginDescriptor
  route: RelayPluginRoute
  approvedOrigins: string[]
  status: RelayPluginStatus
  createdAt: number
  updatedAt: number
  discovery?: IDiscoveryCandidate
  // Preference for one exact current origin/endpoints/seq/digest target; no new grant.
  lastGoodTarget?: string
  subscription?: { sha256: string; size: number; savedAt: number }
  lastError?: 'network' | 'credentials' | 'invalid-subscription' | 'storage' | 'cancelled'
}
export interface RelayPluginState {
  pending: boolean
  operation?:
    | 'install'
    | 'login'
    | 'update'
    | 'remove'
    | 'save-profile'
    | 'preview-remote'
    | 'preview-file'
    | 'rediscover'
  operationId?: string
  uncertain: boolean
  records: RelayPluginRecord[]
  warnings: string[]
  automaticUpdatesEnabled: boolean
}
export interface RelayPluginPreview {
  descriptor: IPluginDescriptor
  origins: string[]
  sha256: string
}
export type RelayPluginRemotePreview =
  { status: 'cancelled' } | { status: 'preview'; preview: RelayPluginPreview; text: string }
export type RelayPluginResult =
  | { status: 'cancelled' }
  | { status: 'installed' | 'updated' | 'removed' | 'rediscovered'; id: string }
  | { status: 'saved-profile'; id: string; profile: RelayStoredProfile }

export type RelayPluginScheduleStatus =
  | 'armed'
  | 'updated'
  | 'failed'
  | 'credentials'
  | 'changed'
  | 'uncertain'
  | 'cancelled'
  | 'busy'
  | 'stopped'
  | 'suspended'
export interface RelayPluginSchedulerState {
  pending: boolean
  suspended?: boolean
  entries: {
    id: string
    name: string
    route: RelayPluginRoute
    origins: string[]
    discoveryRevision: string
    minutes: number
    enabled: boolean
    nextAt?: string
    lastStatus?: RelayPluginScheduleStatus
    failureCount: number
  }[]
}

export function pluginId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value))
    throw new Error('插件ID无效。')
  return value
}
export function pluginRoute(value: unknown): RelayPluginRoute {
  if (value !== 'auto' && value !== 'direct' && value !== 'proxy') throw new Error('插件路由无效。')
  return value
}
