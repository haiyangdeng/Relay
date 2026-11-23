import { randomUUID } from 'crypto'
import { lstat, realpath } from 'fs/promises'
import { projectProxyGroups } from '../clash-backend'
import { validateCoreMode } from '../../../shared/relay/core'
import { localProxyPort } from '../../../shared/relay/local-proxy'
import type { TrafficUsageConnectionSnapshot } from '../../../shared/trafficUsage'
import type { TrafficHistoryOwner } from '../../../shared/relay/traffic-history'
import {
  copyFloatingTrafficSample,
  floatingTrafficFreshMS,
  type RelayTunTrafficSample
} from '../../../shared/relay/floating-traffic'
import {
  smartToolsRequest,
  smartToolsDefinition,
  type SmartToolsInspection,
  type SmartToolsReply
} from '../../../shared/relay/smart-tools'
import { profileEvidence } from '../../../shared/relay/profiles'
import {
  tunDigest,
  tunPlanRequest,
  type TunPlanRequest,
  type TunSessionPreparation,
  type TunSessionState,
  type TunSessionResult
} from '../../../shared/relay/tun'
export type {
  TunSessionPreparation,
  TunSessionState,
  TunSessionResult
} from '../../../shared/relay/tun'
import type { RuntimeAsset, RuntimeResourcePin } from '../configuration/bindings'
import {
  tunRulesReadRequest,
  tunRuleChangeRequest,
  type TunRuntimeRuleConfirmation,
  type TunRuntimeRulesResult
} from '../../../shared/relay/tun-rules'
import {
  tunResourceReadRequest,
  tunResourceReplaceRequest,
  type TunResourcesResult
} from '../../../shared/relay/tun-resources'
import {
  isGeoResourceKind,
  type GeoResourceKind,
  type GeoOriginSelection
} from '../../../shared/relay/geo-origins'
import type { GeoOriginCandidate } from '../resources/origin-candidate'
import {
  assertGeoAutomaticTunPermit,
  type GeoAutomaticPermit,
  type GeoAutomaticOwner
} from '../resources/automatic-permit'
import type { RuleProviderResourceCandidate } from '../resources/rule-provider-candidate'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'
import type { TunRuleProviderEntry } from '../../../shared/relay/tun-rule-providers'
import {
  applyTunFixedGroups,
  restoreTunSavedSelectors,
  tunGroupSelections,
  type ProxyGroupAction,
  type ProxyGroupChannel
} from './proxy-groups'
import type { createTunSmartToolsChannel } from './smart-tools-channel'
import type { TunPlanEvidence } from './plan'
import {
  prepareTunDescriptorRuntime,
  prepareTunCoreRuntime,
  tunRuntimeIsCurrent,
  type TunRuntime
} from './runtime'
import type { TunRuntimeReader } from './runtime-channel'
import type { TunRulesChannel } from './rules-channel'
import type { TunResourcesChannel, TunResourceBlobTicket } from './resources-channel'
import type { TunResourceInbox } from './resource-inbox'
import type { TunRuleProvidersChannel } from './rule-providers-contract'
import { createTunRuleProvidersService, type TunRuleProviderConfirmation } from './rule-providers'

export interface TunRuntimeCapture {
  snapshot: {
    instanceId: string
    revision: string
    configuration: string
    proxyPort: number
    source: { kind: 'tun-managed'; sessionId: string }
  }
  capturedAt: number
  isCurrent(): boolean
  isOwnerLive(): boolean
  assertOwner(signal: AbortSignal): Promise<void>
}
export type TunRuntimeCaptureResult =
  | { status: 'captured'; capture: TunRuntimeCapture }
  | { status: 'busy' | 'unsupported' | 'unavailable' }

// Only fixed diagnostic codes cross the renderer boundary. Raw exceptions can
// contain private paths/configuration and must remain outside UI warnings.
export class TunStartFailure extends Error {
  constructor(
    readonly code:
      | 'checked-source'
      | 'checked-invalidated'
      | 'checked-expired'
      | 'checked-assets'
      | 'checked-profile'
      | 'native-inspection'
      | 'native-baseline'
      | 'native-installation'
      | 'existing-tunnel'
      | 'owned-host-inspection'
  ) {
    super(code)
  }
}

// Only a strictly bound negative native receipt proves that the terminal
// resource-release action did not close its command channel.
export class TunResourcesReleaseDenied extends Error {}
export class TunDisposalDenied extends Error {}

export interface TunSessionBinding {
  sessionId: string
  evidenceSHA256: string
  runtimeConfigurationSHA256: string
}
export interface TunHostObservation extends TunSessionBinding {
  version: 1
  phase:
    | 'idle'
    | 'acquired'
    | 'coreReady'
    | 'active'
    | 'coreStopped'
    | 'released'
    | 'restored'
    | 'unknown'
  core: 'none' | 'running' | 'stopped' | 'unknown'
  device: 'none' | 'held' | 'released' | 'absent' | 'unknown'
  network: 'unchanged' | 'active' | 'restored' | 'unknown'
}
export interface TunWorkDirectoryProof {
  path: string
  device: string
  inode: string
}
// Each capability owns one persistent native host, its XPC connection and its
// ordinary-UID child. No renderer-selected FD, executable, path or PID enters it.
// Mutations must be idempotent for a retry of this same held capability only.
export interface TunSessionHost {
  readonly proxyGroups?: ProxyGroupChannel
  readonly runtimeReader?: TunRuntimeReader
  readonly rulesChannel?: TunRulesChannel
  readonly resourcesChannel?: TunResourcesChannel
  readonly resourceInbox?: TunResourceInbox
  readonly ruleProvidersChannel?: TunRuleProvidersChannel
  readonly smartToolsChannel?: ReturnType<typeof createTunSmartToolsChannel>
  acquire(): Promise<TunHostObservation>
  startCore(): Promise<TunHostObservation>
  activate(): Promise<TunHostObservation>
  inspect(): Promise<TunHostObservation>
  inspectWorkDirectory?(): Promise<TunWorkDirectoryProof | null>
  stopCore(): Promise<TunHostObservation>
  release(): Promise<TunHostObservation>
  verifyRestored(): Promise<TunHostObservation>
  // Send this control operation immediately, independently of an outstanding
  // activation. It revokes unexecuted authority without stopping the core or
  // releasing recovery ownership; resolution requires a native acknowledgment.
  revokeActivation(): Promise<void>
  dispose(): Promise<void>
  // Managed hosts may release their stopped child/device capability while
  // retaining evidence of external proxy changes. Success proves the child and
  // device are gone and the route/DNS baseline is restored.
  disposeReleased?(): Promise<void>
}
export interface TunSessionCandidate {
  fixedGroups?: { name: string; member: string }[]
  readSavedSelectors?(): Promise<Map<string, string>>
  profileId?: string
  // Can be assembled from CompleteConfigurationService.takeChecked(); the
  // checked configuration/assets/pins remain private to the main process.
  evidence: TunPlanEvidence
  // Recheck the saved source/assets and the exact prepared native baseline.
  // This must not refresh timestamps, extend consent or generate new bytes.
  recheck(): Promise<void>
}
export interface TunSessionLaunchBundle {
  readonly sourceConfiguration: string
  readonly assets: readonly RuntimeAsset[]
  readonly pins: readonly RuntimeResourcePin[]
}
export interface TunResourceConfirmation {
  sessionId: string
  configurationRevision: string
  expectedGenerationSHA256: string
  origin: GeoOriginCandidate['origin']
  kind: GeoResourceKind
  oldSHA256: string
  newSHA256: string
  bytes: number
  selector: string
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))

function cloneEvidence(evidence: TunPlanEvidence): TunPlanEvidence {
  const { assets, ...metadata } = evidence
  return {
    ...structuredClone(metadata),
    assets: assets.map(({ bytes, ...asset }) => {
      if (!Buffer.isBuffer(bytes)) throw new Error('运行资源正文必须为已校验的Buffer。')
      return { ...structuredClone(asset), bytes: Buffer.from(bytes) }
    })
  }
}

function sessionRequest(raw: unknown): string {
  if (!object(raw) || Object.keys(raw).join(',') !== 'sessionId' || !uuid(raw.sessionId))
    throw new Error('TUN会话操作仅接受本次主进程生成的会话标识。')
  return raw.sessionId
}

export function validateTunHostObservation(
  raw: unknown,
  binding: TunSessionBinding
): TunHostObservation {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(',') !==
      'core,device,evidenceSHA256,network,phase,runtimeConfigurationSHA256,sessionId,version' ||
    raw.version !== 1 ||
    raw.sessionId !== binding.sessionId ||
    raw.evidenceSHA256 !== binding.evidenceSHA256 ||
    raw.runtimeConfigurationSHA256 !== binding.runtimeConfigurationSHA256 ||
    typeof raw.phase !== 'string' ||
    typeof raw.core !== 'string' ||
    typeof raw.device !== 'string' ||
    typeof raw.network !== 'string' ||
    ![
      'idle',
      'acquired',
      'coreReady',
      'active',
      'coreStopped',
      'released',
      'restored',
      'unknown'
    ].includes(raw.phase) ||
    !['none', 'running', 'stopped', 'unknown'].includes(raw.core) ||
    !['none', 'held', 'released', 'absent', 'unknown'].includes(raw.device) ||
    !['unchanged', 'active', 'restored', 'unknown'].includes(raw.network)
  )
    throw new Error('原生TUN会话回执与本次绑定不一致。')
  const combination = [raw.core, raw.device, raw.network].join(',')
  if (
    (raw.phase === 'idle' && combination !== 'none,none,unchanged') ||
    (raw.phase === 'acquired' && combination !== 'none,held,unchanged') ||
    (raw.phase === 'coreReady' && combination !== 'running,held,unchanged') ||
    (raw.phase === 'active' && combination !== 'running,held,active') ||
    (raw.phase === 'coreStopped' && !['none', 'stopped'].includes(raw.core)) ||
    (raw.phase === 'released' &&
      (!['none', 'stopped'].includes(raw.core) ||
        !['none', 'released', 'absent'].includes(raw.device))) ||
    (raw.phase === 'restored' &&
      (!['none', 'stopped'].includes(raw.core) ||
        !['none', 'absent'].includes(raw.device) ||
        raw.network !== 'restored'))
  )
    throw new Error('原生TUN阶段缺少对应的设备、核心或恢复证据。')
  return {
    version: 1,
    ...binding,
    phase: raw.phase as TunHostObservation['phase'],
    core: raw.core as TunHostObservation['core'],
    device: raw.device as TunHostObservation['device'],
    network: raw.network as TunHostObservation['network']
  }
}

export function createTunSessionService(adapters: {
  execution?: 'core-managed'
  readCandidate(request: TunPlanRequest): Promise<TunSessionCandidate>
  // Register before spawning/acquiring anything. A throw before registration
  // is permitted only if no resource or mutation escaped this call.
  openHost(
    runtime: TunRuntime,
    binding: TunSessionBinding,
    // Main-only bytes for the exact checked bundle. The host validates hashes
    // before writing its private resource files; this never crosses renderer IPC.
    launch: TunSessionLaunchBundle,
    registerRecovery: (host: TunSessionHost) => void
  ): Promise<TunSessionHost>
  confirmStart(preparation: TunSessionPreparation): Promise<boolean>
  confirmStop(state: TunSessionState, reason: 'stop' | 'quit'): Promise<boolean>
  confirmRule?(report: TunRuntimeRuleConfirmation): Promise<boolean>
  readResourceCandidate?(selection: GeoOriginSelection): Promise<GeoOriginCandidate>
  confirmResource?(report: TunResourceConfirmation): Promise<boolean>
  readRuleProviderCandidate?(
    selection: RelayProfileSelection,
    expected: Pick<TunRuleProviderEntry, 'kind' | 'behavior'>
  ): Promise<RuleProviderResourceCandidate>
  confirmRuleProvider?(report: TunRuleProviderConfirmation): Promise<boolean>
  notify?(): void
  onRuntimeChanged?(): void
  onRuntimeChanging?(): void
  now?(): number
  monotonicNow?(): number
}) {
  const now = adapters.now ?? Date.now,
    monotonicNow = adapters.monotonicNow ?? (() => performance.now()),
    waiters: (() => void)[] = []
  let phase: TunSessionState['phase'] = 'idle',
    busy = false,
    generation = 0,
    warnings: string[] = [],
    host: TunSessionHost | undefined,
    binding: TunSessionBinding | undefined,
    latest: TunHostObservation | undefined,
    disposePending: { host: TunSessionHost; restored: TunHostObservation } | undefined,
    releasedDisposePending: { host: TunSessionHost } | undefined,
    revoking: { host: TunSessionHost; promise: Promise<void> } | undefined,
    revocationFailed = false,
    closing: Promise<boolean> | undefined
  let connectionsPending: { abort: AbortController } | undefined
  let trafficPending: { abort: AbortController } | undefined
  let smartToolsBusy = false
  let rulesPending: { channel: TunRulesChannel; abort: AbortController } | undefined
  let resourcesPending:
    { channel: TunResourcesChannel; abort: AbortController; automatic: boolean } | undefined
  const isolatedResources = new WeakSet<TunSessionHost>()
  let loaded:
    | {
        host: TunSessionHost
        profileId?: string
        binding: TunSessionBinding
        configuration: string
        mode?: string
        ports?: number[]
      }
    | undefined
  let automaticOwnerCache:
    { active: NonNullable<typeof loaded>; owner: GeoAutomaticOwner } | undefined
  let proof:
    | {
        public: TunSessionPreparation
        request: TunPlanRequest
        candidate: TunSessionCandidate
        runtime: TunRuntime
        generation: number
      }
    | undefined
  const cancelTraffic = (): void => {
    trafficPending?.abort.abort()
    connectionsPending?.abort.abort()
  }
  const changing = (): void => {
    cancelTraffic()
    try {
      adapters.onRuntimeChanging?.()
    } catch {
      /* Display observers cannot take control authority. */
    }
  }
  const begin = (): void => {
    busy = true
    changing()
  }
  const notify = (): void => {
    changing()
    try {
      adapters.notify?.()
    } catch {
      // A closed renderer must not prevent revocation, recovery or settlement.
    }
  }
  const currentHost = (): TunSessionHost | undefined => host
  const state = (): TunSessionState => ({
    phase,
    pending: busy || !!closing || !!revoking,
    owned: !!host,
    ...(binding ? { sessionId: binding.sessionId } : {}),
    traffic:
      phase === 'active' && latest?.phase === 'active'
        ? 'forwarding'
        : !host || phase === 'restored'
          ? 'inactive'
          : 'unconfirmed',
    restorationVerified: phase === 'restored' && !host,
    protectionVerified: false,
    warnings: [...warnings]
  })
  const settleWaiters = (): void => {
    if (!busy && !revoking) waiters.splice(0).forEach((resolve) => resolve())
  }
  const end = (): void => {
    busy = false
    settleWaiters()
    notify()
    try {
      adapters.onRuntimeChanged?.()
    } catch {
      /* Notifications do not change the transaction. */
    }
  }
  const whenIdle = (): Promise<void> =>
    busy || revoking ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const whenRevoked = (): Promise<void> => revoking?.promise ?? Promise.resolve()
  const result = (status: TunSessionResult['status']): TunSessionResult => ({
    status,
    state: { ...state(), pending: !!revoking }
  })
  const uncertain = (): void => {
    loaded = undefined
    phase = 'uncertain'
    warnings = [
      releasedDisposePending
        ? '本次核心已停止，宿主资源释放及退出尚未确认；保留本次宿主，请重试完成停用。'
        : disposePending
          ? '本次网络及设备恢复已有终端证据，宿主退出尚未确认；保留本次宿主，请重试完成停用。'
          : 'TUN会话结果未确认；保留本次宿主及恢复能力，请复核后明确停用。'
    ]
    notify()
  }
  const revokeActivation = (owned: TunSessionHost): void => {
    if (revoking?.host === owned) return
    let finish!: () => void
    const attempt = { host: owned, promise: new Promise<void>((resolve) => (finish = resolve)) }
    // Publish the in-flight revocation before calling the adapter, which may
    // synchronously reenter invalidation. Never queue it behind activation.
    revoking = attempt
    const settled = (failed: boolean): void => {
      if (revoking === attempt) {
        revoking = undefined
        if (host === owned) {
          revocationFailed = failed
          if (failed) uncertain()
        }
      }
      finish()
      settleWaiters()
      notify()
    }
    try {
      void owned.revokeActivation().then(
        () => settled(false),
        () => settled(true)
      )
    } catch {
      settled(true)
    }
    notify()
  }
  const accept = (
    raw: TunHostObservation,
    expected?: TunHostObservation['phase']
  ): TunHostObservation => {
    if (!binding) throw new Error('缺少本次TUN会话绑定。')
    const next = validateTunHostObservation(raw, binding)
    if (expected && next.phase !== expected) throw new Error('本次TUN操作尚未确认完成。')
    latest = next
    return next
  }
  const invalidateRules = (): void => {
    const current = rulesPending
    if (!current) return
    current.abort.abort()
    // Scope-only revocation; never reuse the lifecycle uncertain/recovery path.
    void current.channel.cancel().catch(() => {})
  }
  const invalidateResources = (): void => {
    ruleProviders.invalidate()
    const current = resourcesPending
    if (!current) return
    current.abort.abort()
    void current.channel.cancel().catch(() => {})
  }
  const invalidatePending = (): void => {
    invalidateRules()
    invalidateResources()
    ++generation
    proof = undefined
    if (host) {
      uncertain()
      // A terminal capability may already have closed its control channel;
      // no activation remains after its verified network/device restoration.
      if (!disposePending && !releasedDisposePending) revokeActivation(host)
    } else {
      if (phase === 'prepared') phase = 'idle'
      notify()
    }
  }
  const disposeReleasedOwned = async (owned: TunSessionHost): Promise<void> => {
    if (host !== owned || !binding || !owned.disposeReleased)
      throw new Error('本次TUN资源释放能力已变化。')
    // Once attempted, the native command channel may already be terminal.
    // Retain that exact capability for disposal-only retry even if IO exit
    // confirmation fails after the terminal native acknowledgment.
    releasedDisposePending = { host: owned }
    await whenRevoked()
    try {
      await owned.disposeReleased()
    } catch (error) {
      if (error instanceof TunResourcesReleaseDenied) releasedDisposePending = undefined
      throw error
    }
    await whenRevoked()
    host = undefined
    loaded = undefined
    latest = undefined
    binding = undefined
    disposePending = undefined
    releasedDisposePending = undefined
    phase = 'released'
    revocationFailed = false
    warnings = ['TUN 已关闭，路由和 DNS 已恢复。保留当前系统代理设置。']
  }
  // The caller owns the existing lifecycle operation. Startup compensation
  // must not reenter stopCurrent or wait for the busy operation it is inside.
  const restoreOwned = async (
    owned: TunSessionHost,
    reason: 'stop' | 'startup'
  ): Promise<TunSessionResult> => {
    let failureStage = 'session-binding',
      coreStopped = false
    try {
      if (host !== owned || !binding) throw new Error('本次TUN恢复宿主已变化。')
      phase = 'stopping'
      notify()
      if (releasedDisposePending) {
        failureStage = 'released-host-dispose'
        if (releasedDisposePending.host !== owned) throw new Error('本次宿主资源释放能力已变化。')
        await disposeReleasedOwned(owned)
        return result('released')
      }
      // Stop only the native host's held ordinary-UID child and FD copies.
      // A stopped core or released helper FD alone cannot complete recovery.
      if (disposePending) {
        // The same capability has already proved the terminal network/device
        // state. It permits no new start/activation; retry only its disposal.
        if (disposePending.host !== owned) throw new Error('本次宿主恢复能力已变化。')
        accept(disposePending.restored, 'restored')
      } else {
        failureStage = 'core-stop'
        accept(await owned.stopCore(), 'coreStopped')
        coreStopped = true
        failureStage = 'device-release'
        accept(await owned.release(), 'released')
        failureStage = 'restoration-check'
        const restored = accept(await owned.verifyRestored(), 'restored')
        disposePending = { host: owned, restored }
      }
      failureStage = 'revocation-wait'
      await whenRevoked()
      failureStage = 'host-dispose'
      await owned.dispose()
      await whenRevoked()
      host = undefined
      loaded = undefined
      latest = undefined
      binding = undefined
      disposePending = undefined
      phase = 'restored'
      revocationFailed = false
      warnings = []
      return result('restored')
    } catch (error) {
      const disposalDenied =
        failureStage === 'host-dispose' &&
        error instanceof TunDisposalDenied &&
        disposePending?.host === owned
      if (
        adapters.execution === 'core-managed' &&
        ((coreStopped && ['device-release', 'restoration-check'].includes(failureStage)) ||
          disposalDenied) &&
        owned.disposeReleased
      ) {
        // A bound refusal proves normal disposal did not terminate the host.
        // Its old restoration proof no longer describes the changed baseline.
        if (disposalDenied) disposePending = undefined
        try {
          await disposeReleasedOwned(owned)
          return result('released')
        } catch {
          // Retain the terminal attempt for an explicitly authorized retry;
          // no other command may reuse a possibly closed native channel.
          failureStage += '/released-host-dispose'
        }
      }
      uncertain()
      warnings.push(
        reason === 'startup'
          ? `TUN启动恢复失败阶段：${failureStage}。`
          : `TUN停用失败阶段：${failureStage}。`
      )
      return result('uncertain')
    }
  }
  const stopCurrent = async (reason: 'stop' | 'quit'): Promise<TunSessionResult> => {
    if (busy || resourcesPending || revoking || !host || !binding)
      throw new Error('请等待当前操作结束并选择本次TUN会话。')
    const owned = host
    begin()
    proof = undefined
    ++generation
    try {
      if (!(await adapters.confirmStop(state(), reason))) return result('cancelled')
      return await restoreOwned(owned, 'stop')
    } catch {
      uncertain()
      warnings.push('TUN停用失败阶段：confirmation。')
      return result('uncertain')
    } finally {
      end()
    }
  }
  const rulesOperation = async (
    raw: unknown,
    changing: boolean,
    assertUI: () => void
  ): Promise<TunRuntimeRulesResult> => {
    const selection = changing ? tunRuleChangeRequest(raw) : undefined,
      request = selection ?? tunRulesReadRequest(raw),
      sessionId = request.sessionId,
      output = (
        status: Exclude<TunRuntimeRulesResult['status'], 'snapshot' | 'changed' | 'unchanged'>
      ): TunRuntimeRulesResult => ({ status, sessionId })
    if (busy || rulesPending || resourcesPending || closing || revoking) return output('busy')
    const active = loaded,
      channel = active?.host.rulesChannel
    if (!active || active.binding.sessionId !== sessionId) return output('stale')
    if (!channel) return output('unsupported')
    const epoch = generation,
      operation = { channel, abort: new AbortController() }
    let changeStarted = false,
      changedStatus: TunRuntimeRulesResult['status'] | undefined
    const live = (): void => {
      assertUI()
      // No global idle callback: this logical operation owns busy itself.
      if (
        operation.abort.signal.aborted ||
        generation !== epoch ||
        loaded !== active ||
        host !== active.host ||
        host.rulesChannel !== channel ||
        binding?.sessionId !== active.binding.sessionId ||
        binding.evidenceSHA256 !== active.binding.evidenceSHA256 ||
        binding.runtimeConfigurationSHA256 !== active.binding.runtimeConfigurationSHA256 ||
        phase !== 'active' ||
        latest?.phase !== 'active' ||
        closing ||
        revoking ||
        revocationFailed ||
        disposePending
      )
        throw new Error('本次TUN规则范围已失效。')
    }
    begin()
    rulesPending = operation
    notify()
    const revoked = (): TunRuntimeRulesResult =>
      output(
        changeStarted &&
          (!changedStatus || changedStatus === 'changed' || changedStatus === 'uncertain')
          ? 'uncertain'
          : 'cancelled'
      )
    const perform = async (): Promise<TunRuntimeRulesResult> => {
      try {
        live()
        const observed = await channel.read(operation.abort.signal, live)
        live()
        if (!('snapshot' in observed)) return output(observed.status)
        if (observed.status !== 'snapshot') return output('unavailable')
        const snapshot = observed.snapshot
        if (snapshot.configurationRevision !== active.binding.runtimeConfigurationSHA256)
          return output('stale')
        const publicSnapshot = { ...structuredClone(snapshot), sessionId }
        if (!selection) return { status: 'snapshot', sessionId, snapshot: publicSnapshot }
        const rule = snapshot.rules[selection.index]
        if (
          selection.configurationRevision !== snapshot.configurationRevision ||
          selection.rulesSHA256 !== snapshot.rulesSHA256 ||
          !rule ||
          rule.index !== selection.index ||
          typeof rule.disabled !== 'boolean'
        )
          return output('stale')
        if (rule.disabled === selection.disabled)
          return { status: 'unchanged', sessionId, snapshot: publicSnapshot }
        if (!channel.isAvailable()) return output('unavailable')
        const accepted = await (adapters.confirmRule?.({
          sessionId,
          configurationRevision: snapshot.configurationRevision,
          rulesSHA256: snapshot.rulesSHA256,
          rule: { ...structuredClone(rule), disabled: rule.disabled },
          disabled: selection.disabled
        }) ?? false)
        live()
        if (!accepted) return output('cancelled')
        if (!channel.isAvailable()) return output('unavailable')
        // The human dialog is complete before Native's short prepare lease starts.
        changeStarted = true
        const changed = await channel.change(
          {
            configurationRevision: selection.configurationRevision,
            rulesSHA256: selection.rulesSHA256,
            index: selection.index,
            disabled: selection.disabled
          },
          operation.abort.signal,
          live
        )
        changedStatus = changed.status
        live()
        if ('snapshot' in changed) {
          if (
            changed.snapshot.configurationRevision !== snapshot.configurationRevision ||
            changed.snapshot.rules[selection.index]?.disabled !== selection.disabled
          )
            return output('uncertain')
          return {
            status: changed.status,
            sessionId,
            snapshot: { ...structuredClone(changed.snapshot), sessionId }
          }
        }
        return output(changed.status)
      } catch {
        return revoked()
      }
    }
    let outcome: TunRuntimeRulesResult,
      drained = true
    try {
      outcome = await perform()
    } finally {
      try {
        await channel.whenIdle()
      } catch {
        drained = false
        try {
          channel.invalidate()
        } catch {
          /* Only rules authority is discarded. */
        }
      } finally {
        end()
      }
    }
    try {
      // Drain and end notifications can both invalidate the private UI scope.
      // No awaited work or observer belongs after this final publication guard.
      live()
      return drained ? outcome : output(changeStarted ? 'uncertain' : 'unavailable')
    } catch {
      return revoked()
    } finally {
      if (rulesPending === operation) rulesPending = undefined
    }
  }
  const automaticResourceOwner = (sessionId: string): GeoAutomaticOwner | undefined => {
    const active = loaded,
      channel = active?.host.resourcesChannel
    if (!active || active.binding.sessionId !== sessionId || !channel) return undefined
    const assertCurrent = (): void => {
      if (
        loaded !== active ||
        host !== active.host ||
        binding?.sessionId !== active.binding.sessionId ||
        binding.evidenceSHA256 !== active.binding.evidenceSHA256 ||
        binding.runtimeConfigurationSHA256 !== active.binding.runtimeConfigurationSHA256 ||
        phase !== 'active' ||
        latest?.phase !== 'active' ||
        closing ||
        revoking ||
        revocationFailed ||
        disposePending ||
        isolatedResources.has(active.host) ||
        host.resourcesChannel !== channel ||
        !channel.isAvailable()
      )
        throw new Error('自动地理更新绑定的活动实例已失效。')
    }
    try {
      assertCurrent()
    } catch {
      return undefined
    }
    if (automaticOwnerCache?.active !== active)
      automaticOwnerCache = {
        active,
        owner: {
          sessionId: active.binding.sessionId,
          configurationRevision: active.binding.runtimeConfigurationSHA256,
          assertCurrent
        }
      }
    return automaticOwnerCache.owner
  }
  const resourcesOperation = async (
    raw: unknown,
    changing: boolean,
    assertUI: () => void,
    automaticPermit?: GeoAutomaticPermit
  ): Promise<TunResourcesResult> => {
    const selection = changing ? tunResourceReplaceRequest(raw) : undefined,
      request = selection ?? tunResourceReadRequest(raw),
      sessionId = request.sessionId,
      output = (
        status: Exclude<TunResourcesResult['status'], 'snapshot' | 'updated' | 'unchanged'>
      ): TunResourcesResult => ({ status, sessionId })
    if (busy || rulesPending || resourcesPending || closing || revoking) return output('busy')
    const active = loaded,
      channel = active?.host.resourcesChannel,
      inbox = active?.host.resourceInbox,
      readCandidate = adapters.readResourceCandidate,
      automaticOwner = automaticPermit ? automaticResourceOwner(sessionId) : undefined
    if (!active || active.binding.sessionId !== sessionId) return output('stale')
    if (isolatedResources.has(active.host)) return output('uncertain')
    if (!channel || (changing && (!inbox || !readCandidate))) return output('unsupported')
    if (automaticPermit && !automaticOwner) return output('unsupported')
    const epoch = generation,
      operation = {
        channel,
        abort: new AbortController(),
        invalid: false,
        automatic: !!automaticPermit
      }
    let replaceStarted = false,
      replacementStatus: TunResourcesResult['status'] | undefined,
      staged: TunResourceBlobTicket | undefined
    let automaticOrigin: GeoOriginCandidate['origin'] | undefined
    const live = (): void => {
      try {
        assertUI()
        if (automaticPermit && automaticOwner && automaticOrigin)
          assertGeoAutomaticTunPermit(automaticPermit, automaticOrigin, automaticOwner)
      } catch (error) {
        operation.invalid = true
        operation.abort.abort()
        throw error
      }
      if (
        operation.abort.signal.aborted ||
        resourcesPending !== operation ||
        generation !== epoch ||
        loaded !== active ||
        host !== active.host ||
        host.resourcesChannel !== channel ||
        host.resourceInbox !== inbox ||
        binding?.sessionId !== active.binding.sessionId ||
        binding.evidenceSHA256 !== active.binding.evidenceSHA256 ||
        binding.runtimeConfigurationSHA256 !== active.binding.runtimeConfigurationSHA256 ||
        phase !== 'active' ||
        latest?.phase !== 'active' ||
        closing ||
        revoking ||
        revocationFailed ||
        disposePending
      ) {
        operation.invalid = true
        throw new Error('本次TUN地理资源范围已失效。')
      }
    }
    const revoked = (): TunResourcesResult => {
      const unknown =
        replaceStarted &&
        (!replacementStatus || replacementStatus === 'updated' || replacementStatus === 'uncertain')
      if (unknown) isolatedResources.add(active.host)
      return output(unknown ? 'uncertain' : 'cancelled')
    }
    begin()
    resourcesPending = operation
    notify()
    const perform = async (): Promise<TunResourcesResult> => {
      try {
        live()
        const observed = await channel.read(operation.abort.signal, live)
        live()
        if (!('snapshot' in observed)) {
          if (observed.status === 'uncertain') isolatedResources.add(active.host)
          return output(observed.status)
        }
        const before = observed.snapshot
        if (
          observed.status !== 'snapshot' ||
          before.configurationRevision !== active.binding.runtimeConfigurationSHA256
        )
          return output('stale')
        if (!selection)
          return {
            status: 'snapshot',
            sessionId,
            snapshot: { ...structuredClone(before), sessionId }
          }
        if (
          selection.configurationRevision !== before.configurationRevision ||
          selection.expectedGenerationSHA256 !== before.generationSHA256
        )
          return output('stale')
        if (!readCandidate || !inbox) return output('unsupported')
        const candidate = await readCandidate(selection.origin)
        automaticOrigin = candidate.origin
        live()
        if (automaticPermit && !candidate.origin.autoIntent.requested) return output('stale')
        const job = candidate.job,
          kind = job.descriptor.kind,
          previous = before.resources.find((row) => row.kind === kind)
        if (
          !isGeoResourceKind(kind) ||
          !previous?.active ||
          candidate.origin.id !== selection.origin.id ||
          candidate.origin.revision !== selection.origin.revision
        )
          return output('stale')
        const accepted = automaticPermit
          ? true
          : await (adapters.confirmResource?.({
              sessionId,
              configurationRevision: before.configurationRevision,
              expectedGenerationSHA256: before.generationSHA256,
              origin: structuredClone(candidate.origin),
              kind,
              oldSHA256: previous.sha256,
              newSHA256: job.sha256,
              bytes: job.bytes.length,
              selector: job.descriptor.selector
            }) ?? false)
        live()
        if (!accepted) return output('cancelled')
        await candidate.recheck()
        live()
        staged = await inbox.stage(job, operation.abort.signal, live)
        live()
        if (
          staged.kind !== kind ||
          staged.sha256 !== job.sha256 ||
          staged.bytes !== job.bytes.length ||
          staged.selector !== job.descriptor.selector
        )
          return output('unavailable')
        await candidate.recheck()
        live()
        if (!channel.isAvailable()) return output('unavailable')
        replaceStarted = true
        const changed = await channel.replace(
          {
            configurationRevision: before.configurationRevision,
            expectedGenerationSHA256: before.generationSHA256,
            kind,
            oldSHA256: previous.sha256,
            newSHA256: staged.sha256,
            bytes: staged.bytes,
            selector: staged.selector,
            blobId: staged.blobId
          },
          operation.abort.signal,
          live
        )
        replacementStatus = changed.status
        live()
        if (!('snapshot' in changed)) {
          if (changed.status === 'uncertain') isolatedResources.add(active.host)
          return output(changed.status)
        }
        await candidate.recheck()
        live()
        const after = changed.snapshot,
          target = after.resources.find((row) => row.kind === kind)
        if (
          (changed.status !== 'updated' && changed.status !== 'unchanged') ||
          after.configurationRevision !== before.configurationRevision ||
          after.resources.length !== before.resources.length ||
          !target?.active ||
          target.sha256 !== staged.sha256 ||
          target.bytes !== staged.bytes ||
          before.resources.some(
            (row) =>
              row.kind !== kind &&
              !after.resources.some(
                (next) =>
                  next.kind === row.kind &&
                  next.sha256 === row.sha256 &&
                  next.bytes === row.bytes &&
                  next.active === row.active
              )
          )
        ) {
          isolatedResources.add(active.host)
          return output('uncertain')
        }
        return {
          status: changed.status,
          sessionId,
          snapshot: { ...structuredClone(after), sessionId }
        }
      } catch {
        return replaceStarted
          ? revoked()
          : output(
              operation.invalid || operation.abort.signal.aborted ? 'cancelled' : 'unavailable'
            )
      }
    }
    let outcome: TunResourcesResult,
      drained = true
    try {
      outcome = await perform()
    } finally {
      try {
        await channel.whenIdle()
        if (staged) {
          const receipt = await channel.discardBlob(staged)
          if (receipt === 'discarded' || receipt === 'absent') inbox?.acknowledgeDiscard(staged)
        }
      } catch {
        drained = false
        channel.invalidate()
      } finally {
        end()
      }
    }
    try {
      live()
      if (!drained) {
        if (replaceStarted) isolatedResources.add(active.host)
        return output(replaceStarted ? 'uncertain' : 'unavailable')
      }
      return outcome
    } catch {
      return revoked()
    } finally {
      if (resourcesPending === operation) resourcesPending = undefined
    }
  }
  const ruleProviders = createTunRuleProvidersService({
    acquire(sessionId) {
      if (busy || rulesPending || resourcesPending || closing || revoking) return { status: 'busy' }
      const active = loaded,
        channel = active?.host.ruleProvidersChannel,
        inbox = active?.host.resourceInbox
      if (!active || active.binding.sessionId !== sessionId) return { status: 'stale' }
      if (!channel || !inbox) return { status: 'unsupported' }
      const epoch = generation,
        assertCurrent = (): void => {
          if (
            generation !== epoch ||
            loaded !== active ||
            host !== active.host ||
            host.ruleProvidersChannel !== channel ||
            host.resourceInbox !== inbox ||
            binding?.sessionId !== active.binding.sessionId ||
            binding.evidenceSHA256 !== active.binding.evidenceSHA256 ||
            binding.runtimeConfigurationSHA256 !== active.binding.runtimeConfigurationSHA256 ||
            phase !== 'active' ||
            latest?.phase !== 'active' ||
            closing ||
            revoking ||
            revocationFailed ||
            disposePending
          )
            throw new Error('本次规则提供者的持有会话已变化。')
        }
      try {
        assertCurrent()
      } catch {
        return { status: 'unavailable' }
      }
      begin()
      notify()
      return {
        status: 'held',
        lease: {
          owner: active.host,
          sessionId,
          configurationRevision: active.binding.runtimeConfigurationSHA256,
          channel,
          inbox,
          assertCurrent,
          release: end
        }
      }
    },
    readCandidate: (selection, expected) => {
      if (!adapters.readRuleProviderCandidate) throw new Error('规则提供者候选检查不可用。')
      return adapters.readRuleProviderCandidate(selection, expected)
    },
    confirm: (report) => adapters.confirmRuleProvider?.(report) ?? Promise.resolve(false)
  })
  const proxyPageOwner = () => {
    const active = loaded
    if (
      !active ||
      !active.profileId ||
      host !== active.host ||
      !host.proxyGroups ||
      busy ||
      closing ||
      revoking ||
      phase !== 'active' ||
      latest?.phase !== 'active'
    )
      return undefined
    const runtime = JSON.parse(active.configuration)
    return {
      kind: 'tun-managed' as const,
      instanceId: active.binding.sessionId,
      configurationRevision: active.binding.runtimeConfigurationSHA256,
      profileId: active.profileId,
      mode: validateCoreMode(active.mode ?? runtime.mode ?? 'rule')
    }
  }
  const readProxyTable = async (action: ProxyGroupAction) => {
    const active = loaded,
      owner = proxyPageOwner()
    if (!active || !owner || !active.host.proxyGroups) throw new Error('TUN 节点会话尚未就绪。')
    const nodes = await active.host.proxyGroups(action)
    if (loaded !== active || proxyPageOwner()?.instanceId !== owner.instanceId)
      throw new Error('TUN 节点会话已切换。')
    return { nodes, mode: owner.mode, runtime: JSON.parse(active.configuration) }
  }
  return {
    proxyPageOwner,
    async proxyGroups(showHidden: boolean) {
      const { nodes, runtime, mode } = await readProxyTable({ action: 'groups' })
      return projectProxyGroups(new Map(Object.entries(nodes)), runtime, mode, showHidden)
    },
    async changeProxy(action: Exclude<ProxyGroupAction, { action: 'groups' }>) {
      await readProxyTable(action)
    },
    async proxySelections() {
      const { nodes } = await readProxyTable({ action: 'groups' })
      return tunGroupSelections(nodes)
    },
    async smartTools(
      raw: unknown,
      confirmClear: (inspection: SmartToolsInspection) => Promise<boolean> = async () => false
    ): Promise<SmartToolsReply> {
      const request = smartToolsRequest(raw)
      if (request.target !== 'tun') throw new Error('Smart工具实例类别不符。')
      const active = loaded,
        lane = active?.host.smartToolsChannel
      const context = (): SmartToolsInspection => {
        if (
          !active ||
          !lane ||
          loaded !== active ||
          host !== active.host ||
          active.host.smartToolsChannel !== lane ||
          binding?.sessionId !== active.binding.sessionId ||
          binding.evidenceSHA256 !== active.binding.evidenceSHA256 ||
          binding.runtimeConfigurationSHA256 !== active.binding.runtimeConfigurationSHA256 ||
          phase !== 'active' ||
          latest?.phase !== 'active' ||
          closing ||
          revoking ||
          revocationFailed
        )
          throw new Error('本次TUN Smart工具持有者已变化。')
        const configuration: unknown = JSON.parse(active.configuration)
        if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration))
          throw new Error()
        const groups = (configuration as Record<string, unknown>)['proxy-groups']
        if (!Array.isArray(groups)) throw new Error()
        const definition = smartToolsDefinition({
          configurationRevision: active.binding.runtimeConfigurationSHA256,
          groups: groups
            .filter((group) => !!group && typeof group === 'object' && group.type === 'smart')
            .map((group) => group.name)
        })
        return {
          target: 'tun',
          instanceId: active.binding.sessionId,
          available: lane.isAvailable(),
          ...definition
        }
      }
      let initial: SmartToolsInspection
      try {
        initial = context()
      } catch {
        return { status: 'unavailable' }
      }
      if (request.action === 'inspect') return { status: 'ready', inspection: initial }
      if (!initial.available) return { status: 'unsupported' }
      if (smartToolsBusy || lane?.isBusy()) return { status: 'busy' }
      if (
        !lane ||
        request.instanceId !== initial.instanceId ||
        request.configurationRevision !== initial.configurationRevision ||
        (request.action === 'weights' && !initial.groups.includes(request.group))
      )
        return { status: 'unavailable' }
      const assertOwner = (): void => {
        const fresh = context()
        if (
          !fresh.available ||
          fresh.configurationRevision !== initial.configurationRevision ||
          JSON.stringify(fresh.groups) !== JSON.stringify(initial.groups)
        )
          throw new Error('本次Smart配置已变化。')
      }
      smartToolsBusy = true
      const abort = new AbortController()
      let writeDispatched = false
      try {
        if (request.action === 'weights') {
          const reply = await lane.weights(abort.signal, assertOwner)
          assertOwner()
          if (reply.status !== 'snapshot' || reply.snapshot.kind !== 'weights')
            return { status: 'unavailable' }
          const group = reply.snapshot.groups.find((group) => group.name === request.group)
          return group?.status === 'ready'
            ? { status: 'weights', weights: group.weights }
            : { status: 'unavailable' }
        }
        if (!(await confirmClear(structuredClone(initial)))) return { status: 'cancelled' }
        assertOwner()
        writeDispatched = true
        const reply = await lane.clearCache(abort.signal, assertOwner)
        assertOwner()
        if (reply.status === 'updated' && reply.snapshot.kind === 'clear-cache')
          return { status: 'accepted' }
        return {
          status:
            reply.status === 'cancelled'
              ? 'cancelled'
              : reply.status === 'uncertain'
                ? 'uncertain'
                : 'unavailable'
        }
      } catch {
        return {
          status: writeDispatched
            ? 'uncertain'
            : request.action === 'clear-cache'
              ? 'cancelled'
              : 'unavailable'
        }
      } finally {
        smartToolsBusy = false
      }
    },
    state,
    systemProxyListener(sessionId: string | undefined): { httpPort: number; mixedPort?: number } {
      const active = loaded
      if (
        !active ||
        active.host !== host ||
        binding?.sessionId !== sessionId ||
        active.binding.sessionId !== sessionId ||
        busy ||
        closing ||
        revoking ||
        phase !== 'active' ||
        latest?.phase !== 'active'
      )
        throw new Error('TUN 的代理监听尚未确认。')
      // The native receipt binds this session to these exact launch bytes.
      // System proxy needs its ordinary ports, even when runtime export is unavailable.
      const config: Record<string, unknown> = JSON.parse(active.configuration)
      const mixedPort = config['mixed-port'] ? localProxyPort(config['mixed-port']) : undefined
      return { httpPort: localProxyPort(config.port || mixedPort), mixedPort }
    },
    readRuleProviders: ruleProviders.read,
    replaceRuleProvider: ruleProviders.replace,
    invalidateRuleProviders: ruleProviders.invalidate,
    readRules: (raw: unknown, assertUI: () => void) => rulesOperation(raw, false, assertUI),
    changeRule: (raw: unknown, assertUI: () => void) => rulesOperation(raw, true, assertUI),
    invalidateRules,
    readResources: (raw: unknown, assertUI: () => void) => resourcesOperation(raw, false, assertUI),
    replaceResource: (raw: unknown, assertUI: () => void) =>
      resourcesOperation(raw, true, assertUI),
    invalidateResources,
    invalidateInteractiveResources: (): void => {
      ruleProviders.invalidate()
      if (resourcesPending && !resourcesPending.automatic) invalidateResources()
    },
    automaticResourceOwner,
    // Main-only branded permit. Public IPC uses the manual entry above.
    replaceResourceScheduled: (raw: unknown, permit: GeoAutomaticPermit, assertScope: () => void) =>
      resourcesOperation(raw, true, assertScope, permit),
    // Display-only fixed telemetry. Never sets lifecycle busy or dispatches a
    // control action; old/failed lanes leave the active TUN owner unchanged.
    cancelTraffic,
    cancelHistoryRead: (): void => {
      connectionsPending?.abort.abort()
    },
    captureWorkDirectory(): ((open: (path: string) => Promise<void>) => Promise<void>) | undefined {
      const active = loaded,
        capturedBinding = binding,
        observation = latest,
        epoch = generation,
        read = active?.host.inspectWorkDirectory,
        uid = process.getuid?.()
      if (!active || !capturedBinding || !read || uid === undefined || uid === 0) return undefined
      const live = (): boolean =>
        loaded === active &&
        host === active.host &&
        binding === capturedBinding &&
        latest === observation &&
        generation === epoch &&
        phase === 'active' &&
        observation?.phase === 'active' &&
        !busy &&
        !closing &&
        !revoking &&
        !revocationFailed &&
        !disposePending
      if (!live()) return undefined
      return async (open) => {
        const unavailable = (): Error => new Error('本次TUN核心工作目录归属未确认。')
        if (!live()) throw unavailable()
        const proof = await read.call(active.host)
        const prefix = `/private/tmp/relay-session-${uid}-`
        if (
          !live() ||
          !proof ||
          !proof.path.startsWith(prefix) ||
          proof.path.length !== prefix.length + 6 ||
          !/^[A-Za-z0-9]{6}$/u.test(proof.path.slice(prefix.length))
        )
          throw unavailable()
        const { path } = proof
        if ((await realpath(path)) !== path || !live()) throw unavailable()
        const info = await lstat(path, { bigint: true })
        if (
          !live() ||
          !info.isDirectory() ||
          info.uid !== BigInt(uid) ||
          (info.mode & 0o7777n) !== 0o700n ||
          info.dev.toString() !== proof.device ||
          info.ino.toString() !== proof.inode
        )
          throw unavailable()
        await open(path)
      }
    },
    historyOwner(): TrafficHistoryOwner | undefined {
      const active = loaded,
        reader = active?.host.runtimeReader
      if (
        !active ||
        !reader?.supportsConnections?.() ||
        host !== active.host ||
        binding?.sessionId !== active.binding.sessionId ||
        binding.evidenceSHA256 !== active.binding.evidenceSHA256 ||
        binding.runtimeConfigurationSHA256 !== active.binding.runtimeConfigurationSHA256 ||
        phase !== 'active' ||
        latest?.phase !== 'active' ||
        busy ||
        resourcesPending ||
        closing ||
        revoking ||
        revocationFailed ||
        disposePending
      )
        return undefined
      return {
        kind: 'tun-managed',
        instanceId: active.binding.sessionId,
        configurationRevision: active.binding.runtimeConfigurationSHA256,
        evidenceSHA256: active.binding.evidenceSHA256
      }
    },
    async readConnections(
      signal: AbortSignal
    ): Promise<
      { owner: TrafficHistoryOwner; snapshot: TrafficUsageConnectionSnapshot } | undefined
    > {
      const active = loaded,
        reader = active?.host.runtimeReader,
        read = reader?.connections
      if (!active || !reader || !read || signal.aborted || connectionsPending) return undefined
      const operation = { abort: new AbortController() },
        wallStart = now(),
        monoStart = monotonicNow()
      let lastWall = wallStart,
        lastMono = monoStart
      const live = (): boolean => {
        const wall = now(),
          mono = monotonicNow()
        const fresh =
          Number.isSafeInteger(wallStart) &&
          Number.isFinite(monoStart) &&
          Number.isSafeInteger(wall) &&
          Number.isFinite(mono) &&
          wall >= lastWall &&
          mono >= lastMono &&
          wall - wallStart < floatingTrafficFreshMS &&
          mono - monoStart < floatingTrafficFreshMS
        lastWall = wall
        lastMono = mono
        return (
          fresh &&
          connectionsPending === operation &&
          !operation.abort.signal.aborted &&
          !signal.aborted &&
          loaded === active &&
          host === active.host &&
          binding?.sessionId === active.binding.sessionId &&
          binding.evidenceSHA256 === active.binding.evidenceSHA256 &&
          binding.runtimeConfigurationSHA256 === active.binding.runtimeConfigurationSHA256 &&
          phase === 'active' &&
          latest?.phase === 'active' &&
          !busy &&
          !resourcesPending &&
          !closing &&
          !revoking &&
          !revocationFailed &&
          !disposePending &&
          reader.isAvailable()
        )
      }
      connectionsPending = operation
      const abort = (): void => operation.abort.abort()
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (!live()) return undefined
        const result = await read.call(reader, operation.abort.signal)
        if (!live() || result.status !== 'connections') return undefined
        if (!live()) return undefined
        return {
          owner: {
            kind: 'tun-managed',
            instanceId: active.binding.sessionId,
            configurationRevision: active.binding.runtimeConfigurationSHA256,
            evidenceSHA256: active.binding.evidenceSHA256
          },
          snapshot: result.snapshot
        }
      } catch {
        return undefined
      } finally {
        signal.removeEventListener('abort', abort)
        if (connectionsPending === operation) connectionsPending = undefined
      }
    },
    async readTraffic(signal: AbortSignal): Promise<RelayTunTrafficSample | undefined> {
      const active = loaded,
        reader = active?.host.runtimeReader,
        read = reader?.traffic
      if (!active || !reader || !read || signal.aborted || trafficPending) return undefined
      const operation = { abort: new AbortController() },
        wallStart = now(),
        monoStart = monotonicNow()
      let lastWall = wallStart,
        lastMono = monoStart
      const live = (): boolean => {
        const wall = now(),
          mono = monotonicNow()
        const fresh =
          Number.isSafeInteger(wallStart) &&
          Number.isFinite(monoStart) &&
          Number.isSafeInteger(wall) &&
          Number.isFinite(mono) &&
          wall >= lastWall &&
          mono >= lastMono &&
          wall - wallStart < floatingTrafficFreshMS &&
          mono - monoStart < floatingTrafficFreshMS
        lastWall = wall
        lastMono = mono
        return (
          fresh &&
          trafficPending === operation &&
          !operation.abort.signal.aborted &&
          !signal.aborted &&
          loaded === active &&
          host === active.host &&
          binding?.sessionId === active.binding.sessionId &&
          binding.evidenceSHA256 === active.binding.evidenceSHA256 &&
          binding.runtimeConfigurationSHA256 === active.binding.runtimeConfigurationSHA256 &&
          phase === 'active' &&
          latest?.phase === 'active' &&
          !busy &&
          !resourcesPending &&
          !closing &&
          !revoking &&
          !revocationFailed &&
          !disposePending &&
          reader.isAvailable()
        )
      }
      trafficPending = operation
      const abort = (): void => operation.abort.abort()
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (!live()) return undefined
        const result = await read.call(reader, operation.abort.signal)
        if (!live() || result.status !== 'sampled') return undefined
        const sample = copyFloatingTrafficSample({
          ...result.frame,
          kind: 'tun-managed',
          ...active.binding,
          receivedAt: wallStart
        })
        if (!live() || !sample || !('kind' in sample)) return undefined
        // Include the final check and preserve already-spent monotonic time
        // when the wall clock stalls/lags. Round the duration before epoch
        // subtraction so sub-ms time is not lost to large-number rounding.
        const age = Math.ceil(Math.max(lastWall - wallStart, lastMono - monoStart)),
          receivedAt = lastWall - age
        if (age >= floatingTrafficFreshMS || !Number.isSafeInteger(receivedAt) || receivedAt < 0)
          return undefined
        return Object.freeze({ ...sample, receivedAt })
      } catch {
        return undefined
      } finally {
        signal.removeEventListener('abort', abort)
        if (trafficPending === operation) trafficPending = undefined
      }
    },
    async captureRuntime(
      expectedProxyPort: number,
      signal: AbortSignal
    ): Promise<TunRuntimeCaptureResult> {
      if (signal.aborted) return { status: 'unavailable' }
      const active = loaded,
        reader = active?.host.runtimeReader
      if (!active || !reader) return { status: 'unsupported' }
      let rejected = false,
        lastMode: string | undefined
      const owned = (): boolean =>
        !rejected &&
        loaded === active &&
        host === active.host &&
        binding?.sessionId === active.binding.sessionId &&
        phase === 'active' &&
        latest?.phase === 'active' &&
        !closing &&
        !revoking &&
        !revocationFailed &&
        !disposePending
      if (!owned()) return { status: 'unavailable' }
      if (busy || resourcesPending) return { status: 'busy' }
      if (
        !Number.isInteger(expectedProxyPort) ||
        expectedProxyPort < 1024 ||
        expectedProxyPort > 65535 ||
        Buffer.byteLength(active.configuration) > 512 * 1024
      )
        return { status: 'unsupported' }
      const original: Record<string, unknown> = JSON.parse(active.configuration)
      const read = async (abort: AbortSignal) => {
        if (abort.aborted || !owned()) return { status: 'unavailable' as const }
        const observed = await reader.capture(abort)
        if (abort.aborted || !owned()) return { status: 'unavailable' as const }
        if (observed.status !== 'captured') return observed
        const value = observed.snapshot
        if (
          value.originalLoadedSHA256 !== active.binding.runtimeConfigurationSHA256 ||
          value.originalLoadedBytes !== Buffer.byteLength(active.configuration) ||
          !value.ports.some(
            (port) =>
              port.port === expectedProxyPort &&
              original[port.kind === 'http' ? 'port' : 'mixed-port'] === port.port
          )
        ) {
          rejected = true
          return { status: 'unavailable' as const }
        }
        lastMode = value.mode
        active.mode = value.mode
        active.ports = value.ports.map((port) => port.port)
        return observed
      }
      try {
        const observed = await read(signal)
        if (observed.status !== 'captured') return observed
        if (busy || resourcesPending) return { status: 'busy' }
        const mode = observed.snapshot.mode,
          configuration = JSON.stringify({ ...original, mode }, null, 2) + '\n',
          isOwnerLive = (): boolean => owned() && reader.isAvailable(),
          isCurrent = (): boolean =>
            isOwnerLive() && !busy && lastMode === mode && active.mode === mode
        if (Buffer.byteLength(configuration) > 512 * 1024) return { status: 'unsupported' }
        return {
          status: 'captured',
          capture: {
            snapshot: Object.freeze({
              instanceId: active.binding.sessionId,
              revision: active.binding.runtimeConfigurationSHA256,
              configuration,
              proxyPort: expectedProxyPort,
              source: Object.freeze({
                kind: 'tun-managed' as const,
                sessionId: active.binding.sessionId
              })
            }),
            capturedAt: now(),
            isCurrent,
            isOwnerLive,
            assertOwner: async (abort) => {
              const next = await read(abort)
              if (next.status !== 'captured' || !isOwnerLive()) {
                if (next.status !== 'busy') rejected = true
                throw new Error('TUN运行读取或监听归属未确认。')
              }
            }
          }
        }
      } catch {
        return { status: 'unavailable' }
      }
    },
    assertRuntime(expected: {
      instanceId: string
      revision: string
      proxyPort: number
      configuration: string
    }): void {
      if (
        !loaded ||
        host !== loaded.host ||
        busy ||
        closing ||
        revoking ||
        phase !== 'active' ||
        latest?.phase !== 'active' ||
        !loaded.host.runtimeReader?.isAvailable() ||
        loaded.binding.sessionId !== expected.instanceId ||
        loaded.binding.runtimeConfigurationSHA256 !== expected.revision ||
        !loaded.ports?.includes(expected.proxyPort) ||
        !loaded.mode ||
        JSON.stringify({ ...JSON.parse(loaded.configuration), mode: loaded.mode }, null, 2) +
          '\n' !==
          expected.configuration
      )
        throw new Error('本次TUN运行正文或会话已变化。')
    },
    isBusy: (): boolean => busy || !!rulesPending || !!resourcesPending || !!closing || !!revoking,
    isBlocking: (): boolean => busy || !!host || !!closing || !!revoking,
    whenIdle,
    invalidatePending,
    clear: invalidatePending,
    async prepare(raw: unknown): Promise<TunSessionPreparation> {
      const request = tunPlanRequest(raw)
      if (busy || host || closing || revoking) throw new Error('请先结束本次TUN会话或恢复操作。')
      begin()
      proof = undefined
      const epoch = ++generation
      try {
        const candidate = await adapters.readCandidate(request),
          evidence = cloneEvidence(candidate.evidence),
          runtime = (
            adapters.execution === 'core-managed'
              ? prepareTunCoreRuntime
              : prepareTunDescriptorRuntime
          )(request, evidence, now())
        if (epoch !== generation || closing) throw new Error('准备期间凭据已失效。')
        const output = { ...runtime.preparation, evidenceId: randomUUID() }
        proof = {
          public: structuredClone(output),
          request,
          candidate: {
            evidence,
            profileId: candidate.profileId,
            fixedGroups: structuredClone(candidate.fixedGroups),
            readSavedSelectors: candidate.readSavedSelectors,
            recheck: () => candidate.recheck()
          },
          runtime,
          generation: epoch
        }
        phase = 'prepared'
        warnings = []
        return structuredClone(output)
      } catch (error) {
        phase = 'idle'
        throw error
      } finally {
        end()
      }
    },
    async start(raw: unknown): Promise<TunSessionResult> {
      const id = profileEvidence(raw),
        current = proof
      if (
        busy ||
        revoking ||
        host ||
        closing ||
        !current ||
        current.public.evidenceId !== id ||
        current.generation !== generation
      )
        throw new Error('请重新准备并核对本次TUN配置。')
      proof = undefined
      begin()
      let failureStage = 'preparation-validity'
      const live = (): void => {
        if (
          current.generation !== generation ||
          closing ||
          !tunRuntimeIsCurrent(current.runtime, current.request, current.candidate.evidence, now())
        )
          throw new Error('本次TUN准备、来源或授权时效已变化。')
      }
      try {
        live()
        failureStage = 'confirmation'
        if (!(await adapters.confirmStart(structuredClone(current.public)))) {
          phase = 'idle'
          return result('cancelled')
        }
        failureStage = 'candidate-recheck'
        await current.candidate.recheck()
        failureStage = 'confirmed-preparation-validity'
        live()
        failureStage = 'session-binding'
        binding = {
          sessionId: randomUUID(),
          evidenceSHA256: current.runtime.preparation.evidenceSHA256,
          runtimeConfigurationSHA256: current.runtime.runtimeConfigurationSHA256
        }
        if (!uuid(binding.sessionId) || !tunDigest(binding.evidenceSHA256)) throw new Error()
        phase = 'starting'
        notify()
        failureStage = 'host-open'
        const opened = await adapters.openHost(
          structuredClone(current.runtime),
          { ...binding },
          {
            sourceConfiguration: current.candidate.evidence.configuration,
            assets: current.candidate.evidence.assets.map(({ bytes, ...asset }) => ({
              ...structuredClone(asset),
              bytes: Buffer.from(bytes)
            })),
            pins: structuredClone(current.candidate.evidence.pins)
          },
          (owner) => {
            if (host && host !== owner) throw new Error('一次TUN启动只能注册一个本次宿主。')
            host = owner
            if (current.generation !== generation || closing) revokeActivation(owner)
          }
        )
        // Retain a returned capability even if an adapter violated registration;
        // never discard a possibly live resource after a protocol error.
        failureStage = 'host-registration'
        const owner = currentHost()
        if (!owner) {
          host = opened
          throw new Error('原生宿主没有在启动前注册恢复能力。')
        }
        if (owner !== opened) throw new Error('原生宿主与恢复能力不一致。')
        failureStage = 'host-preparation-validity'
        live()
        if (current.runtime.version === 1) {
          failureStage = 'device-acquire'
          accept(await owner.acquire(), 'acquired')
          failureStage = 'acquired-preparation-validity'
          live()
        }
        failureStage = 'core-start'
        accept(await owner.startCore(), current.runtime.version === 2 ? 'active' : 'coreReady')
        failureStage = 'activation-recheck'
        await current.candidate.recheck()
        failureStage = 'activation-preparation-validity'
        live()
        if (current.runtime.version === 1) {
          failureStage = 'network-activate'
          accept(await owner.activate(), 'active')
        }
        if (current.candidate.readSavedSelectors) {
          failureStage = 'saved-selector-restore'
          const saved = await current.candidate.readSavedSelectors()
          live()
          if (saved.size) await restoreTunSavedSelectors(owner.proxyGroups, saved, live)
        }
        if (current.candidate.fixedGroups?.length) {
          failureStage = 'fixed-group-handoff'
          await applyTunFixedGroups(owner.proxyGroups, current.candidate.fixedGroups, live)
        }
        failureStage = 'active-preparation-validity'
        live()
        phase = 'active'
        if (current.runtime.version === 2)
          loaded = {
            host: owner,
            profileId: current.candidate.profileId,
            binding: { ...binding },
            configuration: current.runtime.configuration
          }
        warnings = []
        return result('started')
      } catch (error) {
        if (host) {
          const owned = host
          uncertain()
          revokeActivation(owned)
          if (current.runtime.version === 2) {
            // Starting this owned managed core also owns recovery of a failed
            // attempt. Preserve the legacy descriptor path and never request
            // fresh UI authority to undo an unsuccessful launch.
            await whenRevoked()
            ++generation
            await restoreOwned(owned, 'startup')
          }
        } else {
          binding = undefined
          latest = undefined
          phase = 'idle'
          warnings = ['启动前条件未通过，未取得TUN会话；请重新准备。']
        }
        const detail = error instanceof TunStartFailure ? `/${error.code}` : ''
        warnings.push(`TUN启动失败阶段：${failureStage}${detail}。`)
        return result(host || phase === 'uncertain' ? 'uncertain' : 'failed')
      } finally {
        if (!host && phase === 'prepared') phase = 'idle'
        end()
      }
    },
    async stop(raw: unknown): Promise<TunSessionResult> {
      if (sessionRequest(raw) !== binding?.sessionId || closing)
        throw new Error('本次TUN会话已经变化，请重新读取。')
      return stopCurrent('stop')
    },
    async inspect(raw?: unknown): Promise<TunSessionState> {
      if (raw !== undefined) throw new Error('TUN状态复核不接受参数。')
      if (busy || resourcesPending || closing || revoking)
        throw new Error('请等待当前TUN操作结束。')
      if (!host) return state()
      // A terminal host may already have closed its command channel. Preserve
      // its verified recovery and pending disposal rather than issue another
      // command or let a status receipt replace that terminal evidence.
      if (disposePending || releasedDisposePending) return state()
      begin()
      const epoch = generation
      try {
        accept(await host.inspect())
        if (epoch !== generation || revocationFailed || latest?.phase !== 'active') uncertain()
        else {
          phase = 'active'
          warnings = []
        }
        return { ...state(), pending: !!revoking }
      } catch {
        uncertain()
        return { ...state(), pending: !!revoking }
      } finally {
        end()
      }
    },
    cancel(raw: unknown): void {
      if (profileEvidence(raw) === proof?.public.evidenceId) invalidatePending()
    },
    requestClose(): Promise<boolean> {
      if (closing) return closing
      const close = async (): Promise<boolean> => {
        invalidatePending()
        await whenIdle()
        if (!host) return true
        await stopCurrent('quit')
        return !host
      }
      closing = close().finally(() => {
        closing = undefined
        notify()
      })
      notify()
      return closing
    }
  }
}
