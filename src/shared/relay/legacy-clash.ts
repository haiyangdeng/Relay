import type { RelayBackupRestorePlan } from './backup'
import { localProxyPort } from './local-proxy'

export interface LegacyClashMigrationRequest {
  proxyPort?: number
}
export interface LegacyClashMigrationResult {
  status: 'prepared' | 'inspected' | 'cancelled'
  plan?: RelayBackupRestorePlan
  report?: LegacyClashMigrationReport
  migrationId?: string
}
export function legacyClashMigrationRequest(raw: unknown): LegacyClashMigrationRequest {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('旧备份迁移参数无效。')
  const item = raw as Record<string, unknown>
  if (Object.keys(item).some((key) => key !== 'proxyPort'))
    throw new Error('旧备份迁移仅接受可选本地代理端口。')
  return item.proxyPort === undefined ? {} : { proxyPort: localProxyPort(item.proxyPort) }
}

export type LegacyClashDisposition = 'applied' | 'retained' | 'decision-required'
export interface LegacySubStoreItemReport {
  kind: 'subscription' | 'collection' | 'section'
  oldName?: string
  newName?: string
  disposition: 'accepted' | 'retained'
  reason: string
}
export interface LegacySubStoreSummary {
  schema: 'legacy-map' | '2.0'
  subscriptions: number
  collections: number
  items: LegacySubStoreItemReport[]
}
export interface LegacyClashMigrationReport {
  format: 'clash-party-legacy-zip'
  archiveSHA256: string
  containsSecrets: true
  substore?: LegacySubStoreSummary
  files: {
    path: string
    bytes: number
    sha256: string
    disposition: LegacyClashDisposition
    reason: string
  }[]
  profiles: {
    legacyId: string
    profileId?: string
    sourceId?: string
    disposition: LegacyClashDisposition
    reason: string
  }[]
  counts: {
    profiles: number
    sources: number
    overrides: number
    rulePatches: number
    applied: number
    retained: number
    'decision-required': number
  }
}
