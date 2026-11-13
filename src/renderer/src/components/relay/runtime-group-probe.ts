import type { RelayProfileInventory, RelayProfileGroups } from '../../../../shared/relay/profiles'
import type { RelayProfileSelection } from '../../../../shared/relay/runtime'
import { reservedProfileTargets } from '../../../../shared/relay/profiles'
import type { ProxyDelay } from '../proxies/proxy-item'
import type {
  IsolatedProbeDelay,
  IsolatedProbePlan,
  IsolatedProbeResult,
  IsolatedProbeTargets
} from '../../../../shared/relay/isolated-probes'
import { probeDelayBuiltins } from '../../../../shared/relay/isolated-probes'
import { executeIsolatedProbe } from './isolated-probe-action'

interface RuntimeProbeOptions {
  delay?: IsolatedProbeDelay
  readProfiles(): Promise<RelayProfileInventory>
  readGroups(profile: RelayProfileSelection): Promise<RelayProfileGroups>
  invoke(channel: string, input?: unknown): Promise<unknown>
  current(): boolean
  cancelled(): boolean
  prepared(plan: IsolatedProbePlan): void
}

// Include aliases and built-ins so every displayed member gets this run's result.
export function runtimeProbeMembers(group: string, groups: IMihomoMixedGroup[]): string[] {
  const names = new Set<string>()
  const visit = (name: string): void => {
    if (names.has(name)) return
    names.add(name)
    for (const member of groups.find((entry) => entry.name === name)?.all ?? []) visit(member.name)
  }
  visit(group)
  return [...names]
}

export function runtimeProbeDisplayStatus(
  name: string,
  error = '未收到本次测速结果，请重试。'
): ProxyDelay {
  if (!runtimeProbeTestAvailable(name))
    return {
      label: '不可测',
      detail: '规则控制项没有独立网络出口。'
    }
  return { error }
}
export function runtimeProbeTestAvailable(name: string): boolean {
  return name === 'GLOBAL' || !reservedProfileTargets.has(name) || probeDelayBuiltins.has(name)
}

async function executeRuntimeProbe(
  profileId: string,
  group: string,
  options: RuntimeProbeOptions,
  kind: 'nodeDelay' | 'groupDelay'
): Promise<IsolatedProbeResult> {
  const cancelled = (): IsolatedProbeResult => ({
    status: 'cancelled',
    kind,
    measurements: [],
    isolated: true
  })
  const check = (): void => {
    if (!options.current()) throw new Error('运行配置已变化，请重新测速。')
  }
  check()
  if (options.cancelled()) return cancelled()
  const inventory = await options.readProfiles()
  check()
  if (options.cancelled()) return cancelled()
  const profile = inventory.profiles.find((entry) => entry.id === profileId)
  if (!profile) throw new Error('当前运行配置的已保存来源不可用，请刷新后重试。')
  const selection = { id: profile.id, sha256: profile.sha256 }
  const source = await options.readGroups(selection)
  check()
  if (options.cancelled()) return cancelled()
  if (source.profile.id !== selection.id || source.profile.sha256 !== selection.sha256)
    throw new Error('来源已变化，请刷新后重试。')
  // Main resolves targets from the effective runtime configuration, including
  // persisted overrides; the raw source's groups need not contain added groups.
  const targets = (await options.invoke(
    'relayIsolatedProbeTargets',
    selection
  )) as IsolatedProbeTargets
  check()
  if (options.cancelled()) return cancelled()
  const supported =
    kind === 'groupDelay'
      ? targets.groups.includes(group)
      : runtimeProbeTestAvailable(group) &&
        (targets.nodes.includes(group) ||
          targets.groups.includes(group) ||
          probeDelayBuiltins.has(group))
  if (!supported) throw new Error('此节点或代理组不支持独立测速。')
  return executeIsolatedProbe(
    {
      profile: selection,
      target: group,
      kind,
      provider: 'ip.sb',
      ...(options.delay ? { delay: options.delay } : {})
    },
    options.invoke,
    {
      cancelled: () => options.cancelled() || !options.current(),
      prepared: options.prepared
    }
  )
}

export function executeRuntimeGroupProbe(
  profileId: string,
  group: string,
  options: RuntimeProbeOptions
): Promise<IsolatedProbeResult> {
  return executeRuntimeProbe(profileId, group, options, 'groupDelay')
}

export function executeRuntimeNodeProbe(
  profileId: string,
  node: string,
  options: RuntimeProbeOptions
): Promise<IsolatedProbeResult> {
  return executeRuntimeProbe(profileId, node, options, 'nodeDelay')
}
