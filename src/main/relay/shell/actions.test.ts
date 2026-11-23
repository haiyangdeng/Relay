import { describe, expect, it, vi } from 'vitest'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import type {
  SystemProxyReport,
  SystemProxyPreparation,
  SystemProxyResult
} from '../../../shared/relay/system-proxy'
import type {
  TunSessionState,
  TunSessionResult,
  TunSessionPreparation
} from '../../../shared/relay/tun'
import type { RelayShellAction } from '../../../shared/relay/shell'
import { createSystemProxyService } from '../system-proxy/service'
import { createShellActions } from './actions'

const id = '00000000-0000-4000-8000-000000000038'
const other = '00000000-0000-4000-8000-000000000039'
const proxyReport = (active = true): SystemProxyReport => ({
  status: active ? 'active' : 'inactive',
  revision: 'a'.repeat(64),
  location: 'Private test location',
  services: [],
  canApply: !active,
  canRestore: active,
  ...(active ? { recordID: id } : {}),
  warnings: []
})
const tunState = (active = true): TunSessionState => ({
  phase: active ? 'active' : 'idle',
  pending: false,
  owned: active,
  ...(active ? { sessionId: id } : {}),
  traffic: active ? 'forwarding' : 'inactive',
  restorationVerified: false,
  protectionVerified: false,
  warnings: []
})
const restoredTun = (): TunSessionState => ({
  ...tunState(false),
  phase: 'restored',
  restorationVerified: true
})
const tunPlan = (): TunSessionPreparation => ({
  version: 1,
  evidenceId: id,
  configurationSHA256: 'a'.repeat(64),
  bundleSHA256: 'b'.repeat(64),
  tunSHA256: 'c'.repeat(64),
  assetsSHA256: 'd'.repeat(64),
  helperRevision: 'e'.repeat(64),
  networkRevision: 'f'.repeat(64),
  evidenceSHA256: '1'.repeat(64),
  createdAt: Date.now(),
  expiresAt: Date.now() + 60000,
  readyForConfirmation: true,
  canApply: false,
  active: false,
  runtimeVerified: false,
  protectionVerified: false,
  effects: { device: 'utun', autoRoute: true, dnsHijack: true },
  issues: []
})
function fixture() {
  let tun = tunState()
  const local: LocalProxyState = {
    phase: 'running',
    pending: false,
    owned: true,
    hasRecord: true,
    uncertain: false,
    instanceId: id,
    httpPort: 18191,
    mode: 'rule',
    traffic: 'listening',
    groups: [],
    systemProxyChanged: false,
    liveGuardEnabled: false,
    warnings: []
  }
  const adapters = {
    assertAvailable: vi.fn(() => {}),
    assertIdle: vi.fn((_action: RelayShellAction, _sessionId?: string) => {}),
    showWindow: vi.fn(() => {}),
    showFloatingWindow: vi.fn(async () => {}),
    quit: vi.fn(() => {}),
    runInBackground: vi.fn(async () => {}),
    restart: vi.fn(async (): Promise<'requested' | 'cancelled' | 'busy'> => 'requested'),
    copy: vi.fn((_text: string) => {}),
    notify: vi.fn(() => {}),
    local: {
      state: vi.fn(() => structuredClone(local)),
      mode: vi.fn(async (_id: string, _mode: 'rule' | 'global' | 'direct') => {})
    },
    systemProxy: {
      state: vi.fn(() => ({ pending: false })),
      inspect: vi.fn(async (): Promise<SystemProxyReport> => proxyReport()),
      prepareApply: vi.fn(async (_report: SystemProxyReport): Promise<SystemProxyPreparation> => ({
        evidenceId: id,
        action: 'apply',
        report: proxyReport(false)
      })),
      prepareRestore: vi.fn(async (): Promise<SystemProxyPreparation> => ({
        evidenceId: id,
        action: 'restore',
        report: proxyReport()
      })),
      execute: vi.fn(async (_request: { evidenceId: string }): Promise<SystemProxyResult> => ({
        status: 'restored',
        report: { ...proxyReport(false), status: 'restored' },
        warnings: []
      })),
      cancel: vi.fn((_request: { evidenceId: string }) => {})
    },
    tun: {
      state: vi.fn(() => structuredClone(tun)),
      inspect: vi.fn(async () => structuredClone(tun)),
      prepare: vi.fn(async (): Promise<TunSessionPreparation> => {
        tun = { ...tunState(false), phase: 'prepared' }
        return tunPlan()
      }),
      start: vi.fn(async (_request: { evidenceId: string }): Promise<TunSessionResult> => ({
        status: 'started',
        state: tunState()
      })),
      cancel: vi.fn((_request: { evidenceId: string }) => {}),
      stop: vi.fn(async (_request: { sessionId: string }): Promise<TunSessionResult> => ({
        status: 'restored',
        state: restoredTun()
      }))
    }
  }
  return {
    adapters,
    actions: createShellActions(adapters),
    local,
    setTun(value: TunSessionState) {
      tun = value
    }
  }
}

describe('Exhaustive Relay shell intent routing', () => {
  it.each(['ruleMode', 'globalMode', 'directMode'] as const)(
    'preserves explicit %s without a fallback mode',
    async (action) => {
      const f = fixture()
      await expect(f.actions.perform(action)).resolves.toBe('performed')
      const modes = { ruleMode: 'rule', globalMode: 'global', directMode: 'direct' }
      expect(f.adapters.local.mode).toHaveBeenCalledExactlyOnceWith(id, modes[action])
      expect(f.adapters.notify).toHaveBeenCalledOnce()
      expect(f.adapters.systemProxy.inspect).not.toHaveBeenCalled()
      expect(f.adapters.tun.stop).not.toHaveBeenCalled()
    }
  )
  it('preserves both window actions and delegates quit only to the supplied existing exit gate', async () => {
    const f = fixture()
    await f.actions.perform('showWindow')
    await f.actions.perform('showFloatingWindow')
    await f.actions.perform('quitApp')
    expect(f.adapters.showWindow).toHaveBeenCalledTimes(2)
    expect(f.adapters.showFloatingWindow).toHaveBeenCalledOnce()
    expect(f.adapters.quit).toHaveBeenCalledOnce()
    expect(f.adapters.local.mode).not.toHaveBeenCalled()
  })
  it('routes restart only to the guarded Main intent and preserves cancellation without Core actions', async () => {
    const f = fixture()
    expect(await f.actions.perform('restartApp')).toBe('performed')
    f.adapters.restart.mockResolvedValueOnce('cancelled')
    expect(await f.actions.perform('restartApp')).toBe('cancelled')
    f.adapters.restart.mockResolvedValueOnce('busy')
    await expect(f.actions.perform('restartApp')).rejects.toThrow('尚未结束')
    expect(f.adapters.quit).not.toHaveBeenCalled()
    expect(f.adapters.local.mode).not.toHaveBeenCalled()
    expect(f.adapters.tun.stop).not.toHaveBeenCalled()
  })
  it('uses the saved format only for a confirmed owned HTTP listener', async () => {
    const f = fixture()
    const actions = createShellActions({ ...f.adapters, environmentFormat: () => 'fish' })
    await actions.perform('copyEnv')
    expect(f.adapters.copy).toHaveBeenLastCalledWith(
      'set -x http_proxy http://127.0.0.1:18191; set -x https_proxy http://127.0.0.1:18191; set -x all_proxy http://127.0.0.1:18191'
    )
    f.adapters.copy.mockClear()
    f.local.owned = false
    await expect(actions.perform('copyEnv')).rejects.toThrow('监听')
    f.local.owned = true
    f.local.uncertain = true
    await expect(actions.perform('copyEnv')).rejects.toThrow('监听')
    f.local.uncertain = false
    f.local.httpPort = 18191.5
    await expect(actions.perform('copyEnv')).rejects.toThrow('端口')
    expect(f.adapters.copy).not.toHaveBeenCalled()
  })
  it('preserves the existing environment text including its NO_PROXY line', async () => {
    const f = fixture()
    await f.actions.perform('copyEnv')
    expect(f.adapters.copy).toHaveBeenCalledExactlyOnceWith(
      'export HTTP_PROXY=http://127.0.0.1:18191\nexport HTTPS_PROXY=http://127.0.0.1:18191\nexport ALL_PROXY=http://127.0.0.1:18191\nexport NO_PROXY=localhost,127.0.0.1,::1'
    )
    expect(f.adapters.quit).not.toHaveBeenCalled()
  })
  it('copies only the explicitly requested format from the current owned port', async () => {
    const f = fixture()
    const actions = createShellActions({ ...f.adapters, environmentFormat: () => 'fish' })
    await actions.perform({ action: 'copyEnv', format: 'cmd' })
    expect(f.adapters.copy).toHaveBeenCalledExactlyOnceWith(
      'set http_proxy=http://127.0.0.1:18191\r\nset https_proxy=http://127.0.0.1:18191'
    )
    f.adapters.copy.mockClear()
    await expect(actions.perform({ action: 'copyEnv', format: 'cmd', port: 7890 })).rejects.toThrow(
      '未支持'
    )
    await expect(actions.perform({ action: 'copyEnv', format: 'other' })).rejects.toThrow('未支持')
    f.local.owned = false
    await expect(actions.perform({ action: 'copyEnv', format: 'cmd' })).rejects.toThrow('监听')
    expect(f.adapters.copy).not.toHaveBeenCalled()
  })
  it.each([undefined, null, {}, 'arbitrary', 'quitWithoutCore', 'direct'])(
    'rejects unsupported action %j before any adapter or Direct submission',
    async (raw) => {
      const f = fixture()
      await expect(f.actions.perform(raw)).rejects.toThrow('未支持')
      expect(f.adapters.assertAvailable).not.toHaveBeenCalled()
      expect(f.adapters.local.mode).not.toHaveBeenCalled()
      expect(f.adapters.systemProxy.inspect).not.toHaveBeenCalled()
      expect(f.adapters.tun.inspect).not.toHaveBeenCalled()
      expect(f.adapters.quit).not.toHaveBeenCalled()
    }
  )
  it('keeps ordinary copy/mode unavailable without the existing running instance', async () => {
    const f = fixture()
    f.local.phase = 'idle'
    await expect(f.actions.perform('copyEnv')).rejects.toThrow('自有代理')
    await expect(f.actions.perform('globalMode')).rejects.toThrow('自有代理')
    expect(f.adapters.copy).not.toHaveBeenCalled()
    expect(f.adapters.local.mode).not.toHaveBeenCalled()
  })
})

describe('Fresh own system-proxy recovery intent', () => {
  it('keeps the requested checkbox state when cold startup finishes during a click', async () => {
    const f = fixture()
    await expect(f.actions.perform({ action: 'triggerSysProxy', enabled: true })).resolves.toBe(
      'performed'
    )
    f.adapters.systemProxy.inspect.mockResolvedValueOnce(proxyReport(false))
    await expect(f.actions.perform({ action: 'triggerSysProxy', enabled: false })).resolves.toBe(
      'restored'
    )
    expect(f.adapters.systemProxy.prepareRestore).not.toHaveBeenCalled()
    expect(f.adapters.systemProxy.prepareApply).not.toHaveBeenCalled()
    expect(f.adapters.systemProxy.execute).not.toHaveBeenCalled()
  })
  it('binds inspect to the same prepared record/revision and delegates the concrete confirmation', async () => {
    const f = fixture()
    await expect(f.actions.perform('triggerSysProxy')).resolves.toBe('restored')
    expect(f.adapters.showWindow).toHaveBeenCalledBefore(f.adapters.systemProxy.inspect)
    expect(f.adapters.systemProxy.execute).toHaveBeenCalledExactlyOnceWith({ evidenceId: id })
    expect(f.adapters.systemProxy.cancel).toHaveBeenCalledExactlyOnceWith({ evidenceId: id })
    expect(f.adapters.local.mode).not.toHaveBeenCalled()
  })
  it('prepares and applies inactive settings through the supplied existing service', async () => {
    const f = fixture()
    f.adapters.systemProxy.inspect.mockResolvedValue(proxyReport(false))
    f.adapters.systemProxy.execute.mockResolvedValueOnce({
      status: 'applied',
      report: proxyReport(),
      warnings: []
    })
    await expect(f.actions.perform('triggerSysProxy')).resolves.toBe('performed')
    expect(f.adapters.systemProxy.prepareApply).toHaveBeenCalledExactlyOnceWith(proxyReport(false))
    expect(f.adapters.systemProxy.prepareRestore).not.toHaveBeenCalled()
    expect(f.adapters.systemProxy.execute).toHaveBeenCalledExactlyOnceWith({ evidenceId: id })
    expect(f.adapters.systemProxy.cancel).toHaveBeenCalledExactlyOnceWith({ evidenceId: id })
  })
  it.each(['revision', 'recordID'] as const)(
    'refuses changed prepared %s without executing and retires only its own token',
    async (field) => {
      const f = fixture()
      f.adapters.systemProxy.prepareRestore.mockResolvedValue({
        evidenceId: id,
        action: 'restore',
        report: { ...proxyReport(), [field]: field === 'revision' ? 'b'.repeat(64) : other }
      })
      await expect(f.actions.perform('triggerSysProxy')).rejects.toThrow('已变化')
      expect(f.adapters.systemProxy.execute).not.toHaveBeenCalled()
      expect(f.adapters.systemProxy.cancel).toHaveBeenCalledExactlyOnceWith({ evidenceId: id })
    }
  )
  it('rechecks the Main lease after preparation, before calling execute', async () => {
    const f = fixture()
    let revoked = false
    f.adapters.assertAvailable.mockImplementation(() => {
      if (revoked) throw new Error('lease revoked')
    })
    f.adapters.systemProxy.prepareRestore.mockImplementation(async () => {
      revoked = true
      return { evidenceId: id, action: 'restore', report: proxyReport() }
    })
    await expect(f.actions.perform('triggerSysProxy')).rejects.toThrow('lease revoked')
    expect(f.adapters.systemProxy.execute).not.toHaveBeenCalled()
    expect(f.adapters.systemProxy.cancel).toHaveBeenCalledOnce()
  })
  it('keeps cancellation distinct from restoration and never retries an uncertain submission', async () => {
    const f = fixture()
    f.adapters.systemProxy.execute.mockResolvedValueOnce({ status: 'cancelled', warnings: [] })
    await expect(f.actions.perform('triggerSysProxy')).resolves.toBe('cancelled')
    f.adapters.systemProxy.execute.mockResolvedValueOnce({ status: 'uncertain', warnings: [] })
    await expect(f.actions.perform('triggerSysProxy')).rejects.toThrow('没有自动重试')
    expect(f.adapters.systemProxy.execute).toHaveBeenCalledTimes(2)
  })
  it('refuses an unconfirmed/no-record observation rather than treating it as off', async () => {
    const f = fixture()
    f.adapters.systemProxy.inspect.mockResolvedValue({ ...proxyReport(false), status: 'uncertain' })
    await expect(f.actions.perform('triggerSysProxy')).rejects.toThrow('未确认')
    expect(f.adapters.systemProxy.execute).not.toHaveBeenCalled()
  })
})

describe('Fresh exact owned TUN intent', () => {
  it('stops only the same fresh active session via the supplied confirmation service', async () => {
    const f = fixture()
    await expect(f.actions.perform('triggerTun')).resolves.toBe('restored')
    expect(f.adapters.tun.stop).toHaveBeenCalledExactlyOnceWith({ sessionId: id })
    expect(f.adapters.assertIdle).toHaveBeenLastCalledWith('triggerTun', id)
  })
  it('finishes a verified release without claiming full proxy settings restoration', async () => {
    const f = fixture()
    f.adapters.tun.stop.mockResolvedValueOnce({
      status: 'released',
      state: { ...tunState(false), phase: 'released' }
    })
    await expect(f.actions.perform('triggerTun')).resolves.toBe('performed')
  })
  it('prepares and starts an inactive TUN through the supplied checked service', async () => {
    const f = fixture()
    f.setTun(tunState(false))
    await expect(f.actions.perform('triggerTun')).resolves.toBe('performed')
    expect(f.adapters.tun.prepare).toHaveBeenCalledOnce()
    expect(f.adapters.tun.start).toHaveBeenCalledExactlyOnceWith({ evidenceId: id })
    expect(f.adapters.tun.cancel).toHaveBeenCalledExactlyOnceWith({ evidenceId: id })
    expect(f.adapters.tun.stop).not.toHaveBeenCalled()
    expect(f.adapters.local.mode).not.toHaveBeenCalled()
  })
  it('rejects owner replacement during the fresh inspect', async () => {
    const f = fixture()
    f.adapters.tun.inspect.mockResolvedValue({ ...tunState(), sessionId: other })
    await expect(f.actions.perform('triggerTun')).rejects.toThrow('已变化')
    expect(f.adapters.tun.stop).not.toHaveBeenCalled()
  })
  it('checks the current owner again after inspect settles', async () => {
    const f = fixture()
    f.adapters.tun.inspect.mockImplementation(async () => {
      f.setTun({ ...tunState(), sessionId: other })
      return tunState()
    })
    await expect(f.actions.perform('triggerTun')).rejects.toThrow('已变化')
    expect(f.adapters.tun.stop).not.toHaveBeenCalled()
  })
  it('does not stop a pending or uncertain session', async () => {
    const f = fixture()
    f.setTun({ ...tunState(), phase: 'uncertain', traffic: 'unconfirmed' })
    await expect(f.actions.perform('triggerTun')).rejects.toThrow('未确认')
    expect(f.adapters.tun.inspect).not.toHaveBeenCalled()
    expect(f.adapters.tun.stop).not.toHaveBeenCalled()
  })
  it('keeps cancellation and failure results distinct from verified restoration', async () => {
    const f = fixture()
    f.adapters.tun.stop.mockResolvedValueOnce({ status: 'cancelled', state: tunState() })
    await expect(f.actions.perform('triggerTun')).resolves.toBe('cancelled')
    f.adapters.tun.stop.mockResolvedValueOnce({
      status: 'uncertain',
      state: { ...tunState(), phase: 'uncertain', traffic: 'unconfirmed' }
    })
    await expect(f.actions.perform('triggerTun')).rejects.toThrow('没有自动重试')
    expect(f.adapters.tun.stop).toHaveBeenCalledTimes(2)
  })
  it('serializes pending callbacks and releases its gate after an inspect error', async () => {
    const f = fixture()
    let reject!: (error: Error) => void
    f.adapters.tun.inspect.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    const first = f.actions.perform('triggerTun')
    await expect(f.actions.perform('directMode')).rejects.toThrow('尚未结束')
    expect(f.adapters.local.mode).not.toHaveBeenCalled()
    reject(new Error('reader failed'))
    await expect(first).rejects.toThrow('reader failed')
    await expect(f.actions.perform('ruleMode')).resolves.toBe('performed')
  })
})

describe('Real system-proxy service contract with an injected native backend', () => {
  it.each(['cancel', 'restore', 'changed'] as const)(
    'preserves existing specific confirmation and fresh revision boundary: %s',
    async (kind) => {
      const f = fixture()
      let current = proxyReport()
      const native = vi.fn(
        async (
          action: 'inspect' | 'prepare' | 'apply' | 'prepareRestore' | 'restore'
        ): Promise<SystemProxyReport> => {
          if (action === 'restore') current = { ...proxyReport(false), status: 'restored' }
          return structuredClone(current)
        }
      )
      const confirm = vi.fn(async () => {
        if (kind === 'changed') current.revision = 'b'.repeat(64)
        return kind !== 'cancel'
      })
      const real = createSystemProxyService({
        native,
        confirm,
        pac: async () => {
          throw new Error('unused PAC')
        },
        verifyTarget: async () => {},
        notify: () => {}
      })
      const actions = createShellActions({
        ...f.adapters,
        systemProxy: { ...real, prepareApply: f.adapters.systemProxy.prepareApply }
      })
      if (kind === 'changed')
        await expect(actions.perform('triggerSysProxy')).rejects.toThrow('结果未确认')
      else
        await expect(actions.perform('triggerSysProxy')).resolves.toBe(
          kind === 'cancel' ? 'cancelled' : 'restored'
        )
      expect(confirm).toHaveBeenCalledOnce()
      expect(native.mock.calls.filter(([action]) => action === 'restore')).toHaveLength(
        kind === 'restore' ? 1 : 0
      )
      expect(native.mock.calls.some(([action]) => action === 'apply')).toBe(false)
      expect(f.adapters.local.mode).not.toHaveBeenCalled()
    }
  )
})

describe('Background intent delegates only to the window owner', () => {
  it('awaits the hide operation without querying or stopping network services', async () => {
    const f = fixture()
    let finish!: () => void
    f.adapters.runInBackground.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    let completed = false
    const operation = f.actions.perform('runInBackground').then(() => (completed = true))
    expect(completed).toBe(false)
    expect(f.adapters.quit).not.toHaveBeenCalled()
    expect(f.adapters.local.state).not.toHaveBeenCalled()
    expect(f.adapters.local.mode).not.toHaveBeenCalled()
    expect(f.adapters.systemProxy.inspect).not.toHaveBeenCalled()
    expect(f.adapters.tun.stop).not.toHaveBeenCalled()
    finish()
    await operation
    expect(completed).toBe(true)
  })
})

describe('Fresh tray enable boundaries', () => {
  it.each(['revision', 'recordID', 'canApply'] as const)(
    'refuses system apply after changed %s',
    async (field) => {
      const f = fixture()
      f.adapters.systemProxy.inspect.mockResolvedValue(proxyReport(false))
      f.adapters.systemProxy.prepareApply.mockResolvedValue({
        evidenceId: id,
        action: 'apply',
        report: {
          ...proxyReport(field === 'recordID'),
          [field]: field === 'revision' ? 'b'.repeat(64) : field === 'recordID' ? other : false
        }
      })
      await expect(f.actions.perform('triggerSysProxy')).rejects.toThrow('已变化')
      expect(f.adapters.systemProxy.execute).not.toHaveBeenCalled()
      expect(f.adapters.systemProxy.cancel).toHaveBeenCalledExactlyOnceWith({ evidenceId: id })
    }
  )
  it('keeps system apply cancellation distinct and does not retry uncertain writes', async () => {
    const f = fixture()
    f.adapters.systemProxy.inspect.mockResolvedValue(proxyReport(false))
    f.adapters.systemProxy.execute.mockResolvedValueOnce({ status: 'cancelled', warnings: [] })
    expect(await f.actions.perform('triggerSysProxy')).toBe('cancelled')
    f.adapters.systemProxy.execute.mockResolvedValueOnce({ status: 'uncertain', warnings: [] })
    await expect(f.actions.perform('triggerSysProxy')).rejects.toThrow('没有自动重试')
    expect(f.adapters.systemProxy.execute).toHaveBeenCalledTimes(2)
    expect(f.adapters.systemProxy.cancel).toHaveBeenCalledTimes(2)
  })
  it('does not prepare a TUN when the owner changes during inspect', async () => {
    const f = fixture()
    f.setTun(tunState(false))
    f.adapters.tun.inspect.mockImplementationOnce(async () => {
      f.setTun(tunState())
      return tunState(false)
    })
    await expect(f.actions.perform('triggerTun')).rejects.toThrow('已变化')
    expect(f.adapters.tun.prepare).not.toHaveBeenCalled()
    expect(f.adapters.tun.start).not.toHaveBeenCalled()
  })
  it.each(['expired', 'notReady', 'ownerChanged', 'leaseLost'] as const)(
    'retires unused TUN evidence on %s',
    async (kind) => {
      const f = fixture()
      f.setTun(tunState(false))
      f.adapters.tun.prepare.mockImplementationOnce(async () => {
        f.setTun(kind === 'ownerChanged' ? tunState() : { ...tunState(false), phase: 'prepared' })
        if (kind === 'leaseLost')
          f.adapters.assertAvailable.mockImplementationOnce(() => {
            throw new Error('lease lost')
          })
        const plan = tunPlan()
        return {
          ...plan,
          ...(kind === 'expired' ? { createdAt: 1, expiresAt: 2 } : {}),
          ...(kind === 'notReady' ? { readyForConfirmation: false } : {})
        }
      })
      await expect(f.actions.perform('triggerTun')).rejects.toThrow()
      expect(f.adapters.tun.start).not.toHaveBeenCalled()
      expect(f.adapters.tun.cancel).toHaveBeenCalledExactlyOnceWith({ evidenceId: id })
    }
  )
  it('reports a TUN prerequisite failure without stopping or starting anything', async () => {
    const f = fixture()
    f.setTun(tunState(false))
    f.adapters.tun.prepare.mockRejectedValueOnce(new Error('当前普通代理核心正在运行'))
    await expect(f.actions.perform('triggerTun')).rejects.toThrow('核心正在运行')
    expect(f.adapters.tun.start).not.toHaveBeenCalled()
    expect(f.adapters.tun.stop).not.toHaveBeenCalled()
    expect(f.adapters.tun.cancel).not.toHaveBeenCalled()
  })
  it('preserves TUN start cancellation and uncertain result without retry or stop', async () => {
    const f = fixture()
    f.setTun(tunState(false))
    f.adapters.tun.start.mockResolvedValueOnce({ status: 'cancelled', state: tunState(false) })
    expect(await f.actions.perform('triggerTun')).toBe('cancelled')
    f.adapters.tun.start.mockResolvedValueOnce({
      status: 'uncertain',
      state: { ...tunState(false), phase: 'uncertain', traffic: 'unconfirmed' }
    })
    await expect(f.actions.perform('triggerTun')).rejects.toThrow('没有自动重试')
    expect(f.adapters.tun.start).toHaveBeenCalledTimes(2)
    expect(f.adapters.tun.stop).not.toHaveBeenCalled()
    expect(f.adapters.tun.cancel).toHaveBeenCalledTimes(2)
  })
})
