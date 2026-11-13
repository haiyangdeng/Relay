import * as files from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type {
  GeoOriginDefinition,
  GeoOriginFetchPlan,
  GeoOriginRecord,
  GeoOriginSavePlan
} from '../../../shared/relay/geo-origins'
import type { ResourceCheckResult } from '../../../shared/relay/resources'
import type { ResourceValidationJob } from './check-definition'
import { ResourceStore } from './store'
import { ResourceOriginStore, GeoOriginWriteUncertain } from './origin-store'
import { createResourceOriginService } from './origin-service'
import { issueGeoAutomaticPermit, revokeGeoAutomaticPermit } from './automatic-permit'

const definition = (): GeoOriginDefinition => ({
  descriptor: { name: 'Geo fixture', kind: 'geoip-dat', behavior: null, selector: 'cn' },
  source: {
    kind: 'http',
    url: 'https://fixture.invalid/PRIVATE?token=SECRET',
    proxyPort: 17891,
    headers: { authorization: 'Bearer SECRET' }
  },
  expectedSHA256: '',
  autoIntent: { requested: false, schedule: { kind: 'manual' } }
})
const selection = (record: GeoOriginRecord) => ({
  id: record.info.id,
  revision: record.info.revision
})
async function setup() {
  const home = await files.realpath(await files.mkdtemp('/private/tmp/relay-geo-origin-service-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    cache = new ResourceStore(context),
    origins = new ResourceOriginStore(context, cache, { now: () => 1000 }),
    bytes = Buffer.from('synthetic Geo format; fake checker only'),
    releases: Array<() => void> = []
  let live = true,
    time = 1000
  const guard = (): void => {
      if (!live) throw new Error('SECRET private context')
    },
    adapters = {
      origins,
      cache,
      download: vi.fn(
        async (
          _url: string,
          _port: number,
          _signal: AbortSignal,
          _headers: Record<string, string>
        ) => Buffer.from(bytes)
      ),
      check: vi.fn(
        async (
          job: ResourceValidationJob,
          _signal?: AbortSignal,
          _live?: () => void
        ): Promise<ResourceCheckResult> => ({
          status: 'passed',
          resourceSHA256: job.sha256,
          coreVersion: 'fixture-core',
          warnings: ['SECRET ignored adapter warning']
        })
      ),
      confirmSave: vi.fn(async (_plan: GeoOriginSavePlan) => false),
      confirmFetch: vi.fn(async (_plan: GeoOriginFetchPlan) => false),
      onChanged: vi.fn(async (_id?: string) => {}),
      notify: vi.fn(() => {}),
      now: () => time
    },
    service = createResourceOriginService(adapters)
  return {
    home,
    context,
    cache,
    origins,
    adapters,
    service,
    guard,
    bytes,
    lose: () => {
      live = false
    },
    advance: () => {
      time += 60001
    },
    async create() {
      return origins.save({ origin: null, definition: definition() })
    },
    hold<T>(value: T) {
      const gate = Promise.withResolvers<T>()
      const release = () => gate.resolve(value)
      releases.push(release)
      return { promise: gate.promise, release }
    },
    async close() {
      for (const release of releases) release()
      await service.requestClose()
      vi.restoreAllMocks()
      await files.rm(home, { recursive: true, force: true })
    }
  }
}
async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>
): Promise<void> {
  const f = await setup()
  try {
    await run(f)
  } finally {
    await f.close()
  }
}

describe('Geo private automatic fetch authority', () => {
  const createAuto = async (f: Awaited<ReturnType<typeof setup>>) => {
    const value = definition()
    value.autoIntent = { requested: true, schedule: { kind: 'interval', minutes: 1 } }
    return f.origins.save({ origin: null, definition: value })
  }
  it('reuses the whole acquisition/check/head pipeline with a true private grant and does not re-prompt every period', async () =>
    fixture(async (f) => {
      const record = await createAuto(f),
        permit = issueGeoAutomaticPermit(record.info)
      const first = await f.service.fetch(selection(record), () => {}, permit)
      expect(first.status).toBe('updated')
      expect(f.adapters.confirmFetch).not.toHaveBeenCalled()
      const current = await f.origins.readId(record.info.id)
      expect((await f.service.fetch(selection(current), () => {}, permit)).status).toBe('updated')
      expect(f.adapters.check).toHaveBeenCalledTimes(2)
      expect((await f.cache.list()).resources).toHaveLength(1)
      expect(JSON.stringify(first)).not.toMatch(/SECRET|PRIVATE|authorization/u)
    }))
  it('rejects a serialized fake permit and a false saved intent before downloading', async () =>
    fixture(async (f) => {
      const record = await createAuto(f),
        permit = issueGeoAutomaticPermit(record.info)
      expect(
        (await f.service.fetch(selection(record), () => {}, structuredClone(permit))).status
      ).toBe('cancelled')
      expect(f.adapters.download).not.toHaveBeenCalled()
      const value = {
          ...record.definition,
          autoIntent: { requested: false, schedule: { kind: 'manual' as const } }
        },
        changed = await f.origins.save({ origin: selection(record), definition: value }),
        invalidPolicy = issueGeoAutomaticPermit(changed.info)
      expect((await f.service.fetch(selection(changed), () => {}, invalidPolicy)).status).toBe(
        'failed'
      )
      expect(f.adapters.download).not.toHaveBeenCalled()
    }))
  it('never lends a background cancellation ID to a manual state reader or hide handler', async () =>
    fixture(async (f) => {
      const record = await createAuto(f),
        permit = issueGeoAutomaticPermit(record.info),
        gate = f.hold(Buffer.from(f.bytes)),
        entered = Promise.withResolvers<void>()
      f.adapters.download.mockImplementationOnce(async () => {
        entered.resolve()
        return gate.promise
      })
      const pending = f.service.fetch(selection(record), () => {}, permit)
      await entered.promise
      expect(f.service.state()).toMatchObject({
        pending: true,
        automatic: true,
        originId: record.info.id
      })
      expect(f.service.state().operationId).toBeUndefined()
      expect(f.service.cancelInteractive()).toBe(false)
      f.lose()
      gate.release()
      expect((await pending).status).toBe('updated')
    }))
  it('withholds cache and head publication after its private grant disappears during a held transfer', async () =>
    fixture(async (f) => {
      const record = await createAuto(f),
        permit = issueGeoAutomaticPermit(record.info),
        gate = f.hold(Buffer.from(f.bytes)),
        entered = Promise.withResolvers<void>()
      f.adapters.download.mockImplementationOnce(async () => {
        entered.resolve()
        return gate.promise
      })
      const pending = f.service.fetch(selection(record), () => {}, permit)
      await entered.promise
      revokeGeoAutomaticPermit(permit)
      expect(f.service.isBusy()).toBe(true)
      gate.release()
      expect((await pending).status).toBe('cancelled')
      expect((await f.cache.list()).resources).toHaveLength(0)
      expect((await f.origins.readId(record.info.id)).info.head).toBeUndefined()
    }))
  it('drains an automatic transfer on close despite its cancellation ticket being private', async () =>
    fixture(async (f) => {
      const record = await createAuto(f),
        permit = issueGeoAutomaticPermit(record.info),
        gate = f.hold(Buffer.from(f.bytes)),
        entered = Promise.withResolvers<void>()
      let signal: AbortSignal | undefined
      f.adapters.download.mockImplementationOnce(async (_url, _port, s) => {
        signal = s
        entered.resolve()
        return gate.promise
      })
      const pending = f.service.fetch(selection(record), () => {}, permit)
      await entered.promise
      let closed = false
      const close = f.service.requestClose().then(() => (closed = true))
      expect(signal?.aborted).toBe(true)
      await Promise.resolve()
      expect(closed).toBe(false)
      gate.release()
      expect((await pending).status).toBe('cancelled')
      await close
      expect(f.service.isBusy()).toBe(false)
    }))
})

describe('Saved Geo origins explicit confirmation and existing ResourceService reuse', () => {
  it('mounts inertly and defaults definition confirmation to cancellation with only safe plan fields', async () =>
    fixture(async (f) => {
      expect(f.service.state()).toEqual({ pending: false, phase: 'idle' })
      expect(await f.service.list(f.guard)).toEqual({ origins: [], incomplete: 0, warnings: [] })
      await expect(files.lstat(f.context.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      const result = await f.service.save({ origin: null, definition: definition() }, f.guard)
      expect(result.status).toBe('cancelled')
      expect(JSON.stringify(f.adapters.confirmSave.mock.calls)).not.toMatch(
        /PRIVATE|SECRET|authorization|url/u
      )
      expect(f.adapters.download).not.toHaveBeenCalled()
      expect(f.adapters.check).not.toHaveBeenCalled()
      expect(f.adapters.onChanged).not.toHaveBeenCalled()
      await expect(files.lstat(f.origins.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }))
  it('saves only after separate Native acceptance, sanitizes mutation acknowledgement and exposes detail only on read', async () =>
    fixture(async (f) => {
      f.adapters.confirmSave.mockImplementationOnce(async (plan) => {
        plan.descriptor.name = 'Injected'
        plan.autoIntent.requested = true
        return true
      })
      const result = await f.service.save({ origin: null, definition: definition() }, f.guard)
      expect(result.status).toBe('saved')
      expect(result.origin?.descriptor.name).toBe('Geo fixture')
      expect(result.origin?.autoIntent.requested).toBe(false)
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|authorization|definition|url/u)
      if (!result.origin) throw new Error('Fixture origin missing')
      const selected = { id: result.origin.id, revision: result.origin.revision }
      expect((await f.service.read(selected, f.guard)).definition).toEqual(definition())
      expect(JSON.stringify(await f.service.list(f.guard))).not.toMatch(
        /PRIVATE|SECRET|authorization/u
      )
      expect(f.adapters.onChanged).toHaveBeenCalledWith(result.origin.id)
      expect(f.adapters.download).not.toHaveBeenCalled()
    }))
  it('rejects an expired save confirmation or stale definition before any write', async () =>
    fixture(async (f) => {
      const created = await f.create(),
        before = await files.readFile(f.origins.path)
      f.adapters.confirmSave.mockImplementationOnce(async () => {
        f.advance()
        return true
      })
      expect(
        (await f.service.save({ origin: selection(created), definition: definition() }, f.guard))
          .status
      ).toBe('failed')
      const updated = definition()
      updated.source.proxyPort = 17892
      await f.origins.save({ origin: selection(created), definition: updated })
      expect(
        (await f.service.save({ origin: selection(created), definition: definition() }, f.guard))
          .status
      ).toBe('failed')
      expect(f.adapters.confirmSave).toHaveBeenCalledTimes(1)
      expect(f.adapters.onChanged).not.toHaveBeenCalled()
      expect((await files.readFile(f.origins.path)).equals(before)).toBe(false)
    }))
  it('cancels held Native save with the exact operation id and retains busy until real settlement', async () =>
    fixture(async (f) => {
      const gate = f.hold(true),
        entered = Promise.withResolvers<void>()
      f.adapters.confirmSave.mockImplementationOnce(async () => {
        entered.resolve()
        return gate.promise
      })
      const pending = f.service.save({ origin: null, definition: definition() }, f.guard)
      await entered.promise
      const id = f.service.state().operationId
      if (!id) throw new Error('Fixture operation missing')
      expect(f.service.cancel('00000000-0000-4000-8000-000000000099')).toBe(false)
      expect(f.service.cancel(id)).toBe(true)
      let idle = false
      const drained = f.service.whenIdle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(idle).toBe(false)
      expect(f.service.isBusy()).toBe(true)
      gate.release()
      expect((await pending).status).toBe('cancelled')
      await drained
      expect((await f.origins.list()).origins).toEqual([])
      expect(f.adapters.onChanged).not.toHaveBeenCalled()
    }))
  it('awaits asynchronous source revocation and then rejects a lost UI scope without rolling back a saved record', async () =>
    fixture(async (f) => {
      const gate = f.hold(undefined),
        entered = Promise.withResolvers<void>()
      f.adapters.confirmSave.mockResolvedValue(true)
      f.adapters.onChanged.mockImplementationOnce(async () => {
        entered.resolve()
        await gate.promise
      })
      const pending = f.service.save({ origin: null, definition: definition() }, f.guard)
      await entered.promise
      expect(f.service.isBusy()).toBe(true)
      f.lose()
      gate.release()
      const result = await pending
      expect(result.status).toBe('uncertain')
      expect(result.origin).toBeUndefined()
      expect((await f.origins.list()).origins).toHaveLength(1)
      expect(JSON.stringify(result)).not.toContain('SECRET')
    }))
  it('invalidates all possible grants on an unknown create publication without returning private data or retrying', async () =>
    fixture(async (f) => {
      const original = f.origins.save.bind(f.origins)
      vi.spyOn(f.origins, 'save').mockImplementationOnce(async (raw) => {
        await original(raw)
        throw new GeoOriginWriteUncertain()
      })
      f.adapters.confirmSave.mockResolvedValue(true)
      const result = await f.service.save({ origin: null, definition: definition() }, f.guard)
      expect(result.status).toBe('uncertain')
      expect(result.origin).toBeUndefined()
      expect(f.adapters.onChanged).toHaveBeenCalledExactlyOnceWith(undefined)
      expect((await f.origins.list()).origins).toHaveLength(1)
    }))
  it('does not revoke origin grants for an acknowledged no-op definition save', async () =>
    fixture(async (f) => {
      const created = await f.create()
      f.adapters.confirmSave.mockResolvedValue(true)
      const result = await f.service.save(
        { origin: selection(created), definition: created.definition },
        f.guard
      )
      expect(result.status).toBe('saved')
      expect(result.origin).toEqual(created.info)
      expect(f.adapters.onChanged).not.toHaveBeenCalled()
    }))
  it('creates a new private ResourceService proof per fetch and clears its actual60s timer after cancellation', async () =>
    fixture(async (f) => {
      const created = await f.create(),
        timer = vi.spyOn(globalThis, 'setTimeout'),
        clear = vi.spyOn(globalThis, 'clearTimeout')
      for (let n = 0; n < 2; n++)
        expect((await f.service.fetch(selection(created), f.guard)).status).toBe('cancelled')
      const timers = timer.mock.calls
        .map((args, index) => ({ delay: args[1], handle: timer.mock.results[index].value }))
        .filter((v) => v.delay === 60000)
      expect(timers).toHaveLength(2)
      expect(timers[0].handle).not.toBe(timers[1].handle)
      for (const value of timers)
        expect(clear.mock.calls.some((args) => args[0] === value.handle)).toBe(true)
      expect(
        new Set(f.adapters.confirmFetch.mock.calls.map((args) => args[0].preparation.evidenceId))
          .size
      ).toBe(2)
      expect(f.adapters.download).not.toHaveBeenCalled()
      expect((await f.cache.list()).resources).toHaveLength(0)
      expect(JSON.stringify(f.adapters.confirmFetch.mock.calls)).not.toMatch(
        /PRIVATE|SECRET|authorization/u
      )
    }))
  it('uses saved proxy/headers through real acquire/check and publishes only a passed immutable cache head', async () =>
    fixture(async (f) => {
      const created = await f.create()
      f.adapters.confirmFetch.mockResolvedValue(true)
      const result = await f.service.fetch(selection(created), f.guard)
      expect(result.status).toBe('updated')
      expect(result.origin?.originRevision).toBe(created.info.originRevision)
      expect(result.origin?.head?.resource.id).toBe(result.resource?.id)
      expect(result.check?.status).toBe('passed')
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|authorization|definition|url/u)
      expect(f.adapters.download).toHaveBeenCalledWith(
        created.definition.source.url,
        17891,
        expect.any(AbortSignal),
        { authorization: 'Bearer SECRET' }
      )
      expect(f.adapters.check).toHaveBeenCalledTimes(1)
      expect(f.adapters.onChanged).not.toHaveBeenCalled()
      if (!result.resource) throw new Error('Fixture cache missing')
      expect(
        (await f.cache.read({ id: result.resource.id, sha256: result.resource.sha256 })).bytes
      ).toEqual(f.bytes)
      expect(result.resource.integrity).toBe('notChecked')
    }))
  it('keeps a cached body but not head when the existing checker does not pass', async () =>
    fixture(async (f) => {
      const created = await f.create()
      f.adapters.confirmFetch.mockResolvedValue(true)
      f.adapters.check.mockImplementationOnce(async (job) => ({
        status: 'notVerified',
        resourceSHA256: job.sha256,
        warnings: ['SECRET raw failure']
      }))
      const result = await f.service.fetch(selection(created), f.guard)
      expect(result.status).toBe('failed')
      expect(result.check?.status).toBe('notVerified')
      expect((await f.cache.list()).resources).toHaveLength(1)
      expect((await f.origins.readId(created.info.id)).info.head).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain('SECRET')
    }))
  it('reuses an actually verified identical snapshot while still running a new fixedCore check', async () =>
    fixture(async (f) => {
      const created = await f.create(),
        save = vi.spyOn(f.cache, 'save')
      f.adapters.confirmFetch.mockResolvedValue(true)
      const first = await f.service.fetch(selection(created), f.guard)
      if (!first.origin || !first.resource) throw new Error('Fixture head missing')
      const read = vi.spyOn(f.cache, 'read')
      const second = await f.service.fetch(
        { id: first.origin.id, revision: first.origin.revision },
        f.guard
      )
      expect(second.status).toBe('updated')
      expect(second.resource?.id).toBe(first.resource.id)
      expect(second.warnings.join('')).toContain('复用')
      expect(read).toHaveBeenCalledWith({ id: first.resource.id, sha256: first.resource.sha256 })
      expect(save).toHaveBeenCalledTimes(1)
      expect(f.adapters.check).toHaveBeenCalledTimes(2)
      expect((await f.cache.list()).resources).toHaveLength(1)
    }))
  it('can reuse identical verified content after URL and headers changed, without reviving the old origin revision', async () =>
    fixture(async (f) => {
      const created = await f.create(),
        save = vi.spyOn(f.cache, 'save')
      f.adapters.confirmFetch.mockResolvedValue(true)
      const first = await f.service.fetch(selection(created), f.guard)
      if (!first.origin || !first.resource) throw new Error('Fixture head missing')
      const changed = definition()
      changed.source.url = 'https://fixture.invalid/NEW_PRIVATE?token=NEW_SECRET'
      changed.source.headers.authorization = 'Bearer NEW_SECRET'
      const edited = await f.origins.save({
        origin: { id: first.origin.id, revision: first.origin.revision },
        definition: changed
      })
      const second = await f.service.fetch(selection(edited), f.guard)
      expect(second.status).toBe('updated')
      expect(second.resource?.id).toBe(first.resource.id)
      expect(second.origin?.head?.originRevision).toBe(edited.info.originRevision)
      expect(second.origin?.originRevision).not.toBe(first.origin.originRevision)
      expect(save).toHaveBeenCalledTimes(1)
      expect(f.adapters.check).toHaveBeenCalledTimes(2)
      expect(f.adapters.download).toHaveBeenLastCalledWith(
        changed.source.url,
        17891,
        expect.any(AbortSignal),
        changed.source.headers
      )
    }))
  it('reuses a cross-HOME copied portable snapshot only after a full read and another fixed checker pass', async () =>
    fixture(async (f) => {
      const created = await f.create()
      f.adapters.confirmFetch.mockResolvedValue(true)
      const first = await f.service.fetch(selection(created), f.guard)
      if (!first.origin?.head?.receipt || !first.resource)
        throw new Error('Fixture receipt missing')
      const home = await files.realpath(
          await files.mkdtemp('/private/tmp/relay-geo-service-copy-')
        ),
        context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
      let service: ReturnType<typeof createResourceOriginService> | undefined
      try {
        await files.cp(f.context.stateRoot, context.stateRoot, {
          recursive: true,
          errorOnExist: true
        })
        const cache = new ResourceStore(context),
          origins = new ResourceOriginStore(context, cache),
          original = await f.cache.read(first.origin.head.resource),
          restored = await origins.readId(first.origin.id),
          copied = await cache.read(first.origin.head.resource),
          save = vi.spyOn(cache, 'save')
        expect(copied.revision).not.toBe(original.revision)
        expect(copied.metadataSHA256).toBe(original.metadataSHA256)
        service = createResourceOriginService({ ...f.adapters, cache, origins })
        const result = await service.fetch(selection(restored), f.guard)
        expect(result.status).toBe('updated')
        expect(result.resource?.id).toBe(first.resource.id)
        expect(result.warnings.join('')).toContain('复用')
        expect(save).not.toHaveBeenCalled()
        expect(f.adapters.check).toHaveBeenCalledTimes(2)
        expect((await cache.list()).resources).toHaveLength(1)
      } finally {
        await service?.requestClose()
        await files.rm(home, { recursive: true, force: true })
      }
    }))
  it.each(['name', 'selector'] as const)(
    'keeps identical body with changed %s in a new metadata snapshot',
    async (field) =>
      fixture(async (f) => {
        const created = await f.create()
        f.adapters.confirmFetch.mockResolvedValue(true)
        const first = await f.service.fetch(selection(created), f.guard)
        if (!first.origin || !first.resource) throw new Error('Fixture head missing')
        const changed = definition()
        changed.descriptor[field] = field === 'name' ? 'New public name' : 'us'
        const edited = await f.origins.save({
          origin: { id: first.origin.id, revision: first.origin.revision },
          definition: changed
        })
        const second = await f.service.fetch(selection(edited), f.guard)
        expect(second.status).toBe('updated')
        expect(second.resource?.sha256).toBe(first.resource.sha256)
        expect(second.resource?.id).not.toBe(first.resource.id)
        expect(second.resource?.[field]).toBe(changed.descriptor[field])
        expect((await f.cache.list()).resources).toHaveLength(2)
        expect(f.adapters.check).toHaveBeenCalledTimes(2)
        expect(
          (await f.cache.read({ id: first.resource.id, sha256: first.resource.sha256 })).info[field]
        ).toBe(created.definition.descriptor[field])
      })
  )
  it.each(['body', 'metadata', 'metadata-format'] as const)(
    'does not hide a same-SHA old head %s failure with a fresh snapshot',
    async (kind) =>
      fixture(async (f) => {
        const created = await f.create()
        f.adapters.confirmFetch.mockResolvedValue(true)
        const first = await f.service.fetch(selection(created), f.guard)
        if (!first.origin || !first.resource) throw new Error('Fixture head missing')
        const before = await files.readFile(f.origins.path),
          root = join(f.cache.directory, first.resource.id)
        if (kind === 'body')
          await files.writeFile(join(root, 'resource.bin'), Buffer.alloc(f.bytes.length, 0x78))
        else if (kind === 'metadata-format') {
          const path = join(root, 'metadata.json'),
            before = await files.readFile(path, 'utf8')
          await files.writeFile(path, before + '\n')
        } else {
          const path = join(root, 'metadata.json'),
            value = JSON.parse(await files.readFile(path, 'utf8'))
          value.createdAt = new Date(Date.parse(value.createdAt) + 1).toISOString()
          await files.writeFile(path, JSON.stringify(value))
        }
        const save = vi.spyOn(f.cache, 'save')
        const second = await f.service.fetch(
          { id: first.origin.id, revision: first.origin.revision },
          f.guard
        )
        expect(['failed', 'uncertain']).toContain(second.status)
        expect(save).not.toHaveBeenCalled()
        expect(f.adapters.check).toHaveBeenCalledTimes(1)
        expect(await files.readFile(f.origins.path)).toEqual(before)
        expect((await f.cache.list()).resources.length).toBeLessThanOrEqual(1)
      })
  )
  it('rejects expected-SHA failure before the existing cache save or checker', async () =>
    fixture(async (f) => {
      const def = definition()
      def.expectedSHA256 = '0'.repeat(64)
      const created = await f.origins.save({ origin: null, definition: def })
      f.adapters.confirmFetch.mockResolvedValue(true)
      expect((await f.service.fetch(selection(created), f.guard)).status).toBe('failed')
      expect((await f.cache.list()).resources).toHaveLength(0)
      expect(f.adapters.check).not.toHaveBeenCalled()
    }))
  it('rejects a source edit across Native await with zero download and no implicit reconfirmation', async () =>
    fixture(async (f) => {
      const created = await f.create(),
        gate = f.hold(true),
        entered = Promise.withResolvers<void>()
      f.adapters.confirmFetch.mockImplementationOnce(async () => {
        entered.resolve()
        return gate.promise
      })
      const pending = f.service.fetch(selection(created), f.guard)
      await entered.promise
      const changed = definition()
      changed.source.proxyPort = 17892
      await f.origins.save({ origin: selection(created), definition: changed })
      gate.release()
      expect((await pending).status).toBe('failed')
      expect(f.adapters.download).not.toHaveBeenCalled()
      expect(f.adapters.confirmFetch).toHaveBeenCalledTimes(1)
    }))
  it('aborts a held download without early busy release, cache write or automatic retry', async () =>
    fixture(async (f) => {
      const created = await f.create(),
        gate = f.hold(Buffer.from(f.bytes)),
        entered = Promise.withResolvers<void>()
      let signal: AbortSignal | undefined
      f.adapters.confirmFetch.mockResolvedValue(true)
      f.adapters.download.mockImplementationOnce(async (_u, _p, s) => {
        signal = s
        entered.resolve()
        return gate.promise
      })
      const pending = f.service.fetch(selection(created), f.guard)
      await entered.promise
      const close = f.service.requestClose()
      expect(signal?.aborted).toBe(true)
      expect(f.service.isBusy()).toBe(true)
      gate.release()
      expect((await pending).status).toBe('cancelled')
      await close
      expect((await f.cache.list()).resources).toHaveLength(0)
      expect(f.adapters.download).toHaveBeenCalledTimes(1)
    }))
  it('does not move head after context loss during a held check, while retaining the admitted immutable cache', async () =>
    fixture(async (f) => {
      const created = await f.create(),
        gate = f.hold<ResourceCheckResult>({
          status: 'passed',
          resourceSHA256: '0'.repeat(64),
          warnings: []
        }),
        entered = Promise.withResolvers<void>()
      f.adapters.confirmFetch.mockResolvedValue(true)
      f.adapters.check.mockImplementationOnce(async (job) => {
        entered.resolve()
        const result = await gate.promise
        return { ...result, resourceSHA256: job.sha256 }
      })
      const pending = f.service.fetch(selection(created), f.guard)
      await entered.promise
      f.lose()
      expect(f.service.isBusy()).toBe(true)
      gate.release()
      const result = await pending
      expect(result.status).toBe('uncertain')
      expect(result.origin).toBeUndefined()
      expect((await f.cache.list()).resources).toHaveLength(1)
      expect((await f.origins.readId(created.info.id)).info.head).toBeUndefined()
    }))
  it('does not roll back a head transaction already entered when its UI context is lost', async () =>
    fixture(async (f) => {
      const created = await f.create(),
        gate = f.hold(undefined),
        entered = Promise.withResolvers<void>(),
        commit = f.origins.commitHead.bind(f.origins)
      f.adapters.confirmFetch.mockResolvedValue(true)
      vi.spyOn(f.origins, 'commitHead').mockImplementationOnce(async (raw) => {
        const result = await commit(raw)
        entered.resolve()
        await gate.promise
        return result
      })
      const pending = f.service.fetch(selection(created), f.guard)
      await entered.promise
      f.lose()
      gate.release()
      const result = await pending
      expect(result.status).toBe('uncertain')
      expect(result.origin).toBeUndefined()
      expect((await f.origins.readId(created.info.id)).info.head).toBeDefined()
      expect(f.adapters.onChanged).not.toHaveBeenCalled()
    }))
  it('keeps cancellation anchor through end notification and rechecks before publishing a completed save', async () =>
    fixture(async (f) => {
      f.adapters.confirmSave.mockResolvedValue(true)
      let id: string | undefined
      const cancelled: boolean[] = []
      f.adapters.notify.mockImplementation(() => {
        const state = f.service.state()
        if (state.operationId) id = state.operationId
        if (!state.pending && id) cancelled.push(f.service.cancel(id))
      })
      const result = await f.service.save({ origin: null, definition: definition() }, f.guard)
      expect(result.status).toBe('uncertain')
      expect(result.origin).toBeUndefined()
      expect((await f.origins.list()).origins).toHaveLength(1)
      expect(cancelled[0]).toBe(true)
      f.adapters.notify.mockReset()
      expect((await f.service.list(f.guard)).origins).toHaveLength(1)
    }))
  it('rejects completed read data after end observer invalidation and does not expose guard errors', async () =>
    fixture(async (f) => {
      const created = await f.create()
      f.adapters.notify.mockImplementation(() => {
        if (!f.service.state().pending) f.lose()
      })
      await expect(f.service.read(selection(created), f.guard)).rejects.toThrow('未完整确认')
      expect(f.service.isBusy()).toBe(false)
      await expect(f.service.list(f.guard)).rejects.not.toThrow('SECRET')
    }))
})

it('independent cancellation latch prevents definition admission from inside its final context callback', async () =>
  fixture(async (f) => {
    const save = vi.spyOn(f.origins, 'save')
    f.adapters.confirmSave.mockResolvedValue(true)
    const guard = () => {
      f.guard()
      if (f.service.state().phase === 'savingDefinition')
        f.service.cancel(f.service.state().operationId)
    }
    const result = await f.service.save({ origin: null, definition: definition() }, guard)
    expect(save).not.toHaveBeenCalled()
    expect(result.status).toBe('cancelled')
  }))
it('independent cancellation latch prevents download admission from inside its final context callback', async () =>
  fixture(async (f) => {
    const record = await f.create()
    f.adapters.confirmFetch.mockResolvedValue(true)
    const guard = () => {
      f.guard()
      if (f.service.state().phase === 'acquiring') f.service.cancel(f.service.state().operationId)
    }
    const result = await f.service.fetch(selection(record), guard)
    expect(f.adapters.download).not.toHaveBeenCalled()
    expect(result.status).toBe('cancelled')
  }))

it('passes a private operation-bound guard through the deferred checker rather than only checking its entry', async () =>
  fixture(async (f) => {
    const record = await f.create()
    f.adapters.confirmFetch.mockResolvedValue(true)
    f.adapters.check.mockImplementationOnce(async (job, _signal, live) => {
      expect(typeof live).toBe('function')
      f.service.cancel(f.service.state().operationId)
      expect(live).toThrow('范围已失效')
      return { status: 'passed', resourceSHA256: job.sha256, warnings: [] }
    })
    expect((await f.service.fetch(selection(record), f.guard)).status).toBe('uncertain')
    expect((await f.origins.readId(record.info.id)).info.head).toBeUndefined()
  }))
