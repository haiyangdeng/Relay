import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import type { ConfigurationEditRecord } from '../../../../shared/relay/configuration-edit'
import type { SystemProxyReport } from '../../../../shared/relay/system-proxy'
import type { TunStatus } from '../../../../shared/relay/tun'
import type { RuntimeInfoSnapshot } from '../../../../shared/relay/observability'
import {
  DEFAULT_MIHOMO_DNS_CONFIG,
  DEFAULT_MIHOMO_SNIFFER_CONFIG
} from '../../../../shared/appConfig'
import { errorMessage } from '../../utils/error-message'
import { createTunPanelController } from './tun-controller'
import { createTunRendererApi } from './tun-api'
import { prepareCurrentTunConfiguration } from './tun-configuration-action'
import {
  sidebarConfigurationSwitch,
  sidebarSystemProxy,
  type SidebarInvoke
} from './sidebar-actions'

export type SidebarSwitch = 'sysproxy' | 'tun' | 'dns' | 'sniff'
export interface SidebarStatus {
  local?: LocalProxyState
  system?: SystemProxyReport
  systemPending?: boolean
  systemObserved?: boolean
  tun?: TunStatus
  dns?: boolean
  sniff?: boolean
  groups?: number
  rules?: number
  version?: string
  memory?: number
  rates?: { upload: number; download: number }
}
const enabled = (value: unknown): boolean | undefined =>
  value && typeof value === 'object' && 'enable' in value && typeof value.enable === 'boolean'
    ? value.enable
    : undefined
export function sidebarRates(
  previous: { id: string; at: number; upload: number; download: number } | undefined,
  next: { id: string; at: number; upload: number; download: number }
): SidebarStatus['rates'] {
  if (
    !previous ||
    previous.id !== next.id ||
    next.at <= previous.at ||
    next.at - previous.at > 10000 ||
    next.upload < previous.upload ||
    next.download < previous.download
  )
    return undefined
  const seconds = (next.at - previous.at) / 1000
  return {
    upload: (next.upload - previous.upload) / seconds,
    download: (next.download - previous.download) / seconds
  }
}
export function useSidebarStatus(profileId?: string) {
  const [status, setStatus] = useState<SidebarStatus>({}),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState('')
  const refs = useRef({
      profileId,
      mounted: true,
      operation: false,
      reading: undefined as number | undefined,
      systemReading: false,
      systemQueued: false,
      systemGeneration: 0,
      generation: 0,
      status
    }),
    lastTraffic = useRef<Parameters<typeof sidebarRates>[0]>(undefined)
  refs.current.profileId = profileId
  refs.current.status = status
  const invoke: SidebarInvoke = (channel, ...args) =>
    window.electron.ipcRenderer.invoke(channel, ...args)
  const refreshSystem = useCallback(async function readSystem(): Promise<void> {
    const current = refs.current
    if (!current.mounted) return
    if (current.systemReading) {
      current.systemQueued = true
      return
    }
    current.systemReading = true
    const generation = current.systemGeneration
    try {
      let system: { pending: boolean; observed: boolean; report?: SystemProxyReport } | undefined
      try {
        system = (await window.electron.ipcRenderer.invoke(
          'relaySystemProxyState'
        )) as typeof system
      } catch {
        system = undefined
      }
      if (current.mounted && generation === current.systemGeneration)
        setStatus((previous) => ({
          ...previous,
          system: system?.report,
          systemPending: system?.pending,
          systemObserved: system?.observed
        }))
    } finally {
      current.systemReading = false
      if (current.systemQueued) {
        current.systemQueued = false
        if (current.mounted) void readSystem()
      }
    }
  }, [])
  const refreshTelemetry = useCallback(async function readTelemetry(): Promise<void> {
    const current = refs.current
    if (!current.mounted || current.operation || current.reading !== undefined) return
    const generation = current.generation,
      selected = current.profileId
    current.reading = generation
    const valid = (): boolean =>
      current.mounted && generation === current.generation && selected === current.profileId
    const safe = async <T>(channel: string): Promise<T | undefined> => {
      try {
        return (await window.electron.ipcRenderer.invoke(channel)) as T
      } catch {
        return undefined
      }
    }
    try {
      const [local, tun, edit] = await Promise.all([
        safe<LocalProxyState>('relayLocalProxyState'),
        safe<TunStatus>('relayTunStatus'),
        safe<ConfigurationEditRecord>('relayConfigEditRead')
      ])
      if (!valid()) return
      const next: SidebarStatus = {
        local,
        tun,
        dns: undefined,
        sniff: undefined,
        groups: undefined,
        rules: undefined,
        version: undefined,
        memory: undefined,
        rates: undefined
      }
      // Readiness is already known; expensive stats do not gate the switches.
      // Clear samples on an owner change rather than carrying old rates over.
      setStatus((previous) => ({
        ...previous,
        ...(previous.local?.instanceId !== local?.instanceId ||
        previous.local?.configurationRevision !== local?.configurationRevision ||
        previous.local?.phase !== local?.phase
          ? next
          : { local, tun })
      }))
      if (local?.owned && local.phase === 'running' && !local.pending && !local.uncertain) {
        const [runtime, groups, version, info] = await Promise.all([
          safe<Record<string, unknown>>('getRuntimeConfig'),
          safe<unknown[]>('mihomoGroups'),
          safe<{ version: string }>('mihomoVersion'),
          safe<RuntimeInfoSnapshot>('relayRuntimeInfo')
        ])
        const after = await safe<LocalProxyState>('relayLocalProxyState')
        if (!valid()) return
        next.local = after
        if (
          after &&
          info &&
          after.owned &&
          after.phase === 'running' &&
          after.traffic === 'listening' &&
          !after.pending &&
          !after.uncertain &&
          after.pid === local.pid &&
          after.instanceId === local.instanceId &&
          after.configurationRevision === local.configurationRevision &&
          info.process.phase === local.phase &&
          info.process.pid === local.pid &&
          info.process.instanceId === local.instanceId &&
          info.process.configurationRevision === local.configurationRevision
        ) {
          next.dns = enabled(runtime?.dns)
          next.sniff = enabled(runtime?.sniffer)
          next.groups = Array.isArray(groups) ? groups.length : undefined
          next.rules = Array.isArray(runtime?.rules) ? runtime.rules.length : undefined
          next.version = version?.version
          next.memory = info.memory
          if (
            info.traffic &&
            Number.isFinite(info.traffic.upload) &&
            Number.isFinite(info.traffic.download)
          ) {
            const sample = {
              id: `${local.instanceId}:${local.configurationRevision}`,
              at: performance.now(),
              ...info.traffic
            }
            next.rates = sidebarRates(lastTraffic.current, sample)
            lastTraffic.current = sample
          } else lastTraffic.current = undefined
        } else lastTraffic.current = undefined
      } else {
        lastTraffic.current = undefined
        if (edit && local && !local.owned && !local.pending && !local.uncertain) {
          next.dns = enabled(edit.document.controlled.dns) ?? DEFAULT_MIHOMO_DNS_CONFIG.enable
          next.sniff =
            enabled(edit.document.controlled.sniffer) ?? DEFAULT_MIHOMO_SNIFFER_CONFIG.enable
        }
      }
      // System state has its own freshness and may have changed via the panel
      // or tray while telemetry was pending. Never overwrite it from this read.
      if (valid()) setStatus((previous) => ({ ...previous, ...next }))
    } finally {
      if (current.reading === generation) current.reading = undefined
      if (current.mounted && generation !== current.generation && !current.operation)
        void readTelemetry()
    }
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([refreshSystem(), refreshTelemetry()])
  }, [refreshSystem, refreshTelemetry])
  const tunController = useRef<ReturnType<typeof createTunPanelController> | null>(null)
  if (!tunController.current)
    tunController.current = createTunPanelController({
      api: createTunRendererApi(),
      evidence: () => undefined,
      busy: () => false,
      context: () => refs.current.profileId,
      activationBlocked: () =>
        !refs.current.mounted ||
        !refs.current.status.local ||
        !!refs.current.status.local?.owned ||
        !!refs.current.status.local?.pending,
      prepareEvidence: async (current) => {
        const id = refs.current.profileId
        if (!id) throw new Error('请先选择配置。')
        return prepareCurrentTunConfiguration(id, {
          invoke,
          current: () => current() && refs.current.mounted && refs.current.profileId === id
        })
      },
      onBusy: () => {}
    })
  useEffect(() => {
    const state = refs.current
    state.mounted = true
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    const remove = window.electron.ipcRenderer.on('relayTunUpdated', () => void refresh())
    // SystemProxyService publishes this main-process notification after native
    // observations/transactions, including actions from the panel and tray.
    // Refresh the cheap cache only; do not restart a pending telemetry request.
    const removeSystem = window.electron.ipcRenderer.on('controledMihomoConfigUpdated', () => {
      ++state.systemGeneration
      void refreshSystem()
    })
    const changed = (): void => {
      ++refs.current.generation
      void refresh()
    }
    window.addEventListener('relay-sidebar-settings-changed', changed)
    return () => {
      state.mounted = false
      ++state.generation
      ++state.systemGeneration
      clearInterval(timer)
      remove()
      removeSystem()
      window.removeEventListener('relay-sidebar-settings-changed', changed)
    }
  }, [refresh, refreshSystem])
  useEffect(() => {
    ++refs.current.generation
    setStatus((previous) => ({
      local: previous.local,
      tun: previous.tun,
      system: previous.system,
      systemPending: previous.systemPending,
      systemObserved: previous.systemObserved
    }))
    lastTraffic.current = undefined
    void refresh()
  }, [profileId, refresh])
  const change = async (kind: SidebarSwitch, value: boolean): Promise<void> => {
    const state = refs.current
    if (state.operation || !state.mounted) return
    state.operation = true
    const generation = ++state.generation,
      selected = state.profileId
    setPending(true)
    setNotice('')
    try {
      if (kind === 'sysproxy') {
        const report = await sidebarSystemProxy(
          value,
          invoke,
          () => state.mounted && generation === state.generation && selected === state.profileId
        )
        if (
          report &&
          state.mounted &&
          generation === state.generation &&
          selected === state.profileId
        ) {
          ++state.systemGeneration
          setStatus((previous) => ({
            ...previous,
            system: report,
            systemPending: false,
            systemObserved: true
          }))
        }
      } else if (kind === 'tun') {
        const control = tunController.current
        if (!control) return
        await control.run('status')
        if (value) await control.enable()
        else await control.run('stop')
        const result = control.snapshot()
        setNotice(result.notice)
      } else {
        const result = await sidebarConfigurationSwitch(
          kind,
          value,
          selected,
          invoke,
          () => state.mounted && generation === state.generation && selected === state.profileId
        )
        setNotice(result === 'applied' ? '设置已应用。' : '设置已保存，将在下次启用配置时使用。')
      }
    } catch (error) {
      if (state.mounted) setNotice(errorMessage(error, '操作未完成，请进入对应页面核对。'))
    } finally {
      if (kind === 'dns' || kind === 'sniff')
        window.dispatchEvent(new Event('relay-sidebar-settings-changed'))
      window.dispatchEvent(new Event('relay-sidebar-network-changed'))
      state.operation = false
      if (state.mounted) setPending(false)
      await refresh()
    }
  }
  return { status, pending, notice, refresh, change }
}
