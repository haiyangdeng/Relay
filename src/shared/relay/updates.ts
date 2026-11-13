export const RELAY_UPDATE_TARGETS = [
  'core',
  'core-alpha',
  'core-smart',
  'smart-model',
  'smart-model-middle',
  'smart-model-large',
  'substore-backend',
  'substore-frontend'
] as const
export type RelayUpdateTarget = (typeof RELAY_UPDATE_TARGETS)[number]
export interface RelayUpdateAsset {
  target: RelayUpdateTarget
  version: string
  architecture?: 'arm64' | 'x64'
  downloadBytes: number
  sha256: string
}
export interface RelayUpdateCandidate extends RelayUpdateAsset {
  id: string
  payloadBytes: number
  payloadSHA256: string
  stagedAt: number
  installed: false
  applied: false
}
export interface RelayUpdatePlan extends RelayUpdateAsset {
  evidenceId: string
  proxyPort: number
  expiresAt: number
}
export interface RelayUpdateState {
  trustedAssets: RelayUpdateAsset[]
  candidates: RelayUpdateCandidate[]
  incomplete: number
  pending: boolean
  appReleaseChannelConfigured: false
  smartReleaseChannelConfigured: false
  discoversLatestVersions: false
  installationSupported: false
}
export function relayUpdateRequest(value: unknown): {
  target: RelayUpdateTarget
  proxyPort: number
} {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'proxyPort,target'
  )
    throw new Error('更新获取只接受资源类型和本次HTTP代理端口。')
  const input = value as Record<string, unknown>
  if (
    !RELAY_UPDATE_TARGETS.some((target) => target === input.target) ||
    typeof input.proxyPort !== 'number' ||
    !Number.isInteger(input.proxyPort) ||
    input.proxyPort < 1024 ||
    input.proxyPort > 65535
  )
    throw new Error('更新资源类型或代理端口无效。')
  return { target: input.target as RelayUpdateTarget, proxyPort: input.proxyPort }
}
export function relayUpdateId(value: unknown, key: 'id' | 'evidenceId' = 'id'): string {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== key
  )
    throw new Error('更新操作只接受本次凭据。')
  const id = (value as Record<string, unknown>)[key]
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))
    throw new Error('更新凭据无效。')
  return id
}
