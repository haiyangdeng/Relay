import type { RelayProfileInventory, RelayStoredProfile } from '../../../../shared/relay/profiles'
import type {
  LocalProxyPreparation,
  LocalProxyResult,
  LocalProxyState,
  LocalResolverMode,
  LocalProxyLifetime,
  LocalCoreLogLevel
} from '../../../../shared/relay/local-proxy'
import type { DedicatedListenerPlan } from '../../../../shared/relay/dedicated-listeners'
import { localProxyPlanRecord } from '../../../../shared/relay/local-proxy-plan'
import {
  localProxyPortsFor,
  type LocalProxyPorts
} from '../../../../shared/relay/local-proxy-ports'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>
type ProfileSelection = Pick<RelayStoredProfile, 'id' | 'sha256'>
export interface RelayProxyStartOptions {
  resolverMode?: LocalResolverMode
  lifetime?: LocalProxyLifetime
  logLevel?: LocalCoreLogLevel
  dedicated?: DedicatedListenerPlan
  ports?: LocalProxyPorts
}

export function relayProxyRunning(state?: LocalProxyState): boolean {
  return !!(
    state?.owned === true &&
    state.phase === 'running' &&
    state.traffic === 'listening' &&
    state.pending === false &&
    state.uncertain === false
  )
}

export function relayProxyCanPrepare(state?: LocalProxyState): boolean {
  // A fresh service starts as unknown. Prepare verifies the lease and ports.
  return !!(
    state &&
    state.owned === false &&
    state.pending === false &&
    state.uncertain === false &&
    state.hasRecord === false &&
    state.traffic === 'inactive' &&
    ['unknown', 'idle', 'failed'].includes(state.phase)
  )
}

export function relayProxyMatchesProfile(
  state: LocalProxyState | undefined,
  profileId?: string | null
): boolean {
  return relayProxyRunning(state) && (!profileId || state?.profileId === profileId)
}

async function selectPinnedProfile(selection: ProfileSelection, invoke: Invoke): Promise<void> {
  await invoke('changeCurrentProfile', selection)
  const confirmed = (await invoke('getProfileConfig')) as IProfileConfig | undefined
  if (confirmed?.current !== selection.id) throw new Error('配置未选用，可能已取消操作。')
}

export async function chooseCachedProfile(
  profile: RelayStoredProfile,
  invoke: Invoke
): Promise<void> {
  await selectPinnedProfile({ id: profile.id, sha256: profile.sha256 }, invoke)
}

export async function startCachedProxy(
  profile: RelayStoredProfile,
  httpPort: number,
  invoke: Invoke,
  options: RelayProxyStartOptions = {}
): Promise<LocalProxyResult> {
  if (!Number.isInteger(httpPort) || httpPort < 1024 || httpPort > 65535)
    throw new Error('请填写 1024–65535 范围内的本地代理端口。')
  const ports =
    options.ports === undefined ? undefined : localProxyPortsFor(httpPort, options.ports)
  const selection = { id: profile.id, sha256: profile.sha256 }
  const state = (await invoke('relayLocalProxyState')) as LocalProxyState | undefined
  if (!relayProxyCanPrepare(state)) {
    throw new Error('当前代理状态需要核对，请打开内核设置处理。')
  }
  await selectPinnedProfile(selection, invoke)
  const preparation = (await invoke('relayLocalProxyPrepare', {
    profile: selection,
    httpPort,
    resolverMode: options.resolverMode ?? 'profile',
    lifetime: options.lifetime ?? 'main',
    ...(options.logLevel ? { logLevel: options.logLevel } : {}),
    ...(ports ? { ports } : {}),
    ...(options.dedicated ? { dedicated: options.dedicated } : {})
  })) as LocalProxyPreparation
  if (!preparation.canStart)
    throw new Error(preparation.warnings.join(' ') || '当前配置或端口尚未就绪。')
  // Main retains its native confirmation and rechecks the pinned profile/port.
  return (await invoke('relayLocalProxyAction', {
    action: 'start',
    evidenceId: preparation.evidenceId
  })) as LocalProxyResult
}

export async function activateCachedProfile(
  profile: RelayStoredProfile,
  httpPort: number,
  invoke: Invoke,
  options: RelayProxyStartOptions = {}
): Promise<LocalProxyState> {
  const pinned = { ...profile }
  const state = (await invoke('relayLocalProxyState')) as LocalProxyState | undefined
  if (relayProxyRunning(state)) {
    await chooseCachedProfile(pinned, invoke)
  } else {
    if (!relayProxyCanPrepare(state)) throw new Error('当前代理状态需要核对，请打开内核设置处理。')
    const result = await startCachedProxy(pinned, httpPort, invoke, options)
    if (result.status === 'cancelled') throw new Error('已取消使用此配置。')
    if (result.status !== 'started')
      throw new Error(result.state.warnings.join(' ') || '代理启动未确认，请打开内核设置核对。')
  }
  const confirmed = (await invoke('relayLocalProxyState')) as LocalProxyState | undefined
  if (!confirmed || !relayProxyRunning(confirmed) || confirmed.profileId !== pinned.id)
    throw new Error('当前配置尚未确认运行，请打开内核设置核对。')
  return confirmed
}

// An explicit system-proxy click may prepare Relay's selected local core. This
// never reloads another owner, adopts a record, or applies system settings.
export async function ensureSelectedProxy(
  invoke: Invoke,
  current: () => boolean
): Promise<LocalProxyState> {
  const check = (): void => {
    if (!current()) throw new Error('当前配置或页面已变化，请重新操作。')
  }
  const guarded: Invoke = async (channel, ...args) => {
    check()
    const value = await invoke(channel, ...args)
    check()
    return value
  }
  let state = (await guarded('relayLocalProxyState')) as LocalProxyState
  if (relayProxyRunning(state)) return state
  if (!relayProxyCanPrepare(state)) throw new Error('当前代理状态需要核对，请打开内核设置处理。')
  const config = (await guarded('getProfileConfig')) as IProfileConfig | undefined
  const inventory = (await guarded('relayProfileList')) as RelayProfileInventory
  const profile = inventory.profiles.find((row) => row.id === config?.current)
  if (!profile) throw new Error('没有可用配置，请先导入订阅或本地配置。')
  const plan = localProxyPlanRecord(await guarded('relayLocalProxyPlanRead')).document
  const pinned: Invoke = async (channel, ...args) => {
    if (
      ['changeCurrentProfile', 'relayLocalProxyPrepare', 'relayLocalProxyAction'].includes(channel)
    ) {
      const selected = (await guarded('getProfileConfig')) as IProfileConfig | undefined
      if (selected?.current !== profile.id) throw new Error('当前配置已变化，请重新操作。')
    }
    return guarded(channel, ...args)
  }
  const result = await startCachedProxy(profile, plan.httpPort, pinned, plan)
  if (result.status !== 'started') throw new Error('配置启动未确认，系统代理未更改。')
  state = (await guarded('relayLocalProxyState')) as LocalProxyState
  if (
    !relayProxyMatchesProfile(state, profile.id) ||
    state.httpPort !== plan.httpPort ||
    JSON.stringify(localProxyPortsFor(state.httpPort, state.ports)) !==
      JSON.stringify(localProxyPortsFor(plan.httpPort, plan.ports))
  )
    throw new Error('配置运行状态未确认，系统代理未更改。')
  return state
}
