// Controlled dedicated listener runtime for the owned local proxy core.
//
// compileProfileRuntime always emits listeners: [] (the profile's own
// listeners are dropped by the controlled projection). This module injects
// Relay-owned dedicated HTTP/SOCKS listeners whose traffic is pinned to a
// single fixed proxy node, and provides the strict validator used by
// ownedCoreConfiguration so only these exact entries may reach the core.
import {
  dedicatedListenerNames,
  dedicatedListeners,
  dedicatedListenerSummary,
  type DedicatedListenerPlan,
  type DedicatedListenerSummary
} from '../../../shared/relay/dedicated-listeners'
import { plainConfigurationMap } from '../profiles/document'
import { canonicalNode } from '../profiles/nodes'

type Config = Record<string, unknown>

const ALLOWED_FIELDS = new Set(['name', 'type', 'port', 'listen', 'proxy', 'udp'])
const NON_PROXY_TYPES = new Set(['direct', 'dns', 'reject', 'rematch'])

function listenerEntry(
  name: (typeof dedicatedListenerNames)[number],
  type: 'http' | 'socks',
  port: number
): Record<string, unknown> {
  return { name, type, port, listen: '127.0.0.1', proxy: '', udp: false }
}

// Check the actual adapter in the compiled configuration. A custom name can
// refer to a direct or rematch adapter, and dialer-proxy can select another route.
export function validateDedicatedRoute(plan: DedicatedListenerPlan, config: Config): void {
  const nodes: unknown[] = Array.isArray(config.proxies) ? config.proxies : []
  const node = nodes.find(
    (item): item is Config => plainConfigurationMap(item) && item.name === plan.route
  )
  if (!node || typeof node.type !== 'string' || NON_PROXY_TYPES.has(node.type))
    throw new Error('专用监听路由必须是本次已校验的具体代理节点，不能选择组、直连或规则动作。')
  const dialer = canonicalNode(node)['dialer-proxy']
  if (dialer !== undefined && dialer !== null && dialer !== '')
    throw new Error('专用监听请选择未配置前置代理的节点。')
}

// Mutate the parsed runtime config to carry the dedicated listeners. The
// caller has already produced the controlled projection (listeners: []); this
// only sets the Relay-owned entries and returns the public summary.
export function injectDedicatedListeners(
  config: Config,
  plan: DedicatedListenerPlan | undefined
): DedicatedListenerSummary | undefined {
  if (!plan) {
    if (!Array.isArray(config.listeners) || config.listeners.length)
      throw new Error('受控监听器边界不符。')
    return undefined
  }
  validateDedicatedRoute(plan, config)
  const entries: Record<string, unknown>[] = []
  if (plan.httpPort !== undefined) {
    const entry = listenerEntry('relay-ai-http', 'http', plan.httpPort)
    entry.proxy = plan.route
    entries.push(entry)
  }
  if (plan.socksPort !== undefined) {
    const entry = listenerEntry('relay-ai-socks', 'socks', plan.socksPort)
    entry.proxy = plan.route
    entries.push(entry)
  }
  config.listeners = entries
  return dedicatedListenerSummary(plan)
}

// Strict validator used by ownedCoreConfiguration: only the exact Relay-owned
// dedicated listener entries (in a fixed order) are admitted. Anything else —
// a profile-injected listener, an extra field, a foreign port — is rejected so
// the controlled boundary is never widened by source input.
export function controlledListeners(value: unknown): DedicatedListenerSummary | undefined {
  if (!Array.isArray(value)) throw new Error('受控监听器边界不符。')
  if (!value.length) return undefined
  if (value.length > dedicatedListenerNames.length) throw new Error('受控监听器边界不符。')
  let httpPort: number | undefined,
    socksPort: number | undefined,
    route = ''
  for (let index = 0; index < value.length; index++) {
    const entry = value[index]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('受控监听器边界不符。')
    const keys = Object.keys(entry).sort().join(',')
    if (keys !== 'listen,name,port,proxy,type,udp') throw new Error('受控监听器边界不符。')
    const record = entry as Record<string, unknown>
    const expected = record.name
    if (
      (expected !== 'relay-ai-http' && expected !== 'relay-ai-socks') ||
      (expected === 'relay-ai-http' && index !== 0) ||
      (expected === 'relay-ai-socks' && socksPort !== undefined)
    )
      throw new Error('受控监听器边界不符。')
    if (record.type !== (expected === 'relay-ai-http' ? 'http' : 'socks'))
      throw new Error('受控监听器边界不符。')
    if (record.listen !== '127.0.0.1' || record.udp !== false)
      throw new Error('受控监听器边界不符。')
    if (
      typeof record.port !== 'number' ||
      !Number.isInteger(record.port) ||
      record.port < 1024 ||
      record.port > 65535
    )
      throw new Error('受控监听器边界不符。')
    if (typeof record.proxy !== 'string' || !record.proxy.trim() || record.proxy.length > 256)
      throw new Error('受控监听器边界不符。')
    if (route && record.proxy !== route) throw new Error('专用监听路由必须一致。')
    route = record.proxy
    if (expected === 'relay-ai-http') httpPort = record.port
    else socksPort = record.port
  }
  if (!route) throw new Error('受控监听器边界不符。')
  return dedicatedListenerSummary(
    dedicatedListeners({
      ...(httpPort !== undefined ? { httpPort } : {}),
      ...(socksPort !== undefined ? { socksPort } : {}),
      route
    })
  )
}

// Re-export the allowed-field set name list for tests.
export { ALLOWED_FIELDS }
