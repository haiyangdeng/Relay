import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GeoOriginRecord } from '../../../shared/relay/geo-origins'
import type { GeoScheduleTarget } from '../../../shared/relay/geo-scheduler'
import { geoScheduleArmRequest } from '../../../shared/relay/geo-scheduler'
import { createGeoSourceScheduler } from './geo-scheduler'
import {
  assertGeoAutomaticPermit,
  type GeoAutomaticOwner,
  type GeoAutomaticPermit
} from './automatic-permit'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-02T00:00:00.000Z'))
  const record: GeoOriginRecord = {
    info: {
      id: '11111111-1111-4111-8111-111111111111',
      revision: 'a'.repeat(64),
      originRevision: 'b'.repeat(64),
      descriptor: { name: 'Geo custom', kind: 'geosite-dat', behavior: null, selector: 'CUSTOM' },
      origin: 'https://fixture.invalid',
      proxyPort: 18191,
      hasPrivateHeaders: true,
      expectedSHA256: '',
      autoIntent: { requested: true, schedule: { kind: 'interval', minutes: 1 } },
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z'
    },
    definition: {
      descriptor: { name: 'Geo custom', kind: 'geosite-dat', behavior: null, selector: 'CUSTOM' },
      source: {
        kind: 'http',
        url: 'https://fixture.invalid/PRIVATE?token=SECRET',
        proxyPort: 18191,
        headers: { authorization: 'SECRET' }
      },
      expectedSHA256: '',
      autoIntent: { requested: true, schedule: { kind: 'interval', minutes: 1 } }
    }
  }
  let ownerLive = true
  const owner: GeoAutomaticOwner = {
      sessionId: '22222222-2222-4222-8222-222222222222',
      configurationRevision: 'c'.repeat(64),
      assertCurrent: vi.fn(() => {
        if (!ownerLive) throw new Error('lost held owner')
      })
    },
    adapters = {
      origins: {
        read: vi.fn(async (selection: { id: string; revision: string }) => {
          if (selection.id !== record.info.id || selection.revision !== record.info.revision)
            throw new Error('changed selected record')
          return structuredClone(record)
        }),
        readId: vi.fn(async (id: string) => {
          if (id !== record.info.id) throw new Error('unknown source')
          return structuredClone(record)
        })
      },
      canRun: vi.fn(() => true),
      owner: vi.fn(
        async (
          _id: string,
          _kind: unknown,
          _live: () => void
        ): Promise<GeoAutomaticOwner | undefined> => owner
      ),
      confirm: vi.fn(async () => false),
      run: vi.fn(
        async (
          input: GeoOriginRecord,
          permit: GeoAutomaticPermit,
          _target: GeoScheduleTarget
        ): Promise<{ status: 'updated' | 'failed' | 'uncertain'; warnings: string[] }> => {
          assertGeoAutomaticPermit(permit, input.info)
          return { status: 'updated', warnings: [] }
        }
      ),
      requestStop: vi.fn(async () => {})
    },
    scheduler = createGeoSourceScheduler(adapters),
    request = (target: GeoScheduleTarget = { kind: 'cache' }) => ({
      origin: { id: record.info.id, revision: record.info.revision },
      target
    })
  cleanup.push(() => scheduler.requestClose())
  return { record, owner, adapters, scheduler, request, loseOwner: () => (ownerLive = false) }
}

describe('Geo explicit memory-only grants on the existing source scheduler', () => {
  it('does zero constructor IO and never infers permission from persisted requested=true', async () => {
    const f = fixture()
    expect(f.scheduler.state()).toEqual({ pending: false, entries: [] })
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.origins.read).not.toHaveBeenCalled()
    expect(f.adapters.run).not.toHaveBeenCalled()
  })
  it('default-cancels and keeps private definitions out of the consent/state view', async () => {
    const f = fixture(),
      result = await f.scheduler.arm(f.request(), () => {})
    expect(result).toEqual({ status: 'cancelled', state: { pending: false, entries: [] } })
    expect(JSON.stringify(f.adapters.confirm.mock.calls)).not.toMatch(
      /SECRET|PRIVATE|authorization/u
    )
    expect(f.adapters.owner).not.toHaveBeenCalled()
    expect(f.record.definition.autoIntent.requested).toBe(true)
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.run).not.toHaveBeenCalled()
  })
  it('waits a full completion-based period, reuses head-only revisions, and never re-prompts each tick', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    expect((await f.scheduler.arm(f.request(), () => {})).status).toBe('armed')
    expect(f.scheduler.state()).toMatchObject({
      pending: false,
      entries: [{ enabled: true, target: { kind: 'cache' } }]
    })
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.adapters.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.adapters.run).toHaveBeenCalledTimes(1)
    f.record.info.revision = 'd'.repeat(64)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapters.run).toHaveBeenCalledTimes(2)
    expect(f.adapters.confirm).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.scheduler.state())).not.toMatch(
      /SECRET|PRIVATE|authorization|originRevision/u
    )
  })
  it('binds active permission to the exact current owner and cfg before asking Native consent', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    expect(
      (await f.scheduler.arm(f.request({ kind: 'tun', sessionId: f.owner.sessionId }), () => {}))
        .status
    ).toBe('armed')
    expect(f.adapters.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'tun', sessionId: f.owner.sessionId },
        configurationRevision: f.owner.configurationRevision
      })
    )
    f.loseOwner()
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapters.run).not.toHaveBeenCalled()
    expect(f.scheduler.state().entries[0].enabled).toBe(false)
  })
  it('reports missing positive active capability as unsupported without silently granting cache-only permission', async () => {
    const f = fixture()
    f.adapters.owner.mockResolvedValue(undefined)
    expect(
      (await f.scheduler.arm(f.request({ kind: 'tun', sessionId: f.owner.sessionId }), () => {}))
        .status
    ).toBe('unsupported')
    expect(f.adapters.confirm).not.toHaveBeenCalled()
    expect(f.scheduler.state().entries).toHaveLength(0)
  })
  it('revokes a lost active owner immediately while cache-only permission has no owner dependency', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    await f.scheduler.arm(f.request({ kind: 'tun', sessionId: f.owner.sessionId }), () => {})
    f.loseOwner()
    await f.scheduler.invalidateOwners()
    expect(f.scheduler.state().entries[0]).toMatchObject({
      enabled: false,
      target: { kind: 'tun', sessionId: f.owner.sessionId }
    })
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapters.run).not.toHaveBeenCalled()
    await f.scheduler.arm(f.request(), () => {})
    await f.scheduler.invalidateOwners()
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapters.run).toHaveBeenCalledOnce()
  })
  it('waits for the actual held Native dialog when closing and does not arm after it returns', async () => {
    const f = fixture(),
      gate = Promise.withResolvers<boolean>()
    f.adapters.confirm.mockReturnValueOnce(gate.promise)
    const pending = f.scheduler.arm(f.request(), () => {})
    await vi.waitFor(() => expect(f.adapters.confirm).toHaveBeenCalledOnce())
    let closed = false
    const close = f.scheduler.requestClose().then(() => (closed = true))
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(f.scheduler.isBusy()).toBe(true)
    gate.resolve(true)
    expect((await pending).status).toBe('cancelled')
    await close
    expect(f.scheduler.isBusy()).toBe(false)
    expect(f.scheduler.state().entries).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.run).not.toHaveBeenCalled()
  })
  it('stops an in-flight consent after silent UI loss without creating an automatic token', async () => {
    const f = fixture()
    let live = true
    f.adapters.confirm.mockImplementationOnce(async () => {
      live = false
      return true
    })
    expect(
      (
        await f.scheduler.arm(f.request(), () => {
          if (!live) throw new Error('scope')
        })
      ).status
    ).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.run).not.toHaveBeenCalled()
  })
  it('rechecks source CAS after consent and rejects an edit without requesting any download', async () => {
    const f = fixture()
    f.adapters.confirm.mockImplementationOnce(async () => {
      f.record.info.revision = 'e'.repeat(64)
      return true
    })
    expect((await f.scheduler.arm(f.request(), () => {})).status).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.run).not.toHaveBeenCalled()
  })
  it('keeps the stop barrier until the actual background operation finishes', async () => {
    const f = fixture(),
      gate = Promise.withResolvers<{ status: 'updated'; warnings: string[] }>()
    f.adapters.confirm.mockResolvedValue(true)
    f.adapters.run.mockImplementationOnce(async () => gate.promise)
    f.adapters.requestStop.mockImplementationOnce(async () => {
      await gate.promise
    })
    await f.scheduler.arm(f.request(), () => {})
    const tick = vi.advanceTimersByTimeAsync(60000)
    await vi.waitFor(() => expect(f.adapters.run).toHaveBeenCalledOnce())
    let stopped = false
    const stop = f.scheduler.disarm({ id: f.record.info.id }).then(() => (stopped = true))
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(f.scheduler.isBusy()).toBe(true)
    gate.resolve({ status: 'updated', warnings: [] })
    await stop
    await tick
    expect(f.scheduler.isBusy()).toBe(false)
    expect(f.scheduler.state().entries[0].enabled).toBe(false)
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.run).toHaveBeenCalledOnce()
  })
  it('retains periodic consent across normal failures but disables future work on uncertain publication', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    f.adapters.run
      .mockResolvedValueOnce({ status: 'failed', warnings: [] })
      .mockResolvedValueOnce({ status: 'uncertain', warnings: [] })
    await f.scheduler.arm(f.request(), () => {})
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.scheduler.state().entries[0].enabled).toBe(true)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.scheduler.state().entries[0]).toMatchObject({
      enabled: false,
      lastStatus: 'uncertain'
    })
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.adapters.run).toHaveBeenCalledTimes(2)
  })
  it('resumes at a full new period and does not replay missed wake-up intervals', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    await f.scheduler.arm(f.request(), () => {})
    await f.scheduler.suspend()
    await vi.advanceTimersByTimeAsync(3600000)
    f.scheduler.resume()
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.adapters.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.adapters.run).toHaveBeenCalledOnce()
  })
  it.each([
    { kind: 'cache', permission: true },
    { kind: 'tun', sessionId: 'PID:12' },
    { kind: 'cache', path: '/tmp/foo' }
  ])('rejects a public authority/path variant before IO %#', (target) => {
    const f = fixture()
    expect(() => geoScheduleArmRequest({ ...f.request(), target })).toThrow()
    expect(f.adapters.origins.read).not.toHaveBeenCalled()
  })
})
