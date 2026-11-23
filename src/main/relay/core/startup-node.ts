import { isDeepStrictEqual } from 'node:util'
import type { LocalProxyGroup } from '../../../shared/relay/local-proxy'
import { plainConfigurationMap } from '../profiles/document'
import type { RelayOwnedCore } from './owned-runtime'

// Mihomo constructs selectors with default-selected before forwarding. Only
// mutate the composed runtime copy; automatic strategies keep their own order.
export function applySavedSelectorDefaults(
  configuration: Record<string, unknown>,
  saved: ReadonlyMap<string, string>
): void {
  if (!saved.size || !Array.isArray(configuration['proxy-groups'])) return
  const groups = configuration['proxy-groups']
  for (const group of groups) {
    if (!plainConfigurationMap(group) || group.type !== 'select' || typeof group.name !== 'string')
      continue
    const member = saved.get(group.name)
    if (
      member &&
      member !== group.name &&
      Array.isArray(group.proxies) &&
      group.proxies.includes(member) &&
      !group.filter &&
      !group['exclude-filter'] &&
      !group['exclude-type']
    )
      group['default-selected'] = member
  }
  const global = projectedGlobalSelector(configuration, groups, saved.get('GLOBAL'))
  if (global) groups.push(global)
}

function projectedGlobalSelector(
  configuration: Record<string, unknown>,
  groups: unknown[],
  selected: unknown
): Record<string, unknown> | undefined {
  if (typeof selected !== 'string' || !selected || selected === 'DIRECT') return
  // config.parseProxies in 3f27ef3 assembles the implicit GLOBAL in source
  // order and does not include provider payloads. An ordinary explicit group
  // uses its own name for its compatible provider: do not shadow a real one.
  const providers = configuration['proxy-providers']
  if (
    providers !== undefined &&
    (!plainConfigurationMap(providers) || Object.hasOwn(providers, 'GLOBAL'))
  )
    return
  const nodes = configuration.proxies ?? []
  const named = (
    entry: unknown
  ): entry is Record<string, unknown> & { name: string; type: string } =>
    plainConfigurationMap(entry) &&
    typeof entry.name === 'string' &&
    !!entry.name &&
    typeof entry.type === 'string' &&
    !!entry.type
  if (!Array.isArray(nodes) || !nodes.every(named) || !groups.every(named)) return
  const members = [
    'DIRECT',
    'REJECT',
    ...nodes
      .filter((node) => node.type !== 'pass' && node.type !== 'pass-rule')
      .map((node) => node.name),
    ...groups.map((group) => group.name)
  ]
  if (
    !members.includes('GLOBAL') &&
    members.includes(selected) &&
    new Set(members).size === members.length
  )
    return { name: 'GLOBAL', type: 'select', proxies: members, 'default-selected': selected }
  return undefined
}

// GLOBAL is reserved in source profiles. The owned-core verifier can strip
// the exact native group we appended for schema checks. Mihomo receives the
// original bytes, including the chosen default, for both startup and reload.
export function profileSourceForOwnedCore(
  configuration: Record<string, unknown>,
  original: string
): string {
  const groups = configuration['proxy-groups']
  if (!Array.isArray(groups)) return original
  const last = groups.at(-1)
  if (!plainConfigurationMap(last) || last.name !== 'GLOBAL') return original
  const declared = groups.slice(0, -1)
  const expected = projectedGlobalSelector(configuration, declared, last['default-selected'])
  if (!expected || !isDeepStrictEqual(last, expected)) return original
  return JSON.stringify({ ...configuration, 'proxy-groups': declared })
}

// Each core gets a fresh private working directory. Reapply only the user's
// confirmed selector choices, with the same fixed/automatic semantics as Mihomo.
export async function restoreSavedSelectors(
  core: Pick<RelayOwnedCore, 'select' | 'group'>,
  groups: LocalProxyGroup[],
  saved: Map<string, string>,
  current: () => void
): Promise<void> {
  for (const [name, member] of saved) {
    current()
    const group = groups.find((item) => item.name === name)
    if (name === 'GLOBAL') {
      const global = await core.group(name)
      current()
      if (
        global.type !== 'Selector' ||
        !Array.isArray(global.all) ||
        !global.all.includes(member) ||
        global.now === member
      )
        continue
    } else {
      if (!group || group.selectable === false || !group.members.includes(member)) continue
      if ((group.type === 'select' ? group.now : group.fixed) === member) continue
    }
    await core.select(name, member)
    current()
    const observed = await core.group(name)
    current()
    if (observed.now !== member || (group && group.type !== 'select' && observed.fixed !== member))
      throw new Error('上次所选节点恢复未确认。')
  }
}
