import { randomUUID } from 'crypto'
import * as files from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { overrideLibraryRuntimeId } from '../../../shared/relay/override-library'
import { defaultEditDocument, profileOverridesFor } from '../../../shared/relay/configuration-edit'
import { profileHash } from '../profiles/source'
import { OverrideLibraryStore, OverrideLibraryWriteUncertain } from './override-library-store'
import { ConfigurationEditStore } from './edit-store'

vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

async function fixture(
  run: (f: {
    store: OverrideLibraryStore
    context: { home: string; stateRoot: string }
    directory: string
  }) => Promise<void>
): Promise<void> {
  const home = await files.realpath(await files.mkdtemp('/private/tmp/relay-override-library-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
    store = new OverrideLibraryStore(context, { now: () => 1000 })
  try {
    await run({ store, context, directory: join(context.stateRoot, 'Configuration') })
  } finally {
    vi.restoreAllMocks()
    vi.mocked(files.open).mockReset()
    vi.mocked(files.open).mockImplementation(
      (await vi.importActual<typeof import('fs/promises')>('fs/promises')).open
    )
    await files.rm(home, { recursive: true, force: true })
  }
}
const local = {
  expectedLibraryRevision: '',
  name: 'Local',
  kind: 'yaml',
  type: 'local',
  content: 'rules: []\n'
}
const cas = (r: Awaited<ReturnType<OverrideLibraryStore['read']>>) => ({
  id: r.item.id,
  expectedLibraryRevision: r.revision,
  expectedMetadataRevision: r.item.metadataRevision,
  expectedBodyRevision: r.item.bodyRevision
})
describe('Private override library single-file CAS', () => {
  it('keeps queue-bound inheritance JSON unchanged when library metadata disappears before validation', async () =>
    fixture(async (f) => {
      const item = await f.store.create(local),
        previous = randomUUID(),
        target = randomUUID(),
        edits = new ConfigurationEditStore(f.context),
        current = await edits.save({
          ...defaultEditDocument(),
          profileId: previous,
          profileOverrides: [
            { id: overrideLibraryRuntimeId(item.item.id), kind: 'yaml', content: '{}' }
          ]
        }),
        path = join(f.directory, 'configuration-edit.json'),
        before = await files.readFile(path)
      await expect(
        edits.inherit(previous, target, async (document) => {
          expect(profileOverridesFor(document, target)).toHaveLength(1)
          await f.store.remove(cas(item))
          await f.store.assertBindings([
            ...document.globalOverrides,
            ...document.profileOverrides,
            ...(document.profileOverrideSets ?? []).flatMap((set) => set.overrides)
          ])
        })
      ).rejects.toThrow('引用缺失')
      expect(await files.readFile(path)).toEqual(before)
      const unchanged = await edits.inherit(previous, previous, async () => {
        throw new Error('No-op must not validate')
      })
      expect(unchanged.revision).toBe(current.revision)
      expect(await files.readFile(path)).toEqual(before)
      expect(
        (await edits.save(defaultEditDocument(), current.revision)).document.profileOverrides
      ).toEqual([])
    }))
  it('is inert when missing, creates only its private file, and lists summaries without private URL/body', async () =>
    fixture(async (f) => {
      expect(await f.store.list()).toEqual({ revision: '', exists: false, items: [] })
      await expect(files.lstat(f.context.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      const created = await f.store.create(local),
        read = await f.store.read({ id: created.item.id })
      expect(read).toEqual(created)
      expect(read.item.bodyRevision).toBe(profileHash(local.content))
      expect((await files.stat(f.directory)).mode & 0o7777).toBe(0o700)
      expect((await files.stat(f.store.path)).mode & 0o7777).toBe(0o600)
      const remote = await f.store.create({
        expectedLibraryRevision: created.revision,
        name: 'Remote',
        kind: 'js',
        type: 'remote',
        remote: { url: 'https://example.invalid/PRIVATE?token=PRIVATE', proxyPort: 17891 }
      })
      expect(remote.item.bodyState).toBe('missing')
      const inventory = await f.store.list()
      expect(JSON.stringify(inventory)).not.toMatch(/PRIVATE|url|content/u)
      expect(inventory.items).toHaveLength(2)
    }))
  it('keeps metadata and body revisions independent, and marks changed-source/manual remote caches honestly', async () =>
    fixture(async (f) => {
      const created = await f.store.create({
          expectedLibraryRevision: '',
          name: 'Remote',
          kind: 'yaml',
          type: 'remote',
          remote: { url: 'https://example.invalid/old', proxyPort: 17891 }
        }),
        fetched = await f.store.saveFetched({
          ...cas(created),
          expectedSourceFingerprint: created.item.sourceFingerprint ?? '',
          content: 'rules: []\n',
          fetchedAt: 1000
        })
      expect(fetched.item.bodyState).toBe('current')
      expect(fetched.item.metadataRevision).toBe(created.item.metadataRevision)
      const moved = await f.store.saveMetadata({
        id: fetched.item.id,
        expectedLibraryRevision: fetched.revision,
        expectedMetadataRevision: fetched.item.metadataRevision,
        name: 'Moved',
        remote: { url: 'https://example.invalid/new', proxyPort: 17892 }
      })
      expect(moved.item.bodyState).toBe('stale')
      expect(moved.item.content).toBe(fetched.item.content)
      expect(moved.item.bodyRevision).toBe(fetched.item.bodyRevision)
      const manual = await f.store.saveBody({
        id: moved.item.id,
        expectedLibraryRevision: moved.revision,
        expectedBodyRevision: moved.item.bodyRevision,
        content: 'rules: [MATCH,REJECT]\n'
      })
      expect(manual.item.bodyState).toBe('manual')
      expect(manual.item.metadataRevision).toBe(moved.item.metadataRevision)
      expect(manual.item.lastFetchedAt).toBe(1000)
      const bytes = await files.readFile(f.store.path)
      await expect(
        f.store.saveFetched({
          ...cas(manual),
          expectedSourceFingerprint: fetched.item.sourceFingerprint ?? '',
          content: '{}',
          fetchedAt: 1000
        })
      ).rejects.toThrow('来源或修订')
      expect(await files.readFile(f.store.path)).toEqual(bytes)
    }))
  it('serializes two same-path instances and refuses a stale library/item CAS without discarding either draft', async () =>
    fixture(async (f) => {
      const other = new OverrideLibraryStore(f.context, { now: () => 1000 }),
        results = await Promise.allSettled([
          f.store.create(local),
          other.create({ ...local, name: 'Other' })
        ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
      const inventory = await f.store.list(),
        current = await f.store.read({ id: inventory.items[0].id }),
        changed = await other.saveBody({
          id: current.item.id,
          expectedLibraryRevision: current.revision,
          expectedBodyRevision: current.item.bodyRevision,
          content: 'rules: [MATCH,REJECT]'
        })
      await expect(
        f.store.saveMetadata({
          id: current.item.id,
          expectedLibraryRevision: current.revision,
          expectedMetadataRevision: current.item.metadataRevision,
          name: 'Stale draft'
        })
      ).rejects.toThrow('修订已变化')
      await expect(
        f.store.saveBody({
          id: current.item.id,
          expectedLibraryRevision: changed.revision,
          expectedBodyRevision: current.item.bodyRevision,
          content: '{}'
        })
      ).rejects.toThrow('正文修订')
      expect(await f.store.read({ id: current.item.id })).toEqual(changed)
    }))
  it('preserves exact prior bytes on an atomic-write failure and does not poison the shared queue', async () =>
    fixture(async (f) => {
      const created = await f.store.create(local),
        before = await files.readFile(f.store.path),
        failing = new OverrideLibraryStore(f.context, {
          write: async () => {
            throw new Error('PRIVATE failure')
          }
        })
      await expect(
        failing.saveBody({
          id: created.item.id,
          expectedLibraryRevision: created.revision,
          expectedBodyRevision: created.item.bodyRevision,
          content: '{}'
        })
      ).rejects.toBeInstanceOf(OverrideLibraryWriteUncertain)
      expect(await files.readFile(f.store.path)).toEqual(before)
      expect((await files.stat(f.store.path)).mode & 0o7777).toBe(0o600)
      expect(
        (
          await f.store.saveBody({
            id: created.item.id,
            expectedLibraryRevision: created.revision,
            expectedBodyRevision: created.item.bodyRevision,
            content: '{}'
          })
        ).item.content
      ).toBe('{}')
    }))
  it.each(['json', 'utf8', 'unknown', 'duplicate'] as const)(
    'rejects a %s corrupt library without reset or private error reflection',
    async (kind) =>
      fixture(async (f) => {
        await f.store.create(local)
        let bytes = Buffer.from('{"PRIVATE-token":')
        if (kind === 'utf8') bytes = Buffer.from([0xff])
        if (kind === 'unknown' || kind === 'duplicate') {
          const value = JSON.parse((await files.readFile(f.store.path)).toString())
          if (kind === 'unknown') value.items[0].role = 'smart'
          else value.items.push(value.items[0])
          bytes = Buffer.from(JSON.stringify(value))
        }
        await files.writeFile(f.store.path, bytes)
        await expect(f.store.list()).rejects.toThrow()
        try {
          await f.store.list()
        } catch (e) {
          expect(String(e)).not.toContain('PRIVATE-token')
        }
        expect(await files.readFile(f.store.path)).toEqual(bytes)
      })
  )
  it.each(['symlink', 'hardlink', 'mode'] as const)(
    'does not adopt an unsafe %s file',
    async (kind) =>
      fixture(async (f) => {
        await f.store.create(local)
        const original = await files.readFile(f.store.path),
          other = join(f.context.home, 'other.json')
        if (kind === 'symlink') {
          await files.rename(f.store.path, other)
          await files.symlink(other, f.store.path)
        }
        if (kind === 'hardlink') await files.link(f.store.path, other)
        if (kind === 'mode') await files.chmod(f.store.path, 0o644)
        await expect(f.store.list()).rejects.toThrow()
        expect(await files.readFile(f.store.path)).toEqual(original)
        if (kind === 'mode') expect((await files.stat(f.store.path)).mode & 0o7777).toBe(0o644)
      })
  )
  it('tightens only the known same-owner legacy0755 Configuration directory through its pinned descriptor', async () =>
    fixture(async (f) => {
      await new ConfigurationEditStore(f.context).save(defaultEditDocument())
      expect((await files.stat(f.directory)).mode & 0o7777).toBe(0o700)
      const editFile = join(f.directory, 'configuration-edit.json'),
        editBytes = await files.readFile(editFile)
      await files.chmod(f.directory, 0o755)
      const before = await files.stat(f.directory)
      expect(await f.store.list()).toEqual({ revision: '', exists: false, items: [] })
      const after = await files.stat(f.directory)
      expect(after.ino).toBe(before.ino)
      expect(after.mode & 0o7777).toBe(0o700)
      expect(await files.readFile(editFile)).toEqual(editBytes)
    }))
  it.each([0o750, 0o770, 0o777])(
    'refuses unknown or writable directory mode%o without repairing it',
    async (mode) =>
      fixture(async (f) => {
        await files.mkdir(f.directory, { recursive: true, mode })
        await files.chmod(f.directory, mode)
        await expect(f.store.list()).rejects.toThrow()
        expect((await files.stat(f.directory)).mode & 0o7777).toBe(mode)
      })
  )
  it('does not chmod or write a late replacement directory when tightening a pinned legacy inode', async () =>
    fixture(async (f) => {
      await files.mkdir(f.directory, { recursive: true, mode: 0o755 })
      await files.chmod(f.directory, 0o755)
      const parked = join(f.context.stateRoot, 'Configuration-original'),
        originalOpen = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).open
      let replaced = false
      vi.mocked(files.open).mockImplementation(async (...args) => {
        const handle = await originalOpen(...args)
        if (args[0] === f.directory && !replaced) {
          replaced = true
          await files.rename(f.directory, parked)
          await files.mkdir(f.directory, { mode: 0o755 })
        }
        return handle
      })
      await expect(f.store.list()).rejects.toThrow('目录发生改变')
      expect((await files.stat(f.directory)).mode & 0o7777).toBe(0o755)
      expect(await files.readdir(f.directory)).toEqual([])
      expect((await files.stat(parked)).mode & 0o7777).toBe(0o700)
    }))
  it('rejects a file identity replacement during a bounded read even with identical bytes', async () =>
    fixture(async (f) => {
      await f.store.create(local)
      const original = await files.readFile(f.store.path),
        originalOpen = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).open
      let replaced = false
      vi.mocked(files.open).mockImplementation(async (...args) => {
        if (args[0] === f.store.path && !replaced) {
          replaced = true
          await files.rename(f.store.path, f.store.path + '.original')
          await files.writeFile(f.store.path, original, { mode: 0o600 })
        }
        return originalOpen(...args)
      })
      await expect(f.store.list()).rejects.toThrow()
      expect(await files.readFile(f.store.path)).toEqual(original)
      expect(await files.readFile(f.store.path + '.original')).toEqual(original)
    }))
  it('enforces200 entries and final serialized1MiB without truncating accepted prior records', async () =>
    fixture(async (f) => {
      await f.store.create(local)
      const seed = JSON.parse((await files.readFile(f.store.path)).toString()).items[0]
      await files.writeFile(
        f.store.path,
        JSON.stringify({
          version: 1,
          items: Array.from({ length: 200 }, () => ({ ...seed, id: randomUUID() }))
        })
      )
      let bytes = await files.readFile(f.store.path),
        inventory = await f.store.list()
      expect(inventory.items).toHaveLength(200)
      await expect(
        f.store.create({ ...local, expectedLibraryRevision: inventory.revision })
      ).rejects.toThrow('200')
      expect(await files.readFile(f.store.path)).toEqual(bytes)
      await files.writeFile(
        f.store.path,
        JSON.stringify({
          version: 1,
          items: Array.from({ length: 8 }, () => ({
            ...seed,
            id: randomUUID(),
            content: 'value: ' + 'x'.repeat(120000)
          }))
        })
      )
      bytes = await files.readFile(f.store.path)
      inventory = await f.store.list()
      await expect(
        f.store.create({
          ...local,
          expectedLibraryRevision: inventory.revision,
          content: 'value: ' + 'x'.repeat(120000)
        })
      ).rejects.toThrow('1MiB')
      expect(await files.readFile(f.store.path)).toEqual(bytes)
    }))
  it('checks only namespace existence and immutable kind without upgrading inline revisions or reading on nonlibrary paths', async () =>
    fixture(async (f) => {
      const created = await f.store.create(local)
      await f.store.assertBindings([
        { id: overrideLibraryRuntimeId(created.item.id), kind: 'yaml' }
      ])
      await f.store.saveBody({
        id: created.item.id,
        expectedLibraryRevision: created.revision,
        expectedBodyRevision: created.item.bodyRevision,
        content: '{}'
      })
      await f.store.assertBindings([
        { id: overrideLibraryRuntimeId(created.item.id), kind: 'yaml' }
      ])
      await expect(
        f.store.assertBindings([{ id: overrideLibraryRuntimeId(created.item.id), kind: 'js' }])
      ).rejects.toThrow()
      await files.writeFile(f.store.path, 'BROKEN')
      await f.store.assertBindings([{ id: 'smart-core-override', kind: 'js' }])
      await expect(
        f.store.assertBindings([{ id: overrideLibraryRuntimeId(created.item.id), kind: 'yaml' }])
      ).rejects.toThrow()
      expect(
        () => new OverrideLibraryStore({ ...f.context, stateRoot: join(f.context.home, 'Edge') })
      ).toThrow()
      expect(
        () => new OverrideLibraryStore({ ...f.context, home: f.context.home + '/..' })
      ).toThrow()
    }))
})
