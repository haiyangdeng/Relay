import { restoreSavedSelectors } from './startup-node'
import { randomUUID } from 'crypto'
import {
  smartToolsRequest,
  type SmartToolsInspection,
  type SmartToolsReply
} from '../../../shared/relay/smart-tools'
import {
  localProxyAction,
  localProxyPrepare,
  type LocalCoreLogLevel,
  type LocalReloadPreparation,
  type LocalProxyState,
  type LocalProxyPreparation,
  type LocalProxyResult,
  type LocalProxyRulesSnapshot,
  type LocalProxyRuleConfirmation,
  type LocalProxyGroup,
  type LocalResolverMode,
  type LocalProxyLifetime,
  type LocalResolutionSummary
} from '../../../shared/relay/local-proxy'
import {
  enabledLocalProxyPorts,
  localProxyPortsFor,
  localProxyPortsCompatible,
  localProxyPortsMatch,
  type LocalProxyPorts
} from '../../../shared/relay/local-proxy-ports'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'
import type { RuntimeLogSnapshot } from '../../../shared/relay/observability'
import { MissingRuntimeGeoDataError, type RuntimeProfileRead } from '../configuration/edit-service'
import type { RuntimeAsset } from '../configuration/bindings'
import { profileHash } from '../profiles/source'
import { groupTypes } from '../profiles/groups'
import { validateCoreMode, type RelayCoreMode } from '../../../shared/relay/core'
import { healthURL, assertOwnedHealthTestAvailable } from '../../../shared/relay/health'
import { reservedProfileTargets } from '../profiles/inspect'
import {
  dedicatedListenersCompatible,
  type DedicatedListenerPlan,
  type DedicatedListenerSummary
} from '../../../shared/relay/dedicated-listeners'
import { persistentCoreConfiguration } from '../core-owner/runtime'
import { readConnections, readLogs, type ConnectionSnapshot } from './owned-observe'
import type { CoreStoreLease, CoreStoreSnapshot, CoreLeaseRuntime } from './store'
import type { RelayCoreResource } from './resources'
import {
  OWNED_CORE_CONFIGURATION_TIMEOUT_WARNING,
  OwnedCoreConfigurationTimeoutError,
  type RelayOwnedCore,
  type OwnedCoreProfileOwner,
  type OwnedCoreCleanupRegistration
} from './owned-runtime'
import { smartCollectCSV, type SmartLearningStopResult } from './smart-state-runtime'
import { localProxyConfiguration } from './local-proxy-runtime'
import { compatibleLocalProxyGeoAssets } from './local-proxy-geo'
import { ownsHttpListener, ownsUdpListener, probeLocalUdpPort } from './port'
import { localProxyRulesSHA256, readLocalProxyRules } from './local-proxy-rules'
import type { OwnedTrafficSample } from './owned-traffic'

class LocalRuleScopeError extends Error {}

export interface LocalRuntimeCapture {
  snapshot: {
    instanceId: string
    revision: string
    configuration: string
    proxyPort: number
  }
  capturedAt: number
  isCurrent(): boolean
  isOwnerLive(): boolean
  assertOwner(signal: AbortSignal): Promise<void>
}
export type LocalRuntimeCaptureResult =
  | { status: 'captured'; capture: LocalRuntimeCapture }
  | { status: 'busy' }
  | { status: 'unavailable' }

export class LocalProxyMutationRefused extends Error {}

export function createLocalProxyService(adapters: {
  read(
    selection: RelayProfileSelection,
    resolverMode?: LocalResolverMode
  ): Promise<RuntimeProfileRead>
  resolvePinnedNode?(
    stored: RuntimeProfileRead,
    plan: DedicatedListenerPlan
  ): Promise<{ node: Record<string, unknown>; revision: string }>
  inspect(): Promise<CoreStoreSnapshot>
  resources(
    lifetime?: LocalProxyLifetime,
    runtimeAssets?: readonly RuntimeAsset[]
  ): Promise<RelayCoreResource>
  portAvailable(port: number): Promise<boolean>
  portAvailableUDP?(port: number): Promise<boolean>
  acquire(
    context: CoreLeaseRuntime,
    revision: string,
    lifetime?: LocalProxyLifetime
  ): Promise<CoreStoreLease>
  start(
    source: string,
    port: number,
    registerCleanup: OwnedCoreCleanupRegistration,
    resolverMode: LocalResolverMode,
    dedicated: DedicatedListenerPlan | undefined,
    owner: OwnedCoreProfileOwner,
    lifetime?: LocalProxyLifetime,
    logLevel?: LocalCoreLogLevel,
    runtimeAssets?: readonly RuntimeAsset[],
    ports?: LocalProxyPorts,
    pinnedNode?: Record<string, unknown>,
    selectors?: ReadonlyMap<string, string>
  ): Promise<RelayOwnedCore>
  confirmStart(preparation: LocalProxyPreparation, assertContext?: () => void): Promise<boolean>
  confirmStop(state: LocalProxyState, reason: 'stop' | 'quit'): Promise<boolean>
  confirmTest?(group: string, member: string, origin: string): Promise<boolean>
  confirmMode?(previous: RelayCoreMode, next: RelayCoreMode): Promise<boolean>
  confirmRule?(report: LocalProxyRuleConfirmation): Promise<boolean>
  confirmReload?(preparation: LocalReloadPreparation): Promise<boolean>
  rememberSelector?(profileId: string, group: string, member?: string): Promise<void>
  readSelectors?(profileId: string): Promise<Map<string, string>>
  beforeRuntimeMutation?(): Promise<void>
  onRuntimeChanging?(): void
  onRuntimeChanged?(): void
  ownsHttpListener?(pid: number, port: number): Promise<boolean>
  ownsUDPListener?(pid: number, port: number): Promise<boolean>
  now?(): number
}) {
  let phase: LocalProxyState['phase'] = 'unknown',
    busy = false,
    hasRecord = false,
    uncertain = false,
    abortStart = false,
    generation = 0,
    runtimeObservation = 0
  let smartToolsBusy = false
  let trafficEpoch = 0,
    trafficPending: { controller: AbortController; epoch: number } | undefined
  const cancelTraffic = (): void => {
    ++trafficEpoch
    // Cancelling this read must never wait for server EOF or delay lifecycle/lease release.
    trafficPending?.controller.abort()
  }
  let instanceId: string | undefined,
    lastEndedId: string | undefined,
    httpPort: number | undefined,
    profileName: string | undefined
  let ports: LocalProxyPorts | undefined
  const udpPorts = (value: LocalProxyPorts): number[] => [value.socks, value.mixed].filter(Boolean)
  const ownsOrdinaryListeners = async (
    pid: number,
    currentPorts: LocalProxyPorts
  ): Promise<boolean> =>
    (
      await Promise.all([
        ...enabledLocalProxyPorts(currentPorts).map((value) =>
          (adapters.ownsHttpListener ?? ownsHttpListener)(pid, value)
        ),
        ...udpPorts(currentPorts).map((value) =>
          (adapters.ownsUDPListener ?? ownsUdpListener)(pid, value)
        )
      ])
    ).every(Boolean)
  let lifetime: LocalProxyLifetime = 'main'
  let logLevel: LocalCoreLogLevel | undefined
  let resolution: LocalResolutionSummary | undefined
  let observedMode: RelayCoreMode | undefined
  let activeProfileId: string | undefined, runtimeConfiguration: string | undefined
  let runtimeAssets: readonly RuntimeAsset[] | undefined
  let learningOwner: symbol | undefined,
    learningPublishable = false,
    retainedLearningEvidence = false,
    learningPersisted = false,
    learningStopResult: (() => SmartLearningStopResult | undefined) | undefined
  let dedicated: DedicatedListenerSummary | undefined, livePid: number | undefined
  let session: RelayOwnedCore | undefined,
    lease: CoreStoreLease | undefined,
    cleanup: (() => Promise<void>) | undefined
  let groups: LocalProxyGroup[] = [],
    warnings: string[] = []
  let definitions: LocalProxyGroup[] = []
  let ending: Promise<LocalProxyResult> | undefined,
    closing: Promise<'closed' | 'cancelled' | 'failed'> | undefined
  let stoppingRequest: Promise<LocalProxyResult> | undefined
  let proof:
    | {
        report: LocalProxyPreparation
        selection: RelayProfileSelection
        sourceRevision: string
        pinnedNodeRevision?: string
        coreRevision: string
        resourceSHA256: string
        at: number
      }
    | undefined
  let reloadProof:
    | {
        report: LocalReloadPreparation
        selection: RelayProfileSelection
        revision: string
        pinnedNodeRevision?: string
        configuration: string
        selectors: Map<string, string>
        built: ReturnType<typeof localProxyConfiguration>
        at: number
        generation: number
      }
    | undefined
  const now = adapters.now ?? Date.now,
    waiters: (() => void)[] = []
  const owned = (): boolean => !!session || !!lease || !!cleanup
  const readSelectors = (profileId: string): Promise<Map<string, string>> =>
    adapters.readSelectors?.(profileId) ?? Promise.resolve(new Map())
  const learningWarnings = (): string[] =>
    retainedLearningEvidence
      ? [
          learningPersisted
            ? 'Smart学习状态已保存；本次部分收尾资料已保留。'
            : 'Smart学习状态保存结果未确认；旧版本与本次工作资料均保留。'
        ]
      : []
  const assertLearningReload = (profileUUID: string, parsed: Record<string, unknown>): void => {
    const binding = session?.smartStateBinding
    if (
      binding &&
      (profileUUID !== binding.profileUUID || smartCollectCSV(parsed) !== binding.collectCSV)
    )
      throw new Error('Smart学习状态绑定当前配置及采集开关；请明确停止后重新启动。')
  }
  const begin = (): void => {
    busy = true
    try {
      adapters.onRuntimeChanging?.()
    } catch {
      // Revocation observers cannot prevent an owned operation or its cleanup.
    }
  }
  const end = (): void => {
    busy = false
    ++runtimeObservation
    waiters.splice(0).forEach((resolve) => resolve())
    try {
      adapters.onRuntimeChanged?.()
    } catch {
      // An observer cannot change an already settled core operation.
    }
  }
  const whenIdle = (): Promise<void> =>
    busy ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const state = (): LocalProxyState => {
    const child = session?.state()
    return {
      phase: child === 'unexpectedExit' ? 'failed' : phase,
      pending: busy || !!closing,
      owned: owned(),
      hasRecord,
      uncertain: uncertain || (lifetime === 'persistent' && child === 'unexpectedExit'),
      instanceId,
      httpPort,
      ports: ports ? { ...ports } : undefined,
      mode: child === 'running' && phase === 'running' ? observedMode : undefined,
      profileName,
      profileId: activeProfileId,
      configurationRevision: runtimeConfiguration ? profileHash(runtimeConfiguration) : undefined,
      lifetime,
      ...(child === 'running' && phase === 'running' && logLevel ? { logLevel } : {}),
      resolution: resolution ? { ...resolution } : undefined,
      pid: livePid,
      dedicated: dedicated ? { ...dedicated } : undefined,
      traffic:
        child === 'running' && phase === 'running'
          ? 'listening'
          : lifetime === 'persistent' && child === 'unexpectedExit'
            ? 'unconfirmed'
            : child === 'stopped' || child === 'unexpectedExit' || !cleanup
              ? 'inactive'
              : 'unconfirmed',
      groups: structuredClone(
        !session || child === 'unexpectedExit' || child === 'stopped'
          ? groups.map((group) => ({
              ...group,
              testURL: group.testURL ? new URL(group.testURL).origin : undefined,
              now: undefined,
              fixed: undefined,
              health: undefined,
              confirmed: false
            }))
          : groups.map((group) => ({
              ...group,
              testURL: group.testURL ? new URL(group.testURL).origin : undefined
            }))
      ),
      systemProxyChanged: false,
      liveGuardEnabled: false,
      warnings: [
        ...warnings,
        ...(child === 'unexpectedExit'
          ? [
              lifetime === 'persistent'
                ? '持久owner连接或控制未确认，不等于Core已经退出；没有自动接回或重启，请通过持久面板核对。'
                : '本次代理意外退出；没有自动重启，请清理本次会话。'
            ]
          : [])
      ]
    }
  }
  const result = (status: LocalProxyResult['status']): LocalProxyResult => ({
    status,
    state: { ...state(), pending: false }
  })
  const liveGroups = async (): Promise<LocalProxyGroup[]> => {
    if (!session) throw new Error()
    const value = (await session.read('proxies')).proxies
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    const map = new Map(Object.entries(value))
    if (definitions.some((g) => g.providers?.length)) {
      const raw = (await session.read('providers/proxies')).providers
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error()
      for (const name of new Set(definitions.flatMap((g) => g.providers ?? []))) {
        const provider = Object.hasOwn(raw, name)
          ? (raw as Record<string, { proxies?: unknown }>)[name]
          : undefined
        if (!provider || !Array.isArray(provider.proxies) || provider.proxies.length > 2000)
          throw new Error()
        for (const node of provider.proxies) {
          if (!node || typeof node !== 'object' || typeof node.name !== 'string') throw new Error()
          map.set(node.name, node)
        }
      }
    }
    return definitions.map((expected) => {
      const raw = map.get(expected.name)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error()
      const group = raw as Record<string, unknown>
      const smartAutomatic =
        expected.type === 'smart' && group.now === 'Smart - Select' && group.fixed === ''
      if (
        group.type !== groupTypes[expected.type ?? 'select'] ||
        !Array.isArray(group.all) ||
        !group.all.length ||
        group.all.length > 2000 ||
        group.all.some((name) => typeof name !== 'string' || !expected.members.includes(name)) ||
        (!expected.dynamic && JSON.stringify(group.all) !== JSON.stringify(expected.members)) ||
        (expected.type === 'smart'
          ? !smartAutomatic &&
            (typeof group.fixed !== 'string' ||
              !group.fixed ||
              group.fixed !== group.now ||
              !group.all.includes(group.fixed))
          : expected.type !== 'load-balance' &&
            (typeof group.now !== 'string' || !group.all.includes(group.now)))
      )
        throw new Error()
      const members = group.all as string[]
      return {
        ...expected,
        members,
        now: smartAutomatic ? undefined : typeof group.now === 'string' ? group.now : undefined,
        fixed:
          typeof group.fixed === 'string' && (!group.fixed || members.includes(group.fixed))
            ? group.fixed
            : undefined,
        health: members.map((name) => {
          const raw = map.get(name)
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { name }
          const node = raw as Record<string, unknown>
          const extra = node.extra as
            Record<string, { alive?: boolean; history?: unknown[] }> | undefined
          const perURL =
            expected.testURL && extra && typeof extra === 'object'
              ? extra[expected.testURL]
              : undefined
          const history = expected.testURL ? perURL?.history : node.history
          const last = Array.isArray(history) ? history.at(-1) : undefined
          const entry =
            last && typeof last === 'object' ? (last as Record<string, unknown>) : undefined
          return {
            name,
            alive: expected.testURL
              ? perURL?.alive
              : typeof node.alive === 'boolean'
                ? node.alive
                : undefined,
            delay:
              typeof entry?.delay === 'number' &&
              Number.isInteger(entry.delay) &&
              entry.delay >= 0 &&
              entry.delay <= 65535
                ? entry.delay
                : undefined,
            at:
              typeof entry?.time === 'string' && Number.isFinite(Date.parse(entry.time))
                ? entry.time
                : undefined
          }
        }),
        confirmed: true
      }
    })
  }
  const clearEndedPersistentMemory = (): void => {
    session = undefined
    cleanup = undefined
    lease = undefined
    learningOwner = undefined
    learningPublishable = false
    learningStopResult = undefined
    lastEndedId = instanceId
    instanceId = undefined
    groups = []
    definitions = []
    observedMode = undefined
    activeProfileId = undefined
    runtimeConfiguration = undefined
    runtimeAssets = undefined
    dedicated = undefined
    ports = undefined
    livePid = undefined
    phase = 'idle'
    hasRecord = false
    uncertain = false
    warnings = []
  }
  const finish = (
    releaseBusy = true,
    verifyBeforeStop?: () => Promise<boolean>
  ): Promise<LocalProxyResult> => {
    if (ending) return ending
    cancelTraffic()
    ending = (async () => {
      try {
        await adapters.beforeRuntimeMutation?.()
        if (verifyBeforeStop && !(await verifyBeforeStop())) {
          ending = undefined
          return result('cancelled')
        }
      } catch (error) {
        ending = undefined
        if (error instanceof LocalProxyMutationRefused) return result('cancelled')
        throw error
      }
      begin()
      phase = 'stopping'
      proof = undefined
      ++generation
      try {
        try {
          await lease?.update('stopping', session?.pid)
        } catch {
          learningPublishable = false
          warnings = ['记录复核失败，仍将仅结束本次持有的子进程。']
        }
        if (cleanup) await cleanup()
        else await session?.stop()
        const learningResult = learningStopResult?.() ?? session?.smartStateStopResult?.()
        if (learningResult) {
          retainedLearningEvidence ||= learningResult.retainedEvidence
          learningPersisted ||= learningResult.status === 'persisted'
        }
        session = undefined
        cleanup = undefined
        await lease?.release()
        lease = undefined
        learningOwner = undefined
        learningPublishable = false
        learningStopResult = undefined
        lastEndedId = instanceId
        instanceId = undefined
        groups = []
        definitions = []
        observedMode = undefined
        activeProfileId = undefined
        runtimeConfiguration = undefined
        runtimeAssets = undefined
        dedicated = undefined
        ports = undefined
        livePid = undefined
        phase = 'idle'
        hasRecord = false
        uncertain = false
        warnings = ['本次本地代理已停止；系统代理和现有Clash没有改动。', ...learningWarnings()]
        return result('stopped')
      } catch {
        phase = 'failed'
        uncertain = true
        warnings = [
          '本次代理退出或记录清理未确认，保留实例、记录和窗口供重试；没有强杀或按磁盘PID操作其他核心。'
        ]
        return result('uncertain')
      } finally {
        if (releaseBusy) end()
        ending = undefined
      }
    })()
    return ending
  }
  return {
    async smartTools(
      raw: unknown,
      confirmClear: (inspection: SmartToolsInspection) => Promise<boolean> = async () => false
    ): Promise<SmartToolsReply> {
      const request = smartToolsRequest(raw)
      if (request.target !== 'ordinary') throw new Error('Smart工具实例类别不符。')
      const current = session,
        heldLease = lease,
        heldOwner = learningOwner,
        id = instanceId
      const context = (): SmartToolsInspection => {
        if (
          !current ||
          !id ||
          !heldLease ||
          !heldOwner ||
          session !== current ||
          lease !== heldLease ||
          learningOwner !== heldOwner ||
          !learningPublishable ||
          instanceId !== id ||
          phase !== 'running' ||
          uncertain ||
          closing ||
          ending ||
          stoppingRequest ||
          current.state() !== 'running' ||
          !current.smartToolsDefinition
        )
          throw new Error('本次Smart核心已撤销。')
        const definition = current.smartToolsDefinition()
        const expected = definitions
          .filter((group) => group.type === 'smart')
          .map((group) => group.name)
        if (JSON.stringify([...definition.groups].sort()) !== JSON.stringify(expected.sort()))
          throw new Error('Smart组与持有配置不符。')
        return { target: 'ordinary', instanceId: id, available: true, ...definition }
      }
      let initial: SmartToolsInspection
      try {
        initial = context()
      } catch {
        return { status: 'unavailable' }
      }
      if (request.action === 'inspect') return { status: 'ready', inspection: initial }
      if (smartToolsBusy) return { status: 'busy' }
      if (
        request.instanceId !== initial.instanceId ||
        request.configurationRevision !== initial.configurationRevision ||
        (request.action === 'weights' && !initial.groups.includes(request.group))
      )
        return { status: 'unavailable' }
      const assertLive = (): void => {
        const fresh = context()
        if (
          fresh.configurationRevision !== initial.configurationRevision ||
          JSON.stringify(fresh.groups) !== JSON.stringify(initial.groups)
        )
          throw new Error('Smart配置已变化。')
      }
      smartToolsBusy = true
      let submitted = false
      try {
        if (request.action === 'weights') {
          assertLive()
          if (!current?.smartWeights) return { status: 'unsupported' }
          const snapshot = await current.smartWeights({ assertLive })
          assertLive()
          const group = snapshot.groups.find((group) => group.name === request.group)
          if (
            snapshot.configurationRevision !== initial.configurationRevision ||
            !group ||
            group.status !== 'ready'
          )
            return { status: 'unavailable' }
          return { status: 'weights', weights: group.weights }
        }
        // Tool IO has its own single-flight bit: holding a confirmation or a
        // lost response never marks lifecycle recovery busy or stops the Core.
        if (!(await confirmClear(structuredClone(initial)))) return { status: 'cancelled' }
        assertLive()
        if (!current?.clearSmartCache) return { status: 'unsupported' }
        await current.clearSmartCache({
          assertLive,
          submitted: () => {
            submitted = true
          }
        })
        assertLive()
        return { status: 'accepted' }
      } catch {
        return {
          status: submitted
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
    whenIdle,
    async captureRuntime(signal: AbortSignal): Promise<LocalRuntimeCaptureResult> {
      if (signal.aborted) throw new Error('已取消运行配置捕获。')
      const current = session,
        id = instanceId,
        port = httpPort,
        capturedPorts = ports,
        source = runtimeConfiguration,
        observation = runtimeObservation
      let ownerRejected = false,
        lastReadMode: RelayCoreMode | undefined
      const isOwnerLive = (): boolean =>
        !!current &&
        !!id &&
        !!port &&
        session === current &&
        instanceId === id &&
        httpPort === port &&
        ports === capturedPorts &&
        phase === 'running' &&
        current.state() === 'running' &&
        !uncertain &&
        !ownerRejected &&
        !closing &&
        !stoppingRequest
      if (!isOwnerLive() || !current || !id || !port || !capturedPorts || !source)
        return { status: 'unavailable' }
      if (busy) return { status: 'busy' }
      const readOwner = async (activeSignal: AbortSignal): Promise<Record<string, unknown>> => {
        if (activeSignal.aborted || !isOwnerLive()) throw new Error('本次运行实例已失效。')
        const [config, version, owns] = await Promise.all([
          current.read('configs'),
          current.read('version'),
          ownsOrdinaryListeners(current.pid, capturedPorts)
        ])
        if (
          activeSignal.aborted ||
          !isOwnerLive() ||
          !localProxyPortsMatch(config, capturedPorts) ||
          version.version !== current.version ||
          !owns
        ) {
          ownerRejected = true
          throw new Error('本次运行实例或监听归属未确认。')
        }
        lastReadMode = validateCoreMode(config.mode)
        return config
      }
      try {
        const config = await readOwner(signal)
        if (!isOwnerLive()) return { status: 'unavailable' }
        if (busy || runtimeObservation !== observation || runtimeConfiguration !== source)
          return { status: 'busy' }
        const mode = validateCoreMode(config.mode),
          runtime: Record<string, unknown> = JSON.parse(source)
        observedMode = mode
        runtime.mode = mode
        const isCurrent = (): boolean =>
          isOwnerLive() &&
          !busy &&
          runtimeConfiguration === source &&
          observedMode === mode &&
          lastReadMode === mode
        const capture: LocalRuntimeCapture = {
          snapshot: Object.freeze({
            instanceId: id,
            revision: profileHash(source),
            configuration: JSON.stringify(runtime, null, 2) + '\n',
            proxyPort: port
          }),
          capturedAt: now(),
          isCurrent,
          isOwnerLive,
          assertOwner: async (activeSignal) => {
            await readOwner(activeSignal)
          }
        }
        return { status: 'captured', capture }
      } catch {
        if (signal.aborted) throw new Error('已取消运行配置捕获。')
        return busy && isOwnerLive() && !ownerRejected
          ? { status: 'busy' }
          : { status: 'unavailable' }
      }
    },
    clear(): void {
      cancelTraffic()
      proof = undefined
      reloadProof = undefined
      ++generation
    },
    isBlocking: (): boolean => busy || owned() || !!closing,
    acknowledgeArchivedPersistentOwner(): void {
      if (
        lifetime !== 'persistent' ||
        busy ||
        closing ||
        ending ||
        stoppingRequest ||
        (session && !['stopped', 'unexpectedExit'].includes(session.state()))
      )
        throw new Error('Persistent instance still active')
      // Main calls only after the fixed signed recovery helper has positively
      // proved both processes gone and returned an archived durable receipt.
      clearEndedPersistentMemory()
    },
    acknowledgeRetiredPersistentOwner(): void {
      if (
        lifetime !== 'persistent' ||
        busy ||
        closing ||
        ending ||
        stoppingRequest ||
        (session && !['stopped', 'unexpectedExit'].includes(session.state()))
      )
        throw new Error('Persistent references still active')
      // Main has closed/own-serve-gone/native-clear proof. Forget only this
      // old delegate; no file release/delete or PID operation is performed.
      clearEndedPersistentMemory()
    },
    async finalizePersistentOwner(): Promise<LocalProxyResult> {
      if (
        lifetime !== 'persistent' ||
        busy ||
        closing ||
        ending ||
        stoppingRequest ||
        !lease ||
        (session && !['stopped', 'unexpectedExit'].includes(session.state()))
      )
        throw new Error('No closed persistent lease')
      begin()
      try {
        // Native release itself requires fresh original held-child closed facts;
        // no stop is dispatched by this explicit finalization-only path.
        await lease.release()
        clearEndedPersistentMemory()
        return result('stopped')
      } catch {
        uncertain = true
        return result('uncertain')
      } finally {
        end()
      }
    },
    finishPersistentOwner(): Promise<LocalProxyResult> {
      if (lifetime !== 'persistent' || busy || closing || !owned())
        throw new Error('No held persistent instance')
      return finish()
    },
    invalidatePending(): void {
      cancelTraffic()
      proof = undefined
      reloadProof = undefined
      ++generation
      if (busy) abortStart = true
    },
    async prepareReload(raw: unknown): Promise<LocalReloadPreparation> {
      const selected = localProxyPrepare(raw)
      if (selected.logLevel !== undefined) throw new Error('日志级别只能在普通核心下次启动前选择。')
      if (
        busy ||
        closing ||
        stoppingRequest ||
        phase !== 'running' ||
        !session?.reload ||
        !lease?.updateRuntime ||
        !instanceId ||
        !runtimeConfiguration ||
        session.state() !== 'running' ||
        selected.httpPort !== httpPort ||
        !ports ||
        !localProxyPortsCompatible(localProxyPortsFor(selected.httpPort, selected.ports), ports)
      )
        throw new Error('请选择本次自有运行实例和相同监听端口。')
      begin()
      reloadProof = undefined
      const id = instanceId,
        actionGeneration = generation
      try {
        const stored = await adapters.read(selected.profile, selected.resolverMode),
          pin = selected.dedicated
            ? await adapters.resolvePinnedNode?.(stored, selected.dedicated)
            : undefined,
          config = await session.read('configs')
        if (
          closing ||
          stoppingRequest ||
          generation !== actionGeneration ||
          id !== instanceId ||
          session.state() !== 'running'
        )
          throw new Error()
        const mode = validateCoreMode(config.mode),
          previous: Record<string, unknown> = JSON.parse(runtimeConfiguration)
        if (
          !ports ||
          !localProxyPortsMatch(config, ports) ||
          (logLevel !== undefined && config['log-level'] !== logLevel)
        )
          throw new Error()
        if (!dedicatedListenersCompatible(dedicated, selected.dedicated))
          throw new Error('本次热载不能更换专用监听端口或路由；请停止后重新准备。')
        if (!compatibleLocalProxyGeoAssets(runtimeAssets, stored.runtimeAssets))
          throw new Error(
            '本次热载不能更换已固定的地理数据库；请明确停止本次 Relay 代理后重新启动。'
          )
        previous.mode = mode
        const selectors = await readSelectors(stored.profile.id)
        const built = localProxyConfiguration(
            stored.text,
            selected.httpPort,
            selected.resolverMode,
            selected.dedicated,
            logLevel,
            stored.runtimeAssets,
            selected.ports,
            pin?.node,
            selectors
          ),
          candidate: Record<string, unknown> = JSON.parse(built.configuration)
        candidate.mode = mode
        assertLearningReload(stored.profile.id, candidate)
        const configuration = JSON.stringify(candidate)
        const report: LocalReloadPreparation = {
          evidenceId: randomUUID(),
          instanceId: id,
          profile: stored.profile,
          httpPort: selected.httpPort,
          ports: { ...built.ports },
          previousSHA256: profileHash(JSON.stringify(previous)),
          runtimeSHA256: profileHash(configuration),
          scope: 'controlled-local-projection',
          warnings: [
            '仅热载本次自有核心受控投影，保留监听端口与当前模式；完整候选启用及系统接管仍由后续流程处理。',
            '将更新节点、组、规则及所选受支持DNS/hosts；核心会重建相应状态，新连接可能短暂失败，既有连接也可能受源变化影响。没有强制重建监听器、自动关闭全部连接或重启回退。'
          ]
        }
        reloadProof = {
          report,
          selection: selected.profile,
          revision: stored.revision,
          pinnedNodeRevision: pin?.revision,
          configuration,
          selectors,
          built,
          at: now(),
          generation: actionGeneration
        }
        return structuredClone(report)
      } finally {
        end()
      }
    },
    async reload(raw: unknown): Promise<LocalProxyResult> {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).join(',') !== 'evidenceId'
      )
        throw new Error('热载只接受本次准备凭据。')
      const current = reloadProof,
        evidenceId = (raw as { evidenceId?: unknown }).evidenceId
      const fresh = (): boolean =>
        !!current &&
        reloadProof === current &&
        evidenceId === current.report.evidenceId &&
        current.generation === generation &&
        now() >= current.at &&
        now() - current.at <= 60000 &&
        current.report.instanceId === instanceId &&
        !closing &&
        !stoppingRequest &&
        session?.state() === 'running' &&
        phase === 'running'
      if (busy || !fresh() || !current || !session?.reload || !lease?.updateRuntime)
        throw new Error('请重新准备本次自有实例的热载。')
      cancelTraffic()
      begin()
      let applied = false
      try {
        if (!(await adapters.confirmReload?.(structuredClone(current.report)))) {
          reloadProof = undefined
          return result('cancelled')
        }
        const stored = await adapters.read(current.selection, current.built.resolution.mode),
          pin = current.built.dedicated
            ? await adapters.resolvePinnedNode?.(stored, current.built.dedicated)
            : undefined,
          config = await session.read('configs')
        const selectors = await readSelectors(stored.profile.id)
        const previous: Record<string, unknown> = JSON.parse(runtimeConfiguration ?? '{}')
        previous.mode = validateCoreMode(config.mode)
        if (
          !fresh() ||
          selectors.size !== current.selectors.size ||
          [...selectors].some(([group, member]) => current.selectors.get(group) !== member) ||
          stored.revision !== current.revision ||
          pin?.revision !== current.pinnedNodeRevision ||
          !compatibleLocalProxyGeoAssets(runtimeAssets, stored.runtimeAssets) ||
          profileHash(JSON.stringify(previous)) !== current.report.previousSHA256 ||
          !ports ||
          !localProxyPortsMatch(config, ports) ||
          (logLevel !== undefined && config['log-level'] !== logLevel)
        )
          throw new Error()
        assertLearningReload(
          stored.profile.id,
          JSON.parse(current.configuration) as Record<string, unknown>
        )
        await adapters.beforeRuntimeMutation?.()
        reloadProof = undefined
        if (
          closing ||
          stoppingRequest ||
          current.generation !== generation ||
          session.state() !== 'running'
        )
          throw new Error()
        applied = true
        const receipt = session.smartStateBinding
          ? await session.reload(
              current.configuration,
              current.report.previousSHA256,
              stored.profile.id,
              stored.runtimeAssets
            )
          : await session.reload(
              current.configuration,
              current.report.previousSHA256,
              undefined,
              stored.runtimeAssets
            )
        if (receipt.runtimeSHA256 !== current.report.runtimeSHA256 || session.state() !== 'running')
          throw new Error()
        if (logLevel !== undefined && (await session.read('configs'))['log-level'] !== logLevel)
          throw new Error('本次核心日志级别未能复核。')
        await lease.updateRuntime({
          kind: 'localProxy',
          httpPort: current.report.httpPort,
          ports: { ...current.built.ports },
          profileId: stored.profile.id,
          sourceSHA256: stored.profile.sha256,
          resolverMode: current.built.resolution.mode
        })
        runtimeConfiguration = current.configuration
        runtimeAssets = [
          ...(runtimeAssets ?? []),
          ...(stored.runtimeAssets ?? [])
            .filter((asset) => !(runtimeAssets ?? []).some((pinned) => pinned.path === asset.path))
            .map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes) }))
        ]
        const profileChanged = activeProfileId !== stored.profile.id
        activeProfileId = stored.profile.id
        profileName = stored.profile.name
        resolution = current.built.resolution
        definitions = structuredClone(current.built.groups)
        groups = structuredClone(definitions)
        groups = await liveGroups()
        if (profileChanged && selectors.size) {
          const assertOwner = (): void => {
            if (
              closing ||
              stoppingRequest ||
              generation !== current.generation ||
              instanceId !== current.report.instanceId ||
              session?.state() !== 'running'
            )
              throw new Error('恢复节点选择时本次核心已变化。')
          }
          assertOwner()
          await restoreSavedSelectors(session, groups, selectors, assertOwner)
          groups = await liveGroups()
          assertOwner()
        }
        observedMode = validateCoreMode(config.mode)
        warnings = [
          '本次自有核心热载已确认，实例及监听端口保持；旧配置与候选证据留在本次私有工作目录。没有停止、重启或操作其他Clash。'
        ]
        return result('reloaded')
      } catch (error) {
        if (error instanceof LocalProxyMutationRefused) return result('cancelled')
        reloadProof = undefined
        if (applied) {
          learningPublishable = false
          uncertain = true
          observedMode = undefined
          runtimeConfiguration = undefined
          runtimeAssets = undefined
          activeProfileId = undefined
          profileName = undefined
          phase = 'failed'
          groups = groups.map((group) => ({
            ...group,
            confirmed: false,
            now: undefined,
            fixed: undefined,
            health: undefined
          }))
          warnings = [
            '热载回执、运行状态或来源记录未确认；保留实例及证据，禁止自动重试、回滚或重启。请人工核对后明确停止或恢复。'
          ]
          return result('uncertain')
        }
        warnings = ['热载前复核未通过，未向核心发送候选；现有实例保留。']
        return result('failed')
      } finally {
        end()
      }
    },
    async inspectLive(includeResource = false): Promise<
      | {
          instanceId: string
          config: Record<string, unknown>
          runtime: Record<string, unknown>
          proxies: Record<string, unknown>
          providers: Record<string, unknown>
          version: Record<string, unknown>
          rules: Record<string, unknown>
          coreSHA256?: string
        }
      | undefined
    > {
      await whenIdle()
      const current = session,
        id = instanceId
      if (!current || !id || phase !== 'running' || current.state() !== 'running' || closing)
        return undefined
      try {
        const [config, proxies, providers, version, rules] = await Promise.all([
          current.read('configs'),
          current.read('proxies'),
          current.read('providers/proxies'),
          current.read('version'),
          current.read('rules')
        ])
        const resource = includeResource
          ? await adapters.resources(lifetime, runtimeAssets)
          : undefined
        if (
          session !== current ||
          instanceId !== id ||
          current.state() !== 'running' ||
          phase !== 'running' ||
          closing ||
          busy
        )
          throw new Error()
        observedMode = validateCoreMode(config.mode)
        if (
          !ports ||
          !localProxyPortsMatch(config, ports) ||
          version.version !== current.version ||
          (resource && resource.version !== current.version)
        )
          throw new Error()
        if (!runtimeConfiguration) throw new Error()
        const runtime: Record<string, unknown> = JSON.parse(runtimeConfiguration)
        runtime.mode = config.mode
        return {
          instanceId: id,
          config,
          runtime,
          proxies,
          providers,
          version,
          rules,
          ...(resource ? { coreSHA256: resource.sha256 } : {})
        }
      } catch {
        observedMode = undefined
        throw new Error('本次自有核心状态未能完整读取。')
      }
    },
    async prepare(raw: unknown): Promise<LocalProxyPreparation> {
      const input = localProxyPrepare(raw)
      if (input.lifetime === 'persistent' && input.logLevel !== undefined)
        throw new Error('持久普通代理不接入自定义日志级别。')
      const preparedPorts = localProxyPortsFor(input.httpPort, input.ports)
      if (
        input.lifetime === 'persistent' &&
        !localProxyPortsCompatible(preparedPorts, localProxyPortsFor(input.httpPort))
      )
        throw new Error('持久普通代理仅支持普通 HTTP 端口；其他监听端口请使用随主程序运行模式。')
      if (busy || owned() || closing) throw new Error('请先结束本次本地代理操作。')
      begin()
      proof = undefined
      const current = ++generation
      try {
        const stored = await adapters.read(input.profile, input.resolverMode)
        const pin = input.dedicated
          ? await adapters.resolvePinnedNode?.(stored, input.dedicated)
          : undefined
        const [snapshot, resource, selectors] = await Promise.all([
          adapters.inspect(),
          adapters.resources(input.lifetime, stored.runtimeAssets),
          readSelectors(stored.profile.id)
        ])
        const built = localProxyConfiguration(
          stored.text,
          input.httpPort,
          input.resolverMode,
          input.dedicated,
          input.logLevel,
          stored.runtimeAssets,
          preparedPorts,
          pin?.node,
          selectors
        )
        if (input.lifetime === 'persistent') {
          if (input.resolverMode !== 'off' || input.dedicated || stored.runtimeAssets?.length)
            throw new Error('持久普通代理不接入DNS或专用监听。')
          persistentCoreConfiguration(stored.text, input.httpPort, selectors)
        }
        const dedicatedPorts =
          input.dedicated === undefined
            ? []
            : [input.dedicated.httpPort, input.dedicated.socksPort].filter(
                (value): value is number => value !== undefined
              )
        const sockets = [
          ...[...enabledLocalProxyPorts(built.ports), ...dedicatedPorts].map((port) => ({
            protocol: 'TCP',
            port,
            probe: adapters.portAvailable
          })),
          ...udpPorts(built.ports).map((port) => ({
            protocol: 'UDP',
            port,
            probe: adapters.portAvailableUDP ?? probeLocalUdpPort
          }))
        ]
        const free =
          snapshot.lease === 'missing'
            ? await Promise.all(sockets.map((socket) => socket.probe(socket.port)))
            : []
        const unavailable = sockets.filter((_, index) => !free[index])
        const available = snapshot.lease === 'missing' && !unavailable.length
        if (generation !== current || closing) throw new Error()
        hasRecord = snapshot.lease !== 'missing'
        phase = hasRecord || !available ? 'blocked' : 'idle'
        warnings = hasRecord
          ? ['已有自有核心会话或旧记录，不自动接管。']
          : available
            ? [
                '节点、规则、DNS 和嗅探沿用配置；监听端口、TUN 和缓存由 Relay 管理。',
                input.resolverMode === 'profile'
                  ? '本次将启用受支持的原DNS／hosts；DNS监听关闭，未接入系统代理或Claude保护。'
                  : '只开启127.0.0.1上所选的普通代理监听；原DNS／TUN等配置未应用，未接入系统代理或Claude保护。',
                ...(input.dedicated
                  ? [
                      `专用监听已就绪：HTTP ${input.dedicated.httpPort ?? '—'} / SOCKS ${input.dedicated.socksPort ?? '—'} 绑定固定节点 ${input.dedicated.route}；不把共享组的DIRECT当作回退。`
                    ]
                  : [])
              ]
            : [
                `普通代理监听端口不可用：${unavailable.map((s) => `${s.protocol} ${s.port}`).join('、')}。请检查端口占用。`
              ]
        const report: LocalProxyPreparation = {
          evidenceId: randomUUID(),
          profile: stored.profile,
          httpPort: input.httpPort,
          ports: { ...built.ports },
          runtimeSHA256: profileHash(built.configuration),
          version: resource.version,
          lifetime: input.lifetime,
          resolverMode: input.resolverMode,
          ...(input.logLevel !== undefined ? { logLevel: input.logLevel } : {}),
          resolution: built.resolution,
          canStart: available && !hasRecord,
          hasRecord,
          warnings: [...warnings],
          dedicated: built.dedicated
        }
        if (report.canStart)
          proof = {
            report,
            selection: input.profile,
            sourceRevision: stored.revision,
            pinnedNodeRevision: pin?.revision,
            coreRevision: snapshot.revision,
            resourceSHA256: resource.sha256,
            at: now()
          }
        return structuredClone(report)
      } catch (error) {
        if (error instanceof MissingRuntimeGeoDataError) throw error
        throw new Error(
          '本地代理准备未完成：请核对已支持的节点／规则、DNS／hosts选项和显式DNS引导地址。未启动或更改原配置。'
        )
      } finally {
        end()
      }
    },
    async action(raw: unknown, assertContext?: () => void): Promise<LocalProxyResult> {
      const input = localProxyAction(raw)
      if (input.action === 'probe' || input.action === 'delay') assertOwnedHealthTestAvailable()
      if (closing) throw new Error('退出确认或清理尚未结束。')
      if (input.action === 'stop') {
        if (stoppingRequest && input.instanceId === instanceId) return stoppingRequest
        if (input.instanceId === lastEndedId && !owned()) return result('stopped')
        if (input.instanceId !== instanceId) throw new Error('实例已变化，不停止其他会话。')
        cancelTraffic()
        stoppingRequest = (async () => {
          if (busy) {
            abortStart = true
            await whenIdle()
          }
          if (!owned()) return result('stopped')
          begin()
          try {
            if (
              session &&
              !['stopped', 'unexpectedExit'].includes(session.state()) &&
              !(await adapters.confirmStop(state(), 'stop'))
            )
              return result('cancelled')
            return await finish(false)
          } catch {
            warnings = ['停止确认未完成，保留本次实例和窗口。']
            return result('failed')
          } finally {
            end()
          }
        })().finally(() => {
          stoppingRequest = undefined
        })
        return stoppingRequest
      }
      if (busy) throw new Error('请先等待本次操作结束。')
      if (['mode', 'select', 'automatic', 'rule'].includes(input.action)) cancelTraffic()
      if (input.action === 'rules' || input.action === 'rule') {
        const current = session,
          id = instanceId,
          port = httpPort,
          configuration = runtimeConfiguration,
          actionGeneration = generation
        if (!current || !id || !port || !configuration || input.instanceId !== id)
          throw new Error('本次代理未就绪或实例已变化。')
        const pid = current.pid,
          version = current.version,
          configurationRevision = profileHash(configuration)
        begin()
        let submitted = false,
          mode: RelayCoreMode | undefined
        const assertLive = (): void => {
          try {
            if (
              session !== current ||
              instanceId !== id ||
              httpPort !== port ||
              generation !== actionGeneration ||
              runtimeConfiguration !== configuration ||
              phase !== 'running' ||
              current.state() !== 'running' ||
              current.pid !== pid ||
              current.version !== version ||
              uncertain ||
              closing ||
              stoppingRequest ||
              (input.action === 'rule' && input.configurationRevision !== configurationRevision) ||
              typeof assertContext !== 'function'
            )
              throw new Error()
            // Context follows all observable getters; only pure freshness follows it.
            assertContext()
            if (
              session !== current ||
              instanceId !== id ||
              generation !== actionGeneration ||
              runtimeConfiguration !== configuration ||
              closing ||
              stoppingRequest
            )
              throw new Error()
          } catch {
            throw new LocalRuleScopeError('本次规则操作上下文已失效。')
          }
        }
        const guards = { assertLive },
          assertOwner = async (): Promise<void> => {
            assertLive()
            const config = await current.read('configs', guards)
            assertLive()
            const actualVersion = await current.read('version', guards)
            assertLive()
            if (!ports) throw new LocalRuleScopeError('本次监听计划未确认。')
            const owns = await ownsOrdinaryListeners(pid, ports)
            assertLive()
            const nextMode = validateCoreMode(config.mode)
            if (
              !localProxyPortsMatch(config, ports) ||
              actualVersion.version !== version ||
              !owns ||
              (mode !== undefined && mode !== nextMode)
            )
              throw new LocalRuleScopeError('本次规则列表归属未确认。')
            mode = nextMode
            observedMode = nextMode
          },
          readRules = async (): Promise<ReturnType<typeof readLocalProxyRules>> => {
            assertLive()
            const raw = await current.read('rules', guards)
            assertLive()
            return readLocalProxyRules(raw)
          },
          snapshot = (table: ReturnType<typeof readLocalProxyRules>): LocalProxyRulesSnapshot => ({
            instanceId: id,
            configurationRevision,
            rulesSHA256: table.rulesSHA256,
            rules: structuredClone(table.rules)
          })
        try {
          await assertOwner()
          const before = await readRules()
          await assertOwner()
          assertLive()
          if (input.action === 'rules') return { ...result('refreshed'), rules: snapshot(before) }
          const target = before.rules[input.index]
          if (
            before.rulesSHA256 !== input.rulesSHA256 ||
            !target ||
            typeof target.disabled !== 'boolean'
          )
            throw new LocalRuleScopeError('规则列表已变化或该行不可操作。')
          if (target.disabled === input.disabled)
            return { ...result('refreshed'), rules: snapshot(before) }
          if (!current.patchRule) throw new Error('本次实例不支持临时规则操作。')
          const report: LocalProxyRuleConfirmation = {
            instanceId: id,
            configurationRevision,
            rulesSHA256: before.rulesSHA256,
            rule: { ...target, disabled: target.disabled },
            disabled: input.disabled
          }
          const accepted = await adapters.confirmRule?.(structuredClone(report))
          assertLive()
          if (!accepted) return result('cancelled')
          await assertOwner()
          const latest = await readRules()
          if (latest.rulesSHA256 !== before.rulesSHA256)
            throw new LocalRuleScopeError('确认期间规则列表已变化。')
          await assertOwner()
          assertLive()
          if (!current.patchRule) throw new Error('本次实例不支持临时规则操作。')
          const expected = localProxyRulesSHA256(
            before.rules.map((row) =>
              row.index === input.index ? { ...row, disabled: input.disabled } : row
            )
          )
          await adapters.beforeRuntimeMutation?.()
          assertLive()
          await current.patchRule(input.index, input.disabled, {
            assertLive,
            submitted: () => {
              submitted = true
            }
          })
          assertLive()
          await assertOwner()
          const confirmed = await readRules()
          await assertOwner()
          assertLive()
          if (confirmed.rulesSHA256 !== expected) throw new Error('规则读回未确认。')
          warnings = [
            '仅本次核心规则的临时禁用位已读回确认；完整重新加载不保留。没有改写规则文件、关闭连接、重启或改变系统代理。'
          ]
          return { ...result('ruleChanged'), rules: snapshot(confirmed) }
        } catch (error) {
          if (error instanceof LocalProxyMutationRefused) return result('cancelled')
          warnings = [
            submitted
              ? '本次规则写入已尝试，但结果未确认；请显式重读核对，没有自动重试、回滚或重启。'
              : '本次规则列表或上下文未确认；没有提交规则写入，请显式重读后再操作。'
          ]
          return result(
            !submitted && error instanceof LocalRuleScopeError ? 'cancelled' : 'unconfirmed'
          )
        } finally {
          end()
        }
      }
      if (
        input.action === 'select' ||
        input.action === 'refresh' ||
        input.action === 'delay' ||
        input.action === 'automatic' ||
        input.action === 'mode' ||
        input.action === 'probe'
      ) {
        if (
          input.instanceId !== instanceId ||
          phase !== 'running' ||
          !session ||
          session.state() !== 'running'
        )
          throw new Error('本次代理未就绪或实例已变化。')
        begin()
        const actionGeneration = generation
        try {
          const config = await session.read('configs')
          if (!ports || !localProxyPortsMatch(config, ports))
            throw new Error('本次普通监听端口已变化。')
          groups = await liveGroups()
          if (input.action === 'mode') {
            const previous = validateCoreMode((await session.read('configs')).mode)
            observedMode = previous
            if (input.mode === previous) return result('refreshed')
            if (!(await adapters.confirmMode?.(previous, input.mode))) return result('cancelled')
            if (
              closing ||
              stoppingRequest ||
              actionGeneration !== generation ||
              session.state() !== 'running'
            )
              return result('cancelled')
            if (
              validateCoreMode((await session.read('configs')).mode) !== previous ||
              !session.patchMode
            )
              throw new Error()
            await adapters.beforeRuntimeMutation?.()
            observedMode = undefined
            if (closing || stoppingRequest || actionGeneration !== generation) throw new Error()
            await session.patchMode(input.mode)
            const confirmed = validateCoreMode((await session.read('configs')).mode)
            if (confirmed !== input.mode) throw new Error()
            observedMode = confirmed
            warnings = [
              '本次核心模式已重新读取确认；只影响本次代理后续路由。没有断开已有连接、改动系统代理或重启核心。'
            ]
            return result('modeChanged')
          }
          observedMode = validateCoreMode((await session.read('configs')).mode)
          if (input.action === 'probe') {
            if (!runtimeConfiguration || !session.testDelay) throw new Error()
            const source: Record<string, unknown> = JSON.parse(runtimeConfiguration)
            const providers = source['proxy-providers'] as Record<
              string,
              { payload: { name: string }[] }
            >
            const allowed = new Set([
              ...reservedProfileTargets,
              ...definitions.flatMap((g) => [g.name, ...g.members])
            ])
            if (Array.isArray(source.proxies))
              for (const node of source.proxies)
                if (node && typeof node === 'object' && typeof node.name === 'string')
                  allowed.add(node.name)
            if (!allowed.has(input.member)) throw new Error()
            if (
              input.provider &&
              (!Object.hasOwn(providers, input.provider) ||
                !providers[input.provider].payload.some((n) => n.name === input.member))
            )
              throw new Error()
            const target = healthURL(input.url)
            if (!(await adapters.confirmTest?.('Clash 节点', input.member, new URL(target).origin)))
              return result('cancelled')
            if (
              closing ||
              stoppingRequest ||
              actionGeneration !== generation ||
              session.state() !== 'running'
            )
              return result('cancelled')
            try {
              const delay = await session.testDelay(input.member, target, 5000)
              groups = await liveGroups()
              warnings = ['本次节点测速已返回实际延迟；可能更新自动选路使用的健康记录。']
              return { ...result('tested'), delay }
            } catch {
              groups = await liveGroups()
              warnings = ['本次测速失败或超时；已重读核心记录，没有改为直连或自动重试。']
              return result('unconfirmed')
            }
          }
          if (input.action === 'select') {
            const group = groups.find((value) => value.name === input.group)
            if (input.group === 'GLOBAL') {
              const global = await session.group('GLOBAL')
              if (
                global.type !== 'Selector' ||
                !Array.isArray(global.all) ||
                !global.all.includes(input.member)
              )
                throw new Error()
            } else if (
              !group ||
              group.selectable === false ||
              !group.members.includes(input.member)
            )
              throw new Error()
            await adapters.beforeRuntimeMutation?.()
            if (closing || stoppingRequest || actionGeneration !== generation) throw new Error()
            await session.select(input.group, input.member)
            groups = await liveGroups()
            const selected =
              input.group === 'GLOBAL'
                ? (await session.group('GLOBAL')).now
                : groups.find((value) => value.name === input.group)?.now
            if (selected !== input.member) throw new Error()
            if (activeProfileId)
              await adapters.rememberSelector?.(activeProfileId, input.group, input.member)
          }
          if (input.action === 'delay') {
            const group = groups.find((g) => g.name === input.group)
            if (!group?.testURL || !group.members.includes(input.member) || !session.testDelay)
              throw new Error()
            if (
              !(await adapters.confirmTest?.(
                group.name,
                input.member,
                new URL(group.testURL).origin
              ))
            )
              return result('cancelled')
            if (
              closing ||
              stoppingRequest ||
              actionGeneration !== generation ||
              session.state() !== 'running'
            )
              return result('cancelled')
            try {
              await session.testDelay(input.member, group.testURL, 5000, group.expectedStatus)
            } catch {
              groups = await liveGroups()
              warnings = [
                '本次测速失败或超时；已重新读取核心健康记录，没有改用其他节点或直连重试。'
              ]
              return result('unconfirmed')
            }
            groups = await liveGroups()
          }
          if (input.action === 'automatic') {
            const group = groups.find((g) => g.name === input.group)
            if (
              !group ||
              !['url-test', 'fallback', 'smart'].includes(group.type ?? '') ||
              !session.automatic
            )
              throw new Error()
            await adapters.beforeRuntimeMutation?.()
            if (closing || stoppingRequest || actionGeneration !== generation) throw new Error()
            await session.automatic(group.name)
            groups = await liveGroups()
            if (groups.find((g) => g.name === group.name)?.fixed !== '') throw new Error()
            if (activeProfileId) await adapters.rememberSelector?.(activeProfileId, input.group)
          }
          warnings = [
            '当前成员、选择与健康记录来自本次私有接口；负载均衡没有单一当前节点。空成员回退仍遵循原配置，不代表禁止直连。'
          ]
          return result(
            input.action === 'select'
              ? 'selected'
              : input.action === 'delay'
                ? 'tested'
                : input.action === 'automatic'
                  ? 'automatic'
                  : 'refreshed'
          )
        } catch (error) {
          if (error instanceof LocalProxyMutationRefused) return result('cancelled')
          observedMode = undefined
          groups = groups.map((value) => ({
            ...value,
            now: undefined,
            fixed: undefined,
            health: undefined,
            confirmed: false
          }))
          warnings = ['组选择或读取结果未确认，请刷新核对；没有自动重试、回滚或重启核心。']
          return result('unconfirmed')
        } finally {
          end()
        }
      }
      const current = proof
      const fresh = (): boolean =>
        !!current &&
        proof === current &&
        current.report.evidenceId === input.evidenceId &&
        now() >= current.at &&
        now() - current.at <= 60000
      if (owned() || !fresh() || !current) throw new Error('请重新准备，或先结束现有实例。')
      begin()
      abortStart = false
      let startupStep = '复核配置和核心资源'
      try {
        if (
          !(await adapters.confirmStart(structuredClone(current.report), assertContext)) ||
          abortStart
        ) {
          instanceId = undefined
          return result('cancelled')
        }
        assertContext?.()
        const stored = await adapters.read(current.selection, current.report.resolverMode)
        const pin = current.report.dedicated
          ? await adapters.resolvePinnedNode?.(stored, current.report.dedicated)
          : undefined
        if (
          !fresh() ||
          stored.revision !== current.sourceRevision ||
          pin?.revision !== current.pinnedNodeRevision
        )
          throw new Error()
        const resource = await adapters.resources(current.report.lifetime, stored.runtimeAssets)
        if (
          resource.sha256 !== current.resourceSHA256 ||
          resource.version !== current.report.version ||
          !fresh()
        )
          throw new Error('固定核心资源已变化，请重新准备。')
        const selectors = await readSelectors(stored.profile.id)
        const built = localProxyConfiguration(
          stored.text,
          current.report.httpPort,
          current.report.resolverMode,
          current.report.dedicated,
          current.report.logLevel,
          stored.runtimeAssets,
          current.report.ports,
          pin?.node,
          selectors
        )
        if (profileHash(built.configuration) !== current.report.runtimeSHA256) throw new Error()
        assertContext?.()
        await adapters.beforeRuntimeMutation?.()
        if (closing || stoppingRequest || abortStart || !fresh()) throw new Error()
        assertContext?.()
        instanceId = current.report.evidenceId
        proof = undefined
        phase = 'starting'
        lifetime = current.report.lifetime ?? 'main'
        logLevel = current.report.logLevel
        if (lifetime === 'persistent') {
          if (!localProxyPortsCompatible(built.ports, localProxyPortsFor(current.report.httpPort)))
            throw new Error('持久普通代理仅支持普通 HTTP 端口。')
          persistentCoreConfiguration(stored.text, current.report.httpPort, selectors)
        }
        httpPort = current.report.httpPort
        ports = built.ports
        profileName = stored.profile.name
        activeProfileId = stored.profile.id
        runtimeConfiguration = built.configuration
        runtimeAssets = stored.runtimeAssets?.map((asset) => ({
          ...asset,
          bytes: Buffer.from(asset.bytes)
        }))
        resolution = built.resolution
        dedicated = built.dedicated
        startupStep = '登记普通代理会话'
        lease = await adapters.acquire(
          {
            kind: 'localProxy',
            httpPort,
            ports: { ...ports },
            profileId: stored.profile.id,
            sourceSHA256: stored.profile.sha256,
            resolverMode: current.report.resolverMode ?? 'off'
          },
          current.coreRevision,
          lifetime
        )
        assertContext?.()
        const owner = Symbol('owned Smart state'),
          ownerLease = lease
        learningOwner = owner
        learningPublishable = false
        retainedLearningEvidence = false
        learningPersisted = false
        learningStopResult = undefined
        hasRecord = true
        definitions = built.groups.map((group) => ({ ...group, confirmed: false }))
        groups = structuredClone(definitions)
        if (abortStart) return await finish(false)
        assertContext?.()
        startupStep = '校验配置并启动普通代理核心'
        session = await adapters.start(
          stored.text,
          httpPort,
          (stop, stateResult) => {
            cleanup = stop
            learningStopResult = stateResult
          },
          current.report.resolverMode ?? 'off',
          current.report.dedicated,
          {
            profileUUID: stored.profile.id,
            assertLive: () => {
              if (learningOwner !== owner || lease !== ownerLease)
                throw new Error('Smart状态会话所有者已变化。')
            },
            mayPersist: () => learningOwner === owner && lease === ownerLease && learningPublishable
          },
          lifetime,
          logLevel,
          stored.runtimeAssets,
          ports,
          pin?.node,
          selectors
        )
        cleanup ??= () => session?.stop() ?? Promise.resolve()
        assertContext?.()
        livePid = session.pid
        startupStep = '核对核心运行配置与监听端口'
        const config = await session.read('configs'),
          tun = config.tun
        if (
          !ports ||
          !localProxyPortsMatch(config, ports) ||
          config.mode !== JSON.parse(built.configuration).mode ||
          (logLevel !== undefined && config['log-level'] !== logLevel) ||
          config['allow-lan'] !== false ||
          config['tproxy-port'] !== 0 ||
          !tun ||
          typeof tun !== 'object' ||
          (tun as Record<string, unknown>).enable !== false
        )
          throw new Error()
        startupStep = '读取代理组'
        groups = await liveGroups()
        observedMode = validateCoreMode(config.mode)
        if (selectors.size) {
          const currentStart = (): void => {
            assertContext?.()
            if (closing || stoppingRequest || abortStart) throw new Error('启动已取消。')
          }
          startupStep = '恢复所选节点'
          await restoreSavedSelectors(session, groups, selectors, currentStart)
          groups = await liveGroups()
          currentStart()
        }
        startupStep = '登记已运行的核心'
        await lease.update('running', session.pid)
        assertContext?.()
        if (abortStart) return await finish(false)
        phase = 'running'
        learningPublishable = true
        uncertain = false
        warnings = [
          resolution.mode === 'profile'
            ? '本地代理运行中；受支持的原DNS／hosts已用于本次实例，DNS监听关闭。系统代理及Claude网络未自动改变，真实禁止直连未启用。'
            : '本地代理运行中，可由程序手动接入。原DNS等完整配置未应用；系统代理及Claude网络未自动改变，真实禁止直连未启用。'
        ]
        return result('started')
      } catch (error) {
        if (error instanceof LocalProxyMutationRefused) return result('cancelled')
        if (owned()) {
          const ended = await finish(false)
          if (ended.status === 'uncertain') return ended
        } else {
          instanceId = undefined
          try {
            hasRecord = (await adapters.inspect()).lease !== 'missing'
          } catch {
            hasRecord = true
          }
        }
        phase = hasRecord ? 'blocked' : 'failed'
        warnings = [
          `普通代理启动失败，未完成「${startupStep}」。`,
          ...(error instanceof OwnedCoreConfigurationTimeoutError
            ? [OWNED_CORE_CONFIGURATION_TIMEOUT_WARNING]
            : []),
          ...learningWarnings()
        ]
        return result('failed')
      } finally {
        end()
      }
    },
    requestClose(
      verifyBeforeStop?: () => Promise<boolean>
    ): Promise<'closed' | 'cancelled' | 'failed'> {
      if (closing) return closing
      cancelTraffic()
      abortStart = true
      proof = undefined
      ++generation
      closing = (async () => {
        await whenIdle()
        if (!owned()) return 'closed' as const
        try {
          if (
            session &&
            !['stopped', 'unexpectedExit'].includes(session.state()) &&
            !(await adapters.confirmStop(state(), 'quit'))
          )
            return 'cancelled' as const
          const outcome = await finish(true, verifyBeforeStop)
          if (verifyBeforeStop && outcome.status === 'cancelled') return 'cancelled' as const
          return outcome.status === 'stopped' ? ('closed' as const) : ('failed' as const)
        } catch {
          warnings = ['退出确认未完成，保留本次实例和窗口。']
          return 'failed' as const
        }
      })().finally(() => {
        closing = undefined
      })
      return closing
    },
    cancelTraffic,
    isTrafficBusy: (): boolean => !!trafficPending,
    async readTraffic(signal: AbortSignal): Promise<OwnedTrafficSample | undefined> {
      const current = session,
        id = instanceId,
        actionGeneration = generation,
        configuration = runtimeConfiguration,
        profileId = activeProfileId,
        mode = observedMode,
        heldLease = lease
      const readTraffic = current?.readTraffic
      if (
        trafficPending ||
        busy ||
        closing ||
        stoppingRequest ||
        uncertain ||
        !current ||
        !id ||
        !configuration ||
        !heldLease ||
        !readTraffic ||
        phase !== 'running' ||
        current.state() !== 'running' ||
        signal.aborted
      )
        return undefined
      const revision = profileHash(configuration),
        operation = { controller: new AbortController(), epoch: trafficEpoch }
      trafficPending = operation
      const abort = (): void => operation.controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      const live = (): void => {
        if (
          operation.controller.signal.aborted ||
          trafficPending !== operation ||
          operation.epoch !== trafficEpoch ||
          generation !== actionGeneration ||
          session !== current ||
          instanceId !== id ||
          runtimeConfiguration !== configuration ||
          activeProfileId !== profileId ||
          observedMode !== mode ||
          lease !== heldLease ||
          phase !== 'running' ||
          current.state() !== 'running' ||
          busy ||
          closing ||
          stoppingRequest ||
          uncertain
        )
          throw new Error('本次流量读取的所有者或配置已变化。')
      }
      try {
        live()
        const sample = await readTraffic.call(current, {
          instanceId: id,
          configurationRevision: revision,
          signal: operation.controller.signal,
          assertLive: live
        })
        live()
        if (sample.instanceId !== id || sample.configurationRevision !== revision)
          throw new Error('本次流量样本来源不符。')
        return sample
      } catch {
        // An unavailable read is never presented as zero traffic and does not
        // revoke the Core, change lifecycle busy or retain the CoreStore lease.
        return undefined
      } finally {
        signal.removeEventListener('abort', abort)
        if (trafficPending === operation) trafficPending = undefined
      }
    },
    async connections(): Promise<ConnectionSnapshot | undefined> {
      await whenIdle()
      const current = session,
        id = instanceId
      if (!current || !id || phase !== 'running' || current.state() !== 'running' || closing)
        return undefined
      return readConnections(current)
    },
    logs(): readonly string[] {
      return readLogs(session)
    },
    logSnapshot(): RuntimeLogSnapshot {
      return session?.logSnapshot?.() ?? { sequence: 0, lines: [] }
    },
    captureWorkDirectory(): ((open: (path: string) => Promise<void>) => Promise<void>) | undefined {
      const current = session,
        id = instanceId,
        heldLease = lease,
        observation = runtimeObservation,
        source = runtimeConfiguration,
        openDirectory = current?.openWorkDirectory
      if (!current || !id || !heldLease || !source || !openDirectory) return undefined
      const live = (): boolean =>
        session === current &&
        instanceId === id &&
        lease === heldLease &&
        runtimeObservation === observation &&
        runtimeConfiguration === source &&
        phase === 'running' &&
        current.state() === 'running' &&
        !busy &&
        !closing &&
        !stoppingRequest &&
        !uncertain
      if (!live()) return undefined
      return async (open) => {
        const assertLive = (): void => {
          if (!live()) throw new Error('本次核心或工作目录归属已变化。')
        }
        assertLive()
        await openDirectory.call(current, open, assertLive)
      }
    },
    async closeConnection(raw: unknown): Promise<void> {
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 256)
        throw new Error('连接标识无效。')
      if (busy || closing || !session || phase !== 'running' || session.state() !== 'running')
        throw new Error('请等待当前操作结束。')
      if (!session.closeConnection) throw new Error('本次实例不支持关闭单个连接。')
      begin()
      try {
        await session.closeConnection(raw)
      } finally {
        end()
      }
    },
    async closeAllConnections(): Promise<void> {
      if (busy || closing || !session || phase !== 'running' || session.state() !== 'running')
        throw new Error('请等待当前操作结束。')
      if (!session.closeAllConnections) throw new Error('本次实例不支持关闭全部连接。')
      begin()
      try {
        await session.closeAllConnections()
      } finally {
        end()
      }
    }
  }
}
