import {
  mkdtemp,
  realpath,
  lstat,
  readFile,
  writeFile,
  rm,
  readdir,
  mkdir,
  chmod,
  symlink,
  rename
} from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileStore } from '../profiles/store'
import { sourceOptions } from './source-options'
import { SubscriptionSourceStore, SubscriptionJournalUncertain } from './source-store'
import { SubscriptionFiles } from './private-files'

const request = {
  name: 'Fixture',
  url: 'https://private.invalid/PRIVATE?token=PRIVATE',
  proxyPort: 18191
}
afterEach(() => vi.restoreAllMocks())
async function fixture(
  run: (store: SubscriptionSourceStore, profiles: ProfileStore, home: string) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-source-journal-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  try {
    await run(new SubscriptionSourceStore(context), new ProfileStore(context), home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
const select = (s: { id: string; revision: string }) => ({ id: s.id, revision: s.revision })
describe('Private append-only subscription journal', () => {
  it('stores v2 credentials privately and appends cache checks without changing configuration history', async () => {
    await fixture(async (store, profiles) => {
      const options = {
          ...sourceOptions(undefined),
          headers: { authorization: 'Bearer PRIVATE' },
          schedule: { kind: 'interval' as const, minutes: 5 }
        },
        source = await store.create(request, options),
        p = await profiles.save('First', 'proxies: []'),
        profile = { id: p.id, sha256: p.sha256 },
        metadata = {
          checkedAt: new Date().toISOString(),
          status: 200 as const,
          resourceSHA256: 'c'.repeat(64),
          etag: '"PRIVATE"',
          quota: { total: 100 },
          homeOrigin: 'https://billing.invalid',
          homeURL: 'https://billing.invalid/PRIVATE'
        },
        first = await store.commit(select(source), async () => ({ profile }), { metadata }),
        checked = await store.observe(select(first), { ...metadata, status: 304 })
      expect(checked.versions).toHaveLength(1)
      expect(checked.observation).toMatchObject({ status: 304, quota: { total: 100 } })
      expect(JSON.stringify(checked)).not.toContain('PRIVATE')
      const stored = await store.read(select(checked))
      expect(stored.recordCount).toBe(2)
      expect(stored.cache?.metadata.etag).toBe('"PRIVATE"')
      expect(stored.cache?.metadata.homeURL).toBe('https://billing.invalid/PRIVATE')
      expect(stored.options.headers).toEqual({ authorization: 'Bearer PRIVATE' })
      const other = await profiles.save('Second', 'rules: []'),
        second = await store.commit(select(checked), async () => ({
          profile: { id: other.id, sha256: other.sha256 }
        })),
        restored = await store.commit(select(second), async () => ({
          profile,
          restoredFrom: first.versions[0].id
        }))
      expect((await store.read(select(restored))).cache).toBeUndefined()
    })
  })
  it('does no constructor or list writes and privately stores the URL without returning it', async () => {
    await fixture(async (store) => {
      expect((await store.list()).sources).toEqual([])
      await expect(lstat(store.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      const info = await store.create(request),
        root = join(store.directory, info.id)
      expect(JSON.stringify(info)).not.toContain('PRIVATE')
      expect((await store.read(select(info))).request).toEqual(request)
      expect((await lstat(root)).mode & 0o777).toBe(0o700)
      expect((await lstat(join(root, 'source.json'))).mode & 0o777).toBe(0o600)
      expect(await readFile(join(root, 'source.json'), 'utf8')).toContain('PRIVATE')
    })
  })
  it('appends hash-linked immutable versions, rejects stale writes and records restoration without overwriting profiles', async () => {
    await fixture(async (store, profiles) => {
      const source = await store.create(request),
        first = await profiles.save('First', 'proxies: []'),
        second = await profiles.save('Second', 'rules: []'),
        a = { id: first.id, sha256: first.sha256 },
        b = { id: second.id, sha256: second.sha256 }
      const one = await store.commit(select(source), async () => ({ profile: a }))
      await expect(store.commit(select(source), async () => ({ profile: b }))).rejects.toThrow(
        '修订'
      )
      const two = await store.commit(select(one), async () => ({ profile: b })),
        restored = await store.commit(select(two), async () => ({
          profile: a,
          restoredFrom: one.versions[0].id
        }))
      expect(restored.versions.map((v) => v.profile)).toEqual([a, b, a])
      expect(restored.versions[2].action).toBe('restore')
      expect((await profiles.list()).profiles).toHaveLength(2)
      expect((await profiles.read(a)).text).toBe('proxies: []')
      expect(await readdir(join(store.directory, source.id))).toEqual(
        expect.arrayContaining(['source.json', 'versions'])
      )
      expect(restored.locked).toBe(false)
    })
  })
  it('holds an exclusive source lease and never adopts an orphan lock', async () => {
    await fixture(async (store, profiles) => {
      const source = await store.create(request),
        p = await profiles.save('First', 'proxies: []'),
        selected = select(source)
      let finish!: (value: { profile: { id: string; sha256: string } }) => void
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const building = store.commit(
        selected,
        async () =>
          new Promise((resolve) => {
            finish = resolve
            entered()
          })
      )
      // Wait for the actual lease-protected build boundary. A polling timeout
      // also measured unrelated filesystem scheduling under parallel builds.
      await Promise.race([started, building])
      expect((await store.read(selected)).info.locked).toBe(true)
      await expect(
        store.commit(selected, async () => ({ profile: { id: p.id, sha256: p.sha256 } }))
      ).rejects.toThrow('写锁')
      finish({ profile: { id: p.id, sha256: p.sha256 } })
      const current = await building
      const lock = join(store.directory, source.id, '.write-lock')
      await mkdir(lock, { mode: 0o700 })
      await writeFile(join(lock, 'owner.json'), 'unknown old owner', { mode: 0o600 })
      await expect(
        store.commit(select(current), async () => ({ profile: { id: p.id, sha256: p.sha256 } }))
      ).rejects.toThrow('写锁')
      expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe('unknown old owner')
    })
  })
  it('preserves previous commits and an orphan profile when a commit write fails', async () => {
    await fixture(async (store, profiles) => {
      const source = await store.create(request),
        p = await profiles.save('First', 'proxies: []'),
        a = { id: p.id, sha256: p.sha256 },
        current = await store.commit(select(source), async () => ({ profile: a })),
        write = SubscriptionFiles.prototype.write
      vi.spyOn(SubscriptionFiles.prototype, 'write').mockImplementation(async function (
        this: SubscriptionFiles,
        path,
        raw
      ) {
        if (path.includes('/versions/002-')) throw new Error('PRIVATE fault')
        return write.call(this, path, raw)
      })
      await expect(
        store.commit(select(current), async () => {
          const p = await profiles.save('Orphan', 'rules: []')
          return { profile: { id: p.id, sha256: p.sha256 } }
        })
      ).rejects.toBeInstanceOf(SubscriptionJournalUncertain)
      expect((await store.read(select(current))).info.versions).toHaveLength(1)
      expect((await profiles.list()).profiles).toHaveLength(2)
      expect((await store.read(select(current))).info.locked).toBe(false)
    })
  })
  it('does not append or remove a replaced lease owner', async () => {
    await fixture(async (store, profiles) => {
      const source = await store.create(request),
        p = await profiles.save('First', 'proxies: []'),
        owner = join(store.directory, source.id, '.write-lock/owner.json')
      await expect(
        store.commit(select(source), async () => {
          await writeFile(owner, JSON.stringify({ token: 'replaced-owner' }))
          return { profile: { id: p.id, sha256: p.sha256 } }
        })
      ).rejects.toBeInstanceOf(SubscriptionJournalUncertain)
      expect(await readFile(owner, 'utf8')).toBe(JSON.stringify({ token: 'replaced-owner' }))
      expect((await store.read(select(source))).info).toMatchObject({ versions: [], locked: true })
    })
  })
  it('detects changed history, unsafe permissions and linked origins without changing them', async () => {
    await fixture(async (store, profiles, home) => {
      const source = await store.create(request),
        p = await profiles.save('First', 'proxies: []'),
        current = await store.commit(select(source), async () => ({
          profile: { id: p.id, sha256: p.sha256 }
        })),
        root = join(store.directory, source.id),
        versions = join(root, 'versions'),
        file = join(versions, (await readdir(versions))[0]),
        raw = await readFile(file, 'utf8')
      await writeFile(file, JSON.stringify({ ...JSON.parse(raw), parent: 'changed' }))
      expect((await store.list()).incomplete).toBe(1)
      await writeFile(file, raw)
      await chmod(join(root, 'source.json'), 0o644)
      await expect(store.read(select(current))).rejects.toThrow()
      await chmod(join(root, 'source.json'), 0o600)
      const outside = join(home, 'keep.json')
      await rename(join(root, 'source.json'), outside)
      await symlink(outside, join(root, 'source.json'))
      await expect(store.read(select(current))).rejects.toThrow()
      expect(await readFile(outside, 'utf8')).toContain('PRIVATE')
    })
  })
})
