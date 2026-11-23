import { describe, expect, it, vi } from 'vitest'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'
import {
  defaultLocalProxyPlan,
  type LocalProxyPlan,
  type LocalProxyPlanRecord
} from '../../../shared/relay/local-proxy-plan'
import { waitForTunPlanPorts } from './port'
import { createProfileStartup } from './profile-startup'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  const selection = { id: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64) }
  const state: ReturnType<Parameters<typeof createProfileStartup>[0]['state']> = {
    owned: false,
    pending: false,
    uncertain: false,
    hasRecord: false,
    traffic: 'inactive',
    phase: 'unknown'
  }
  const adapters = {
    state: () => state,
    readSelection: vi.fn(async (): Promise<RelayProfileSelection | undefined> => selection),
    readPlan: vi.fn(async (): Promise<LocalProxyPlanRecord> => ({
      document: defaultLocalProxyPlan(),
      revision: '',
      exists: false
    })),
    context: vi.fn(() => vi.fn()),
    prepare: vi.fn(async () => ({ canStart: true, hasRecord: false, evidenceId: 'startup' })),
    start: vi.fn(async (_id: string, current: () => void) => {
      current()
      return { status: 'started' as const }
    }),
    invalidate: vi.fn()
  }
  return { selection, state, adapters, startup: createProfileStartup(adapters) }
}

describe('Saved profile startup', () => {
  it('runs the exact saved id/hash once through the ordinary main-owned local preparation', async () => {
    const f = fixture()
    const first = f.startup.run()
    expect(f.startup.run()).toBe(first)
    expect(await first).toBe('started')
    await f.startup.run()
    expect(f.adapters.prepare).toHaveBeenCalledExactlyOnceWith({
      profile: f.selection,
      httpPort: 18191,
      resolverMode: 'profile',
      lifetime: 'main'
    })
    expect(f.adapters.start).toHaveBeenCalledExactlyOnceWith('startup', expect.any(Function))
    expect(f.adapters.readSelection).toHaveBeenCalledTimes(2)
  })
  it('does not choose another profile when no saved selection exists', async () => {
    const f = fixture()
    f.adapters.readSelection.mockResolvedValue(undefined)
    expect(await f.startup.run()).toBe('skipped')
    expect(f.adapters.prepare).not.toHaveBeenCalled()
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
  it('reuses the exact saved ordinary and dedicated settings after each cold start', async () => {
    const f = fixture(),
      record: LocalProxyPlanRecord = {
        document: {
          httpPort: 18192,
          resolverMode: 'off',
          dedicated: { httpPort: 18193, socksPort: 18190, route: 'fixed-node' }
        },
        revision: 'b'.repeat(64),
        exists: true
      }
    f.adapters.readPlan.mockResolvedValue(record)
    expect(await f.startup.run()).toBe('started')
    expect(await createProfileStartup(f.adapters).run()).toBe('started')
    expect(f.adapters.prepare).toHaveBeenNthCalledWith(1, {
      profile: f.selection,
      ...record.document,
      lifetime: 'main'
    })
    expect(f.adapters.prepare.mock.calls[1]).toEqual(f.adapters.prepare.mock.calls[0])
    expect(f.adapters.readPlan).toHaveBeenCalledTimes(4)
  })
  it('refuses unreadable saved settings rather than reverting to defaults or direct routing', async () => {
    const f = fixture()
    f.adapters.readPlan.mockRejectedValue(new Error('invalid private plan'))
    expect(await f.startup.run()).toBe('failed')
    expect(f.adapters.prepare).not.toHaveBeenCalled()
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
  it('cancels an in-flight plan read without using its late settings', async () => {
    const f = fixture(),
      gate = deferred<LocalProxyPlanRecord>()
    f.adapters.readPlan.mockReturnValue(gate.promise)
    const running = f.startup.run()
    await vi.waitFor(() => expect(f.adapters.readPlan).toHaveBeenCalledOnce())
    f.startup.cancel()
    gate.resolve({ document: defaultLocalProxyPlan(), revision: '', exists: false })
    expect(await running).toBe('cancelled')
    expect(f.adapters.prepare).not.toHaveBeenCalled()
  })
  it('invalidates preparation when the saved plan changes before start', async () => {
    const f = fixture()
    f.adapters.readPlan.mockResolvedValueOnce({
      document: defaultLocalProxyPlan(),
      revision: '',
      exists: false
    })
    f.adapters.readPlan.mockResolvedValue({
      document: { ...defaultLocalProxyPlan(), httpPort: 18194 },
      revision: 'c'.repeat(64),
      exists: true
    })
    expect(await f.startup.run()).toBe('failed')
    expect(f.adapters.prepare).toHaveBeenCalledOnce()
    expect(f.adapters.start).not.toHaveBeenCalled()
    expect(f.adapters.invalidate).toHaveBeenCalledOnce()
  })
  it('rechecks the plan after an inventory wait and never starts an obsolete prepared route', async () => {
    const f = fixture(),
      gate = deferred<boolean>(),
      waitForInventory = vi.fn().mockResolvedValueOnce(false).mockReturnValueOnce(gate.promise),
      startup = createProfileStartup({ ...f.adapters, waitForInventory })
    const operation = startup.run()
    await vi.waitFor(() => expect(waitForInventory).toHaveBeenCalledTimes(2))
    f.adapters.readPlan.mockResolvedValue({
      document: {
        ...defaultLocalProxyPlan(),
        dedicated: { socksPort: 18190, route: 'changed-node' }
      },
      revision: 'd'.repeat(64),
      exists: true
    })
    gate.resolve(true)
    expect(await operation).toBe('failed')
    expect(f.adapters.start).not.toHaveBeenCalled()
    expect(f.adapters.invalidate).toHaveBeenCalledOnce()
  })
  it('waits for inventory reads before preparation and again before starting', async () => {
    const f = fixture(),
      preparing = deferred<boolean>(),
      starting = deferred<boolean>(),
      waitForInventory = vi
        .fn()
        .mockReturnValueOnce(preparing.promise)
        .mockReturnValueOnce(starting.promise)
        .mockResolvedValue(false),
      startup = createProfileStartup({ ...f.adapters, waitForInventory })
    const operation = startup.run()
    await vi.waitFor(() => expect(waitForInventory).toHaveBeenCalledTimes(1))
    expect(f.adapters.prepare).not.toHaveBeenCalled()
    preparing.resolve(true)
    await vi.waitFor(() => expect(waitForInventory).toHaveBeenCalledTimes(2))
    expect(f.adapters.prepare).toHaveBeenCalledOnce()
    expect(f.adapters.start).not.toHaveBeenCalled()
    starting.resolve(true)
    expect(await operation).toBe('started')
    expect(f.adapters.start).toHaveBeenCalledOnce()
  })
  it.each([1, 2])('preserves cancellation during inventory wait %i', async (cancelAt) => {
    const f = fixture(),
      gate = deferred<void>(),
      waitForInventory = vi.fn(async () => {
        if (waitForInventory.mock.calls.length === cancelAt) await gate.promise
        return true
      }),
      startup = createProfileStartup({ ...f.adapters, waitForInventory })
    const operation = startup.run()
    await vi.waitFor(() => expect(waitForInventory).toHaveBeenCalledTimes(cancelAt))
    startup.cancel()
    gate.resolve()
    expect(await operation).toBe('cancelled')
    expect(f.adapters.start).not.toHaveBeenCalled()
    expect(f.adapters.prepare).toHaveBeenCalledTimes(cancelAt - 1)
  })
  it('rechecks a selection changed while waiting for the final inventory read', async () => {
    const f = fixture(),
      gate = deferred<boolean>(),
      waitForInventory = vi.fn().mockResolvedValueOnce(false).mockReturnValueOnce(gate.promise),
      startup = createProfileStartup({ ...f.adapters, waitForInventory })
    const operation = startup.run()
    await vi.waitFor(() => expect(waitForInventory).toHaveBeenCalledTimes(2))
    f.adapters.readSelection.mockResolvedValue({ ...f.selection, sha256: 'b'.repeat(64) })
    gate.resolve(true)
    expect(await operation).toBe('failed')
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
  it.each([
    { owned: true },
    { pending: true },
    { uncertain: true },
    { hasRecord: true },
    { traffic: 'unconfirmed' as const },
    { phase: 'blocked' as const },
    { phase: 'running' as const }
  ])('does not adopt, clean or restart an existing/unconfirmed owner: %j', async (patch) => {
    const f = fixture()
    Object.assign(f.state, patch)
    expect(await f.startup.run()).toBe('skipped')
    expect(f.adapters.readSelection).not.toHaveBeenCalled()
    expect(f.adapters.prepare).not.toHaveBeenCalled()
    expect(f.adapters.invalidate).not.toHaveBeenCalled()
  })
  it('does not retry a blocked preparation or select another port', async () => {
    const f = fixture()
    f.adapters.prepare.mockResolvedValue({
      canStart: false,
      hasRecord: false,
      evidenceId: 'blocked'
    })
    expect(await f.startup.run()).toBe('skipped')
    await f.startup.run()
    expect(f.adapters.prepare).toHaveBeenCalledTimes(1)
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
  it.each(['id', 'sha256'] as const)(
    'refuses a changed %s while preparation was pending',
    async (key) => {
      const f = fixture()
      f.adapters.readSelection.mockResolvedValueOnce(f.selection).mockResolvedValue({
        ...f.selection,
        [key]: key === 'id' ? '22222222-2222-4222-8222-222222222222' : 'b'.repeat(64)
      })
      expect(await f.startup.run()).toBe('failed')
      expect(f.adapters.start).not.toHaveBeenCalled()
    }
  )
  it('lets a manual action before startup suppress automatic selection/start completely', async () => {
    const f = fixture()
    expect(f.startup.cancelAndWait()).toBeUndefined()
    expect(await f.startup.run()).toBe('skipped')
    expect(f.adapters.prepare).not.toHaveBeenCalled()
    expect(f.adapters.invalidate).not.toHaveBeenCalled()
  })
  it('cancels a pending preference read instead of later starting the old choice', async () => {
    const f = fixture(),
      gate = deferred<RelayProfileSelection | undefined>()
    f.adapters.readSelection.mockReturnValue(gate.promise)
    const running = f.startup.run()
    const manual = f.startup.cancelAndWait()
    gate.resolve(f.selection)
    await manual
    expect(await running).toBe('cancelled')
    expect(f.adapters.prepare).not.toHaveBeenCalled()
    expect(f.adapters.invalidate).toHaveBeenCalledOnce()
  })
  it('invalidates pending preparation on close and never submits its late result', async () => {
    const f = fixture(),
      gate = deferred<{ canStart: boolean; hasRecord: boolean; evidenceId: string }>()
    f.adapters.prepare.mockReturnValue(gate.promise)
    const running = f.startup.run()
    await vi.waitFor(() => expect(f.adapters.prepare).toHaveBeenCalledOnce())
    f.startup.cancel()
    gate.resolve({ canStart: true, hasRecord: false, evidenceId: 'late' })
    expect(await running).toBe('cancelled')
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
  it('waits for an in-flight owned startup to observe cancellation before allowing a manual operation', async () => {
    const f = fixture(),
      gate = deferred<void>()
    f.adapters.start.mockImplementation(async (_id, current) => {
      await gate.promise
      current()
      return { status: 'started' }
    })
    const running = f.startup.run()
    await vi.waitFor(() => expect(f.adapters.start).toHaveBeenCalledOnce())
    let manualStarted = false
    const pending = f.startup.cancelAndWait()?.then(() => {
      manualStarted = true
    })
    expect(manualStarted).toBe(false)
    gate.resolve()
    await pending
    expect(await running).toBe('cancelled')
    expect(manualStarted).toBe(true)
    await f.startup.run()
    expect(f.adapters.start).toHaveBeenCalledOnce()
  })
  it('does not read/start without a current visible window context or retry after failure', async () => {
    const f = fixture()
    f.adapters.context.mockImplementation(() => {
      throw new Error('hidden/closed')
    })
    expect(await f.startup.run()).toBe('failed')
    await f.startup.run()
    expect(f.adapters.readSelection).not.toHaveBeenCalled()
    expect(f.adapters.context).toHaveBeenCalledOnce()
  })
})

describe('restoring a saved ordinary core immediately after TUN quit', () => {
  function afterTun(options: { live?: boolean; lease?: boolean; paused?(): void } = {}) {
    const f = fixture()
    const record: LocalProxyPlanRecord = {
      document: {
        httpPort: 7890,
        resolverMode: 'profile',
        ports: { http: 7890, socks: 7891, mixed: 7892, redir: 0 },
        dedicated: { httpPort: 17890, socksPort: 17891, route: 'fixed' }
      },
      exists: true,
      revision: 'f'.repeat(64)
    }
    f.adapters.readPlan.mockResolvedValue(record)
    let time = 0
    f.adapters.prepare.mockImplementation(async () => {
      const canStart = !options.lease && !options.live && time >= 30000
      f.state.phase = canStart ? 'idle' : 'blocked'
      f.state.hasRecord = !!options.lease
      return { canStart, hasRecord: !!options.lease, evidenceId: canStart ? 'fresh' : 'blocked' }
    })
    const probe = vi.fn(async (port: number) => port !== 17891 || time >= 30000)
    const waitForPorts = vi.fn((plan: LocalProxyPlan, current: () => void) =>
      waitForTunPlanPorts(plan, current, {
        probe,
        now: () => time,
        msl: async () => 15000,
        table: async () =>
          'tcp4 0 0 127.0.0.1.17891 127.0.0.1.60111 ' + (options.live ? 'LISTEN' : 'TIME_WAIT'),
        pause: async (ms: number) => {
          time += ms
          options.paused?.()
        }
      })
    )
    const onStarted = vi.fn(async (current: () => void) => current())
    const startup = createProfileStartup({ ...f.adapters, waitForPorts, onStarted })
    return { ...f, record, startup, probe, waitForPorts, onStarted, time: () => time }
  }

  it('reopens the saved ordinary and dedicated ports and applies the saved proxy preference once after TIME_WAIT', async () => {
    const f = afterTun()
    expect(await f.startup.run()).toBe('started')
    expect(f.time()).toBe(30000)
    expect(new Set(f.probe.mock.calls.map(([port]) => port))).toEqual(
      new Set([7890, 7891, 7892, 17890, 17891])
    )
    expect(f.adapters.prepare.mock.calls[0]).toEqual(f.adapters.prepare.mock.calls[1])
    expect(f.adapters.start).toHaveBeenCalledExactlyOnceWith('fresh', expect.any(Function))
    expect(f.onStarted).toHaveBeenCalledOnce()
  })
  it.each(['first-use', 'LISTEN', 'lease'] as const)(
    'does not wait, retry or take over on %s',
    async (kind) => {
      const f = afterTun({ live: kind === 'LISTEN', lease: kind === 'lease' })
      if (kind === 'first-use') f.adapters.readSelection.mockResolvedValue(undefined)
      expect(await f.startup.run()).toBe('skipped')
      expect(f.time()).toBe(0)
      expect(f.waitForPorts).toHaveBeenCalledTimes(kind === 'LISTEN' ? 1 : 0)
      expect(f.adapters.prepare).toHaveBeenCalledTimes(kind === 'first-use' ? 0 : 1)
      expect(f.adapters.start).not.toHaveBeenCalled()
      expect(f.onStarted).not.toHaveBeenCalled()
    }
  )
  it.each([true, false])(
    'accepts a blocked result from the fresh prepare without retrying again, hasRecord=%s',
    async (hasRecord) => {
      const f = afterTun()
      f.adapters.prepare.mockResolvedValueOnce({
        canStart: false,
        hasRecord: false,
        evidenceId: 'first'
      })
      f.adapters.prepare.mockResolvedValueOnce({ canStart: false, hasRecord, evidenceId: 'second' })
      expect(await f.startup.run()).toBe('skipped')
      expect(f.time()).toBe(30000)
      expect(f.adapters.prepare).toHaveBeenCalledTimes(2)
      expect(f.waitForPorts).toHaveBeenCalledOnce()
      expect(f.adapters.start).not.toHaveBeenCalled()
      expect(f.onStarted).not.toHaveBeenCalled()
    }
  )
  it.each(['quit', 'lost owner', 'profile', 'plan'] as const)(
    'rechecks %s before preparing a second time',
    async (change) => {
      const f = afterTun({
        paused: () => {
          if (change === 'quit') f.startup.cancel()
          if (change === 'lost owner') f.state.hasRecord = true
          if (change === 'profile')
            f.adapters.readSelection.mockResolvedValue({ ...f.selection, sha256: 'd'.repeat(64) })
          if (change === 'plan')
            f.adapters.readPlan.mockResolvedValue({ ...f.record, revision: 'd'.repeat(64) })
        }
      })
      expect(await f.startup.run()).toBe(change === 'quit' ? 'cancelled' : 'failed')
      expect(f.time()).toBe(change === 'quit' || change === 'lost owner' ? 750 : 30000)
      expect(f.adapters.prepare).toHaveBeenCalledTimes(1)
      expect(f.adapters.start).not.toHaveBeenCalled()
      expect(f.onStarted).not.toHaveBeenCalled()
    }
  )
})

describe('one-click ordinary system proxy startup', () => {
  it('reports the blocked listener and the failed startup stage to the same click', async () => {
    const f = fixture()
    const blocked = createProfileStartup({
      ...f.adapters,
      prepare: async () => ({
        canStart: false,
        hasRecord: false,
        evidenceId: 'busy',
        warnings: ['TCP 17891 不可用']
      }),
      waitForPorts: async () => false
    })
    await expect(blocked.startOnClick(() => {})).rejects.toThrow('TCP 17891')
    const failed = createProfileStartup({
      ...f.adapters,
      start: async () => ({ status: 'failed', state: { warnings: ['恢复所选节点未完成'] } })
    })
    await expect(failed.startOnClick(() => {})).rejects.toThrow('恢复所选节点')
  })
  it('leaves import alone and resolves the first profile only on a click', async () => {
    const f = fixture()
    f.adapters.readSelection.mockResolvedValue(undefined)
    const selectOnClick = vi.fn(async () => {
      f.adapters.readSelection.mockResolvedValue(f.selection)
      return f.selection
    })
    const onStarted = vi.fn()
    const manager = createProfileStartup({ ...f.adapters, selectOnClick, onStarted })
    expect(await manager.run()).toBe('skipped')
    expect(selectOnClick).not.toHaveBeenCalled()
    await manager.startOnClick(() => {})
    expect(selectOnClick).toHaveBeenCalledOnce()
    expect(f.adapters.prepare).toHaveBeenCalledOnce()
    expect(f.adapters.start).toHaveBeenCalledOnce()
    // The explicit caller owns applying the system proxy with the current settings.
    expect(onStarted).not.toHaveBeenCalled()
  })
  it('joins a saved-profile cold start while its prepared core is not listening yet', async () => {
    const f = fixture(),
      gate = deferred<void>()
    f.adapters.start.mockImplementation(async (_id, check) => {
      await gate.promise
      check()
      f.state.owned = true
      return { status: 'started' }
    })
    const cold = f.startup.run()
    await vi.waitFor(() => expect(f.adapters.start).toHaveBeenCalledOnce())
    const manual = f.startup.startOnClick(() => {})
    gate.resolve()
    expect(await cold).toBe('started')
    await manual
    expect(f.adapters.prepare).toHaveBeenCalledOnce()
    expect(f.adapters.start).toHaveBeenCalledOnce()
    expect(f.adapters.invalidate).not.toHaveBeenCalled()
  })
  it('never resolves a fallback for an empty library, a held lease or a cancelled click', async () => {
    const f = fixture(),
      selectOnClick = vi.fn(async () => undefined)
    const manager = createProfileStartup({ ...f.adapters, selectOnClick })
    await expect(manager.startOnClick(() => {})).rejects.toThrow('导入')
    f.state.hasRecord = true
    await expect(manager.startOnClick(() => {})).rejects.toThrow()
    expect(selectOnClick).toHaveBeenCalledOnce()
    f.state.hasRecord = false
    const gate = deferred<RelayProfileSelection | undefined>()
    const second = createProfileStartup({ ...f.adapters, selectOnClick: () => gate.promise })
    const manual = second.startOnClick(() => {})
    second.cancel()
    gate.resolve(f.selection)
    await expect(manual).rejects.toThrow()
    expect(f.adapters.prepare).not.toHaveBeenCalled()
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
})
