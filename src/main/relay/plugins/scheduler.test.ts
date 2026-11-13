import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRelayPluginScheduler,
  type PluginSchedulePermission,
  type PluginSchedulePermit
} from './scheduler'

const cleanup: (() => Promise<void>)[] = [],
  id = '00000000-0000-0000-0000-000000000001',
  secondId = '00000000-0000-0000-0000-000000000002'
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  vi.useRealTimers()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}
async function settle(): Promise<void> {
  for (let i = 0; i < 8; ++i) await Promise.resolve()
}
function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'))
  const permits: ReturnType<typeof permit>[] = []
  function permit(selected: string) {
    return {
      permission: {
        id: selected,
        name: 'Fixture',
        route: 'proxy' as const,
        origins: ['https://plugin.invalid'],
        revision: 'a'.repeat(64),
        discoveryRevision: 'b'.repeat(64)
      },
      activate: vi.fn(async () => {}),
      run: vi.fn(async (): Promise<Awaited<ReturnType<PluginSchedulePermit['run']>>> => ({
        status: 'updated'
      })),
      revoke: vi.fn(() => {})
    }
  }
  const adapters = {
    prepare: vi.fn(async (selected: string): Promise<PluginSchedulePermit> => {
      const prepared = permit(selected)
      permits.push(prepared)
      return prepared
    }),
    canRun: vi.fn(() => true),
    confirm: vi.fn(async (_permission: PluginSchedulePermission, _minutes: number) => true),
    notify: vi.fn(() => {}),
    random: () => 0
  }
  const scheduler = createRelayPluginScheduler(adapters)
  cleanup.push(() => scheduler.requestClose())
  return { scheduler, adapters, permits, selection: { id, minutes: 1 } }
}

describe('Plugin scheduling requires a fresh in-memory permission', () => {
  it('does no startup IO, does not restore authorizations, and waits one full cycle', async () => {
    const f = fixture()
    expect(f.scheduler.state()).toEqual({ pending: false, entries: [] })
    expect(f.adapters.prepare).not.toHaveBeenCalled()
    await f.scheduler.arm(f.selection)
    expect(f.adapters.confirm).toHaveBeenCalledWith(f.permits[0].permission, 1)
    expect(f.permits[0].activate).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.permits[0].run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.permits[0].run).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.permits[0].run).toHaveBeenCalledOnce()
    const fresh = createRelayPluginScheduler(f.adapters)
    cleanup.push(() => fresh.requestClose())
    expect(fresh.state().entries).toEqual([])
    expect(f.adapters.prepare).toHaveBeenCalledTimes(1)
  })

  it('revokes a declined capability without activating it or scheduling', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(false)
    expect((await f.scheduler.arm(f.selection)).status).toBe('cancelled')
    expect(f.permits[0].revoke).toHaveBeenCalledOnce()
    expect(f.permits[0].activate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.permits[0].run).not.toHaveBeenCalled()
    expect(f.scheduler.state().entries).toEqual([])
  })

  it('requires the prepared revision to survive activation after confirmation', async () => {
    const f = fixture()
    f.adapters.confirm.mockImplementation(async () => {
      f.permits[0].activate.mockRejectedValue(new Error('changed'))
      return true
    })
    await expect(f.scheduler.arm(f.selection)).rejects.toThrow('changed')
    expect(f.permits[0].revoke).toHaveBeenCalledOnce()
    expect(f.scheduler.isBusy()).toBe(false)
    expect(f.scheduler.state().entries).toEqual([])
  })

  it('does not let a dialog or state consumer mutate the bound permission', async () => {
    const f = fixture()
    f.adapters.confirm.mockImplementation(async (permission) => {
      permission.origins.push('https://unapproved.invalid')
      return true
    })
    await f.scheduler.arm(f.selection)
    const state = f.scheduler.state()
    state.entries[0].origins.push('https://other.invalid')
    expect(f.permits[0].permission.origins).toEqual(['https://plugin.invalid'])
    expect(f.scheduler.state().entries[0].origins).toEqual(['https://plugin.invalid'])
  })

  it.each([
    null,
    { id },
    { id, minutes: 0 },
    { id, minutes: 1.5 },
    { id, minutes: '1' },
    { id, minutes: 34561 },
    { id, minutes: Infinity },
    { id, minutes: 1, restored: true },
    { id: '../other', minutes: 1 }
  ])('rejects malformed schedule parameters %j without preparing credentials', async (raw) => {
    const f = fixture()
    await expect(f.scheduler.arm(raw)).rejects.toThrow()
    expect(f.adapters.prepare).not.toHaveBeenCalled()
  })

  it('uses exponential network backoff while keeping the interval floor and resets after success', async () => {
    const f = fixture()
    await f.scheduler.arm(f.selection)
    f.permits[0].run
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'failed' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.scheduler.state().entries[0]).toMatchObject({
      enabled: true,
      failureCount: 1,
      lastStatus: 'failed'
    })
    await vi.advanceTimersByTimeAsync(299999)
    expect(f.permits[0].run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.permits[0].run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(599999)
    expect(f.permits[0].run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.permits[0].run).toHaveBeenCalledTimes(3)
    expect(f.scheduler.state().entries[0]).toMatchObject({
      enabled: true,
      failureCount: 0,
      lastStatus: 'updated'
    })
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.permits[0].run).toHaveBeenCalledTimes(4)
    await f.scheduler.arm({ id: secondId, minutes: 10 })
    f.permits[1].run.mockResolvedValueOnce({ status: 'failed' })
    await vi.advanceTimersByTimeAsync(600000)
    expect(Date.parse(f.scheduler.state().entries[1].nextAt ?? '') - Date.now()).toBe(600000)
  })

  it.each(['credentials', 'changed', 'uncertain', 'cancelled'] as const)(
    'stops on %s and never reuses the capability',
    async (status) => {
      const f = fixture()
      await f.scheduler.arm(f.selection)
      f.permits[0].run.mockResolvedValueOnce({ status })
      await vi.advanceTimersByTimeAsync(60000)
      expect(f.scheduler.state().entries[0]).toMatchObject({ enabled: false, lastStatus: status })
      expect(f.permits[0].revoke).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(86400000)
      expect(f.permits[0].run).toHaveBeenCalledOnce()
    }
  )

  it('treats an unexpected thrown operation as uncertain and stops', async () => {
    const f = fixture()
    await f.scheduler.arm(f.selection)
    f.permits[0].run.mockRejectedValueOnce(new Error('unknown'))
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.scheduler.state().entries[0]).toMatchObject({
      enabled: false,
      lastStatus: 'uncertain'
    })
  })

  it('defers busy work and serializes multiple plugin entries without catch-up', async () => {
    const f = fixture(),
      result = deferred<Awaited<ReturnType<PluginSchedulePermit['run']>>>()
    await f.scheduler.arm(f.selection)
    await f.scheduler.arm({ id: secondId, minutes: 1 })
    f.adapters.canRun.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.permits[0].run).not.toHaveBeenCalled()
    expect(f.permits[1].run).not.toHaveBeenCalled()
    f.adapters.canRun.mockReturnValue(true)
    f.permits[0].run.mockReturnValueOnce(result.promise)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.permits[0].run).toHaveBeenCalledOnce()
    expect(f.permits[1].run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300000)
    expect(f.permits[0].run).toHaveBeenCalledOnce()
    expect(f.permits[1].run).not.toHaveBeenCalled()
    result.resolve({ status: 'updated' })
    await settle()
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.permits[1].run).toHaveBeenCalledOnce()
  })

  it('revokes and waits for an in-flight update on disarm, preserving the stop outcome', async () => {
    const f = fixture(),
      result = deferred<Awaited<ReturnType<PluginSchedulePermit['run']>>>()
    await f.scheduler.arm(f.selection)
    f.permits[0].run.mockReturnValueOnce(result.promise)
    await vi.advanceTimersByTimeAsync(60000)
    let stopped = false
    const stopping = f.scheduler.disarm({ id }).then(() => {
      stopped = true
    })
    await settle()
    expect(stopped).toBe(false)
    expect(f.permits[0].revoke).toHaveBeenCalledOnce()
    result.resolve({ status: 'updated' })
    await stopping
    expect(f.scheduler.state().entries[0]).toMatchObject({ enabled: false, lastStatus: 'stopped' })
    await vi.advanceTimersByTimeAsync(3600000)
    expect(f.permits[0].run).toHaveBeenCalledOnce()
  })

  it.each(['requestClose', 'suspend'] as const)(
    'invalidates and waits for a pending confirmation across %s',
    async (action) => {
      const f = fixture(),
        answer = deferred<boolean>()
      f.adapters.confirm.mockReturnValueOnce(answer.promise)
      const arming = f.scheduler.arm(f.selection)
      await settle()
      let closed = false
      const closing = f.scheduler[action]().then(() => {
        closed = true
      })
      f.scheduler.resume()
      await settle()
      expect(closed).toBe(false)
      expect(f.permits[0].revoke).toHaveBeenCalled()
      answer.resolve(true)
      expect((await arming).status).toBe('cancelled')
      await closing
      expect(f.permits[0].activate).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(120000)
      expect(f.permits[0].run).not.toHaveBeenCalled()
      expect(f.scheduler.state().entries).toEqual([])
    }
  )

  it('revokes on sleep and resume never revives the old authorization', async () => {
    const f = fixture()
    await f.scheduler.arm(f.selection)
    await f.scheduler.suspend()
    expect(f.scheduler.state()).toMatchObject({
      suspended: true,
      entries: [{ enabled: false, lastStatus: 'suspended' }]
    })
    await expect(f.scheduler.arm(f.selection)).rejects.toThrow('挂起')
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(3600000)
    expect(f.permits[0].run).not.toHaveBeenCalled()
    await f.scheduler.arm(f.selection)
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.permits[1].run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.permits[1].run).toHaveBeenCalledOnce()
  })

  it('invalidates an authorization even while prepare is awaiting credential access', async () => {
    const f = fixture(),
      prepared = deferred<PluginSchedulePermit>()
    const realPrepare = f.adapters.prepare.getMockImplementation()
    if (!realPrepare) throw new Error('fixture prepare missing')
    f.adapters.prepare.mockReturnValueOnce(prepared.promise)
    const arming = f.scheduler.arm(f.selection)
    const closing = f.scheduler.requestClose()
    prepared.resolve(await realPrepare(id))
    expect((await arming).status).toBe('cancelled')
    await closing
    expect(f.adapters.confirm).not.toHaveBeenCalled()
    expect(f.permits[0].revoke).toHaveBeenCalledOnce()
  })

  it('waits for an activation in progress and never installs it after close', async () => {
    const f = fixture(),
      activation = deferred<void>()
    f.adapters.confirm.mockImplementationOnce(async () => {
      f.permits[0].activate.mockReturnValueOnce(activation.promise)
      return true
    })
    const arming = f.scheduler.arm(f.selection)
    await settle()
    expect(f.permits[0].activate).toHaveBeenCalledOnce()
    const closing = f.scheduler.requestClose()
    expect(f.scheduler.isBlocking()).toBe(true)
    activation.resolve()
    expect((await arming).status).toBe('cancelled')
    await closing
    expect(f.scheduler.state()).toEqual({ pending: false, entries: [] })
    expect(f.permits[0].revoke).toHaveBeenCalled()
  })

  it('disarming during confirmation invalidates the pending authorization', async () => {
    const f = fixture(),
      answer = deferred<boolean>()
    f.adapters.confirm.mockReturnValueOnce(answer.promise)
    const arming = f.scheduler.arm(f.selection)
    await settle()
    const disarming = f.scheduler.disarm({ id })
    answer.resolve(true)
    expect((await arming).status).toBe('cancelled')
    expect(await disarming).toEqual({ pending: false, entries: [] })
    expect(f.permits[0].activate).not.toHaveBeenCalled()
  })
})
