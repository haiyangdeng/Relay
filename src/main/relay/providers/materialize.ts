import { analyzeProfile, PROFILE_BYTE_LIMIT } from '../profiles/inspect'
import { profileHash } from '../profiles/source'
import { providerName, type ProviderItem } from '../../../shared/relay/providers'
import { subscriptionRequest } from '../../../shared/relay/subscription'
import { providerHeaders } from '../subscriptions/transfer'
import { compileProfileRuntime } from '../profiles/runtime'

type Item = Record<string, unknown>
const object = (value: unknown): value is Item =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export interface ProviderDescriptor {
  item: ProviderItem
  url?: string
  headers?: Record<string, string>
  inline?: string
  definition: Item
  limit: number
}
export function resourceBinding(profileId: string, revision: string, name: string): string {
  return 'provider:' + profileId + ':' + profileHash(revision + '\0' + name)
}
export function providerDescriptors(text: string): {
  data: Item
  descriptors: ProviderDescriptor[]
} {
  const data = analyzeProfile(text).data
  if (!data || !object(data['proxy-providers'])) throw new Error('配置没有可读取的节点提供者。')
  const entries = Object.entries(data['proxy-providers'])
  if (!entries.length || entries.length > 64) throw new Error('提供者数量必须是1到64。')
  const descriptors = entries.map(([key, value]): ProviderDescriptor => {
    const name = providerName(key)
    if (!object(value)) throw new Error('提供者结构无效。')
    const kind = ['file', 'http', 'inline'].includes(String(value.type))
      ? (value.type as 'file' | 'http' | 'inline')
      : 'unsupported'
    const item: ProviderItem = { name, kind, canAcquire: false, issues: [], resources: [] }
    const result: ProviderDescriptor = { item, definition: value, limit: PROFILE_BYTE_LIMIT }
    try {
      if (value['size-limit'] !== undefined) {
        if (
          typeof value['size-limit'] !== 'number' ||
          !Number.isSafeInteger(value['size-limit']) ||
          value['size-limit'] < 0
        )
          throw new Error()
        if (value['size-limit'] > 0)
          result.limit = Math.min(PROFILE_BYTE_LIMIT, value['size-limit'])
      }
      if (kind === 'http') {
        const request = subscriptionRequest({ name: 'Provider', url: value.url, proxyPort: 18191 })
        result.url = request.url
        result.headers = providerHeaders(value.header)
        item.origin = new URL(request.url).origin
      } else if (kind === 'inline') {
        result.inline = JSON.stringify({ proxies: value.payload })
        item.nodes = parseProviderResource(result.inline).nodes.length
      } else if (kind === 'file') {
        if (typeof value.path !== 'string' || !value.path.trim()) throw new Error()
      } else throw new Error()
      item.canAcquire = true
    } catch {
      item.issues.push('提供者类型、地址、请求头或内联节点未通过当前受控检查。')
    }
    return result
  })
  return { data, descriptors }
}
export function parseProviderResource(text: string): { nodes: Item[] } {
  const data = analyzeProfile(text).data
  if (
    !data ||
    Object.keys(data).join(',') !== 'proxies' ||
    !Array.isArray(data.proxies) ||
    !data.proxies.length ||
    data.proxies.length > 2000 ||
    data.proxies.some((node) => !object(node))
  )
    throw new Error('资源必须是仅含proxies的YAML／JSON映射，节点1到2000个；未进行格式转换。')
  return { nodes: data.proxies as Item[] }
}
export function materializeProviders(
  source: string,
  resources: Record<string, string>
): { text: string; nodes: number } {
  const { data, descriptors } = providerDescriptors(source)
  if (
    descriptors.length !== Object.keys(resources).length ||
    descriptors.some((d) => !Object.hasOwn(resources, d.item.name))
  )
    throw new Error('必须逐项选择当前来源的全部提供者缓存。')
  const nodes: Item[] = Array.isArray(data.proxies) ? [...data.proxies] : []
  const provided = new Map<string, string[]>()
  const inline: Item = {}
  let bytes = 0
  for (const d of descriptors) {
    if (
      !d.item.canAcquire ||
      Object.keys(d.definition).some(
        (key) =>
          ![
            'type',
            'url',
            'path',
            'interval',
            'payload',
            'header',
            'proxy',
            'health-check',
            'filter',
            'exclude-filter',
            'exclude-type',
            'size-limit'
          ].includes(key)
      )
    )
      throw new Error('提供者含筛选、覆盖或其他未接入的变换，不能生成静态副本。')
    const text = resources[d.item.name]
    bytes += Buffer.byteLength(text)
    if (bytes > 4 * 1024 * 1024) throw new Error('缓存合计超过4MiB。')
    const parsed = parseProviderResource(text).nodes
    nodes.push(...parsed)
    inline[d.item.name] = {
      type: 'inline',
      payload: parsed,
      ...Object.fromEntries(
        Object.entries(d.definition).filter(([key]) =>
          ['filter', 'exclude-filter', 'exclude-type', 'health-check'].includes(key)
        )
      )
    }
    provided.set(
      d.item.name,
      parsed.map((node) => String(node.name))
    )
  }
  // Dynamic/provider filtering must run in the pinned core, retaining provider
  // boundaries. Flattening use into proxies changes upstream filter semantics.
  const originalGroups = Array.isArray(data['proxy-groups']) ? data['proxy-groups'] : []
  const advanced =
    descriptors.some((d) =>
      ['filter', 'exclude-filter', 'exclude-type', 'health-check'].some((k) =>
        Object.hasOwn(d.definition, k)
      )
    ) ||
    originalGroups.some(
      (g) =>
        !object(g) ||
        g.type !== 'select' ||
        Object.keys(g).some(
          (k) => !['name', 'type', 'proxies', 'use', 'hidden', 'icon'].includes(k)
        )
    )
  if (advanced) {
    const text = JSON.stringify({ ...data, 'proxy-providers': inline })
    if (Buffer.byteLength(text) > PROFILE_BYTE_LIMIT || !compileProfileRuntime(text).configuration)
      throw new Error('动态组副本的显式测速地址、节点冲突或支持字段未通过检查；未保存或近似筛选。')
    return { text, nodes: nodes.length }
  }
  const groups = (Array.isArray(data['proxy-groups']) ? data['proxy-groups'] : []).map((value) => {
    if (
      !object(value) ||
      value.type !== 'select' ||
      Object.keys(value).some(
        (key) => !['name', 'type', 'proxies', 'use', 'hidden', 'icon'].includes(key)
      )
    )
      throw new Error('静态副本目前只接受明确成员／use的select组，不替代动态组。')
    const group = { ...value },
      members = Array.isArray(group.proxies) ? [...group.proxies] : []
    if (Array.isArray(group.use))
      for (const name of group.use) {
        if (typeof name !== 'string' || !provided.has(name)) throw new Error('提供者引用无效。')
        members.push(...(provided.get(name) ?? []))
      }
    delete group.use
    group.proxies = members
    return group
  })
  const text = JSON.stringify({
    ...data,
    proxies: nodes,
    'proxy-groups': groups,
    'proxy-providers': {}
  })
  if (Buffer.byteLength(text) > PROFILE_BYTE_LIMIT || !analyzeProfile(text).data)
    throw new Error('静态副本存在名称冲突、引用错误或超过2MiB；未重命名、删减或保存。')
  return { text, nodes: nodes.length }
}
