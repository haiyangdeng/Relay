import { randomUUID } from 'crypto'
import { constants, readdirSync, writeFileSync } from 'fs'
import * as fs from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { SmartStateConflict, SmartStateStore, SmartStateWriteUncertain } from './smart-state-store'
import {
  smartStateCSVHeader,
  smartStateDigest,
  smartStateKey,
  smartStateSchema,
  type SmartStateFileData
} from './smart-state-schema'

vi.mock('fs/promises', async (original) => ({
  ...(await original<typeof import('fs/promises')>())
}))

const live = (): void => undefined
const cache = (text: string): SmartStateFileData[] => [
  { path: 'cache.db', bytes: Buffer.from(text) }
]
const both = (text: string, suffix = 'closed disk bytes\npartial'): SmartStateFileData[] => [
  ...cache(text),
  {
    path: 'smart_weight_data.csv',
    bytes: Buffer.concat([smartStateCSVHeader(), Buffer.from(suffix)])
  }
]
async function fixture(
  run: (f: {
    store: SmartStateStore
    context: { home: string; stateRoot: string }
    profile: string
    key: string
    root: string
    head: string
  }) => Promise<void>
): Promise<void> {
  const home = await fs.realpath(await fs.mkdtemp('/private/tmp/relay-smart-state-store-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    profile = randomUUID(),
    key = smartStateKey(profile),
    root = join(context.stateRoot, 'SmartState', key)
  try {
    await run({
      store: new SmartStateStore(context),
      context,
      profile,
      key,
      root,
      head: join(root, 'head.json')
    })
  } finally {
    vi.restoreAllMocks()
    await fs.rm(home, { recursive: true, force: true })
  }
}
afterEach(() => vi.restoreAllMocks())

describe('Main-only immutable Smart state and checked head publication', () => {
  it('prepares detached empty cache and the sole exact header without creating a head or source grant', async () =>
    fixture(async (f) => {
      const off = await f.store.prepare(f.profile, false),
        on = await f.store.prepare(f.profile, true)
      expect(off.receipt).toMatchObject({ version: 1, key: f.key, previousRevision: null })
      expect(off.copyFiles()).toEqual([{ path: 'cache.db', bytes: Buffer.alloc(0) }])
      expect(on.receipt.files.map((x) => x.path)).toEqual(['cache.db', 'smart_weight_data.csv'])
      const header = on.copyFiles()[1].bytes
      expect(header.length).toBe(555)
      expect(smartStateDigest(header)).toBe(smartStateSchema.csvHeaderSHA256)
      expect(header.toString().trimEnd().split(',')).toHaveLength(42)
      expect(Object.isFrozen(on.receipt)).toBe(true)
      expect(Object.isFrozen(on.receipt.files[0])).toBe(true)
      expect(JSON.stringify(on.receipt)).not.toMatch(/executable|sourceGrant|stateRoot|session/u)
      header[0] ^= 1
      expect(on.copyFiles()[1].bytes).toEqual(smartStateCSVHeader())
      await on.recheck()
      await expect(fs.lstat(f.context.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(smartStateKey(f.profile)).toBe(f.key)
      expect(smartStateKey(randomUUID())).not.toBe(f.key)
      await expect(f.store.prepare('../profile', true)).rejects.toThrow()
    }))
  it('commits only fixed detached bytes, reopens the exact immutable revision and preserves older versions', async () =>
    fixture(async (f) => {
      const initial = await f.store.prepare(f.profile, true),
        input = both('first'),
        expected = Buffer.from(input[0].bytes)
      const pending = f.store.commit(f.key, null, input, live)
      input[0].bytes.fill(0)
      const revision = await pending,
        read = await new SmartStateStore(f.context).prepare(f.profile, true)
      expect(read.receipt.previousRevision).toBe(revision)
      expect(read.copyFiles()[0].bytes).toEqual(expected)
      expect((await fs.stat(f.head)).mode & 0o7777).toBe(0o600)
      expect((await fs.stat(f.root)).mode & 0o7777).toBe(0o700)
      expect((await fs.stat(join(f.root, 'versions', revision, 'cache.db'))).mode & 0o7777).toBe(
        0o600
      )
      await read.recheck()
      await expect(initial.recheck()).rejects.toThrow()
      const next = await f.store.commit(f.key, revision, both('second'), live)
      expect(next).not.toBe(revision)
      expect(await fs.readFile(join(f.root, 'versions', revision, 'cache.db'))).toEqual(expected)
      await expect(read.recheck()).rejects.toThrow(SmartStateConflict)
    }))
  it('retains an existing CSV master while collection is off, including its known partial tail', async () =>
    fixture(async (f) => {
      const original = both('one'),
        first = await f.store.commit(f.key, null, original, live)
      const off = await f.store.prepare(f.profile, false)
      expect(off.copyFiles().map((x) => x.path)).toEqual(['cache.db'])
      const next = await f.store.commit(f.key, first, cache('two'), live),
        reopened = await f.store.prepare(f.profile, true)
      expect(reopened.receipt.previousRevision).toBe(next)
      expect(reopened.copyFiles()[1].bytes).toEqual(original[1].bytes)
      expect(await fs.readFile(join(f.root, 'versions', first, 'smart_weight_data.csv'))).toEqual(
        original[1].bytes
      )
    }))
  it('adds the correct initial header when collection is first enabled on a cache-only head', async () =>
    fixture(async (f) => {
      const revision = await f.store.commit(f.key, null, cache('cache-only'), live)
      const prepared = await f.store.prepare(f.profile, true)
      expect(prepared.receipt.previousRevision).toBe(revision)
      expect(prepared.copyFiles()[1].bytes).toEqual(smartStateCSVHeader())
      expect(await fs.readdir(join(f.root, 'versions', revision))).toEqual(
        expect.not.arrayContaining(['smart_weight_data.csv'])
      )
    }))
  it('allows an empty cache to remain a valid opaque seed', async () =>
    fixture(async (f) => {
      const revision = await f.store.commit(
        f.key,
        null,
        [{ path: 'cache.db', bytes: Buffer.alloc(0) }],
        live
      )
      const prepared = await f.store.prepare(f.profile, false)
      expect(prepared.receipt.previousRevision).toBe(revision)
      expect(prepared.receipt.files[0]).toEqual({
        path: 'cache.db',
        size: 0,
        sha256: smartStateDigest(Buffer.alloc(0))
      })
      await prepared.recheck()
    }))
  it('serializes separate instances and refuses a competing expected revision before creating a second version', async () =>
    fixture(async (f) => {
      const guard = vi.fn(live),
        other = new SmartStateStore(f.context)
      const results = await Promise.allSettled([
        f.store.commit(f.key, null, cache('winner'), live),
        other.commit(f.key, null, cache('stale'), guard)
      ])
      expect(results[0].status).toBe('fulfilled')
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: expect.any(SmartStateConflict)
      })
      expect(guard).not.toHaveBeenCalled()
      expect(await fs.readdir(join(f.root, 'versions'))).toHaveLength(1)
      expect((await f.store.prepare(f.profile, false)).copyFiles()[0].bytes.toString()).toBe(
        'winner'
      )
    }))
  it('keeps A-to-B-to-A revisions distinct and rejects an old head CAS', async () =>
    fixture(async (f) => {
      const a = await f.store.commit(f.key, null, cache('A'), live),
        b = await f.store.commit(f.key, a, cache('B'), live),
        again = await f.store.commit(f.key, b, cache('A'), live)
      expect(new Set([a, b, again]).size).toBe(3)
      await expect(f.store.commit(f.key, a, cache('overwrite'), live)).rejects.toThrow(
        SmartStateConflict
      )
    }))
  it('checks a restored caller lease after staging and before head rename, preserving the old master and failed version', async () =>
    fixture(async (f) => {
      const first = await f.store.commit(f.key, null, cache('old'), live),
        head = await fs.readFile(f.head)
      let current = true
      const original = fs.open,
        reached = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>()
      const intercepted = vi
        .spyOn(fs, 'open')
        .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          if (
            typeof args[0] === 'string' &&
            args[0].endsWith('/cache.db') &&
            typeof args[1] === 'number' &&
            args[1] & constants.O_CREAT
          ) {
            reached.resolve()
            await release.promise
          }
          return original(...args)
        })
      const guard = vi.fn(() => {
        expect(readdirSync(join(f.root, 'versions'))).toHaveLength(2)
        if (!current) throw Error('restored')
      })
      const commit = f.store.commit(f.key, first, cache('unpublished'), guard)
      try {
        await reached.promise
        current = false
        release.resolve()
        await expect(commit).rejects.toThrow(SmartStateWriteUncertain)
      } finally {
        release.resolve()
        await commit.catch(() => {})
        intercepted.mockRestore()
      }
      expect(guard).toHaveBeenCalledOnce()
      expect(await fs.readFile(f.head)).toEqual(head)
      expect((await f.store.prepare(f.profile, false)).copyFiles()[0].bytes.toString()).toBe('old')
      expect(await fs.readdir(join(f.root, 'versions'))).toHaveLength(2)
    }))
  it.each(['resolve', 'reject'] as const)(
    'refuses asynchronous %s or missing final guards without publication or unhandled rejection',
    async (outcome) =>
      fixture(async (f) => {
        const first = await f.store.commit(f.key, null, cache('old'), live),
          raw = await fs.readFile(f.head),
          rejections: unknown[] = []
        const rejected = (reason: unknown): void => {
          rejections.push(reason)
        }
        process.on('unhandledRejection', rejected)
        try {
          await expect(
            f.store.commit(f.key, first, cache('next'), async () => {
              if (outcome === 'reject') throw new Error('private guard rejection')
            })
          ).rejects.toThrow(SmartStateWriteUncertain)
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(rejections).toEqual([])
        } finally {
          process.off('unhandledRejection', rejected)
        }
        await expect(
          Reflect.apply(f.store.commit, f.store, [f.key, first, cache('next')])
        ).rejects.toThrow()
        expect(await fs.readFile(f.head)).toEqual(raw)
      })
  )
  it('refuses an unknown staged entry before changing head and does not delete it', async () =>
    fixture(async (f) => {
      const first = await f.store.commit(f.key, null, cache('old'), live),
        before = await fs.readFile(f.head)
      let marker = ''
      await expect(
        f.store.commit(f.key, first, cache('next'), () => {
          const candidate = readdirSync(join(f.root, 'versions')).find((x) => x !== first)
          if (!candidate) throw new Error('Staged version missing')
          marker = join(f.root, 'versions', candidate, 'foreign')
          writeFileSync(marker, 'retain', { mode: 0o600 })
        })
      ).rejects.toThrow(SmartStateWriteUncertain)
      expect(await fs.readFile(f.head)).toEqual(before)
      expect(await fs.readFile(marker, 'utf8')).toBe('retain')
    }))
  it('does not overwrite a current head replaced inside the synchronous caller fence', async () =>
    fixture(async (f) => {
      const first = await f.store.commit(f.key, null, cache('old'), live),
        foreign = Buffer.from('unrecognized head')
      await expect(
        f.store.commit(f.key, first, cache('next'), () => writeFileSync(f.head, foreign))
      ).rejects.toThrow(SmartStateWriteUncertain)
      expect(await fs.readFile(f.head)).toEqual(foreign)
      expect((await fs.readFile(join(f.root, 'versions', first, 'cache.db'))).toString()).toBe(
        'old'
      )
      await expect(f.store.prepare(f.profile, false)).rejects.toThrow()
    }))
  it.each([
    'head-mode',
    'cache-mode',
    'cache-link',
    'head-link',
    'head-symlink',
    'bad-CSV',
    'duplicate-head-field',
    'unknown-current-entry'
  ] as const)('keeps %s corruption fail-closed without repairing the master', async (kind) =>
    fixture(async (f) => {
      const revision = await f.store.commit(f.key, null, both('known'), live),
        version = join(f.root, 'versions', revision),
        head = await fs.readFile(f.head)
      if (kind === 'head-mode') await fs.chmod(f.head, 0o644)
      if (kind === 'cache-mode') await fs.chmod(join(version, 'cache.db'), 0o644)
      if (kind === 'cache-link')
        await fs.link(join(version, 'cache.db'), join(f.context.home, 'second-link'))
      if (kind === 'head-link') await fs.link(f.head, join(f.context.home, 'second-head-link'))
      if (kind === 'head-symlink') {
        await fs.writeFile(join(f.context.home, 'head-copy'), head, { mode: 0o600 })
        await fs.unlink(f.head)
        await fs.symlink(join(f.context.home, 'head-copy'), f.head)
      }
      if (kind === 'bad-CSV')
        await fs.writeFile(join(version, 'smart_weight_data.csv'), 'bad header')
      if (kind === 'duplicate-head-field')
        await fs.writeFile(
          f.head,
          '{"version":2,"version":1,"key":"' + f.key + '","revision":"' + revision + '"}'
        )
      if (kind === 'unknown-current-entry')
        await fs.writeFile(join(version, 'foreign'), 'keep', { mode: 0o600 })
      const before = (await fs.readdir(version)).sort()
      await expect(f.store.prepare(f.profile, false)).rejects.toThrow()
      await expect(f.store.commit(f.key, revision, cache('overwrite'), live)).rejects.toThrow()
      expect((await fs.readdir(version)).sort()).toEqual(before)
      expect(await fs.readFile(join(version, 'cache.db'))).toEqual(Buffer.from('known'))
    })
  )
  it('refuses a pre-existing incomplete namespace instead of creating a fresh initial head', async () =>
    fixture(async (f) => {
      await fs.mkdir(join(f.root, 'versions'), { recursive: true, mode: 0o700 })
      await expect(f.store.prepare(f.profile, true)).rejects.toThrow()
      await expect(f.store.commit(f.key, null, cache('new'), live)).rejects.toThrow()
      expect(await fs.readdir(f.root)).toEqual(['versions'])
    }))
  it.each(['parent-mode', 'parent-symlink'] as const)(
    'rejects %s without adjusting it',
    async (kind) =>
      fixture(async (f) => {
        await f.store.commit(f.key, null, cache('known'), live)
        const parent = join(f.context.stateRoot, 'SmartState')
        if (kind === 'parent-mode') await fs.chmod(parent, 0o755)
        else {
          await fs.rename(parent, parent + '-known')
          await fs.symlink(parent + '-known', parent)
        }
        const before = await fs.lstat(parent)
        await expect(f.store.prepare(f.profile, true)).rejects.toThrow()
        const after = await fs.lstat(parent)
        expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode])
      })
  )
  it('revokes a prepared seed when the state ancestor is replaced even with the same subtree bytes', async () =>
    fixture(async (f) => {
      await f.store.commit(f.key, null, both('known'), live)
      const prepared = await f.store.prepare(f.profile, true),
        old = f.context.stateRoot + '-old'
      await fs.rename(f.context.stateRoot, old)
      await fs.mkdir(f.context.stateRoot, { mode: 0o700 })
      await fs.rename(join(old, 'SmartState'), join(f.context.stateRoot, 'SmartState'))
      await expect(prepared.recheck()).rejects.toThrow()
    }))
  it.each([
    'bad-key',
    'bad-revision',
    'missing-cache',
    'duplicate',
    'traversal',
    'bad-header',
    'oversize'
  ] as const)('rejects %s input before mutating a known head', async (kind) =>
    fixture(async (f) => {
      const revision = await f.store.commit(f.key, null, both('known'), live),
        head = await fs.readFile(f.head),
        versions = await fs.readdir(join(f.root, 'versions'))
      let key = f.key,
        expected: string | null = revision,
        data: unknown = cache('next')
      if (kind === 'bad-key') key = '../key'
      if (kind === 'bad-revision') expected = 'bad'
      if (kind === 'missing-cache')
        data = [{ path: 'smart_weight_data.csv', bytes: smartStateCSVHeader() }]
      if (kind === 'duplicate') data = [...cache('a'), ...cache('b')]
      if (kind === 'traversal') data = [{ path: '../cache.db', bytes: Buffer.from('a') }]
      if (kind === 'bad-header')
        data = [...cache('a'), { path: 'smart_weight_data.csv', bytes: Buffer.alloc(555) }]
      if (kind === 'oversize')
        data = [{ path: 'cache.db', bytes: Buffer.alloc(smartStateSchema.fileByteLimit + 1) }]
      await expect(
        Reflect.apply(f.store.commit, f.store, [key, expected, data, live])
      ).rejects.toThrow()
      expect(await fs.readFile(f.head)).toEqual(head)
      expect(await fs.readdir(join(f.root, 'versions'))).toEqual(versions)
    })
  )
})

it('rejects a missing context home without treating it as a first state namespace', async () =>
  fixture(async (f) => {
    const moved = f.context.home + '-known'
    await fs.rename(f.context.home, moved)
    try {
      await expect(f.store.prepare(f.profile, true)).rejects.toThrow()
    } finally {
      await fs.rename(moved, f.context.home)
    }
  }))

it('retains the old master and failed immutable copy on a file fsync failure', async () =>
  fixture(async (f) => {
    const revision = await f.store.commit(f.key, null, cache('old'), live),
      head = await fs.readFile(f.head),
      original = fs.open
    const intercepted = vi
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const file = await original(...args)
        if (
          typeof args[0] === 'string' &&
          args[0].endsWith('/cache.db') &&
          typeof args[1] === 'number' &&
          args[1] & constants.O_CREAT
        )
          vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('private fsync failure'))
        return file
      })
    await expect(f.store.commit(f.key, revision, cache('failed copy'), live)).rejects.toThrow(
      SmartStateWriteUncertain
    )
    intercepted.mockRestore()
    expect(await fs.readFile(f.head)).toEqual(head)
    expect(await fs.readFile(join(f.root, 'versions', revision, 'cache.db'))).toEqual(
      Buffer.from('old')
    )
    expect(await fs.readdir(join(f.root, 'versions'))).toHaveLength(2)
    expect((await f.store.prepare(f.profile, false)).copyFiles()[0].bytes).toEqual(
      Buffer.from('old')
    )
  }))

it('reports post-rename directory-sync uncertainty without deleting either immutable revision', async () =>
  fixture(async (f) => {
    const revision = await f.store.commit(f.key, null, cache('old'), live),
      original = SubscriptionFiles.prototype.sync
    const sync = vi.spyOn(SubscriptionFiles.prototype, 'sync').mockImplementation(async function (
      this: SubscriptionFiles,
      path: string
    ) {
      if (path === f.root) throw new Error('private post-rename fsync failure')
      await original.call(this, path)
    })
    let failure: unknown
    try {
      await f.store.commit(f.key, revision, cache('new'), live)
    } catch (error) {
      failure = error
    }
    sync.mockRestore()
    expect(failure).toBeInstanceOf(SmartStateWriteUncertain)
    const head = JSON.parse(await fs.readFile(f.head, 'utf8')) as { revision: string }
    expect(head.revision).not.toBe(revision)
    expect((failure as SmartStateWriteUncertain).attemptedRevision).toBe(head.revision)
    expect(await fs.readFile(join(f.root, 'versions', revision, 'cache.db'))).toEqual(
      Buffer.from('old')
    )
    expect(await fs.readFile(join(f.root, 'versions', head.revision, 'cache.db'))).toEqual(
      Buffer.from('new')
    )
    expect(await fs.readdir(join(f.root, 'versions'))).toHaveLength(2)
  }))
