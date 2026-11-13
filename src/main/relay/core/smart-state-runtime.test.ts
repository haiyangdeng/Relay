import { randomUUID } from 'crypto'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  truncate,
  writeFile
} from 'fs/promises'
import { createServer, type Server } from 'net'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SmartStateStore } from './smart-state-store'
import { smartStateCSVHeader, smartStateKey } from './smart-state-schema'
import { SmartLearningRuntime, type SmartLearningContext } from './smart-state-runtime'

const fixtures: { home: string; runtime?: SmartLearningRuntime; server?: Server }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    await f.runtime?.finish(false)
    if (f.server)
      await new Promise<void>((resolve, reject) =>
        f.server?.close((error) => (error ? reject(error) : resolve()))
      )
    // These fresh private fixtures and every injected "foreign" inode were
    // created by this test. Runtime source itself has no recursive remove.
    await rm(f.home, { recursive: true, force: true })
  }
})
const configuration = (collectdata: boolean) => ({
  'proxy-groups': [{ name: 'S', type: 'smart', collectdata }]
})
async function fixture(collect = true, profileUUID = randomUUID()) {
  const home = await realpath(await mkdtemp('/private/tmp/relay-owned-state-fs-')),
    directory = join(home, 'runtime'),
    store = new SmartStateStore({
      home,
      stateRoot: join(home, 'Library/Application Support/Relay-Preview')
    })
  await mkdir(directory, { mode: 0o700 })
  const tracked: { home: string; runtime?: SmartLearningRuntime; server?: Server } = { home }
  fixtures.push(tracked)
  let live = true,
    publishable = true
  const context: SmartLearningContext = {
    profileUUID,
    store,
    assertOwner: () => {
      if (!live) throw new Error('restore revoked owner')
    },
    mayPersist: () => publishable
  }
  const start = async (): Promise<SmartLearningRuntime> => {
    const runtime = await SmartLearningRuntime.prepare(directory, configuration(collect), context)
    tracked.runtime = runtime
    await runtime.writeImmutable('config.yaml', Buffer.from('controlled configuration'))
    await runtime.writeImmutable('Model.bin', Buffer.from('immutable fixture model'))
    await runtime.verifyBeforeLaunch()
    runtime.markReady()
    return runtime
  }
  const change = async (name: string, bytes: Buffer): Promise<void> => {
    const file = await open(join(directory, name), 'r+')
    try {
      await file.truncate(0)
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  const coreNames = (): Promise<string[]> =>
    import('fs/promises').then((fs) => fs.readdir(directory))
  const head = join(
    home,
    'Library/Application Support/Relay-Preview/SmartState',
    smartStateKey(profileUUID),
    'head.json'
  )
  return {
    home,
    directory,
    profileUUID,
    store,
    context,
    tracked,
    start,
    change,
    coreNames,
    head,
    revoke: () => {
      live = false
    },
    forbidSave: () => {
      publishable = false
    }
  }
}

describe('Private ordinary Smart state owner using actual files, no Core', () => {
  it('captures UUID, store and guard function references before pending prepare can retarget the input DTO', async () => {
    const f = await fixture(),
      other = await fixture(),
      prepare = f.store.prepare.bind(f.store)
    let release: () => void = () => undefined,
      entered: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve
      })
    const pending = vi.spyOn(f.store, 'prepare').mockImplementation(async (...args) => {
      const value = await prepare(...args)
      entered()
      await gate
      return value
    })
    const starting = f.start()
    await Promise.race([
      ready,
      starting.then(() => {
        throw new Error('prepare unexpectedly finished')
      })
    ])
    Object.assign(f.context, {
      profileUUID: other.profileUUID,
      store: other.store,
      assertOwner: () => {
        throw new Error('replacement DTO guard must not retarget the old owner')
      },
      mayPersist: () => false
    })
    release()
    const runtime = await starting
    pending.mockRestore()
    expect(f.context.profileUUID).toBe(other.profileUUID)
    expect(runtime.binding.profileUUID).toBe(f.profileUUID)
    await f.change('cache.db', Buffer.from('learned by original profile'))
    expect((await runtime.finish(true)).status).toBe('persisted')
    expect((await f.store.prepare(f.profileUUID, false)).copyFiles()[0].bytes).toEqual(
      Buffer.from('learned by original profile')
    )
    expect((await other.store.prepare(f.profileUUID, false)).receipt.previousRevision).toBeNull()
  })
  it('keeps first seed inert, saves exact closed bytes, removes only created files and restores the same UUID', async () => {
    const f = await fixture(),
      runtime = await f.start(),
      cache = Buffer.from('opaque learned bytes'),
      csv = Buffer.concat([smartStateCSVHeader(), Buffer.from('known partial tail')])
    await expect(lstat(f.head)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.change('cache.db', cache)
    await f.change('smart_weight_data.csv', csv)
    const report = await runtime.finish(true)
    expect(report).toMatchObject({ status: 'persisted', retainedEvidence: true })
    expect(await f.coreNames()).toEqual([])
    expect((await lstat(f.directory)).isDirectory()).toBe(true)
    const saved = await f.store.prepare(f.profileUUID, true)
    expect(saved.copyFiles()).toEqual([
      { path: 'cache.db', bytes: cache },
      { path: 'smart_weight_data.csv', bytes: csv }
    ])
    const second = join(f.home, 'second')
    await mkdir(second, { mode: 0o700 })
    const restored = await SmartLearningRuntime.prepare(second, configuration(true), f.context)
    try {
      expect(await readFile(join(second, 'cache.db'))).toEqual(cache)
      expect(await readFile(join(second, 'smart_weight_data.csv'))).toEqual(csv)
    } finally {
      await restored.finish(false)
    }
    expect(Object.isFrozen(runtime.binding)).toBe(true)
  })
  it('isolates another profile UUID and retains an old CSV master during a CSV-off session', async () => {
    const f = await fixture(false),
      csv = Buffer.concat([smartStateCSVHeader(), Buffer.from('old tail')])
    await f.store.commit(
      smartStateKey(f.profileUUID),
      null,
      [
        { path: 'cache.db', bytes: Buffer.from('old') },
        { path: 'smart_weight_data.csv', bytes: csv }
      ],
      () => undefined
    )
    const runtime = await f.start()
    await expect(lstat(join(f.directory, 'smart_weight_data.csv'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await f.change('cache.db', Buffer.from('new cache'))
    expect((await runtime.finish(true)).status).toBe('persisted')
    expect((await f.store.prepare(f.profileUUID, true)).copyFiles()[1].bytes).toEqual(csv)
    const other = await f.store.prepare(randomUUID(), true)
    expect(other.receipt.previousRevision).toBeNull()
    expect(other.copyFiles()).toEqual([
      { path: 'cache.db', bytes: Buffer.alloc(0) },
      { path: 'smart_weight_data.csv', bytes: smartStateCSVHeader() }
    ])
  })
  it.each(['not reaped normally', 'not admitted'])(
    'keeps the old head and whole workspace for %s',
    async (reason) => {
      const f = await fixture(),
        runtime = await f.start()
      if (reason === 'not admitted') f.forbidSave()
      const before = await f.coreNames(),
        report = await runtime.finish(reason !== 'not reaped normally')
      expect(report.status).toBe('retained')
      expect(await f.coreNames()).toEqual(before)
      await expect(lstat(f.head)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )
  it('does not invoke a launch seed recheck after readiness or during the closed save', async () => {
    const f = await fixture(),
      original = f.store.prepare.bind(f.store),
      checks: ReturnType<typeof vi.fn>[] = []
    vi.spyOn(f.store, 'prepare').mockImplementation(async (...args) => {
      const value = await original(...args),
        check = vi.fn(value.recheck)
      checks.push(check)
      return { ...value, recheck: check }
    })
    const runtime = await f.start(),
      check = checks[0],
      before = check.mock.calls.length
    check.mockRejectedValue(new Error('old launch receipt must not be used at stop'))
    expect((await runtime.finish(true)).status).toBe('persisted')
    expect(check.mock.calls.length).toBe(before)
  })
  it('rejects restore revocation and preserves the whole workspace', async () => {
    const f = await fixture(),
      runtime = await f.start(),
      before = await f.coreNames()
    f.revoke()
    expect((await runtime.finish(true)).status).toBe('retained')
    expect(await f.coreNames()).toEqual(before)
    await expect(lstat(f.head)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not relabel a learning owner or change CSV capability during a hot reload', async () => {
    const f = await fixture(),
      runtime = await f.start()
    expect(() => runtime.assertReload(f.profileUUID, configuration(true))).not.toThrow()
    expect(() => runtime.assertReload(randomUUID(), configuration(true))).toThrow('明确停止')
    expect(() => runtime.assertReload(f.profileUUID, configuration(false))).toThrow('明确停止')
    expect(runtime.binding.profileUUID).toBe(f.profileUUID)
  })
  it.each(['cache.db.bak', 'foreign'])(
    'retains every runtime file when an unknown %s appears',
    async (name) => {
      const f = await fixture(),
        runtime = await f.start()
      await writeFile(join(f.directory, name), 'foreign', { flag: 'wx', mode: 0o600 })
      const before = await f.coreNames()
      expect((await runtime.finish(true)).status).toBe('retained')
      expect(await f.coreNames()).toEqual(before)
      await expect(lstat(f.head)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )
  it('allows only an unowned small socket residue and never unlinks or authenticates it', async () => {
    const f = await fixture(),
      runtime = await f.start(),
      path = join(f.directory, 'api.sock'),
      server = createServer()
    f.tracked.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    await chmod(path, 0o666)
    const before = await lstat(path)
    expect((await runtime.finish(true)).status).toBe('persisted')
    const after = await lstat(path)
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
    expect(await f.coreNames()).toEqual(['api.sock'])
  })
  it('does not treat a regular file named api.sock as that permitted residue', async () => {
    const f = await fixture(),
      runtime = await f.start()
    await writeFile(join(f.directory, 'api.sock'), 'foreign', { flag: 'wx', mode: 0o600 })
    const before = await f.coreNames()
    expect((await runtime.finish(true)).status).toBe('retained')
    expect(await f.coreNames()).toEqual(before)
  })
  it.each(['replacement', 'hardlink', 'mode', 'CSV header', 'budget', 'immutable body'])(
    'refuses %s and unlinks nothing',
    async (reason) => {
      const f = await fixture(),
        runtime = await f.start(),
        cache = join(f.directory, 'cache.db')
      if (reason === 'replacement') {
        await rename(cache, join(f.home, 'retained-cache'))
        await writeFile(cache, Buffer.alloc(0), { flag: 'wx', mode: 0o600 })
      }
      if (reason === 'hardlink') await link(cache, join(f.home, 'outside-cache'))
      if (reason === 'mode') await chmod(cache, 0o644)
      if (reason === 'CSV header') await f.change('smart_weight_data.csv', Buffer.alloc(555))
      if (reason === 'budget') await truncate(cache, 128 * 1024 * 1024 + 1)
      if (reason === 'immutable body')
        await f.change('Model.bin', Buffer.from('changed immutable model'))
      const before = await f.coreNames()
      expect((await runtime.finish(true)).status).toBe('retained')
      expect(await f.coreNames()).toEqual(before)
      await expect(lstat(f.head)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )
  it('CAS conflict preserves the competing head and every old runtime file', async () => {
    const f = await fixture(),
      runtime = await f.start(),
      other = await f.store.commit(
        smartStateKey(f.profileUUID),
        null,
        [{ path: 'cache.db', bytes: Buffer.from('other') }],
        () => undefined
      ),
      before = await f.coreNames()
    expect((await runtime.finish(true)).status).toBe('retained')
    expect(await f.coreNames()).toEqual(before)
    expect((await f.store.prepare(f.profileUUID, false)).receipt.previousRevision).toBe(other)
  })
  it.each(['unknown after snapshot', 'changed same FD after snapshot', 'revoked owner'])(
    'runs the dedicated closed snapshot fence for %s',
    async (reason) => {
      const f = await fixture(),
        runtime = await f.start(),
        commit = f.store.commit.bind(f.store)
      vi.spyOn(f.store, 'commit').mockImplementation(async (...args) => {
        if (reason === 'unknown after snapshot')
          await writeFile(join(f.directory, 'foreign'), 'foreign', { flag: 'wx', mode: 0o600 })
        if (reason === 'changed same FD after snapshot')
          await f.change('cache.db', Buffer.from('changed after capture'))
        if (reason === 'revoked owner') f.revoke()
        return commit(...args)
      })
      expect((await runtime.finish(true)).status).toBe('retained')
      expect(await f.coreNames()).toContain('config.yaml')
      await expect(lstat(f.head)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )
  it('keeps a known save ACK separate from later cleanup failure', async () => {
    const f = await fixture(),
      runtime = await f.start(),
      commit = f.store.commit.bind(f.store)
    vi.spyOn(f.store, 'commit').mockImplementation(async (...args) => {
      const revision = await commit(...args)
      await writeFile(join(f.directory, 'foreign-after-ACK'), 'foreign', {
        flag: 'wx',
        mode: 0o600
      })
      return revision
    })
    expect(await runtime.finish(true)).toMatchObject({
      status: 'persisted',
      cleanupFailed: true,
      retainedEvidence: true
    })
    expect(await f.coreNames()).toContain('Model.bin')
    expect((await f.store.prepare(f.profileUUID, true)).receipt.previousRevision).not.toBeNull()
  })
  it('does not grow the creator roster after the closed snapshot or publish changed late immutable evidence', async () => {
    const f = await fixture(),
      runtime = await f.start(),
      commit = f.store.commit.bind(f.store),
      name = 'reload-' + randomUUID() + '.json'
    vi.spyOn(f.store, 'commit').mockImplementation(async (...args) => {
      await runtime.writeImmutable(name, Buffer.from('late registered evidence'))
      await f.change(name, Buffer.from('changed after its own sealed read'))
      return commit(...args)
    })
    const report = await runtime.finish(true)
    const phase = process.env.RELAY_OWNED_ROSTER_PHASE ?? 'after'
    if (!['before', 'after'].includes(phase)) throw new Error('invalid private roster proof phase')
    await writeFile(
      join(
        process.env.RELAY_OWNED_PROOF_OUTPUT ??
          join(process.cwd(), '.relay-build/private/p34-smart-state-owned-runtime-20261103'),
        `growing-roster-${phase}-facts.json`
      ),
      JSON.stringify(
        {
          report,
          coreNames: await f.coreNames(),
          headPresent: await lstat(f.head).then(
            () => true,
            () => false
          ),
          CoreExecuted: false
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
    expect(report.status).toBe('retained')
    expect(await f.coreNames()).toContain('Model.bin')
    await expect(lstat(f.head)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('never retries an uncertain commit or turns a fresh head read into lost-ACK success', async () => {
    const f = await fixture(),
      runtime = await f.start(),
      commit = f.store.commit.bind(f.store),
      call = vi.spyOn(f.store, 'commit').mockImplementation(async (...args) => {
        await commit(...args)
        throw new Error('private lost ACK')
      })
    const first = await runtime.finish(true),
      before = await f.coreNames()
    expect(first.status).toBe('retained')
    expect(await runtime.finish(true)).toBe(first)
    expect(call).toHaveBeenCalledOnce()
    expect(await f.coreNames()).toEqual(before)
    expect((await f.store.prepare(f.profileUUID, true)).receipt.previousRevision).not.toBeNull()
  })
  it('consumes an invalid async owner rejection without publishing or leaking an unhandled rejection', async () => {
    const f = await fixture(),
      observed: unknown[] = [],
      listener = (value: unknown): void => {
        observed.push(value)
      }
    f.context.assertOwner = async () => {
      throw new Error('invalid async owner')
    }
    process.on('unhandledRejection', listener)
    try {
      await expect(f.start()).rejects.toThrow()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(observed).toEqual([])
      await expect(lstat(f.head)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      process.removeListener('unhandledRejection', listener)
    }
  })
})
