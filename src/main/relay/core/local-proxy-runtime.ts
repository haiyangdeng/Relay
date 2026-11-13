import { compileProfileRuntime } from '../profiles/runtime'
import { analyzeProfile, PROFILE_BYTE_LIMIT } from '../profiles/inspect'
import { compileProfileResolution } from '../profiles/resolution'
import {
  localCoreLogLevel,
  localResolverMode,
  type LocalCoreLogLevel,
  type LocalResolverMode,
  type LocalResolutionSummary,
  type LocalProxyGroup
} from '../../../shared/relay/local-proxy'
import type {
  DedicatedListenerPlan,
  DedicatedListenerSummary
} from '../../../shared/relay/dedicated-listeners'
import { snifferSettings } from '../../../shared/relay/configuration-edit'
import { groupTypes, healthURL, type GroupType } from '../profiles/groups'
import type { RuntimeAsset } from '../configuration/bindings'
import {
  localProxyPortsFor,
  validateDedicatedPortConflicts,
  type LocalProxyPorts
} from '../../../shared/relay/local-proxy-ports'
import { injectDedicatedListeners } from './dedicated-listeners'
import { localProxyInheritedOptions, validateLocalProxySourceOptions } from './local-proxy-options'
import {
  localProxyGeography,
  localProxyGeoControls,
  validateLocalProxyGeoAssets
} from './local-proxy-geo'
import {
  startOwnedCore,
  type RelayOwnedCore,
  type OwnedCoreCleanupRegistration
} from './owned-runtime'
import type { SmartLearningContext } from './smart-state-runtime'

export function localProxyConfiguration(
  source: string,
  port: number,
  resolutionMode: LocalResolverMode = 'off',
  dedicated: DedicatedListenerPlan | undefined = undefined,
  logLevel?: LocalCoreLogLevel,
  runtimeAssets: readonly RuntimeAsset[] = [],
  ports?: LocalProxyPorts
): {
  configuration: string
  ports: LocalProxyPorts
  groups: LocalProxyGroup[]
  resolution: LocalResolutionSummary
  dedicated: DedicatedListenerSummary | undefined
} {
  const ordinaryPorts = localProxyPortsFor(port, ports)
  validateDedicatedPortConflicts(ordinaryPorts, dedicated)
  const mode = localResolverMode(resolutionMode)
  const sourceData = analyzeProfile(source).data
  if (!sourceData) throw new Error('配置来源无效。')
  const geography = localProxyGeography(
    { ...sourceData, dns: mode === 'profile' ? sourceData.dns : undefined },
    runtimeAssets
  )
  const compiled = compileProfileRuntime(source, geography)
  if (!compiled.configuration)
    throw new Error(compiled.issues.join(' ') || '配置含未接入选项，不能启动当前本地代理。')
  const input: unknown = JSON.parse(compiled.configuration)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置无效。')
  const config = input as Record<string, unknown>
  const groups: LocalProxyGroup[] = []
  const nodeNames = Array.isArray(config.proxies) ? config.proxies.map((n) => n.name as string) : []
  const providers = config['proxy-providers'] as Record<
    string,
    { payload: { name: string }[]; 'health-check'?: { url?: string } }
  >
  if (!Array.isArray(config['proxy-groups'])) throw new Error('代理组结构无效。')
  const candidates: unknown[] = config['proxy-groups']
  for (const value of candidates) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('代理组结构无效。')
    const raw = value as Record<string, unknown>
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.name !== 'string' ||
      typeof raw.type !== 'string' ||
      !Object.hasOwn(groupTypes, raw.type)
    )
      throw new Error('代理组结构无效。')
    const members = Array.isArray(raw.proxies)
      ? raw.proxies.filter((v): v is string => typeof v === 'string')
      : []
    const use =
      raw['include-all'] || raw['include-all-providers']
        ? Object.keys(providers)
        : Array.isArray(raw.use)
          ? raw.use
          : []
    for (const provider of use) {
      if (typeof provider !== 'string' || !providers[provider]) throw new Error('提供者引用无效。')
      members.push(...providers[provider].payload.map((n) => n.name))
    }
    if (raw['include-all'] || raw['include-all-proxies']) members.push(...nodeNames)
    const dynamic = !!(
      use.length ||
      raw['include-all'] ||
      raw['include-all-proxies'] ||
      raw['include-all-providers'] ||
      raw['exclude-filter'] ||
      raw['exclude-type']
    )
    const emptyFallback =
      typeof raw['empty-fallback'] === 'string' ? raw['empty-fallback'] : 'COMPATIBLE'
    groups.push({
      name: raw.name,
      type: raw.type as GroupType,
      dynamic,
      providers: use.filter((v): v is string => typeof v === 'string'),
      selectable: raw.type !== 'load-balance',
      expectedStatus: typeof raw['expected-status'] === 'string' ? raw['expected-status'] : '',
      testURL:
        typeof raw.url === 'string'
          ? healthURL(raw.url)
          : use
              .map((p) => providers[String(p)]?.['health-check']?.url)
              .find((u): u is string => !!u),
      emptyFallback,
      members: dynamic ? [...new Set([...members, emptyFallback])] : members,
      confirmed: false
    })
  }
  if (
    groups.length > 80 ||
    groups.reduce((sum, group) => sum + Buffer.byteLength(JSON.stringify(group)), 0) > 49152
  )
    throw new Error('当前本地代理组控制超过显示预算，未启动或截断可操作成员。')
  validateLocalProxySourceOptions(sourceData)
  Object.assign(config, localProxyInheritedOptions(sourceData))
  if (runtimeAssets.length) Object.assign(config, localProxyGeoControls)
  config.port = ordinaryPorts.http
  config['socks-port'] = ordinaryPorts.socks
  config['mixed-port'] = ordinaryPorts.mixed
  config['redir-port'] = ordinaryPorts.redir
  if (logLevel !== undefined) config['log-level'] = localCoreLogLevel(logLevel)
  if (sourceData.sniffer !== undefined) config.sniffer = snifferSettings(sourceData.sniffer)
  let resolution: LocalResolutionSummary = {
    mode: 'off',
    enabled: false,
    hosts: 0,
    policies: 0,
    bootstrapDerived: false,
    listenerSuppressed: false
  }
  if (mode === 'profile') {
    const data = analyzeProfile(source).data
    if (!data) throw new Error('配置来源无效。')
    const targets = new Set([
      'DIRECT',
      ...groups.map((group) => group.name),
      ...compiled.catalogue.nodes.map((node) => node.name)
    ])
    // Catalogue is intentionally bounded; the compiler's complete node set is
    // used here so a redacted UI budget never changes DNS route semantics.
    if (Array.isArray(config.proxies))
      for (const node of config.proxies)
        if (node && typeof node === 'object' && typeof node.name === 'string')
          targets.add(node.name)
    const result = compileProfileResolution(data, targets, geography)
    config.dns = result.dns
    config.hosts = result.hosts
    config.ipv6 = result.ipv6
    resolution = result.summary
  }
  // Relay-owned dedicated listeners are the only listeners admitted. The
  // profile's own listeners were dropped by compileProfileRuntime; inject ours
  // here so the controlled boundary stays exact and source-independent.
  const dedicatedSummary = injectDedicatedListeners(config, dedicated)
  const configuration = JSON.stringify(config)
  validateLocalProxyGeoAssets(config, runtimeAssets)
  if (Buffer.byteLength(configuration) > PROFILE_BYTE_LIMIT)
    throw new Error('运行配置超过2MiB，未启动。')
  return { configuration, ports: ordinaryPorts, groups, resolution, dedicated: dedicatedSummary }
}
export async function startLocalProxyCore(
  resourceRoot: string,
  source: string,
  port: number,
  registerCleanup: OwnedCoreCleanupRegistration,
  resolverMode: LocalResolverMode = 'off',
  dedicated: DedicatedListenerPlan | undefined = undefined,
  learningContext?: SmartLearningContext,
  logLevel?: LocalCoreLogLevel,
  runtimeAssets: readonly RuntimeAsset[] = [],
  ports?: LocalProxyPorts
): Promise<RelayOwnedCore> {
  const built = localProxyConfiguration(
    source,
    port,
    resolverMode,
    dedicated,
    logLevel,
    runtimeAssets,
    ports
  )
  return startOwnedCore(
    resourceRoot,
    built.configuration,
    'localProxy',
    registerCleanup,
    undefined,
    undefined,
    learningContext,
    undefined,
    runtimeAssets
  )
}
