import { createHash } from 'crypto'
import type { TunPreparation } from '../../../shared/relay/tun'
import { validateBoundConfiguration } from '../configuration/checker'
import { inspectRuntimeConfiguration } from '../configuration/schema'
import { plainConfigurationMap as object } from '../profiles/document'
import { prepareTunPlan, tunPlanIsCurrent, type TunPlanEvidence } from './plan'
import type { CheckedTunExecutionV2 } from './checked-execution'

// Main-process private data: configuration can contain credentials and must not
// be copied into renderer status, logs, or a root request that only accepts SHA.
export interface TunDescriptorRuntime {
  version: 1
  descriptor: 3
  sourceConfigurationSHA256: string
  runtimeConfigurationSHA256: string
  configuration: string
  preparation: TunPreparation
  active: false
  runtimeVerified: false
  protectionVerified: false
}
export interface TunCoreRuntime extends Omit<TunDescriptorRuntime, 'version' | 'descriptor'> {
  version: 2
  execution: 'core-managed'
  device: string
  checkedExecution?: CheckedTunExecutionV2
}
export type TunRuntime = TunDescriptorRuntime | TunCoreRuntime
const textHash = (value: string): string => createHash('sha256').update(value).digest('hex')

// Mihomo v1.19.33 / sing-tun v0.4.28 owns creation, routes and DNS when
// file-descriptor is absent. Keep every checked option and resource intact.
// Bind an automatic utun name to this preparation so native readiness can
// verify one exact interface; a collision is rejected before launch.
export function prepareTunCoreRuntime(
  request: unknown,
  evidence: TunPlanEvidence,
  now: number
): TunCoreRuntime {
  const preparation = prepareTunPlan(request, evidence, now)
  if (evidence.helper.execution !== 'core-managed')
    throw new Error('TUN自管运行需要对应的新权限安装，不能使用旧FD辅助组件。')
  if (
    preparation.issues.includes('parserNotPassed') ||
    preparation.issues.includes('parserDigestMismatch')
  )
    throw new Error('TUN运行配置需要完整候选通过固定核心解析。')
  const parsed = inspectRuntimeConfiguration(evidence.configuration).configuration
  if (!parsed || !object(parsed.tun)) throw new Error('TUN运行配置缺少有效候选。')
  // A privileged core may expose mutable APIs or change the host clock through
  // otherwise valid Mihomo options. Only our private Unix controller is admitted.
  for (const key of [
    'external-controller',
    'external-controller-tls',
    'external-controller-unix',
    'external-controller-pipe'
  ])
    if (parsed[key] !== undefined && parsed[key] !== '')
      throw new Error(
        '具有系统权限的TUN核心仅允许本次私有控制通道，请清空额外external-controller配置。'
      )
  if (
    object(parsed.ntp) &&
    parsed.ntp['write-to-system'] !== undefined &&
    parsed.ntp['write-to-system'] !== false
  )
    throw new Error('TUN授权不包含修改系统时钟，请关闭ntp.write-to-system。')

  // Fixed Mihomo v1.19.33 checkTunName parses Darwin indices with signed
  // 16 bits. Larger uint32-compatible names are silently regenerated upstream.
  // Keep our exact-name binding and existing collision rejection instead.
  const maximumDeviceIndex = 32767,
    firstAutomaticIndex = 10000,
    device =
      parsed.tun.device === 'utun'
        ? `utun${firstAutomaticIndex + (Number.parseInt(preparation.evidenceSHA256.slice(0, 8), 16) % (maximumDeviceIndex - firstAutomaticIndex + 1))}`
        : String(parsed.tun.device),
    tun = { ...parsed.tun, device }
  if (Number(device.slice(4)) > maximumDeviceIndex)
    throw new Error('固定Mihomo的macOS设备编号必须在0至32767之间，超出范围会被核心改名。')
  delete tun['file-descriptor']
  const configuration = JSON.stringify({ ...parsed, tun })
  if (!inspectRuntimeConfiguration(configuration).configuration)
    throw new Error('TUN运行配置未通过完整结构校验。')
  // The receipt binds source bytes; the runtime changes only the validated TUN
  // device and FD fields, whose projection Native independently reconstructs.
  validateBoundConfiguration(
    evidence.checkedExecution ? evidence.configuration : configuration,
    evidence.assets,
    evidence.checkedExecution?.receipt
  )
  return {
    version: 2,
    execution: 'core-managed',
    device,
    ...(evidence.checkedExecution
      ? { checkedExecution: structuredClone(evidence.checkedExecution) }
      : {}),
    sourceConfigurationSHA256: preparation.configurationSHA256,
    runtimeConfigurationSHA256: textHash(configuration),
    configuration,
    preparation,
    active: false,
    runtimeVerified: false,
    protectionVerified: false
  }
}

export function tunRuntimeIsCurrent(
  runtime: TunRuntime,
  request: unknown,
  evidence: TunPlanEvidence,
  now: number
): boolean {
  if (runtime.version === 1) return tunDescriptorRuntimeIsCurrent(runtime, request, evidence, now)
  try {
    if (!tunPlanIsCurrent(runtime.preparation, request, evidence, now)) return false
    return (
      JSON.stringify(runtime) ===
      JSON.stringify(prepareTunCoreRuntime(request, evidence, runtime.preparation.createdAt))
    )
  } catch {
    return false
  }
}

// Only produces bytes for the fixed FD3 mapping in RelayTunDescriptor. It never
// opens/transfers a descriptor, writes a file, starts a core, or changes a route.
// The helper still needs a typed projection and explicit activation consent.
export function prepareTunDescriptorRuntime(
  request: unknown,
  evidence: TunPlanEvidence,
  now: number
): TunDescriptorRuntime {
  if (evidence.checkedExecution)
    throw new Error('核心执行快照仅支持execution-v2自管运行，不能交给FD辅助组件。')
  const preparation = prepareTunPlan(request, evidence, now)
  if (
    preparation.issues.includes('parserNotPassed') ||
    preparation.issues.includes('parserDigestMismatch')
  )
    throw new Error('FD运行配置需要原完整候选通过固定核心解析，且摘要完全一致。')
  const parsed = inspectRuntimeConfiguration(evidence.configuration).configuration
  if (!parsed || !object(parsed.tun)) throw new Error('FD运行配置缺少有效TUN候选。')
  const configuration = JSON.stringify({
    ...parsed,
    tun: { ...parsed.tun, 'file-descriptor': 3 }
  })
  // Retain the complete candidate, including route/DNS requests. Supplied-FD
  // setup belongs to the helper; do not turn the candidate into a local-proxy
  // projection or discard options to make the runtime appear supported.
  if (!inspectRuntimeConfiguration(configuration).configuration)
    throw new Error('FD运行配置未通过完整结构校验。')
  validateBoundConfiguration(configuration, evidence.assets)
  return {
    version: 1,
    descriptor: 3,
    sourceConfigurationSHA256: preparation.configurationSHA256,
    runtimeConfigurationSHA256: textHash(configuration),
    configuration,
    preparation,
    active: false,
    runtimeVerified: false,
    protectionVerified: false
  }
}

export function tunDescriptorRuntimeIsCurrent(
  runtime: TunDescriptorRuntime,
  request: unknown,
  evidence: TunPlanEvidence,
  now: number
): boolean {
  try {
    if (!tunPlanIsCurrent(runtime.preparation, request, evidence, now)) return false
    // Rebuild using the original preparation time. A later observation cannot
    // silently refresh the old plan or swap its generated runtime bytes.
    const expected = prepareTunDescriptorRuntime(request, evidence, runtime.preparation.createdAt)
    return JSON.stringify(runtime) === JSON.stringify(expected)
  } catch {
    return false
  }
}
