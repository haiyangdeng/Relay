import type { RelayStoredProfile } from '../../../../shared/relay/profiles'
import { relayProxyCanPrepare } from '../../../../shared/relay/local-proxy'
import type {
  LocalProxyPreparation,
  LocalProxyResult,
  LocalProxyState,
  RelayProxyPageOwner,
  LocalResolverMode,
  LocalProxyLifetime,
  LocalCoreLogLevel
} from '../../../../shared/relay/local-proxy'
import type { DedicatedListenerPlan } from '../../../../shared/relay/dedicated-listeners'
import {
  localProxyPortsFor,
  type LocalProxyPorts
} from '../../../../shared/relay/local-proxy-ports'

export { relayProxyCanPrepare }

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

export async function chooseActiveTunProfile(
  selection: ProfileSelection,
  invoke: Invoke,
  expectedInstance?: string
): Promise<RelayProxyPageOwner | undefined> {
  const owner = (await invoke('relayProxyPageOwner')) as RelayProxyPageOwner | undefined
  if (expectedInstance && (owner?.kind !== 'tun-managed' || owner.instanceId !== expectedInstance))
    throw new Error('虚拟网卡会话已变化，请重新选择配置。')
  if (owner?.kind !== 'tun-managed') return undefined
  await selectPinnedProfile({ id: selection.id, sha256: selection.sha256 }, invoke)
  const active = (await invoke('relayProxyPageOwner')) as RelayProxyPageOwner | undefined
  if (active?.kind !== 'tun-managed' || active.profileId !== selection.id)
    throw new Error('虚拟网卡运行配置未确认。')
  return active
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
