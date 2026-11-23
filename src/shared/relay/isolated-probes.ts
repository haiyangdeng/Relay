import { profileSelection, type RelayProfileSelection } from './runtime'
import { healthURL } from './health'
import { stripProfileControls } from './profiles'
// Match the fixed Clash Party v2.0.4 default for node/group delay.
export const probeDelayURL = 'https://www.gstatic.com/generate_204'
export const probeMaxNodes = 100
export const probeMaxGroupMembers = probeMaxNodes + 44
export const probeConcurrency = 5
export const probeDelayBuiltins: ReadonlySet<string> = new Set(['DIRECT', 'REJECT', 'COMPATIBLE'])
export const probeIPProviders = ['ip.sb', 'ipwho.is', 'ipapi.is'] as const
export type ProbeIPProvider = (typeof probeIPProviders)[number]
export const probeLatencyTargets = ['Google', 'Cloudflare', 'GitHub'] as const
export type ProbeLatencyTarget = (typeof probeLatencyTargets)[number]
export const probeEndpoints = Object.freeze({
  'ip.sb': 'https://api.ip.sb/geoip',
  'ipwho.is': 'https://ipwho.is/',
  'ipapi.is': 'https://api.ipapi.is/',
  Google: 'https://www.google.com/generate_204',
  Cloudflare: 'https://www.cloudflare.com/cdn-cgi/trace',
  GitHub: 'https://github.com/'
})
export interface IsolatedProbeDelay {
  url: string
  timeout: number
  selections: Record<string, string>
  members?: string[]
}
export interface IsolatedProbeRequest {
  profile: RelayProfileSelection
  target: string
  kind: 'ip' | 'latency' | 'nodeDelay' | 'groupDelay'
  provider: ProbeIPProvider
  delay?: IsolatedProbeDelay
}
export interface IsolatedProbeTargets {
  nodes: string[]
  groups: string[]
}
export interface IsolatedProbePlan {
  evidenceId: string
  name: string
  kind: IsolatedProbeRequest['kind']
  nodes: string[]
  origins: string[]
  sourceSHA256: string
  configurationSHA256: string
}
export interface IsolatedProbeIP {
  ip: string
  country?: string
  countryCode?: string
  asn?: string
  latitude?: number
  longitude?: number
  city?: string
  region?: string
  organization?: string
}
export interface IsolatedProbeResult {
  status: 'completed' | 'cancelled'
  kind: IsolatedProbeRequest['kind']
  ip?: IsolatedProbeIP
  measurements: { name: string; milliseconds: number | null; error?: string }[]
  isolated: true
}
export function probeMeasurementSummary(result: IsolatedProbeResult): string {
  if (result.status === 'cancelled') return '已取消测速。'
  const unavailable = result.measurements.filter((item) => item.error).length
  const passed = result.measurements.filter(
    (item) => !item.error && item.milliseconds !== null
  ).length
  const timedOut = result.measurements.length - passed - unavailable
  if (!passed && !timedOut && unavailable)
    return '未能测速：节点配置或代理地址不支持本次探测，请查看各节点原因。'
  if (!passed && !unavailable)
    return '未取得延迟：节点到测试站点的连接超时或失败，请检查节点或稍后重试。'
  if (!timedOut && !unavailable) return '测速完成；结果来自独立探测，未改变当前节点。'
  return `测速结束：${[
    `${passed} 项成功`,
    ...(timedOut ? [`${timedOut} 项超时`] : []),
    ...(unavailable ? [`${unavailable} 项无法测试`] : [])
  ].join('、')}。`
}
export interface IsolatedProbeState {
  pending: boolean
  uncertain: boolean
  canCleanup: boolean
  preparedId?: string
  warning?: string
}
export const isolatedProbeChannels = [
  'relayIsolatedProbeTargets',
  'relayIsolatedProbePrepare',
  'relayIsolatedProbeRun',
  'relayIsolatedProbeCancel',
  'relayIsolatedProbeCleanup',
  'relayIsolatedProbeState'
] as const
export function isolatedProbeRequest(input: unknown): IsolatedProbeRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('独立探测选择无效。')
  const raw = input as Record<string, unknown>
  if (
    !['kind,profile,provider,target', 'delay,kind,profile,provider,target'].includes(
      Object.keys(raw).sort().join(',')
    ) ||
    !['ip', 'latency', 'nodeDelay', 'groupDelay'].includes(String(raw.kind)) ||
    !probeIPProviders.includes(raw.provider as ProbeIPProvider) ||
    typeof raw.target !== 'string' ||
    !probeName(raw.target)
  )
    throw new Error('独立探测参数无效。')
  let delay: IsolatedProbeDelay | undefined
  if (Object.hasOwn(raw, 'delay')) {
    if (
      !['nodeDelay', 'groupDelay'].includes(String(raw.kind)) ||
      !raw.delay ||
      typeof raw.delay !== 'object' ||
      Array.isArray(raw.delay)
    )
      throw new Error('独立测速参数无效。')
    const value = raw.delay as Record<string, unknown>
    if (
      !['selections,timeout,url', 'members,selections,timeout,url'].includes(
        Object.keys(value).sort().join(',')
      ) ||
      !Number.isInteger(value.timeout) ||
      Number(value.timeout) < 1000 ||
      Number(value.timeout) > 10000 ||
      !value.selections ||
      typeof value.selections !== 'object' ||
      Array.isArray(value.selections)
    )
      throw new Error('独立测速参数无效。')
    const url = healthURL(value.url),
      hostname = new URL(url).hostname,
      selections = Object.entries(value.selections)
    // Address/public-network admission remains Main's responsibility. Reject
    // malformed hostnames here without introducing a browser DNS lookup.
    if (
      hostname.length > 253 ||
      !(
        /^\[[a-f0-9:]+\]$/iu.test(hostname) ||
        hostname
          .replace(/\.$/u, '')
          .split('.')
          .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))
      ) ||
      selections.length > 100 ||
      selections.some(([name, member]) => !probeName(name) || !probeName(member))
    )
      throw new Error('独立测速目标或组选项无效。')
    const members = value.members
    if (Array.isArray(members) && members.length > probeMaxGroupMembers)
      throw new Error(`该组超过一次测速的 ${probeMaxGroupMembers} 个直属成员上限。`)
    if (
      'members' in value &&
      (raw.kind !== 'groupDelay' ||
        !Array.isArray(members) ||
        !members.length ||
        !members.every(probeName) ||
        new Set(members).size !== members.length)
    )
      throw new Error('组测速成员无效。')
    delay = {
      url,
      timeout: Number(value.timeout),
      selections: Object.fromEntries(selections),
      ...(Array.isArray(members) ? { members: [...members] } : {})
    }
  }
  return {
    profile: profileSelection(raw.profile),
    target: raw.target,
    kind: raw.kind as IsolatedProbeRequest['kind'],
    provider: raw.provider as ProbeIPProvider,
    ...(delay ? { delay } : {})
  }
}
function probeName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !!value.trim() &&
    value.length <= 256 &&
    stripProfileControls(value) === value
  )
}
export function isolatedProbeEvidence(input: unknown): string {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).join(',') !== 'evidenceId'
  )
    throw new Error('独立探测凭据无效。')
  const id = (input as Record<string, unknown>).evidenceId
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))
    throw new Error('独立探测凭据无效。')
  return id
}
