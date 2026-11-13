import type { RelayBackupRestorePlan } from './backup'
import type { LegacyClashMigrationReport } from './legacy-clash'
import type { RelayStoredProfile } from './profiles'

export type LegacyRelayOrigin = 'Relay' | 'Relay-Preview'
export interface LegacyRelayInspectRequest {
  origin: LegacyRelayOrigin
}
export interface LegacyRelayProfileSelection {
  id: string
  sha256: string
  revision: string
}
export interface LegacyRelayPrepareRequest {
  inspectionId: string
  profiles: LegacyRelayProfileSelection[]
}
export interface LegacyRelayInspection {
  inspectionId: string
  origin: LegacyRelayOrigin
  sourceSHA256: string
  preparedAt: number
  expiresAt: number
  profiles: (RelayStoredProfile & { revision: string })[]
  incomplete: number
  warnings: string[]
}
export interface LegacyRelayMigrationReport {
  format: 'relay-legacy-profiles-v1'
  origin: LegacyRelayOrigin
  sourceSHA256: string
  originalArchiveSHA256: string
  containsSecrets: true
  profiles: {
    legacyId: string
    legacySHA256: string
    legacyRevision: string
    profileId: string
    profileSHA256: string
  }[]
  warnings: string[]
}
export type LegacyMigrationReport = LegacyClashMigrationReport | LegacyRelayMigrationReport
export interface LegacyRelayInspectResult {
  status: 'inspected' | 'cancelled'
  inspection?: LegacyRelayInspection
}
export interface LegacyRelayMigrationResult {
  status: 'prepared' | 'cancelled'
  plan?: RelayBackupRestorePlan
  report?: LegacyRelayMigrationReport
  migrationId?: string
}

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const sha = /^[a-f0-9]{64}$/u
export function legacyRelayInspectRequest(raw: unknown): LegacyRelayInspectRequest {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).join(',') !== 'origin'
  )
    throw new Error('旧Relay检查仅接受固定来源标识，不接受路径。')
  const origin = (raw as { origin?: unknown }).origin
  if (origin !== 'Relay' && origin !== 'Relay-Preview') throw new Error('旧Relay来源未支持。')
  return { origin }
}
export function legacyRelayPrepareRequest(raw: unknown): LegacyRelayPrepareRequest {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'inspectionId,profiles'
  )
    throw new Error('旧Relay迁移仅接受本次检查凭据和所选记录。')
  const input = raw as Record<string, unknown>
  if (
    typeof input.inspectionId !== 'string' ||
    !uuid.test(input.inspectionId) ||
    !Array.isArray(input.profiles) ||
    !input.profiles.length ||
    input.profiles.length > 200
  )
    throw new Error('旧Relay检查凭据或选择数量无效。')
  const seen = new Set<string>(),
    profiles = input.profiles.map((raw): LegacyRelayProfileSelection => {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(',') !== 'id,revision,sha256'
      )
        throw new Error('旧配置选择字段无效。')
      const item = raw as Record<string, unknown>
      if (
        typeof item.id !== 'string' ||
        !uuid.test(item.id) ||
        seen.has(item.id) ||
        typeof item.sha256 !== 'string' ||
        !sha.test(item.sha256) ||
        typeof item.revision !== 'string' ||
        !sha.test(item.revision)
      )
        throw new Error('旧配置选择标识、摘要或修订无效。')
      seen.add(item.id)
      return { id: item.id, sha256: item.sha256, revision: item.revision }
    })
  return { inspectionId: input.inspectionId, profiles }
}
