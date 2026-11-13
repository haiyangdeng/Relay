import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { GeoOriginDefinition, GeoOriginRecord } from '../../../shared/relay/geo-origins'
import { bindRuntimeResources } from '../configuration/bindings'
import { collectRuntimeDependencies } from '../configuration/dependencies'
import { isolatedCoreConfiguration } from '../core/configuration'
import { RelayBackupStore } from '../backup/store'
import { readBackupArchive } from '../backup/archive'
import type { RelayStateContext } from '../context'
import { ResourceOriginStore } from './origin-store'
import { ResourceStore } from './store'
import { readGeoOriginCandidate, readDefaultGeoBinding } from './origin-candidate'

const definition = (): GeoOriginDefinition => ({
    descriptor: { name: 'Geo candidate', kind: 'geosite-dat', behavior: null, selector: 'CUSTOM' },
    source: {
      kind: 'http',
      url: 'https://fixture.invalid/PRIVATE?token=SECRET',
      proxyPort: 18191,
      headers: { authorization: 'Bearer SECRET' }
    },
    expectedSHA256: '',
    autoIntent: { requested: false, schedule: { kind: 'manual' } }
  }),
  select = (record: GeoOriginRecord) => ({ id: record.info.id, revision: record.info.revision })
async function fixture(
  run: (f: {
    origins: ResourceOriginStore
    cache: ResourceStore
    record: GeoOriginRecord
    context: RelayStateContext
    promote(bytes?: Buffer): Promise<GeoOriginRecord>
  }) => Promise<void>
) {
  const home = await realpath(await mkdtemp('/private/tmp/relay-geo-candidate-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    cache = new ResourceStore(context),
    origins = new ResourceOriginStore(context, cache),
    record = await origins.save({ origin: null, definition: definition() })
  try {
    await run({
      origins,
      cache,
      record,
      context,
      async promote(bytes = Buffer.from('Geo candidate body')) {
        const current = await origins.readId(record.info.id),
          info = await cache.save(current.definition.descriptor, bytes),
          resource = { id: info.id, sha256: info.sha256 },
          cached = await cache.read(resource)
        return origins.commitHead({
          origin: select(current),
          originRevision: current.info.originRevision,
          resource,
          resourceRevision: cached.revision
        })
      }
    })
  } finally {
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
  }
}

// Replay exact decoded backup files into a second owned HOME. This checks the
// portable record contract, not the separate Native transaction/rollback.
async function copiedBackup(
  context: RelayStateContext,
  run: (copy: { origins: ResourceOriginStore; cache: ResourceStore }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-geo-candidate-copy-')),
    target = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  try {
    const archive = await new RelayBackupStore(context).archive(),
      { snapshot } = readBackupArchive(archive.bytes)
    for (const path of snapshot.directories)
      await mkdir(join(target.stateRoot, path), { recursive: true, mode: 0o700 })
    for (const entry of snapshot.entries)
      await writeFile(join(target.stateRoot, entry.path), entry.bytes, {
        flag: 'wx',
        mode: entry.mode
      })
    const cache = new ResourceStore(target)
    await run({ cache, origins: new ResourceOriginStore(target, cache) })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('Geo source head to private runtime candidate', () => {
  it('uses an exact portable metadata receipt after cross-HOME backup replay and pins the current dynamic revision', async () =>
    fixture(async (f) => {
      const origin = await f.promote(),
        head = origin.info.head
      if (!head?.receipt) throw new Error('Missing portable fixture receipt')
      const original = await f.cache.read(head.resource)
      expect(head.receipt.metadataSHA256).toBe(original.metadataSHA256)
      expect(head).not.toHaveProperty('resourceRevision')
      await copiedBackup(f.context, async (copy) => {
        const restored = await copy.origins.readId(origin.info.id),
          cached = await copy.cache.read(head.resource),
          binding = await readDefaultGeoBinding(copy.origins, copy.cache, 'geosite-dat'),
          candidate = await readGeoOriginCandidate(copy.origins, copy.cache, select(restored))
        expect(restored).toEqual(origin)
        expect(cached.bytes).toEqual(original.bytes)
        expect(cached.metadataSHA256).toBe(original.metadataSHA256)
        expect(cached.revision).not.toBe(original.revision)
        expect(binding?.revision).toBe(cached.revision)
        await candidate.recheck()
        const actual = copy.cache.read.bind(copy.cache)
        vi.spyOn(copy.cache, 'read').mockImplementationOnce(async (...args) => ({
          ...(await actual(...args)),
          revision: '0'.repeat(64)
        }))
        await expect(candidate.recheck()).rejects.toThrow('元数据')
      })
    }))
  it('retains strict path-bound legacy heads without interpreting them as portable receipts', async () =>
    fixture(async (f) => {
      const origin = await f.promote(),
        head = origin.info.head
      if (!head) throw new Error('Missing fixture head')
      const cached = await f.cache.read(head.resource),
        raw = JSON.parse(await readFile(f.origins.path, 'utf8'))
      raw.origins[0].head = {
        resource: head.resource,
        resourceRevision: cached.revision,
        originRevision: head.originRevision,
        acquiredAt: head.acquiredAt
      }
      await writeFile(f.origins.path, JSON.stringify(raw))
      const legacy = await f.origins.readId(origin.info.id)
      await (await readGeoOriginCandidate(f.origins, f.cache, select(legacy))).recheck()
      expect((await readDefaultGeoBinding(f.origins, f.cache, 'geosite-dat'))?.revision).toBe(
        cached.revision
      )
      await copiedBackup(f.context, async (copy) => {
        const restored = await copy.origins.readId(legacy.info.id)
        await expect(
          readGeoOriginCandidate(copy.origins, copy.cache, select(restored))
        ).rejects.toThrow('元数据')
        await expect(
          readDefaultGeoBinding(copy.origins, copy.cache, 'geosite-dat')
        ).rejects.toThrow('元数据')
        expect((await copy.origins.readId(legacy.info.id)).info.head).toEqual(legacy.info.head)
      })
    }))
  it('rejects a metadata-byte-only change without repairing a portable head or the cache', async () =>
    fixture(async (f) => {
      const origin = await f.promote(),
        head = origin.info.head
      if (!head?.receipt) throw new Error('Missing portable fixture head')
      const candidate = await readGeoOriginCandidate(f.origins, f.cache, select(origin)),
        path = join(f.cache.directory, head.resource.id, 'metadata.json'),
        before = await readFile(path, 'utf8'),
        changed = before + '\n'
      await writeFile(path, changed)
      expect(JSON.parse(changed)).toEqual(JSON.parse(before))
      await expect(candidate.recheck()).rejects.toThrow('元数据')
      await expect(readDefaultGeoBinding(f.origins, f.cache, 'geosite-dat')).rejects.toThrow(
        '元数据'
      )
      expect(await readFile(path, 'utf8')).toBe(changed)
      expect((await f.origins.readId(origin.info.id)).info.head).toEqual(head)
    }))
  it('materializes the latest unpinned source head into a new immutable candidate and invalidates a stale default proof', async () =>
    fixture(async (f) => {
      const first = await f.promote(),
        source = JSON.stringify({
          ...isolatedCoreConfiguration(),
          rules: ['GEOSITE,CUSTOM,REJECT', 'MATCH,REJECT']
        }),
        adapters = {
          resources: f.cache,
          providers: {
            read: async () => {
              throw new Error('unexpected provider')
            }
          },
          defaultGeoResource: (kind: Parameters<typeof readDefaultGeoBinding>[2]) =>
            readDefaultGeoBinding(f.origins, f.cache, kind)
        },
        old = await bindRuntimeResources(source, [], adapters)
      expect(old.unresolved).toEqual([])
      expect(old.assets).toMatchObject([
        { path: 'GeoSite.dat', sha256: first.info.head?.resource.sha256 }
      ])
      await old.recheck()
      const second = await f.promote(Buffer.from('next checked Geo body')),
        next = await bindRuntimeResources(source, [], adapters)
      expect(next.assets[0].sha256).toBe(second.info.head?.resource.sha256)
      expect(next.sha256).not.toBe(old.sha256)
      expect(old.assets[0].bytes.toString()).toBe('Geo candidate body')
      await expect(old.recheck()).rejects.toThrow()
      await next.recheck()
    }))
  it('preserves explicit pinned historical Geo bindings instead of replacing them with a newer global head', async () =>
    fixture(async (f) => {
      const first = await f.promote(),
        head = first.info.head
      if (!head) throw new Error('missing fixture head')
      await f.promote(Buffer.from('new global head'))
      const source = JSON.stringify({
          ...isolatedCoreConfiguration(),
          rules: ['GEOSITE,CUSTOM,REJECT', 'MATCH,REJECT']
        }),
        dependency = collectRuntimeDependencies(source).dependencies.find(
          (item) => item.kind === 'geosite-dat'
        )
      if (!dependency) throw new Error('missing fixture dependency')
      const resolve = vi.fn(async () => readDefaultGeoBinding(f.origins, f.cache, 'geosite-dat')),
        bundle = await bindRuntimeResources(
          source,
          [{ dependencyId: dependency.id, selection: head.resource }],
          {
            resources: f.cache,
            providers: {
              read: async () => {
                throw new Error('unexpected provider')
              }
            },
            defaultGeoResource: resolve
          }
        )
      expect(resolve).not.toHaveBeenCalled()
      expect(bundle.assets[0].sha256).toBe(head.resource.sha256)
      await f.promote(Buffer.from('third global head'))
      await bundle.recheck()
    }))
  it('resolves Geo introduced by a bound classical rule provider using the same mature dependency collector', async () =>
    fixture(async (f) => {
      const record = await f.promote(),
        rule = await f.cache.save(
          { name: 'Classical Geo fixture', kind: 'rule-yaml', behavior: 'classical', selector: '' },
          Buffer.from('payload:\n  - GEOSITE,CUSTOM\n')
        ),
        source = JSON.stringify({
          ...isolatedCoreConfiguration(),
          'rule-providers': {
            local: {
              type: 'file',
              path: 'old.yaml',
              behavior: 'classical',
              format: 'yaml',
              interval: 0
            }
          },
          rules: ['RULE-SET,local,REJECT', 'MATCH,REJECT']
        }),
        dependency = collectRuntimeDependencies(source).dependencies.find(
          (item) => item.kind === 'rule-yaml'
        )
      if (!dependency) throw new Error('missing fixture rule dependency')
      const bundle = await bindRuntimeResources(
        source,
        [{ dependencyId: dependency.id, selection: { id: rule.id, sha256: rule.sha256 } }],
        {
          resources: f.cache,
          providers: {
            read: async () => {
              throw new Error('unexpected provider')
            }
          },
          defaultGeoResource: (kind) => readDefaultGeoBinding(f.origins, f.cache, kind)
        }
      )
      expect(bundle.unresolved).toEqual([])
      expect(bundle.assets.find((asset) => asset.path === 'GeoSite.dat')?.sha256).toBe(
        record.info.head?.resource.sha256
      )
      await bundle.recheck()
    }))
  it('does not adopt a source head retained from an older definition or repair changed resource metadata', async () =>
    fixture(async (f) => {
      const record = await f.promote(),
        head = record.info.head
      if (!head) throw new Error('missing fixture head')
      const source = JSON.stringify({
          ...isolatedCoreConfiguration(),
          rules: ['GEOSITE,CUSTOM,REJECT', 'MATCH,REJECT']
        }),
        cached = await f.cache.read(head.resource)
      await writeFile(
        join(f.cache.directory, head.resource.id, 'metadata.json'),
        JSON.stringify({ version: 1, ...cached.info, name: 'changed' }),
        { mode: 0o600 }
      )
      await expect(
        bindRuntimeResources(source, [], {
          resources: f.cache,
          providers: {
            read: async () => {
              throw new Error('unexpected provider')
            }
          },
          defaultGeoResource: (kind) => readDefaultGeoBinding(f.origins, f.cache, kind)
        })
      ).rejects.toThrow('元数据')
      await f.origins.save({
        origin: select(record),
        definition: {
          ...record.definition,
          source: { ...record.definition.source, url: 'https://new.invalid/data' }
        }
      })
      expect(await readDefaultGeoBinding(f.origins, f.cache, 'geosite-dat')).toBeUndefined()
    }))
  it('uses actual immutable bytes and a safe source summary without inferring active acceptance', async () =>
    fixture(async (f) => {
      const record = await f.promote(),
        candidate = await readGeoOriginCandidate(f.origins, f.cache, select(record))
      expect(candidate.job.bytes.toString()).toBe('Geo candidate body')
      expect(candidate.job.descriptor).toEqual(record.definition.descriptor)
      expect(candidate.job.sha256).toBe(record.info.head?.resource.sha256)
      expect(JSON.stringify(candidate.origin)).not.toMatch(/SECRET|PRIVATE|authorization|token/u)
      expect(candidate).not.toHaveProperty('active')
      candidate.origin.descriptor.name = 'caller copy'
      await candidate.recheck()
      expect((await f.origins.read(select(record))).info.descriptor.name).toBe('Geo candidate')
    }))
  it('refuses an unacquired source without touching the cache', async () =>
    fixture(async (f) => {
      const read = vi.spyOn(f.cache, 'read')
      await expect(readGeoOriginCandidate(f.origins, f.cache, select(f.record))).rejects.toThrow()
      expect(read).not.toHaveBeenCalled()
    }))
  it('refuses the retained old head after a source edit', async () =>
    fixture(async (f) => {
      const record = await f.promote(),
        edited = await f.origins.save({
          origin: select(record),
          definition: {
            ...record.definition,
            source: { ...record.definition.source, url: 'https://changed.invalid/new' }
          }
        }),
        read = vi.spyOn(f.cache, 'read')
      await expect(readGeoOriginCandidate(f.origins, f.cache, select(edited))).rejects.toThrow()
      expect(read).not.toHaveBeenCalled()
    }))
  it('invalidates a held candidate when a new head is committed', async () =>
    fixture(async (f) => {
      const record = await f.promote(),
        candidate = await readGeoOriginCandidate(f.origins, f.cache, select(record))
      await f.promote(Buffer.from('new independent head'))
      await expect(candidate.recheck()).rejects.toThrow()
    }))
  it('rechecks the complete resource metadata revision, even if the body SHA is unchanged', async () =>
    fixture(async (f) => {
      const record = await f.promote(),
        candidate = await readGeoOriginCandidate(f.origins, f.cache, select(record)),
        head = record.info.head
      if (!head) throw new Error('fixture head missing')
      const read = await f.cache.read(head.resource)
      await writeFile(
        join(f.cache.directory, head.resource.id, 'metadata.json'),
        JSON.stringify({ version: 1, ...read.info, name: 'changed metadata' }),
        { mode: 0o600 }
      )
      await expect(candidate.recheck()).rejects.toThrow()
      expect((await f.origins.read(select(record))).info.head).toEqual(head)
    }))
  it('refuses actual cache corruption without replacing or repairing the head', async () =>
    fixture(async (f) => {
      const record = await f.promote(),
        candidate = await readGeoOriginCandidate(f.origins, f.cache, select(record)),
        head = record.info.head
      if (!head) throw new Error('fixture head missing')
      await writeFile(
        join(f.cache.directory, head.resource.id, 'resource.bin'),
        Buffer.from('corrupt candidate!'),
        { mode: 0o600 }
      )
      await expect(candidate.recheck()).rejects.toThrow()
      expect((await f.origins.read(select(record))).info.head).toEqual(head)
    }))
  it('detects a source edit during an awaited full cache read before returning usable bytes', async () =>
    fixture(async (f) => {
      const record = await f.promote(),
        cacheRead = f.cache.read.bind(f.cache),
        gate = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>()
      vi.spyOn(f.cache, 'read').mockImplementationOnce(async (...args) => {
        const value = await cacheRead(...args)
        entered.resolve()
        await gate.promise
        return value
      })
      const pending = readGeoOriginCandidate(f.origins, f.cache, select(record)),
        rejected = expect(pending).rejects.toThrow()
      await entered.promise
      await f.origins.save({
        origin: select(record),
        definition: {
          ...record.definition,
          autoIntent: { requested: false, schedule: { kind: 'interval', minutes: 1440 } }
        }
      })
      gate.resolve()
      await rejected
    }))
})
