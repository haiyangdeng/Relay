import { parseDocument } from 'yaml'
import {
  DEFAULT_CONTROL_DNS,
  DEFAULT_MIHOMO_DNS_CONFIG,
  DEFAULT_USE_NAMESERVER_POLICY
} from '../../../shared/appConfig'
import {
  configurationEditDocument,
  type ConfigurationEditDocument
} from '../../../shared/relay/configuration-edit'

type Item = Record<string, unknown>
export type RelayDnsValue = string | string[]
export interface RelayDnsRow {
  domain: string
  value: RelayDnsValue
}
export interface RelayDnsDraft {
  enable: boolean
  ipv6: boolean
  useHosts: boolean
  useSystemHosts: boolean
  respectRules: boolean
  enhancedMode: 'fake-ip' | 'redir-host' | 'normal'
  fakeIPRange: string
  fakeIPFilter: string[]
  fakeIPFilterMode: 'blacklist' | 'whitelist' | 'rule'
  defaultNameserver: string[]
  nameserver: string[]
  proxyServerNameserver: string[]
  directNameserver: string[]
  fallback: string[]
  fallbackGeoip: boolean
  fallbackGeoipCode: string
  fallbackIpcidr: string[]
  fallbackDomain: string[]
  nameserverPolicy: RelayDnsRow[]
  hosts: RelayDnsRow[]
  controlDns: boolean
  useNameserverPolicy: boolean
  disableDnsOverrideGuard: boolean
}
export interface RelayDnsChanges {
  dns?: boolean
  hosts?: boolean
  controlDns?: boolean
  useNameserverPolicy?: boolean
  disableDnsOverrideGuard?: boolean
}

function isMap(value: unknown): value is Item {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function map(value: unknown, label: string): Item {
  if (!isMap(value)) throw new Error(label + '必须为映射。')
  return value
}
function field(source: Item, key: string, fallback: unknown): unknown {
  return source[key] === undefined ? fallback : source[key]
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('DNS开关必须为布尔。')
  return value
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('DNS文本字段无效。')
  return value
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('DNS列表必须为字符串数组。')
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('DNS列表必须为字符串数组。')
    result.push(item)
  }
  return result
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  for (const item of choices) if (value === item) return item
  throw new Error('DNS选项不受此表单支持。')
}
function rowValue(value: unknown): RelayDnsValue {
  const checked = typeof value === 'string' ? string(value) : strings(value)
  if (
    typeof checked === 'string'
      ? !checked.trim()
      : !checked.length || checked.some((item) => !item.trim())
  )
    throw new Error('DNS映射值不能为空。')
  return checked
}
function rows(value: unknown, label: string): RelayDnsRow[] {
  return Object.entries(map(value, label)).map(([domain, entry]) => {
    if (!domain.trim()) throw new Error('DNS映射键不能为空。')
    return { domain, value: rowValue(entry) }
  })
}
function rowMap(value: RelayDnsRow[]): Record<string, RelayDnsValue> {
  if (!Array.isArray(value)) throw new Error('DNS映射草稿必须为数组。')
  const seen = new Set<string>()
  return Object.fromEntries(
    value.flatMap((row) => {
      if (!isMap(row) || Object.keys(row).sort().join(',') !== 'domain,value')
        throw new Error('DNS映射草稿字段无效。')
      const domain = string(row.domain).trim()
      // An empty UI placeholder is not a stored mapping.
      if (!domain && typeof row.value === 'string' && !row.value.trim()) return []
      if (!domain || seen.has(domain)) throw new Error('DNS映射键为空或重复。')
      seen.add(domain)
      return [[domain, rowValue(row.value)]]
    })
  )
}

export function relayDnsPolicy(value: RelayDnsRow[]): Record<string, RelayDnsValue> {
  return rowMap(value)
}

export function parseRelayDnsPolicy(text: string): RelayDnsRow[] {
  if (
    typeof text !== 'string' ||
    text.length > 1024 * 1024 ||
    new TextEncoder().encode(text).byteLength > 1024 * 1024
  )
    throw new Error('DNS策略JSON过大或无效。')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('DNS策略必须为有效JSON。')
  }
  // JSON.parse establishes the syntax. The existing YAML parser only checks
  // duplicate decoded keys, which JSON.parse would otherwise silently replace.
  const document = parseDocument(text, { schema: 'json', uniqueKeys: true, strict: true })
  if (document.errors.length) throw new Error('DNS策略JSON含重复键或无效结构。')
  return rows(parsed, 'DNS策略')
}

export function relayDnsDraft(base: ConfigurationEditDocument): RelayDnsDraft {
  const document = configurationEditDocument(base)
  const dns = map(field(document.controlled, 'dns', {}), 'DNS设置')
  const filter = map(field(dns, 'fallback-filter', {}), 'DNS回退过滤')
  const defaults = DEFAULT_MIHOMO_DNS_CONFIG
  const defaultFilter = defaults['fallback-filter'] ?? {}
  return {
    enable: boolean(field(dns, 'enable', defaults.enable)),
    ipv6: boolean(field(dns, 'ipv6', defaults.ipv6)),
    useHosts: boolean(field(dns, 'use-hosts', defaults['use-hosts'])),
    useSystemHosts: boolean(field(dns, 'use-system-hosts', defaults['use-system-hosts'])),
    respectRules: boolean(field(dns, 'respect-rules', defaults['respect-rules'])),
    enhancedMode: choice(field(dns, 'enhanced-mode', defaults['enhanced-mode']), [
      'fake-ip',
      'redir-host',
      'normal'
    ]),
    fakeIPRange: string(field(dns, 'fake-ip-range', defaults['fake-ip-range'])),
    fakeIPFilter: strings(field(dns, 'fake-ip-filter', defaults['fake-ip-filter'])),
    fakeIPFilterMode: choice(field(dns, 'fake-ip-filter-mode', 'blacklist'), [
      'blacklist',
      'whitelist',
      'rule'
    ]),
    defaultNameserver: strings(field(dns, 'default-nameserver', defaults['default-nameserver'])),
    nameserver: strings(field(dns, 'nameserver', defaults.nameserver)),
    proxyServerNameserver: strings(
      field(dns, 'proxy-server-nameserver', defaults['proxy-server-nameserver'])
    ),
    directNameserver: strings(field(dns, 'direct-nameserver', defaults['direct-nameserver'])),
    fallback: strings(field(dns, 'fallback', defaults.fallback)),
    fallbackGeoip: boolean(field(filter, 'geoip', defaultFilter.geoip)),
    fallbackGeoipCode: string(field(filter, 'geoip-code', defaultFilter['geoip-code'])),
    fallbackIpcidr: strings(field(filter, 'ipcidr', defaultFilter.ipcidr)),
    fallbackDomain: strings(field(filter, 'domain', defaultFilter.domain)),
    nameserverPolicy: rows(field(dns, 'nameserver-policy', {}), 'DNS策略'),
    hosts: rows(field(document.controlled, 'hosts', {}), 'Hosts'),
    controlDns: document.controlDns ?? DEFAULT_CONTROL_DNS,
    useNameserverPolicy: document.useNameserverPolicy ?? DEFAULT_USE_NAMESERVER_POLICY,
    disableDnsOverrideGuard: document.disableDnsOverrideGuard ?? false
  }
}

// Pure projection only: the caller keeps the read revision and uses the existing
// relayConfigEditSave({ document, expectedRevision }) CAS. No fingerprint is made
// or changed here, and flags alone never create DNS/hosts bodies.
export function relayDnsDocument(
  base: ConfigurationEditDocument,
  draft: RelayDnsDraft,
  changes: RelayDnsChanges
): ConfigurationEditDocument {
  const next = configurationEditDocument(base)
  const allowed = ['dns', 'hosts', 'controlDns', 'useNameserverPolicy', 'disableDnsOverrideGuard']
  for (const [key, value] of Object.entries(map(changes, 'DNS修改范围'))) {
    if (!allowed.includes(key) || typeof value !== 'boolean') throw new Error('DNS修改范围无效。')
  }
  if (changes.dns) {
    const original = map(field(next.controlled, 'dns', {}), 'DNS设置')
    next.controlled.dns = {
      ...original,
      enable: boolean(draft.enable),
      ipv6: boolean(draft.ipv6),
      'use-hosts': boolean(draft.useHosts),
      'use-system-hosts': boolean(draft.useSystemHosts),
      'respect-rules': boolean(draft.respectRules),
      'enhanced-mode': choice(draft.enhancedMode, ['fake-ip', 'redir-host', 'normal']),
      'fake-ip-range': string(draft.fakeIPRange),
      'fake-ip-filter': strings(draft.fakeIPFilter),
      'fake-ip-filter-mode': choice(draft.fakeIPFilterMode, ['blacklist', 'whitelist', 'rule']),
      'default-nameserver': strings(draft.defaultNameserver),
      nameserver: strings(draft.nameserver),
      'proxy-server-nameserver': strings(draft.proxyServerNameserver),
      'direct-nameserver': strings(draft.directNameserver),
      fallback: strings(draft.fallback),
      'fallback-filter': {
        ...map(field(original, 'fallback-filter', {}), 'DNS回退过滤'),
        geoip: boolean(draft.fallbackGeoip),
        'geoip-code': string(draft.fallbackGeoipCode),
        ipcidr: strings(draft.fallbackIpcidr),
        domain: strings(draft.fallbackDomain)
      },
      'nameserver-policy': relayDnsPolicy(draft.nameserverPolicy)
    }
  }
  if (changes.hosts) next.controlled.hosts = rowMap(draft.hosts)
  if (changes.controlDns) next.controlDns = boolean(draft.controlDns)
  if (changes.useNameserverPolicy) next.useNameserverPolicy = boolean(draft.useNameserverPolicy)
  if (changes.disableDnsOverrideGuard)
    next.disableDnsOverrideGuard = boolean(draft.disableDnsOverrideGuard)
  return configurationEditDocument(next)
}
