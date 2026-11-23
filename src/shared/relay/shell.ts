export const shellShortcutActions = [
  'showWindow',
  'showFloatingWindow',
  'triggerSysProxy',
  'triggerTun',
  'ruleMode',
  'globalMode',
  'directMode',
  'copyEnv',
  'runInBackground',
  'restartApp',
  'quitApp'
] as const
export type RelayShellAction = (typeof shellShortcutActions)[number]
export const shellEnvironmentFormats = [
  'default',
  'bash',
  'cmd',
  'powershell',
  'fish',
  'nushell'
] as const
export type RelayShellEnvironmentFormat = (typeof shellEnvironmentFormats)[number]
export type RelayShellActionRequest =
  | RelayShellAction
  | { action: 'copyEnv'; format: RelayShellEnvironmentFormat }
  | { action: 'triggerSysProxy'; enabled: boolean }
export const shellEnvironmentLabels: Record<RelayShellEnvironmentFormat, string> = {
  default: '原有格式（含NO_PROXY）',
  bash: 'Bash',
  cmd: 'CMD',
  powershell: 'PowerShell',
  fish: 'Fish',
  nushell: 'Nushell'
}

// Adapted from fixed Clash Party v2.0.4 ac294fed tray.copyEnv. Only an
// already verified own HTTP listener may supply the port; no commands run here.
export function shellProxyEnvironment(port: number, format: RelayShellEnvironmentFormat): string {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error('本次HTTP端口未确认。')
  const proxy = `http://127.0.0.1:${port}`
  switch (format) {
    case 'default':
      return `export HTTP_PROXY=${proxy}\nexport HTTPS_PROXY=${proxy}\nexport ALL_PROXY=${proxy}\nexport NO_PROXY=localhost,127.0.0.1,::1`
    case 'bash':
      return `export https_proxy=${proxy} http_proxy=${proxy} all_proxy=${proxy}`
    case 'cmd':
      return `set http_proxy=${proxy}\r\nset https_proxy=${proxy}`
    case 'powershell':
      return `$env:HTTP_PROXY="${proxy}"; $env:HTTPS_PROXY="${proxy}"`
    case 'fish':
      return `set -x http_proxy ${proxy}; set -x https_proxy ${proxy}; set -x all_proxy ${proxy}`
    case 'nushell':
      return `$env.HTTP_PROXY = "${proxy}"; $env.HTTPS_PROXY = "${proxy}"; $env.ALL_PROXY = "${proxy}"`
    default:
      throw new Error('环境变量格式未支持。')
  }
}
export interface RelayShellRestartResult {
  status: 'requested' | 'cancelled'
}
export interface RelayShellTheme {
  id: string
  name: string
  css: string
}

export const shellTrayProxyGroupStyles = ['default', 'submenu'] as const
export type RelayShellTrayProxyGroupStyle = (typeof shellTrayProxyGroupStyles)[number]
export const shellTrayProxyGroupLabels: Record<RelayShellTrayProxyGroupStyle, string> = {
  default: '逐组显示（上游默认）',
  submenu: '折叠至本次实例节点子菜单'
}

export const shellTrayIconKinds = ['default', 'white', 'blue', 'green', 'red'] as const
export type RelayShellTrayIconKind = (typeof shellTrayIconKinds)[number]
export type RelayTrayTrafficTextColor = 'auto' | 'black' | 'white'
export interface RelayShellDisplaySettings {
  floatingWindowCompatMode?: boolean
  trayTrafficTextColor?: RelayTrayTrafficTextColor
  useWindowFrame?: boolean
  disableHardwareAcceleration?: boolean
}

export const relayShellAppearanceKeys = [
  'floatingWindowCompatMode',
  'trayTrafficTextColor'
] as const
export const relayShellStartupKeys = ['useWindowFrame', 'disableHardwareAcceleration'] as const
export const relayShellDisplayKeys = [
  ...relayShellAppearanceKeys,
  ...relayShellStartupKeys
] as const

export function shellDisplaySettings(
  input: Partial<Record<(typeof relayShellDisplayKeys)[number], unknown>>
): RelayShellDisplaySettings {
  const settings: RelayShellDisplaySettings = {}
  for (const key of relayShellDisplayKeys) {
    if (!Object.hasOwn(input, key)) continue
    const value = input[key]
    if (key === 'trayTrafficTextColor') {
      if (value !== 'auto' && value !== 'black' && value !== 'white')
        throw new Error('托盘速度文字颜色无效。')
      settings[key] = value
      continue
    }
    if (typeof value !== 'boolean') throw new Error('窗口显示选项必须为开关。')
    settings[key] = value
  }
  return settings
}

export interface RelayShellSettings extends RelayShellDisplaySettings {
  operationMode: 'standard' | 'simple'
  appTheme: 'light' | 'dark' | 'system'
  silentStart: boolean
  closeToTray: boolean
  alwaysOnTop: boolean
  showFloatingWindow: boolean
  spinFloatingIcon: boolean
  showDockIcon: boolean
  disableTray: boolean
  disableTrayIconColor: boolean
  trayShowTraffic: boolean
  customTrayIcons: Record<RelayShellTrayIconKind, string>
  swapTrayClick: boolean
  triggerMainWindowBehavior: 'show' | 'toggle'
  showCurrentProxyInTray: boolean
  proxyInTray: boolean
  trayProxyGroupStyle: RelayShellTrayProxyGroupStyle
  environmentFormat: RelayShellEnvironmentFormat
  environmentFormats?: RelayShellEnvironmentFormat[]
  customCSS: string
  themes: RelayShellTheme[]
  shortcuts: Record<RelayShellAction, string>
}
export interface RelayShellRecord {
  settings: RelayShellSettings
  revision: string
  exists: boolean
}
export interface RelayShellState extends RelayShellRecord {
  initialized: boolean
  pending: boolean
  uncertain: boolean
  warnings: string[]
}

export interface RelayLoginItemResult {
  status: 'applied' | 'unchanged' | 'cancelled' | 'uncertain'
  openAtLogin?: boolean
  warnings: string[]
}

export function defaultShellSettings(): RelayShellSettings {
  return {
    operationMode: 'standard',
    appTheme: 'system',
    silentStart: false,
    closeToTray: false,
    alwaysOnTop: false,
    showFloatingWindow: false,
    spinFloatingIcon: true,
    showDockIcon: true,
    disableTray: false,
    disableTrayIconColor: false,
    trayShowTraffic: false,
    customTrayIcons: { default: '', white: '', blue: '', green: '', red: '' },
    swapTrayClick: false,
    triggerMainWindowBehavior: 'show',
    showCurrentProxyInTray: false,
    proxyInTray: true,
    trayProxyGroupStyle: 'default',
    environmentFormat: 'default',
    customCSS: '',
    themes: [],
    shortcuts: {
      showWindow: '',
      showFloatingWindow: '',
      triggerSysProxy: '',
      triggerTun: '',
      ruleMode: '',
      globalMode: '',
      directMode: '',
      copyEnv: '',
      runInBackground: '',
      restartApp: '',
      quitApp: ''
    }
  }
}

const modifierOrder = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift', 'Super']
const modifierNames: Record<string, string> = {
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super'
}

export function shellAccelerator(value: unknown): string {
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > 100) throw new Error('快捷键格式无效。')
  const parts = value.split('+').map((part) => part.trim()),
    key = parts.pop()
  if (!key || !parts.length || parts.length > 4) throw new Error('快捷键需要修饰键和按键。')
  const modifiers = parts.map((part) => modifierNames[part.toLowerCase()])
  if (modifiers.some((part) => !part) || new Set(modifiers).size !== modifiers.length)
    throw new Error('快捷键修饰键无效或重复。')
  const normalized =
    key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase()
  if (
    !/^[A-Z0-9]$/u.test(normalized) &&
    !/^F([1-9]|1\d|2[0-4])$/u.test(normalized) &&
    !['Space', 'Enter', 'Tab', 'Escape', 'Up', 'Down', 'Left', 'Right'].includes(normalized)
  )
    throw new Error('快捷键按键不受支持。')
  return [...modifierOrder.filter((part) => modifiers.includes(part)), normalized].join('+')
}

export function shellSettings(value: unknown): RelayShellSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('窗口设置格式无效。')
  const input = value as Record<string, unknown>,
    defaults = defaultShellSettings()
  if (
    Object.keys(input).some(
      (key) =>
        key !== 'environmentFormats' &&
        !relayShellDisplayKeys.some((displayKey) => displayKey === key) &&
        !Object.hasOwn(defaults, key)
    ) ||
    Object.keys(defaults)
      .filter(
        (key) =>
          ![
            'showDockIcon',
            'disableTray',
            'disableTrayIconColor',
            'trayShowTraffic',
            'customTrayIcons',
            'customCSS',
            'themes',
            'swapTrayClick',
            'triggerMainWindowBehavior',
            'spinFloatingIcon',
            'showCurrentProxyInTray',
            'proxyInTray',
            'trayProxyGroupStyle',
            'environmentFormat'
          ].includes(key)
      )
      .some((key) => !Object.hasOwn(input, key))
  )
    throw new Error('窗口设置字段不完整或包含未支持选项。')
  if (input.operationMode !== 'standard' && input.operationMode !== 'simple')
    throw new Error('界面模式无效。')
  if (typeof input.appTheme !== 'string' || !['light', 'dark', 'system'].includes(input.appTheme))
    throw new Error('主题无效。')
  for (const field of ['silentStart', 'closeToTray', 'alwaysOnTop', 'showFloatingWindow'])
    if (typeof input[field] !== 'boolean') throw new Error('窗口开关必须为布尔值。')
  const spinFloatingIcon = Object.hasOwn(input, 'spinFloatingIcon')
    ? input.spinFloatingIcon
    : defaults.spinFloatingIcon
  if (typeof spinFloatingIcon !== 'boolean') throw new Error('浮窗图标旋转开关必须为布尔值。')
  const triggerMainWindowBehavior = Object.hasOwn(input, 'triggerMainWindowBehavior')
    ? input.triggerMainWindowBehavior
    : defaults.triggerMainWindowBehavior
  if (triggerMainWindowBehavior !== 'show' && triggerMainWindowBehavior !== 'toggle')
    throw new Error('托盘主窗口触发行为无效。')
  const showDockIcon = Object.prototype.hasOwnProperty.call(input, 'showDockIcon')
    ? input.showDockIcon
    : true
  if (typeof showDockIcon !== 'boolean') throw new Error('Dock开关必须为布尔值。')
  const disableTray = Object.hasOwn(input, 'disableTray') ? input.disableTray : false
  if (typeof disableTray !== 'boolean') throw new Error('托盘图标开关必须为布尔值。')
  const disableTrayIconColor = Object.hasOwn(input, 'disableTrayIconColor')
      ? input.disableTrayIconColor
      : false,
    trayShowTraffic = Object.hasOwn(input, 'trayShowTraffic') ? input.trayShowTraffic : false
  if (typeof disableTrayIconColor !== 'boolean' || typeof trayShowTraffic !== 'boolean')
    throw new Error('托盘显示设置必须为开关。')
  const customTrayIcons = shellTrayIcons(
    Object.hasOwn(input, 'customTrayIcons') ? input.customTrayIcons : defaults.customTrayIcons
  )
  const swapTrayClick = Object.hasOwn(input, 'swapTrayClick') ? input.swapTrayClick : false
  if (typeof swapTrayClick !== 'boolean') throw new Error('托盘点击开关必须为布尔值。')
  const showCurrentProxyInTray = Object.hasOwn(input, 'showCurrentProxyInTray')
    ? input.showCurrentProxyInTray
    : false
  if (typeof showCurrentProxyInTray !== 'boolean') throw new Error('托盘当前代理开关必须为布尔值。')
  const proxyInTray = Object.hasOwn(input, 'proxyInTray') ? input.proxyInTray : true
  if (typeof proxyInTray !== 'boolean') throw new Error('托盘代理组开关必须为布尔值。')
  // Existing on-disk records had one collapsed submenu. Reading keeps that
  // presentation without rewriting bytes; fresh settings use the upstream default.
  const trayProxyGroupStyle = Object.hasOwn(input, 'trayProxyGroupStyle')
    ? input.trayProxyGroupStyle
    : 'submenu'
  if (
    typeof trayProxyGroupStyle !== 'string' ||
    !shellTrayProxyGroupStyles.includes(trayProxyGroupStyle as RelayShellTrayProxyGroupStyle)
  )
    throw new Error('托盘代理组布局未支持。')
  const environmentFormat = Object.hasOwn(input, 'environmentFormat')
    ? shellEnvironmentFormat(input.environmentFormat)
    : defaults.environmentFormat
  let environmentFormats: RelayShellEnvironmentFormat[] | undefined
  if (Object.hasOwn(input, 'environmentFormats')) {
    const formats = input.environmentFormats
    if (
      !Array.isArray(formats) ||
      !formats.length ||
      formats.length > shellEnvironmentFormats.length
    )
      throw new Error('请选择至少一种托盘复制格式。')
    environmentFormats = Array.from(formats, shellEnvironmentFormat)
    if (new Set(environmentFormats).size !== environmentFormats.length)
      throw new Error('托盘复制格式不能重复。')
  }
  if (!input.shortcuts || typeof input.shortcuts !== 'object' || Array.isArray(input.shortcuts))
    throw new Error('快捷键设置无效。')
  const shortcuts = input.shortcuts as Record<string, unknown>
  if (
    Object.keys(shortcuts).some((key) => !Object.hasOwn(defaults.shortcuts, key)) ||
    shellShortcutActions
      .filter(
        (action) =>
          !['triggerSysProxy', 'triggerTun', 'runInBackground', 'restartApp'].includes(action)
      )
      .some((action) => !Object.hasOwn(shortcuts, action))
  )
    throw new Error('快捷键动作不完整或无效。')
  const result: RelayShellSettings = {
    ...shellDisplaySettings(input),
    operationMode: input.operationMode,
    appTheme: input.appTheme as RelayShellSettings['appTheme'],
    silentStart: input.silentStart as boolean,
    closeToTray: input.closeToTray as boolean,
    alwaysOnTop: input.alwaysOnTop as boolean,
    showFloatingWindow: input.showFloatingWindow as boolean,
    spinFloatingIcon,
    showDockIcon,
    disableTray,
    disableTrayIconColor,
    trayShowTraffic,
    customTrayIcons,
    swapTrayClick,
    triggerMainWindowBehavior,
    showCurrentProxyInTray,
    proxyInTray,
    trayProxyGroupStyle: trayProxyGroupStyle as RelayShellTrayProxyGroupStyle,
    environmentFormat,
    ...(environmentFormats ? { environmentFormats } : {}),
    customCSS: shellCSS(Object.hasOwn(input, 'customCSS') ? input.customCSS : ''),
    themes: shellThemeLibrary(Object.hasOwn(input, 'themes') ? input.themes : []),
    shortcuts: { ...defaults.shortcuts }
  }
  const used = new Set<string>()
  for (const action of shellShortcutActions) {
    const accelerator = shellAccelerator(Object.hasOwn(shortcuts, action) ? shortcuts[action] : '')
    if (accelerator && used.has(accelerator)) throw new Error('多个动作不能使用同一个快捷键。')
    if (accelerator) used.add(accelerator)
    result.shortcuts[action] = accelerator
  }
  return result
}

export function shellCSS(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    new TextEncoder().encode(value).byteLength > 8192
  )
    throw new Error('自定义样式必须是8KiB以内的CSS文本。')
  return value
}
export function shellThemeLibrary(value: unknown): RelayShellTheme[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('主题库最多保存16个方案。')
  const ids = new Set<string>(),
    names = new Set<string>()
  let total = 0
  return value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'css,id,name'
    )
      throw new Error('主题方案格式无效。')
    const theme = item as Record<string, unknown>
    if (
      typeof theme.id !== 'string' ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(theme.id) ||
      ids.has(theme.id) ||
      typeof theme.name !== 'string' ||
      !theme.name.trim() ||
      theme.name !== theme.name.trim() ||
      theme.name.length > 80 ||
      [...theme.name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      names.has(theme.name.toLowerCase())
    )
      throw new Error('主题标识或名称无效、重复或过长。')
    const css = shellCSS(theme.css)
    total += new TextEncoder().encode(css).byteLength
    if (total > 32768) throw new Error('主题库CSS合计不能超过32KiB。')
    ids.add(theme.id)
    names.add(theme.name.toLowerCase())
    return { id: theme.id, name: theme.name, css }
  })
}

export function shellAction(value: unknown): RelayShellAction {
  if (typeof value !== 'string' || !shellShortcutActions.includes(value as RelayShellAction))
    throw new Error('窗口动作未支持。')
  return value as RelayShellAction
}

function shellEnvironmentFormat(value: unknown): RelayShellEnvironmentFormat {
  if (!shellEnvironmentFormats.includes(value as RelayShellEnvironmentFormat))
    throw new Error('环境变量格式未支持。')
  return value as RelayShellEnvironmentFormat
}

export function shellActionRequest(value: unknown): RelayShellActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return shellAction(value)
  const request = value as Record<string, unknown>
  if (
    request.action === 'triggerSysProxy' &&
    typeof request.enabled === 'boolean' &&
    Object.keys(request).length === 2
  )
    return { action: 'triggerSysProxy', enabled: request.enabled }
  if (Object.keys(request).sort().join(',') !== 'action,format' || request.action !== 'copyEnv')
    throw new Error('窗口动作未支持。')
  return { action: 'copyEnv', format: shellEnvironmentFormat(request.format) }
}

// Persist only a small bounded PNG, never a path or executable image format.
export function shellTrayIconData(value: unknown): string {
  if (value === '') return ''
  if (
    typeof value !== 'string' ||
    value.length > 32768 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)
  )
    throw new Error('托盘图标必须是受限PNG。')
  const encoded = value.slice('data:image/png;base64,'.length),
    raw = atob(encoded)
  if (
    btoa(raw) !== encoded ||
    raw.length < 33 ||
    [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => raw.charCodeAt(i) !== v) ||
    raw.slice(12, 16) !== 'IHDR'
  )
    throw new Error('托盘PNG图标无效。')
  const read = (at: number): number =>
    Array.from(raw.slice(at, at + 4)).reduce((n, c) => n * 256 + c.charCodeAt(0), 0)
  if (read(8) !== 13 || read(16) < 1 || read(20) < 1 || read(16) > 128 || read(20) > 128)
    throw new Error('托盘图标最多128像素。')
  return value
}
export function shellTrayIcons(value: unknown): Record<RelayShellTrayIconKind, string> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...shellTrayIconKinds].sort().join(',')
  )
    throw new Error('托盘图标组无效。')
  const raw = value as Record<string, unknown>
  return {
    default: shellTrayIconData(raw.default),
    white: shellTrayIconData(raw.white),
    blue: shellTrayIconData(raw.blue),
    green: shellTrayIconData(raw.green),
    red: shellTrayIconData(raw.red)
  }
}
