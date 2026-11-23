import { localProxyPlan, type LocalProxyPlan } from '../../../shared/relay/local-proxy-plan'
import { localProxyPortsFor } from '../../../shared/relay/local-proxy-ports'
import type { LocalProxyGroup } from '../../../shared/relay/local-proxy'
import { injectDedicatedListeners } from '../core/dedicated-listeners'
import { applySavedSelectorDefaults } from '../core/startup-node'
import { mergeDedicatedPinnedNode } from '../core/dedicated-pinned-node'
import { plainConfigurationMap } from '../profiles/document'

type Selection = Pick<LocalProxyGroup, 'name' | 'now' | 'confirmed' | 'type'> & {
  members?: readonly string[]
}

// Apply to the composed configuration after overrides, before resource binding.
// Switching the core owner must preserve the ordinary and fixed AI entry points.
export function tunLocalPlanProjection(
  source: Record<string, unknown>,
  rawPlan: LocalProxyPlan,
  pinnedNode?: Record<string, unknown>,
  selections: readonly Selection[] = [],
  savedSelectors?: ReadonlyMap<string, string>
): Record<string, unknown> {
  const plan = localProxyPlan(rawPlan),
    ports = localProxyPortsFor(plan.httpPort, plan.ports),
    configuration = structuredClone(source)
  configuration.listeners = []
  mergeDedicatedPinnedNode(configuration, plan.dedicated, pinnedNode)
  injectDedicatedListeners(configuration, plan.dedicated)
  // The fixed Mihomo HTTP inbound is TCP-only and has no UDP option. The
  // ordinary owned-core validator retains its separate, stricter entry shape.
  if (Array.isArray(configuration.listeners))
    for (const listener of configuration.listeners)
      if (plainConfigurationMap(listener) && listener.type === 'http') delete listener.udp
  if (savedSelectors) applySavedSelectorDefaults(configuration, savedSelectors)
  const groups: unknown[] = Array.isArray(configuration['proxy-groups'])
    ? configuration['proxy-groups']
    : []
  for (const selection of selections) {
    if (selection.type !== 'select' || !selection.confirmed || !selection.now) continue
    let group = groups.find(
      (entry): entry is Record<string, unknown> =>
        plainConfigurationMap(entry) && entry.name === selection.name && entry.type === 'select'
    )
    if (!group && selection.name === 'GLOBAL') {
      const members = selection.members
      if (
        !members?.length ||
        members.length > 2000 ||
        !members.includes(selection.now) ||
        members.includes('GLOBAL') ||
        new Set(members).size !== members.length ||
        groups.some((entry) => plainConfigurationMap(entry) && entry.name === 'GLOBAL')
      )
        throw new Error('当前 GLOBAL 节点选择未完整确认；未切换核心。')
      // Mihomo only synthesizes GLOBAL when it is absent. An explicit selector
      // keeps the observed implicit group's membership, order and current route.
      group = { name: 'GLOBAL', type: 'select', proxies: [...members] }
      groups.push(group)
      configuration['proxy-groups'] = groups
    }
    if (!group) throw new Error('当前节点选择与 TUN 配置不一致；未切换核心。')
    // Mihomo's native selector option preserves the selected route without
    // reordering members or replacing dynamic provider expansion.
    group['default-selected'] = selection.now
  }
  return {
    port: ports.http,
    'socks-port': ports.socks,
    'mixed-port': ports.mixed,
    'redir-port': ports.redir,
    'tproxy-port': 0,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    listeners: configuration.listeners,
    ...(configuration.proxies === undefined ? {} : { proxies: configuration.proxies }),
    ...(configuration['proxy-groups'] === undefined
      ? {}
      : { 'proxy-groups': configuration['proxy-groups'] })
  }
}
