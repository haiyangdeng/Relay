import { stripProfileControls } from '../../../shared/relay/profiles'
import { SIMPLE_RULE_TYPES, ruleParts } from '../../../shared/simple-rules'
import { CONFIGURATION_BYTE_LIMIT, plainConfigurationMap as plain } from './document'
import { reservedProfileTargets } from './inspect'
import { supportedGroup } from './groups'
import { canonicalNode, inspectNode, projectNode } from './nodes'

type Item = Record<string, unknown>
type Collection = 'nodes' | 'groups'
function fail(): never {
  throw new Error('无法完整确认名称与引用；未生成改名副本。')
}
// This transaction supports independent JSON values only. The document parser
// deliberately preserves YAML identities; do not let cloning keep aliases
// across outbound declarations, references and opaque namespaces.
function independentJSON(source: Item): void {
  const seen = new Set<object>()
  let nodes = 0,
    bytes = 0
  const charge = (count: number): void => {
    bytes += count
    if (bytes > CONFIGURATION_BYTE_LIMIT) fail()
  }
  const walk = (value: unknown, depth: number): void => {
    if (++nodes > 50000 || depth > 40) fail()
    if (typeof value === 'string') charge(Buffer.byteLength(value) + 2)
    else if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      charge(String(value).length)
    else {
      if (
        (!plain(value) && !Array.isArray(value)) ||
        seen.has(value) ||
        Object.getOwnPropertySymbols(value).length ||
        (Array.isArray(value) &&
          (Object.getPrototypeOf(value) !== Array.prototype ||
            value.length > 50000 ||
            Object.keys(value).length !== value.length ||
            Object.keys(value).some((key, index) => key !== String(index))))
      )
        fail()
      seen.add(value)
      charge(2)
      for (const key of Object.getOwnPropertyNames(value)) {
        if (Array.isArray(value) && key === 'length') continue
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (
          ['__proto__', 'constructor', 'prototype'].includes(key) ||
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        )
          fail()
        charge(Buffer.byteLength(key) + 4)
        walk(descriptor.value, depth + 1)
      }
    }
  }
  // Charge raw UTF-8 first: after identity/depth/count validation, JSON escaping
  // can allocate at most six times this bound. The exact 2MiB limit follows.
  walk(source, 0)
}
const name = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value &&
  value === value.trim() &&
  value.length <= 256 &&
  value.isWellFormed() &&
  stripProfileControls(value) === value
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 8192 && stripProfileControls(value) === value
const list = (value: unknown, limit = 10000): unknown[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > limit) return fail()
  return value
}
const map = (value: unknown): Item => {
  if (value === undefined) return {}
  if (!plain(value)) return fail()
  return value
}
const records = (value: unknown, limit = 500): Item[] =>
  list(value, limit).map((item) => (plain(item) ? item : fail()))
const strings = (value: unknown): string[] =>
  list(value).map((item) => (name(item) ? item : fail()))
const canonicalKeys = (item: Item, fields: readonly string[]): void => {
  for (const key of Object.keys(item))
    if (fields.some((field) => key.replaceAll('_', '-').toLowerCase() === field && key !== field))
      fail()
}
const acyclic = (edges: Map<string, Set<string>>): void => {
  const visiting = new Set<string>(),
    done = new Set<string>()
  const visit = (current: string): void => {
    if (visiting.has(current)) fail()
    if (done.has(current)) return
    visiting.add(current)
    for (const target of edges.get(current) ?? []) if (edges.has(target)) visit(target)
    visiting.delete(current)
    done.add(current)
  }
  for (const current of edges.keys()) visit(current)
}

// Exact minimal adaptation of the existing Smart R2 template ruleTargetIndex
// (shared/relay/smart-override.ts:51), pinned to Mihomo ParseRulePayload.
// It intentionally does not import/run the name-generating Smart transform.
const ruleTargetIndex = (parts: string[]): number => {
  const type = parts[0].toUpperCase()
  if (parts.length < 2 || type === 'SUB-RULE') return -1
  if (type === 'MATCH') return 1
  if (
    ['NOT', 'OR', 'AND', 'DOMAIN-REGEX', 'PROCESS-NAME-REGEX', 'PROCESS-PATH-REGEX'].includes(type)
  )
    return parts.length >= 3 ? parts.length - 1 : -1
  return parts.length >= 3 ? 2 : -1
}
const replacePart = (raw: string, value: string): string =>
  raw.slice(0, raw.length - raw.trimStart().length) + value + raw.slice(raw.trimEnd().length)

function project(data: Item, before?: string, after?: string, overlayKind?: string): void {
  canonicalKeys(data, [
    'proxies',
    'proxy-groups',
    'proxy-providers',
    'rule-providers',
    'sub-rules',
    'rules',
    'dns',
    'listeners',
    'tunnels',
    'ntp'
  ])
  const nodes = records(data.proxies),
    groups = records(data['proxy-groups']),
    providers = map(data['proxy-providers']),
    ruleProviders = map(data['rule-providers']),
    subRules = map(data['sub-rules']),
    targets = new Map<string, Item>(),
    edges = new Map<string, Set<string>>(),
    subEdges = new Map<string, Set<string>>(),
    overlays = new Map<string, string[]>()
  const rewrite = (value: string): string =>
    before !== undefined && value === before ? (after ?? fail()) : value
  const reference = (value: unknown, source?: string): string => {
    if (!name(value)) return fail()
    const next = rewrite(value)
    if (!targets.has(next) && !reservedProfileTargets.has(next)) return fail()
    if (source) edges.get(source)?.add(next)
    return next
  }
  const field = (item: Item, key: string, source?: string): void => {
    canonicalKeys(item, [key])
    if (item[key] !== undefined && item[key] !== '') item[key] = reference(item[key], source)
  }
  const addOverlay = (item: Item): void => {
    if (['tailscale', 'easytier'].includes(String(item.type))) {
      const key = String(item.name)
      overlays.set(key, [...(overlays.get(key) ?? []), String(item.type)])
    }
  }
  for (const item of [...nodes, ...groups]) {
    if (
      !name(item.name) ||
      targets.has(item.name) ||
      reservedProfileTargets.has(item.name) ||
      Buffer.byteLength(JSON.stringify(item)) > 64 * 1024
    )
      fail()
    targets.set(item.name, item)
    edges.set(item.name, new Set())
  }
  for (const node of nodes) {
    if (!inspectNode(node).supported) fail()
    addOverlay(node)
  }
  for (const [key, provider] of Object.entries(providers)) {
    if (
      !name(key) ||
      !plain(provider) ||
      !['inline', 'http', 'file'].includes(String(provider.type))
    )
      fail()
    canonicalKeys(provider, [
      'proxy',
      'dialer-proxy',
      'payload',
      'override',
      'filter',
      'exclude-filter'
    ])
    if (provider.filter || provider['exclude-filter']) fail()
    if (provider.type === 'inline' && !list(provider.payload, 2000).length) fail()
    const override = map(provider.override)
    canonicalKeys(override, [
      'dialer-proxy',
      'additional-prefix',
      'additional-suffix',
      'proxy-name',
      'override-expr'
    ])
    if (
      override['additional-prefix'] ||
      override['additional-suffix'] ||
      list(override['proxy-name']).length ||
      list(override['override-expr']).length
    )
      fail()
    for (const node of records(provider.payload, 2000)) {
      if (!name(node.name) || !inspectNode(node).supported) fail()
      addOverlay(node)
    }
  }
  const dnsServer = (value: unknown, bound = false): string => {
    if (!text(value) || !value) return fail()
    const scheme = value.includes('://')
      ? value.slice(0, value.indexOf('://'))
      : value === 'system'
        ? 'system'
        : 'udp'
    if (
      ![
        'udp',
        'tcp',
        'tls',
        'http',
        'https',
        'quic',
        'system',
        'dhcp',
        'rcode',
        'ts',
        'tailscale',
        'et',
        'easytier'
      ].includes(scheme)
    )
      return fail()
    const hash = value.indexOf('#'),
      body = hash < 0 ? value : value.slice(0, hash),
      raw = hash < 0 ? '' : value.slice(hash + 1)
    if (['ts', 'tailscale', 'et', 'easytier'].includes(scheme)) {
      const start = value.indexOf('://') + 3,
        authority = body.slice(start).split(/[/?]/u)[0],
        kind = ['ts', 'tailscale'].includes(scheme) ? 'tailscale' : 'easytier'
      if (!authority || /[@%:[\]\\\s]/u.test(authority)) return fail()
      const next = overlayKind === kind ? rewrite(authority) : authority,
        matches = overlays.get(next) ?? []
      if (matches.length !== 1 || matches[0] !== kind) return fail()
      if (next !== authority) {
        if (/[/?#@%:[\]\\\s]/u.test(next)) return fail()
        return value.slice(0, start) + next + value.slice(start + authority.length)
      }
      return value
    }
    // Go url.Parse decodes the entire Fragment before splitting, last bare
    // token wins. URI clients with a bound WireGuard adapter ignore it.
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return fail()
    }
    if (bound || ['system', 'dhcp', 'rcode'].includes(scheme)) return value
    const bare = decoded.split('&').filter((part) => !part.includes('=')),
      selected = bare.at(-1) ?? ''
    if (!selected || selected === 'RULES') return value
    // renameProfileOutbound admits after only when it is absent from the
    // original global/built-in namespace. An existing effective selector equal
    // to it was an interface fallback; adding that global name would capture it.
    if (after !== undefined && selected === after) return fail()
    if (selected !== before) return value
    // Without encoded separators the byte span maps unambiguously. Keep all
    // parameter bytes; reject the ambiguous subset instead of reserializing it.
    if (/%(?:26|3d)/iu.test(raw) || !after || after === 'RULES' || /[&#=]/u.test(after))
      return fail()
    const parts = raw.split('&')
    let index = -1
    for (let i = 0; i < parts.length; i++)
      if (!decodeURIComponent(parts[i]).includes('=')) index = i
    if (index < 0) return fail()
    parts[index] = encodeURIComponent(after)
    return body + '#' + parts.join('&')
  }
  const nodeReferences = (node: Item, global = false): void => {
    const canonical = canonicalNode(node)
    for (const key of Object.keys(node))
      if (
        key.replaceAll('_', '-').toLowerCase() === 'dialer-proxy' &&
        node[key] !== undefined &&
        node[key] !== ''
      )
        node[key] = reference(node[key], global ? String(node.name) : undefined)
    if (node.type === 'wireguard') {
      const active = canonical['remote-dns-resolve']
      if (active !== undefined && typeof active !== 'boolean') fail()
      const key = Object.keys(node).find((key) => key.toLowerCase() === 'dns')
      if (key && active) node[key] = list(node[key]).map((server) => dnsServer(server, true))
    }
  }
  for (const node of nodes) nodeReferences(node, true)
  for (const provider of Object.values(providers)) {
    if (!plain(provider)) return fail()
    field(provider, 'proxy')
    field(provider, 'dialer-proxy')
    field(map(provider.override), 'dialer-proxy')
    for (const node of records(provider.payload, 2000)) nodeReferences(node)
  }
  for (const group of groups) {
    if (!supportedGroup(group, undefined, { allowASNDependency: true })) fail()
    if (
      group.filter ||
      group['exclude-filter'] ||
      group['policy-priority'] ||
      group['include-all'] ||
      group['include-all-proxies'] ||
      group['include-all-providers']
    )
      fail()
    const manual = strings(group.proxies),
      memberNames = new Set(manual),
      supplied = new Set<string>()
    if (memberNames.size !== manual.length) fail()
    for (const key of strings(group.use)) {
      const provider = providers[key]
      if (!plain(provider) || provider.type !== 'inline') return fail()
      for (const node of records(provider.payload, 2000)) {
        const name = String(node.name)
        if (memberNames.has(name) || supplied.has(name)) return fail()
        supplied.add(name)
      }
    }
    if (group['default-selected'] !== undefined && group['default-selected'] !== '') {
      const selected = group['default-selected']
      if (!name(selected) || (!memberNames.has(selected) && !supplied.has(selected))) return fail()
      if (memberNames.has(selected)) group['default-selected'] = rewrite(selected)
    }
    if (group.proxies !== undefined)
      group.proxies = manual.map((value) => reference(value, String(group.name)))
    field(group, 'empty-fallback', String(group.name))
    if (
      typeof group['empty-fallback'] === 'string' &&
      groups.some((item) => item.name === group['empty-fallback'])
    )
      fail()
  }
  const rule = (value: unknown, needTarget: boolean, source?: string, depth = 0): string => {
    if (!text(value) || !value.trim() || depth > 32) return fail()
    const raw = value.split(','),
      parts = raw.map((part) => part.replace(/^ +| +$/gu, '')),
      type = parts[0].toUpperCase()
    if (!SIMPLE_RULE_TYPES.includes(type)) return fail()
    let target = ruleTargetIndex(parts)
    if (type === 'SUB-RULE') target = parts.length - 1
    if (needTarget && (target < 1 || !name(parts[target]))) return fail()
    if (type === 'MATCH') {
      if (!needTarget || parts.length !== 2) return fail()
    } else if (['AND', 'OR', 'NOT', 'SUB-RULE'].includes(type)) {
      const payload = parts.slice(1, needTarget ? target : undefined).join(',')
      if (!payload.startsWith('(') || !payload.endsWith(')')) return fail()
      let level = 0
      for (const char of payload) {
        if (char === '(') level++
        if (char === ')') level--
        if (level < 0 || level > 32) fail()
      }
      if (level) return fail()
      if (['NOT', 'SUB-RULE'].includes(type)) rule(payload.slice(1, -1), false, source, depth + 1)
      else {
        const children = ruleParts(payload.slice(1, -1))
        if (children.length < 2) return fail()
        for (const child of children) {
          if (!child.startsWith('(') || !child.endsWith(')')) return fail()
          rule(child.slice(1, -1), false, source, depth + 1)
        }
      }
    } else {
      const regex = ['DOMAIN-REGEX', 'PROCESS-NAME-REGEX', 'PROCESS-PATH-REGEX'].includes(type)
      const payload = parts.slice(1, regex ? (needTarget ? target : undefined) : 2).join(',')
      if (!payload) return fail()
      if (
        !regex &&
        parts.slice(needTarget ? 3 : 2).some((option) => !['no-resolve', 'src'].includes(option))
      )
        return fail()
      if (type === 'RULE-SET' && !Object.hasOwn(ruleProviders, payload)) return fail()
    }
    if (needTarget) {
      if (type === 'SUB-RULE') {
        if (!Object.hasOwn(subRules, parts[target])) return fail()
        if (source) subEdges.get(source)?.add(parts[target])
      } else {
        const next = reference(parts[target])
        if (next.includes(',')) return fail()
        raw[target] = replacePart(raw[target], next)
      }
    }
    return raw.join(',')
  }
  for (const [key, provider] of Object.entries(ruleProviders)) {
    if (
      !name(key) ||
      !plain(provider) ||
      !['inline', 'http', 'file'].includes(String(provider.type)) ||
      !['domain', 'ipcidr', 'classical'].includes(String(provider.behavior))
    )
      return fail()
    canonicalKeys(provider, ['proxy', 'payload', 'override'])
    if (provider.override !== undefined) fail()
    field(provider, 'proxy')
    for (const value of list(provider.payload)) {
      if (!text(value) || !value) return fail()
      if (provider.behavior === 'classical') {
        if (['MATCH', 'RULE-SET', 'SUB-RULE'].includes(value.split(',')[0].trim().toUpperCase()))
          return fail()
        rule(value, false)
      }
    }
  }
  for (const key of Object.keys(subRules)) {
    if (!name(key)) fail()
    subEdges.set(key, new Set())
  }
  if (data.rules !== undefined) data.rules = list(data.rules).map((value) => rule(value, true))
  for (const [key, values] of Object.entries(subRules))
    subRules[key] = list(values).map((value) => rule(value, true, key))
  for (const listener of records(data.listeners)) {
    field(listener, 'proxy')
    canonicalKeys(listener, ['rule'])
    if (
      listener.rule !== undefined &&
      listener.rule !== '' &&
      (typeof listener.rule !== 'string' || !Object.hasOwn(subRules, listener.rule))
    )
      fail()
  }
  for (const tunnel of list(data.tunnels)) {
    if (typeof tunnel === 'string') continue
    if (!plain(tunnel)) return fail()
    field(tunnel, 'proxy')
  }
  if (data.tunnels !== undefined)
    data.tunnels = list(data.tunnels).map((value) => {
      if (typeof value !== 'string') return value
      const raw = value.split(','),
        parts = raw.map((part) => part.trim())
      if (
        ![3, 4].includes(parts.length) ||
        parts[0].split('/').some((part) => !['tcp', 'udp'].includes(part)) ||
        parts.slice(1, 3).some((part) => !/^(?:\[[^\]]+\]|[^:]+):[0-9]+$/u.test(part))
      )
        return fail()
      if (parts.length === 4 && parts[3]) raw[3] = replacePart(raw[3], reference(parts[3]))
      return raw.join(',')
    })
  field(map(data.ntp), 'dialer-proxy')
  const dns = map(data.dns)
  const slots = [
      'nameserver',
      'fallback',
      'default-nameserver',
      'proxy-server-nameserver',
      'direct-nameserver'
    ],
    policies = ['nameserver-policy', 'proxy-server-nameserver-policy']
  canonicalKeys(dns, [...slots, ...policies])
  for (const key of slots)
    if (dns[key] !== undefined) dns[key] = list(dns[key]).map((value) => dnsServer(value))
  for (const key of policies)
    for (const [selector, value] of Object.entries(map(dns[key]))) {
      const policy = map(dns[key])
      policy[selector] = Array.isArray(value)
        ? value.map((server) => dnsServer(server))
        : dnsServer(value)
    }
  acyclic(edges)
  acyclic(subEdges)
}

// Only detached, bounded parsed profile data enters here. No file, provider,
// Core, resolver, network or runtime lookup is part of this transaction.
export function renameProfileOutbound(
  source: Item,
  collection: Collection,
  originalName: string,
  newName: string
): Item {
  if (
    !name(originalName) ||
    !name(newName) ||
    originalName === newName ||
    reservedProfileTargets.has(newName)
  )
    return fail()
  if (!plain(source)) return fail()
  independentJSON(source)
  if (Buffer.byteLength(JSON.stringify(source)) > CONFIGURATION_BYTE_LIMIT) return fail()
  const validated = structuredClone(source)
  project(validated)
  const key = collection === 'groups' ? 'proxy-groups' : 'proxies',
    items = records(validated[key]),
    selected = items.find((item) => item.name === originalName)
  if (
    !selected ||
    [...records(validated.proxies), ...records(validated['proxy-groups'])].some(
      (item) => item.name === newName
    )
  )
    return fail()
  const overlayKind = collection === 'nodes' ? String(selected.type) : undefined
  selected.name = newName
  if (
    collection === 'nodes' &&
    ['tailscale', 'zerotier', 'easytier'].includes(String(selected.type))
  )
    items[items.indexOf(selected)] = projectNode(selected)
  validated[key] = items
  project(validated, originalName, newName, overlayKind)
  project(validated)
  if (Buffer.byteLength(JSON.stringify(validated)) > CONFIGURATION_BYTE_LIMIT) return fail()
  return validated
}
