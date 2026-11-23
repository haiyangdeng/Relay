import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  TunSessionPreparation,
  TunSessionState,
  TunStatus
} from '../../../../shared/relay/tun'
import { systemProxyListenerPort } from './system-proxy-actions'
import { createTunRendererApi } from './tun-api'
import {
  createTunPanelController,
  activeTunSwitch,
  tunSwitchProgress,
  tunStoppingNotice,
  type TunPanelSnapshot
} from './tun-controller'
import { RelayTunControls } from './tun-panel'

const completeId = '11111111-1111-4111-8111-111111111111',
  preparedId = '22222222-2222-4222-8222-222222222222',
  sessionId = '33333333-3333-4333-8333-333333333333'
const idle: TunSessionState = {
  phase: 'idle',
  pending: false,
  owned: false,
  traffic: 'inactive',
  restorationVerified: false,
  protectionVerified: false,
  warnings: []
}
const active: TunSessionState = {
  ...idle,
  phase: 'active',
  owned: true,
  traffic: 'forwarding',
  sessionId
}
const restored: TunSessionState = { ...idle, phase: 'restored', restorationVerified: true }
const plan: TunSessionPreparation = {
  version: 1,
  evidenceId: preparedId,
  configurationSHA256: 'a'.repeat(64),
  bundleSHA256: 'b'.repeat(64),
  tunSHA256: 'c'.repeat(64),
  assetsSHA256: 'd'.repeat(64),
  helperRevision: 'e'.repeat(64),
  networkRevision: 'f'.repeat(64),
  evidenceSHA256: '1'.repeat(64),
  createdAt: 1000,
  expiresAt: 61000,
  readyForConfirmation: true,
  canApply: false,
  active: false,
  runtimeVerified: false,
  protectionVerified: false,
  effects: { device: 'utun', autoRoute: true, dnsHijack: true },
  issues: []
}
const status = (session = idle): TunStatus => ({ session, helper: 'ready', warnings: [] })
const render = (
  snapshot: Partial<TunPanelSnapshot> = {},
  evidence: string | undefined = completeId,
  now = 1000,
  activationBlocked = false
): string =>
  renderToStaticMarkup(
    createElement(RelayTunControls, {
      snapshot: { pending: false, unconfirmed: false, notice: '', ...snapshot },
      completeEvidenceId: evidence,
      busy: false,
      activationBlocked,
      now,
      onAction: () => {},
      onCancel: () => {}
    })
  )
function fixture(
  options: Pick<Parameters<typeof createTunPanelController>[0], 'prepareEvidence' | 'context'> = {}
) {
  let evidence: string | undefined = completeId,
    externalBusy = false,
    activationBlocked = false
  const invoke = vi.fn(async (channel: string, _input?: unknown): Promise<unknown> => {
      if (channel === 'relayTunStatus') return status()
      if (channel === 'relayTunPrepare') return plan
      if (channel === 'relayTunStart') return { status: 'started', state: active }
      if (channel === 'relayTunStop') return { status: 'restored', state: restored }
      if (channel === 'relayTunInspect') return active
      if (channel === 'relayTunCancel') return undefined
      throw new Error('unexpected channel')
    }),
    onBusy = vi.fn(),
    control = createTunPanelController({
      api: createTunRendererApi(invoke),
      evidence: () => evidence,
      busy: () => externalBusy,
      activationBlocked: () => activationBlocked,
      onBusy,
      now: () => 1000,
      ...options
    })
  return {
    control,
    invoke,
    onBusy,
    evidence: (next?: string) => {
      evidence = next
    },
    busy: (next: boolean) => {
      externalBusy = next
    },
    activationBlocked: (next: boolean) => {
      activationBlocked = next
    }
  }
}

describe('TUN controls and opaque renderer flow', () => {
  it('uses only the verified listener for system HTTP and SOCKS under TUN', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel !== 'relayEnsureSystemProxyListener') throw new Error('Unexpected IPC')
      return { httpPort: 7890, mixedPort: 7893 }
    })
    expect(
      await systemProxyListenerPort(invoke, () => true, { mode: 'manual', socks: false })
    ).toBe(7890)
    expect(await systemProxyListenerPort(invoke, () => true, { mode: 'manual', socks: true })).toBe(
      7893
    )
    expect(invoke.mock.calls).toEqual([
      ['relayEnsureSystemProxyListener'],
      ['relayEnsureSystemProxyListener']
    ])
  })
  it('does not offer an unprepared, expired or source-mismatched start', () => {
    for (const html of [
      render(),
      render({ preparation: plan, preparedFor: completeId }, completeId, 61001),
      render({ preparation: plan, preparedFor: preparedId })
    ])
      expect(html).not.toContain('确认并启用本次TUN')
    expect(render({}, '')).toContain('先在完整运行配置面板')
    expect(render()).not.toContain('grantTunPermissions')
    expect(render()).not.toContain('restartCore')
  })
  it('shows missing-helper instructions and exact main-process candidate hints without enabling installation', () => {
    const html = render({
      status: {
        session: idle,
        helper: 'missing',
        warnings: ['候选：/fixture/RelayTunHelper.pkg；核对授权说明后手工安装。']
      }
    })
    expect(html).toContain('辅助组件尚未安装')
    expect(html).toContain('/fixture/RelayTunHelper.pkg')
    expect(html).toContain('手动安装')
    expect(html).not.toMatch(/<button[^>]*>[^<]*安装/)
  })
  it('keeps owned-session recovery available and never equates forwarding with protection', () => {
    const html = render({ status: status(active) })
    expect(html).toMatch(/<button>停用并恢复本次TUN/)
    expect(html).toMatch(/<button>重新复核本次TUN/)
    expect(html).toContain('不代表Claude禁止直连保护已验证')
    expect(html).not.toContain('网络恢复已确认')
    expect(render({ status: status(restored) })).toContain('网络恢复已确认')
  })
  it.each([active, restored])(
    'does not present an unconfirmed snapshot as current success',
    (session) => {
      const html = render({ status: status(session), unconfirmed: true })
      expect(html).toContain('结果待复核')
      expect(html).not.toContain('本次转发已确认')
      expect(html).not.toContain('已确认恢复')
      expect(html).not.toContain('网络恢复已确认')
      if (session.owned) expect(html).toMatch(/<button>停用并恢复本次TUN/)
    }
  )
  it('sends only the latest complete proof, then the prepared proof, then the owned session ID', async () => {
    const f = fixture()
    expect(f.invoke).not.toHaveBeenCalled()
    await f.control.run('prepare')
    expect(f.invoke).toHaveBeenLastCalledWith('relayTunPrepare', { evidenceId: completeId })
    await f.control.run('start')
    expect(f.invoke).toHaveBeenLastCalledWith('relayTunStart', { evidenceId: preparedId })
    expect(render(f.control.snapshot())).toContain('本次转发已确认')
    await f.control.run('stop')
    expect(f.invoke).toHaveBeenLastCalledWith('relayTunStop', { sessionId })
    expect(render(f.control.snapshot())).toContain('网络恢复已确认')
    expect(f.onBusy.mock.calls.map(([value]) => value)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false
    ])
  })
  it('withdraws a prepared proof when the complete source changes and cannot start it', async () => {
    const f = fixture()
    await f.control.run('prepare')
    f.evidence(preparedId)
    f.control.updateEvidence()
    expect(f.invoke).toHaveBeenLastCalledWith('relayTunCancel', { evidenceId: preparedId })
    await f.control.run('start')
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'relayTunStart')).toBe(false)
    expect(f.control.snapshot().preparation).toBeUndefined()
  })
  it.each(['sourceChange', 'cancel'] as const)(
    'cancels a late preparation after %s instead of resurrecting it',
    async (mode) => {
      const f = fixture()
      let finish!: (value: unknown) => void
      f.invoke.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const preparing = f.control.run('prepare')
      await vi.waitFor(() => expect(f.invoke).toHaveBeenCalled())
      if (mode === 'sourceChange') {
        f.evidence(preparedId)
        f.control.updateEvidence()
      } else await f.control.cancel()
      finish(plan)
      await preparing
      expect(f.control.snapshot().preparation).toBeUndefined()
      expect(f.invoke).toHaveBeenLastCalledWith('relayTunCancel', { evidenceId: preparedId })
    }
  )
  it('retains actual ownership if the source changes during a confirmed start', async () => {
    const f = fixture()
    await f.control.run('prepare')
    let finish!: (value: unknown) => void
    f.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const starting = f.control.run('start')
    f.evidence(undefined)
    f.control.updateEvidence()
    finish({ status: 'started', state: active })
    await starting
    expect(f.control.snapshot().status?.session.owned).toBe(true)
    expect(render(f.control.snapshot(), undefined)).toMatch(/<button>停用并恢复本次TUN/)
  })
  it('re-reads real status after an uncertain start and never retries or stops automatically', async () => {
    const f = fixture()
    await f.control.run('prepare')
    f.invoke.mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce(status(active))
    await f.control.run('start')
    expect(f.control.snapshot().status?.session.owned).toBe(true)
    expect(f.invoke).toHaveBeenLastCalledWith('relayTunStatus')
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'relayTunStart')).toHaveLength(1)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'relayTunStop')).toBe(false)
  })
  it('refreshes an active host notification without withdrawing its held capability or checked source', async () => {
    const f = fixture()
    await f.control.run('prepare')
    await f.control.run('start')
    f.invoke.mockResolvedValueOnce(status(active))
    f.control.hostChanged()
    await vi.waitFor(() => expect(f.control.snapshot().pending).toBe(false))
    expect(f.control.snapshot().status?.session.owned).toBe(true)
    expect(
      f.invoke.mock.calls.some(
        ([channel]) => channel === 'relayTunStop' || channel === 'relayTunCancel'
      )
    ).toBe(false)
    expect(f.invoke).toHaveBeenLastCalledWith('relayTunStatus')
  })
  it('preserves a released-tunnel recovery failure across refresh and explicitly resumes only the ordinary core', async () => {
    const f = fixture()
    const ordinaryRecovery = { sessionId, phase: 'failed' as const, reason: 'listener' as const }
    let observed: TunStatus = { ...status(restored), ordinaryRecovery }
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayTunStatus') return observed
      if (channel === 'relayTunRecoverOrdinary') {
        observed = status(restored)
        return { status: 'restored', state: { ...restored, warnings: ['普通代理已恢复。'] } }
      }
      throw Error('Unexpected mutation')
    })
    await f.control.run('status')
    const html = render(f.control.snapshot())
    expect(html).toContain('恢复普通代理')
    expect(html).toContain('普通代理待恢复')
    expect(html).not.toContain('本次核心、设备及网络恢复已确认')
    f.control.hostChanged()
    await vi.waitFor(() => expect(f.control.snapshot().pending).toBe(false))
    expect(f.control.snapshot().notice).toContain('普通代理恢复未确认')
    await f.control.run('recover')
    expect(f.invoke).toHaveBeenCalledWith('relayTunRecoverOrdinary', { sessionId })
    expect(f.control.snapshot().status?.ordinaryRecovery).toBeUndefined()
    expect(f.invoke.mock.calls.map(([name]) => name)).not.toContain('relayTunStop')
  })
  it('holds the shared closing indication through ordinary proxy restoration and preserves its final outcome', async () => {
    const f = fixture()
    await f.control.run('prepare')
    await f.control.run('start')
    let finish!: (value: unknown) => void, finishStatus!: (value: unknown) => void
    f.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    f.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStatus = resolve
        })
    )
    const phases: boolean[] = []
    const unsubscribe = tunSwitchProgress.subscribe(() =>
      phases.push(tunSwitchProgress.read() === 'stop')
    )
    try {
      const operation = f.control.run('stop')
      f.control.hostChanged()
      expect(f.control.snapshot().notice).toBe(tunStoppingNotice)
      expect(render({ status: status(restored) })).toContain(tunStoppingNotice)
      expect(render({ status: status(restored) })).not.toContain('网络恢复已确认')
      const incomplete = 'TUN 已关闭；普通代理恢复未确认，可从系统代理开关重新连接。'
      finish({ status: 'restored', state: { ...restored, warnings: [incomplete] } })
      await vi.waitFor(() => expect(finishStatus).toBeTypeOf('function'))
      expect(tunSwitchProgress.read()).toBe('stop')
      expect(render(f.control.snapshot())).toContain(tunStoppingNotice)
      finishStatus(status(restored))
      await operation
      expect(phases).toEqual([true, false])
      expect(f.control.snapshot().notice).toBe(incomplete)
    } finally {
      unsubscribe()
    }
  })
  it.each(['restored', 'uncertain', 'unavailable'] as const)(
    'reconciles queued stop notifications with %s status without replaying the stop',
    async (outcome) => {
      const f = fixture()
      await f.control.run('prepare')
      await f.control.run('start')
      const uncertain: TunSessionState = {
        ...active,
        phase: 'uncertain',
        traffic: 'unconfirmed'
      }
      let finish!: (value: unknown) => void
      f.invoke.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      if (outcome === 'unavailable') f.invoke.mockRejectedValueOnce(new Error('status unavailable'))
      else f.invoke.mockResolvedValueOnce(status(outcome === 'restored' ? restored : uncertain))
      const stopping = f.control.run('stop')
      f.busy(true) // React has not yet committed the parent's onBusy(false).
      f.control.hostChanged()
      f.control.hostChanged()
      finish({ status: 'uncertain', state: uncertain })
      await stopping
      expect(f.invoke.mock.calls.filter(([channel]) => channel === 'relayTunStop')).toHaveLength(1)
      expect(f.invoke.mock.calls.filter(([channel]) => channel === 'relayTunStatus')).toHaveLength(
        1
      )
      expect(f.control.snapshot()).toMatchObject({
        pending: false,
        unconfirmed: outcome === 'unavailable',
        status: { session: outcome === 'restored' ? restored : uncertain }
      })
      if (outcome === 'restored') expect(render(f.control.snapshot())).toContain('网络恢复已确认')
    }
  )
  it('does not label a refresh current when another notification arrives during that read', async () => {
    const f = fixture()
    await f.control.run('prepare')
    await f.control.run('start')
    let stopped!: (value: unknown) => void, refreshed!: (value: unknown) => void
    f.invoke
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            stopped = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            refreshed = resolve
          })
      )
    const stopping = f.control.run('stop')
    f.control.hostChanged()
    stopped({ status: 'restored', state: restored })
    await vi.waitFor(() => expect(f.invoke).toHaveBeenLastCalledWith('relayTunStatus'))
    f.control.hostChanged()
    refreshed(status(restored))
    await stopping
    expect(f.control.snapshot()).toMatchObject({ pending: false, unconfirmed: true })
    expect(render(f.control.snapshot())).not.toContain('网络恢复已确认')
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'relayTunStatus')).toHaveLength(1)
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'relayTunStop')).toHaveLength(1)
  })
  it.each(['prepared', 'idle'] as const)(
    'reconciles a pending preparation notification against the actual %s host state',
    async (phase) => {
      const f = fixture()
      let finish!: (value: unknown) => void
      f.invoke.mockImplementation(async (channel) => {
        if (channel === 'relayTunPrepare')
          return new Promise((resolve) => {
            finish = resolve
          })
        if (channel === 'relayTunStatus') return status({ ...idle, phase })
        if (channel === 'relayTunCancel') return undefined
        throw new Error('unexpected action')
      })
      const preparing = f.control.run('prepare')
      await vi.waitFor(() =>
        expect(f.invoke).toHaveBeenCalledWith('relayTunPrepare', expect.anything())
      )
      f.control.hostChanged()
      finish(plan)
      await preparing
      expect(f.control.snapshot().preparation).toEqual(phase === 'prepared' ? plan : undefined)
      expect(f.invoke.mock.calls.filter(([channel]) => channel === 'relayTunCancel')).toHaveLength(
        phase === 'prepared' ? 0 : 1
      )
    }
  )
  it('withdraws an older preparation when a host update arrives during a status read', async () => {
    const f = fixture()
    await f.control.run('prepare')
    let finish!: (value: unknown) => void
    f.invoke
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      .mockImplementationOnce(async () => {
        f.control.hostChanged()
      })
    const reading = f.control.run('status')
    f.control.hostChanged()
    finish(status({ ...idle, phase: 'prepared' }))
    await reading
    expect(f.control.snapshot().preparation).toBeUndefined()
    expect(f.control.snapshot().unconfirmed).toBe(false)
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'relayTunCancel')).toHaveLength(1)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'relayTunStart')).toBe(false)
  })
  it('keeps an unknown-state gate if both the action and its status recovery fail', async () => {
    const f = fixture()
    f.invoke.mockRejectedValue(new Error('unavailable'))
    await f.control.run('status')
    expect(f.control.snapshot().unconfirmed).toBe(true)
    expect(render(f.control.snapshot())).toContain('请保留窗口并重新读取')
  })
  it('refuses privileged renderer claims before reaching IPC', async () => {
    const f = fixture(),
      api = createTunRendererApi(f.invoke)
    await expect(
      api.relayTunPrepare({ evidenceId: completeId, fd: 3 } as { evidenceId: string })
    ).rejects.toThrow('仅接受')
    await expect(
      api.relayTunStop({ sessionId, pid: 100 } as { sessionId: string })
    ).rejects.toThrow('仅接受')
    expect(f.invoke).not.toHaveBeenCalled()
  })
})

describe('single action TUN enable', () => {
  it('permits status and owned-session restoration while another session blocks activation', async () => {
    const f = fixture()
    f.activationBlocked(true)
    await f.control.run('status')
    expect(f.invoke).toHaveBeenLastCalledWith('relayTunStatus')
    f.invoke.mockClear()
    await f.control.run('prepare')
    await f.control.run('start')
    await f.control.enable()
    expect(f.invoke).not.toHaveBeenCalled()
    f.invoke.mockResolvedValueOnce(status(active))
    await f.control.run('status')
    await f.control.run('stop')
    expect(f.invoke).toHaveBeenLastCalledWith('relayTunStop', { sessionId })
    const html = render({ status: status(active) }, completeId, 1000, true)
    expect(html).not.toContain('根据完整检查准备TUN')
    expect(html).not.toContain('确认并启用本次TUN')
    expect(html).toMatch(/<button>读取TUN与辅助组件状态/)
    expect(html).toMatch(/<button>停用并恢复本次TUN/)
  })
  it('retires a fresh preparation if another session appears during the final read', async () => {
    const f = fixture()
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayTunPrepare') return plan
      if (channel === 'relayTunStatus') {
        f.activationBlocked(true)
        return status({ ...idle, phase: 'prepared' })
      }
      if (channel === 'relayTunCancel') return undefined
      throw Error('unexpected start')
    })
    await f.control.enable()
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayTunPrepare',
      'relayTunStatus',
      'relayTunCancel'
    ])
    expect(f.control.snapshot().preparation).toBeUndefined()
  })
  it('prepares, rechecks and requests native start in one busy operation', async () => {
    const f = fixture()
    f.onBusy.mockImplementation((value) => f.busy(value))
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayTunPrepare') return plan
      if (channel === 'relayTunStatus') return status({ ...idle, phase: 'prepared' })
      if (channel === 'relayTunStart') return { status: 'started', state: active }
      throw Error('unexpected action')
    })
    await f.control.enable()
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayTunPrepare',
      'relayTunStatus',
      'relayTunStart'
    ])
    expect(f.onBusy.mock.calls.map(([value]) => value)).toEqual([true, false])
    expect(f.control.snapshot().status?.session).toEqual(active)
  })
  it('does not continue when preparation is blocked or status no longer confirms preparation', async () => {
    const blocked = fixture()
    blocked.invoke.mockResolvedValueOnce({
      ...plan,
      readyForConfirmation: false,
      issues: ['helperNotReady']
    })
    await blocked.control.enable()
    expect(blocked.invoke).toHaveBeenCalledTimes(1)
    const changed = fixture()
    await changed.control.enable()
    expect(changed.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayTunPrepare',
      'relayTunStatus',
      'relayTunCancel'
    ])
    expect(changed.control.snapshot().preparation).toBeUndefined()
  })
  it('does not start when the source changes while reading the prepared status', async () => {
    const f = fixture()
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayTunPrepare') return plan
      if (channel === 'relayTunStatus') {
        f.evidence(undefined)
        return status({ ...idle, phase: 'prepared' })
      }
      if (channel === 'relayTunCancel') return undefined
      throw Error('unexpected start')
    })
    await f.control.enable()
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'relayTunStart')).toBe(false)
  })
  it('retains a cancelled start without replaying it', async () => {
    const f = fixture()
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayTunPrepare') return plan
      if (channel === 'relayTunStatus') return status({ ...idle, phase: 'prepared' })
      if (channel === 'relayTunStart') return { status: 'cancelled', state: idle }
      throw Error('unexpected action')
    })
    await f.control.enable()
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'relayTunStart')).toHaveLength(1)
    expect(f.control.snapshot().notice).toContain('已取消')
    expect(f.control.snapshot().status?.session.owned).toBe(false)
  })
})

describe('Current-profile TUN toggle', () => {
  it('labels idle and prepared as closed, distinguishes missing authorization from forwarding', () => {
    for (const phase of ['idle', 'prepared'] as const) {
      const html = render({ status: status({ ...idle, phase }) })
      expect(html).toContain('已关闭')
      expect(html).not.toContain('尚未准备')
      expect(html).not.toContain('已开启')
    }
    const missing = render({ status: { ...status(), helper: 'missing' } })
    expect(missing).toContain('未授权')
    expect(missing).toContain('安装与授权说明')
    expect(missing).toContain('RelayTun-CoreManaged-v2-local-geodata-v1.pkg')
    expect(missing).toContain('刷新授权状态')
    expect(render({ status: status(active) })).toContain('已开启')
  })
  it('unbinds only the matching visible-panel shortcut on replacement and unmount', () => {
    const initial = { checked: false, disabled: false, setEnabled: vi.fn() }
    const replacement = { checked: true, disabled: false, setEnabled: vi.fn() }
    const oldCleanup = activeTunSwitch.bind(initial)
    const cleanup = activeTunSwitch.bind(replacement)
    oldCleanup()
    try {
      activeTunSwitch.read()?.setEnabled(false)
      expect(initial.setEnabled).not.toHaveBeenCalled()
      expect(replacement.setEnabled).toHaveBeenCalledExactlyOnceWith(false)
    } finally {
      cleanup()
    }
    expect(activeTunSwitch.read()).toBeUndefined()
  })
  it('serialises enable from independent panel and sidebar controllers during preparation', async () => {
    let complete!: (id: string) => void
    const sidebar = fixture({
      prepareEvidence: () =>
        new Promise((resolve) => {
          complete = resolve
        })
    })
    const panel = fixture()
    sidebar.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayTunPrepare') return plan
      if (channel === 'relayTunStatus') return status({ ...idle, phase: 'prepared' })
      if (channel === 'relayTunStart') return { status: 'started', state: active }
      throw Error('unexpected channel')
    })
    const first = sidebar.control.enable()
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    try {
      await panel.control.enable()
      expect(panel.invoke).not.toHaveBeenCalled()
      expect(tunSwitchProgress.read()).toBe('start')
    } finally {
      complete(completeId)
      await first
    }
    expect(
      sidebar.invoke.mock.calls.filter(([channel]) => channel === 'relayTunStart')
    ).toHaveLength(1)
    expect(tunSwitchProgress.read()).toBeUndefined()
  })
  it('checks the selected configuration then enables using its exact evidence from one click', async () => {
    const prepareEvidence = vi.fn(async () => completeId)
    const f = fixture({ prepareEvidence, context: () => 'selected' })
    f.evidence(undefined)
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayTunPrepare') return plan
      if (channel === 'relayTunStatus') return status({ ...idle, phase: 'prepared' })
      if (channel === 'relayTunStart') return { status: 'started', state: active }
      throw Error('unexpected')
    })
    await Promise.all([f.control.enable(), f.control.enable()])
    expect(prepareEvidence).toHaveBeenCalledOnce()
    expect(f.invoke).toHaveBeenCalledWith('relayTunPrepare', { evidenceId: completeId })
    expect(f.invoke.mock.calls.map(([name]) => name)).toEqual([
      'relayTunPrepare',
      'relayTunStatus',
      'relayTunStart'
    ])
    expect(f.control.snapshot().status?.session).toEqual(active)
  })
  it.each(['cancel', 'source', 'unmount'] as const)(
    'does not submit a late configuration after %s',
    async (kind) => {
      let resolve!: (id: string) => void
      let context = 'first'
      let current!: () => boolean
      const f = fixture({
        prepareEvidence: (check) => {
          current = check
          return new Promise((done) => {
            resolve = done
          })
        },
        context: () => context
      })
      f.evidence(undefined)
      const pending = f.control.enable()
      await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
      if (kind === 'cancel') await f.control.cancel()
      else if (kind === 'source') context = 'second'
      else f.activationBlocked(true)
      expect(current()).toBe(false)
      resolve(completeId)
      await pending
      expect(f.invoke).not.toHaveBeenCalled()
    }
  )
})
