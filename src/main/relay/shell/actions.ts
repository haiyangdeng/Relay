import {
  shellActionRequest,
  shellProxyEnvironment,
  type RelayShellAction,
  type RelayShellEnvironmentFormat
} from '../../../shared/relay/shell'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import {
  systemProxyReport,
  type SystemProxyPreparation,
  type SystemProxyReport,
  type SystemProxyResult
} from '../../../shared/relay/system-proxy'
import {
  tunSessionResult,
  tunSessionPreparation,
  type TunSessionPreparation,
  tunSessionState,
  type TunSessionResult,
  type TunSessionState
} from '../../../shared/relay/tun'

export interface ShellActionAdapters {
  assertAvailable(): void
  assertIdle(action: RelayShellAction, tunSessionId?: string): void | Promise<void>
  showWindow(): void
  showFloatingWindow(): Promise<void>
  quit(): void
  runInBackground(): Promise<void>
  restart(): Promise<'requested' | 'cancelled' | 'busy'>
  copy(text: string): void
  environmentFormat?(): RelayShellEnvironmentFormat
  notify(): void
  local: {
    state(): LocalProxyState
    mode(instanceId: string, mode: 'rule' | 'global' | 'direct'): Promise<void>
  }
  systemProxy: {
    inspect(): Promise<SystemProxyReport>
    prepareApply(report: SystemProxyReport): Promise<SystemProxyPreparation>
    prepareRestore(): Promise<SystemProxyPreparation>
    execute(request: { evidenceId: string }): Promise<SystemProxyResult>
    cancel(request: { evidenceId: string }): void
  }
  tun: {
    state(): TunSessionState
    inspect(): Promise<TunSessionState>
    prepare(): Promise<TunSessionPreparation>
    start(request: { evidenceId: string }): Promise<TunSessionResult>
    cancel(request: { evidenceId: string }): void
    stop(request: { sessionId: string }): Promise<TunSessionResult>
  }
}
export type ShellActionOutcome = 'performed' | 'restored' | 'cancelled'

// Explicit tray toggles reuse the existing preparation and owner services.
// Main supplies saved settings and the pinned selected profile; no renderer
// channel, native path, arbitrary PID or optimistic checkbox grants execution.
export function createShellActions(adapters: ShellActionAdapters) {
  let pending = false
  const toggleSystemProxy = async (enabled?: boolean): Promise<ShellActionOutcome> => {
    adapters.showWindow()
    const observed = systemProxyReport(await adapters.systemProxy.inspect())
    adapters.assertAvailable()
    await adapters.assertIdle('triggerSysProxy')
    if (!observed.recordID) {
      if (!['inactive', 'restored'].includes(observed.status))
        throw new Error('系统代理状态未确认，请在工作区核对。')
      if (enabled === false) return 'restored'
      const plan = await adapters.systemProxy.prepareApply(observed)
      const request = { evidenceId: plan.evidenceId }
      try {
        adapters.assertAvailable()
        await adapters.assertIdle('triggerSysProxy')
        const prepared = systemProxyReport(plan.report)
        if (
          plan.action !== 'apply' ||
          !prepared.canApply ||
          prepared.recordID ||
          prepared.revision !== observed.revision
        )
          throw new Error('系统代理启用条件已变化，请重新核对。')
        const result = await adapters.systemProxy.execute(request)
        if (result.status === 'cancelled') return 'cancelled'
        if (result.status !== 'applied' || !result.report)
          throw new Error('系统代理启用结果未确认；没有自动重试。')
        const applied = systemProxyReport(result.report)
        if (!['applied', 'active'].includes(applied.status) || !applied.recordID)
          throw new Error('系统代理启用结果未确认；没有自动重试。')
        return 'performed'
      } finally {
        adapters.systemProxy.cancel(request)
      }
    }
    if (!observed.canRestore || ['pending', 'conflict', 'uncertain'].includes(observed.status))
      throw new Error('本次系统代理恢复未确认，请在工作区核对。')
    if (enabled === true && ['active', 'applied'].includes(observed.status)) return 'performed'
    if (enabled === true) throw new Error('现有系统代理记录需要核对。')
    const plan = await adapters.systemProxy.prepareRestore()
    const request = { evidenceId: plan.evidenceId }
    try {
      adapters.assertAvailable()
      await adapters.assertIdle('triggerSysProxy')
      const prepared = systemProxyReport(plan.report)
      if (
        plan.action !== 'restore' ||
        prepared.recordID !== observed.recordID ||
        prepared.revision !== observed.revision ||
        !prepared.canRestore
      )
        throw new Error('系统代理或恢复记录已变化，请重新核对。')
      const result = await adapters.systemProxy.execute(request)
      if (result.status === 'cancelled') return 'cancelled'
      if (result.status !== 'restored' || !result.report)
        throw new Error('系统代理恢复结果未确认；没有自动重试。')
      const restored = systemProxyReport(result.report)
      if (restored.status !== 'restored' || restored.recordID)
        throw new Error('系统代理恢复结果未确认；没有自动重试。')
      return 'restored'
    } finally {
      adapters.systemProxy.cancel(request)
    }
  }
  const stopTun = async (): Promise<ShellActionOutcome> => {
    adapters.showWindow()
    const before = tunSessionState(adapters.tun.state())
    if (before.pending || before.phase === 'uncertain')
      throw new Error('本次TUN操作或恢复尚未确认。')
    await adapters.assertIdle('triggerTun', before.owned ? before.sessionId : undefined)
    const observed = tunSessionState(await adapters.tun.inspect())
    adapters.assertAvailable()
    if (
      observed.pending ||
      observed.phase === 'uncertain' ||
      observed.owned !== before.owned ||
      observed.sessionId !== before.sessionId
    )
      throw new Error('本次TUN会话已变化，请在工作区核对。')
    if (!observed.owned) {
      await adapters.assertIdle('triggerTun')
      const fresh = tunSessionState(adapters.tun.state())
      if (
        fresh.pending ||
        fresh.owned ||
        fresh.phase !== observed.phase ||
        fresh.traffic !== 'inactive'
      )
        throw new Error('本次TUN会话已变化，请在工作区核对。')
      const plan = await adapters.tun.prepare()
      const request = { evidenceId: plan.evidenceId }
      try {
        const prepared = tunSessionPreparation(plan)
        adapters.assertAvailable()
        await adapters.assertIdle('triggerTun')
        const current = tunSessionState(adapters.tun.state())
        if (
          !prepared.readyForConfirmation ||
          prepared.expiresAt <= Date.now() ||
          current.pending ||
          current.owned ||
          current.phase !== 'prepared'
        )
          throw new Error('TUN启用条件已变化或尚未就绪，请重新核对。')
        const result = tunSessionResult(await adapters.tun.start(request))
        if (result.status === 'cancelled') return 'cancelled'
        if (result.status !== 'started' || !result.state.owned || !result.state.sessionId)
          throw new Error('TUN启用结果未确认；没有自动重试。')
        return 'performed'
      } finally {
        adapters.tun.cancel(request)
      }
    }
    const current = tunSessionState(adapters.tun.state())
    if (
      observed.phase !== 'active' ||
      observed.traffic !== 'forwarding' ||
      !observed.sessionId ||
      current.pending ||
      current.phase !== 'active' ||
      !current.owned ||
      current.sessionId !== observed.sessionId ||
      current.traffic !== 'forwarding'
    )
      throw new Error('本次TUN会话已变化，请在工作区核对。')
    await adapters.assertIdle('triggerTun', observed.sessionId)
    const result = tunSessionResult(await adapters.tun.stop({ sessionId: observed.sessionId }))
    if (result.status === 'cancelled') return 'cancelled'
    if (result.status === 'released') return 'performed'
    if (result.status !== 'restored') throw new Error('TUN停用或恢复未确认；没有自动重试。')
    return 'restored'
  }
  return {
    async perform(raw: unknown): Promise<ShellActionOutcome> {
      const request = shellActionRequest(raw)
      const action = typeof request === 'string' ? request : request.action
      if (pending) throw new Error('窗口动作尚未结束。')
      adapters.assertAvailable()
      pending = true
      try {
        switch (action) {
          case 'showWindow':
            adapters.showWindow()
            return 'performed'
          case 'showFloatingWindow':
            await adapters.showFloatingWindow()
            return 'performed'
          case 'runInBackground':
            await adapters.runInBackground()
            return 'performed'
          case 'restartApp': {
            const result = await adapters.restart()
            if (result === 'busy') throw new Error('重启确认或退出恢复尚未结束。')
            return result === 'cancelled' ? 'cancelled' : 'performed'
          }
          case 'quitApp':
            adapters.showWindow()
            adapters.quit()
            return 'performed'
          case 'triggerSysProxy':
            return await toggleSystemProxy(
              typeof request === 'object' && request.action === 'triggerSysProxy'
                ? request.enabled
                : undefined
            )
          case 'triggerTun':
            return await stopTun()
          case 'copyEnv':
          case 'ruleMode':
          case 'globalMode':
          case 'directMode': {
            const state = adapters.local.state()
            if (state.phase !== 'running' || !state.instanceId || state.pending)
              throw new Error('请先明确启动本次自有代理。')
            if (action === 'copyEnv') {
              if (!state.owned || state.uncertain || state.traffic !== 'listening')
                throw new Error('本次自有HTTP监听未确认。')
              if (!state.httpPort) throw new Error('本次HTTP端口未确认。')
              const format =
                typeof request === 'object' && request.action === 'copyEnv'
                  ? request.format
                  : (adapters.environmentFormat?.() ?? 'default')
              adapters.copy(shellProxyEnvironment(state.httpPort, format))
              return 'performed'
            }
            await adapters.assertIdle(action)
            const modes = { ruleMode: 'rule', globalMode: 'global', directMode: 'direct' } as const
            await adapters.local.mode(state.instanceId, modes[action])
            adapters.notify()
            return 'performed'
          }
          default: {
            const unsupported: never = action
            throw new Error(`窗口动作未支持：${unsupported}`)
          }
        }
      } finally {
        pending = false
      }
    }
  }
}
