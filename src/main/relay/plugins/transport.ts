import type { RelayPluginRecord } from '../../../shared/relay/plugins'
import {
  requestOnce,
  type PluginProxy,
  type PluginResponse,
  type PluginRequestOptions
} from '../../resolve/plugin/http-client'
import {
  createGuardedLookup,
  isForbiddenHost,
  type ResolveAll
} from '../../resolve/plugin/net-guard'
import { isFailoverError, preflightGuard } from '../../resolve/plugin/route'
import type { BaseRoute } from '../../resolve/plugin/route'
import type { RoutedRequester, OperationContext } from '../../resolve/plugin/operation'
import { abortable } from '../../resolve/plugin/abortable'

export function createRelayPluginContext(adapters: {
  record: Pick<RelayPluginRecord, 'route' | 'approvedOrigins'>
  signal: AbortSignal
  proxy(): Promise<PluginProxy>
  request?(url: string, options: PluginRequestOptions): Promise<PluginResponse>
  now?(): number
  resolveAll?: ResolveAll
}): OperationContext {
  const request = adapters.request ?? requestOnce,
    now = adapters.now ?? (() => performance.now()),
    started = now(),
    selected = new Map<string, BaseRoute>()
  const remaining = (): number => Math.max(0, 120000 - (now() - started))
  const requester: RoutedRequester = {
    async request(raw, options) {
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
        throw new Error('TLS校验关闭时不能访问插件来源。')
      const url = new URL(raw)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        isForbiddenHost(url.hostname) ||
        !adapters.record.approvedOrigins.includes(url.origin)
      )
        throw new Error('插件目标尚未授权。')
      const fixed = selected.get(url.origin),
        routes: BaseRoute[] = fixed
          ? [fixed]
          : adapters.record.route === 'auto'
            ? ['direct', 'proxy']
            : [adapters.record.route]
      let last: unknown
      for (const route of routes) {
        if (adapters.signal.aborted || remaining() < 1000) throw new Error('插件操作已取消或超时。')
        try {
          let proxy: PluginProxy | undefined
          if (route === 'proxy') {
            await preflightGuard(
              url.hostname,
              adapters.resolveAll,
              adapters.signal,
              Math.min(remaining(), 10000)
            )
            proxy = await abortable(adapters.proxy(), adapters.signal, remaining())
            if (
              proxy.host !== '127.0.0.1' ||
              !Number.isInteger(proxy.port) ||
              proxy.port < 1024 ||
              proxy.port > 65535
            )
              throw new Error('插件代理必须是已验证的本次Relay回环入口。')
          }
          const response = await request(url.href, {
            ...options,
            binary: true,
            maxBytes: Math.min(options.maxBytes, 2 * 1024 * 1024),
            signal: adapters.signal,
            timeout: Math.min(remaining(), 15000),
            proxy,
            lookup: proxy ? undefined : createGuardedLookup(adapters.resolveAll)
          })
          selected.set(url.origin, route)
          return {
            ...response,
            body: response.bytes
              ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(response.bytes)
              : response.body
          }
        } catch (error) {
          last = error
          // A consuming POST may switch routes only when transport proves it was never sent.
          if (
            fixed ||
            !isFailoverError(error, options.method === 'POST' ? 'pre-send-only' : 'safe')
          )
            throw error
        }
      }
      throw last ?? new Error('插件请求未完成。')
    }
  }
  return {
    signal: adapters.signal,
    remainingMs: remaining,
    requester,
    stage() {
      // Relay commits validated discovery through its own private store.
    }
  }
}
