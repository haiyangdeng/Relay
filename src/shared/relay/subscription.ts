import { stripProfileControls, type RelayProfilePreparation } from './profiles'
import { localProxyPort } from './local-proxy'

export interface SubscriptionRequest {
  name: string
  url: string
  proxyPort: number
}
export interface SubscriptionPreparation {
  evidenceId: string
  name: string
  origin: string
  proxyPort: number
}
export interface SubscriptionDownloadResult {
  status: 'cancelled' | 'downloaded' | 'rejected' | 'failed'
  profile?: RelayProfilePreparation
  warnings: string[]
}
export interface SubscriptionState {
  phase: 'idle' | 'confirmingDownload' | 'downloading' | 'downloaded' | 'confirmingSave' | 'saving'
  pending: boolean
  operationId?: string
  preparedId?: string
  stagedId?: string
}
export function subscriptionRequest(raw: unknown): SubscriptionRequest {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'name,proxyPort,url'
  )
    throw new Error('只接受订阅名称、HTTP(S)地址和本地代理端口。')
  const input = raw as Record<string, unknown>
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 120 ||
    stripProfileControls(input.name) !== input.name ||
    typeof input.url !== 'string' ||
    input.url.length > 4096 ||
    input.url.trim() !== input.url ||
    stripProfileControls(input.url) !== input.url
  )
    throw new Error('订阅名称或地址无效。')
  let url: URL
  try {
    url = new URL(input.url)
  } catch {
    throw new Error('订阅地址无效。')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && Number(url.port) === 0)
  )
    throw new Error('订阅仅支持无用户信息、无片段的HTTP(S)地址。')
  return { name: input.name, url: url.toString(), proxyPort: localProxyPort(input.proxyPort) }
}
