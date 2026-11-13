import { createHash } from 'crypto'
import {
  tunDigest,
  tunHelperObservation,
  tunNetworkObservation,
  tunPlanRequest,
  type TunHelperObservation,
  type TunNetworkObservation,
  type TunPlanIssue,
  type TunPreparation
} from '../../../shared/relay/tun'
import type { CompleteConfigurationResult } from '../../../shared/relay/configuration'
import type { RuntimeAsset, RuntimeResourcePin } from '../configuration/bindings'
import { validateBoundConfiguration } from '../configuration/checker'
import { inspectRuntimeConfiguration } from '../configuration/schema'
import { CONFIGURATION_BYTE_LIMIT, plainConfigurationMap as object } from '../profiles/document'
import { profileSelection } from '../../../shared/relay/runtime'
import coreManifest from '../core/manifest.json'
import geodataManifest from '../core/geodata-manifest.json'
import { validateCheckedTunExecutionV2, type CheckedTunExecutionV2 } from './checked-execution'

export interface TunPlanEvidence {
  // Supplied by main-process stores/native observations, never by renderer IPC.
  configurationExpiresAt: number
  configuration: string
  assets: readonly RuntimeAsset[]
  pins: readonly RuntimeResourcePin[]
  parser: CompleteConfigurationResult
  helper: TunHelperObservation
  network: TunNetworkObservation
  expectedHelperSHA256: string
  expectedCoreSHA256: string
  currentUID: number
  checkedExecution?: CheckedTunExecutionV2
}
export const tunPlanLifetime = 60000
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textHash = (value: string): string => createHash('sha256').update(value).digest('hex')
function deviceName(value: unknown): value is string {
  // Darwin IFNAMSIZ is 16 including the NUL terminator. sc_unit is uint32;
  // an explicit interface index N is mapped to N+1, so UINT32_MAX is invalid.
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') >= 16) return false
  if (value === 'utun') return true
  if (!value.startsWith('utun')) return false
  const suffix = value.slice(4),
    index = Number(suffix)
  return Number.isInteger(index) && index >= 0 && index <= 4294967294 && String(index) === suffix
}

// This does not read files, install/launch helpers, contact a core or change
// network preferences. A later executor must independently obtain consent and
// re-observe/recheck all evidence; this plan deliberately has canApply=false.
export function prepareTunPlan(
  raw: unknown,
  evidence: TunPlanEvidence,
  now: number
): TunPreparation {
  const request = tunPlanRequest(raw)
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - tunPlanLifetime ||
    !Number.isSafeInteger(evidence.currentUID) ||
    evidence.currentUID < 1 ||
    evidence.currentUID > 0xffffffff ||
    !tunDigest(evidence.expectedHelperSHA256) ||
    !tunDigest(evidence.expectedCoreSHA256) ||
    typeof evidence.configuration !== 'string' ||
    Buffer.byteLength(evidence.configuration) > CONFIGURATION_BYTE_LIMIT ||
    textHash(evidence.configuration) !== request.configurationSHA256
  )
    throw new Error('TUN候选正文、固定资源或当前用户证据无效。')
  if (
    !Number.isSafeInteger(evidence.configurationExpiresAt) ||
    evidence.configurationExpiresAt < now
  )
    throw new Error('完整配置检查凭据已过期或无效，请重新生成并检查完整候选。')
  const parsed = inspectRuntimeConfiguration(evidence.configuration).configuration
  if (!parsed || !object(parsed.tun) || parsed.tun.enable !== true)
    throw new Error('TUN准备需要固定核心支持、明确启用TUN的完整候选。')
  // Preserve all fixed-schema TUN options. Do not normalize into the old local
  // HTTP projection, which intentionally forbids TUN and other listeners.
  const tun = parsed.tun
  if (
    !deviceName(tun.device) ||
    !['gvisor', 'system', 'mixed'].includes(String(tun.stack)) ||
    typeof tun['auto-route'] !== 'boolean' ||
    typeof tun['auto-detect-interface'] !== 'boolean' ||
    !Array.isArray(tun['dns-hijack']) ||
    tun['dns-hijack'].some((value) => typeof value !== 'string') ||
    (tun['file-descriptor'] !== undefined && tun['file-descriptor'] !== 0)
  )
    throw new Error('TUN候选需明确macOS设备、栈、自动路由、接口与DNS劫持；不接受外部文件描述符。')
  if (evidence.checkedExecution)
    validateCheckedTunExecutionV2(
      evidence.checkedExecution,
      evidence.configuration,
      evidence.assets,
      evidence.expectedCoreSHA256,
      now
    )
  else validateBoundConfiguration(evidence.configuration, evidence.assets)
  if (!Array.isArray(evidence.pins) || evidence.pins.length > 200)
    throw new Error('TUN完整资源包来源无效。')
  const identities = new Set<string>()
  for (const pin of evidence.pins) {
    if (
      !object(pin) ||
      Object.keys(pin).sort().join(',') !== 'id,namespace,revision,sha256' ||
      typeof pin.namespace !== 'string' ||
      !['resource', 'provider'].includes(pin.namespace) ||
      !tunDigest(pin.revision)
    )
      throw new Error('TUN完整资源包来源无效。')
    const selection = profileSelection({ id: pin.id, sha256: pin.sha256 }),
      key = pin.namespace + ':' + selection.id
    if (identities.has(key)) throw new Error('TUN资源包来源重复。')
    identities.add(key)
  }
  const assets = evidence.assets.map(({ path, sha256, expectedRules }) => ({
      path,
      sha256,
      ...(expectedRules !== undefined ? { expectedRules } : {})
    })),
    bundleSHA256 = hash({ configuration: parsed, assets, pins: evidence.pins, unresolved: [] })
  if (bundleSHA256 !== request.bundleSHA256) throw new Error('TUN完整候选或资源包摘要已变化。')
  const helper = tunHelperObservation(evidence.helper),
    network = tunNetworkObservation(evidence.network),
    parser = evidence.parser,
    issues: TunPlanIssue[] = []
  if (
    !object(parser) ||
    Object.keys(parser).some(
      (key) =>
        ![
          'status',
          'scope',
          'configurationSHA256',
          'coreVersion',
          'active',
          'runtimeAccepted',
          'warnings'
        ].includes(key)
    ) ||
    parser.scope !== 'complete-parser' ||
    parser.active !== false ||
    parser.runtimeAccepted !== false ||
    !tunDigest(parser.configurationSHA256) ||
    !['passed', 'rejected', 'unavailable', 'cancelled', 'uncertain'].includes(parser.status) ||
    !Array.isArray(parser.warnings) ||
    parser.warnings.length > 32 ||
    parser.warnings.some((warning) => typeof warning !== 'string' || warning.length > 4096)
  )
    throw new Error('TUN完整解析证据无效。')
  // Main supplies expectedCoreSHA256 from the authenticated installation gate.
  // Checked executions bind their compiled tuple; legacy retains its fixed pair.
  const parserVersion =
    evidence.checkedExecution?.receipt.core.version ??
    (Object.values(geodataManifest.assets).some((pin) => pin.sha256 === evidence.expectedCoreSHA256)
      ? geodataManifest.version
      : coreManifest.version)
  if (parser.status !== 'passed' || parser.coreVersion !== parserVersion)
    issues.push('parserNotPassed')
  if (parser.configurationSHA256 !== request.configurationSHA256)
    issues.push('parserDigestMismatch')
  if (helper.state !== 'ready') issues.push('helperNotReady')
  if (evidence.checkedExecution && helper.execution !== 'core-managed')
    issues.push('helperResourceMismatch')
  if (helper.identity !== 'authenticated') issues.push('helperIdentityUnconfirmed')
  if (helper.authorization !== 'approved') issues.push('helperAuthorizationUnconfirmed')
  if (
    helper.helperSHA256 !== evidence.expectedHelperSHA256 ||
    helper.coreSHA256 !== evidence.expectedCoreSHA256
  )
    issues.push('helperResourceMismatch')
  if (
    !helper.rootOwned ||
    (helper.execution === 'core-managed'
      ? helper.privilegedCoreVerified !== true
      : !helper.runningAsRoot)
  )
    issues.push('helperPrivilegeUnconfirmed')
  if (helper.clientUID !== evidence.currentUID) issues.push('helperClientMismatch')
  if (network.state !== 'observed') issues.push('networkUnconfirmed')
  if (network.existingTunnel !== 'none') issues.push('existingTunnelUnresolved')
  if (network.recovery !== 'available') issues.push('recoveryUnavailable')
  if (
    [helper.observedAt, network.observedAt].some(
      (time) => time > now || now - time > tunPlanLifetime
    )
  )
    issues.push('observationExpired')
  const basis = {
    request,
    tunSHA256: hash(tun),
    assetsSHA256: hash(assets),
    helper,
    network,
    parser,
    expectedHelperSHA256: evidence.expectedHelperSHA256,
    expectedCoreSHA256: evidence.expectedCoreSHA256,
    currentUID: evidence.currentUID,
    configurationExpiresAt: evidence.configurationExpiresAt,
    ...(evidence.checkedExecution ? { executionSHA256: evidence.checkedExecution.sha256 } : {}),
    createdAt: now,
    expiresAt: Math.min(
      Math.min(
        evidence.configurationExpiresAt,
        evidence.checkedExecution?.receipt.expiresAt ?? evidence.configurationExpiresAt
      ),
      Math.min(now, helper.observedAt, network.observedAt) + tunPlanLifetime
    )
  }
  return {
    version: 1,
    ...request,
    tunSHA256: basis.tunSHA256,
    assetsSHA256: basis.assetsSHA256,
    helperRevision: helper.revision,
    networkRevision: network.revision,
    evidenceSHA256: hash(basis),
    createdAt: basis.createdAt,
    expiresAt: basis.expiresAt,
    readyForConfirmation: issues.length === 0,
    canApply: false,
    active: false,
    runtimeVerified: false,
    protectionVerified: false,
    effects: {
      device: tun.device,
      autoRoute: tun['auto-route'],
      dnsHijack: tun['dns-hijack'].length > 0
    },
    issues
  }
}

export function tunPlanIsCurrent(
  plan: TunPreparation,
  request: unknown,
  evidence: TunPlanEvidence,
  now: number
): boolean {
  if (
    !Number.isSafeInteger(now) ||
    now < plan.createdAt ||
    now > plan.expiresAt ||
    (evidence.checkedExecution !== undefined &&
      now >= evidence.checkedExecution.receipt.expiresAt) ||
    !plan.readyForConfirmation
  )
    return false
  try {
    // New observations must be bound into a new plan, rather than silently
    // refreshing consent or extending the lifetime of an existing one.
    const current = prepareTunPlan(request, evidence, plan.createdAt)
    return current.readyForConfirmation && hash(current) === hash(plan)
  } catch {
    return false
  }
}
