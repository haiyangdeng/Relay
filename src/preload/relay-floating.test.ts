import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { relayFloatingTrafficChannel } from '../shared/relay/floating-traffic'
import { createReadonlyFloatingBridge } from './relay-floating'

let wall = 10000,
  tick = 0
const sample = () => ({
  up: 1024,
  down: 2048,
  upTotal: 100000,
  downTotal: 200000,
  instanceId: '11111111-1111-4111-8111-111111111111',
  configurationRevision: 'a'.repeat(64),
  receivedAt: wall
})
function fixture() {
  const io = { on: vi.fn(), removeListener: vi.fn() },
    bridge = createReadonlyFloatingBridge(io, { now: () => wall, tick: () => tick })
  const receive = (...args: unknown[]) => io.on.mock.calls[0][1]({}, ...args)
  return { ...bridge, io, receive }
}
beforeEach(() => {
  wall = 10000
  tick = 0
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
describe('Readonly floating event cache', () => {
  it('subscribes before React mounts and replays only the strict current snapshot without invoke/send', () => {
    const f = fixture(),
      listener = vi.fn()
    f.receive({ version: 1, status: 'ready', sample: sample(), spinFloatingIcon: false })
    const off = f.api.onSnapshot(listener)
    expect(f.io.on).toHaveBeenCalledOnce()
    expect(f.io.on.mock.calls[0][0]).toBe(relayFloatingTrafficChannel)
    expect(Object.keys(f.api)).toEqual(['onSnapshot'])
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0].sample.up).toBe(1024)
    expect(listener.mock.calls[0][0].spinFloatingIcon).toBe(false)
    off()
    f.receive({ version: 1, status: 'unavailable' })
    expect(listener).toHaveBeenCalledOnce()
    f.dispose()
  })
  it.each([
    { version: 1, status: 'ready', sample: { ...sample(), html: '<img src=x>' } },
    { version: 1, status: 'ready', sample: sample(), spinFloatingIcon: 'true' },
    { version: 2, status: 'loading' },
    { version: 1, status: 'loading', path: '/private' }
  ])('rejects extra fields/version instead of forwarding data %j', (value) => {
    const f = fixture(),
      listener = vi.fn()
    f.api.onSnapshot(listener)
    f.receive(value)
    expect(listener).toHaveBeenLastCalledWith({ version: 1, status: 'unavailable' })
    f.dispose()
  })
  it('accepts only one payload argument and catches invalid events', () => {
    const f = fixture(),
      listener = vi.fn()
    f.api.onSnapshot(listener)
    f.receive({ version: 1, status: 'loading' }, 'extra')
    expect(listener).toHaveBeenLastCalledWith({ version: 1, status: 'unavailable' })
    f.dispose()
  })
  it.each([
    () => {
      wall -= 1
    },
    () => {
      tick -= 1
    },
    () => {
      wall += 2000
    },
    () => {
      tick += 2000
    }
  ])('rejects expired or backwards clocks on cache replay', (change) => {
    const f = fixture(),
      old = vi.fn(),
      next = vi.fn()
    f.api.onSnapshot(old)
    f.receive({ version: 1, status: 'ready', sample: sample() })
    change()
    f.api.onSnapshot(next)
    expect(next).toHaveBeenLastCalledWith({ version: 1, status: 'unavailable' })
    expect(old).toHaveBeenLastCalledWith({ version: 1, status: 'unavailable' })
    f.dispose()
  })
  it('does not accept future receivedAt or give an old sample a new two-second lifetime', () => {
    const f = fixture(),
      listener = vi.fn()
    f.api.onSnapshot(listener)
    f.receive({ version: 1, status: 'ready', sample: { ...sample(), receivedAt: wall + 1 } })
    expect(listener).toHaveBeenLastCalledWith({ version: 1, status: 'unavailable' })
    f.receive({ version: 1, status: 'ready', sample: { ...sample(), receivedAt: wall - 1500 } })
    expect(listener.mock.lastCall?.[0].status).toBe('ready')
    vi.advanceTimersByTime(500)
    expect(listener).toHaveBeenLastCalledWith({ version: 1, status: 'unavailable' })
    f.dispose()
  })
  it('clears the cached ready value on finite expiry without a further Main event', () => {
    const f = fixture(),
      listener = vi.fn()
    f.api.onSnapshot(listener)
    f.receive({ version: 1, status: 'ready', sample: sample() })
    vi.advanceTimersByTime(2000)
    expect(listener).toHaveBeenLastCalledWith({ version: 1, status: 'unavailable' })
    f.dispose()
  })
  it('removes only its owned event listener, isolates subscriber exceptions and disposes once', () => {
    const f = fixture(),
      broken = vi.fn(() => {
        throw Error('renderer callback')
      }),
      good = vi.fn()
    f.api.onSnapshot(broken)
    f.api.onSnapshot(good)
    f.receive({ version: 1, status: 'hidden' })
    expect(good).toHaveBeenLastCalledWith({ version: 1, status: 'hidden' })
    expect(broken).toHaveBeenCalledOnce()
    f.dispose()
    f.dispose()
    expect(f.io.removeListener).toHaveBeenCalledOnce()
    expect(f.io.removeListener.mock.calls[0]).toEqual(f.io.on.mock.calls[0])
    expect(vi.getTimerCount()).toBe(0)
    f.receive({ version: 1, status: 'loading' })
    expect(good).toHaveBeenCalledTimes(2)
  })
})
