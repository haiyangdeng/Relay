import { describe, expect, it, vi } from 'vitest'
import type { TunSessionState, TunSessionResult } from '../../../shared/relay/tun'
import { createTunHandoff, type TunHandoffContext } from './handoff'
const idle = (): TunSessionState => ({
  phase: 'prepared',
  pending: false,
  owned: false,
  traffic: 'inactive',
  restorationVerified: false,
  protectionVerified: false,
  warnings: []
})
function fixture() {
  let state = idle()
  const order: string[] = []
  const context: TunHandoffContext = {
    instanceId: 'local',
    httpPort: 7892,
    authorized: vi.fn(() => true),
    recheck: vi.fn(async () => {}),
    recheckResume: vi.fn(async () => {}),
    authorizeStop: vi.fn(),
    assertCurrentOwner: vi.fn(),
    stopLocal: vi.fn(async () => {
      order.push('local-stop')
      return true
    }),
    resumeLocal: vi.fn(async () => {
      order.push('local-start')
    })
  }
  const adapters = {
    state: () => state,
    systemProxyNeeded: vi.fn(async () => false),
    notify: vi.fn(),
    readSelections: vi.fn(async () => [{ name: 'Proxy', now: 'Node B' }]),
    start: vi.fn(async (): Promise<TunSessionResult> => {
      order.push('tun-start')
      state = { ...idle(), phase: 'active', owned: true, sessionId: 'tun', traffic: 'forwarding' }
      return { status: 'started', state }
    }),
    stop: vi.fn(async (): Promise<TunSessionResult> => {
      order.push('tun-stop')
      state = { ...idle(), phase: 'restored', restorationVerified: true }
      return { status: 'restored', state }
    })
  }
  const handoff = createTunHandoff(adapters)
  handoff.remember('proof', context)
  return {
    context,
    adapters,
    handoff,
    order,
    setState: (value: TunSessionState) => {
      state = value
    }
  }
}
function failWithOwnedSession(f: ReturnType<typeof fixture>, sessionId = 'tun'): void {
  f.adapters.start.mockImplementation(async () => {
    f.order.push('tun-start')
    const state: TunSessionState = {
      ...idle(),
      phase: 'uncertain',
      owned: true,
      sessionId,
      traffic: 'unconfirmed'
    }
    f.setState(state)
    return { status: 'uncertain', state }
  })
}
describe('TUN user-intent handoff preserving system proxy settings', () => {
  it('does not stop during preparation and restores local only after verified TUN stop', async () => {
    const f = fixture()
    expect(f.order).toEqual([])
    expect((await f.handoff.start({ evidenceId: 'proof' })).status).toBe('started')
    expect(f.handoff.proxyPort()).toBe(7892)
    await f.handoff.stop({ sessionId: 'tun' })
    expect(f.order).toEqual(['local-stop', 'tun-start', 'tun-stop', 'local-start'])
  })
  it('keeps ordinary core alive when its source changes before commit', async () => {
    const f = fixture()
    vi.mocked(f.context.recheck).mockRejectedValue(new Error('changed'))
    await expect(f.handoff.start({ evidenceId: 'proof' })).rejects.toThrow('changed')
    expect(f.order).toEqual([])
  })
  it('does not start TUN after uncertain ordinary stop', async () => {
    const f = fixture()
    vi.mocked(f.context.stopLocal).mockResolvedValue(false)
    await expect(f.handoff.start({ evidenceId: 'proof' })).rejects.toThrow('停止未确认')
    expect(f.adapters.start).not.toHaveBeenCalled()
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
  })
  it('recovers ordinary service on explicit failed-and-restored TUN startup', async () => {
    const f = fixture()
    f.adapters.start.mockImplementation(async () => {
      const state = { ...idle(), phase: 'restored' as const, restorationVerified: true }
      f.setState(state)
      return { status: 'failed', state }
    })
    const result = await f.handoff.start({ evidenceId: 'proof' })
    expect(result.status).toBe('failed')
    expect(result.state.warnings.join('')).toContain('普通代理已恢复')
    expect(f.context.resumeLocal).toHaveBeenCalledOnce()
  })
  it('never starts a second core while native cleanup is uncertain', async () => {
    const f = fixture()
    f.adapters.start.mockImplementation(async () => {
      const state = { ...idle(), phase: 'uncertain' as const, owned: true }
      f.setState(state)
      return { status: 'uncertain', state }
    })
    expect((await f.handoff.start({ evidenceId: 'proof' })).status).toBe('uncertain')
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
  })
  it('retains a failed owned handoff until explicit stop verifies native restoration', async () => {
    const f = fixture()
    failWithOwnedSession(f)
    expect((await f.handoff.start({ evidenceId: 'proof' })).status).toBe('uncertain')
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
    expect(f.handoff.proxyPort()).toBe(7892)
    const result = await f.handoff.stop({ sessionId: 'tun' })
    expect(result.status).toBe('restored')
    expect(result.state.warnings.join('')).toContain('普通代理继续运行')
    expect(f.context.authorizeStop).toHaveBeenCalledOnce()
    expect(f.context.recheckResume).toHaveBeenCalledOnce()
    expect(f.order).toEqual(['local-stop', 'tun-start', 'tun-stop', 'local-start'])
  })
  it('keeps the same recovery context across repeated uncertain stop results', async () => {
    const f = fixture()
    failWithOwnedSession(f)
    await f.handoff.start({ evidenceId: 'proof' })
    f.adapters.stop.mockImplementationOnce(async () => ({
      status: 'uncertain',
      state: f.adapters.state()
    }))
    expect((await f.handoff.stop({ sessionId: 'tun' })).status).toBe('uncertain')
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
    await f.handoff.stop({ sessionId: 'tun' })
    expect(f.context.resumeLocal).toHaveBeenCalledOnce()
    await f.handoff.stop({ sessionId: 'tun' })
    expect(f.context.resumeLocal).toHaveBeenCalledOnce()
  })
  it('cleans up a failed native session even when its ordinary configuration is unavailable', async () => {
    const f = fixture()
    failWithOwnedSession(f)
    await f.handoff.start({ evidenceId: 'proof' })
    vi.mocked(f.context.recheckResume).mockRejectedValue(new Error('private source removed'))
    const result = await f.handoff.stop({ sessionId: 'tun' })
    expect(f.adapters.stop).toHaveBeenCalledOnce()
    expect(f.context.recheckResume).toHaveBeenCalledOnce()
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.ordinaryRecovery).toEqual({ sessionId: 'tun', phase: 'failed', reason: 'source' })
    expect(f.handoff.ordinaryRecovery()).toEqual(result.ordinaryRecovery)
    expect(result.state).toMatchObject({ owned: false, restorationVerified: true })
    expect(result.state.warnings.join('')).toContain('普通代理恢复未确认')
    expect(result.state.warnings.join('')).not.toContain('private source')
    expect(f.order).toEqual(['local-stop', 'tun-start', 'tun-stop'])
  })
  it('reports verified TUN cleanup when ordinary recovery itself fails without retrying it', async () => {
    const f = fixture()
    failWithOwnedSession(f)
    await f.handoff.start({ evidenceId: 'proof' })
    vi.mocked(f.context.resumeLocal).mockRejectedValue(new Error('private occupied port'))
    const result = await f.handoff.stop({ sessionId: 'tun' })
    expect(result.status).toBe('failed')
    expect(result.ordinaryRecovery).toEqual({
      sessionId: 'tun',
      phase: 'failed',
      reason: 'listener'
    })
    expect(f.handoff.ordinaryRecovery()).toEqual(result.ordinaryRecovery)
    expect(result.state.owned).toBe(false)
    expect(result.state.warnings.join('')).toContain('普通代理恢复未确认')
    expect(result.state.warnings.join('')).not.toContain('private occupied')
    await expect(f.handoff.stop({ sessionId: 'tun' })).rejects.toThrow('已关闭')
    expect(f.context.resumeLocal).toHaveBeenCalledOnce()
    expect(f.context.authorizeStop).toHaveBeenCalledOnce()
  })
  it('keeps explicit stop authorization for failed sessions and checks it on every retry', async () => {
    const f = fixture()
    failWithOwnedSession(f)
    await f.handoff.start({ evidenceId: 'proof' })
    f.adapters.stop.mockImplementationOnce(async () => ({
      status: 'uncertain',
      state: f.adapters.state()
    }))
    await f.handoff.stop({ sessionId: 'tun' })
    vi.mocked(f.context.authorized).mockReturnValue(false)
    await expect(f.handoff.stop({ sessionId: 'tun' })).rejects.toThrow('授权已失效')
    expect(f.context.authorizeStop).toHaveBeenCalledTimes(2)
    expect(f.adapters.stop).toHaveBeenCalledOnce()
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
  })
  it('waits for failed-session cleanup before checking or resuming ordinary configuration', async () => {
    const f = fixture()
    failWithOwnedSession(f)
    await f.handoff.start({ evidenceId: 'proof' })
    vi.mocked(f.context.recheckResume).mockRejectedValue(new Error('source not yet available'))
    f.adapters.stop.mockImplementationOnce(async () => ({
      status: 'uncertain',
      state: f.adapters.state()
    }))
    const result = await f.handoff.stop({ sessionId: 'tun' })
    expect(result.status).toBe('uncertain')
    expect(f.context.recheckResume).not.toHaveBeenCalled()
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
    vi.mocked(f.context.recheckResume).mockResolvedValue(undefined)
    await f.handoff.stop({ sessionId: 'tun' })
    expect(f.context.resumeLocal).toHaveBeenCalledOnce()
  })
  it('does not resume an ordinary core when authority expires during failed-session cleanup', async () => {
    const f = fixture()
    failWithOwnedSession(f)
    await f.handoff.start({ evidenceId: 'proof' })
    f.adapters.stop.mockImplementation(async () => {
      const state = { ...idle(), phase: 'restored' as const, restorationVerified: true }
      f.setState(state)
      vi.mocked(f.context.authorized).mockReturnValue(false)
      return { status: 'restored', state }
    })
    const result = await f.handoff.stop({ sessionId: 'tun' })
    expect(result.status).toBe('failed')
    expect(result.ordinaryRecovery).toEqual({
      sessionId: 'tun',
      phase: 'failed',
      reason: 'authorization'
    })
    expect(f.handoff.ordinaryRecovery()).toEqual(result.ordinaryRecovery)
    expect(result.state.warnings.join('')).toContain('普通代理恢复未确认')
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
  })
  it('does not bind failed recovery to a different current native session', async () => {
    const f = fixture()
    f.adapters.start.mockImplementation(async () => {
      const state: TunSessionState = {
        ...idle(),
        phase: 'uncertain',
        owned: true,
        sessionId: 'old-tun'
      }
      f.setState({ ...state, sessionId: 'new-tun' })
      return { status: 'uncertain', state }
    })
    await f.handoff.start({ evidenceId: 'proof' })
    expect(f.handoff.proxyPort()).toBeUndefined()
    await f.handoff.stop({ sessionId: 'new-tun' })
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
  })
  it('does not retain failed recovery when no ordinary core was stopped', async () => {
    const f = fixture()
    f.context.instanceId = undefined
    failWithOwnedSession(f)
    await f.handoff.start({ evidenceId: 'proof' })
    expect(f.context.stopLocal).not.toHaveBeenCalled()
    await f.handoff.stop({ sessionId: 'tun' })
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
  })
  it('rejects new preparation while a failed owned session still needs restoration', async () => {
    const f = fixture()
    failWithOwnedSession(f)
    await f.handoff.start({ evidenceId: 'proof' })
    expect(() => f.handoff.remember('new-proof', { ...f.context })).toThrow('TUN')
    await f.handoff.stop({ sessionId: 'tun' })
    expect(f.context.resumeLocal).toHaveBeenCalledOnce()
  })
  it('never uses an old recovery context to stop a replacement native session', async () => {
    const f = fixture()
    failWithOwnedSession(f)
    await f.handoff.start({ evidenceId: 'proof' })
    f.setState({ ...f.adapters.state(), sessionId: 'replacement' })
    await expect(f.handoff.stop({ sessionId: 'tun' })).rejects.toThrow('会话')
    expect(f.adapters.stop).not.toHaveBeenCalled()
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
  })
  it.each(['quit', 'uninstall'])(
    'does not resurrect after %s releases native directly',
    async () => {
      const f = fixture()
      await f.handoff.start({ evidenceId: 'proof' })
      await f.adapters.stop()
      expect(f.context.resumeLocal).not.toHaveBeenCalled()
      await expect(f.handoff.stop({ sessionId: 'tun' })).rejects.toThrow('会话')
      expect(f.context.authorizeStop).not.toHaveBeenCalled()
      expect(f.context.resumeLocal).not.toHaveBeenCalled()
    }
  )
  it.each(['quit', 'uninstall'])(
    'does not resurrect a failed handoff after %s releases native directly',
    async () => {
      const f = fixture()
      failWithOwnedSession(f)
      await f.handoff.start({ evidenceId: 'proof' })
      await f.adapters.stop()
      await expect(f.handoff.stop({ sessionId: 'tun' })).rejects.toThrow('会话')
      expect(f.context.authorizeStop).not.toHaveBeenCalled()
      expect(f.context.resumeLocal).not.toHaveBeenCalled()
    }
  )
  it('discards a released previous recovery context before remembering a new preparation', async () => {
    const f = fixture()
    await f.handoff.start({ evidenceId: 'proof' })
    await f.adapters.stop()
    const next = { ...f.context, resumeLocal: vi.fn(async () => {}) }
    f.handoff.remember('next-proof', next)
    await f.handoff.stop({ sessionId: 'tun' })
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
    expect(next.resumeLocal).not.toHaveBeenCalled()
  })
  it('does not resurrect a core after the originating window/quit authority is revoked', async () => {
    const f = fixture()
    await f.handoff.start({ evidenceId: 'proof' })
    vi.mocked(f.context.authorized).mockReturnValue(false)
    await expect(f.handoff.stop({ sessionId: 'tun' })).rejects.toThrow('授权已失效')
    expect(f.adapters.stop).not.toHaveBeenCalled()
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
  })
  it('serializes concurrent switch intents', async () => {
    const f = fixture()
    let finish!: (value: boolean) => void
    vi.mocked(f.context.stopLocal).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = f.handoff.start({ evidenceId: 'proof' })
    await vi.waitFor(() => expect(f.context.stopLocal).toHaveBeenCalled())
    await expect(f.handoff.start({ evidenceId: 'proof' })).rejects.toThrow('切换正在进行')
    finish(true)
    await pending
    expect(f.adapters.start).toHaveBeenCalledOnce()
  })
  it('does not retry a failed ordinary recovery', async () => {
    const f = fixture()
    f.adapters.start.mockResolvedValue({ status: 'failed', state: idle() })
    vi.mocked(f.context.resumeLocal).mockRejectedValue(new Error('occupied'))
    await expect(f.handoff.start({ evidenceId: 'proof' })).rejects.toThrow('occupied')
    expect(f.context.resumeLocal).toHaveBeenCalledOnce()
  })
  it('closes an active tunnel when its previous ordinary profile has been removed', async () => {
    const f = fixture()
    await f.handoff.start({ evidenceId: 'proof' })
    vi.mocked(f.context.recheckResume).mockRejectedValue(new Error('profile removed'))
    const result = await f.handoff.stop({ sessionId: 'tun' })
    expect(result.status).toBe('failed')
    expect(result.ordinaryRecovery).toEqual({ sessionId: 'tun', phase: 'failed', reason: 'source' })
    expect(f.handoff.ordinaryRecovery()).toEqual(result.ordinaryRecovery)
    expect(result.state.warnings.join('')).toContain('普通代理恢复未确认')
    expect(f.context.authorizeStop).toHaveBeenCalledOnce()
    expect(f.order).toEqual(['local-stop', 'tun-start', 'tun-stop'])
  })
  it.each([false, true])(
    'restores without a pre-existing ordinary owner only when Relay system proxy is needed at stop: %s',
    async (duringTun) => {
      const f = fixture()
      f.context.instanceId = undefined
      await f.handoff.start({ evidenceId: 'proof' })
      f.context.proxyPorts = [7890, 7891, 17890, 17891]
      f.adapters.systemProxyNeeded.mockResolvedValue(duringTun)
      await f.handoff.stop({ sessionId: 'tun' })
      expect(f.context.stopLocal).not.toHaveBeenCalled()
      expect(f.adapters.systemProxyNeeded).toHaveBeenCalledWith([7890, 7891, 17890, 17891])
      expect(f.context.resumeLocal).toHaveBeenCalledTimes(duringTun ? 1 : 0)
      expect(f.handoff.ordinaryRecovery()).toBeUndefined()
    }
  )
  it('keeps a partial system proxy dependency recoverable until a fresh read resolves it', async () => {
    const f = fixture()
    f.context.instanceId = undefined
    await f.handoff.start({ evidenceId: 'proof' })
    f.adapters.systemProxyNeeded.mockRejectedValueOnce(new Error('dependency unknown'))
    const first = await f.handoff.stop({ sessionId: 'tun' })
    expect(first.ordinaryRecovery).toEqual({
      sessionId: 'tun',
      phase: 'failed',
      reason: 'systemProxy'
    })
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
    f.adapters.systemProxyNeeded.mockResolvedValue(true)
    expect((await f.handoff.recoverOrdinary({ sessionId: 'tun' })).status).toBe('restored')
    expect(f.context.resumeLocal).toHaveBeenCalledOnce()
    expect(f.adapters.stop).toHaveBeenCalledOnce()
  })
  it('publishes the unfinished handoff until the ordinary listener and selected groups are confirmed', async () => {
    const f = fixture()
    let release!: () => void
    vi.mocked(f.context.resumeLocal).mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done
        })
    )
    await f.handoff.start({ evidenceId: 'proof' })
    const stopping = f.handoff.stop({ sessionId: 'tun' })
    await vi.waitFor(() => expect(f.context.resumeLocal).toHaveBeenCalled())
    expect(f.handoff.ordinaryRecovery()).toEqual({ sessionId: 'tun', phase: 'resuming' })
    expect(f.handoff.isBusy()).toBe(true)
    await expect(f.handoff.recoverOrdinary({ sessionId: 'tun' })).rejects.toThrow('正在进行')
    release()
    expect((await stopping).status).toBe('restored')
    expect(f.handoff.ordinaryRecovery()).toBeUndefined()
  })
  it('continues only the exact released session on explicit recovery, retaining its selectors and never stopping native twice', async () => {
    const f = fixture()
    await f.handoff.start({ evidenceId: 'proof' })
    vi.mocked(f.context.resumeLocal).mockRejectedValueOnce(new Error('private occupied port'))
    const stop = await f.handoff.stop({ sessionId: 'tun' })
    expect(stop.ordinaryRecovery?.phase).toBe('failed')
    await expect(f.handoff.recoverOrdinary({ sessionId: 'other' })).rejects.toThrow('失效')
    expect((await f.handoff.recoverOrdinary({ sessionId: 'tun' })).status).toBe('restored')
    expect(f.context.authorizeStop).toHaveBeenCalledTimes(2)
    expect(f.context.resumeLocal).toHaveBeenNthCalledWith(2, [{ name: 'Proxy', now: 'Node B' }])
    expect(f.adapters.stop).toHaveBeenCalledOnce()
    expect(f.handoff.ordinaryRecovery()).toBeUndefined()
    await expect(f.handoff.recoverOrdinary({ sessionId: 'tun' })).rejects.toThrow('失效')
  })
  it('retains a failed ordinary recovery through prepare/cancel but revokes it once a new TUN really starts', async () => {
    const f = fixture()
    await f.handoff.start({ evidenceId: 'proof' })
    vi.mocked(f.context.resumeLocal).mockRejectedValueOnce(Error('occupied'))
    await f.handoff.stop({ sessionId: 'tun' })
    f.setState(idle())
    f.handoff.remember('second', f.context)
    f.handoff.cancel('second')
    expect(f.handoff.ordinaryRecovery()?.phase).toBe('failed')
    f.handoff.remember('third', f.context)
    await f.handoff.start({ evidenceId: 'third' })
    expect(f.handoff.ordinaryRecovery()).toBeUndefined()
    await expect(f.handoff.recoverOrdinary({ sessionId: 'tun' })).rejects.toThrow('失效')
  })
  it('invalidates recovery after explicit reconnection or replacement and never resumes an unrelated session', async () => {
    const f = fixture()
    await f.handoff.start({ evidenceId: 'proof' })
    vi.mocked(f.context.recheckResume).mockRejectedValueOnce(new Error('private source'))
    await f.handoff.stop({ sessionId: 'tun' })
    const restored = f.adapters.state()
    f.setState({
      ...restored,
      phase: 'active',
      owned: true,
      sessionId: 'other',
      traffic: 'forwarding'
    })
    expect(f.handoff.ordinaryRecovery()).toBeUndefined()
    await expect(f.handoff.recoverOrdinary({ sessionId: 'tun' })).rejects.toThrow('失效')
    f.setState(restored)
    f.handoff.clearOrdinaryRecovery()
    await expect(f.handoff.recoverOrdinary({ sessionId: 'tun' })).rejects.toThrow('失效')
    expect(f.context.resumeLocal).not.toHaveBeenCalled()
    expect(f.adapters.stop).toHaveBeenCalledOnce()
  })
  it('returns the latest TUN group choices to the local core after proven release', async () => {
    const f = fixture()
    await f.handoff.start({ evidenceId: 'proof' })
    f.adapters.stop.mockImplementationOnce(async () => {
      const state = { ...idle(), phase: 'released' as const }
      f.setState(state)
      return { status: 'released', state }
    })
    const result = await f.handoff.stop({ sessionId: 'tun' })
    expect(result.status).toBe('released')
    expect(f.context.resumeLocal).toHaveBeenCalledExactlyOnceWith([
      { name: 'Proxy', now: 'Node B' }
    ])
  })
  it('closes and resumes with the prior choices if the TUN controller cannot read selections', async () => {
    const f = fixture()
    await f.handoff.start({ evidenceId: 'proof' })
    f.adapters.readSelections.mockRejectedValueOnce(new Error('socket unavailable'))
    expect((await f.handoff.stop({ sessionId: 'tun' })).status).toBe('restored')
    expect(f.context.resumeLocal).toHaveBeenCalledExactlyOnceWith(undefined)
  })
})
