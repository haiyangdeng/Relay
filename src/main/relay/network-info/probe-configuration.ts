import { isIP } from 'net'
import { isForbiddenHost } from '../../resolve/plugin/net-guard'
import { analyzeProfile, reservedProfileTargets } from '../profiles/inspect'
import { supportedNode, projectNode } from '../profiles/nodes'
import { isolatedCoreConfiguration } from '../core/configuration'
import { ownedCoreConfiguration } from '../core/owned-runtime'
import { profileHash } from '../profiles/source'
import type {
  IsolatedProbeRequest,
  IsolatedProbeTargets
} from '../../../shared/relay/isolated-probes'
import { probeMaxNodes } from '../../../shared/relay/isolated-probes'
export const isolatedProbeGroup = '__RELAY_ISOLATED_PROBE__'
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
function source(text: string) {
  const config = analyzeProfile(text).data
  if (!config || !Array.isArray(config.proxies) || !Array.isArray(config['proxy-groups']))
    throw new Error('保存配置中没有可读取的节点与组结构。')
  const nodes = new Map<string, Record<string, unknown>>(),
    groups = new Map<string, Record<string, unknown>>()
  for (const row of config.proxies)
    if (object(row) && typeof row.name === 'string') {
      if (nodes.has(row.name)) throw new Error('节点名称重复。')
      nodes.set(row.name, row)
    }
  for (const row of config['proxy-groups'])
    if (object(row) && typeof row.name === 'string') {
      if (groups.has(row.name) || nodes.has(row.name)) throw new Error('节点与组名称存在歧义。')
      groups.set(row.name, row)
    }
  return { nodes, groups, config }
}
export function isolatedProbeTargets(text: string): IsolatedProbeTargets {
  const data = source(text)
  return {
    nodes: [...data.nodes.keys()].slice(0, 100),
    groups: ['GLOBAL', ...data.groups.keys()].slice(0, 41)
  }
}
export function isolatedProbeConfiguration(
  text: string,
  request: Pick<IsolatedProbeRequest, 'target' | 'kind' | 'delay'>,
  port: number,
  pinnedHosts: Readonly<Record<string, string>> = {},
  unavailableServers: ReadonlySet<string> = new Set()
) {
  const data = source(text),
    selected: string[] = []
  const testingDelay = request.kind === 'nodeDelay' || request.kind === 'groupDelay'
  if (
    testingDelay &&
    data.config['unified-delay'] !== undefined &&
    typeof data.config['unified-delay'] !== 'boolean'
  )
    throw new Error('1-RTT延迟测试设置无效。')
  const builtins = new Set(['DIRECT', 'REJECT', 'COMPATIBLE'])
  const measurementLimit = request.delay ? probeMaxNodes + 44 : probeMaxNodes
  const delayTargets = new Map<string, string>()
  const failures = new Map<string, string>()
  const resolve = (name: string, stack = new Set<string>()): string => {
    if (builtins.has(name)) return name === 'COMPATIBLE' ? 'DIRECT' : name
    if (data.nodes.has(name)) return name
    if (stack.has(name) || stack.size >= 16) throw new Error('当前选中路径存在循环。')
    const group = data.groups.get(name)
    if (
      name !== 'GLOBAL' &&
      (!group || !['select', 'url-test', 'fallback'].includes(String(group.type)))
    )
      throw new Error('此组不能用单一选中节点表示延迟。')
    if (
      group &&
      ((Array.isArray(group.use) && group.use.length > 0) ||
        group['include-all'] ||
        group['include-all-proxies'] ||
        group['include-all-providers'] ||
        group.filter ||
        group['exclude-filter'] ||
        group['exclude-type'])
    )
      throw new Error('动态代理组不支持独立路径快照。')
    const member = request.delay?.selections[name]
    const members =
      name === 'GLOBAL'
        ? [...data.nodes.keys(), ...data.groups.keys(), ...builtins]
        : group?.proxies
    if (!member || !Array.isArray(members) || !members.includes(member))
      throw new Error('代理组当前选中路径未确认。')
    return resolve(member, new Set([...stack, name]))
  }
  const select = (name: string): void => {
    if (selected.includes(name)) return
    selected.push(name)
    if (selected.length > measurementLimit)
      throw new Error(`一次独立探测限1至${measurementLimit}项。`)
    try {
      delayTargets.set(name, resolve(name))
    } catch (error) {
      failures.set(name, error instanceof Error ? error.message : '选中路径未确认')
    }
  }
  const collect = (name: string, ancestors = new Set<string>()): void => {
    if (ancestors.has(name) || ancestors.size >= 16) throw new Error('静态组存在循环或依赖过深。')
    if (name !== 'GLOBAL' && reservedProfileTargets.has(name)) {
      if (testingDelay && request.delay && builtins.has(name)) select(name)
      return
    }
    if (data.nodes.has(name)) {
      select(name)
      return
    }
    const group = data.groups.get(name)
    if (
      !group ||
      !Array.isArray(group.proxies) ||
      (group.use !== undefined && (!Array.isArray(group.use) || group.use.length > 0)) ||
      group['include-all'] ||
      group['include-all-proxies'] ||
      group['include-all-providers'] ||
      group.filter ||
      group['exclude-filter'] ||
      group['exclude-type']
    )
      throw new Error('本次仅支持明确保存的静态节点及静态成员；不解析动态提供者。')
    if (testingDelay && request.delay) select(name)
    const next = new Set(ancestors)
    next.add(name)
    for (const node of group.proxies) {
      if (typeof node !== 'string') throw new Error('静态组成员无效。')
      collect(node, next)
    }
  }
  if (request.kind === 'groupDelay') {
    // Mihomo v1.19.33 config/config.go synthesizes GLOBAL from configured
    // outbounds. Its static leaf projection is every saved proxy, once; do not
    // admit DIRECT or resolve provider-dependent groups as new probe egress.
    if (request.target === 'GLOBAL') {
      for (const name of data.nodes.keys()) collect(name)
      if (request.delay) {
        select('GLOBAL')
        collect('DIRECT')
        collect('REJECT')
        for (const name of data.groups.keys()) select(name)
      }
    } else {
      if (!data.groups.has(request.target)) throw new Error('请选择保存的静态组。')
      collect(request.target)
    }
  } else {
    if (
      !data.nodes.has(request.target) &&
      !(
        testingDelay &&
        request.delay &&
        (builtins.has(request.target) ||
          data.groups.has(request.target) ||
          request.target === 'GLOBAL')
      )
    )
      throw new Error('请选择已保存的静态节点。')
    select(request.target)
  }
  if (!selected.length || selected.length > measurementLimit)
    throw new Error(`一次独立探测限1至${probeMaxNodes}个静态节点。`)
  const admitted = new Map<string, Record<string, unknown>>()
  let endpointFailure = false
  const add = (name: string, stack = new Set<string>()): void => {
    if (stack.has(name) || stack.size >= 16) throw new Error('节点拨号链循环或过深。')
    if (admitted.has(name)) return
    const original = data.nodes.get(name)
    if (!original) throw new Error('拨号链依赖必须是已保存的静态节点。')
    if (!supportedNode(original)) throw new Error('所选静态节点含未接入字段或外部文件依赖。')
    const node = projectNode(original),
      via = node['dialer-proxy']
    if (node['ip-version'] === 'ipv6' || (node.type === 'mieru' && isIP(String(node.server)) === 6))
      throw new Error('本次独立探测不提供该节点要求的IPv6解析。')
    if (typeof node.server === 'string' && unavailableServers.has(node.server)) {
      endpointFailure = true
      throw new Error('代理服务器地址不可用')
    }
    if (
      typeof node.server !== 'string' ||
      isForbiddenHost(node.server) ||
      (!isIP(node.server) &&
        (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(node.server) ||
          node.server.includes('..') ||
          node.server.length > 253))
    )
      throw new Error('独立探测不访问本机或私网代理，域名须是规范ASCII。')

    if (
      ![
        'ss',
        'ssr',
        'vmess',
        'vless',
        'trojan',
        'socks5',
        'http',
        'snell',
        'hysteria',
        'hysteria2',
        'tuic',
        'anytls',
        'mieru'
      ].includes(String(node.type))
    )
      throw new Error('独立探测暂不运行可能依赖接口或持久身份的出站协议。')
    const ech = object(node['ech-opts']) ? node['ech-opts'] : undefined,
      realm = object(node['realm-opts']) ? node['realm-opts'] : undefined
    if (
      (node.ip !== undefined && node.ip !== null && String(node.ip) !== '') ||
      (node['interface-name'] !== undefined &&
        node['interface-name'] !== null &&
        String(node['interface-name']) !== '') ||
      (node['routing-mark'] !== undefined && Number(node['routing-mark']) !== 0) ||
      (ech?.enable && !ech.config) ||
      realm?.enable ||
      ['shadow-tls-opts', 'restls-opts', 'jls-opts'].some(
        (key) => object(node[key]) && Object.keys(node[key]).length > 0
      )
    )
      throw new Error('本次独立探测不使用额外IP覆盖、接口绑定、动态ECH、Realm发现或高级安全插件。')
    if (
      (node.plugin &&
        !(
          node.type === 'ss' &&
          node.plugin === 'obfs' &&
          object(node['plugin-opts']) &&
          ['http', 'tls'].includes(String(node['plugin-opts'].mode))
        )) ||
      (['vmess', 'vless', 'trojan'].includes(String(node.type)) &&
        node.network !== undefined &&
        !['', 'tcp', 'ws', 'http', 'h2', 'grpc'].includes(String(node.network))) ||
      (node.type === 'snell' &&
        node['obfs-opts'] &&
        typeof node['obfs-opts'] === 'object' &&
        !['', 'http', 'tls'].includes(
          String((node['obfs-opts'] as Record<string, unknown>).mode ?? '')
        ))
    )
      throw new Error('本次独立探测不使用插件或额外端点传输。')
    admitted.set(name, node)
    if (via === 'DIRECT') delete node['dialer-proxy']
    else if (via !== undefined) {
      if (typeof via !== 'string') throw new Error('拨号链无效。')
      const next = new Set(stack)
      next.add(name)
      add(via, next)
    }
    if (admitted.size > probeMaxNodes) throw new Error('独立节点及拨号链超过100项。')
  }
  for (const name of selected) {
    if (failures.has(name)) continue
    const target = delayTargets.get(name)
    if (!target) {
      failures.set(name, '当前测速路径未确认。')
      continue
    }
    if (builtins.has(target)) continue
    const previous = new Map(admitted)
    endpointFailure = false
    try {
      add(target)
    } catch (error) {
      if (request.kind !== 'groupDelay') throw error
      admitted.clear()
      previous.forEach((node, name) => admitted.set(name, node))
      failures.set(name, endpointFailure ? '代理服务器地址不可用' : '节点配置不支持独立测速')
    }
  }
  const runnableNodes = selected.filter((name) => !failures.has(name))
  if (admitted.has(isolatedProbeGroup)) throw new Error('节点名与独立探测保留名称冲突。')
  const config = {
    ...isolatedCoreConfiguration('rule'),
    port,
    ...(testingDelay ? { 'unified-delay': data.config['unified-delay'] === true } : {}),
    hosts: Object.fromEntries(Object.entries(pinnedHosts).sort(([a], [b]) => a.localeCompare(b))),
    proxies: [...admitted.values()],
    // Delay uses only the per-outbound controller API. Its HTTP listener must
    // never expose DIRECT or an unrelated default egress.
    'proxy-groups': [
      {
        name: isolatedProbeGroup,
        type: 'select',
        proxies: testingDelay ? ['REJECT'] : runnableNodes
      }
    ],
    rules: [`MATCH,${isolatedProbeGroup}`]
  }
  const configuration = JSON.stringify(config)
  if (runnableNodes.length)
    ownedCoreConfiguration(configuration, 'localProxy', undefined, pinnedHosts)
  return {
    configuration,
    sha256: profileHash(JSON.stringify({ ...config, port: 0, hosts: {}, failures: [...failures] })),
    servers: [...new Set([...admitted.values()].map((row) => row.server as string))],
    nodes: selected,
    delayTargets,
    runnableNodes,
    failures
  }
}
