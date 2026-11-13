import { pluginRoute, type RelayPluginRoute } from '../../../shared/relay/plugins'
import { isForbiddenHost } from '../../resolve/plugin/net-guard'
import { createRelayPluginContext } from './transport'

export interface DescriptorSource {
  url: string
  route: RelayPluginRoute
}
export function descriptorSource(raw: unknown): DescriptorSource {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'route,url'
  )
    throw new Error('描述来源只接受HTTPS地址和网络路由。')
  const input = raw as Record<string, unknown>
  if (
    typeof input.url !== 'string' ||
    input.url.length > 4096 ||
    [...input.url].some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) === 127)
  )
    throw new Error('描述地址无效。')
  const url = new URL(input.url)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    isForbiddenHost(url.hostname)
  )
    throw new Error('描述来源必须是无内嵌凭据的公开HTTPS地址。')
  return { url: url.href, route: pluginRoute(input.route) }
}
export async function downloadDescriptor(
  source: DescriptorSource,
  signal: AbortSignal,
  adapters: Pick<Parameters<typeof createRelayPluginContext>[0], 'proxy' | 'request' | 'resolveAll'>
): Promise<string> {
  const selected = descriptorSource(source)
  const context = createRelayPluginContext({
    ...adapters,
    signal,
    record: { route: selected.route, approvedOrigins: [new URL(selected.url).origin] }
  })
  const result = await context.requester.request(selected.url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
    maxBytes: 1024 * 1024
  })
  if (signal.aborted || result.status !== 200 || Buffer.byteLength(result.body) > 1024 * 1024)
    throw new Error('描述下载未确认或超出1MiB限制。')
  return result.body
}
