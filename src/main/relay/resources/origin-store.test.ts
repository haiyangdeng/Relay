import { randomUUID } from 'crypto'
import * as files from 'fs/promises'
import { join, dirname } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { GeoOriginDefinition, GeoOriginRecord } from '../../../shared/relay/geo-origins'
import { geoResourceKinds } from '../../../shared/relay/geo-origins'
import { atomicWriteFile } from '../../utils/safeFile'
import { ResourceStore } from './store'
import {
  ResourceOriginStore,
  GeoOriginWriteUncertain,
  type GeoOriginHeadCommit
} from './origin-store'

const definition = (
  kind: GeoOriginDefinition['descriptor']['kind'] = 'geoip-dat'
): GeoOriginDefinition => ({
  descriptor: { name: 'Geo fixture', kind, behavior: null, selector: 'cn' },
  source: {
    kind: 'http',
    url: 'https://example.invalid/PRIVATE/path?token=SECRET',
    proxyPort: 17891,
    headers: { authorization: 'Bearer SECRET' }
  },
  expectedSHA256: '',
  autoIntent: { requested: false, schedule: { kind: 'manual' } }
})
const selected = (record: GeoOriginRecord) => ({
  id: record.info.id,
  revision: record.info.revision
})
async function fixture(
  run: (f: {
    home: string
    context: { home: string; stateRoot: string }
    cache: ResourceStore
    store: ResourceOriginStore
  }) => Promise<void>
): Promise<void> {
  const home = await files.realpath(await files.mkdtemp('/private/tmp/relay-geo-origins-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    cache = new ResourceStore(context),
    store = new ResourceOriginStore(context, cache, { now: () => 1000 })
  try {
    await run({ home, context, cache, store })
  } finally {
    vi.restoreAllMocks()
    await files.rm(home, { recursive: true, force: true })
  }
}
async function head(
  cache: ResourceStore,
  record: GeoOriginRecord,
  bytes = Buffer.from('private binary')
): Promise<GeoOriginHeadCommit> {
  const info = await cache.save(record.definition.descriptor, bytes),
    resource = { id: info.id, sha256: info.sha256 },
    read = await cache.read(resource)
  return {
    origin: selected(record),
    originRevision: record.info.originRevision,
    resource,
    resourceRevision: read.revision
  }
}
describe('Private Geo origin definitions and independently verified cache heads', () => {
  it('is inert when missing and lists no private path/query/headers or inferred grant', async () =>
    fixture(async (f) => {
      const read = vi.spyOn(f.cache, 'read')
      expect(await f.store.list()).toEqual({ origins: [], incomplete: 0, warnings: [] })
      await expect(files.lstat(f.context.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      const created = await f.store.save({ origin: null, definition: definition() })
      expect(created.info).toMatchObject({
        origin: 'https://example.invalid',
        hasPrivateHeaders: true,
        createdAt: '1970-01-01T00:00:01.000Z',
        autoIntent: { requested: false }
      })
      expect(JSON.stringify(await f.store.list())).not.toMatch(
        /SECRET|PRIVATE|authorization|token|https:\/\/example.invalid\//u
      )
      expect(read).not.toHaveBeenCalled()
      expect((await files.stat(f.store.path)).mode & 0o7777).toBe(0o600)
      expect((await files.stat(dirname(f.store.path))).mode & 0o7777).toBe(0o700)
      expect((await f.store.read(selected(created))).definition).toEqual(definition())
    }))
  it('keeps four Geo kinds unique and an existing kind immutable', async () =>
    fixture(async (f) => {
      const records: GeoOriginRecord[] = []
      for (const kind of geoResourceKinds)
        records.push(await f.store.save({ origin: null, definition: definition(kind) }))
      const before = await files.readFile(f.store.path)
      await expect(f.store.save({ origin: null, definition: definition() })).rejects.toThrow(
        '已有来源'
      )
      await expect(
        f.store.save({ origin: selected(records[0]), definition: definition('geosite-dat') })
      ).rejects.toThrow('不可更改')
      expect((await f.store.list()).origins).toHaveLength(4)
      expect(await files.readFile(f.store.path)).toEqual(before)
    }))
  it('lists a missing record under safe legacy0755 without changing directory metadata', async () =>
    fixture(async (f) => {
      const directory = dirname(f.store.path)
      await files.mkdir(directory, { recursive: true, mode: 0o700 })
      await files.chmod(directory, 0o755)
      const before = await files.stat(directory)
      expect(await f.store.list()).toEqual({ origins: [], incomplete: 0, warnings: [] })
      const after = await files.stat(directory)
      expect([after.dev, after.ino, after.mode, after.mtimeMs, after.ctimeMs]).toEqual([
        before.dev,
        before.ino,
        before.mode,
        before.mtimeMs,
        before.ctimeMs
      ])
      expect(after.mode & 0o7777).toBe(0o755)
      expect(await files.readdir(directory)).toEqual([])
    }))
  it('saves0600 and reads under legacy0755 without chmod of the shared parent', async () =>
    fixture(async (f) => {
      const directory = dirname(f.store.path)
      await files.mkdir(directory, { recursive: true, mode: 0o700 })
      await files.chmod(directory, 0o755)
      const created = await f.store.save({ origin: null, definition: definition() }),
        beforeRead = await files.stat(directory)
      expect(beforeRead.mode & 0o7777).toBe(0o755)
      expect((await files.stat(f.store.path)).mode & 0o7777).toBe(0o600)
      expect(await f.store.read(selected(created))).toEqual(created)
      expect(await f.store.readId(created.info.id)).toEqual(created)
      expect((await f.store.list()).origins).toEqual([created.info])
      const afterRead = await files.stat(directory)
      expect([
        afterRead.dev,
        afterRead.ino,
        afterRead.mode,
        afterRead.mtimeMs,
        afterRead.ctimeMs
      ]).toEqual([
        beforeRead.dev,
        beforeRead.ino,
        beforeRead.mode,
        beforeRead.mtimeMs,
        beforeRead.ctimeMs
      ])
    }))
  it.each(['writable', 'symlink'] as const)(
    'still refuses a %s Configuration without repairing it',
    async (kind) =>
      fixture(async (f) => {
        const directory = dirname(f.store.path)
        await files.mkdir(directory, { recursive: true, mode: 0o700 })
        if (kind === 'writable') await files.chmod(directory, 0o775)
        else {
          await files.rename(directory, directory + '-owned')
          await files.symlink(directory + '-owned', directory)
        }
        const before = await files.lstat(directory)
        expect((await f.store.list()).incomplete).toBe(1)
        await expect(f.store.save({ origin: null, definition: definition() })).rejects.toThrow()
        const after = await files.lstat(directory)
        expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode])
        await expect(files.lstat(f.store.path)).rejects.toMatchObject({ code: 'ENOENT' })
      })
  )
  it('reopens explicit private detail and returns detached copies without creating a permission', async () =>
    fixture(async (f) => {
      const def = definition()
      def.autoIntent = { requested: true, schedule: { kind: 'interval', minutes: 60 } }
      const created = await f.store.save({ origin: null, definition: def }),
        reopened = new ResourceOriginStore(f.context, f.cache)
      expect(await reopened.readId(created.info.id)).toEqual(created)
      created.definition.source.headers.authorization = 'changed'
      created.info.autoIntent.requested = false
      const actual = await reopened.readId(created.info.id)
      expect(actual.definition.source.headers.authorization).toBe('Bearer SECRET')
      expect(actual.info.autoIntent.requested).toBe(true)
      expect(Object.keys(actual.info)).not.toContain('grant')
      expect((await files.readdir(f.context.stateRoot)).sort()).toEqual(['Configuration'])
    }))
  it('changes origin revision on A to B to A even with a frozen clock, but no-op save does not write', async () =>
    fixture(async (f) => {
      const a = await f.store.save({ origin: null, definition: definition() }),
        before = await files.readFile(f.store.path)
      expect(await f.store.save({ origin: selected(a), definition: definition() })).toEqual(a)
      expect(await files.readFile(f.store.path)).toEqual(before)
      const bdef = definition()
      bdef.source.url = 'https://example.invalid/other'
      const b = await f.store.save({ origin: selected(a), definition: bdef }),
        again = await f.store.save({ origin: selected(b), definition: definition() })
      expect(
        new Set([a.info.originRevision, b.info.originRevision, again.info.originRevision]).size
      ).toBe(3)
      await expect(f.store.read(selected(a))).rejects.toThrow('修订已变化')
    }))
  it('moves head only after an actual immutable ResourceStore read and keeps origin revision stable', async () =>
    fixture(async (f) => {
      const created = await f.store.save({ origin: null, definition: definition() }),
        first = await head(f.cache, created),
        saved = await f.store.commitHead(first)
      expect(saved.info.originRevision).toBe(created.info.originRevision)
      expect(saved.info.revision).not.toBe(created.info.revision)
      expect(saved.info.head).toMatchObject({
        resource: first.resource,
        receipt: {
          version: 1,
          metadataSHA256: (await f.cache.read(first.resource)).metadataSHA256
        },
        originRevision: created.info.originRevision
      })
      expect(saved.info.head).not.toHaveProperty('resourceRevision')
      const second = await head(f.cache, saved, Buffer.from('new immutable')),
        next = await f.store.commitHead(second)
      expect(next.info.head?.resource).toEqual(second.resource)
      expect((await f.cache.read(first.resource)).bytes).toEqual(Buffer.from('private binary'))
      expect((await f.cache.read(first.resource)).revision).toBe(first.resourceRevision)
      expect((await f.cache.list()).resources).toHaveLength(2)
      expect((await f.cache.read(second.resource)).info.integrity).toBe('notChecked')
    }))
  it('reads a legacy root-bound head without rewriting or promoting it to a portable receipt', async () =>
    fixture(async (f) => {
      const created = await f.store.save({ origin: null, definition: definition() }),
        request = await head(f.cache, created)
      await f.store.commitHead(request)
      const document = JSON.parse(await files.readFile(f.store.path, 'utf8')),
        persisted = document.origins[0].head
      delete persisted.receipt
      persisted.resourceRevision = request.resourceRevision
      const bytes = JSON.stringify(document)
      await files.writeFile(f.store.path, bytes)
      const read = vi.spyOn(f.cache, 'read'),
        legacy = await f.store.readId(created.info.id)
      expect(legacy.info.head).toMatchObject({ resourceRevision: request.resourceRevision })
      expect(legacy.info.head).not.toHaveProperty('receipt')
      expect((await f.store.list()).incomplete).toBe(0)
      expect(read).not.toHaveBeenCalled()
      expect(await files.readFile(f.store.path, 'utf8')).toBe(bytes)
    }))
  it('refuses mixed, missing, unknown or malformed head receipts without mutation or legacy inference', async () =>
    fixture(async (f) => {
      const created = await f.store.save({ origin: null, definition: definition() }),
        request = await head(f.cache, created)
      await f.store.commitHead(request)
      const base = JSON.parse(await files.readFile(f.store.path, 'utf8')),
        original = base.origins[0].head,
        withoutReceipt = { ...original }
      delete withoutReceipt.receipt
      for (const invalid of [
        withoutReceipt,
        { ...original, resourceRevision: request.resourceRevision },
        { ...original, receipt: { version: 2, metadataSHA256: 'a'.repeat(64) } },
        { ...original, receipt: { version: 1, metadataSHA256: 'INVALID' } },
        { ...original, receipt: { version: 1, metadataSHA256: 'a'.repeat(64), grant: true } },
        { ...original, receipt: null }
      ]) {
        const bytes = JSON.stringify({
          ...base,
          origins: [{ ...base.origins[0], head: invalid }]
        })
        await files.writeFile(f.store.path, bytes)
        expect(await f.store.list()).toMatchObject({ origins: [], incomplete: 1 })
        await expect(f.store.readId(created.info.id)).rejects.toThrow()
        await expect(
          f.store.save({ origin: selected(created), definition: definition() })
        ).rejects.toThrow()
        expect(await files.readFile(f.store.path, 'utf8')).toBe(bytes)
      }
    }))
  it('preserves old cache head on definition changes and marks its old origin binding honestly', async () =>
    fixture(async (f) => {
      const created = await f.store.save({ origin: null, definition: definition() }),
        saved = await f.store.commitHead(await head(f.cache, created)),
        nextDef = definition()
      nextDef.source.proxyPort = 17892
      const next = await f.store.save({ origin: selected(saved), definition: nextDef })
      expect(next.info.head).toEqual(saved.info.head)
      expect(next.info.head?.originRevision).not.toBe(next.info.originRevision)
      const previousHead = saved.info.head
      if (!previousHead) throw new Error('Fixture cache receipt missing')
      expect((await f.cache.read(previousHead.resource)).bytes).toEqual(
        Buffer.from('private binary')
      )
    }))
  it('rejects stale origin/full-record/resource revisions and wrong descriptor without moving a head', async () =>
    fixture(async (f) => {
      const created = await f.store.save({ origin: null, definition: definition() }),
        request = await head(f.cache, created),
        before = await files.readFile(f.store.path)
      for (const invalid of [
        { ...request, origin: { ...request.origin, revision: '0'.repeat(64) } },
        { ...request, originRevision: '0'.repeat(64) },
        { ...request, resourceRevision: '0'.repeat(64) }
      ])
        await expect(f.store.commitHead(invalid)).rejects.toThrow()
      const other = await f.cache.save(definition('asn-mmdb').descriptor, Buffer.from('other')),
        resource = { id: other.id, sha256: other.sha256 },
        read = await f.cache.read(resource)
      await expect(
        f.store.commitHead({ ...request, resource, resourceRevision: read.revision })
      ).rejects.toThrow('类型或来源')
      expect(await files.readFile(f.store.path)).toEqual(before)
    }))
  it('enforces expected SHA and a real current binary body before publishing a head', async () =>
    fixture(async (f) => {
      const def = definition()
      def.expectedSHA256 = 'a'.repeat(64)
      const created = await f.store.save({ origin: null, definition: def }),
        request = await head(f.cache, created),
        before = await files.readFile(f.store.path)
      await expect(f.store.commitHead(request)).rejects.toThrow('类型或来源')
      const clean = await f.store.save({ origin: selected(created), definition: definition() }),
        valid = await head(f.cache, clean)
      await files.writeFile(
        join(f.cache.directory, valid.resource.id, 'resource.bin'),
        'changed binary'
      )
      await expect(f.store.commitHead(valid)).rejects.toThrow('摘要')
      expect((await f.store.readId(created.info.id)).info.head).toBeUndefined()
      expect(before.equals(await files.readFile(f.store.path))).toBe(false)
    }))
  it('serializes separate Store instances and rejects the losing stale draft after a held writer settles', async () =>
    fixture(async (f) => {
      const created = await f.store.save({ origin: null, definition: definition() }),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>(),
        write = vi.fn(async (...args: Parameters<typeof atomicWriteFile>) => {
          entered.resolve()
          await release.promise
          await atomicWriteFile(...args)
        }),
        first = new ResourceOriginStore(f.context, f.cache, { write }),
        second = new ResourceOriginStore(f.context, f.cache)
      const one = definition()
      one.source.proxyPort = 17892
      const saving = first.save({ origin: selected(created), definition: one })
      await entered.promise
      const two = definition()
      two.source.proxyPort = 17893
      const losing = second.save({ origin: selected(created), definition: two })
      release.resolve()
      await saving
      await expect(losing).rejects.toThrow('修订已变化')
      expect(write).toHaveBeenCalledTimes(1)
      expect((await second.readId(created.info.id)).definition.source.proxyPort).toBe(17892)
    }))
  it.each(['before', 'after'] as const)(
    'reports %s publication failure as uncertain without automatic retry or rollback',
    async (stage) =>
      fixture(async (f) => {
        const created = await f.store.save({ origin: null, definition: definition() }),
          before = await files.readFile(f.store.path),
          next = definition()
        next.source.proxyPort = 17892
        const write = vi.fn(async (...args: Parameters<typeof atomicWriteFile>) => {
            if (stage === 'after') await atomicWriteFile(...args)
            throw new Error('SECRET write fault')
          }),
          store = new ResourceOriginStore(f.context, f.cache, { write })
        await expect(
          store.save({ origin: selected(created), definition: next })
        ).rejects.toBeInstanceOf(GeoOriginWriteUncertain)
        expect(write).toHaveBeenCalledTimes(1)
        const actual = await f.store.readId(created.info.id)
        expect(actual.definition.source.proxyPort).toBe(stage === 'before' ? 17891 : 17892)
        expect((await files.readFile(f.store.path)).equals(before)).toBe(stage === 'before')
        if (stage === 'after')
          await expect(
            f.store.save({ origin: selected(created), definition: definition() })
          ).rejects.toThrow('修订已变化')
      })
  )
  it('refuses unknown/future/grant records without resetting or rewriting their original bytes', async () =>
    fixture(async (f) => {
      const created = await f.store.save({ origin: null, definition: definition() }),
        raw = await files.readFile(f.store.path, 'utf8'),
        base = JSON.parse(raw)
      for (const bad of [
        { ...base, version: 2 },
        { ...base, grant: true },
        { ...base, origins: [{ ...base.origins[0], permit: { active: true } }] },
        { ...base, origins: [...base.origins, { ...base.origins[0], id: randomUUID() }] }
      ]) {
        const bytes = JSON.stringify(bad)
        await files.writeFile(f.store.path, bytes)
        expect(await f.store.list()).toMatchObject({ origins: [], incomplete: 1 })
        await expect(
          f.store.save({ origin: selected(created), definition: definition() })
        ).rejects.toThrow()
        expect(await files.readFile(f.store.path, 'utf8')).toBe(bytes)
      }
    }))
  it('does not follow source file symlinks or accept hardlinks/unsafe modes', async () =>
    fixture(async (f) => {
      const created = await f.store.save({ origin: null, definition: definition() }),
        raw = await files.readFile(f.store.path),
        foreign = join(f.home, 'foreign.json')
      await files.writeFile(foreign, raw, { mode: 0o600 })
      await files.unlink(f.store.path)
      await files.symlink(foreign, f.store.path)
      await expect(f.store.readId(created.info.id)).rejects.toThrow()
      expect(await files.readFile(foreign)).toEqual(raw)
      await files.unlink(f.store.path)
      await files.link(foreign, f.store.path)
      await expect(f.store.readId(created.info.id)).rejects.toThrow()
      await files.unlink(f.store.path)
      await files.writeFile(f.store.path, raw, { mode: 0o644 })
      expect((await f.store.list()).incomplete).toBe(1)
      expect((await files.stat(f.store.path)).mode & 0o7777).toBe(0o644)
    }))
  it('rechecks source CAS after an awaited real cache read and preserves a foreign replacement', async () =>
    fixture(async (f) => {
      const created = await f.store.save({ origin: null, definition: definition() }),
        request = await head(f.cache, created),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>(),
        read = f.cache.read.bind(f.cache)
      vi.spyOn(f.cache, 'read').mockImplementation(async (...args) => {
        const value = await read(...args)
        entered.resolve()
        await release.promise
        return value
      })
      const committing = f.store.commitHead(request)
      await entered.promise
      const external = JSON.parse(await files.readFile(f.store.path, 'utf8'))
      external.origins[0].definition.source.proxyPort = 17892
      const bytes = JSON.stringify(external)
      await files.writeFile(f.store.path, bytes)
      release.resolve()
      await expect(committing).rejects.toThrow('修订已变化')
      expect(await files.readFile(f.store.path, 'utf8')).toBe(bytes)
      expect((await f.store.readId(created.info.id)).info.head).toBeUndefined()
    }))
  it('rejects a replaced Configuration inode after cache verification without writing the new directory', async () =>
    fixture(async (f) => {
      const created = await f.store.save({ origin: null, definition: definition() }),
        request = await head(f.cache, created),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>(),
        read = f.cache.read.bind(f.cache)
      vi.spyOn(f.cache, 'read').mockImplementation(async (...args) => {
        const value = await read(...args)
        entered.resolve()
        await release.promise
        return value
      })
      const committing = f.store.commitHead(request)
      await entered.promise
      const directory = dirname(f.store.path),
        old = directory + '-retained',
        bytes = await files.readFile(f.store.path)
      await files.rename(directory, old)
      await files.mkdir(directory, { mode: 0o700 })
      await files.writeFile(f.store.path, bytes, { mode: 0o600 })
      release.resolve()
      await expect(committing).rejects.toThrow('已变化')
      expect(await files.readFile(f.store.path)).toEqual(bytes)
      expect(await files.readFile(join(old, 'resource-origins.json'))).toEqual(bytes)
    }))
})
