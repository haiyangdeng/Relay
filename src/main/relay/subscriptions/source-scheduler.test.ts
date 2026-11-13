import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubscriptionSourceResult } from '../../../shared/relay/subscription-sources'
import type { SubscriptionSourceStore } from './source-store'
import { sourceOptions } from './source-options'
import { createSourceScheduler, effectiveSourceSchedule, nextSourceRun } from './source-scheduler'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'))
  const stored: Awaited<ReturnType<SubscriptionSourceStore['read']>> = {
    info: {
      id: '00000000-0000-0000-0000-000000000001',
      revision: 'a'.repeat(64),
      name: 'Fixture',
      origin: 'https://sub.invalid',
      proxyPort: 18191,
      createdAt: '2026-10-25',
      versions: [],
      locked: false
    },
    options: { ...sourceOptions(undefined), schedule: { kind: 'interval', minutes: 1 } },
    request: { name: 'Fixture', url: 'https://sub.invalid/PRIVATE', proxyPort: 18191 },
    originRevision: 'b'.repeat(64),
    recordCount: 0,
    parent: null,
    cache: undefined
  }
  const adapters = {
    store: {
      read: vi.fn(async () => structuredClone(stored)),
      readId: vi.fn(async () => structuredClone(stored))
    },
    canRun: vi.fn(() => true),
    run: vi.fn(async (): Promise<SubscriptionSourceResult> => ({ status: 'saved', warnings: [] })),
    requestStop: vi.fn(async () => {}),
    confirm: vi.fn(async () => false)
  }
  const scheduler = createSourceScheduler(adapters)
  cleanup.push(() => scheduler.requestClose())
  return {
    scheduler,
    adapters,
    stored,
    selection: { id: stored.info.id, revision: stored.info.revision }
  }
}
describe('Explicit per-session source scheduling', () => {
  it('waits through long cron timer chunks without running before the original nextAt', async () => {
    const f = fixture()
    f.stored.options.schedule = { kind: 'cron', expression: '0 0 1 1 *' }
    f.adapters.confirm.mockResolvedValue(true)
    await f.scheduler.arm(f.selection)
    const target = Date.parse(String(f.scheduler.state().entries[0].nextAt)),
      initial = Date.now()
    expect(target - initial).toBeGreaterThan(2147483647)
    await vi.advanceTimersByTimeAsync(2147483647)
    expect(f.adapters.run).not.toHaveBeenCalled()
    expect(f.adapters.store.readId).not.toHaveBeenCalled()
    expect(f.scheduler.state().entries[0].nextAt).toBe(new Date(target).toISOString())
    await vi.advanceTimersByTimeAsync(target - Date.now() - 1)
    expect(f.adapters.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.adapters.run).toHaveBeenCalledOnce()
  })
  it('does not let an expired pre-wake read failure disable the new wake interval', async () => {
    const f = fixture(),
      gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>()
    f.adapters.confirm.mockResolvedValue(true)
    await f.scheduler.arm(f.selection)
    f.adapters.store.readId.mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      throw new Error('expired read')
    })
    await vi.advanceTimersByTimeAsync(60000)
    await entered.promise
    await f.scheduler.suspend()
    f.scheduler.resume()
    const next = f.scheduler.state().entries[0].nextAt
    gate.resolve()
    await f.scheduler.whenIdle()
    expect(f.scheduler.state().entries[0]).toMatchObject({ enabled: true, nextAt: next })
    expect(f.adapters.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapters.run).toHaveBeenCalledOnce()
  })
  it('does not resume an expired fire after sleep during its source read or reset the fresh wake timer', async () => {
    const f = fixture(),
      gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>()
    f.adapters.confirm.mockResolvedValue(true)
    await f.scheduler.arm(f.selection)
    f.adapters.store.readId.mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      return structuredClone(f.stored)
    })
    await vi.advanceTimersByTimeAsync(60000)
    await entered.promise
    await f.scheduler.suspend()
    f.scheduler.resume()
    const wakeNext = f.scheduler.state().entries[0].nextAt
    gate.resolve()
    await f.scheduler.whenIdle()
    expect(f.adapters.run).not.toHaveBeenCalled()
    expect(f.scheduler.state().entries[0].nextAt).toBe(wakeNext)
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.adapters.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.adapters.run).toHaveBeenCalledOnce()
  })
  it('still disables an uncertain admitted publication when it completes after sleep and resume', async () => {
    const f = fixture(),
      gate = Promise.withResolvers<SubscriptionSourceResult>()
    f.adapters.confirm.mockResolvedValue(true)
    f.adapters.run.mockReturnValueOnce(gate.promise)
    await f.scheduler.arm(f.selection)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapters.run).toHaveBeenCalledOnce()
    await f.scheduler.suspend()
    f.scheduler.resume()
    gate.resolve({ status: 'uncertain', warnings: [] })
    await f.scheduler.whenIdle()
    expect(f.scheduler.state().entries[0]).toMatchObject({
      enabled: false,
      lastStatus: 'uncertain'
    })
    expect(f.scheduler.state().entries[0].nextAt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.run).toHaveBeenCalledOnce()
  })
  it.each(['suspend', 'close', 'disarm'] as const)(
    'does not admit a timer when %s occurs during the final source re-read',
    async (kind) => {
      const f = fixture(),
        gate = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>()
      f.adapters.confirm.mockResolvedValue(true)
      f.adapters.store.read
        .mockImplementationOnce(async () => structuredClone(f.stored))
        .mockImplementationOnce(async () => {
          entered.resolve()
          await gate.promise
          return structuredClone(f.stored)
        })
      const pending = f.scheduler.arm(f.selection)
      await entered.promise
      if (kind === 'suspend') {
        await f.scheduler.suspend()
        f.scheduler.resume()
      } else if (kind === 'close') await f.scheduler.requestClose()
      else await f.scheduler.disarm({ id: f.selection.id })
      let idle = false
      const drained = f.scheduler.whenIdle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(idle).toBe(false)
      gate.resolve()
      expect((await pending).status).toBe('cancelled')
      await drained
      expect(idle).toBe(true)
      expect(f.scheduler.state().entries).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(120000)
      expect(f.adapters.run).not.toHaveBeenCalled()
    }
  )
  it('pauses timers across suspend and schedules a full new interval on resume without burst catch-up', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    await f.scheduler.arm(f.selection)
    await vi.advanceTimersByTimeAsync(30000)
    await f.scheduler.suspend()
    expect(f.scheduler.state()).toMatchObject({
      suspended: true,
      entries: [{ enabled: true, lastStatus: 'suspended' }]
    })
    await vi.advanceTimersByTimeAsync(3600000)
    expect(f.adapters.run).not.toHaveBeenCalled()
    await expect(f.scheduler.arm(f.selection)).rejects.toThrow('挂起')
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.adapters.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.adapters.run).toHaveBeenCalledOnce()
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.adapters.run).toHaveBeenCalledOnce()
  })
  it('invalidates an arming confirmation across sleep even if the system resumes before consent returns', async () => {
    const f = fixture()
    let answer: (value: boolean) => void = () => {}
    f.adapters.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )
    const arming = f.scheduler.arm(f.selection)
    await Promise.resolve()
    await Promise.resolve()
    await f.scheduler.suspend()
    f.scheduler.resume()
    answer(true)
    expect((await arming).status).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.run).not.toHaveBeenCalled()
  })
  it('does no startup IO and cancellation never arms a timer', async () => {
    const f = fixture()
    expect(f.scheduler.state()).toEqual({ pending: false, entries: [] })
    expect(f.adapters.store.read).not.toHaveBeenCalled()
    expect((await f.scheduler.arm(f.selection)).status).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.run).not.toHaveBeenCalled()
  })
  it('waits the full interval and never repeats immediately or persists an enabled flag', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    expect((await f.scheduler.arm(f.selection)).status).toBe('armed')
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.adapters.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.adapters.run).toHaveBeenCalledTimes(1)
    expect(f.adapters.run).toHaveBeenCalledWith(f.selection.id, f.stored.originRevision)
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.adapters.run).toHaveBeenCalledTimes(1)
    await f.scheduler.requestClose()
    expect(f.scheduler.state().entries[0].enabled).toBe(false)
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.run).toHaveBeenCalledTimes(1)
  })
  it('defers while manual work is busy without burst catch-up', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    f.adapters.canRun.mockReturnValue(false)
    await f.scheduler.arm(f.selection)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.scheduler.state().entries[0].lastStatus).toBe('busy')
    expect(f.adapters.run).not.toHaveBeenCalled()
    f.adapters.canRun.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapters.run).toHaveBeenCalledTimes(1)
  })
  it('stops on origin changes or uncertain writes without adopting the changed source', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    await f.scheduler.arm(f.selection)
    f.stored.originRevision = 'c'.repeat(64)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.scheduler.state().entries[0]).toMatchObject({
      enabled: false,
      lastStatus: 'sourceChanged'
    })
    expect(f.adapters.run).not.toHaveBeenCalled()
    await f.scheduler.arm(f.selection)
    f.adapters.run.mockResolvedValueOnce({ status: 'uncertain', warnings: [] })
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.scheduler.state().entries[0]).toMatchObject({
      enabled: false,
      lastStatus: 'uncertain'
    })
  })
  it('does not overlap an in-flight update and waits for its cancellation on disarm', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    let finish!: (result: SubscriptionSourceResult) => void
    f.adapters.run.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await f.scheduler.arm(f.selection)
    await vi.advanceTimersByTimeAsync(60000)
    await vi.advanceTimersByTimeAsync(300000)
    expect(f.adapters.run).toHaveBeenCalledTimes(1)
    f.adapters.requestStop.mockImplementationOnce(async () => {
      finish({ status: 'cancelled', warnings: [] })
    })
    await f.scheduler.disarm({ id: f.selection.id })
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.scheduler.state().entries[0].enabled).toBe(false)
    expect(f.adapters.run).toHaveBeenCalledTimes(1)
  })
  it('uses five-field cron with a minute floor and only follows server intervals when opted in', () => {
    const f = fixture(),
      at = Date.now(),
      next = nextSourceRun({ kind: 'cron', expression: '* * * * *' }, at)
    expect(next).toBe(at + 60000)
    f.stored.cache = {
      profile: { id: f.selection.id, sha256: 'a'.repeat(64) },
      metadata: {
        checkedAt: new Date().toISOString(),
        status: 200,
        resourceSHA256: 'a'.repeat(64),
        intervalMinutes: 5
      }
    }
    expect(effectiveSourceSchedule(f.stored)).toEqual({ kind: 'interval', minutes: 1 })
    f.stored.options.useServerInterval = true
    expect(effectiveSourceSchedule(f.stored)).toEqual({ kind: 'interval', minutes: 5 })
  })
})
