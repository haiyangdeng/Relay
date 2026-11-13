import type { RelayShellSettings } from '../../shared/relay/shell'
import type { RelayUIPreferences } from '../../shared/relay/ui-preferences'
import { defaultConfig, defaultControledMihomoConfig } from '../utils/template'
import type { RelayWindowStartup } from './shell/window-startup'

// This build has no live backend import. These values are isolated preview
// data, not observations of the user's configuration or running core.
export function createPreviewBackend(adapters?: {
  preferences(): RelayUIPreferences
  appearance?(): Pick<RelayShellSettings, 'appTheme' | 'operationMode'>
  windowPreferences?: RelayWindowStartup
  patchView(input: unknown): Promise<void>
}): (channel: string, input?: unknown) => unknown {
  const config: IAppConfig = {
    ...structuredClone(defaultConfig),
    modeSelected: true,
    operationMode: 'standard',
    appTheme: 'light',
    enableTrafficLogger: false,
    useSubStore: false,
    autoCheckUpdate: false,
    autoCloseConnection: false,
    enableSmartOverride: false,
    rememberSelectedSiderCard: false,
    useWindowFrame: true
  }
  const reads: Record<string, () => unknown> = {
    getAppConfig: () => {
      const { version: _version, ...view } = adapters?.preferences() ?? {}
      return structuredClone({
        ...config,
        ...view,
        ...adapters?.appearance?.(),
        ...adapters?.windowPreferences
      })
    },
    getControledMihomoConfig: () => ({
      ...structuredClone(defaultControledMihomoConfig),
      tun: { enable: false }
    }),
    getProfileConfig: () => ({ items: [] }),
    getOverrideConfig: () => ({ items: [] }),
    getPluginConfig: () => ({ items: [] }),
    getCurrentProfileItem: () => null,
    mihomoGroups: () => [],
    mihomoProxies: () => ({ proxies: {} }),
    mihomoRules: () => ({ rules: [] }),
    mihomoProxyProviders: () => ({ providers: {} }),
    mihomoRuleProviders: () => ({ providers: {} }),
    mihomoVersion: () => ({ version: 'Not running — preview', meta: true }),
    getVersion: () => '1.0.0',
    platform: () => process.platform,
    checkAutoRun: () => false,
    isAlwaysOnTop: () => false,
    applyTheme: () => undefined,
    setNativeTheme: () => undefined,
    takeDnsOverrideAutoDisabledNotice: () => null,
    queryTrafficUsageOverview: () => ({ upload: 0, download: 0, days: [] }),
    getInterfaces: () => [],
    getSmartModelStatus: () => ({ exists: false, downloading: false })
  }
  return (channel, input) => {
    if (channel === 'patchAppConfig') {
      if (adapters) return adapters.patchView(input)
      // Sidebar resizing shares the upstream config IPC. Keep this view state
      // in memory, and refuse the whole patch if it contains any other setting.
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        !Object.hasOwn(input, 'siderWidth')
      ) {
        throw new Error('Relay 预览仅允许在内存中调整侧栏宽度；其他配置仍锁定。')
      }
      const width = (input as Record<string, unknown>).siderWidth
      if (
        typeof width !== 'number' ||
        !Number.isFinite(width) ||
        !(width === 60 || width === 70 || (width >= 250 && width <= 400))
      ) {
        throw new Error('侧栏宽度无效，没有应用修改。')
      }
      config.siderWidth = width
      return
    }
    if (!Object.hasOwn(reads, channel))
      throw new Error('Relay 开发预览未启用此操作；没有修改配置或网络。')
    return reads[channel]()
  }
}

export const previewReadChannels = [
  'getAppConfig',
  'getControledMihomoConfig',
  'getProfileConfig',
  'getOverrideConfig',
  'getPluginConfig',
  'getCurrentProfileItem',
  'mihomoGroups',
  'mihomoProxies',
  'mihomoRules',
  'mihomoProxyProviders',
  'mihomoRuleProviders',
  'mihomoVersion',
  'getVersion',
  'platform',
  'checkAutoRun',
  'isAlwaysOnTop',
  'applyTheme',
  'setNativeTheme',
  'takeDnsOverrideAutoDisabledNotice',
  'queryTrafficUsageOverview',
  'getInterfaces',
  'getSmartModelStatus'
] as const
