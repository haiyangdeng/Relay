import { createHash, randomUUID } from 'crypto'
import {
  type SubStoreAdvancedStart,
  subStoreEvidence,
  subStoreProxy,
  subStoreSelection,
  type SubStoreConversion,
  type SubStoreItem,
  type SubStoreRecovery,
  type SubStoreState
} from '../../../shared/relay/substore'
import { analyzeProfile } from '../profiles/inspect'
import type { SubStoreEgress } from './isolated-egress'
import { subStoreAdvancedStart } from './advanced-options'
import { downloadSubStoreAsset, type SubStoreResources } from './resources'
import { archiveSubStoreSession, inspectSubStoreSession, type SubStoreRuntime } from './runtime'

export function createSubStoreService(adapters: {
  resources: SubStoreResources
  start(input: {
    proxyPort: number
    signal: AbortSignal
    registerCleanup(stop: () => Promise<void>): void
  }): Promise<SubStoreRuntime>
  save(name: string, text: string): Promise<unknown>
  confirmRecover?(record: SubStoreRecovery, signal: AbortSignal): Promise<boolean>
  confirmAcquire(proxyPort: number): Promise<boolean>
  confirmStart(proxyPort: number): Promise<boolean>
  confirmSave(plan: SubStoreConversion, signal: AbortSignal): Promise<boolean>
  download?: typeof downloadSubStoreAsset
  advanced?: {
    validate(request: SubStoreAdvancedStart): Promise<void>
    confirm(
      request: SubStoreAdvancedStart,
      purpose: 'start' | 'acquire',
      signal: AbortSignal
    ): Promise<boolean>
    open(
      request: SubStoreAdvancedStart,
      input: { signal: AbortSignal; registerCleanup(stop: () => Promise<void>): void }
    ): Promise<SubStoreRuntime>
    acquire(
      request: SubStoreAdvancedStart,
      input: { signal: AbortSignal; registerCleanup(stop: () => Promise<void>): void }
    ): Promise<SubStoreEgress>
  }
  now?(): number
}) {
  const now = adapters.now ?? Date.now
  let phase: SubStoreState['phase'] = 'idle',
    busy = false,
    ready = false,
    closing = false
  let advancedOptions: SubStoreAdvancedStart | undefined
  let runtime: SubStoreRuntime | undefined,
    cleanup: (() => Promise<void>) | undefined,
    proxyPort: number | undefined
  let controller: AbortController | undefined
  let conversion: { plan: SubStoreConversion; text: string; at: number } | undefined
  let warnings: string[] = []
  let recovery: SubStoreRecovery | undefined
  const waiters: (() => void)[] = []
  const whenIdle = (): Promise<void> =>
    busy ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const state = (): SubStoreState => ({
    phase: phase === 'running' && runtime && !runtime.alive() ? 'failed' : phase,
    pending: busy,
    resourcesReady: ready,
    backendVersion: adapters.resources.manifest.backend.version,
    frontendVersion: adapters.resources.manifest.frontend.version,
    ...(runtime?.alive() ? { pid: runtime.pid, frontendURL: runtime.frontendURL, proxyPort } : {}),
    ...(recovery ? { recovery } : {}),
    ...(advancedOptions && runtime?.alive()
      ? {
          mode: advancedOptions.mode,
          allowLan: advancedOptions.allowLan,
          backendOrigin:
            advancedOptions.mode === 'remote'
              ? new URL(advancedOptions.backendURL).origin
              : undefined,
          lanURL: runtime.lanURL,
          tasks: {
            sync: advancedOptions.syncCron,
            download: advancedOptions.downloadCron,
            upload: advancedOptions.uploadCron
          }
        }
      : {}),
    warnings: [...warnings]
  })
  async function operation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (busy || closing) throw new Error('请等待当前Sub-Store操作结束。')
    busy = true
    controller = new AbortController()
    try {
      return await fn(controller.signal)
    } finally {
      busy = false
      controller = undefined
      waiters.splice(0).forEach((resolve) => resolve())
    }
  }
  function running(): SubStoreRuntime {
    if (!runtime?.alive() || phase !== 'running') throw new Error('请先明确启动本次Sub-Store。')
    return runtime
  }
  async function items(
    kind: 'subscription' | 'collection',
    signal: AbortSignal
  ): Promise<SubStoreItem[]> {
    const body: unknown = JSON.parse(
      await running().request(kind === 'subscription' ? '/api/subs' : '/api/collections', signal)
    )
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Sub-Store列表响应无效。')
    const data = (body as { data?: unknown }).data
    if (!Array.isArray(data) || data.length > 1000) throw new Error('Sub-Store列表无效或超限。')
    return data.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('Sub-Store条目无效。')
      const row = item as Record<string, unknown>,
        selection = subStoreSelection({ kind, name: row.name })
      return {
        name: selection.name,
        ...(typeof row.displayName === 'string' && row.displayName.length <= 256
          ? { displayName: row.displayName }
          : {})
      }
    })
  }
  async function stopOwned(): Promise<void> {
    conversion = undefined
    if (!cleanup) {
      phase = 'idle'
      return
    }
    phase = 'stopping'
    try {
      await cleanup()
      cleanup = undefined
      runtime = undefined
      advancedOptions = undefined
      proxyPort = undefined
      phase = 'idle'
      warnings = []
    } catch {
      phase = 'uncertain'
      warnings = ['Sub-Store退出尚未确认，保留本次恢复句柄；未操作其他进程。']
      throw new Error(warnings[0])
    }
  }
  return {
    state,
    isBusy: (): boolean => busy,
    isBlocking: (): boolean => busy || !!cleanup,
    whenIdle,
    async inspect(): Promise<SubStoreState> {
      recovery = cleanup ? undefined : await inspectSubStoreSession(adapters.resources)
      try {
        await adapters.resources.load()
        ready = true
      } catch {
        ready = false
      }
      return state()
    },
    // Main-process handoff only: bytes already verified by the candidate store.
    // No renderer path or automatic process stop/start is accepted here.
    installCandidates(
      backend: Buffer,
      frontend: Buffer,
      parentSignal: AbortSignal
    ): Promise<SubStoreState> {
      return operation(async (signal) => {
        if (cleanup) throw new Error('请先结束本次Sub-Store，再接入候选资源。')
        const active = controller,
          abort = (): void => active?.abort()
        parentSignal.addEventListener('abort', abort, { once: true })
        if (parentSignal.aborted) abort()
        conversion = undefined
        phase = 'acquiring'
        warnings = []
        try {
          await adapters.resources.install(backend, frontend, signal)
          await adapters.resources.load()
          ready = true
          phase = 'idle'
          return state()
        } catch {
          phase = 'failed'
          try {
            await adapters.resources.load()
            ready = true
          } catch {
            ready = false
          }
          throw new Error('Sub-Store资源接入未确认，原件及业务数据保留。')
        } finally {
          parentSignal.removeEventListener('abort', abort)
        }
      })
    },
    advancedAcquire(raw: unknown, assertCurrent: () => void = () => {}): Promise<SubStoreState> {
      return operation(async (signal) => {
        if (!adapters.advanced) throw new Error('独立出站尚未接通。')
        assertCurrent()
        const request = subStoreAdvancedStart(raw)
        if (cleanup) throw new Error('请先完成本次Sub-Store收尾。')
        conversion = undefined
        await adapters.advanced.validate(request)
        assertCurrent()
        const confirmed = await adapters.advanced.confirm(request, 'acquire', signal)
        assertCurrent()
        if (!confirmed || signal.aborted) return state()
        phase = 'acquiring'
        warnings = []
        let cleanupAttempted = false
        try {
          const egress = await adapters.advanced.acquire(request, {
            signal,
            registerCleanup: (stop) => {
              cleanup = stop
            }
          })
          const download = adapters.download ?? downloadSubStoreAsset
          const backend = await download(adapters.resources.manifest.backend, egress.port, signal)
          await egress.assertCurrent()
          assertCurrent()
          const frontend = await download(adapters.resources.manifest.frontend, egress.port, signal)
          await egress.assertCurrent()
          assertCurrent()
          assertCurrent()
          await adapters.resources.install(backend, frontend, signal)
          assertCurrent()
          await adapters.resources.load()
          ready = true
          cleanupAttempted = true
          await stopOwned()
          return state()
        } catch {
          if (!cleanupAttempted) await stopOwned()
          else if (cleanup) throw new Error('Sub-Store独立出站收尾未确认，请单独重试。')
          phase = 'failed'
          warnings = ['固定Sub-Store资源获取未完成；原资源保留，没有使用在用核心或直连回退。']
          throw new Error(warnings[0])
        }
      })
    },
    advancedStart(raw: unknown, assertCurrent: () => void = () => {}): Promise<SubStoreState> {
      return operation(async (signal) => {
        if (!adapters.advanced) throw new Error('独立出站尚未接通。')
        assertCurrent()
        const request = subStoreAdvancedStart(raw)
        if (cleanup) throw new Error('请先完成本次Sub-Store收尾。')
        conversion = undefined
        await adapters.advanced.validate(request)
        assertCurrent()
        await adapters.resources.load()
        assertCurrent()
        ready = true
        const confirmed = await adapters.advanced.confirm(request, 'start', signal)
        assertCurrent()
        if (!confirmed || signal.aborted) return state()
        phase = 'starting'
        warnings = []
        try {
          runtime = await adapters.advanced.open(request, {
            signal,
            registerCleanup: (stop) => {
              cleanup = stop
            }
          })
          assertCurrent()
          if (signal.aborted || !runtime.alive()) throw new Error('Sub-Store启动未确认。')
          cleanup = runtime.stop
          advancedOptions = request
          proxyPort = undefined
          phase = 'running'
          return state()
        } catch {
          await stopOwned()
          phase = 'failed'
          warnings = ['Sub-Store独立启动未完成；没有接管现有代理或回退直连。']
          throw new Error(warnings[0])
        }
      })
    },
    networkUnavailable(): void {
      if (!cleanup) return
      conversion = undefined
      phase = 'uncertain'
      warnings = ['独立出口或无TUN事实已失效，已撤销后续出站；请结束本次服务并核对收尾。']
    },
    acquire(raw: unknown): Promise<SubStoreState> {
      return operation(async (signal) => {
        const request = subStoreProxy(raw)
        if (cleanup) throw new Error('请先结束本次Sub-Store，再更换资源。')
        conversion = undefined
        if (!(await adapters.confirmAcquire(request.proxyPort)) || signal.aborted) return state()
        phase = 'acquiring'
        warnings = []
        try {
          const download = adapters.download ?? downloadSubStoreAsset
          const backend = await download(
            adapters.resources.manifest.backend,
            request.proxyPort,
            signal
          )
          const frontend = await download(
            adapters.resources.manifest.frontend,
            request.proxyPort,
            signal
          )
          await adapters.resources.install(backend, frontend, signal)
          await adapters.resources.load()
          ready = true
          phase = 'idle'
          return state()
        } catch {
          phase = 'failed'
          try {
            await adapters.resources.load()
            ready = true
          } catch {
            ready = false
          }
          warnings = ['Sub-Store固定资源获取未完成，未启用或覆盖其他实例。']
          throw new Error(warnings[0])
        }
      }).then(state)
    },
    start(raw: unknown): Promise<SubStoreState> {
      return operation(async (signal) => {
        const request = subStoreProxy(raw)
        if (cleanup) throw new Error('已有本次Sub-Store或未确认退出。')
        await adapters.resources.load()
        ready = true
        if (!(await adapters.confirmStart(request.proxyPort)) || signal.aborted) return state()
        phase = 'starting'
        warnings = []
        try {
          runtime = await adapters.start({
            proxyPort: request.proxyPort,
            signal,
            registerCleanup: (stop) => {
              cleanup = stop
            }
          })
          if (signal.aborted || !runtime.alive()) throw new Error('Sub-Store启动已取消。')
          cleanup = runtime.stop
          proxyPort = request.proxyPort
          phase = 'running'
          return state()
        } catch {
          try {
            await stopOwned()
          } catch {
            throw new Error('Sub-Store退出尚未确认，请保留窗口。')
          }
          phase = 'failed'
          warnings = ['Sub-Store启动失败，未回退到无沙箱或直连模式。']
          throw new Error(warnings[0])
        }
      }).then(state)
    },
    list(): Promise<{ subscriptions: SubStoreItem[]; collections: SubStoreItem[] }> {
      return operation(async (signal) => ({
        subscriptions: await items('subscription', signal),
        collections: await items('collection', signal)
      }))
    },
    prepareConversion(raw: unknown): Promise<SubStoreConversion> {
      return operation(async (signal) => {
        conversion = undefined
        const selection = subStoreSelection(raw),
          runtime = running()
        if (!(await items(selection.kind, signal)).some((item) => item.name === selection.name))
          throw new Error('请选择本次Sub-Store中的订阅或集合。')
        const prefix = selection.kind === 'collection' ? '/download/collection/' : '/download/'
        const text = await runtime.request(
          prefix + encodeURIComponent(selection.name) + '?target=ClashMeta',
          signal
        )
        if (
          signal.aborted ||
          !runtime.alive() ||
          Buffer.byteLength(text) > 2 * 1024 * 1024 ||
          !analyzeProfile(text).data
        )
          throw new Error('Sub-Store转换结果不是可导入的Clash配置。')
        let name = `Sub-Store ${selection.name}`.slice(0, 120)
        const last = name.charCodeAt(name.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) name = name.slice(0, -1)
        const plan = {
          evidenceId: randomUUID(),
          name,
          sha256: createHash('sha256').update(text).digest('hex'),
          bytes: Buffer.byteLength(text)
        }
        conversion = { plan, text, at: now() }
        return plan
      })
    },
    saveConversion(raw: unknown, assertCurrent: () => void = () => {}): Promise<unknown> {
      return operation(async (signal) => {
        assertCurrent()
        const id = subStoreEvidence(raw),
          prepared = conversion
        conversion = undefined
        running()
        const valid = (): boolean =>
          !!prepared && now() >= prepared.at && now() - prepared.at <= 60000
        if (!prepared || prepared.plan.evidenceId !== id || !valid())
          throw new Error('请重新准备Sub-Store转换。')
        const confirmed = await adapters.confirmSave(prepared.plan, signal)
        assertCurrent()
        if (!confirmed || signal.aborted) return { status: 'cancelled' }
        running()
        if (!valid()) throw new Error('Sub-Store转换保存凭据已过期。')
        assertCurrent()
        return adapters.save(prepared.plan.name, prepared.text)
      })
    },
    recover(assertCurrent: () => void = () => {}): Promise<{ status: 'archived' | 'cancelled' }> {
      return operation(async (signal) => {
        if (cleanup) throw new Error('请先结束本次Sub-Store。')
        assertCurrent()
        const record = await inspectSubStoreSession(adapters.resources)
        assertCurrent()
        if (!record?.canArchive) throw new Error('旧会话仍存在或无法确认，未归档。')
        if (!adapters.confirmRecover) return { status: 'cancelled' }
        const confirmed = await adapters.confirmRecover(record, signal)
        assertCurrent()
        if (!confirmed || signal.aborted) return { status: 'cancelled' }
        const current = (): void => {
          assertCurrent()
          if (signal.aborted) throw new Error('旧会话归档已取消。')
        }
        await archiveSubStoreSession(adapters.resources, record, current)
        recovery = undefined
        phase = 'idle'
        warnings = []
        return { status: 'archived' }
      })
    },
    allowedOrigins: (): readonly string[] => (runtime?.alive() ? runtime.origins : []),
    frontendURL: (): string | undefined => (runtime?.alive() ? runtime.frontendURL : undefined),
    cancel(): void {
      conversion = undefined
      controller?.abort()
    },
    async stop(): Promise<SubStoreState> {
      conversion = undefined
      controller?.abort()
      await whenIdle()
      return operation(async () => {
        await stopOwned()
        return state()
      }).then(state)
    },
    async requestClose(): Promise<boolean> {
      closing = true
      conversion = undefined
      controller?.abort()
      await whenIdle()
      try {
        await stopOwned()
        return true
      } catch {
        return false
      } finally {
        closing = false
      }
    }
  }
}
