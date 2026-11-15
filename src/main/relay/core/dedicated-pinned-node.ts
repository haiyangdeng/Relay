import { createHash } from 'node:crypto'
import type { DedicatedListenerPlan } from '../../../shared/relay/dedicated-listeners'
import { dedicatedListeners } from '../../../shared/relay/dedicated-listeners'
import { plainConfigurationMap } from '../profiles/document'
import { inspectNode, projectNode } from '../profiles/nodes'
import { validateDedicatedRoute } from './dedicated-listeners'

type Node = Record<string, unknown>

export function canonicalDedicatedPinnedNode(value: unknown, route: string): Node {
  dedicatedListeners({ route, httpPort: 17891 })
  if (!plainConfigurationMap(value) || value.name !== route)
    throw new Error('固定专用节点与所选名称不一致。')
  const inspection = inspectNode(value)
  if (!inspection.supported || inspection.requiresResources)
    throw new Error('固定专用节点包含不支持的字段或外部文件依赖。')
  const node = projectNode(value)
  validateDedicatedRoute({ route, httpPort: 17891 }, { proxies: [node] })
  if (Buffer.byteLength(JSON.stringify(node)) > 12 * 1024)
    throw new Error('固定专用节点超过保存大小限制。')
  return structuredClone(node)
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (plainConfigurationMap(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    )
  return value
}

export function dedicatedPinnedNodeHash(node: Node): string {
  if (typeof node.name !== 'string') throw new Error('固定专用节点名称无效。')
  return createHash('sha256')
    .update(JSON.stringify(stable(canonicalDedicatedPinnedNode(node, node.name))))
    .digest('hex')
}

export function assertDedicatedPinnedNodeUnchanged(
  previous: Node,
  next: Node,
  route: string
): void {
  const find = (config: Node): Node => {
    const node = Array.isArray(config.proxies)
      ? config.proxies.find((entry) => plainConfigurationMap(entry) && entry.name === route)
      : undefined
    return canonicalDedicatedPinnedNode(node, route)
  }
  if (dedicatedPinnedNodeHash(find(previous)) !== dedicatedPinnedNodeHash(find(next)))
    throw new Error('本次热载不能更换固定专用节点的内容；已保留当前连接。')
}

// Add only the private, validated pin after compiling the ordinary subscription.
// Its input stays unchanged and no renderer-provided node object reaches here.
export function mergeDedicatedPinnedNode(
  config: Node,
  plan: DedicatedListenerPlan | undefined,
  pinned: Node | undefined
): void {
  if (!pinned) return
  if (!plan) throw new Error('固定专用节点缺少监听方案。')
  const node = canonicalDedicatedPinnedNode(pinned, plan.route)
  const proxies: Node[] = Array.isArray(config.proxies) ? config.proxies : []
  const groups: Node[] = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : []
  const providers = plainConfigurationMap(config['proxy-providers'])
    ? config['proxy-providers']
    : {}
  const collision = (): never => {
    throw new Error('新订阅含有不同的同名专用节点或代理组；已保留当前连接，请先重命名冲突项。')
  }
  if (groups.some((group) => group.name === plan.route)) collision()
  for (const provider of Object.values(providers))
    if (
      plainConfigurationMap(provider) &&
      Array.isArray(provider.payload) &&
      provider.payload.some((entry) => plainConfigurationMap(entry) && entry.name === plan.route)
    )
      collision()
  const existing = proxies.find((entry) => entry.name === plan.route)
  if (existing) {
    if (dedicatedPinnedNodeHash(existing) !== dedicatedPinnedNodeHash(node)) collision()
    return
  }
  // Keep the core's expansion, include filters and sorting. Explicit `proxies`
  // do not have the same filtering/order semantics as include-all. The original
  // exclude expression stays last and unwrapped, including any inline comments.
  const escapedName = plan.route.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const exactName = `(?-imsx:\\A${escapedName}\\z)`
  for (const group of groups) {
    if (!group['include-all'] && !group['include-all-proxies']) continue
    const excluded = group['exclude-filter']
    group['exclude-filter'] =
      typeof excluded === 'string' && excluded ? `${exactName}|${excluded}` : exactName
  }
  config.proxies = [...proxies, node]
}
