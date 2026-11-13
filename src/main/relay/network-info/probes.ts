import { randomUUID } from 'crypto'
import { performance } from 'perf_hooks'
import {
  inspectProbeWorkspaces,
  archiveProbeWorkspaces,
  type ProbeWorkspaceInspection
} from '../core/probe-owners'
import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'
import {
  isolatedProbeEvidence,
  isolatedProbeRequest,
  probeEndpoints,
  probeDelayURL,
  probeLatencyTargets,
  probeConcurrency,
  type IsolatedProbePlan,
  type IsolatedProbeResult,
  type IsolatedProbeState
} from '../../../shared/relay/isolated-probes'
import type { RelayStateContext } from '../context'
import type { ProfileStore } from '../profiles/store'
import { isolatedProbeConfiguration, isolatedProbeTargets } from './probe-configuration'
import { startIsolatedProbe } from './probe-runtime'
import { providerIP } from './probe-ip'
export function createIsolatedProbes(adapters: {
  context: RelayStateContext
  readProfile(selection: RelayProfileSelection): ReturnType<ProfileStore['read']>
  resourceRoot(): Promise<string>
  confirm(plan: IsolatedProbePlan, signal: AbortSignal): Promise<boolean>
  confirmArchive?(count: number, signal: AbortSignal): Promise<boolean>
  independentNetwork(): Promise<string>
}) {
  let startupPending = true,
    owners: ProbeWorkspaceInspection | undefined
  let pending = false,
    uncertain = false,
    warning: string | undefined,
    generation = 0,
    cleanup: (() => Promise<void>) | undefined,
    active: { id: string; abort: AbortController } | undefined
  let proof:
    | {
        request: ReturnType<typeof isolatedProbeRequest>
        plan: IsolatedProbePlan
        revision: string
        at: number
        mono: number
        generation: number
      }
    | undefined
  const waiters: (() => void)[] = []
  const refreshOwners = async (): Promise<void> => {
    owners = await inspectProbeWorkspaces(adapters.context)
  }
  const startup = refreshOwners().finally(() => {
    startupPending = false
  })
  const ownersBlocked = (): boolean => owners !== undefined && owners.status !== 'clear'
  const ownerWarning = (): string | undefined =>
    ownersBlocked()
      ? '发现旧临时核心工作区；没有接管或停止旧进程。仅已确认退出且记录完整的旧目录可单独确认归档，启动记录缺失或未知时保留。'
      : undefined

  const state = (): IsolatedProbeState => ({
    pending: pending || startupPending,
    uncertain: uncertain || ownersBlocked(),
    canCleanup: (!!cleanup || owners?.canArchive === true) && !pending && !startupPending,
    preparedId: proof?.plan.evidenceId,
    warning: warning ?? ownerWarning()
  })
  const whenIdle = (): Promise<void> =>
    pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const operation = async <T>(fn: () => Promise<T>): Promise<T> => {
    await startup
    if (pending || uncertain || cleanup || ownersBlocked()) throw new Error('独立探测尚未收尾。')
    pending = true
    try {
      return await fn()
    } finally {
      pending = false
      waiters.splice(0).forEach((resolve) => resolve())
    }
  }
  const stop = async (): Promise<void> => {
    if (!cleanup) return
    try {
      await cleanup()
      cleanup = undefined
      uncertain = false
      warning = undefined
    } catch {
      uncertain = true
      warning = '本次独立探测核心停止未确认；保留自有记录，请单独重试收尾。'
      throw new Error(warning)
    }
  }
  const cancel = (id?: string): boolean => {
    if (id && active?.id !== id && proof?.plan.evidenceId !== id) return false
    ++generation
    proof = undefined
    active?.abort.abort()
    return true
  }
  const fresh = (p: NonNullable<typeof proof>): boolean => {
    const wall = Date.now(),
      mono = performance.now()
    return (
      p.generation === generation &&
      wall >= p.at &&
      mono >= p.mono &&
      wall - p.at < 60000 &&
      mono - p.mono < 60000
    )
  }
  return {
    state,
    async refreshState() {
      await startup
      if (!pending && !cleanup) await refreshOwners()
      return state()
    },
    whenIdle,
    isBusy: () => pending,
    isBlocking: () => startupPending || pending || !!cleanup || ownersBlocked(),
    targets(input: unknown, assertCurrent: () => void) {
      return operation(async () => {
        assertCurrent()
        const source = await adapters.readProfile(profileSelection(input))
        assertCurrent()
        return isolatedProbeTargets(source.text)
      })
    },
    prepare(input: unknown, assertCurrent: () => void) {
      const request = isolatedProbeRequest(input)
      return operation(async () => {
        proof = undefined
        assertCurrent()
        const source = await adapters.readProfile(request.profile)
        assertCurrent()
        const built = isolatedProbeConfiguration(source.text, request, 49152),
          plan: IsolatedProbePlan = {
            evidenceId: randomUUID(),
            name: source.profile.name,
            kind: request.kind,
            nodes: built.nodes,
            origins: (request.kind === 'ip'
              ? [probeEndpoints[request.provider]]
              : request.kind === 'latency'
                ? probeLatencyTargets.map((name) => probeEndpoints[name])
                : [request.delay?.url ?? probeDelayURL]
            ).map((url) => new URL(url).origin),
            sourceSHA256: source.profile.sha256,
            configurationSHA256: built.sha256
          }
        proof = {
          request,
          plan,
          revision: source.revision,
          at: Date.now(),
          mono: performance.now(),
          generation
        }
        return structuredClone(plan)
      })
    },
    run(input: unknown, assertCurrent: () => void): Promise<IsolatedProbeResult> {
      const id = isolatedProbeEvidence(input),
        prepared = proof
      if (!prepared || prepared.plan.evidenceId !== id || !fresh(prepared))
        return Promise.reject(new Error('独立探测凭据已失效，请重新准备。'))
      return operation(async () => {
        proof = undefined
        const controller = new AbortController(),
          entry = { id, abort: controller }
        active = entry
        let wall = 0,
          tick = 0,
          lastWall = 0,
          lastTick = 0,
          budgetStarted = false,
          cleanupAttempted = false,
          network: string | undefined
        const current = (): void => {
          assertCurrent()
          if (controller.signal.aborted || generation !== prepared.generation || active !== entry)
            throw new Error('独立探测已取消。')
          if (budgetStarted) {
            const now = Date.now(),
              mono = performance.now()
            if (
              !Number.isSafeInteger(now) ||
              !Number.isFinite(mono) ||
              !Number.isSafeInteger(wall) ||
              !Number.isFinite(tick) ||
              now < lastWall ||
              mono < lastTick ||
              now - wall >= 90000 ||
              mono - tick >= 90000
            )
              throw new Error('独立探测预算已结束。')
            lastWall = now
            lastTick = mono
          }
        }
        try {
          current()
          await refreshOwners()
          current()
          if (ownersBlocked()) throw new Error('旧临时核心工作区尚未收尾。')
          if (!(await adapters.confirm(prepared.plan, controller.signal)))
            return {
              status: 'cancelled',
              kind: prepared.request.kind,
              measurements: [],
              isolated: true
            }
          current()
          if (!fresh(prepared)) throw new Error('确认期间探测凭据过期。')
          wall = lastWall = Date.now()
          tick = lastTick = performance.now()
          budgetStarted = true
          current()
          network = await adapters.independentNetwork()
          current()
          const independent = async (): Promise<void> => {
            current()
            let fresh: string
            try {
              fresh = await adapters.independentNetwork()
            } catch (error) {
              controller.abort()
              throw error
            }
            current()
            if (fresh !== network) {
              controller.abort()
              throw new Error('系统网络环境已变化，独立探测已取消，没有重试。')
            }
          }
          const source = await adapters.readProfile(prepared.request.profile)
          current()
          if (source.revision !== prepared.revision) throw new Error('保存的配置在确认期间变化。')
          if (
            isolatedProbeConfiguration(source.text, prepared.request, 49152).sha256 !==
            prepared.plan.configurationSHA256
          )
            throw new Error('独立探测配置已变化。')
          const resourceRoot = await adapters.resourceRoot()
          current()
          await refreshOwners()
          current()
          if (ownersBlocked()) throw new Error('旧临时核心工作区尚未收尾。')
          const runtime = await startIsolatedProbe({
            context: adapters.context,
            resourceRoot,
            text: source.text,
            request: prepared.request,
            signal: controller.signal,
            assertCurrent: current,
            registerCleanup: (stop) => {
              if (cleanup) throw new Error('独立探测清理能力重复。')
              cleanup = stop
            }
          })
          current()
          await independent()
          if (runtime.requestedConfigurationSHA256 !== prepared.plan.configurationSHA256)
            throw new Error('独立探测配置已变化。')
          const result: IsolatedProbeResult = {
            status: 'completed',
            kind: prepared.request.kind,
            measurements: [],
            isolated: true
          }
          if (prepared.request.kind === 'ip') {
            await independent()
            const body = await runtime.request(
              probeEndpoints[prepared.request.provider],
              10000,
              65536
            )
            current()
            await independent()
            result.ip = providerIP(prepared.request.provider, JSON.parse(body.body))
          } else if (prepared.request.kind === 'latency') {
            for (const name of probeLatencyTargets) {
              current()
              let milliseconds: number | null = null
              try {
                await independent()
                const response = await runtime.request(probeEndpoints[name], 5000, 1024 * 1024)
                current()
                milliseconds = response.milliseconds
              } catch {
                current()
              }
              await independent()
              result.measurements.push({ name, milliseconds })
            }
          } else {
            result.measurements = runtime.nodes.map((name) => ({
              name,
              milliseconds: null,
              ...(runtime.failures.has(name) ? { error: runtime.failures.get(name) } : {})
            }))
            let next = 0
            const worker = async (): Promise<void> => {
              while (next < runtime.nodes.length) {
                current()
                const index = next++,
                  node = runtime.nodes[index]
                if (runtime.failures.has(node)) continue
                let milliseconds: number | null = null
                try {
                  await independent()
                  const value = await runtime.delay(
                    node,
                    prepared.request.delay?.url ?? probeDelayURL
                  )
                  current()
                  if (Number.isInteger(value) && value >= 0 && value <= 65535) milliseconds = value
                } catch {
                  current()
                }
                await independent()
                result.measurements[index] = { name: node, milliseconds }
              }
            }
            const workers = await Promise.allSettled(
              Array.from({ length: Math.min(probeConcurrency, runtime.nodes.length) }, worker)
            )
            const failed = workers.find((result) => result.status === 'rejected')
            if (failed?.status === 'rejected') throw failed.reason
          }
          cleanupAttempted = true
          await stop()
          current()
          return result
        } finally {
          active = undefined
          if (!cleanupAttempted) await stop()
        }
      })
    },
    cancel(input: unknown) {
      return cancel(isolatedProbeEvidence(input))
    },
    async cleanup(assertCurrent: () => void = () => {}) {
      await startup
      if (pending) throw new Error('请先取消并等待本次探测。')
      pending = true
      try {
        if (cleanup) await stop()
        else {
          assertCurrent()
          await refreshOwners()
          assertCurrent()
          const prepared = owners,
            controller = new AbortController()
          if (!prepared?.canArchive || !adapters.confirmArchive)
            throw new Error('旧临时核心仍活动或状态未知，没有归档。')
          const epoch = generation
          active = { id: randomUUID(), abort: controller }
          const current = (): void => {
            assertCurrent()
            if (epoch !== generation || controller.signal.aborted)
              throw new Error('旧临时核心归档意图失效。')
          }
          current()
          if (!(await adapters.confirmArchive(prepared.count, controller.signal))) return state()
          current()
          await archiveProbeWorkspaces(adapters.context, prepared, current)
        }
        await refreshOwners()
      } finally {
        active = undefined
        pending = false
        waiters.splice(0).forEach((resolve) => resolve())
      }
      return state()
    },
    async requestClose() {
      cancel()
      await startup
      await whenIdle()
      await stop()
      await refreshOwners()
      if (ownersBlocked()) throw new Error('旧临时核心工作区尚未明确归档，未宣称收尾完成。')
    },
    invalidate: () => {
      cancel()
    }
  }
}
