import { useEffect } from 'react'
import { onInitialContentReady } from '@renderer/utils/startup'
import { createPreloadablePage } from './preloadable-page'

const NetworkPage = createPreloadablePage(() => import('@renderer/pages/network'))
const OverridePage = createPreloadablePage(() => import('@renderer/pages/override'))
const ProxiesPage = createPreloadablePage(() => import('@renderer/pages/proxies'))
const RulesPage = createPreloadablePage(() => import('@renderer/pages/rules'))
const SettingsPage = createPreloadablePage(() => import('@renderer/pages/settings'))
const ProfilesPage = createPreloadablePage(() => import('@renderer/pages/profiles'))
const LogsPage = createPreloadablePage(() => import('@renderer/pages/logs'))
const ConnectionsPage = createPreloadablePage(() => import('@renderer/pages/connections'))
const MihomoPage = createPreloadablePage(() => import('@renderer/pages/mihomo'))
const SysproxyPage = createPreloadablePage(() => import('@renderer/pages/relay-system-proxy'))
const TunPage = createPreloadablePage(() => import('@renderer/pages/tun'))
const ResourcesPage = createPreloadablePage(() => import('@renderer/pages/resources'))
const DNSPage = createPreloadablePage(() => import('@renderer/pages/dns'))
const SnifferPage = createPreloadablePage(() => import('@renderer/pages/sniffer'))
const SubStorePage = createPreloadablePage(() => import('@renderer/pages/substore'))
const TrafficPage = createPreloadablePage(() => import('@renderer/pages/traffic'))
// Both modes share the subscription manager and profile library.
const SimplePage = ProfilesPage
const SimpleModulePage = createPreloadablePage(() => import('@renderer/pages/simple-module'))

export const NetworkPageComponent = NetworkPage.Page
export const Override = OverridePage.Page
export const Proxies = ProxiesPage.Page
export const Rules = RulesPage.Page
export const Settings = SettingsPage.Page
export const Profiles = ProfilesPage.Page
export const Logs = LogsPage.Page
export const Connections = ConnectionsPage.Page
export const Mihomo = MihomoPage.Page
export const Sysproxy = SysproxyPage.Page
export const Tun = TunPage.Page
export const Resources = ResourcesPage.Page
export const DNS = DNSPage.Page
export const Sniffer = SnifferPage.Page
export const SubStore = SubStorePage.Page
export const Traffic = TrafficPage.Page
export const Simple = SimplePage.Page
export const SimpleModule = SimpleModulePage.Page

// 默认落地页立即预加载，避免首屏等待 chunk 下载。
void ProxiesPage.preload().catch(() => {})

const remainingPageLoaders: Array<() => Promise<unknown>> = [
  SettingsPage.preload,
  ProfilesPage.preload,
  ConnectionsPage.preload,
  RulesPage.preload,
  MihomoPage.preload,
  SysproxyPage.preload,
  TunPage.preload,
  DNSPage.preload,
  SnifferPage.preload,
  ResourcesPage.preload,
  OverridePage.preload,
  LogsPage.preload,
  SubStorePage.preload,
  NetworkPage.preload,
  TrafficPage.preload
]
const routePreloadStartDelay = 1000
const routePreloadInterval = 250
const previewPageLoaders = [SysproxyPage.preload, TrafficPage.preload]
const remainingPages = new Map<boolean, Promise<void>>()

function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    window.requestIdleCallback(() => resolve())
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function preloadRemainingPages(previewOnly: boolean): Promise<void> {
  const scheduled = remainingPages.get(previewOnly)
  if (scheduled) return scheduled
  const loaders = previewOnly ? previewPageLoaders : remainingPageLoaders

  const ready = (async (): Promise<void> => {
    for (const [index, loader] of loaders.entries()) {
      await waitForIdle()
      try {
        await loader()
      } catch {
        // A failed page import is retried when the route is opened.
      }

      if (index < loaders.length - 1) {
        await delay(routePreloadInterval)
      }
    }
  })()
  remainingPages.set(previewOnly, ready)
  return ready
}

export function useDeferredRoutePreload(previewOnly = false): void {
  useEffect(() => {
    let startTimer: number | undefined
    const unsubscribe = onInitialContentReady(() => {
      startTimer = window.setTimeout(() => {
        void preloadRemainingPages(previewOnly)
      }, routePreloadStartDelay)
    })

    return (): void => {
      unsubscribe()
      if (startTimer !== undefined) window.clearTimeout(startTimer)
    }
  }, [previewOnly])
}
