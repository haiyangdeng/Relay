import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RelayFloatingTrafficSample,
  RelayFloatingTrafficSnapshot
} from '../../../shared/relay/floating-traffic'
import { createFloatingTrafficController } from './floating-traffic'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
function sample(extra: Partial<RelayFloatingTrafficSample> = {}): RelayFloatingTrafficSample {
  return {
    up: 1024,
    down: 2048,
    upTotal: 100000,
    downTotal: 200000,
    instanceId: '12345678-1234-1234-1234-123456789abc',
    configurationRevision: 'a'.repeat(64),
    receivedAt: Date.now(),
    ...extra
  }
}
async function flush(): Promise<void> {
  for (let index = 0; index < 8; ++index) await Promise.resolve()
}
function setup(
  read = vi.fn<(signal: AbortSignal) => Promise<RelayFloatingTrafficSample | undefined>>()
) {
  const snapshots: RelayFloatingTrafficSnapshot[] = []
  const controller = createFloatingTrafficController({
    readTraffic: read,
    publish: (value) => snapshots.push(value)
  })
  return { controller, read, snapshots }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  vi.setSystemTime(10000)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('ordinary floating traffic controller', () => {
  it('does not read or publish until shown', () => {
    const { controller, read, snapshots } = setup()
    expect(controller.state()).toEqual({ version: 1, status: 'hidden' })
    expect(controller.isReading()).toBe(false)
    expect(read).not.toHaveBeenCalled()
    expect(snapshots).toEqual([])
  })

  it('shows loading and starts one read with a private view signal', async () => {
    const wait = deferred<RelayFloatingTrafficSample | undefined>()
    const { controller, read } = setup(vi.fn(() => wait.promise))
    controller.show()
    controller.show()
    expect(controller.state().status).toBe('loading')
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0][0].aborted).toBe(false)
    expect(controller.isReading()).toBe(true)
    controller.hide()
    wait.resolve(undefined)
    await flush()
  })

  it('hides immediately and aborts only its pending read without waiting', async () => {
    const wait = deferred<RelayFloatingTrafficSample | undefined>()
    const { controller, read } = setup(vi.fn(() => wait.promise))
    controller.show()
    await flush()
    expect(controller.hide()).toBeUndefined()
    expect(read.mock.calls[0][0].aborted).toBe(true)
    expect(controller.state().status).toBe('hidden')
    expect(controller.isReading()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    wait.resolve(sample())
    await flush()
    expect(controller.state().status).toBe('hidden')
    expect(controller.isReading()).toBe(false)
  })

  it('waits for an old hidden read to drain before reading a new visible epoch', async () => {
    const old = deferred<RelayFloatingTrafficSample | undefined>()
    const next = deferred<RelayFloatingTrafficSample | undefined>()
    const { controller, read, snapshots } = setup(
      vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    )
    controller.show()
    await flush()
    controller.hide()
    controller.show()
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    old.resolve(sample({ up: 999 }))
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(snapshots.filter((value) => value.status === 'ready')).toEqual([])
    next.resolve(sample({ up: 2 }))
    await flush()
    expect(controller.state()).toMatchObject({ status: 'ready', sample: { up: 2 } })
    controller.dispose()
  })

  it('invalidates an owner epoch synchronously and ignores its late sample', async () => {
    const old = deferred<RelayFloatingTrafficSample | undefined>()
    const next = deferred<RelayFloatingTrafficSample | undefined>()
    const { controller, read, snapshots } = setup(
      vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    )
    controller.show()
    await flush()
    controller.invalidate()
    expect(controller.state().status).toBe('loading')
    expect(read.mock.calls[0][0].aborted).toBe(true)
    old.resolve(sample())
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(snapshots.some((value) => value.status === 'ready')).toBe(false)
    controller.dispose()
    next.resolve(undefined)
    await flush()
  })

  it.each(['hide', 'dispose'] as const)(
    'does not dispatch when %s occurs before its microtask',
    async (action) => {
      const { controller, read } = setup()
      controller.show()
      controller[action]()
      await flush()
      expect(read).not.toHaveBeenCalled()
      expect(controller.isReading()).toBe(false)
      expect(controller.state().status).toBe('hidden')
    }
  )

  it('preserves actual zero rates and independent cumulative totals', async () => {
    const { controller } = setup(
      vi.fn(async () => sample({ up: 0, down: 0, upTotal: Number.MAX_SAFE_INTEGER }))
    )
    controller.show()
    await flush()
    expect(controller.state()).toMatchObject({
      status: 'ready',
      sample: { up: 0, down: 0, upTotal: Number.MAX_SAFE_INTEGER }
    })
    controller.dispose()
  })

  it('copies and freezes its completed sample instead of retaining a mutable DTO', async () => {
    const value = { ...sample() }
    const { controller } = setup(vi.fn(async () => value))
    controller.show()
    await flush()
    value.up = 100
    value.instanceId = 'bad'
    const result = controller.state()
    expect(result).toMatchObject({ status: 'ready', sample: { up: 1024 } })
    expect(Object.isFrozen(result)).toBe(true)
    if (result.status === 'ready') expect(Object.isFrozen(result.sample)).toBe(true)
    controller.dispose()
  })

  it('publishes unavailable instead of invented zero for a missing backend sample', async () => {
    const { controller } = setup(vi.fn(async () => undefined))
    controller.show()
    await flush()
    expect(controller.state()).toEqual({ version: 1, status: 'unavailable' })
    controller.dispose()
  })

  it('contains a read failure and retries only after a full polling interval', async () => {
    const { controller, read } = setup(vi.fn().mockRejectedValue(new Error('missing')))
    controller.show()
    await flush()
    expect(controller.state().status).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('never polls concurrently while the current read is pending', async () => {
    const wait = deferred<RelayFloatingTrafficSample | undefined>()
    const { controller, read } = setup(vi.fn(() => wait.promise))
    controller.show()
    await flush()
    await vi.advanceTimersByTimeAsync(10000)
    expect(read).toHaveBeenCalledTimes(1)
    controller.dispose()
    wait.resolve(undefined)
    await flush()
  })

  it('schedules after completion without adding a second delay to a slow first frame', async () => {
    const wait = deferred<RelayFloatingTrafficSample | undefined>()
    const { controller, read } = setup(
      vi.fn().mockReturnValueOnce(wait.promise).mockResolvedValue(undefined)
    )
    controller.show()
    await flush()
    await vi.advanceTimersByTimeAsync(1500)
    wait.resolve(sample())
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('expires the last display sample while a later read remains pending', async () => {
    const wait = deferred<RelayFloatingTrafficSample | undefined>()
    const { controller, read } = setup(
      vi.fn().mockResolvedValueOnce(sample()).mockReturnValueOnce(wait.promise)
    )
    controller.show()
    await flush()
    expect(controller.state().status).toBe('ready')
    await vi.advanceTimersByTimeAsync(1999)
    expect(controller.state().status).toBe('ready')
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.state().status).toBe('unavailable')
    expect(read.mock.calls[1][0].aborted).toBe(false)
    expect(controller.isReading()).toBe(true)
    wait.resolve(sample({ down: 99 }))
    await flush()
    expect(controller.state()).toMatchObject({ status: 'ready', sample: { down: 99 } })
    controller.dispose()
  })

  it.each([1, 2000, 10000])('rejects a sample %i milliseconds in the future', async (offset) => {
    const { controller } = setup(vi.fn(async () => sample({ receivedAt: Date.now() + offset })))
    controller.show()
    await flush()
    expect(controller.state().status).toBe('unavailable')
    controller.dispose()
  })

  it.each([2000, 2001, 9999])('rejects a sample already %i milliseconds old', async (age) => {
    const { controller } = setup(vi.fn(async () => sample({ receivedAt: Date.now() - age })))
    controller.show()
    await flush()
    expect(controller.state().status).toBe('unavailable')
    controller.dispose()
  })

  it('uses only the remaining lifetime of a valid old sample', async () => {
    const { controller } = setup(vi.fn(async () => sample({ receivedAt: Date.now() - 1999 })))
    controller.show()
    await flush()
    expect(controller.state().status).toBe('ready')
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.state().status).toBe('unavailable')
    controller.dispose()
  })

  it.each(['wall', 'mono'] as const)(
    'rejects rollback or expiry of the %s display clock',
    async (kind) => {
      let wall = 10000,
        mono = 100
      const controller = createFloatingTrafficController({
        readTraffic: async () => sample(),
        publish: () => {},
        wallNow: () => wall,
        monotonicNow: () => mono
      })
      controller.show()
      await flush()
      expect(controller.state().status).toBe('ready')
      if (kind === 'wall') wall -= 1
      else mono -= 1
      expect(controller.state().status).toBe('unavailable')
      controller.dispose()
    }
  )

  it.each(['wall', 'mono'] as const)(
    'checks the %s display clock even before a delayed timer fires',
    async (kind) => {
      let wall = 10000,
        mono = 100
      const controller = createFloatingTrafficController({
        readTraffic: async () => sample(),
        publish: () => {},
        wallNow: () => wall,
        monotonicNow: () => mono
      })
      controller.show()
      await flush()
      if (kind === 'wall') wall += 2000
      else mono += 2000
      expect(controller.state().status).toBe('unavailable')
      controller.dispose()
    }
  )

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'does not dispatch with an invalid clock %s',
    async (value) => {
      const read = vi.fn(async () => sample())
      const controller = createFloatingTrafficController({
        readTraffic: read,
        publish: () => {},
        monotonicNow: () => value
      })
      controller.show()
      await flush()
      expect(read).not.toHaveBeenCalled()
      expect(controller.state().status).toBe('unavailable')
      controller.dispose()
    }
  )

  it('captures adapter functions before a caller changes its DTO', async () => {
    const originalRead = vi.fn<
      (signal: AbortSignal) => Promise<RelayFloatingTrafficSample | undefined>
    >(async () => sample())
    const originalPublish = vi.fn()
    const input = { readTraffic: originalRead, publish: originalPublish }
    const controller = createFloatingTrafficController(input)
    input.readTraffic = vi.fn(async () => undefined)
    input.publish = vi.fn()
    controller.show()
    await flush()
    expect(originalRead).toHaveBeenCalledTimes(1)
    expect(originalPublish).toHaveBeenCalled()
    expect(input.readTraffic).not.toHaveBeenCalled()
    expect(input.publish).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('contains a throwing display clock without dispatching a read', async () => {
    const read = vi.fn(async () => sample())
    const controller = createFloatingTrafficController({
      readTraffic: read,
      publish: () => {},
      monotonicNow: () => {
        throw new Error('clock unavailable')
      }
    })
    expect(() => controller.show()).not.toThrow()
    await flush()
    expect(read).not.toHaveBeenCalled()
    expect(controller.state().status).toBe('unavailable')
    controller.dispose()
  })

  it('contains a broken display observer without opening a read', async () => {
    const read = vi.fn(async () => sample())
    const controller = createFloatingTrafficController({
      readTraffic: read,
      publish: () => {
        throw new Error('view gone')
      }
    })
    expect(() => controller.show()).not.toThrow()
    await flush()
    expect(read).not.toHaveBeenCalled()
    expect(controller.state().status).toBe('hidden')
    controller.show()
    await vi.advanceTimersByTimeAsync(5000)
    expect(read).not.toHaveBeenCalled()
  })

  it('can be hidden reentrantly by the ready observer', async () => {
    const controller: ReturnType<typeof createFloatingTrafficController> =
      createFloatingTrafficController({
        readTraffic: async () => sample(),
        publish: (value) => {
          if (value.status === 'ready') controller.hide()
        }
      })
    controller.show()
    await flush()
    expect(controller.state().status).toBe('hidden')
    expect(vi.getTimerCount()).toBe(0)
    controller.dispose()
  })

  it('cannot be restarted after dispose even if its late read returns', async () => {
    const wait = deferred<RelayFloatingTrafficSample | undefined>()
    const { controller, read } = setup(vi.fn(() => wait.promise))
    controller.show()
    await flush()
    expect(controller.dispose()).toBeUndefined()
    expect(read.mock.calls[0][0].aborted).toBe(true)
    controller.show()
    controller.invalidate()
    wait.resolve(sample())
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(controller.state().status).toBe('hidden')
    expect(read).toHaveBeenCalledTimes(1)
    expect(controller.isReading()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['invalidate', 'hide-show'] as const)(
    'global read start interval survives %s after a completed read',
    async (action) => {
      const starts: number[] = []
      const { controller } = setup(
        vi.fn(async () => {
          starts.push(Date.now())
          return sample()
        })
      )
      controller.show()
      await flush()
      await vi.advanceTimersByTimeAsync(100)
      if (action === 'invalidate') controller.invalidate()
      else {
        controller.hide()
        controller.show()
      }
      await flush()
      expect(starts).toEqual([10000])
      expect(controller.state().status).toBe('loading')
      await vi.advanceTimersByTimeAsync(899)
      expect(starts).toEqual([10000])
      await vi.advanceTimersByTimeAsync(1)
      expect(starts).toEqual([10000, 11000])
      controller.dispose()
    }
  )

  it('global read start interval measures actual invocation after the first microtask', async () => {
    const starts: number[] = []
    const { controller } = setup(
      vi.fn(async () => {
        starts.push(Date.now())
        return sample()
      })
    )
    controller.show()
    vi.advanceTimersByTime(600)
    await flush()
    expect(starts).toEqual([10600])
    await vi.advanceTimersByTimeAsync(999)
    expect(starts).toEqual([10600])
    await vi.advanceTimersByTimeAsync(1)
    expect(starts).toEqual([10600, 11600])
    controller.dispose()
  })

  it('global read start interval remains fixed through repeated owner notifications', async () => {
    const starts: number[] = []
    const { controller } = setup(
      vi.fn(async () => {
        starts.push(Date.now())
        return undefined
      })
    )
    controller.show()
    await flush()
    for (let index = 0; index < 9; ++index) {
      await vi.advanceTimersByTimeAsync(100)
      controller.invalidate()
      await flush()
      expect(starts).toEqual([10000])
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(starts).toEqual([10000, 11000])
    controller.dispose()
  })

  it('global read start interval records a failed actual invocation as an attempt', async () => {
    const starts: number[] = []
    const { controller } = setup(
      vi.fn(() => {
        starts.push(Date.now())
        throw new Error('own read failed')
      })
    )
    controller.show()
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    controller.hide()
    controller.show()
    await flush()
    expect(starts).toEqual([10000])
    await vi.advanceTimersByTimeAsync(900)
    expect(starts).toEqual([10000, 11000])
    controller.dispose()
  })

  it('global read start interval still requires a pending old read to drain', async () => {
    const old = deferred<RelayFloatingTrafficSample | undefined>()
    const starts: number[] = []
    const { controller } = setup(
      vi.fn(() => {
        starts.push(Date.now())
        return starts.length === 1 ? old.promise : Promise.resolve(sample())
      })
    )
    controller.show()
    await flush()
    controller.hide()
    controller.show()
    await vi.advanceTimersByTimeAsync(1500)
    expect(starts).toEqual([10000])
    old.resolve(sample({ up: 999 }))
    await flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(starts).toEqual([10000, 11500])
    expect(controller.state()).toMatchObject({ status: 'ready', sample: { up: 1024 } })
    controller.dispose()
  })
})

it('clears a TUN source immediately on owner invalidation and rejects its late read', async () => {
  const pending = deferred<RelayFloatingTrafficSample | undefined>()
  const { controller, read } = setup(vi.fn(() => pending.promise))
  controller.show()
  await flush()
  controller.invalidate()
  expect(read.mock.calls[0][0].aborted).toBe(true)
  expect(controller.state().status).toBe('loading')
  pending.resolve({
    kind: 'tun-managed',
    sessionId: '11111111-1111-4111-8111-111111111111',
    evidenceSHA256: 'b'.repeat(64),
    runtimeConfigurationSHA256: 'c'.repeat(64),
    receivedAt: Date.now(),
    up: 0,
    down: 0,
    upTotal: 0,
    downTotal: 0
  })
  await flush()
  expect(controller.state().status).toBe('loading')
  expect(read).toHaveBeenCalledOnce()
  controller.hide()
})
