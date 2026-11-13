import { mkdtemp, realpath, rm } from 'fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VariantStore } from './variant-store'
import { createVariantService } from './variant-service'
import { trustedCoreVariants } from './trusted-variants'

const homes: string[] = []
async function fixture() {
  const stateRoot = await realpath(await mkdtemp('/private/tmp/relay-variant-service-'))
  homes.push(stateRoot)
  const store = new VariantStore({ stateRoot })
  const request = {
    kind: 'smart',
    sourcePath: '/selected/private-model',
    version: 'fixture',
    sha256: 'a'.repeat(64),
    size: 4096
  }
  return { store, request }
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('Variant operation gates and preparation ownership', () => {
  it('returns metadata without source paths and separates Smart support from unavailable downloads', async () => {
    const f = await fixture(),
      service = createVariantService({ store: f.store })
    const preparation = await service.prepareAcquire(f.request)
    expect(preparation).not.toHaveProperty('sourcePath')
    expect(preparation).toMatchObject({ kind: 'smart', version: 'fixture', size: 4096 })
    expect(await service.state()).toMatchObject({
      pending: false,
      trustedCoreVersion: 'v1.19.33',
      smartRuntimeSupported: true,
      networkDownloadSupported: false
    })
  })
  it('consumes expired or cancelled preparations without performing a copy', async () => {
    const f = await fixture(),
      acquire = vi.spyOn(f.store, 'acquire'),
      confirm = vi.fn(async () => false)
    let now = 1000
    const service = createVariantService({
      store: f.store,
      now: () => now,
      confirmAcquire: confirm
    })
    await service.prepareAcquire(f.request)
    now += 60001
    await expect(service.executeAcquire()).rejects.toThrow('重新准备')
    expect(confirm).not.toHaveBeenCalled()
    await service.prepareAcquire(f.request)
    expect(await service.executeAcquire()).toEqual({ status: 'cancelled' })
    await expect(service.executeAcquire()).rejects.toThrow('重新准备')
    expect(acquire).not.toHaveBeenCalled()
  })
  it('offers exact Stable, Alpha and Smart pins for both architectures without exposing archive or path metadata', async () => {
    const f = await fixture(),
      service = createVariantService({ store: f.store }),
      state = await service.state()
    const pins = trustedCoreVariants()
    expect(state.trustedCoreImports).toHaveLength(pins.length)
    for (const pin of pins) {
      const metadata = state.trustedCoreImports.find(
        (item) => item.version === pin.version && item.architecture === pin.architecture
      )
      expect(metadata).toEqual({
        kind: 'core',
        version: pin.version,
        architecture: pin.architecture,
        sha256: pin.sha256,
        size: pin.size
      })
    }
    state.trustedCoreImports[0].sha256 = 'f'.repeat(64)
    expect((await service.state()).trustedCoreImports[0].sha256).toBe(pins[0].sha256)
    expect(state.trustedSmartImports).toHaveLength(3)
    for (const model of state.trustedSmartImports) {
      expect(model.kind).toBe('smart')
      expect(model).not.toHaveProperty('sourcePath')
      expect(model).not.toHaveProperty('url')
    }
  })
  it('refuses concurrent mutation and rechecks core idleness after a confirmation awaits', async () => {
    const f = await fixture(),
      acquire = vi.spyOn(f.store, 'acquire')
    let ready = true,
      finish: (value: boolean) => void = () => {
        throw new Error('missing resolver')
      }
    const service = createVariantService({
      store: f.store,
      ensureIdle: () => {
        if (!ready) throw new Error('owned core running')
      },
      confirmAcquire: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    })
    await service.prepareAcquire(f.request)
    const pending = service.executeAcquire()
    expect(service.isBusy()).toBe(true)
    expect((await service.state()).pending).toBe(true)
    await expect(service.restore('core')).rejects.toThrow('等待')
    const idle = service.whenIdle()
    ready = false
    finish(true)
    await expect(pending).rejects.toThrow('owned core running')
    await idle
    expect(acquire).not.toHaveBeenCalled()
    expect(service.isBusy()).toBe(false)
  })
  it('invalidates the previous plan when a new malformed prepare is attempted', async () => {
    const f = await fixture(),
      service = createVariantService({ store: f.store })
    await service.prepareAcquire(f.request)
    await expect(service.prepareAcquire({ ...f.request, unknown: true })).rejects.toThrow('字段')
    await expect(service.executeAcquire()).rejects.toThrow('重新准备')
  })
})

describe('Private P34 synchronous selection commit invalidation', () => {
  it('notifies successful selection while busy is still held, before idle waiters resume', async () => {
    const f = await fixture(),
      record = {
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'smart' as const,
        version: 'fixture',
        sha256: 'a'.repeat(64),
        size: 4096,
        acquiredAt: 1000
      }
    vi.spyOn(f.store, 'verify').mockResolvedValue(record)
    vi.spyOn(f.store, 'select').mockResolvedValue(record)
    const events: string[] = []
    const service = createVariantService({
      store: f.store,
      selectionChanged: () => {
        expect(service.isBusy()).toBe(true)
        events.push('invalidate')
      }
    })
    const flight = service.select({ id: record.id }),
      idle = service.whenIdle().then(() => events.push('idle'))
    await flight
    await idle
    expect(events).toEqual(['invalidate', 'idle'])
  })
  it('cancelled selection notifies nothing and never changes the store', async () => {
    const f = await fixture(),
      record = {
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'smart' as const,
        version: 'fixture',
        sha256: 'a'.repeat(64),
        size: 4096,
        acquiredAt: 1000
      }
    vi.spyOn(f.store, 'verify').mockResolvedValue(record)
    const select = vi.spyOn(f.store, 'select'),
      changed = vi.fn()
    const service = createVariantService({
      store: f.store,
      confirmSelect: async () => false,
      selectionChanged: changed
    })
    expect(await service.select({ id: record.id })).toEqual({ status: 'cancelled' })
    expect(changed).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })
  it.each(['core', 'smart'] as const)(
    'only positive restore of active %s revokes execution',
    async (kind) => {
      const f = await fixture(),
        id = '11111111-1111-4111-8111-111111111111',
        changed = vi.fn()
      vi.spyOn(f.store, 'list').mockResolvedValue({
        records: [],
        pinnedDefault: true,
        activeCoreId: kind === 'core' ? id : undefined,
        activeSmartId: kind === 'smart' ? id : undefined
      })
      vi.spyOn(f.store, 'restore').mockResolvedValue()
      const service = createVariantService({ store: f.store, selectionChanged: changed })
      await service.restore(kind)
      expect(changed).toHaveBeenCalledTimes(1)
    }
  )
  it('inactive remove/empty restore do not revoke while active remove does, all before busy release', async () => {
    const f = await fixture(),
      id = '11111111-1111-4111-8111-111111111111',
      record = {
        id,
        kind: 'smart' as const,
        version: 'fixture',
        sha256: 'a'.repeat(64),
        size: 4096,
        acquiredAt: 1000
      }
    const list = vi.spyOn(f.store, 'list').mockResolvedValue({
      records: [record],
      pinnedDefault: true,
      activeCoreId: undefined,
      activeSmartId: undefined
    })
    vi.spyOn(f.store, 'remove').mockResolvedValue()
    vi.spyOn(f.store, 'restore').mockResolvedValue()
    const changed = vi.fn(() => expect(service.isBusy()).toBe(true)),
      service = createVariantService({ store: f.store, selectionChanged: changed })
    await service.remove({ id })
    await service.restore('smart')
    expect(changed).not.toHaveBeenCalled()
    list.mockResolvedValue({
      records: [record],
      pinnedDefault: true,
      activeCoreId: undefined,
      activeSmartId: id
    })
    await service.remove({ id })
    expect(changed).toHaveBeenCalledTimes(1)
  })
  it('failed store commit never publishes a successful selection invalidation', async () => {
    const f = await fixture(),
      id = '11111111-1111-4111-8111-111111111111',
      record = {
        id,
        kind: 'smart' as const,
        version: 'fixture',
        sha256: 'a'.repeat(64),
        size: 4096,
        acquiredAt: 1000
      }
    vi.spyOn(f.store, 'verify').mockResolvedValue(record)
    vi.spyOn(f.store, 'select').mockRejectedValue(new Error('commit failed'))
    const changed = vi.fn(),
      service = createVariantService({ store: f.store, selectionChanged: changed })
    await expect(service.select({ id })).rejects.toThrow('commit failed')
    expect(changed).not.toHaveBeenCalled()
    expect(service.isBusy()).toBe(false)
  })
})
