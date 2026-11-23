import {
  configurationEditDocument,
  type ConfigurationEditRecord
} from '../../../../shared/relay/configuration-edit'
import {
  defaultSystemProxyDraft,
  systemProxyDraftRecord
} from '../../../../shared/relay/system-proxy-draft'
import { type SystemProxyReport } from '../../../../shared/relay/system-proxy'
import type {
  LocalProxyState,
  LocalReloadPreparation,
  LocalProxyResult
} from '../../../../shared/relay/local-proxy'
import type { RelayProfileInventory } from '../../../../shared/relay/profiles'
import {
  canSwitchSystemProxy,
  selectedSystemProxyServices,
  submitSystemProxy,
  systemProxyListenerPort
} from './system-proxy-actions'

export type SidebarInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>
export async function sidebarSystemProxy(
  enabled: boolean,
  invoke: SidebarInvoke,
  current: () => boolean = () => true
): Promise<SystemProxyReport | undefined> {
  const guarded: SidebarInvoke = async (channel, ...args) => {
    if (!current()) throw new Error('当前配置或页面已变化，请重新操作。')
    const result = await invoke(channel, ...args)
    if (!current()) throw new Error('当前配置或页面已变化，请重新操作。')
    return result
  }
  const report = (await guarded('relaySystemProxyInspect')) as SystemProxyReport
  if (!enabled) {
    if (!report.recordID && ['inactive', 'restored'].includes(report.status)) return report
    if (!report.recordID || !report.canRestore) throw new Error('没有可恢复的 Relay 系统代理记录。')
    const result = await submitSystemProxy(
      'restore',
      { ...defaultSystemProxyDraft(), port: 18191, serviceIDs: [] },
      guarded,
      () => {}
    )
    if (result.status !== 'restored') throw new Error('系统代理恢复结果需要核对。')
    return result.report
  }
  if (!canSwitchSystemProxy(report))
    throw new Error('系统代理状态需要核对，请检查网络服务和恢复记录。')
  const saved = systemProxyDraftRecord(await guarded('relaySystemProxyDraftRead'))
  const port = await systemProxyListenerPort(guarded, current, saved.document)
  const result = await submitSystemProxy(
    'enable',
    {
      ...saved.document,
      port,
      serviceIDs: selectedSystemProxyServices(report)
    },
    guarded,
    () => {}
  )
  if (result.status !== 'applied') throw new Error('系统代理操作未完成，请打开对应页面核对。')
  return result.report
}

export async function sidebarConfigurationSwitch(
  kind: 'dns' | 'sniff',
  enabled: boolean,
  profileId: string | undefined,
  invoke: SidebarInvoke,
  current: () => boolean
): Promise<'applied' | 'saved'> {
  const check = (): void => {
    if (!current()) throw new Error('当前配置已变化，请重新操作。')
  }
  check()
  const state = (await invoke('relayLocalProxyState')) as LocalProxyState
  check()
  if (state.pending || state.uncertain || (state.owned && state.phase !== 'running'))
    throw new Error('核心状态需要核对。')
  if (state.owned && (!profileId || state.profileId !== profileId))
    throw new Error('运行配置已变化，请重新读取后操作。')
  const saved = (await invoke('relayConfigEditRead')) as ConfigurationEditRecord
  check()
  const document = configurationEditDocument(saved.document),
    key = kind === 'dns' ? 'dns' : 'sniffer'
  const previous = document.controlled[key]
  if (
    previous !== undefined &&
    (!previous || typeof previous !== 'object' || Array.isArray(previous))
  )
    throw new Error('已保存设置格式需要核对。')
  document.controlled = {
    ...document.controlled,
    [key]: { ...(previous as Record<string, unknown> | undefined), enable: enabled }
  }
  if (kind === 'dns') document.controlDns = true
  else document.controlSniff = true
  await invoke('relayConfigEditSave', { document, expectedRevision: saved.revision })
  check()
  if (!state.owned) return 'saved'
  if (!profileId || profileId !== state.profileId || !state.httpPort)
    throw new Error('设置已保存，运行配置已变化，未热载。')
  const profiles = (await invoke('relayProfileList')) as RelayProfileInventory
  check()
  const profile = profiles.profiles.find((row) => row.id === profileId)
  if (!profile) throw new Error('设置已保存，当前配置不存在，未热载。')
  const plan = (await invoke('relayLocalProxyReloadPrepare', {
    profile: { id: profile.id, sha256: profile.sha256 },
    httpPort: state.httpPort,
    ...(state.ports ? { ports: state.ports } : {}),
    ...(state.dedicated
      ? {
          dedicated: {
            route: state.dedicated.route,
            ...(state.dedicated.httpPort ? { httpPort: state.dedicated.httpPort } : {}),
            ...(state.dedicated.socksPort ? { socksPort: state.dedicated.socksPort } : {})
          }
        }
      : {}),
    resolverMode: kind === 'dns' && enabled ? 'profile' : (state.resolution?.mode ?? 'off')
  })) as LocalReloadPreparation
  check()
  if (plan.instanceId !== state.instanceId || plan.previousSHA256 !== state.configurationRevision)
    throw new Error('设置已保存，当前实例已变化，未热载。')
  const result = (await invoke('relayLocalProxyReload', {
    evidenceId: plan.evidenceId
  })) as LocalProxyResult
  check()
  if (result.status !== 'reloaded')
    throw new Error('设置已保存，应用结果未确认，请在对应页面核对。')
  const runtime = (await invoke('getRuntimeConfig')) as Record<string, unknown>
  check()
  const after = (await invoke('relayLocalProxyState')) as LocalProxyState
  check()
  if (
    !result.state ||
    result.state.instanceId !== state.instanceId ||
    result.state.profileId !== profileId ||
    after.instanceId !== result.state.instanceId ||
    after.configurationRevision !== result.state.configurationRevision ||
    after.profileId !== profileId ||
    !after.owned ||
    after.phase !== 'running' ||
    after.traffic !== 'listening' ||
    after.pending ||
    after.uncertain
  )
    throw new Error('应用后的实例已变化，请重新读取状态。')
  const actual = runtime[key]
  if (!actual || typeof actual !== 'object' || !('enable' in actual) || actual.enable !== enabled)
    throw new Error('配置已应用，但来源保护或覆写优先级保留了原开关，请在对应页面核对。')
  return 'applied'
}
