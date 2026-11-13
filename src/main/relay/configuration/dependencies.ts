import { createHash } from 'crypto'
import { plainConfigurationMap as object } from '../profiles/document'
import { canonicalNode } from '../profiles/nodes'
import type { ResourceKind } from '../../../shared/relay/resources'
import { inspectRuntimeConfiguration } from './schema'

type Item = Record<string, unknown>
export interface RuntimeDependency {
  id: string
  kind: ResourceKind | 'proxy-provider' | 'state-directory' | 'ui-directory' | 'rule-bundle'
  target: string[]
  reference: string
  behavior?: 'domain' | 'ipcidr' | 'classical'
}
export const runtimeDependencyId = (kind: string, target: string[], reference: string): string =>
  createHash('sha256').update(JSON.stringify({ kind, target, reference })).digest('hex')

// References remain private main-process data. No original path, URL, external
// controller or directory is opened here. Public plans expose only ID and kind.
export function collectRuntimeDependencies(
  source: string,
  extraRules: readonly string[] = []
): { configuration: Item; dependencies: RuntimeDependency[] } {
  const result = inspectRuntimeConfiguration(source)
  if (!result.configuration) throw new Error('完整配置结构未通过。')
  const configuration = result.configuration,
    dependencies: RuntimeDependency[] = []
  const add = (
    kind: RuntimeDependency['kind'],
    target: string[],
    reference: string,
    behavior?: RuntimeDependency['behavior']
  ): void => {
    const id = runtimeDependencyId(kind, target, reference)
    if (dependencies.some((item) => item.id === id)) return
    if (dependencies.length >= 200) throw new Error('配置资源依赖超过200项。')
    dependencies.push({ id, kind, target, reference, ...(behavior ? { behavior } : {}) })
  }
  const pem = (value: string, kind: string): boolean =>
    kind === 'private-key'
      ? /^-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/u.test(value.trimStart())
      : value
          .trimStart()
          .startsWith(
            kind === 'ech-key' ? '-----BEGIN ECH KEYS-----' : '-----BEGIN CERTIFICATE-----'
          )
  const tls = (item: Item, path: string[], nodeType?: string): void => {
    for (const [key, value] of Object.entries(item)) {
      const at = [...path, key]
      if (['headers', 'ws-headers', 'peer-info', 'reality-opts', 'reality-config'].includes(key))
        continue
      if (
        ['certificate', 'private-key', 'client-auth-cert', 'ech-key'].includes(key) &&
        (typeof value === 'string' || typeof value === 'number') &&
        String(value) !== '' &&
        !(key === 'private-key' && nodeType && ['wireguard', 'masque'].includes(nodeType)) &&
        !pem(String(value), key)
      )
        add('runtime-file', at, String(value))
      if (object(value)) tls(value, at, nodeType)
      else if (Array.isArray(value))
        value.forEach((child, index) => {
          if (object(child)) tls(child, [...at, String(index)], nodeType)
        })
    }
  }
  const nodes = (value: unknown, path: string[]): unknown => {
    if (!Array.isArray(value)) return value
    return value.map((node, index) => {
      if (!object(node)) throw new Error()
      const checked = canonicalNode(node),
        at = [...path, String(index)],
        type = String(checked.type)
      tls(checked, at, type)
      if (
        type === 'zerotier' &&
        (typeof checked.planet === 'string' || typeof checked.planet === 'number') &&
        String(checked.planet) !== ''
      )
        add('runtime-file', [...at, 'planet'], String(checked.planet))
      if (['tailscale', 'zerotier', 'easytier'].includes(type))
        add('state-directory', [...at, 'state-dir'], String(checked['state-dir'] ?? ''))
      return checked
    })
  }
  configuration.proxies = nodes(configuration.proxies, ['proxies'])
  if (configuration.proxies === undefined) delete configuration.proxies
  for (const field of ['tls', 'tuic-server'])
    if (object(configuration[field])) tls(configuration[field], [field])
  if (Array.isArray(configuration.listeners))
    configuration.listeners.forEach((item, index) => {
      if (object(item)) tls(item, ['listeners', String(index)])
    })
  const proxyProviders = configuration['proxy-providers']
  if (object(proxyProviders))
    for (const [name, provider] of Object.entries(proxyProviders)) {
      if (!object(provider)) throw new Error()
      if (provider.type === 'inline') {
        provider.payload = nodes(provider.payload, ['proxy-providers', name, 'payload'])
        if (provider.payload === undefined) delete provider.payload
      } else add('proxy-provider', ['proxy-providers', name], JSON.stringify(provider))
    }
  const ruleProviders = configuration['rule-providers']
  if (object(ruleProviders))
    for (const [name, provider] of Object.entries(ruleProviders)) {
      if (!object(provider)) throw new Error()
      if (provider.type !== 'inline')
        add(
          `rule-${String(provider.format ?? 'yaml')}` as ResourceKind,
          ['rule-providers', name],
          JSON.stringify(provider),
          provider.behavior as RuntimeDependency['behavior']
        )
      if (provider['path-in-bundle'])
        add(
          'rule-bundle',
          ['rule-providers', name, 'path-in-bundle'],
          String(provider['path-in-bundle'])
        )
    }
  if (
    (typeof configuration['external-ui'] === 'string' ||
      typeof configuration['external-ui'] === 'number') &&
    String(configuration['external-ui']) !== ''
  )
    add('ui-directory', ['external-ui'], String(configuration['external-ui']))
  // Look only in rule-bearing fields and DNS selectors, never in passwords,
  // headers or arbitrary strings that happen to contain a geographic keyword.
  const rules: string[] = [...extraRules]
  const append = (value: unknown): void => {
    if (Array.isArray(value))
      for (const item of value) if (typeof item === 'string') rules.push(item)
  }
  append(configuration.rules)
  if (object(configuration['sub-rules'])) Object.values(configuration['sub-rules']).forEach(append)
  if (object(ruleProviders))
    for (const provider of Object.values(ruleProviders))
      if (object(provider) && provider.behavior === 'classical') append(provider.payload)
  const dns = configuration.dns
  const asn =
    rules.some((rule) => /\b(?:SRC-)?IP-ASN\s*,/u.test(rule.toUpperCase())) ||
    (Array.isArray(configuration['proxy-groups']) &&
      configuration['proxy-groups'].some(
        (group) => object(group) && group.type === 'smart' && group['prefer-asn'] === true
      ))
  let geoip = rules.some((rule) => /\b(?:SRC-)?GEOIP\s*,/u.test(rule.toUpperCase())),
    geosite = rules.some((rule) => /\bGEOSITE\s*,/u.test(rule.toUpperCase()))
  if (object(dns)) {
    for (const name of ['nameserver-policy', 'proxy-server-nameserver-policy'])
      if (object(dns[name]))
        for (const key of Object.keys(dns[name])) {
          if (key.startsWith('geosite:')) geosite = true
          if (key.startsWith('geoip:')) geoip = true
        }
    if (
      Array.isArray(dns['fake-ip-filter']) &&
      dns['fake-ip-filter'].some(
        (value) => typeof value === 'string' && value.startsWith('geosite:')
      )
    )
      geosite = true
    const fallback = dns['fallback-filter']
    if (object(fallback)) {
      if (Array.isArray(fallback.geosite) && fallback.geosite.length) geosite = true
      if (fallback.geoip !== false && Array.isArray(dns.fallback) && dns.fallback.length)
        geoip = true
    } else if (Array.isArray(dns.fallback) && dns.fallback.length) geoip = true // fixed default fallback-filter.geoip=true
  }
  if (geoip)
    add(
      configuration['geodata-mode'] === true ? 'geoip-dat' : 'country-mmdb',
      [],
      'fixed-geographic-database'
    )
  if (geosite) add('geosite-dat', [], 'fixed-geographic-database')
  if (asn) add('asn-mmdb', [], 'fixed-geographic-database')
  return { configuration, dependencies }
}
