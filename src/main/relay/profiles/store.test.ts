import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'fs/promises'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileStore, ProfileWriteUncertain } from './store'
import { pickProfileSource, readProfileFile } from './source'
import { PROFILE_BYTE_LIMIT } from './inspect'

const hooks = vi.hoisted(() => ({ failMetadata: false }))
vi.mock('fs/promises', async (original) => {
  const fs = await original<typeof import('fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (hooks.failMetadata && String(args[0]).endsWith('/metadata.json') && args[1] === 'wx')
        throw new Error('PRIVATE write failure')
      return fs.open(...args)
    }
  }
})
beforeEach(() => {
  hooks.failMetadata = false
})
async function fixture(test: (store: ProfileStore, home: string) => Promise<void>): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-profiles-'))
  try {
    await test(
      new ProfileStore({
        home,
        stateRoot: join(home, 'Library/Application Support/Relay-Preview')
      }),
      home
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
const text = '\uFEFF# preserve bytes\nmode: rule\nproxies: []\ndns: {enable: true}\nPRIVATE: keep\n'
describe('Private inactive copies and source identity', () => {
  it('keeps provider resources separate from configurations and legacy Edge staging', async () => {
    await fixture(async (store, home) => {
      const cache = new ProfileStore(
        { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
        'ProviderResources'
      )
      const profile = await store.save('Configuration', text)
      const resource = await cache.save('Resource', 'proxies: []')
      expect((await store.list()).profiles).toEqual([profile])
      expect((await cache.list()).profiles).toEqual([resource])
      await expect(store.read({ id: resource.id, sha256: resource.sha256 })).rejects.toThrow()
      await expect(cache.read({ id: profile.id, sha256: profile.sha256 })).rejects.toThrow()
      expect((await lstat(cache.directory)).mode & 0o777).toBe(0o700)
    })
  })
  it('does not create files on list, preserves exact source bytes and excludes activation', async () => {
    await fixture(async (store, home) => {
      expect(await store.list()).toMatchObject({ profiles: [], activeId: null })
      await expect(lstat(store.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      const origin = join(home, 'original.yaml')
      await writeFile(origin, text)
      const source = await pickProfileSource(origin)
      expect(source.text).toBe(text)
      const saved = await store.save(source.name, source.text)
      const path = join(store.directory, saved.id)
      expect((await lstat(path)).mode & 0o777).toBe(0o700)
      expect((await lstat(join(path, 'profile.yaml'))).mode & 0o777).toBe(0o600)
      expect(await readFile(join(path, 'profile.yaml'), 'utf8')).toBe(text)
      expect(await readFile(origin, 'utf8')).toBe(text)
      expect(await store.list()).toMatchObject({ profiles: [saved], activeId: null, incomplete: 0 })
      expect(JSON.stringify(await store.list())).not.toContain('PRIVATE')
    })
  })
  it('retains concurrent imports independently without overwriting a shared index', async () => {
    await fixture(async (store) => {
      const saved = await Promise.all([store.save('One', text), store.save('Two', text)])
      expect(new Set(saved.map((profile) => profile.id)).size).toBe(2)
      expect((await store.list()).profiles.map((p) => p.name).sort()).toEqual(['One', 'Two'])
    })
  })
  it('preserves changed, unknown, linked and partial records as incomplete', async () => {
    await fixture(async (store, home) => {
      const saved = await store.save('Local', text),
        directory = join(store.directory, saved.id)
      const copy = join(directory, 'profile.yaml')
      await writeFile(copy, text + '# changed\n')
      expect((await store.list()).incomplete).toBe(1)
      expect(await readFile(copy, 'utf8')).toBe(text + '# changed\n')
      await rm(copy)
      const preserve = join(home, 'keep.yaml')
      await writeFile(preserve, text, { mode: 0o600 })
      await symlink(preserve, copy)
      expect((await store.list()).incomplete).toBe(1)
      expect(await readFile(preserve, 'utf8')).toBe(text)
      await mkdir(join(store.directory, 'unknown'), { mode: 0o700 })
      expect((await store.list()).incomplete).toBe(2)
    })
  })
  it('reports an uncertain write, preserves partial data and does not publish it as usable', async () => {
    await fixture(async (store) => {
      hooks.failMetadata = true
      await expect(store.save('Local', text)).rejects.toBeInstanceOf(ProfileWriteUncertain)
      hooks.failMetadata = false
      expect(await store.list()).toMatchObject({ profiles: [], incomplete: 1 })
    })
  })
  it('refuses unsafe directories and leaves unknown metadata unchanged', async () => {
    await fixture(async (store) => {
      const saved = await store.save('Local', text),
        path = join(store.directory, saved.id, 'metadata.json')
      await writeFile(path, '{"version":2,"PRIVATE":"keep"}')
      expect((await store.list()).incomplete).toBe(1)
      expect(await readFile(path, 'utf8')).toBe('{"version":2,"PRIVATE":"keep"}')
      await chmod(store.directory, 0o777)
      await expect(store.list()).rejects.toThrow('不安全')
    })
  })
  it('rejects selected links, invalid UTF8, oversized files and private copies with unsafe permissions', async () => {
    await fixture(async (_store, home) => {
      const path = join(home, 'source.yaml')
      await writeFile(path, text, { mode: 0o644 })
      await symlink(path, path + '-link')
      await expect(readProfileFile(path + '-link')).rejects.toThrow()
      await expect(readProfileFile(path, true)).rejects.toThrow('权限')
      await writeFile(path, Buffer.from([0xc3, 0x28]))
      await expect(readProfileFile(path)).rejects.toThrow()
      await writeFile(path, Buffer.alloc(PROFILE_BYTE_LIMIT + 1))
      await expect(readProfileFile(path)).rejects.toThrow('大小')
      await expect(readProfileFile(home)).rejects.toThrow()
    })
  })
  it('never follows a linked Profiles root and preserves unexpected record members', async () => {
    await fixture(async (store) => {
      const saved = await store.save('Local', text)
      const unknown = join(store.directory, saved.id, 'keep.txt')
      await writeFile(unknown, 'PRIVATE keep')
      expect(await store.list()).toMatchObject({ profiles: [], incomplete: 1 })
      expect(await readFile(unknown, 'utf8')).toBe('PRIVATE keep')
    })
    await fixture(async (store, home) => {
      await mkdir(join(home, 'Library/Application Support/Relay-Preview'), {
        recursive: true,
        mode: 0o700
      })
      const other = join(home, 'untouched')
      await mkdir(other, { mode: 0o700 })
      await symlink(other, store.directory)
      await expect(store.list()).rejects.toThrow('不安全')
      await expect(store.save('Local', text)).rejects.toThrow('不安全')
    })
  })
  it('bounds inventory scans and labels a truncated list', async () => {
    await fixture(async (store) => {
      await store.save('Local', text)
      for (let index = 0; index < 201; index++)
        await mkdir(join(store.directory, `unknown-${index}`))
      const report = await store.list()
      expect(report.warnings.join(' ')).toContain('截断')
      expect(report.profiles.length + report.incomplete).toBe(200)
    })
  })
  it('reads a selected immutable record by ID/hash and pins both source and metadata revisions', async () => {
    await fixture(async (store) => {
      const saved = await store.save('Local', text),
        selected = { id: saved.id, sha256: saved.sha256 }
      const first = await store.read(selected)
      expect(first.text).toBe(text)
      await expect(store.read({ ...selected, path: '/injected' })).rejects.toThrow('只接受')
      await expect(store.read({ ...selected, id: '../outside' })).rejects.toThrow('无效')
      await expect(store.read({ ...selected, sha256: '0'.repeat(64) })).rejects.toThrow('变化')
      const metadata = join(store.directory, saved.id, 'metadata.json')
      const raw = JSON.parse(await readFile(metadata, 'utf8'))
      raw.name = 'Updated locally'
      await writeFile(metadata, JSON.stringify(raw))
      expect((await store.read(selected)).revision).not.toBe(first.revision)
      await writeFile(join(store.directory, saved.id, 'profile.yaml'), text + '# changed')
      await expect(store.read(selected)).rejects.toThrow()
    })
  })
  it('separates new configuration storage from Edge staging and reads old UUID records without migration', async () => {
    await fixture(async (store, home) => {
      expect(store.directory).toBe(
        join(home, 'Library/Application Support/Relay-Preview/Configurations')
      )
      const saved = await store.save('Old test copy', text),
        selection = { id: saved.id, sha256: saved.sha256 }
      const before = await store.read(selection)
      const legacy = join(home, 'Library/Application Support/Relay-Preview/Profiles')
      await mkdir(legacy, { mode: 0o700 })
      const edge = join(legacy, 'Claude-Edge-Network.mobileconfig')
      await writeFile(edge, 'PRIVATE Edge policy retained', { mode: 0o000 })
      await rename(join(store.directory, saved.id), join(legacy, saved.id))
      const report = await store.list()
      expect(report).toMatchObject({ profiles: [saved], incomplete: 0 })
      expect(report.warnings.join(' ')).toContain('只读兼容')
      expect((await store.read(selection)).text).toBe(text)
      expect((await store.read(selection)).revision).not.toBe(before.revision)
      await expect(lstat(join(store.directory, saved.id))).rejects.toMatchObject({ code: 'ENOENT' })
      await chmod(edge, 0o600)
      expect(await readFile(edge, 'utf8')).toBe('PRIVATE Edge policy retained')
      await store.save('New copy', text)
      expect((await store.list()).profiles).toHaveLength(2)
    })
  })
  it('does not silently choose a duplicate ID in new and legacy storage', async () => {
    await fixture(async (store, home) => {
      const saved = await store.save('Copy', text),
        legacy = join(home, 'Library/Application Support/Relay-Preview/Profiles')
      await mkdir(legacy, { mode: 0o700 })
      await cp(join(store.directory, saved.id), join(legacy, saved.id), { recursive: true })
      expect(await store.list()).toMatchObject({ profiles: [], incomplete: 2 })
      await expect(store.read({ id: saved.id, sha256: saved.sha256 })).rejects.toThrow('重复ID')
      expect(await readFile(join(legacy, saved.id, 'profile.yaml'), 'utf8')).toBe(text)
    })
  })
})
