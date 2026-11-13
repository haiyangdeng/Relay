import { createHash } from 'crypto'
import data from './node-schema.json'

type Item = Record<string, unknown>
interface Schema {
  fields: Record<string, string>
  embedded: string[]
  source: string
}
const schemas: Record<string, Schema> = data.structs
const protocols: Record<string, string> = data.protocols
const object = (value: unknown): value is Item =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const supportedNodeTypes: readonly string[] = Object.keys(protocols)
const plugins: Readonly<Record<string, string>> = {
  obfs: 'simpleObfsOption',
  'v2ray-plugin': 'v2rayObfsOption',
  'gost-plugin': 'gostObfsOption',
  'shadow-tls': 'shadowTLSOption',
  restls: 'restlsOption',
  jls: 'jlsOption',
  kcptun: 'kcpTunOption'
}
const stateful = new Set(['tailscale', 'zerotier', 'easytier'])
const fields = new Map<string, Record<string, string>>()
function members(name: string): Record<string, string> {
  const found = fields.get(name)
  if (found) return found
  const schema = schemas[name]
  if (!schema) throw new Error('Unknown fixed schema')
  const result = Object.assign({}, ...schema.embedded.map(members), schema.fields)
  fields.set(name, result)
  return result
}
function conforms(type: string, value: unknown, depth = 0): boolean {
  if (depth > 30) return false
  if (value === null) return true // Upstream's weak decoder treats null as unset.
  if (type.startsWith('*')) return conforms(type.slice(1), value, depth + 1)
  if (type.startsWith('[]'))
    return type === '[]uint8' && typeof value === 'string'
      ? /^[A-Za-z0-9+/]*={0,2}$/u.test(value) &&
          Buffer.from(value, 'base64').toString('base64').replaceAll('=', '') ===
            value.replaceAll('=', '')
      : Array.isArray(value) &&
          value.length <= 10000 &&
          value.every((v) => conforms(type.slice(2), v, depth + 1))
  if (type.startsWith('map[string]'))
    return (
      object(value) && Object.values(value).every((v) => conforms(type.slice(11), v, depth + 1))
    )
  if (type === 'any' || type === 'interface{}') return true // Already bounded by analyzeProfile's plain JSON walk.
  if (type === 'string' || type === 'C.DNSPrefer')
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
  if (type === 'bool')
    return (
      typeof value === 'boolean' ||
      value === 0 ||
      (typeof value === 'number' && Number.isSafeInteger(value))
    )
  if (/^float\d+$/u.test(type))
    return (
      (typeof value === 'number' || (typeof value === 'string' && !!value.trim())) &&
      Number.isFinite(Number(value))
    )
  if (/^u?int\d*$/u.test(type)) {
    if (
      !(typeof value === 'number' && Number.isSafeInteger(value)) &&
      !(typeof value === 'string' && /^[+-]?\d+$/u.test(value))
    )
      return false
    try {
      const number = BigInt(value as string | number),
        bits = BigInt(type.match(/\d+/u)?.[0] ?? 64)
      const unsigned = type.startsWith('uint')
      return (
        number >= (unsigned ? 0n : -(1n << (bits - 1n))) &&
        number < 1n << (unsigned ? bits : bits - 1n)
      )
    } catch {
      return false
    }
  }
  if (!object(value) || !Object.hasOwn(schemas, type)) return false
  const allowed = members(type)
  return Object.entries(value).every(
    ([key, child]) => Object.hasOwn(allowed, key) && conforms(allowed[key], child, depth + 1)
  )
}
function privateState(name: unknown): string {
  return 'relay-node-state/' + createHash('sha256').update(String(name)).digest('hex')
}
function nodeFields(type: string): Record<string, string> {
  // Fixed Mihomo's TUIC parser ignores the common subscription `udp` flag;
  // TUIC enables UDP unconditionally. Preserve the flag as upstream does,
  // without treating unrelated unknown fields as supported options.
  return { ...members(protocols[type]), ...(type === 'tuic' ? { udp: 'bool' } : {}) }
}
const keyIdentity = (key: string): string => key.replaceAll('_', '-').toLowerCase()
function normalizeFields(allowed: Record<string, string>, value: Item): Item {
  const result: Item = {}
  for (const [key, child] of Object.entries(value)) {
    const canonical = Object.keys(allowed).find((k) => keyIdentity(k) === keyIdentity(key))
    if (!canonical || Object.hasOwn(result, canonical))
      throw new Error('Unknown or ambiguous node field')
    result[canonical] = normalizeType(allowed[canonical], child)
  }
  return result
}
function normalizeType(type: string, value: unknown): unknown {
  if (value === null) return value
  if (type.startsWith('*')) return normalizeType(type.slice(1), value)
  if (type.startsWith('[]') && Array.isArray(value))
    return value.map((v) => normalizeType(type.slice(2), v))
  if (type.startsWith('map[string]') && object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, normalizeType(type.slice(11), v)])
    )
  if (Object.hasOwn(schemas, type) && object(value)) return normalizeFields(members(type), value)
  return value
}
export function canonicalNode(node: Item): Item {
  if (typeof node.type !== 'string' || !Object.hasOwn(protocols, node.type))
    throw new Error('Unsupported node type')
  const result = normalizeFields(
    { ...nodeFields(node.type), type: 'string', icon: 'string', smux: 'SingMuxOption' },
    node
  )
  if (result.type === 'ss' && object(result['plugin-opts'])) {
    const plugin = typeof result.plugin === 'string' ? plugins[result.plugin] : undefined
    if (plugin) result['plugin-opts'] = normalizeFields(members(plugin), result['plugin-opts'])
  }
  if (result.type === 'snell' && object(result['obfs-opts'])) {
    const raw = result['obfs-opts'],
      mode = String(Object.entries(raw).find(([k]) => keyIdentity(k) === 'mode')?.[1] ?? '')
    const option =
      mode === 'shadow-tls'
        ? 'shadowTLSOption'
        : mode === 'restls'
          ? 'restlsOption'
          : mode === 'jls'
            ? 'jlsOption'
            : 'simpleObfsOption'
    result['obfs-opts'] = normalizeFields({ ...members(option), mode: 'string' }, raw)
  }
  return result
}
// File content is never read here. A later explicit resource-binding transaction
// can copy and rebase it; current projections block unknown external paths.
export function nodeDependencies(node: Item): string[] {
  try {
    node = canonicalNode(node)
  } catch {
    return []
  }
  const result: string[] = []
  const walk = (item: Item, prefix: string): void => {
    for (const [key, value] of Object.entries(item)) {
      const path = prefix ? prefix + '.' + key : key
      if (
        key === 'certificate' &&
        typeof value === 'string' &&
        value &&
        !value.trimStart().startsWith('-----BEGIN CERTIFICATE-----')
      )
        result.push(path)
      if (
        key === 'private-key' &&
        typeof value === 'string' &&
        value &&
        !(prefix === '' && ['wireguard', 'masque'].includes(String(node.type))) &&
        !/^-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/u.test(value.trimStart())
      )
        result.push(path)
      if (key === 'planet' && typeof value === 'string' && value) result.push(path)
      if (
        key === 'state-dir' &&
        typeof value === 'string' &&
        value &&
        value !== privateState(node.name)
      )
        result.push(path)
      if (
        typeof value === 'number' &&
        ['certificate', 'private-key', 'planet', 'state-dir'].includes(key)
      )
        result.push(path)
      if (['headers', 'ws-headers', 'peer-info'].includes(key)) continue
      if (object(value)) walk(value, path)
      else if (Array.isArray(value))
        value.forEach((v, index) => {
          if (object(v)) walk(v, path + '.' + index)
        })
    }
  }
  walk(node, '')
  return result
}
export function inspectNode(node: Item): { supported: boolean; requiresResources: boolean } {
  try {
    node = canonicalNode(node)
  } catch {
    return { supported: false, requiresResources: false }
  }
  if (typeof node.type !== 'string' || !Object.hasOwn(protocols, node.type))
    return { supported: false, requiresResources: false }
  const schema = nodeFields(node.type)
  const valid = Object.entries(node).every(([key, value]) => {
    if (key === 'type' || key === 'icon') return typeof value === 'string'
    if (key === 'smux') return conforms('SingMuxOption', value)
    if (key === 'plugin-opts' && node.type === 'ss') {
      const plugin = typeof node.plugin === 'string' ? plugins[node.plugin] : undefined
      return plugin ? conforms(plugin, value) : object(value) && !Object.keys(value).length
    }
    if (key === 'obfs-opts' && node.type === 'snell') {
      if (!object(value)) return false
      const mode = String(value.mode ?? '')
      const option =
        mode === 'shadow-tls'
          ? 'shadowTLSOption'
          : mode === 'restls'
            ? 'restlsOption'
            : mode === 'jls'
              ? 'jlsOption'
              : ['', 'http', 'tls'].includes(mode)
                ? 'simpleObfsOption'
                : undefined
      if (!option) return false
      return conforms(
        option,
        Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'mode'))
      )
    }
    return Object.hasOwn(schema, key) && conforms(schema[key], value)
  })
  const plugin =
    node.type !== 'ss' ||
    node.plugin === undefined ||
    node.plugin === '' ||
    (typeof node.plugin === 'string' && Object.hasOwn(plugins, node.plugin))
  const networks: Readonly<Record<string, readonly string[]>> = {
    vmess: ['', 'tcp', 'ws', 'http', 'h2', 'grpc', 'mkcp', 'kcp', 'mekya'],
    vless: ['', 'tcp', 'ws', 'http', 'h2', 'grpc', 'xhttp'],
    trojan: ['', 'tcp', 'ws', 'grpc']
  }
  const network =
    node.network === undefined ||
    !Object.hasOwn(networks, String(node.type)) ||
    networks[String(node.type)].includes(String(node.network))
  return {
    supported: valid && plugin && network,
    requiresResources: nodeDependencies(node).length > 0
  }
}
export function supportedNode(node: Item): boolean {
  const result = inspectNode(node)
  return result.supported && !result.requiresResources
}
export function projectNode(node: Item): Item {
  node = canonicalNode(node)
  // Runtime/check directories are private and ephemeral. Stateful protocols
  // must never derive a writable path from a display name containing slashes.
  return stateful.has(String(node.type)) ? { ...node, 'state-dir': privateState(node.name) } : node
}
