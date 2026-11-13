import { mkdtemp, realpath, rm, lstat, writeFile, readFile, symlink, chmod, cp } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileStore } from '../profiles/store'
import { profileHash } from '../profiles/source'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { ResourceStore, ResourceWriteUncertain } from './store'
import { resourceHash, readBinaryResource } from './source'

const descriptor = {
  name: 'Fixture',
  kind: 'rule-text' as const,
  behavior: 'domain' as const,
  selector: ''
}
afterEach(() => vi.restoreAllMocks())
async function fixture(run: (cache: ResourceStore, home: string) => Promise<void>): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-resources-'))
  try {
    await run(
      new ResourceStore({
        home,
        stateRoot: join(home, 'Library/Application Support/Relay-Preview')
      }),
      home
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
describe('Private immutable binary resources', () => {
  it('keeps construction/list inert and saves exact private bytes independently of configurations', async () => {
    await fixture(async (cache, home) => {
      expect((await cache.list()).resources).toHaveLength(0)
      await expect(lstat(cache.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      const original = Buffer.from([0xff, 0xc3, 0x28, 0, 1]),
        bytes = Buffer.from(original),
        saving = cache.save(descriptor, bytes)
      bytes.fill(7)
      const info = await saving,
        root = join(cache.directory, info.id),
        selection = { id: info.id, sha256: info.sha256 }
      expect(info.sha256).toBe(resourceHash(original))
      expect((await cache.read(selection)).bytes).toEqual(original)
      expect((await lstat(root)).mode & 0o777).toBe(0o700)
      expect((await lstat(join(root, 'resource.bin'))).mode & 0o777).toBe(0o600)
      expect((await lstat(join(root, 'metadata.json'))).mode & 0o777).toBe(0o600)
      const profiles = new ProfileStore({
        home,
        stateRoot: join(home, 'Library/Application Support/Relay-Preview')
      })
      await profiles.save('Config', 'proxies: []')
      expect((await cache.list()).resources).toHaveLength(1)
      expect((await profiles.list()).profiles).toHaveLength(1)
      await expect(cache.read({ ...selection, path: '/PRIVATE' })).rejects.toThrow('摘要')
    })
  })
  it('never labels metadata listing as body verification and refuses a same-size changed body', async () => {
    await fixture(async (cache) => {
      const info = await cache.save(descriptor, Buffer.from('valid')),
        path = join(cache.directory, info.id, 'resource.bin')
      await writeFile(path, 'other')
      expect((await cache.list()).resources[0].integrity).toBe('notChecked')
      await expect(cache.read({ id: info.id, sha256: info.sha256 })).rejects.toThrow('摘要')
      expect(await readFile(path, 'utf8')).toBe('other')
    })
  })
  it('keeps verified metadata SHA portable while the resource revision remains bound to its private root', async () => {
    await fixture(async (cache) => {
      const info = await cache.save(descriptor, Buffer.from('portable bytes')),
        selected = { id: info.id, sha256: info.sha256 },
        root = join(cache.directory, info.id),
        raw = await readFile(join(root, 'metadata.json'), 'utf8'),
        original = await cache.read(selected)
      await fixture(async (copied, home) => {
        await new SubscriptionFiles({
          home,
          stateRoot: join(home, 'Library/Application Support/Relay-Preview')
        }).directory(copied.directory, true)
        const copiedRoot = join(copied.directory, info.id)
        await cp(root, copiedRoot, { recursive: true, force: false, errorOnExist: true })
        const restored = await copied.read(selected)
        expect(restored.info).toEqual(original.info)
        expect(restored.bytes).toEqual(original.bytes)
        expect(original.metadataSHA256).toBe(profileHash(raw))
        expect(restored.metadataSHA256).toBe(original.metadataSHA256)
        expect(restored.revision).not.toBe(original.revision)
        expect(original.revision).toBe(profileHash(root + '\0' + raw + '\0' + info.sha256))
        expect(restored.revision).toBe(profileHash(copiedRoot + '\0' + raw + '\0' + info.sha256))
        expect(await readFile(join(copiedRoot, 'metadata.json'), 'utf8')).toBe(raw)
        expect(await readFile(join(root, 'metadata.json'), 'utf8')).toBe(raw)
      })
    })
  })
  it('hashes exact verified metadata bytes including whitespace and object key order', async () => {
    await fixture(async (cache) => {
      const info = await cache.save(descriptor, Buffer.from('exact metadata bytes')),
        selected = { id: info.id, sha256: info.sha256 },
        meta = join(cache.directory, info.id, 'metadata.json'),
        raw = await readFile(meta, 'utf8'),
        original = await cache.read(selected),
        reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw)).reverse()))
      for (const changed of [raw + '\n', reordered]) {
        expect(changed).not.toBe(raw)
        expect(JSON.parse(changed)).toEqual(JSON.parse(raw))
        await writeFile(meta, changed)
        const verified = await cache.read(selected)
        expect(verified.info).toEqual(original.info)
        expect(verified.bytes).toEqual(original.bytes)
        expect(verified.metadataSHA256).toBe(profileHash(changed))
        expect(verified.metadataSHA256).not.toBe(original.metadataSHA256)
        expect(verified.revision).not.toBe(original.revision)
        expect(await readFile(meta, 'utf8')).toBe(changed)
      }
    })
  })
  it('rejects changed metadata, links and unsafe permissions without repairing or deleting them', async () => {
    await fixture(async (cache, home) => {
      const info = await cache.save(descriptor, Buffer.from('bytes')),
        root = join(cache.directory, info.id),
        meta = join(root, 'metadata.json'),
        raw = await readFile(meta, 'utf8')
      await writeFile(meta, JSON.stringify({ ...JSON.parse(raw), PRIVATE: 'unknown' }))
      expect((await cache.list()).incomplete).toBe(1)
      await writeFile(meta, raw)
      await chmod(join(root, 'resource.bin'), 0o644)
      expect((await cache.list()).incomplete).toBe(1)
      const selected = join(home, 'selected.bin')
      await writeFile(selected, 'selected')
      await symlink(selected, join(home, 'linked.bin'))
      await expect(readBinaryResource(join(home, 'linked.bin'))).rejects.toThrow()
      expect(await readFile(selected, 'utf8')).toBe('selected')
    })
  })
  it('preserves a partial record on metadata failure and never lists it as usable', async () => {
    await fixture(async (cache) => {
      const original = SubscriptionFiles.prototype.write
      vi.spyOn(SubscriptionFiles.prototype, 'write').mockImplementation(async function (
        this: SubscriptionFiles,
        path,
        raw
      ) {
        if (path.endsWith('/metadata.json')) throw new Error('PRIVATE fault')
        return original.call(this, path, raw)
      })
      await expect(cache.save(descriptor, Buffer.from('bytes'))).rejects.toBeInstanceOf(
        ResourceWriteUncertain
      )
      expect(await cache.list()).toMatchObject({ resources: [], incomplete: 1 })
    })
  })
})
