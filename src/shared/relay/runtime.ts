import type { RelayStoredProfile } from './profiles'

export interface RelayProfileSelection {
  id: string
  sha256: string
}
export interface RelayProfileCatalogue {
  nodes: { name: string; type: string }[]
  groups: { name: string; type: string; members: string[]; providers: string[]; dynamic: boolean }[]
  proxyProviders: string[]
  ruleProviders: string[]
  truncated: boolean
}
export interface RelayRuntimePreparation {
  evidenceId: string
  profile: RelayStoredProfile
  catalogue: RelayProfileCatalogue
  scope: 'isolated-projection'
  canValidate: boolean
  runtimeSHA256?: string
  fullSourceVerified: false
  active: false
  excluded: string[]
  issues: string[]
}
export interface RelayRuntimeCheckResult {
  status: 'passed' | 'rejected' | 'unavailable' | 'uncertain'
  scope: 'isolated-projection'
  fullSourceVerified: false
  active: false
  runtimeSHA256: string
  version?: string
  warnings: string[]
}
export function profileSelection(raw: unknown): RelayProfileSelection {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'id,sha256'
  )
    throw new Error('只接受已保存配置的ID和原文摘要。')
  const value = raw as Record<string, unknown>
  if (
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.id) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  )
    throw new Error('配置ID或原文摘要无效。')
  return { id: value.id, sha256: value.sha256 }
}
