import { DEFAULT_SIDER_ORDER } from '../appConfig'
export const relayInterfaceLanguages = ['zh-CN', 'zh-TW', 'en-US', 'ru-RU', 'fa-IR'] as const
export type RelayInterfaceLanguage = (typeof relayInterfaceLanguages)[number]
export const relayLanguageNames: Record<RelayInterfaceLanguage, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文 (台灣)',
  'en-US': 'English',
  'ru-RU': 'Русский',
  'fa-IR': 'فارسی'
}
export const relaySidebarCards = [...DEFAULT_SIDER_ORDER]
export const relaySidebarCardSizes = ['col-span-1', 'col-span-2', 'hidden'] as const
// Fixed Clash Party v2.0.4 SiderConfig defaults, applied to Relay's safe links.
export const relayDefaultSidebarLayout: Readonly<Record<SiderCardKey, CardStatus>> = Object.freeze({
  sysproxy: 'col-span-1',
  tun: 'col-span-1',
  profile: 'col-span-2',
  proxy: 'col-span-1',
  rule: 'col-span-1',
  resource: 'col-span-1',
  override: 'col-span-1',
  connection: 'col-span-2',
  mihomo: 'col-span-2',
  dns: 'col-span-1',
  sniff: 'col-span-1',
  log: 'col-span-1',
  substore: 'col-span-1',
  network: 'col-span-1',
  usage: 'col-span-1'
})
export interface RelayUIPreferences {
  version: 1
  language: RelayInterfaceLanguage
  disableAnimations: boolean
  rememberSelectedSiderCard: boolean
  lockSiderCards: boolean
  hideConnectionCardWave: boolean
  siderOrder: SiderCardKey[]
  siderCardLayout: Record<SiderCardKey, CardStatus>
  siderWidth: number
  lastSelectedSiderCard: (typeof relaySidebarCards)[number]
  hideUnavailableProxies: boolean
  proxyDisplayOrder: IAppConfig['proxyDisplayOrder']
  proxyDisplayMode: IAppConfig['proxyDisplayMode']
  proxyCols: IAppConfig['proxyCols']
  connectionDirection: IAppConfig['connectionDirection']
  connectionOrderBy: IAppConfig['connectionOrderBy']
  profileDisplayDate: IAppConfig['profileDisplayDate']
}
export const relayConnectionSortPreferenceKeys = [
  'connectionDirection',
  'connectionOrderBy'
] as const
export const relayProxyColumns = ['auto', '1', '2', '3', '4'] as const
export const relayProxyDisplayPreferenceKeys = [
  'hideUnavailableProxies',
  'proxyDisplayOrder',
  'proxyDisplayMode'
] as const
export interface RelayUIPreferencesState {
  value: RelayUIPreferences
  revision: string
  exists: boolean
  initialized: boolean
  pending: boolean
  uncertain: boolean
}
export const RELAY_UI_PREFERENCES_CHANNELS = [
  'relayUIPreferencesState',
  'relayUIPreferencesRead',
  'relayUIPreferencesSave',
  'relayAppLogSizeRead',
  'relayAppLogSizeSave'
] as const
export const relayAppLogSize = { min: 1, max: 100, default: 10 } as const
export interface RelayAppLogSizeRecord {
  sizeMiB: number
  revision: string
}
export function isRelayAppLogSizeMiB(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= relayAppLogSize.min &&
    value <= relayAppLogSize.max
  )
}
export function readRelayAppLogSizeRecord(raw: unknown): RelayAppLogSizeRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('应用日志偏好无效。')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).sort().join(',') !== 'revision,sizeMiB' ||
    typeof value.revision !== 'string' ||
    !/^(|[a-f0-9]{64})$/u.test(value.revision) ||
    !isRelayAppLogSizeMiB(value.sizeMiB)
  )
    throw new Error('应用日志偏好无效。')
  return { revision: value.revision, sizeMiB: value.sizeMiB }
}
export function defaultUIPreferences(): RelayUIPreferences {
  return {
    version: 1,
    language: 'zh-CN',
    disableAnimations: false,
    rememberSelectedSiderCard: false,
    lockSiderCards: false,
    hideConnectionCardWave: false,
    siderOrder: [...DEFAULT_SIDER_ORDER],
    siderCardLayout: { ...relayDefaultSidebarLayout },
    siderWidth: 250,
    lastSelectedSiderCard: 'proxy',
    hideUnavailableProxies: false,
    proxyDisplayOrder: 'default',
    proxyDisplayMode: 'simple',
    proxyCols: 'auto',
    connectionDirection: 'asc',
    connectionOrderBy: 'time',
    profileDisplayDate: 'expire'
  }
}
export function interfaceLanguage(raw: unknown): RelayInterfaceLanguage {
  if (typeof raw !== 'string' || !relayInterfaceLanguages.includes(raw as RelayInterfaceLanguage))
    throw new Error('界面语言未支持。')
  return raw as RelayInterfaceLanguage
}
export function uiPreferences(
  raw: unknown,
  format: 'current' | 'stored' = 'current'
): RelayUIPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本地界面偏好无效。')
  const value = raw as Record<string, unknown>,
    defaults = defaultUIPreferences(),
    expectedKeys = Object.keys(defaults).sort(),
    actualKeys = Object.keys(value).sort().join(','),
    preListDisplayKeys = expectedKeys.filter(
      (key) =>
        key !== 'profileDisplayDate' &&
        !relayConnectionSortPreferenceKeys.some((name) => name === key)
    ),
    preLayoutKeys = preListDisplayKeys.filter((key) => key !== 'siderCardLayout'),
    preColumnKeys = preLayoutKeys.filter((key) => key !== 'proxyCols'),
    legacyKeys = preColumnKeys.filter(
      (key) => !relayProxyDisplayPreferenceKeys.some((name) => name === key)
    )
  // Exact old documents keep their original byte revision until a user saves.
  const legacy = format === 'stored' && actualKeys === legacyKeys.join(',')
  const preColumns = format === 'stored' && actualKeys === preColumnKeys.join(',')
  const preLayout = format === 'stored' && actualKeys === preLayoutKeys.join(',')
  const preListDisplay = format === 'stored' && actualKeys === preListDisplayKeys.join(',')
  if (
    (!legacy &&
      !preColumns &&
      !preLayout &&
      !preListDisplay &&
      actualKeys !== expectedKeys.join(',')) ||
    value.version !== 1
  )
    throw new Error('本地界面偏好字段无效。')
  for (const key of [
    'disableAnimations',
    'rememberSelectedSiderCard',
    'lockSiderCards',
    'hideConnectionCardWave'
  ])
    if (typeof value[key] !== 'boolean') throw new Error('界面选项必须是布尔值。')
  if (
    typeof value.siderWidth !== 'number' ||
    !Number.isFinite(value.siderWidth) ||
    !(
      value.siderWidth === 60 ||
      value.siderWidth === 70 ||
      (value.siderWidth >= 250 && value.siderWidth <= 400)
    ) ||
    !relaySidebarCards.includes(
      value.lastSelectedSiderCard as RelayUIPreferences['lastSelectedSiderCard']
    )
  )
    throw new Error('侧栏偏好无效。')
  if (
    !Array.isArray(value.siderOrder) ||
    value.siderOrder.length !== relaySidebarCards.length ||
    new Set(value.siderOrder).size !== value.siderOrder.length ||
    value.siderOrder.some((key) => !relaySidebarCards.includes(key))
  )
    throw new Error('侧栏顺序无效。')
  const { hideUnavailableProxies, proxyDisplayOrder, proxyDisplayMode } = legacy ? defaults : value
  if (
    typeof hideUnavailableProxies !== 'boolean' ||
    (proxyDisplayOrder !== 'default' &&
      proxyDisplayOrder !== 'delay' &&
      proxyDisplayOrder !== 'name') ||
    (proxyDisplayMode !== 'simple' && proxyDisplayMode !== 'full')
  )
    throw new Error('代理列表显示偏好无效。')
  const proxyCols = legacy || preColumns ? defaults.proxyCols : value.proxyCols
  if (!relayProxyColumns.some((choice) => choice === proxyCols))
    throw new Error('代理列表列数无效。')
  const { connectionDirection, connectionOrderBy, profileDisplayDate } =
    legacy || preColumns || preLayout || preListDisplay ? defaults : value
  if (
    (connectionDirection !== 'asc' && connectionDirection !== 'desc') ||
    typeof connectionOrderBy !== 'string' ||
    !['time', 'upload', 'download', 'uploadSpeed', 'downloadSpeed'].includes(connectionOrderBy)
  )
    throw new Error('连接列表排序偏好无效。')
  if (profileDisplayDate !== 'update' && profileDisplayDate !== 'expire')
    throw new Error('订阅日期显示偏好无效。')
  const layout =
    legacy || preColumns || preLayout ? defaults.siderCardLayout : value.siderCardLayout
  if (!layout || typeof layout !== 'object' || Array.isArray(layout))
    throw new Error('侧栏卡片布局无效。')
  const cardLayout = layout as Record<string, unknown>
  if (
    Object.keys(cardLayout).length !== relaySidebarCards.length ||
    relaySidebarCards.some(
      (key) =>
        !Object.hasOwn(cardLayout, key) ||
        !relaySidebarCardSizes.some((size) => size === cardLayout[key])
    )
  )
    throw new Error('侧栏卡片布局无效。')
  return {
    ...defaults,
    ...value,
    siderOrder: [...value.siderOrder],
    siderCardLayout: { ...cardLayout },
    language: interfaceLanguage(value.language)
  } as RelayUIPreferences
}
export function readUIPreferencesState(raw: unknown): RelayUIPreferencesState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('界面偏好回执无效。')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).sort().join(',') !== 'exists,initialized,pending,revision,uncertain,value' ||
    typeof value.revision !== 'string' ||
    !/^(|[a-f0-9]{64})$/u.test(value.revision) ||
    ['exists', 'initialized', 'pending', 'uncertain'].some((key) => typeof value[key] !== 'boolean')
  )
    throw new Error('界面偏好回执未知。')
  return { ...value, value: uiPreferences(value.value) } as RelayUIPreferencesState
}
