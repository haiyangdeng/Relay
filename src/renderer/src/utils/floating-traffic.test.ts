import { describe, expect, it, vi } from 'vitest'
import {
  copyFloatingTrafficSample,
  parseFloatingTrafficSnapshot,
  type RelayFloatingTrafficSample,
  type RelayFloatingTrafficSnapshot
} from '../../../shared/relay/floating-traffic'
import * as calc from './calc'
import { formatFloatingTraffic } from './floating-traffic'

const sample = {
  up: 1024,
  down: 2 * 1024 * 1024,
  upTotal: 1000000,
  downTotal: 2000000,
  instanceId: '12345678-1234-1234-1234-123456789abc',
  configurationRevision: 'a'.repeat(64),
  receivedAt: 10000
}
const ready = (value: RelayFloatingTrafficSample = sample): RelayFloatingTrafficSnapshot => ({
  version: 1,
  status: 'ready',
  sample: value
})

describe('ordinary floating snapshot and mature rate formatting', () => {
  it('uses current byte rates instead of cumulative totals', () => {
    expect(formatFloatingTraffic(ready())).toEqual({ upload: '1.00 KB/s', download: '2.00 MB/s' })
  })
  it('preserves an actual zero sample as zero', () => {
    expect(formatFloatingTraffic(ready({ ...sample, up: 0, down: 0 }))).toEqual({
      upload: '0.00 B/s',
      download: '0.00 B/s'
    })
  })
  it.each(['hidden', 'loading', 'unavailable'] as const)(
    'does not format invented zero in %s state',
    (status) => {
      const spy = vi.spyOn(calc, 'calcTraffic')
      spy.mockClear()
      expect(formatFloatingTraffic({ version: 1, status })).toBeUndefined()
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
  )
  it('supports the safe numeric boundary through the existing formatter', () => {
    expect(formatFloatingTraffic(ready({ ...sample, up: Number.MAX_SAFE_INTEGER }))).toEqual({
      upload: '8.00 PB/s',
      download: '2.00 MB/s'
    })
  })
  it('returns a frozen copy of valid metadata', () => {
    const value = { ...sample }
    const result = parseFloatingTrafficSnapshot(ready(value))
    value.up = 7
    expect(result).toMatchObject({ status: 'ready', sample: { up: 1024 } })
    expect(Object.isFrozen(result)).toBe(true)
    if (result?.status === 'ready') expect(Object.isFrozen(result.sample)).toBe(true)
  })
  it.each(['hidden', 'loading', 'unavailable'] as const)(
    'accepts only the empty %s envelope',
    (status) => {
      expect(parseFloatingTrafficSnapshot({ version: 1, status })).toEqual({ version: 1, status })
      expect(parseFloatingTrafficSnapshot({ version: 1, status, sample })).toBeUndefined()
    }
  )
  it.each([
    undefined,
    null,
    [],
    { version: 2, status: 'ready', sample },
    { version: 1, status: 'unknown' },
    { version: 1, status: 'ready' },
    { version: 1, status: 'ready', sample, url: 'http://example.test' },
    { version: 1, status: 'ready', sample: { ...sample, path: '/cache' } },
    { version: 1, status: 'ready', sample: { ...sample, instanceId: 'other' } },
    { version: 1, status: 'ready', sample: { ...sample, configurationRevision: 'a'.repeat(63) } },
    { version: 1, status: 'ready', sample: { ...sample, up: '0' } },
    { version: 1, status: 'ready', sample: { ...sample, down: -1 } },
    { version: 1, status: 'ready', sample: { ...sample, upTotal: 1.5 } },
    { version: 1, status: 'ready', sample: { ...sample, downTotal: Number.MAX_SAFE_INTEGER + 1 } },
    { version: 1, status: 'ready', sample: { ...sample, receivedAt: Number.NaN } },
    { version: 1, status: 'ready', sample: { ...sample, receivedAt: -1 } }
  ])('rejects invalid or overbroad snapshot %#', (raw) => {
    expect(parseFloatingTrafficSnapshot(raw)).toBeUndefined()
  })
  it('rejects object capabilities and throwing property accessors', () => {
    expect(copyFloatingTrafficSample(Object.assign(new Date(), sample))).toBeUndefined()
    const raw = { ...sample }
    Object.defineProperty(raw, 'up', {
      enumerable: true,
      get: () => {
        throw new Error('not data')
      }
    })
    expect(copyFloatingTrafficSample(raw)).toBeUndefined()
    expect(
      parseFloatingTrafficSnapshot({ version: 1, status: 'ready', sample: raw })
    ).toBeUndefined()
  })
})

describe('explicit TUN sample value boundary', () => {
  const tun = {
    up: 1024,
    down: 0,
    upTotal: 1000000,
    downTotal: 2000000,
    receivedAt: 10000,
    kind: 'tun-managed' as const,
    sessionId: '11111111-1111-4111-8111-111111111111',
    evidenceSHA256: 'b'.repeat(64),
    runtimeConfigurationSHA256: 'c'.repeat(64)
  }
  it('copies only the TUN identity and formats its rates independently of totals', () => {
    const copy = copyFloatingTrafficSample(tun)
    expect(copy).toEqual(tun)
    expect(copy).not.toHaveProperty('instanceId')
    expect(Object.isFrozen(copy)).toBe(true)
    expect(formatFloatingTraffic(ready(tun))).toEqual({ upload: '1.00 KB/s', download: '0.00 B/s' })
  })
  it.each([
    { ...tun, instanceId: sample.instanceId },
    { ...tun, configurationRevision: 'a'.repeat(64) },
    { ...tun, kind: 'ordinary' },
    { ...tun, kind: undefined },
    { ...tun, sessionId: 'not-owned' },
    { ...tun, evidenceSHA256: 'b'.repeat(63) },
    { ...tun, runtimeConfigurationSHA256: 'C'.repeat(64) },
    { ...tun, up: Number.MAX_SAFE_INTEGER + 1 },
    { ...tun, down: -1 },
    { ...tun, receivedAt: Number.NaN },
    { ...tun, path: '/api.sock' }
  ])('rejects mixed identities or invalid counters %#', (value) => {
    expect(copyFloatingTrafficSample(value)).toBeUndefined()
    expect(
      parseFloatingTrafficSnapshot({ version: 1, status: 'ready', sample: value })
    ).toBeUndefined()
  })
})
