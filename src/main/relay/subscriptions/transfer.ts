import { validateHeaderName, validateHeaderValue } from 'http'
import { requestOnce } from '../../resolve/plugin/http-client'
import {
  codeOf,
  CPX_TIMEOUT,
  CPX_REDIRECT_REFUSED,
  CPX_RESPONSE_TOO_LARGE
} from '../../resolve/plugin/errors'
import { subscriptionRequest } from '../../../shared/relay/subscription'
import { PROFILE_BYTE_LIMIT } from '../profiles/inspect'

export function providerHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined) return {}
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype
  )
    throw new Error('提供者请求头格式无效。')
  const result: Record<string, string> = {}
  let bytes = 0
  for (const [key, values] of Object.entries(raw)) {
    const value = Array.isArray(values) && values.length === 1 ? values[0] : undefined
    const lower = key.toLowerCase()
    if (
      typeof value !== 'string' ||
      key.length > 128 ||
      value.length > 4096 ||
      Object.hasOwn(result, lower) ||
      [
        'host',
        'content-length',
        'connection',
        'transfer-encoding',
        'proxy-authorization',
        'proxy-connection',
        '__proto__',
        'constructor',
        'prototype'
      ].includes(lower) ||
      (lower === 'accept-encoding' && value !== 'identity')
    )
      throw new Error('提供者请求头不属于当前受控范围。')
    try {
      validateHeaderName(key)
      validateHeaderValue(key, value)
    } catch {
      throw new Error('提供者请求头无效。')
    }
    bytes += Buffer.byteLength(key + value)
    if (bytes > 16384 || Object.keys(result).length >= 30) throw new Error('提供者请求头超过预算。')
    result[lower] = value
  }
  return result
}

export const SUBSCRIPTION_TIMEOUT = 15000
export class SubscriptionTransferError extends Error {
  constructor(
    readonly reason:
      'timeout' | 'redirect' | 'size' | 'status' | 'encoding' | 'transport' | 'tlsContext'
  ) {
    super(
      {
        timeout: '订阅请求超时，未重试或回退直连。',
        redirect: '订阅返回重定向，本阶段不自动跟随。',
        size: '资源超过本次读取预算，已停止读取。',
        status: '订阅未返回完整成功响应，未保存。',
        encoding: '订阅编码未支持；仅接受未压缩、无替换字符的UTF-8文本。',
        transport: '订阅代理连接或TLS校验失败；未重试或回退直连。',
        tlsContext: '当前进程关闭了TLS证书校验，已阻止订阅请求。'
      }[reason]
    )
  }
}
// Reuse only the bounded single-request transport. Do not import upstream
// routing/retry, subscription schedulers, logging or lifecycle controllers.
export async function downloadSubscription(
  url: string,
  proxyPort: number,
  signal: AbortSignal,
  headers?: Record<string, string>,
  maxBytes = PROFILE_BYTE_LIMIT
): Promise<string> {
  const input = subscriptionRequest({ name: 'Transfer', url, proxyPort })
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > PROFILE_BYTE_LIMIT)
    throw new Error('读取预算无效。')
  if (new URL(input.url).protocol === 'https:' && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new SubscriptionTransferError('tlsContext')
  try {
    const response = await requestOnce(input.url, {
      method: 'GET',
      headers:
        headers === undefined
          ? { 'User-Agent': 'clash.meta/Relay', 'Accept-Encoding': 'identity' }
          : {
              'user-agent': 'clash.meta/Relay',
              'accept-encoding': 'identity',
              ...providerHeaders(
                Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, [value]]))
              )
            },
      timeout: SUBSCRIPTION_TIMEOUT,
      maxBytes,
      proxy: { host: '127.0.0.1', port: input.proxyPort },
      signal
    })
    if (response.status !== 200) throw new SubscriptionTransferError('status')
    const encoding = response.headers['content-encoding']
    // requestOnce decodes to a string. Refuse U+FFFD too, rather than silently
    // accepting invalid bytes (or ambiguously re-encoding a credential).
    if (
      (encoding !== undefined && encoding !== 'identity') ||
      response.body.includes('\ufffd') ||
      response.body.includes('\0')
    )
      throw new SubscriptionTransferError('encoding')
    return response.body
  } catch (error) {
    if (error instanceof SubscriptionTransferError) throw error
    const code = codeOf(error)
    throw new SubscriptionTransferError(
      code === CPX_TIMEOUT
        ? 'timeout'
        : code === CPX_REDIRECT_REFUSED
          ? 'redirect'
          : code === CPX_RESPONSE_TOO_LARGE
            ? 'size'
            : 'transport'
    )
  }
}
