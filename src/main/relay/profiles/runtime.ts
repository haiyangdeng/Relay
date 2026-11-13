import type { RelayProfileCatalogue } from '../../../shared/relay/runtime'
import { smartCollectorSizeMiB } from '../../../shared/relay/smart-settings'
import { stripProfileControls } from '../../../shared/relay/profiles'
import { isolatedCoreConfiguration } from '../core/configuration'
import { analyzeProfile, reservedProfileTargets, PROFILE_BYTE_LIMIT } from './inspect'
import { SMART_MODEL_CONTROLS, supportedGroup, supportedInlineProvider } from './groups'
import { supportedNode, inspectNode, projectNode } from './nodes'
import { supportedInlineRuleProvider } from './rule-providers'

type Item = Record<string, unknown>
const object = (value: unknown): value is Item =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
const items = (value: unknown): Item[] => (Array.isArray(value) ? value.filter(object) : [])

function catalogue(data: Item): RelayProfileCatalogue {
  const result: RelayProfileCatalogue = {
    nodes: [],
    groups: [],
    proxyProviders: [],
    ruleProviders: [],
    truncated: false
  }
  let remaining = 24576
  const take = (...values: string[]): boolean => {
    const size = values.reduce((total, value) => total + Buffer.byteLength(value), 0)
    if (size > remaining) {
      result.truncated = true
      return false
    }
    remaining -= size
    return true
  }
  const names = (values: string[], max = 20): string[] => {
    if (values.length > max) result.truncated = true
    return values.slice(0, max).filter((value) => take(value))
  }
  const nodes = items(data.proxies),
    groups = items(data['proxy-groups'])
  if (nodes.length > 100 || groups.length > 40) result.truncated = true
  for (const item of nodes.slice(0, 100))
    if (
      typeof item.name === 'string' &&
      typeof item.type === 'string' &&
      take(item.name, item.type)
    )
      result.nodes.push({ name: item.name, type: item.type })
  for (const item of groups.slice(0, 40)) {
    if (
      typeof item.name !== 'string' ||
      typeof item.type !== 'string' ||
      !take(item.name, item.type)
    )
      continue
    result.groups.push({
      name: item.name,
      type: item.type,
      members: names(strings(item.proxies)),
      providers: names(strings(item.use)),
      dynamic: !!(
        item['include-all'] ||
        item['include-all-proxies'] ||
        item['include-all-providers'] ||
        item.filter ||
        item['exclude-filter']
      )
    })
  }
  result.proxyProviders = names(
    Object.keys(object(data['proxy-providers']) ? data['proxy-providers'] : {}),
    50
  )
  result.ruleProviders = names(
    Object.keys(object(data['rule-providers']) ? data['rule-providers'] : {}),
    50
  )
  return result
}

// This is deliberately an isolated projection, never the eventual normal
// traffic config. Unknown/dependent node/group/rule options block the check;
// DNS, ports and other source settings remain untouched and unverified.
export interface ProfileRuntimeGeography {
  geoip: boolean
  geosite: boolean
}
export function compileProfileRuntime(
  text: string,
  geography?: ProfileRuntimeGeography
): {
  catalogue: RelayProfileCatalogue
  configuration?: string
  excluded: string[]
  issues: string[]
} {
  const analysis = analyzeProfile(text),
    data = analysis.data
  const empty: RelayProfileCatalogue = {
    nodes: [],
    groups: [],
    proxyProviders: [],
    ruleProviders: [],
    truncated: false
  }
  const excluded = [
    '仅检查隔离投影，不验证完整原配置或连接可用性。',
    '原DNS、hosts、TUN、端口、控制器及其余顶层选项不参与本次检查；原文保持不变。',
    '节点已知字段按固定核心结构保留；有状态协议只在本次私有临时目录使用派生状态子目录，完整持久身份迁移尚未完成。'
  ]
  if (!data) return { catalogue: empty, excluded, issues: analysis.inspection.issues }
  const view = catalogue(data),
    issues: string[] = []
  const nodes = items(data.proxies),
    groups = items(data['proxy-groups']),
    rules = strings(data.rules)
  let collectorSize: number | undefined
  if (object(data.profile) && Object.hasOwn(data.profile, 'smart-collector-size')) {
    try {
      collectorSize = smartCollectorSizeMiB(data.profile['smart-collector-size'])
      if (
        Object.entries(data.profile).some(
          ([key, value]) =>
            key !== 'smart-collector-size' &&
            (!['store-selected', 'store-fake-ip'].includes(key) || typeof value !== 'boolean')
        )
      )
        throw new Error()
    } catch {
      issues.push('Smart采样大小或profile字段无效，未忽略该设置后继续。')
    }
  }
  const providers = object(data['proxy-providers']) ? data['proxy-providers'] : {}
  const ruleProviders = object(data['rule-providers']) ? data['rule-providers'] : {}
  if (
    Object.values(providers).some(
      (provider) => !supportedInlineProvider(provider, supportedNode)
    ) ||
    Object.entries(ruleProviders).some(
      ([name, provider]) =>
        !name.trim() ||
        name !== name.trim() ||
        ['.', '..'].includes(name) ||
        name.length > 256 ||
        stripProfileControls(name) !== name ||
        /[,/\\]/u.test(name) ||
        !supportedInlineRuleProvider(provider)
    )
  )
    issues.push(
      '提供者仍含外部来源、未支持选项或非受控内联规则；先生成受控缓存副本，不交给核心下载。'
    )
  if (nodes.some((node) => !supportedNode(node)))
    issues.push(
      nodes.some((node) => inspectNode(node).requiresResources)
        ? '节点包含尚未绑定的证书／私钥文件、planet或状态目录依赖；未读取原路径，需显式资源映射。'
        : '节点协议、传输字段或结构未通过固定版本校验；没有忽略未知字段或删减节点后继续。'
    )
  if (
    groups.some((group) => {
      const use =
        group['include-all'] || group['include-all-providers']
          ? Object.keys(providers)
          : strings(group.use)
      const inherited = use
        .map((p) => providers[p])
        .filter(object)
        .map((p) => p['health-check'])
        .filter(object)
        .find((h) => typeof h.url === 'string' && h.url)?.url
      return !supportedGroup(group, inherited)
    })
  )
    issues.push(
      '代理组类型、字段或测速地址无效；自动健康检查需要显式HTTP(S)地址，不使用隐含公共地址。'
    )
  // Provider payload names are private inputs too. Reject collisions rather
  // than accepting the core map's silent replacement of a different node.
  const nodeNames = new Set([
    ...reservedProfileTargets,
    ...nodes.map((n) => String(n.name)),
    ...groups.map((g) => String(g.name))
  ])
  for (const provider of Object.values(providers)) {
    if (!object(provider) || !Array.isArray(provider.payload)) continue
    for (const node of provider.payload) {
      if (
        !object(node) ||
        typeof node.name !== 'string' ||
        !node.name.trim() ||
        node.name.length > 256 ||
        stripProfileControls(node.name) !== node.name ||
        nodeNames.has(node.name)
      ) {
        issues.push('提供者节点名称无效或冲突；没有重命名或覆盖节点。')
        break
      }
      nodeNames.add(node.name)
    }
  }
  const targets = new Set([
    ...reservedProfileTargets,
    ...nodes.map((node) => String(node.name)),
    ...groups.map((group) => String(group.name))
  ])
  const domains = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'])
  const cidrs = new Set(['IP-CIDR', 'IP-CIDR6'])
  if (
    rules.some((rule) => {
      const parts = rule.split(',').map((value) => value.trim()),
        type = parts[0]
      if (type === 'MATCH') return parts.length !== 2 || !targets.has(parts[1])
      if (type === 'GEOIP' || type === 'GEOSITE')
        return (
          !(type === 'GEOIP' ? geography?.geoip : geography?.geosite) ||
          !/^[a-zA-Z0-9_@!.-]{1,128}$/.test(parts[1] ?? '') ||
          !targets.has(parts[2]) ||
          (parts.length !== 3 &&
            !(type === 'GEOIP' && parts.length === 4 && parts[3] === 'no-resolve'))
        )
      if (type === 'RULE-SET')
        return (
          !Object.hasOwn(ruleProviders, parts[1]) ||
          !targets.has(parts[2]) ||
          (parts.length !== 3 && !(parts.length === 4 && parts[3] === 'no-resolve'))
        )
      if (type === 'PROCESS-NAME') return parts.length !== 3 || !parts[1] || !targets.has(parts[2])
      if (!domains.has(type) && !cidrs.has(type)) return true
      return (
        !parts[1] ||
        !targets.has(parts[2]) ||
        (parts.length !== 3 &&
          !(cidrs.has(type) && parts.length === 4 && parts[3] === 'no-resolve'))
      )
    })
  )
    issues.push(
      '存在未纳入离线检查的规则或无效目标；地理库／外部规则集／组合规则未自动下载或删减。'
    )
  if (issues.length) return { catalogue: view, excluded, issues }
  const configuration = JSON.stringify({
    ...isolatedCoreConfiguration(),
    ...(groups.some((group) => group.type === 'smart') ? SMART_MODEL_CONTROLS : {}),
    ...(collectorSize !== undefined
      ? {
          profile: {
            'store-selected': false,
            'store-fake-ip': false,
            'smart-collector-size': collectorSize
          }
        }
      : {}),
    proxies: nodes.map(projectNode),
    'proxy-groups': groups,
    'proxy-providers': Object.fromEntries(
      Object.entries(providers).map(([name, provider]) => [
        name,
        object(provider) && Array.isArray(provider.payload)
          ? {
              ...provider,
              payload: provider.payload.map((node) => (object(node) ? projectNode(node) : node))
            }
          : provider
      ])
    ),
    'rule-providers': ruleProviders,
    rules
  })
  if (Buffer.byteLength(configuration) > PROFILE_BYTE_LIMIT)
    return { catalogue: view, excluded, issues: ['隔离配置展开超过2MiB，未启动检查。'] }
  return {
    catalogue: view,
    excluded,
    issues,
    configuration
  }
}
