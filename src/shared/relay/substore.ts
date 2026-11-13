import type { RelayProfileSelection } from './runtime'
export interface SubStoreAdvancedStart {
  profile: RelayProfileSelection
  target: string
  mode: 'local' | 'remote'
  backendURL: string
  allowLan: boolean
  syncCron: string
  downloadCron: string
  uploadCron: string
}
export interface SubStoreItem {
  name: string
  displayName?: string
}
export interface SubStoreRecovery {
  pid?: number
  egressPID?: number
  canArchive: boolean
  revision?: string
}
export interface SubStoreState {
  phase: 'idle' | 'acquiring' | 'starting' | 'running' | 'stopping' | 'failed' | 'uncertain'
  pending: boolean
  resourcesReady: boolean
  backendVersion: string
  frontendVersion: string
  pid?: number
  frontendURL?: string
  proxyPort?: number
  mode?: 'local' | 'remote'
  allowLan?: boolean
  backendOrigin?: string
  lanURL?: string
  tasks?: { sync: string; download: string; upload: string }
  recovery?: SubStoreRecovery
  warnings: string[]
}
export interface SubStoreConversion {
  evidenceId: string
  name: string
  sha256: string
  bytes: number
}
export function subStoreProxy(value: unknown): { proxyPort: number } {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'proxyPort'
  )
    throw new Error('Sub-Store只接受本次代理端口。')
  const port = (value as { proxyPort: unknown }).proxyPort
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Sub-Store代理端口无效。')
  return { proxyPort: port }
}
export function subStoreSelection(value: unknown): {
  kind: 'subscription' | 'collection'
  name: string
} {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'kind,name'
  )
    throw new Error('Sub-Store选择无效。')
  const item = value as Record<string, unknown>
  if (
    !['subscription', 'collection'].includes(String(item.kind)) ||
    typeof item.name !== 'string' ||
    !item.name.trim() ||
    item.name.length > 128 ||
    Array.from(item.name).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('Sub-Store订阅或集合名称无效。')
  return { kind: item.kind as 'subscription' | 'collection', name: item.name }
}
export function subStoreEvidence(value: unknown): string {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'evidenceId'
  )
    throw new Error('Sub-Store保存凭据无效。')
  const id = (value as { evidenceId: unknown }).evidenceId
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))
    throw new Error('Sub-Store保存凭据无效。')
  return id
}
