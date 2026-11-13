import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { CoreStore } from './store'

async function fixture(test: (store: CoreStore, home: string) => Promise<void>): Promise<void> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-core-store-')))
  try {
    await test(
      new CoreStore({ home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }),
      home
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
describe('Core-owned preferences and durable exclusive records', () => {
  it.each([
    undefined,
    { http: 18191, socks: 18192, mixed: 18194, redir: 18195 },
    { http: 0, socks: 18192, mixed: 18191, redir: 0 }
  ])(
    'preserves ordinary listener metadata on acquire, inspect, and source update %j',
    async (ports) => {
      await fixture(async (store) => {
        const runtime = {
          kind: 'localProxy' as const,
          httpPort: 18191,
          ...(ports ? { ports } : {}),
          profileId: '00000000-0000-0000-0000-000000000001',
          sourceSHA256: 'a'.repeat(64),
          resolverMode: 'profile' as const
        }
        const lease = await store.acquire('rule', (await store.inspect()).revision, runtime)
        const file = join(store.directory, '.session/owner.json')
        expect(JSON.parse(await readFile(file, 'utf8')).runtime).toEqual(runtime)
        expect((await store.inspect()).lease).toBe('present')
        await lease.update('running', 1234)
        const changed = {
          ...runtime,
          profileId: '00000000-0000-0000-0000-000000000002',
          sourceSHA256: 'b'.repeat(64)
        }
        if (!lease.updateRuntime) throw new Error('Missing runtime transaction')
        await lease.updateRuntime(changed)
        expect(JSON.parse(await readFile(file, 'utf8')).runtime).toEqual(changed)
        expect((await store.inspect()).lease).toBe('present')
        await lease.release()
        expect((await store.inspect()).lease).toBe('missing')
      })
    }
  )
  it.each([
    { http: 18191, socks: 18191, mixed: 0, redir: 0 },
    { http: 0, socks: 18192, mixed: 18194, redir: 0 },
    { http: 0, socks: 18192, mixed: 0, redir: 18195 }
  ])(
    'refuses duplicate, aliased, or non-HTTP-capable listener records without writes %j',
    async (ports) => {
      await fixture(async (store) => {
        const runtime = {
          kind: 'localProxy' as const,
          httpPort: 18191,
          profileId: '00000000-0000-0000-0000-000000000001',
          sourceSHA256: 'a'.repeat(64)
        }
        const revision = (await store.inspect()).revision
        await expect(store.acquire('rule', revision, { ...runtime, ports })).rejects.toThrow()
        await expect(stat(store.directory)).rejects.toMatchObject({ code: 'ENOENT' })
        const lease = await store.acquire('rule', revision, runtime)
        await lease.update('running', 1234)
        if (!lease.updateRuntime) throw new Error('Missing runtime transaction')
        const file = join(store.directory, '.session/owner.json')
        const original = await readFile(file, 'utf8')
        await expect(lease.updateRuntime({ ...runtime, ports })).rejects.toThrow()
        expect(await readFile(file, 'utf8')).toBe(original)
        const corrupt = JSON.stringify({ ...JSON.parse(original), runtime: { ...runtime, ports } })
        await writeFile(file, corrupt, { mode: 0o600 })
        expect((await store.inspect()).lease).toBe('invalid')
        expect(await readFile(file, 'utf8')).toBe(corrupt)
        await writeFile(file, original, { mode: 0o600 })
        await lease.release()
      })
    }
  )
  it('updates runtime source identity only under the current running nonce and preserves unknown modifications', async () => {
    await fixture(async (store) => {
      const runtime = {
        kind: 'localProxy' as const,
        httpPort: 18191,
        profileId: '00000000-0000-0000-0000-000000000001',
        sourceSHA256: 'a'.repeat(64)
      }
      const lease = await store.acquire('rule', (await store.inspect()).revision, runtime)
      if (!lease.updateRuntime) throw new Error('Missing runtime transaction')
      await expect(lease.updateRuntime(runtime)).rejects.toThrow('运行中')
      await lease.update('running', 1234)
      const changed = {
        ...runtime,
        profileId: '00000000-0000-0000-0000-000000000002',
        sourceSHA256: 'b'.repeat(64)
      }
      await lease.updateRuntime(changed)
      const file = join(store.directory, '.session/owner.json'),
        owner = JSON.parse(await readFile(file, 'utf8'))
      expect(owner.runtime).toEqual(changed)
      expect(owner.pid).toBe(1234)
      await writeFile(file, JSON.stringify({ ...owner, pid: 5678 }), { mode: 0o600 })
      await expect(lease.updateRuntime(runtime)).rejects.toThrow('改变')
      expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(5678)
    })
  })
  it('reads defaults without creating directories, persists mode and excludes another owner', async () => {
    await fixture(async (store) => {
      const initial = await store.inspect()
      expect(initial).toMatchObject({ mode: 'rule', lease: 'missing' })
      await expect(stat(store.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      const lease = await store.acquire('global', initial.revision)
      expect(await store.inspect()).toMatchObject({ mode: 'global', lease: 'present' })
      expect((await stat(join(store.directory, 'preferences.json'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(store.directory, '.session'))).mode & 0o777).toBe(0o700)
      await expect(store.acquire('direct', (await store.inspect()).revision)).rejects.toThrow()
      await lease.update('running', 1234)
      await lease.update('stopping')
      await expect(lease.update('running', 1234)).rejects.toThrow('倒退')
      await lease.release()
      expect(await store.inspect()).toMatchObject({ mode: 'global', lease: 'missing' })
      expect(await readFile(join(store.directory, 'preferences.json'), 'utf8')).toBe(
        '{"version":1,"mode":"global"}'
      )
    })
  })
  it('rejects an externally changed preference revision and preserves invalid or unknown files', async () => {
    await fixture(async (store) => {
      const initial = await store.inspect(),
        lease = await store.acquire('rule', initial.revision)
      await lease.release()
      const next = await store.inspect(),
        file = join(store.directory, 'preferences.json')
      await writeFile(file, '{"version":1,"mode":"direct"}', { mode: 0o600 })
      await expect(store.acquire('global', next.revision)).rejects.toThrow('未完成')
      expect(await store.inspect()).toMatchObject({ mode: 'direct', lease: 'missing' })
      const unknown = '{"version":2,"mode":"rule","PRIVATE":"keep"}'
      await writeFile(file, unknown, { mode: 0o600 })
      await expect(store.inspect()).rejects.toThrow('不兼容')
      expect(await readFile(file, 'utf8')).toBe(unknown)
    })
  })
  it('never removes a changed record or recursively deletes unknown session files', async () => {
    await fixture(async (store) => {
      const lease = await store.acquire('rule', (await store.inspect()).revision)
      const record = join(store.directory, '.session/owner.json'),
        original = await readFile(record, 'utf8')
      await writeFile(record, 'PRIVATE invalid record', { mode: 0o600 })
      await expect(lease.update('running', 1234)).rejects.toThrow('改变')
      await expect(lease.release()).rejects.toThrow('改变')
      expect((await store.inspect()).lease).toBe('invalid')
      await writeFile(record, original, { mode: 0o600 })
      const extra = join(store.directory, '.session/keep.txt')
      await writeFile(extra, 'keep')
      await expect(lease.release()).rejects.toThrow()
      expect(await readFile(extra, 'utf8')).toBe('keep')
      await rm(extra)
      await lease.release()
      expect((await store.inspect()).lease).toBe('missing')
    })
  })
  it('blocks symlink directories and stale session records without adopting their PID', async () => {
    await fixture(async (store, home) => {
      const first = await store.acquire('rule', (await store.inspect()).revision)
      await first.update('running', 99999)
      const second = new CoreStore({
        home,
        stateRoot: join(home, 'Library/Application Support/Relay-Preview')
      })
      expect((await second.inspect()).lease).toBe('present')
      await expect(second.acquire('rule', (await second.inspect()).revision)).rejects.toThrow()
      await first.release()
    })
    await fixture(async (store, home) => {
      await mkdir(join(home, 'Library/Application Support/Relay-Preview'), {
        recursive: true,
        mode: 0o700
      })
      const other = join(home, 'preserve')
      await mkdir(other, { mode: 0o700 })
      await symlink(other, store.directory)
      await expect(store.inspect()).rejects.toThrow('不安全')
    })
  })
  it('persists local-proxy context without allowing context changes or invalid identity fields', async () => {
    await fixture(async (store) => {
      const snapshot = await store.inspect()
      const runtime = {
        kind: 'localProxy' as const,
        httpPort: 18191,
        profileId: '00000000-0000-0000-0000-000000000001',
        sourceSHA256: 'a'.repeat(64)
      }
      await expect(
        store.acquire('rule', snapshot.revision, { ...runtime, httpPort: 80 })
      ).rejects.toThrow('无效')
      await expect(
        Reflect.apply(store.acquire, store, [
          'rule',
          snapshot.revision,
          { ...runtime, resolverMode: 'system' }
        ])
      ).rejects.toThrow('DNS模式')
      await expect(stat(store.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      const lease = await store.acquire('rule', snapshot.revision, runtime)
      await lease.update('running', 1234)
      const record = join(store.directory, '.session/owner.json'),
        raw = await readFile(record, 'utf8')
      expect(JSON.parse(raw).runtime).toEqual(runtime)
      const changed = JSON.parse(raw)
      changed.runtime.httpPort = 18192
      await writeFile(record, JSON.stringify(changed))
      await expect(lease.release()).rejects.toThrow('改变')
      await writeFile(record, raw)
      await lease.release()
      expect((await store.inspect()).lease).toBe('missing')
    })
  })
})
