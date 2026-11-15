import { isIP } from 'net'
import { validateCoreMode } from '../../../shared/relay/core'
import { localCoreLogLevel } from '../../../shared/relay/local-proxy'
import { stripProfileControls } from '../../../shared/relay/profiles'
import { smartCollectorSizeMiB } from '../../../shared/relay/smart-settings'

// Fixed Mihomo RawConfig / Clash Party SIMPLE_GENERAL_CONFIG_KEYS fields.
// Source listener ownership and persistent caches remain separate from the
// Relay HTTP runtime; these fields are retained for complete/TUN preparation.
export const localProxyInheritedKeys = [
  'mode',
  'log-level',
  'unified-delay',
  'tcp-concurrent',
  'find-process-mode',
  'geodata-mode'
] as const
export const localProxySeparateKeys = [
  'port',
  'mixed-port',
  'socks-port',
  'redir-port',
  'tproxy-port',
  'tun',
  'external-controller',
  'allow-lan',
  'bind-address',
  'lan-allowed-ips',
  'lan-disallowed-ips',
  'authentication',
  'skip-auth-prefixes',
  'profile',
  'geo-auto-update',
  'geo-update-interval',
  'geox-url'
] as const
type Map = Record<string, unknown>
const object = (value: unknown): value is Map =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function invalid(key: string): never {
  throw new Error(`HTTP 运行暂不支持当前 ${key} 设置；原配置已保留，请在对应模块核对。`)
}
function cidr(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const [address, prefix, extra] = value.split('/')
  const version = isIP(address)
  return (
    !!version &&
    extra === undefined &&
    /^\d+$/.test(prefix ?? '') &&
    Number(prefix) <= (version === 4 ? 32 : 128)
  )
}
export function localProxyInheritedOptions(source: Map): Map {
  const result: Map = {}
  for (const key of localProxyInheritedKeys) {
    const value = source[key]
    if (value === undefined) continue
    if (key === 'mode') validateCoreMode(value)
    else if (key === 'log-level') localCoreLogLevel(value)
    else if (key === 'find-process-mode') {
      if (typeof value !== 'string' || !['off', 'strict', 'always'].includes(value)) invalid(key)
    } else if (typeof value !== 'boolean') invalid(key)
    result[key] = value
  }
  return result
}
export function validateLocalProxySourceOptions(source: Map): void {
  localProxyInheritedOptions(source)
  for (const key of ['port', 'mixed-port', 'socks-port', 'redir-port', 'tproxy-port']) {
    const value = source[key]
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535)
    )
      invalid(key)
  }
  if (source.tun !== undefined && !object(source.tun)) invalid('tun')
  if (
    source['external-controller'] !== undefined &&
    (typeof source['external-controller'] !== 'string' ||
      stripProfileControls(source['external-controller']) !== source['external-controller'])
  )
    invalid('external-controller')
  if (source['allow-lan'] !== undefined && typeof source['allow-lan'] !== 'boolean')
    invalid('allow-lan')
  if (
    source['bind-address'] !== undefined &&
    (typeof source['bind-address'] !== 'string' ||
      !['*', '', '127.0.0.1', '::1', 'localhost'].includes(source['bind-address']))
  )
    invalid('bind-address')
  for (const key of ['authentication', 'lan-disallowed-ips'])
    if (source[key] !== undefined && (!Array.isArray(source[key]) || source[key].length))
      invalid(key)
  if (
    source['lan-allowed-ips'] !== undefined &&
    (!Array.isArray(source['lan-allowed-ips']) ||
      source['lan-allowed-ips'].some(
        (value) => typeof value !== 'string' || !['0.0.0.0/0', '::/0'].includes(value)
      ))
  )
    invalid('lan-allowed-ips')
  if (
    source['skip-auth-prefixes'] !== undefined &&
    (!Array.isArray(source['skip-auth-prefixes']) || !source['skip-auth-prefixes'].every(cidr))
  )
    invalid('skip-auth-prefixes')
  if (source.profile !== undefined) {
    if (!object(source.profile)) invalid('profile')
    for (const [key, value] of Object.entries(source.profile)) {
      if (key === 'smart-collector-size') smartCollectorSizeMiB(value)
      else if (!['store-selected', 'store-fake-ip'].includes(key) || typeof value !== 'boolean')
        invalid(`profile.${key}`)
    }
  }
  if (source['geo-auto-update'] !== undefined && source['geo-auto-update'] !== false)
    invalid('geo-auto-update')
  const interval = source['geo-update-interval']
  if (
    interval !== undefined &&
    (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > 8760)
  )
    invalid('geo-update-interval')
  if (source['geox-url'] !== undefined) {
    if (!object(source['geox-url'])) invalid('geox-url')
    for (const [key, value] of Object.entries(source['geox-url'])) {
      if (!['geoip', 'geosite', 'mmdb', 'metadb', 'asn'].includes(key) || typeof value !== 'string')
        invalid('geox-url')
      if (value === '') continue
      let url: URL
      try {
        url = new URL(value)
      } catch {
        return invalid('geox-url')
      }
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        invalid('geox-url')
    }
  }
}
