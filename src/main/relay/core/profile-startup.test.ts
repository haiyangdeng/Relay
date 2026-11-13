import { describe, expect, it, vi } from 'vitest'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'
import {
  defaultLocalProxyPlan,
  type LocalProxyPlanRecord
} from '../../../shared/relay/local-proxy-plan'
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
    prepare: vi.fn(async () => ({ canStart: true, evidenceId: 'startup' })),
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
    f.adapters.prepare.mockResolvedValue({ canStart: false, evidenceId: 'blocked' })
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
      gate = deferred<{ canStart: boolean; evidenceId: string }>()
    f.adapters.prepare.mockReturnValue(gate.promise)
    const running = f.startup.run()
    await vi.waitFor(() => expect(f.adapters.prepare).toHaveBeenCalledOnce())
    f.startup.cancel()
    gate.resolve({ canStart: true, evidenceId: 'late' })
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
