export const RELAY_WORKSPACE_PANELS = {
  overview: { title: '概览', group: 'overview' },
  'system-proxy': { title: '系统代理', group: 'sysproxy' },
  profiles: { title: '订阅管理', group: 'profiles' },
  'profile-library': { title: '配置文件与检查', group: 'profiles' },
  'profile-sources': { title: '订阅来源与版本', group: 'profiles' },
  plugins: { title: '插件与订阅授权', group: 'profiles' },
  simple: { title: 'Simple 模块配置', group: 'profiles' },
  providers: { title: '节点提供者', group: 'profiles' },
  'rule-providers': { title: '规则提供者', group: 'profiles' },
  geodata: { title: '外部资源', group: 'resources' },
  'resource-acquisition': { title: '可信资源与模型', group: 'resources' },
  'smart-resources': { title: 'Smart 状态与工具', group: 'resources' },
  rules: { title: '分流规则', group: 'rules' },
  dns: { title: 'DNS 设置', group: 'dns' },
  sniffer: { title: '域名嗅探设置', group: 'sniffer' },
  'override-library': { title: '覆写管理', group: 'override' },
  substore: { title: 'Sub-Store', group: 'substore' },
  tun: { title: '虚拟网卡', group: 'tun' },
  core: { title: '内核设置', group: 'core' },
  variants: { title: '内核版本', group: 'core' },
  'core-check': { title: '内核检查', group: 'core' },
  'core-recovery': { title: '内核恢复', group: 'core' },
  configuration: { title: '运行配置检查', group: 'core' },
  connections: { title: '连接', group: 'connections' },
  logs: { title: '实时日志', group: 'logs' },
  network: { title: '网络信息', group: 'network' },
  clients: { title: 'Claude 与 Codex', group: 'clients' },
  code: { title: 'Claude Code 配置', group: 'clients' },
  'desktop-login': { title: '桌面登录', group: 'desktop-login' },
  guard: { title: '连接保护', group: 'guard' },
  diagnostics: { title: '配置检测', group: 'clients' },
  recovery: { title: '客户端配置恢复', group: 'clients' },
  settings: { title: '界面设置', group: 'settings' },
  shell: { title: '窗口与托盘', group: 'settings' },
  maintenance: { title: '本地维护', group: 'settings' },
  'app-update': { title: '应用更新', group: 'settings' },
  backup: { title: '本地备份', group: 'backup' },
  'backup-accounts': { title: '远程备份', group: 'backup' },
  'runtime-share': { title: '运行配置分享', group: 'backup' }
} as const

export type RelayWorkspacePanel = keyof typeof RELAY_WORKSPACE_PANELS

export const RELAY_WORKSPACE_ROUTES: Readonly<Record<string, RelayWorkspacePanel>> = {
  '/sysproxy': 'system-proxy',
  '/profiles': 'profiles',
  '/resources': 'geodata',
  '/rules': 'rules',
  '/dns': 'dns',
  '/sniffer': 'sniffer',
  '/override': 'override-library',
  '/tun': 'tun',
  '/mihomo': 'core',
  '/connections': 'connections',
  '/logs': 'logs',
  '/network': 'network',
  '/settings': 'settings',
  '/substore': 'substore',
  '/simple': 'simple'
}

export function getRelayWorkspacePanel(search: string): RelayWorkspacePanel {
  const panel = new URLSearchParams(search).get('panel')
  return panel && Object.hasOwn(RELAY_WORKSPACE_PANELS, panel)
    ? (panel as RelayWorkspacePanel)
    : 'overview'
}

export function relayWorkspaceLink(panel: RelayWorkspacePanel): string {
  return panel === 'overview' ? '/relay' : `/relay?panel=${panel}`
}

export function relayNavigationTarget(route: string): string {
  return Object.hasOwn(RELAY_WORKSPACE_ROUTES, route)
    ? relayWorkspaceLink(RELAY_WORKSPACE_ROUTES[route])
    : route
}

export function isRelayNavigationActive(pathname: string, search: string, route: string): boolean {
  const target = relayNavigationTarget(route)
  const [targetPath, targetSearch = ''] = target.split('?')
  if (pathname !== '/relay') return pathname === targetPath || pathname === route
  if (targetPath !== '/relay') return false
  return (
    RELAY_WORKSPACE_PANELS[getRelayWorkspacePanel(search)].group ===
    RELAY_WORKSPACE_PANELS[getRelayWorkspacePanel(targetSearch)].group
  )
}
