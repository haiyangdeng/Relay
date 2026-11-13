import { stripProfileControls, type RelayStoredProfile } from './profiles'
import { profileSelection, type RelayProfileSelection } from './runtime'
import { localProxyPort } from './local-proxy'

export interface ProviderResource {
  id: string
  sha256: string
  createdAt: string
  nodes: number
}
export interface ProviderItem {
  name: string
  kind: 'file' | 'http' | 'inline' | 'unsupported'
  origin?: string
  nodes?: number
  canAcquire: boolean
  issues: string[]
  resources: ProviderResource[]
}
export interface ProviderInventory {
  profile: RelayStoredProfile
  providers: ProviderItem[]
  incomplete: number
  warnings: string[]
}
export interface ProviderPreparation {
  evidenceId: string
  profile: RelayStoredProfile
  provider: ProviderItem
  proxyPort: number
}
export interface ProviderFetchResult {
  status: 'cancelled' | 'cached' | 'failed' | 'uncertain'
  resource?: ProviderResource
  warnings: string[]
}
export interface ProviderBatchPreparation {
  evidenceId: string
  profile: RelayStoredProfile
  providers: ProviderItem[]
  proxyPort: number
}
export interface ProviderBatchFetchResult {
  status: ProviderFetchResult['status'] | 'partial'
  items: {
    provider: string
    status: ProviderFetchResult['status'] | 'skipped'
    resource?: ProviderResource
  }[]
  warnings: string[]
}
export interface ProviderSnapshotPreparation {
  evidenceId: string
  profile: RelayStoredProfile
  sha256: string
  bytes: number
  nodes: number
  canSave: boolean
  issues: string[]
}
export interface ProviderState {
  phase: 'idle' | 'reading' | 'confirming' | 'acquiring' | 'saving' | 'building'
  pending: boolean
  operationId?: string
  preparedId?: string
  batchPreparedId?: string
  snapshotId?: string
}
export function providerName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    stripProfileControls(value) !== value
  )
    throw new Error('提供者名称无效。')
  return value
}
export function providerRequest(raw: unknown): {
  profile: RelayProfileSelection
  provider: string
  proxyPort: number
} {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'profile,provider,proxyPort'
  )
    throw new Error('只接受配置选择、提供者名称和本地代理端口。')
  const value = raw as Record<string, unknown>
  return {
    profile: profileSelection(value.profile),
    provider: providerName(value.provider),
    proxyPort: localProxyPort(value.proxyPort)
  }
}
export function providerBatchRequest(raw: unknown): {
  profile: RelayProfileSelection
  providers: string[]
  proxyPort: number
} {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'profile,providers,proxyPort'
  )
    throw new Error('只接受配置选择、待核对的提供者列表和本地代理端口。')
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.providers) || !value.providers.length || value.providers.length > 64)
    throw new Error('提供者列表必须包含1至64项。')
  const providers = Array.from(value.providers, providerName)
  if (new Set(providers).size !== providers.length) throw new Error('提供者列表有重复名称。')
  return {
    profile: profileSelection(value.profile),
    providers,
    proxyPort: localProxyPort(value.proxyPort)
  }
}
export function providerSnapshotRequest(raw: unknown): {
  profile: RelayProfileSelection
  resources: Record<string, RelayProfileSelection>
} {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'profile,resources'
  )
    throw new Error('只接受配置选择和逐项缓存选择。')
  const value = raw as Record<string, unknown>,
    entries = value.resources
  if (
    !entries ||
    typeof entries !== 'object' ||
    Array.isArray(entries) ||
    Object.getPrototypeOf(entries) !== Object.prototype ||
    Object.keys(entries).length > 64
  )
    throw new Error('缓存选择格式或数量无效。')
  const resources: Record<string, RelayProfileSelection> = {}
  for (const [name, selection] of Object.entries(entries)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name))
      throw new Error('提供者名称无效。')
    resources[providerName(name)] = profileSelection(selection)
  }
  return { profile: profileSelection(value.profile), resources }
}
