import { isIP } from 'net'
import { inspectRuntimeConfiguration } from '../configuration/schema'
import { plainConfigurationMap as object } from '../profiles/document'

interface Prefix {
  address: { family: 'ipv4' | 'ipv6'; value: string }
  length: number
}
interface Range {
  bits: number
  value: bigint
  length: number
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value
function ip(value: string): { bits: number; value: bigint } {
  const family = isIP(value)
  if (!family || value.includes('%')) throw new Error('TUN地址必须是无zone的数字IP。')
  if (family === 4)
    return { bits: 32, value: value.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n) }
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1),
    [head, tail] = normalized.split('::'),
    left = head ? head.split(':') : [],
    right = tail ? tail.split(':') : [],
    words =
      tail === undefined
        ? left
        : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  return { bits: 128, value: words.reduce((n, word) => (n << 16n) | BigInt('0x' + word), 0n) }
}
function text(value: bigint, bits: number): string {
  if (bits === 32)
    return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join('.')
  const words = Array.from({ length: 8 }, (_, i) =>
    Number((value >> BigInt((7 - i) * 16)) & 65535n).toString(16)
  )
  // WHATWG canonical IPv6 serialization matches inet_ntop's compressed form.
  return new URL(`http://[${words.join(':')}]/`).hostname.slice(1, -1)
}
function range(raw: unknown, aligned: boolean): Range {
  if (typeof raw !== 'string') throw new Error('TUN路由／地址必须为CIDR。')
  const [address, suffix, extra] = raw.split('/'),
    parsed = ip(address),
    length = Number(suffix)
  if (
    extra !== undefined ||
    suffix === undefined ||
    !Number.isInteger(length) ||
    String(length) !== suffix ||
    length < 0 ||
    length > parsed.bits
  )
    throw new Error('TUN CIDR前缀无效。')
  const mask = ((1n << BigInt(parsed.bits)) - 1n) ^ ((1n << BigInt(parsed.bits - length)) - 1n)
  if (aligned && (parsed.value & mask) !== parsed.value)
    throw new Error('TUN路由必须为网络对齐的CIDR。')
  return { ...parsed, length }
}
function prefix(value: Range): Prefix {
  return {
    address: { family: value.bits === 32 ? 'ipv4' : 'ipv6', value: text(value.value, value.bits) },
    length: value.length
  }
}
function subtract(base: Range, excluded: Range): Range[] {
  if (base.bits !== excluded.bits) return [base]
  const size = 1n << BigInt(base.bits - base.length),
    end = base.value + size,
    otherEnd = excluded.value + (1n << BigInt(excluded.bits - excluded.length))
  if (otherEnd <= base.value || excluded.value >= end) return [base]
  if (excluded.value <= base.value && otherEnd >= end) return []
  const first = { ...base, length: base.length + 1 },
    second = { ...first, value: base.value + size / 2n }
  return [...subtract(first, excluded), ...subtract(second, excluded)]
}
function list(tun: Record<string, unknown>, key: string): string[] {
  const value = tun[key] ?? []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`TUN ${key}列表无效。`)
  return value as string[]
}

// The supplied-FD core skips Darwin create()/configureDNS(). Generate the
// equivalent bounded interface/routes/resolver intent for the root helper.
// Existing system routes are never replaced; /0 uses two more-specific halves.
export function projectTunNetwork(source: string): { projection: string; managedMTU: number } {
  const config = inspectRuntimeConfiguration(source).configuration
  if (!config || !object(config.tun) || config.tun.enable !== true)
    throw new Error('完整配置未启用TUN。')
  const tun = config.tun,
    dns = object(config.dns) ? config.dns : {},
    ipv6 = config.ipv6 !== false,
    managedMTU = Number(tun.mtu || 9000)
  if (!Number.isInteger(managedMTU) || managedMTU < 1280 || managedMTU > 65535)
    throw new Error('macOS TUN MTU须在1280到65535之间。')
  if (tun['auto-redirect'] === true)
    throw new Error('macOS不支持Linux auto-redirect；请调整完整候选后重新检查。')
  // Dynamic rule sets cannot be silently translated into an incomplete route
  // list. Explicit CIDRs are supported; unsupported intent is rejected early.
  for (const field of [
    'route-address-set',
    'route-exclude-address-set',
    'include-uid',
    'exclude-uid',
    'include-uid-range',
    'exclude-uid-range',
    'include-package',
    'exclude-package',
    'include-interface',
    'exclude-interface',
    'loopback-address'
  ])
    if (list(tun, field).length)
      throw new Error(`本次macOS权限后端尚不能完整实现 ${field}；未忽略该字段或启动。`)
  const v4 = range(
    typeof dns['fake-ip-range'] === 'string' ? dns['fake-ip-range'] : '198.18.0.1/16',
    false
  )
  if (v4.bits !== 32) throw new Error('DNS fake-ip-range必须为IPv4。')
  v4.length = 30
  const addresses = [
    v4,
    ...(ipv6
      ? (tun['inet6-address'] === undefined
          ? ['fdfe:dcba:9876::1/126']
          : list(tun, 'inet6-address')
        ).map((value) => range(value, false))
      : [])
  ]
  if (addresses.length > 16 || addresses.some((a, i) => i > 0 && a.bits !== 128))
    throw new Error('TUN接口地址族或数量无效。')
  const requested = [
      ...list(tun, 'route-address'),
      ...list(tun, 'inet4-route-address'),
      ...list(tun, 'inet6-route-address')
    ].map((value) => range(value, true)),
    excluded = [
      ...list(tun, 'route-exclude-address'),
      ...list(tun, 'inet4-route-exclude-address'),
      ...list(tun, 'inet6-route-exclude-address')
    ].map((value) => range(value, true))
  let routes: Range[] =
    tun['auto-route'] === true
      ? requested.length
        ? requested
        : [range('0.0.0.0/0', true), ...(ipv6 ? [range('::/0', true)] : [])]
      : []
  if (!ipv6 && routes.some((r) => r.bits === 128))
    throw new Error('IPv6已关闭但候选仍请求IPv6路由。')
  for (const excludedRange of excluded) {
    routes = routes.flatMap((r) => subtract(r, excludedRange))
    if (routes.length > 128) throw new Error('TUN排除路由展开超过受控上限128项。')
  }
  routes = routes.flatMap((r) =>
    r.length
      ? [r]
      : [
          { ...r, length: 1 },
          { ...r, length: 1, value: 1n << BigInt(r.bits - 1) }
        ]
  )
  const unique = [...new Map(routes.map((r) => [JSON.stringify(prefix(r)), r])).values()]
  const dnsMode = tun['dns-mode'] ?? 'disabled'
  if (!['disabled', 'hijack', 'native'].includes(String(dnsMode)))
    throw new Error('TUN DNS模式未受支持。')
  if (dnsMode !== 'disabled' && dns.enable !== true)
    throw new Error('启用TUN系统DNS协调需要完整配置明确启用DNS。')
  const resolver =
    dnsMode === 'disabled'
      ? null
      : {
          servers: addresses.map((r) => {
            const next = r.value + 1n,
              last =
                ((r.value >> BigInt(r.bits - r.length)) << BigInt(r.bits - r.length)) +
                (1n << BigInt(r.bits - r.length))
            if (next >= last) throw new Error('TUN地址没有可用的下一个DNS地址。')
            return { family: r.bits === 32 ? 'ipv4' : 'ipv6', value: text(next, r.bits) }
          }),
          matchDomains: [''],
          searchDomains: [],
          searchOrder: 1
        }
  const unroutedResolver = resolver?.servers.find((server) => {
    const target = ip(server.value)
    return !unique.some(
      (route) =>
        route.bits === target.bits &&
        target.value >= route.value &&
        target.value < route.value + (1n << BigInt(route.bits - route.length))
    )
  })
  if (unroutedResolver)
    throw new Error(
      `TUN系统DNS地址 ${unroutedResolver.value} 未被有效路由覆盖；请明确配置路由并检查排除项或auto-route。`
    )
  if (unique.length + (resolver ? 1 : 0) > 128) throw new Error('TUN网络效果超过128项受控上限。')
  const projection = JSON.stringify(
    canonical({
      version: 1,
      device: tun.device,
      mtu: managedMTU,
      addresses: addresses.map(prefix),
      routes: unique.map((r) => ({ destination: prefix(r), scoped: false })),
      resolver
    })
  )
  if (Buffer.byteLength(projection) > 16384) throw new Error('TUN网络计划超过16KiB上限。')
  return { projection, managedMTU }
}
