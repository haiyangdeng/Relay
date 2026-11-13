export const RUNTIME_GIST_FILENAME = 'clash-party.yaml'
export const RUNTIME_GIST_MAX_BYTES = 512 * 1024
export type RelayRuntimeGistSource =
  { kind: 'local-proxy' } | { kind: 'tun-managed'; sessionId: string }
export function runtimeGistSource(raw: unknown): RelayRuntimeGistSource | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('运行配置来源无效。')
  const value = raw as Record<string, unknown>
  if (value.kind === 'local-proxy' && Object.keys(value).join(',') === 'kind')
    return { kind: 'local-proxy' }
  if (
    value.kind === 'tun-managed' &&
    Object.keys(value).length === 2 &&
    Object.keys(value).every((key) => key === 'kind' || key === 'sessionId') &&
    typeof value.sessionId === 'string' &&
    /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.sessionId)
  )
    return { kind: 'tun-managed', sessionId: value.sessionId }
  throw new Error('运行配置来源只接受本地代理或明确的TUN会话。')
}
export function sameRuntimeGistSource(
  left: RelayRuntimeGistSource | undefined,
  right: RelayRuntimeGistSource | undefined
): boolean {
  return (
    (left?.kind ?? 'local-proxy') === (right?.kind ?? 'local-proxy') &&
    (left?.kind !== 'tun-managed' ||
      (right?.kind === 'tun-managed' && left.sessionId === right.sessionId))
  )
}
export interface RelayRuntimeGistRequest {
  source?: RelayRuntimeGistSource
  proxyPort: number
  token: string
  gistId?: string
  recipient?: string
}
export interface RelayRuntimeGistPlan {
  source?: RelayRuntimeGistSource
  evidenceId: string
  action: 'create' | 'update'
  endpoint: string
  filename: typeof RUNTIME_GIST_FILENAME
  gistId?: string
  proxyPort: number
  encrypted: boolean
  containsSecrets: true
  instanceId: string
  configurationRevision: string
  configurationSHA256: string
  configurationBytes: number
  payloadSHA256: string
  payloadBytes: number
  expiresAt: number
}
export interface RelayRuntimeGistResult {
  status: 'uploaded' | 'cancelled' | 'uncertain'
  gistId?: string
  url?: string
}
export function runtimeGistRequest(raw: unknown): RelayRuntimeGistRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('运行配置Gist参数无效。')
  const input = raw as Record<string, unknown>
  if (
    Object.keys(input).some(
      (key) => !['proxyPort', 'token', 'gistId', 'recipient', 'source'].includes(key)
    ) ||
    !Number.isInteger(input.proxyPort) ||
    Number(input.proxyPort) < 1024 ||
    Number(input.proxyPort) > 65535 ||
    typeof input.token !== 'string' ||
    input.token.length < 8 ||
    input.token.length > 500 ||
    !/^[\x21-\x7e]+$/u.test(input.token) ||
    (input.gistId !== undefined &&
      (typeof input.gistId !== 'string' ||
        (input.gistId !== '' && !/^[a-f0-9]{5,64}$/u.test(input.gistId)))) ||
    (input.recipient !== undefined &&
      (typeof input.recipient !== 'string' ||
        input.recipient.length > 4096 ||
        [...input.recipient].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )))
  )
    throw new Error('运行配置Gist只接受本次Token、指定ID、AGE接收者和本地代理端口。')
  const source = runtimeGistSource(input.source)
  return {
    ...(source ? { source } : {}),
    proxyPort: Number(input.proxyPort),
    token: input.token,
    ...(input.gistId ? { gistId: input.gistId } : {}),
    ...(input.recipient ? { recipient: input.recipient } : {})
  }
}
