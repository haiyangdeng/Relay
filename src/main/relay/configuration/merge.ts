import { createHash } from 'crypto'
import { isIP } from 'net'
import { DEFAULT_CONTROL_DNS, DEFAULT_CONTROL_SNIFF } from '../../../shared/appConfig'
import { readConfigurationMap, plainConfigurationMap as object } from '../profiles/document'

type Item = Record<string, unknown>
export interface RuntimeOverride {
  id: string
  kind: 'yaml' | 'js'
  content: string
  role?: 'normal' | 'smart'
}
export interface RuntimeRulePatch {
  prepend?: string[]
  append?: string[]
  delete?: string[]
}
export interface RuntimeMergeOptions {
  profileId: string
  source: string
  globalOverrides: RuntimeOverride[]
  profileOverrides: RuntimeOverride[]
  rulePatch?: RuntimeRulePatch
  profileRulePatch?: RuntimeRulePatch
  controlled: Item
  controlDns?: boolean
  controlSniff?: boolean
  useNameserverPolicy?: boolean
  disableDnsOverrideGuard?: boolean
  confirmedDnsFingerprint?: string
}
function checked(value: unknown): Item {
  let source: string
  try {
    source = JSON.stringify(value)
  } catch {
    throw new Error('配置不是有界JSON映射。')
  }
  const result = readConfigurationMap(source)
  if (!result.data) throw new Error('配置不是有界JSON映射。')
  return result.data
}
const key = (value: string): string => {
  if (['__proto__', 'prototype', 'constructor'].includes(value))
    throw new Error('覆写字段名称无效。')
  return value
}
const unwrap = (name: string): string =>
  name.startsWith('<') && name.endsWith('>') ? name.slice(1, -1) : name
// Match the fixed factory's ordinary replacement and YAML +list/list+ / map!
// semantics while rejecting type conflicts and dangerous normalized keys.
export function mergeConfiguration(target: Item, patch: Item, override = false): Item {
  const result = checked(target),
    other = checked(patch)
  const merge = (base: Item, overlay: Item): void => {
    for (const [name, value] of Object.entries(overlay)) {
      if (object(value)) {
        const replace = name.endsWith('!'),
          field = key(unwrap(replace ? name.slice(0, -1) : name))
        if (replace) {
          base[field] = structuredClone(value)
          continue
        }
        if (base[field] === undefined || base[field] === null) base[field] = {}
        if (!object(base[field])) throw new Error('覆写映射字段结构冲突。')
        merge(base[field], value)
      } else if (Array.isArray(value)) {
        const prepend = override && name.startsWith('+'),
          append = override && !prepend && name.endsWith('+')
        const field = key(unwrap(prepend ? name.slice(1) : append ? name.slice(0, -1) : name))
        if (prepend || append) {
          const prior = base[field] ?? []
          if (!Array.isArray(prior)) throw new Error('覆写列表字段结构冲突。')
          base[field] = structuredClone(prepend ? [...value, ...prior] : [...prior, ...value])
        } else base[field] = structuredClone(value)
      } else base[key(name)] = value
    }
  }
  merge(result, other)
  return checked(result)
}
function rules(profile: Item, patch?: RuntimeRulePatch): Item {
  if (!patch) return profile
  if (
    Object.keys(patch).some((k) => !['prepend', 'append', 'delete'].includes(k)) ||
    Object.values(patch).some((v) => !Array.isArray(v) || v.some((r) => typeof r !== 'string'))
  )
    throw new Error('规则覆写格式无效。')
  if (
    profile.rules !== undefined &&
    (!Array.isArray(profile.rules) || profile.rules.some((r) => typeof r !== 'string'))
  )
    throw new Error('原规则列表无效。')
  let result = Array.isArray(profile.rules) ? ([...profile.rules] as string[]) : []
  const insert = (entries: string[], append: boolean): void => {
    const normal: string[] = []
    for (const rule of entries) {
      const parts = rule.split(','),
        first = parts[0].trim()
      if (first && Number.isFinite(Number(first)) && parts.length >= 3) {
        if (!/^[+-]?\d+$/u.test(first) || !Number.isSafeInteger(Number(first)))
          throw new Error('规则位置必须是有界整数。')
        const offset = Number(first),
          position = append
            ? Math.max(0, result.length - Math.min(offset, result.length))
            : Math.min(offset, result.length)
        result.splice(position, 0, parts.slice(1).join(','))
      } else normal.push(rule)
    }
    result = append ? [...result, ...normal] : [...normal, ...result]
  }
  insert(patch.prepend ?? [], false)
  insert(patch.append ?? [], true)
  const deleted = new Set(patch.delete ?? [])
  return { ...profile, rules: result.filter((rule) => !deleted.has(rule)) }
}
function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value
}
export function protectedDnsFingerprint(profileId: string, profile: Item): string | undefined {
  const dns = profile.dns
  if (!object(dns)) return undefined
  const values = Object.fromEntries(
    ['proxy-server-nameserver', 'proxy-server-nameserver-policy', 'nameserver-policy']
      .filter((key) => {
        const value = dns[key]
        return typeof value === 'string'
          ? !!value.trim()
          : Array.isArray(value)
            ? !!value.length
            : object(value) && !!Object.keys(value).length
      })
      .map((key) => [key, dns[key]])
  )
  return Object.keys(values).length
    ? createHash('sha256')
        .update(JSON.stringify({ profileId, fields: canonical(values) }))
        .digest('hex')
    : undefined
}
export async function composeRuntimeConfiguration(
  input: RuntimeMergeOptions,
  script?: (script: string, configuration: Item) => Promise<{ configuration: Item; logs: string[] }>
): Promise<{
  configuration: Item
  order: string[]
  logs: { id: string; lines: string[] }[]
  dns: { requested: boolean; effective: boolean; autoDisabled: boolean; fingerprint?: string }
}> {
  if (
    typeof input.profileId !== 'string' ||
    !input.profileId ||
    input.profileId.length > 256 ||
    !Array.isArray(input.globalOverrides) ||
    !Array.isArray(input.profileOverrides) ||
    input.globalOverrides.length + input.profileOverrides.length > 200 ||
    (
      ['controlDns', 'controlSniff', 'useNameserverPolicy', 'disableDnsOverrideGuard'] as const
    ).some((key) => input[key] !== undefined && typeof input[key] !== 'boolean') ||
    (input.confirmedDnsFingerprint !== undefined &&
      !/^[a-f0-9]{64}$/u.test(input.confirmedDnsFingerprint))
  )
    throw new Error('运行配置选项无效。')
  const base = readConfigurationMap(input.source).data
  if (!base) throw new Error('来源配置未通过有界解析。')
  const controlled = checked(input.controlled)
  const ordered: RuntimeOverride[] = [],
    seen = new Map<string, RuntimeOverride>()
  for (const item of [...input.globalOverrides, ...input.profileOverrides]) {
    if (
      !item ||
      Object.keys(item).some((key) => !['id', 'kind', 'content', 'role'].includes(key)) ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 256 ||
      !['yaml', 'js'].includes(item.kind) ||
      typeof item.content !== 'string' ||
      Buffer.byteLength(item.content) > (item.kind === 'js' ? 65536 : 2097152) ||
      (item.role !== undefined && !['normal', 'smart'].includes(item.role))
    )
      throw new Error('覆写描述无效。')
    const previous = seen.get(item.id)
    if (previous) {
      if (
        previous.kind !== item.kind ||
        previous.content !== item.content ||
        previous.role !== item.role
      )
        throw new Error('相同覆写ID的内容或身份发生变化。')
      continue
    }
    seen.set(item.id, item)
    ordered.push(structuredClone(item))
  }
  const fingerprint = protectedDnsFingerprint(input.profileId, base),
    requested = input.controlDns ?? DEFAULT_CONTROL_DNS
  const autoDisabled =
    requested &&
    !!fingerprint &&
    !input.disableDnsOverrideGuard &&
    input.confirmedDnsFingerprint !== fingerprint
  const effective = requested && !autoDisabled,
    order: string[] = [],
    logs: { id: string; lines: string[] }[] = []
  let result = base
  const apply = async (item: RuntimeOverride): Promise<void> => {
    if (item.kind === 'yaml') {
      const patch = readConfigurationMap(item.content).data
      if (!patch) throw new Error('YAML覆写未通过有界解析。')
      result = mergeConfiguration(result, patch, true)
    } else {
      if (!script) throw new Error('JavaScript覆写需要受限原生工作进程；没有在主进程执行或跳过。')
      const output = await script(item.content, checked(result))
      if (
        !Array.isArray(output.logs) ||
        output.logs.length > 64 ||
        output.logs.some((line) => typeof line !== 'string' || line.length > 1024)
      )
        throw new Error('脚本日志格式无效。')
      result = checked(output.configuration)
      logs.push({ id: item.id, lines: [...output.logs] })
    }
    order.push(item.id)
  }
  for (const item of ordered.filter((i) => i.role !== 'smart' && i.id !== 'smart-core-override'))
    await apply(item)
  result = checked(rules(result, input.rulePatch))
  result = checked(rules(result, input.profileRulePatch))
  order.push('profile-rules')
  for (const item of ordered.filter((i) => i.role === 'smart' || i.id === 'smart-core-override'))
    await apply(item)
  if (!effective) {
    delete controlled.dns
    delete controlled.hosts
  }
  if (!(input.controlSniff ?? DEFAULT_CONTROL_SNIFF)) delete controlled.sniffer
  if (!input.useNameserverPolicy && object(controlled.dns))
    delete controlled.dns['nameserver-policy']
  result = mergeConfiguration(result, controlled)
  if (!effective && object(result.tun) && (!object(result.dns) || !result.dns.enable))
    result.tun = { ...result.tun, 'dns-hijack': [] }
  if (
    ordered.some((item) => item.role === 'smart' || item.id === 'smart-core-override') &&
    object(result.tun) &&
    result.tun.enable === true &&
    Array.isArray(result.proxies)
  ) {
    const entries = result.tun['route-exclude-address'] ?? []
    if (!Array.isArray(entries) || entries.some((value) => typeof value !== 'string'))
      throw new Error('TUN排除路由格式无效。')
    const addresses = entries as string[],
      existing = new Set(addresses.map((value) => value.trim().toLowerCase()))
    for (const proxy of result.proxies) {
      if (!object(proxy) || (typeof proxy.server !== 'string' && typeof proxy.server !== 'number'))
        continue
      const host = String(proxy.server)
          .trim()
          .replace(/^\[(.*)\]$/u, '$1')
          .toLowerCase(),
        version = isIP(host)
      if (!version) continue
      const cidr = `${host}/${version === 4 ? 32 : 128}`
      if (existing.has(host) || existing.has(cidr)) continue
      addresses.push(cidr)
      existing.add(cidr)
    }
    result.tun['route-exclude-address'] = addresses
  }
  if (Array.isArray(result['lan-allowed-ips']) && !result['lan-allowed-ips'].length)
    delete result['lan-allowed-ips']
  if (result['external-controller'] === '')
    for (const field of [
      'external-controller',
      'external-ui',
      'external-ui-url',
      'external-controller-cors'
    ])
      delete result[field]
  else if (result['external-ui'] === '')
    for (const field of ['external-ui', 'external-ui-url']) delete result[field]
  order.push('controlled-settings')
  return {
    configuration: checked(result),
    order,
    logs,
    dns: { requested, effective, autoDisabled, fingerprint }
  }
}
