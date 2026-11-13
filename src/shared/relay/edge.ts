export const edgePolicyKeys = [
  'DnsOverHttpsMode',
  'NetworkPredictionOptions',
  'ProxySettings',
  'WebRtcLocalhostIpHandling'
] as const
export const edgeAdditionalKeys = [
  'ProxyMode',
  'ProxyServer',
  'ProxyPacUrl',
  'ProxyBypassList',
  'WebRtcIPHandlingUrl',
  'WebRtcLocalIpsAllowedUrls',
  'DnsOverHttpsTemplates'
] as const
export interface RelayEdgeInspection {
  version: 1
  readOnly: true
  runtimeVerified: false
  policySource: 'unconfirmed'
  manualReviewRequired: true
  edgeInstalled: boolean
  policies: { key: string; forced: boolean; matches: boolean; valid: boolean }[]
  reviewKeys: string[]
  status: 'configured' | 'needsInstall' | 'blocked'
  canOpenProfile: boolean
  revision: string
  warnings: string[]
}
export interface RelayEdgePreparation extends RelayEdgeInspection {
  evidenceId: string
}
export type RelayEdgeAction = 'deviceManagement' | 'edgePolicy'
export interface RelayEdgeOpenResult {
  status: 'requested'
  action: RelayEdgeAction | 'openProfile'
  installed: false
  warnings: string[]
}
export type RelayEdgeApplyResult =
  RelayEdgeOpenResult | { status: 'cancelled' | 'uncertain'; installed: false; warnings: string[] }
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Edge 消息格式异常。')
  return raw as Record<string, unknown>
}
export function validateEdgeReviewKeys(raw: unknown): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length > edgeAdditionalKeys.length ||
    new Set(raw).size !== raw.length ||
    raw.some((key) => typeof key !== 'string' || !edgeAdditionalKeys.some((item) => item === key))
  )
    throw new Error('Edge 附加策略检查无效。')
  return [...raw].sort()
}
function warnings(raw: unknown): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length > 16 ||
    raw.some((item) => typeof item !== 'string' || item.length > 2048)
  )
    throw new Error('Edge 说明格式异常。')
  return raw
}
export function validateEdgeInspection(raw: unknown): RelayEdgeInspection {
  const value = object(raw)
  if (
    value.version !== 1 ||
    value.readOnly !== true ||
    value.runtimeVerified !== false ||
    value.policySource !== 'unconfirmed' ||
    value.manualReviewRequired !== true ||
    typeof value.edgeInstalled !== 'boolean' ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.revision) ||
    !Array.isArray(value.policies) ||
    value.policies.length !== 4
  )
    throw new Error('Edge 检查不完整或包含未确认结论。')
  const policies = value.policies.map((rawPolicy) => {
    const policy = object(rawPolicy)
    if (
      !edgePolicyKeys.some((key) => key === policy.key) ||
      typeof policy.forced !== 'boolean' ||
      typeof policy.matches !== 'boolean' ||
      policy.valid !== (policy.forced && policy.matches)
    )
      throw new Error('Edge 基础策略结论无效。')
    return {
      key: String(policy.key),
      forced: policy.forced,
      matches: policy.matches,
      valid: policy.forced && policy.matches
    }
  })
  if (new Set(policies.map((policy) => policy.key)).size !== 4) throw new Error('Edge 策略重复。')
  const reviewKeys = validateEdgeReviewKeys(value.reviewKeys)
  const status =
    reviewKeys.length || !value.edgeInstalled
      ? 'blocked'
      : policies.every((policy) => policy.valid)
        ? 'configured'
        : policies.some((policy) => policy.forced)
          ? 'blocked'
          : 'needsInstall'
  if (value.status !== status || value.canOpenProfile !== (status === 'needsInstall'))
    throw new Error('Edge 安装条件与证据不一致。')
  return {
    version: 1,
    readOnly: true,
    runtimeVerified: false,
    policySource: 'unconfirmed',
    manualReviewRequired: true,
    edgeInstalled: value.edgeInstalled,
    policies,
    reviewKeys,
    status,
    canOpenProfile: status === 'needsInstall',
    revision: value.revision,
    warnings: warnings(value.warnings)
  }
}
export function validateEdgeAction(raw: unknown): RelayEdgeAction {
  const value = object(raw)
  if (
    Object.keys(value).length !== 1 ||
    (value.action !== 'deviceManagement' && value.action !== 'edgePolicy')
  )
    throw new Error('只接受固定设备管理或 Edge 策略入口。')
  return value.action
}
export function validateEdgeOpenResult(raw: unknown): RelayEdgeOpenResult {
  const value = object(raw)
  if (
    value.status !== 'requested' ||
    value.installed !== false ||
    !['deviceManagement', 'edgePolicy', 'openProfile'].some((action) => action === value.action)
  )
    throw new Error('打开请求不能声明安装或网络验证已完成。')
  return {
    status: 'requested',
    installed: false,
    action: value.action as RelayEdgeOpenResult['action'],
    warnings: warnings(value.warnings)
  }
}
