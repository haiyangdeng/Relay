import { validateCoreMode, type RelayCoreMode } from '../../../shared/relay/core'

export function coreEnvironment(source = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  // In particular, do not inherit CLASH_CONFIG_STRING, controller overrides,
  // post-up/post-down commands, SAFE_PATHS, proxy variables or unrelated tokens.
  for (const key of [
    'HOME',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TZ',
    '__CF_USER_TEXT_ENCODING'
  ])
    if (typeof source[key] === 'string') result[key] = source[key]
  result.PATH = '/usr/bin:/bin'
  return result
}
export function isolatedCoreConfiguration(mode: RelayCoreMode = 'rule'): Record<string, unknown> {
  return {
    port: 0,
    'socks-port': 0,
    'mixed-port': 0,
    'redir-port': 0,
    'tproxy-port': 0,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: validateCoreMode(mode),
    'log-level': 'silent',
    ipv6: false,
    'external-controller': '',
    'external-controller-tls': '',
    'external-ui': '',
    dns: { enable: false },
    hosts: {},
    tun: { enable: false },
    ntp: { enable: false },
    sniffer: { enable: false },
    profile: { 'store-selected': false, 'store-fake-ip': false },
    'geo-auto-update': false,
    'geodata-mode': false,
    'find-process-mode': 'off',
    proxies: [],
    'proxy-groups': [],
    'proxy-providers': {},
    'rule-providers': {},
    listeners: [],
    rules: ['MATCH,REJECT']
  }
}
