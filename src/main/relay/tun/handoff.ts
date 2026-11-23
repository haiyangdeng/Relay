import {
  ordinaryRecoveryNotice,
  type TunOrdinaryRecovery,
  type TunSessionResult,
  type TunSessionState
} from '../../../shared/relay/tun'

export type TunSelectorChoice = { name: string; now: string | null }

export interface TunHandoffContext {
  fixedGroups?: { name: string; member: string }[]
  instanceId?: string
  httpPort: number
  mixedPort?: number
  proxyPorts?: readonly number[]
  recheck(): Promise<void>
  recheckResume(): Promise<void>
  authorizeStop(): void
  assertCurrentOwner(): void
  stopLocal(): Promise<boolean>
  resumeLocal(choices?: readonly TunSelectorChoice[]): Promise<void>
  authorized(): boolean
}

// A handoff may observe a Relay-owned system proxy to decide if its listener
// is needed. It never writes macOS proxy settings.
export function createTunHandoff(adapters: {
  state(): TunSessionState
  localOwned?(): boolean
  systemProxyNeeded?(ports: readonly number[]): boolean | Promise<boolean>
  notify?(): void
  readSelections?(): Promise<readonly TunSelectorChoice[]>
  start(input: { evidenceId: string }): Promise<TunSessionResult>
  stop(input: { sessionId: string }): Promise<TunSessionResult>
}) {
  const prepared = new Map<string, TunHandoffContext>()
  const active = new Map<string, { context: TunHandoffContext; started: boolean }>()
  type Recovery = {
    sessionId: string
    context: TunHandoffContext
    choices?: readonly TunSelectorChoice[]
    result: TunSessionResult
    status: TunOrdinaryRecovery
  }
  let recovery: Recovery | undefined
  let busy = false
  const released = (state: TunSessionState): boolean =>
    !state.pending &&
    !state.owned &&
    state.phase !== 'uncertain' &&
    (state.restorationVerified ||
      state.phase === 'idle' ||
      state.phase === 'prepared' ||
      state.phase === 'released')
  const resume = async (
    context: TunHandoffContext,
    choices?: readonly TunSelectorChoice[]
  ): Promise<boolean> => {
    if (!context.authorized() || !released(adapters.state())) return false
    await context.recheckResume()
    await context.resumeLocal(choices)
    return true
  }
  const notify = (): void => {
    try {
      adapters.notify?.()
    } catch {
      /* A closed window cannot change the handoff outcome. */
    }
  }
  const clearRecovery = (): void => {
    if (!recovery) return
    recovery = undefined
    notify()
  }
  const finishOrdinary = async (operation: Recovery): Promise<TunSessionResult> => {
    const { sessionId, context, choices, result } = operation
    recovery = operation
    operation.status = { sessionId, phase: 'resuming' }
    notify()
    let reason: Extract<TunOrdinaryRecovery, { phase: 'failed' }>['reason'] = 'authorization'
    try {
      if (!context.authorized() || !released(adapters.state())) throw new Error()
      reason = 'systemProxy'
      const needed =
        !!context.instanceId ||
        (await adapters.systemProxyNeeded?.(
          context.proxyPorts ?? [
            context.httpPort,
            ...(context.mixedPort ? [context.mixedPort] : [])
          ]
        ))
      if (!needed) {
        clearRecovery()
        return result
      }
      reason = 'source'
      await context.recheckResume()
      reason = 'authorization'
      if (!context.authorized() || !released(adapters.state())) throw new Error()
      reason = 'listener'
      await context.resumeLocal(choices)
    } catch {
      operation.status = { sessionId, phase: 'failed', reason }
      notify()
      return {
        status: 'failed',
        ordinaryRecovery: operation.status,
        state: {
          ...result.state,
          warnings: [
            ...result.state.warnings.slice(0, 31),
            ordinaryRecoveryNotice(operation.status)
          ]
        }
      }
    }
    clearRecovery()
    return {
      ...result,
      state: {
        ...result.state,
        warnings: [...result.state.warnings.slice(0, 31), 'TUN 已关闭，普通代理继续运行。']
      }
    }
  }
  return {
    isBusy: () => busy,
    ordinaryRecovery: (): TunOrdinaryRecovery | undefined => {
      const state = adapters.state()
      return recovery && released(state) ? { ...recovery.status } : undefined
    },
    clearOrdinaryRecovery(): void {
      if (!busy) clearRecovery()
    },
    async recoverOrdinary(input: { sessionId: string }): Promise<TunSessionResult> {
      if (busy) throw new Error('核心切换正在进行。')
      const pending = recovery
      const state = adapters.state()
      if (
        !pending ||
        pending.status.phase !== 'failed' ||
        pending.sessionId !== input.sessionId ||
        !released(state)
      ) {
        throw new Error('本次普通代理恢复记录已经失效。')
      }
      busy = true
      try {
        pending.context.authorizeStop()
        return await finishOrdinary(pending)
      } finally {
        busy = false
      }
    },
    proxyPort: () => active.get(adapters.state().sessionId ?? '')?.context.httpPort,
    mixedPort: () => active.get(adapters.state().sessionId ?? '')?.context.mixedPort,
    remember(evidenceId: string, context: TunHandoffContext): void {
      if (busy) throw new Error('核心切换正在进行。')
      if (!released(adapters.state())) throw new Error('请先结束本次 TUN 会话并确认恢复。')
      active.clear()
      prepared.clear()
      prepared.set(evidenceId, context)
    },
    cancel(evidenceId: string): void {
      prepared.delete(evidenceId)
    },
    async start(input: { evidenceId: string }): Promise<TunSessionResult> {
      if (busy) throw new Error('核心切换正在进行。')
      const context = prepared.get(input.evidenceId)
      prepared.delete(input.evidenceId)
      if (!context) {
        if (adapters.localOwned?.()) throw new Error('普通代理切换凭据已失效，请重新准备。')
        const result = await adapters.start(input)
        if (result.state.owned) clearRecovery()
        return result
      }
      busy = true
      let stopped = false,
        recoveryAttempted = false
      try {
        if (!context.authorized()) throw new Error('本次切换授权已失效。')
        await context.recheck()
        context.assertCurrentOwner()
        if (context.instanceId) {
          if (!(await context.stopLocal())) throw new Error('普通代理停止未确认，未启动 TUN。')
          stopped = true
        }
        if (!context.authorized()) throw new Error('本次切换授权已失效。')
        const result = await adapters.start(input)
        if (result.state.owned) clearRecovery()
        if (result.status === 'started' && result.state.sessionId) {
          active.set(result.state.sessionId, { context, started: true })
          return result
        }
        // A failed readiness check can leave the native session owned while it
        // recovers. Keep only this stopped core's context for explicit stop;
        // an uncertain native state must never trigger a second core here.
        const current = adapters.state()
        if (
          stopped &&
          result.state.owned &&
          result.state.sessionId &&
          current.owned &&
          current.sessionId === result.state.sessionId
        )
          active.set(result.state.sessionId, { context, started: false })
        if (stopped) recoveryAttempted = true
        if (stopped && (await resume(context)))
          return {
            ...result,
            state: {
              ...result.state,
              warnings: [
                ...result.state.warnings,
                'TUN 未启用，普通代理已恢复；系统代理设置保持不变。'
              ]
            }
          }
        return result
      } catch (error) {
        if (stopped && !recoveryAttempted && (await resume(context)))
          return {
            status: 'failed',
            state: {
              ...adapters.state(),
              warnings: ['TUN 未启用，普通代理已恢复；系统代理设置保持不变。']
            }
          }
        throw error
      } finally {
        busy = false
      }
    },
    // Only explicit user stop uses this path. Quit/uninstall continue to call
    // tunSession.requestClose directly and must never resurrect a local core.
    async stop(input: { sessionId: string }): Promise<TunSessionResult> {
      if (busy) throw new Error('核心切换正在进行。')
      busy = true
      try {
        if (recovery?.sessionId === input.sessionId)
          throw new Error('本次 TUN 已关闭，请使用普通代理恢复操作。')
        const retained = active.get(input.sessionId),
          context = retained?.context
        let choices: readonly TunSelectorChoice[] | undefined
        if (context) {
          const current = adapters.state()
          if (!current.owned || current.sessionId !== input.sessionId) {
            active.delete(input.sessionId)
            throw new Error('本次 TUN 会话已变化，不能恢复旧的普通代理。')
          }
          context.authorizeStop()
          if (!context.authorized()) throw new Error('本次停用授权已失效。')
          // An unavailable controller must not veto closing the tunnel.
          if (retained?.started && current.phase === 'active')
            choices = await adapters.readSelections?.().catch(() => undefined)
        }
        const result = await adapters.stop(input)
        if (
          context &&
          (result.status === 'restored' || result.status === 'released') &&
          released(result.state) &&
          released(adapters.state())
        ) {
          active.delete(input.sessionId)
          return await finishOrdinary({
            sessionId: input.sessionId,
            context,
            choices,
            result,
            status: { sessionId: input.sessionId, phase: 'resuming' }
          })
        }
        return result
      } finally {
        busy = false
      }
    }
  }
}
