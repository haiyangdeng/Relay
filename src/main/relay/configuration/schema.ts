import { isIP } from 'net'
import { smartCollectorSizeMiB } from '../../../shared/relay/smart-settings'
import { inspectNode } from '../profiles/nodes'
import { plainConfigurationMap as object, readConfigurationMap } from '../profiles/document'
import { SMART_MODEL_CONTROLS, supportedGroup } from '../profiles/groups'
import schemaData from './config-schema.json'

type Item = Record<string, unknown>
type Family = keyof typeof schemaData.families
interface Schema {
  fields: Record<string, string>
  embedded: string[]
  source: string
}
const schemas: Record<Family, Record<string, Schema>> = schemaData.families
const listeners: Readonly<Record<string, string>> = schemaData.listeners
const groups: Readonly<Record<string, string>> = schemaData.groups
export const runtimeRootFields: readonly string[] = Object.keys(schemas.raw.RawConfig.fields)
export const runtimeListenerTypes: readonly string[] = Object.keys(listeners)
const fieldCache = new Map<string, Record<string, string>>()
function fields(family: Family, type: string): Record<string, string> {
  const key = family + ':' + type
  const cached = fieldCache.get(key)
  if (cached) return cached
  const schema = schemas[family][type]
  if (!schema) throw new Error('Fixed configuration schema missing')
  const result = Object.assign(
    {},
    ...schema.embedded.map((name) => fields(family, name)),
    schema.fields
  )
  fieldCache.set(key, result)
  return result
}
const identity = (key: string, family: Family): string =>
  family === 'inbound' ? key.replaceAll('_', '-').toLowerCase() : key.toLowerCase()
function structure(
  family: Family,
  type: string,
  value: unknown,
  depth: number,
  extra: Record<string, string> = {}
): unknown {
  if (!object(value) || depth > 40) throw new Error()
  const allowed = { ...fields(family, type), ...extra },
    result: Item = {}
  for (const [name, child] of Object.entries(value)) {
    // Raw YAML structs use exact YAML tags. Weakly decoded maps additionally
    // support EqualFold; listener maps also use the fixed '_' key replacer.
    const canonical =
      family === 'raw'
        ? Object.hasOwn(allowed, name)
          ? name
          : undefined
        : Object.keys(allowed).find((key) => identity(key, family) === identity(name, family))
    if (!canonical || Object.hasOwn(result, canonical)) throw new Error()
    result[canonical] = typed(family, allowed[canonical], child, depth + 1)
  }
  return result
}
function typed(family: Family, type: string, value: unknown, depth: number): unknown {
  if (depth > 40) throw new Error()
  if (value === null) return null
  if (type.startsWith('*')) return typed(family, type.slice(1), value, depth + 1)
  if (type.startsWith('[]')) {
    if (!Array.isArray(value)) throw new Error()
    return value.map((child) => typed(family, type.slice(2), child, depth + 1))
  }
  if (type.startsWith('map[string]')) {
    if (!object(value)) throw new Error()
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        typed(family, type.slice(11), child, depth + 1)
      ])
    )
  }
  // Smart462 extends this one RawProfile field. The pinned Stable schema and
  // all other profile keys keep their original strict field/type validation.
  if (type === 'SmartProfile') {
    const profile = structure('raw', 'RawProfile', value, depth, {
      'smart-collector-size': 'int'
    }) as Item
    if (Object.hasOwn(profile, 'smart-collector-size'))
      smartCollectorSizeMiB(profile['smart-collector-size'])
    return profile
  }
  if (Object.hasOwn(schemas[family], type)) return structure(family, type, value, depth)
  if (type === 'orderedmap.OrderedMap[string, any]') {
    if (!object(value)) throw new Error()
    return structuredClone(value)
  }
  if (type === 'LC.Tunnel')
    return typeof value === 'string' ? value : structure('raw', 'tunnel', value, depth)
  if (type === 'any') return structuredClone(value) // Bounded plain data, validated by its owning parser below.
  if (
    type === 'string' ||
    [
      'OverrideExpr',
      'regexp2.Regexp',
      'C.DNSMode',
      'C.FilterMode',
      'C.TUNStack',
      'T.TunnelMode',
      'log.LogLevel',
      'process.FindProcessMode'
    ].includes(type)
  ) {
    if (
      typeof value !== 'string' &&
      !(typeof value === 'number' && Number.isFinite(value) && type === 'string')
    )
      throw new Error()
    return value
  }
  if (type === 'bool') {
    if (
      typeof value !== 'boolean' &&
      !(family !== 'raw' && typeof value === 'number' && Number.isSafeInteger(value))
    )
      throw new Error()
    return value
  }
  if (/^u?int\d*$/u.test(type)) {
    if (
      !(typeof value === 'number' && Number.isSafeInteger(value)) &&
      !(family !== 'raw' && typeof value === 'string' && /^[+-]?\d+$/u.test(value))
    )
      throw new Error()
    const number = BigInt(value as number | string),
      bits = BigInt(type.match(/\d+/u)?.[0] ?? 64),
      unsigned = type.startsWith('uint')
    if (
      number < (unsigned ? 0n : -(1n << (bits - 1n))) ||
      number >= 1n << (unsigned ? bits : bits - 1n)
    )
      throw new Error()
    return value
  }
  if (type === 'netip.Addr' || type === 'netip.Prefix') {
    if (typeof value !== 'string') throw new Error()
    const [address, bits, ...rest] = value.split('/'),
      version = isIP(address)
    if (
      !version ||
      rest.length ||
      (type === 'netip.Addr'
        ? bits !== undefined
        : bits === undefined || !/^\d+$/u.test(bits) || Number(bits) > (version === 4 ? 32 : 128))
    )
      throw new Error()
    return value
  }
  throw new Error('Unresolved fixed field type')
}

// This validates the complete fixed-version document, without resetting ports,
// DNS, listeners or other top-level settings to an isolated projection. It does
// not read resources, initialize a core or claim connection/host acceptance.
export function inspectRuntimeConfiguration(source: string): {
  configuration?: Item
  issues: string[]
} {
  const parsed = readConfigurationMap(source)
  if (!parsed.data) return { issues: ['完整配置未通过有界解析。'] }
  const input = parsed.data
  try {
    const declaredGroups = input['proxy-groups']
    const smart =
      Array.isArray(declaredGroups) &&
      declaredGroups.some((group) => object(group) && group.type === 'smart')
    if (
      smart &&
      Object.entries(SMART_MODEL_CONTROLS).some(
        ([key, value]) => Object.hasOwn(input, key) && input[key] !== value
      )
    )
      throw new Error()
    const configuration = structure('raw', 'RawConfig', input, 0, {
      profile: 'SmartProfile',
      ...(smart ? { 'lgbm-auto-update': 'bool', 'lgbm-url': 'string' } : {})
    }) as Item
    if (smart) Object.assign(configuration, SMART_MODEL_CONTROLS)
    const nodes = (value: unknown): void => {
      if (value === undefined || value === null) return
      if (
        !Array.isArray(value) ||
        value.some((node) => !object(node) || !inspectNode(node).supported)
      )
        throw new Error()
    }
    nodes(configuration.proxies)
    for (const [field, type] of [
      ['proxy-providers', 'proxyProviderSchema'],
      ['rule-providers', 'ruleProviderSchema']
    ] as const) {
      const value = configuration[field]
      if (value === undefined || value === null) continue
      if (!object(value)) throw new Error()
      configuration[field] = Object.fromEntries(
        Object.entries(value).map(([name, provider]) => {
          const checked = structure('provider', type, provider, 0) as Item
          if (!['http', 'file', 'inline'].includes(String(checked.type))) throw new Error()
          if (field === 'proxy-providers') nodes(checked.payload)
          else if (
            !['domain', 'ipcidr', 'classical'].includes(String(checked.behavior)) ||
            (checked.format !== undefined &&
              !['yaml', 'text', 'mrs'].includes(String(checked.format)))
          )
            throw new Error()
          return [name, checked]
        })
      )
    }
    if (configuration['proxy-groups'] !== undefined && configuration['proxy-groups'] !== null) {
      if (!Array.isArray(configuration['proxy-groups'])) throw new Error()
      configuration['proxy-groups'] = configuration['proxy-groups'].map((group) => {
        if (object(group) && group.type === 'smart') {
          if (
            typeof group.name !== 'string' ||
            !group.name.trim() ||
            group.name.length > 256 ||
            !supportedGroup(group, undefined, { allowASNDependency: true })
          )
            throw new Error()
          return structuredClone(group)
        }
        if (!object(group) || typeof group.type !== 'string' || !Object.hasOwn(groups, group.type))
          throw new Error()
        return structure(
          'group',
          'GroupCommonOption',
          group,
          0,
          fields('group', groups[group.type])
        )
      })
    }
    if (configuration.listeners !== undefined && configuration.listeners !== null) {
      if (!Array.isArray(configuration.listeners)) throw new Error()
      configuration.listeners = configuration.listeners.map((listener) => {
        if (
          !object(listener) ||
          typeof listener.type !== 'string' ||
          !Object.hasOwn(listeners, listener.type)
        )
          throw new Error()
        return structure('inbound', listeners[listener.type], listener, 0, { type: 'string' })
      })
    }
    if (!readConfigurationMap(JSON.stringify(configuration)).data) throw new Error()
    return { configuration, issues: [] }
  } catch {
    return {
      issues: ['完整配置包含未知字段、冲突别名、类型错误或固定核心不支持的结构；未删减后继续。']
    }
  }
}
