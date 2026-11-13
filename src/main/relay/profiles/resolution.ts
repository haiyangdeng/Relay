import { isIP } from 'net'
import type { LocalResolutionSummary } from '../../../shared/relay/local-proxy'
import { stripProfileControls } from '../../../shared/relay/profiles'
import type { ProfileRuntimeGeography } from './runtime'

type Item = Record<string, unknown>
const object = (value: unknown): value is Item =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
function fail(): never {
  throw new Error('DNS／hosts含未支持、依赖外部资源或无效的选项；未启动且未删减原配置。')
}
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 2048 &&
  stripProfileControls(value) === value &&
  value.trim() === value
const domain = (value: unknown): value is string => {
  if (!text(value) || value.endsWith('.')) return false
  const host = value.replace(/^(?:\+\.|\*\.|\.)/u, '')
  return (
    host.length <= 253 &&
    host
      .split('.')
      .every((label) => label === '*' || /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/iu.test(label))
  )
}
const cidr = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  const [host, prefix, extra] = value.split('/')
  const family = isIP(host),
    bits = Number(prefix)
  return (
    !!family &&
    extra === undefined &&
    /^\d+$/u.test(prefix ?? '') &&
    Number.isInteger(bits) &&
    bits >= 0 &&
    bits <= (family === 4 ? 32 : 128)
  )
}
function list(value: unknown, required = false): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    (required && !value.length) ||
    value.some((entry) => !text(entry))
  )
    fail()
  return value as string[]
}
function endpoint(
  value: string,
  targets: ReadonlySet<string>,
  bootstrap = false
): { ip: boolean; routed: boolean } {
  if (!text(value) || value === 'system' || /[\s\\]/u.test(value.split('#')[0])) fail()
  let url: URL
  try {
    url = new URL(
      value.includes('://') ? value : 'udp://' + (isIP(value) === 6 ? `[${value}]` : value)
    )
  } catch {
    return fail()
  }
  if (url.protocol === 'rcode:') {
    if (
      bootstrap ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      url.pathname ||
      ![
        'success',
        'format_error',
        'server_failure',
        'name_error',
        'not_implemented',
        'refused'
      ].includes(url.hostname)
    )
      fail()
    return { ip: false, routed: false }
  }
  if (
    !['udp:', 'tcp:', 'tls:', 'http:', 'https:', 'quic:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    !url.hostname ||
    (!['http:', 'https:'].includes(url.protocol) && url.pathname && url.pathname !== '/') ||
    (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
  )
    fail()
  const hostname = url.hostname.replace(/^\[|\]$/gu, ''),
    ip = !!isIP(hostname)
  if (!ip && (!domain(hostname) || /[*_]/u.test(hostname))) fail()
  let route: string
  try {
    route = decodeURIComponent(url.hash.slice(1))
  } catch {
    return fail()
  }
  // Mihomo resolves #name as a proxy when present, otherwise as an explicit
  // interface. On macOS an unknown interface fails public-target binding; preserve this
  // upstream behavior instead of rejecting the entire imported configuration.
  if (route && (!text(route) || /[&=#]/u.test(route))) fail()
  if (bootstrap && (!ip || route)) fail()
  return { ip, routed: !!route && route !== 'DIRECT' && (targets.has(route) || route === 'RULES') }
}

const lists = [
  'nameserver',
  'default-nameserver',
  'fallback',
  'proxy-server-nameserver',
  'direct-nameserver'
]
const policies = ['nameserver-policy', 'proxy-server-nameserver-policy']
const flags = [
  'prefer-h3',
  'ipv6',
  'use-hosts',
  'use-system-hosts',
  'respect-rules',
  'fallback-lazy-query',
  'direct-nameserver-follow-policy'
]
const counts = ['ipv6-timeout', 'cache-max-size', 'fake-ip-ttl']
const fields = new Set([
  ...lists,
  ...policies,
  ...flags,
  ...counts,
  'enable',
  'listen',
  'enhanced-mode',
  'fake-ip-range',
  'fake-ip-range6',
  'fake-ip-filter',
  'fake-ip-filter-mode',
  'cache-algorithm',
  'fallback-filter'
])

// No external files, automatic interface discovery, system DNS or provider
// expansion. Geo policies require bound local data. DNS Listen stays empty.
export function compileProfileResolution(
  data: Item,
  targets: ReadonlySet<string>,
  geography?: ProfileRuntimeGeography
): {
  dns: Item
  hosts: Item
  ipv6: boolean
  summary: LocalResolutionSummary
} {
  if (
    !object(data.dns) ||
    data.dns.enable !== true ||
    Object.keys(data.dns).some((key) => !fields.has(key))
  )
    fail()
  const source = data.dns,
    dns = structuredClone(source)
  if (source.listen !== undefined && typeof source.listen !== 'string') fail()
  for (const key of flags) if (source[key] !== undefined && typeof source[key] !== 'boolean') fail()
  for (const key of counts)
    if (
      source[key] !== undefined &&
      (typeof source[key] !== 'number' ||
        !Number.isInteger(source[key]) ||
        source[key] < 0 ||
        source[key] > 1000000)
    )
      fail()
  if (data.ipv6 !== undefined && typeof data.ipv6 !== 'boolean') fail()
  if (
    source['enhanced-mode'] !== undefined &&
    !['redir-host', 'fake-ip'].includes(String(source['enhanced-mode']))
  )
    fail()
  if (
    source['cache-algorithm'] !== undefined &&
    !['lru', 'arc'].includes(String(source['cache-algorithm']))
  )
    fail()
  if (
    source['fake-ip-filter-mode'] !== undefined &&
    !['blacklist', 'whitelist'].includes(String(source['fake-ip-filter-mode']))
  )
    fail()
  for (const key of ['fake-ip-range', 'fake-ip-range6'])
    if (
      source[key] !== undefined &&
      (!cidr(source[key]) ||
        isIP(String(source[key]).split('/')[0]) !== (key.endsWith('6') ? 6 : 4))
    )
      fail()
  if (
    source['fake-ip-filter'] !== undefined &&
    (!Array.isArray(source['fake-ip-filter']) ||
      source['fake-ip-filter'].length > 512 ||
      source['fake-ip-filter'].some((value) => !domain(value)))
  )
    fail()

  const main = list(source.nameserver, true)
  let routed = false
  for (const key of lists)
    if (source[key] !== undefined) {
      for (const value of list(source[key], key === 'default-nameserver')) {
        const parsed = endpoint(value, targets, key === 'default-nameserver')
        if (key === 'proxy-server-nameserver' && parsed.routed) fail()
        routed ||= parsed.routed
      }
    }
  let policyCount = 0
  for (const key of policies)
    if (source[key] !== undefined) {
      if (!object(source[key]) || Object.keys(source[key]).length > 512) fail()
      for (const [name, values] of Object.entries(source[key])) {
        const geosite = name.startsWith('geosite:')
        if (
          !text(name) ||
          (geosite
            ? !geography?.geosite ||
              !name
                .slice(8)
                .split(',')
                .every((value) => /^[a-zA-Z0-9_@!.-]{1,128}$/u.test(value))
            : !name.split(',').every(domain))
        )
          fail()
        const servers = typeof values === 'string' ? [values] : list(values, true)
        for (const value of servers) {
          const parsed = endpoint(value, targets)
          if (key === 'proxy-server-nameserver-policy' && parsed.routed) fail()
          routed ||= parsed.routed
        }
        ++policyCount
      }
    }
  const proxyDNS =
    source['proxy-server-nameserver'] === undefined ? [] : list(source['proxy-server-nameserver'])
  if (
    (source['respect-rules'] === true || source['proxy-server-nameserver-policy'] !== undefined) &&
    !proxyDNS.length
  )
    fail()
  const nodes = Array.isArray(data.proxies) ? data.proxies : []
  if (
    routed &&
    nodes.some((node) => object(node) && typeof node.server === 'string' && !isIP(node.server)) &&
    !proxyDNS.length
  )
    fail()
  const bootstrapDerived = source['default-nameserver'] === undefined
  if (bootstrapDerived) {
    const literals = main.filter((server) => {
      const parsed = endpoint(server, targets)
      return parsed.ip && !parsed.routed && !server.includes('#')
    })
    if (!literals.length) fail()
    dns['default-nameserver'] = literals
  }
  if (source['fallback-filter'] !== undefined) {
    const filter = source['fallback-filter']
    const hasFallback = source.fallback !== undefined && list(source.fallback).length > 0
    if (
      !object(filter) ||
      Object.keys(filter).some(
        (key) => !['geoip', 'geoip-code', 'ipcidr', 'domain', 'geosite'].includes(key)
      ) ||
      (hasFallback && filter.geoip !== false) ||
      (filter.geoip !== undefined && typeof filter.geoip !== 'boolean') ||
      (filter['geoip-code'] !== undefined && typeof filter['geoip-code'] !== 'string') ||
      (filter.geosite !== undefined && (!Array.isArray(filter.geosite) || filter.geosite.length)) ||
      (filter.ipcidr !== undefined &&
        (!Array.isArray(filter.ipcidr) ||
          filter.ipcidr.length > 512 ||
          filter.ipcidr.some((value) => !cidr(value)))) ||
      (filter.domain !== undefined &&
        (!Array.isArray(filter.domain) ||
          filter.domain.length > 512 ||
          filter.domain.some((value) => !domain(value))))
    )
      fail()
    // Fixed Mihomo parseDNS only reads fallback filters when Fallback is nonempty.
    // Preserve Clash's dormant defaults; active geographical fallback stays blocked.
    dns['fallback-filter'] = { ...filter }
  } else {
    if (source.fallback !== undefined && list(source.fallback).length) fail()
    dns['fallback-filter'] = { geoip: false }
  }
  const hosts = data.hosts === undefined ? {} : data.hosts
  if (!object(hosts) || Object.keys(hosts).length > 1000) fail()
  for (const [name, values] of Object.entries(hosts)) {
    const addresses = typeof values === 'string' ? [values] : list(values, true)
    if (!domain(name) || addresses.some((value) => !isIP(value))) fail()
  }
  dns.listen = ''
  if (Buffer.byteLength(JSON.stringify({ dns, hosts })) > 128 * 1024) fail()
  return {
    dns,
    hosts: structuredClone(hosts),
    ipv6: data.ipv6 === true,
    summary: {
      mode: 'profile',
      enabled: true,
      hosts: Object.keys(hosts).length,
      policies: policyCount,
      bootstrapDerived,
      listenerSuppressed: !!source.listen
    }
  }
}
