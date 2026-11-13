import { createHash } from 'crypto'
import { lstat, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { requestOnce } from '../../resolve/plugin/http-client'
import { generateAgeKeyPair } from '../../utils/age'
import type { RelayWebdavBackupScope } from '../../../shared/relay/backup-scheduler'
import { backupAccountsFixture, webdavAccount } from './accounts.test-fixture'
import { createRemoteBackupTransport } from './remote'
import { RelayBackupStore } from './store'
import { createWebdavBackupScheduler, type WebdavBackupSchedulePermit } from './webdav-scheduler'
import { RelayWebdavReceiptStore } from './webdav-receipts'
import { createWebdavSessionRetention } from './webdav-retention'

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const response = (status: number, bytes = Buffer.alloc(0), etag?: string) => ({
  status,
  bytes,
  body: '',
  headers: etag ? { etag } : {}
})
type Stored = { bytes: Buffer; etag: string }
type AccountsFixture = Parameters<Parameters<typeof backupAccountsFixture>[0]>[0]
async function setup(f: AccountsFixture, recipient?: string) {
  const account = await f.store.save({ ...webdavAccount, ...(recipient ? { recipient } : {}) }),
    files = new Map<string, Stored>(),
    created: string[] = [],
    authorize = vi.fn(
      async (scope: RelayWebdavBackupScope): Promise<WebdavBackupSchedulePermit | undefined> => {
        let active = true
        return {
          permission: structuredClone(scope),
          isLive: () => active && contextLive,
          credential: (signal) => {
            if (signal.aborted) throw new Error('revoked')
            return f.store.credential({ id: scope.id, revision: scope.revision })
          },
          revoke: () => {
            active = false
          }
        }
      }
    )
  let contextLive = true,
    serial = 0
  const request = vi.fn<typeof requestOnce>(async (url, options) => {
      const stored = files.get(url)
      if (options.method === 'PUT') {
        if (stored) return response(412)
        expect(options.headers?.['If-None-Match']).toBe('*')
        const value = { bytes: Buffer.from(options.body ?? ''), etag: '"created-' + ++serial + '"' }
        files.set(url, value)
        created.push(url)
        return response(201, Buffer.alloc(0), value.etag)
      }
      if (options.method === 'GET') {
        if (!stored) return response(404)
        if (options.headers?.['If-Match'] && options.headers['If-Match'] !== stored.etag)
          return response(412)
        return response(200, Buffer.from(stored.bytes), stored.etag)
      }
      if (options.method === 'PROPFIND') {
        if (!stored) return response(404)
        return response(
          207,
          Buffer.from(
            `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${url}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${stored.bytes.length}</d:getcontentlength><d:getetag>${stored.etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
          )
        )
      }
      if (options.method === 'DELETE') {
        if (!stored || options.headers?.['If-Match'] !== stored.etag) return response(412)
        files.delete(url)
        return response(204)
      }
      if (options.method === 'HEAD') return response(stored ? 200 : 404)
      throw new Error('unexpected method')
    }),
    actual = createRemoteBackupTransport(request),
    upload = vi.fn(actual.upload),
    backups = new RelayBackupStore(f.context),
    receiptAdapters: ConstructorParameters<typeof RelayWebdavReceiptStore>[1] = {
      createDirectory: async ({ id }) => {
        const directory = join(f.context.stateRoot, 'RemoteBackupReceipts', id)
        await mkdir(join(f.context.stateRoot, 'RemoteBackupReceipts'), {
          mode: 0o700,
          recursive: true
        })
        await mkdir(directory, { mode: 0o700 })
        const info = await lstat(directory)
        return { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode }
      },
      publish: async ({ id, name, bytes }) => {
        await writeFile(join(f.context.stateRoot, 'RemoteBackupReceipts', id, name), bytes, {
          flag: 'wx',
          mode: 0o600
        })
      }
    },
    receipts = new RelayWebdavReceiptStore(f.context, receiptAdapters),
    makeScheduler = (store = receipts) =>
      createWebdavBackupScheduler({
        accounts: f.store,
        backups,
        receipts: store,
        authorize,
        canRun: () => true,
        timeZone: () => 'UTC',
        transport: { upload, deleteOwned: actual.deleteOwned }
      }),
    scheduler = makeScheduler()
  return {
    account,
    files,
    created,
    authorize,
    request,
    actual,
    backups,
    upload,
    scheduler,
    receipts,
    binding: {
      accountId: account.id,
      directoryURL: account.directoryURL ?? '',
      username: account.username ?? ''
    },
    restart: () => makeScheduler(new RelayWebdavReceiptStore(f.context, receiptAdapters)),
    restoreContext: () => {
      contextLive = true
    },
    loseContext: () => {
      contextLive = false
    },
    arm: (keepCount?: number) =>
      scheduler.arm({
        id: account.id,
        revision: account.revision,
        schedule: { kind: 'interval', minutes: 1 },
        ...(keepCount === undefined ? {} : { retention: { kind: 'session-owned', keepCount } })
      })
  }
}
async function fixture(
  run: (f: AccountsFixture & Awaited<ReturnType<typeof setup>>) => Promise<void>,
  recipient?: string
) {
  await backupAccountsFixture(async (f) => {
    const api = await setup(f, recipient)
    try {
      await run({ ...f, ...api })
    } finally {
      await api.scheduler.requestClose()
    }
  })
}
async function tick(scheduler: ReturnType<typeof createWebdavBackupScheduler>, ms = 60000) {
  await vi.advanceTimersByTimeAsync(ms)
  await scheduler.whenIdle()
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Explicit recorded-owned WebDAV retention across fresh scheduler sessions', () => {
  const arm = (
    scheduler: ReturnType<typeof createWebdavBackupScheduler>,
    account: { id: string; revision: string },
    keepCount = 1
  ) =>
    scheduler.arm({
      id: account.id,
      revision: account.revision,
      schedule: { kind: 'interval', minutes: 1 },
      retention: { kind: 'recorded-owned', keepCount }
    })
  it('imports only persisted verified receipts after fresh Native consent and never scans or adopts an unrelated file', async () => {
    await fixture(async (f) => {
      f.files.set('https://dav.example/foreign.json', {
        bytes: Buffer.from('foreign'),
        etag: '"foreign"'
      })
      await arm(f.scheduler, f.account, 2)
      await tick(f.scheduler)
      await tick(f.scheduler)
      const old = [...f.created]
      await f.scheduler.requestClose()
      const next = f.restart()
      try {
        const result = await arm(next, f.account)
        expect(result.status).toBe('armed')
        expect(f.authorize.mock.calls.at(-1)?.[0].history).toMatchObject({
          ownedCount: 2,
          uncertainCount: 0,
          headSHA256: expect.stringMatching(/^[a-f0-9]{64}$/u)
        })
        expect(f.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(
          0
        )
        await tick(next)
        expect(
          f.request.mock.calls.filter(([, input]) => input.method === 'DELETE').map(([url]) => url)
        ).toEqual(old)
        expect(f.files.has('https://dav.example/foreign.json')).toBe(true)
        expect(next.state().entries[0]).toMatchObject({
          lastResult: 'uploaded',
          retention: {
            kind: 'recorded-owned',
            ownedCount: 1,
            protectedCount: 1,
            deletedCount: 2,
            uncertainCount: 0
          }
        })
        const inventory = await f.receipts.inspect(f.binding)
        expect(inventory.owned.map((item) => item.url)).toEqual([f.created[2]])
        expect(inventory.uncertain).toEqual([])
        expect(
          f.request.mock.calls.every(
            ([, input]) => input.method !== 'PROPFIND' || input.headers?.Depth === '0'
          )
        ).toBe(true)
      } finally {
        await next.requestClose()
      }
    })
  })
  it('cancels before opening a ledger and rejects a head changed while Native consent was pending', async () => {
    await fixture(async (f) => {
      const inspect = vi.spyOn(f.receipts, 'inspect'),
        open = vi.spyOn(f.receipts, 'open')
      f.authorize.mockResolvedValueOnce(undefined)
      expect((await arm(f.scheduler, f.account)).status).toBe('cancelled')
      expect(inspect).toHaveBeenCalledOnce()
      expect(open).not.toHaveBeenCalled()
      const original = f.authorize.getMockImplementation()
      if (!original) throw new Error('permit fixture missing')
      const entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>()
      f.authorize.mockImplementationOnce(async (scope) => {
        entered.resolve()
        await finish.promise
        return original(scope)
      })
      const pending = arm(f.scheduler, f.account)
      await entered.promise
      await f.receipts.open(f.binding, null)
      finish.resolve()
      await expect(pending).rejects.toThrow('已变化')
      expect(f.request).not.toHaveBeenCalled()
      expect(f.created).toEqual([])
    })
  })
  it.each(['before-run', 'archive'] as const)(
    'stops before network when another process appends during %s',
    async (stage) => {
      await fixture(async (f) => {
        await arm(f.scheduler, f.account, 2)
        await tick(f.scheduler)
        await f.scheduler.disarm({ id: f.account.id })
        await arm(f.scheduler, f.account)
        const entered = Promise.withResolvers<void>(),
          finish = Promise.withResolvers<void>(),
          archive = f.backups.archive.bind(f.backups),
          before = f.request.mock.calls.length
        if (stage === 'archive') {
          vi.spyOn(f.backups, 'archive').mockImplementationOnce(async () => {
            entered.resolve()
            await finish.promise
            return archive()
          })
          await vi.advanceTimersByTimeAsync(60000)
          await entered.promise
        }
        const history = await f.receipts.inspect(f.binding)
        if (!history.headSHA256) throw new Error('head missing')
        await f.receipts.beginDeletion(f.binding, history.headSHA256, history.owned[0].url)
        if (stage === 'archive') {
          finish.resolve()
          await f.scheduler.whenIdle()
        } else await tick(f.scheduler)
        expect(f.request).toHaveBeenCalledTimes(before)
        expect(f.scheduler.state().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'failed'
        })
      })
    }
  )
  it('records a new upload durably before granting any deletion and preserves upload success if publication fails', async () => {
    await fixture(async (f) => {
      await arm(f.scheduler, f.account)
      await tick(f.scheduler)
      vi.spyOn(f.receipts, 'recordUploaded').mockRejectedValueOnce(
        new Error('PRIVATE ledger write failed')
      )
      await tick(f.scheduler)
      expect(f.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(0)
      expect(f.files.has(f.created[0])).toBe(true)
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastResult: 'uploaded',
        lastStatus: 'retentionFailed',
        retention: { deletedCount: 0 }
      })
      expect((await f.receipts.inspect(f.binding)).owned.map((item) => item.url)).toEqual([
        f.created[0]
      ])
      expect(JSON.stringify(f.scheduler.state())).not.toContain('PRIVATE')
    })
  })
  it('persists an intent before checking the old file and returns a zero-DELETE conflict to original upload order', async () => {
    await fixture(async (f) => {
      await arm(f.scheduler, f.account)
      await tick(f.scheduler)
      const original = f.request.getMockImplementation()
      if (!original) throw new Error('request missing')
      let checkedIntent = false
      f.request.mockImplementation(async (url, input) => {
        if (url === f.created[0] && input.method === 'PROPFIND') {
          const history = await f.receipts.inspect(f.binding)
          expect(history.uncertain.map((item) => item.url)).toEqual([f.created[0]])
          checkedIntent = true
          return response(503)
        }
        return original(url, input)
      })
      await tick(f.scheduler)
      expect(checkedIntent).toBe(true)
      expect(f.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(0)
      expect((await f.receipts.inspect(f.binding)).owned.map((item) => item.url)).toEqual(f.created)
      expect((await f.receipts.inspect(f.binding)).uncertain).toEqual([])
      expect(f.scheduler.state().entries[0]).toMatchObject({
        lastResult: 'uploaded',
        retention: { lastResult: 'conflict' }
      })
    })
  })
  it('never retries an unconfirmed submitted deletion after a fresh process store and authorization', async () => {
    await fixture(async (f) => {
      await arm(f.scheduler, f.account)
      await tick(f.scheduler)
      const first = f.created[0],
        original = f.request.getMockImplementation()
      if (!original) throw new Error('request missing')
      const entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>()
      f.request.mockImplementationOnce(original)
      f.request.mockImplementation(async (url, input) => {
        if (input.method === 'DELETE') {
          const result = await original(url, input)
          entered.resolve()
          await finish.promise
          return result
        }
        return original(url, input)
      })
      await vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      f.loseContext()
      finish.resolve()
      await f.scheduler.whenIdle()
      expect(f.scheduler.state().entries[0]).toMatchObject({
        lastResult: 'uploaded',
        retention: { lastResult: 'uncertain', uncertainCount: 1 }
      })
      await f.scheduler.requestClose()
      f.restoreContext()
      f.request.mockImplementation(original)
      const next = f.restart()
      try {
        await arm(next, f.account)
        expect(f.authorize.mock.calls.at(-1)?.[0].history?.uncertainCount).toBe(1)
        await tick(next)
        expect(
          f.request.mock.calls.filter(([url, input]) => url === first && input.method === 'DELETE')
        ).toHaveLength(1)
        expect(next.state().entries[0].retention).toMatchObject({
          ownedCount: 1,
          uncertainCount: 1
        })
        expect((await f.receipts.inspect(f.binding)).uncertain.map((item) => item.url)).toEqual([
          first
        ])
      } finally {
        await next.requestClose()
      }
    })
  })
  it('finishes a proven zero-DELETE cancellation as a local fact after Stop and restores the original candidate order', async () => {
    await fixture(async (f) => {
      await arm(f.scheduler, f.account)
      await tick(f.scheduler)
      const original = f.request.getMockImplementation(),
        entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>()
      if (!original) throw new Error('request missing')
      f.request.mockImplementation(async (url, input) => {
        if (url === f.created[0] && input.method === 'GET') {
          entered.resolve()
          await finish.promise
        }
        return original(url, input)
      })
      await vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      const stopping = f.scheduler.disarm({ id: f.account.id })
      finish.resolve()
      await stopping
      expect(f.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(0)
      const history = await f.receipts.inspect(f.binding)
      expect(history.owned.map((item) => item.url)).toEqual(f.created)
      expect(history.uncertain).toEqual([])
      expect(f.scheduler.state().entries[0]).toMatchObject({
        lastStatus: 'stopped',
        lastResult: 'uploaded',
        retention: { lastResult: 'cancelled', uncertainCount: 0 }
      })
    })
  })
  it('preflights upload plus intent and terminal capacity without automatically compacting history', async () => {
    await fixture(async (f) => {
      await arm(f.scheduler, f.account)
      await tick(f.scheduler)
      const inventory = { ...(await f.receipts.inspect(f.binding)), sequence: 9997 },
        scope = structuredClone(f.authorize.mock.calls[0][0])
      scope.history = {
        scopeSHA256: inventory.scopeSHA256,
        headSHA256: inventory.headSHA256,
        ownedCount: inventory.owned.length,
        uncertainCount: inventory.uncertain.length
      }
      vi.spyOn(f.receipts, 'inspect').mockResolvedValue(inventory)
      const helper = createWebdavSessionRetention({
        scope,
        recorded: { store: f.receipts, inventory },
        remove: f.actual.deleteOwned
      })
      const before = f.request.mock.calls.length
      await expect(
        helper.beforeUpload(
          async () => {},
          () => {}
        )
      ).rejects.toThrow('容量不足')
      expect(f.request).toHaveBeenCalledTimes(before)
    })
  })
  it('allows a fresh credential revision to reuse matching facts but rejects a changed directory identity', async () => {
    await fixture(async (f) => {
      await arm(f.scheduler, f.account)
      await tick(f.scheduler)
      await f.scheduler.requestClose()
      const updated = await f.store.save({
          ...webdavAccount,
          id: f.account.id,
          revision: f.account.revision,
          password: 'changed-private-password'
        }),
        next = f.restart()
      try {
        await arm(next, updated)
        expect(f.authorize.mock.calls.at(-1)?.[0].history?.ownedCount).toBe(1)
        await tick(next)
        expect(f.files.has(f.created[0])).toBe(false)
      } finally {
        await next.requestClose()
      }
      const changed = await f.store.save({
          ...webdavAccount,
          id: updated.id,
          revision: updated.revision,
          directoryURL: 'https://different.example/relay/',
          password: 'changed-private-password'
        }),
        other = f.restart(),
        before = f.request.mock.calls.length
      try {
        await expect(arm(other, changed)).rejects.toThrow('来源或目录已变化')
        expect(f.request).toHaveBeenCalledTimes(before)
      } finally {
        await other.requestClose()
      }
    })
  })
})

describe('Only receipts from the explicitly authorized WebDAV retention session', () => {
  it('keeps default grants create-only and requires a strict explicit keep count before Native authorization', async () => {
    await fixture(async (f) => {
      for (const retention of [
        { kind: 'session-owned', keepCount: 0 },
        { kind: 'session-owned', keepCount: 101 },
        { kind: 'session-owned', keepCount: '1' },
        { kind: 'session-owned', keepCount: 1.1 },
        { kind: 'directory', keepCount: 1 },
        { kind: 'session-owned', keepCount: 1, adopt: true }
      ])
        await expect(
          f.scheduler.arm({
            id: f.account.id,
            revision: f.account.revision,
            schedule: { kind: 'interval', minutes: 1 },
            retention
          })
        ).rejects.toThrow()
      expect(f.authorize).not.toHaveBeenCalled()
      await f.arm()
      expect(f.authorize.mock.calls[0][0]).toMatchObject({ delete: false })
      expect(f.authorize.mock.calls[0][0].retention).toBeUndefined()
      await tick(f.scheduler)
      await tick(f.scheduler)
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: true,
        lastResult: 'uploaded'
      })
      expect(f.scheduler.state().entries[0].retention).toBeUndefined()
      expect(f.request.mock.calls.map(([, options]) => options.method)).toEqual([
        'PUT',
        'GET',
        'PUT',
        'GET'
      ])
    })
  })
  it('deletes the oldest actual receipt only after the new upload is confirmed and never lists or adopts foreign files', async () => {
    await fixture(async (f) => {
      const foreign = new URL('relay-foreign-looking.json', webdavAccount.directoryURL).href
      f.files.set(foreign, { bytes: Buffer.from('FOREIGN'), etag: '"foreign"' })
      await f.arm(1)
      expect(f.authorize.mock.calls[0][0]).toMatchObject({
        delete: true,
        retention: { kind: 'session-owned', keepCount: 1 }
      })
      await tick(f.scheduler)
      expect(f.scheduler.state().entries[0].retention).toMatchObject({
        ownedCount: 1,
        protectedCount: 1,
        deletedCount: 0,
        lastResult: 'notNeeded'
      })
      const first = f.created[0],
        oldTag = f.files.get(first)?.etag
      f.request.mockClear()
      await tick(f.scheduler)
      expect(f.request.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
        [f.created[1], 'PUT'],
        [f.created[1], 'GET'],
        [first, 'GET'],
        [first, 'PROPFIND'],
        [first, 'DELETE'],
        [first, 'HEAD']
      ])
      expect(f.request.mock.calls[2][1].headers?.['If-Match']).toBe(oldTag)
      expect(f.request.mock.calls[3][1].headers?.Depth).toBe('0')
      expect(f.request.mock.calls[4][1].headers?.['If-Match']).toBe(oldTag)
      expect(f.files.has(first)).toBe(false)
      expect(f.files.has(f.created[1])).toBe(true)
      expect(f.files.get(foreign)?.bytes.toString()).toBe('FOREIGN')
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: true,
        lastResult: 'uploaded',
        retention: {
          ownedCount: 1,
          protectedCount: 1,
          deletedCount: 1,
          lastResult: 'pruned',
          lastAttemptFilename: new URL(first).pathname.split('/').at(-1)
        }
      })
    })
  })
  it('protects the newest K receipts in completion order across several fresh uploads', async () => {
    await fixture(async (f) => {
      await f.arm(2)
      for (let i = 0; i < 4; i++) await tick(f.scheduler)
      expect(f.created).toHaveLength(4)
      expect(f.created.map((url) => f.files.has(url))).toEqual([false, false, true, true])
      expect(
        f.request.mock.calls.filter(([, o]) => o.method === 'DELETE').map(([url]) => url)
      ).toEqual(f.created.slice(0, 2))
      expect(f.scheduler.state().entries[0].retention).toMatchObject({
        keepCount: 2,
        ownedCount: 2,
        protectedCount: 2,
        deletedCount: 2
      })
    })
  })
  it('never cleans old backups when the new upload is uncertain', async () => {
    await fixture(async (f) => {
      await f.arm(1)
      await tick(f.scheduler)
      const first = f.created[0]
      f.request.mockResolvedValueOnce(response(503))
      await tick(f.scheduler)
      expect(f.files.has(first)).toBe(true)
      expect(f.request.mock.calls.some(([, o]) => o.method === 'DELETE')).toBe(false)
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastResult: 'uncertain'
      })
    })
  })
  it.each([undefined, 'W/"weak"'] as const)(
    'preserves confirmed upload but stops retention when GET lacks a strong tag: %s',
    async (etag) => {
      await fixture(async (f) => {
        const normal = f.request.getMockImplementation()
        if (!normal) throw new Error('missing request')
        f.request.mockImplementation(async (url, options) => {
          const result = await normal(url, options)
          return options.method === 'GET' ? { ...result, headers: etag ? { etag } : {} } : result
        })
        await f.arm(1)
        await tick(f.scheduler)
        expect(f.scheduler.state().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'uploaded',
          lastStatus: 'retentionUnsupported',
          retention: { lastResult: 'unsupported', ownedCount: 0, deletedCount: 0 }
        })
        await tick(f.scheduler, 3600000)
        expect(f.request.mock.calls.map(([, o]) => o.method)).toEqual(['PUT', 'GET'])
      })
    }
  )
  it.each(['etag', 'body', 'metadata'] as const)(
    'refuses changed %s before DELETE while keeping the new upload success',
    async (change) => {
      await fixture(async (f) => {
        await f.arm(1)
        await tick(f.scheduler)
        const first = f.created[0],
          normal = f.request.getMockImplementation()
        if (!normal) throw new Error('missing request')
        f.request.mockImplementation(async (url, options) => {
          if (url === first && options.method === 'GET') {
            const value = f.files.get(first)
            if (!value) throw new Error('missing old file')
            if (change === 'etag') value.etag = '"external-version"'
            if (change === 'body') value.bytes = Buffer.from('FOREIGN-CHANGED-WITH-BROKEN-ETAG')
          }
          const result = await normal(url, options)
          if (url === first && options.method === 'PROPFIND' && change === 'metadata')
            return response(
              207,
              result.bytes.toString().includes('<d:resourcetype/>')
                ? Buffer.from(
                    result.bytes
                      .toString()
                      .replace(
                        '<d:resourcetype/>',
                        '<d:resourcetype><d:collection/></d:resourcetype>'
                      )
                  )
                : result.bytes
            )
          return result
        })
        await tick(f.scheduler)
        expect(f.scheduler.state().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'uploaded',
          lastStatus: 'retentionConflict',
          retention: { lastResult: 'conflict', ownedCount: 2, deletedCount: 0 }
        })
        expect(f.request.mock.calls.some(([, o]) => o.method === 'DELETE')).toBe(false)
        expect(f.files.has(first)).toBe(true)
      })
    }
  )
  it.each(['412', 'wire', 'head'] as const)(
    'stops without retry after deletion %s and does not erase uploaded success',
    async (failure) => {
      await fixture(async (f) => {
        await f.arm(1)
        await tick(f.scheduler)
        const first = f.created[0],
          normal = f.request.getMockImplementation()
        if (!normal) throw new Error('missing request')
        f.request.mockImplementation(async (url, options) => {
          if (options.method === 'DELETE' && failure === '412') return response(412)
          const result = await normal(url, options)
          if (options.method === 'DELETE' && failure === 'wire') throw new Error('unknown wire')
          return options.method === 'HEAD' && failure === 'head' ? response(200) : result
        })
        await tick(f.scheduler)
        const status = failure === '412' ? 'conflict' : 'uncertain'
        expect(f.scheduler.state().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'uploaded',
          retention: {
            lastResult: status,
            deletedCount: 0,
            ownedCount: 2,
            lastAttemptFilename: new URL(first).pathname.split('/').at(-1)
          }
        })
        await tick(f.scheduler, 3600000)
        expect(f.request.mock.calls.filter(([, o]) => o.method === 'DELETE')).toHaveLength(1)
        if (failure === 'wire')
          expect(f.request.mock.calls.some(([, o]) => o.method === 'HEAD')).toBe(false)
        expect(f.files.has(f.created[1])).toBe(true)
      })
    }
  )
  it('revokes eventless context loss after DELETE without HEAD or another automatic attempt', async () => {
    await fixture(async (f) => {
      await f.arm(1)
      await tick(f.scheduler)
      const normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request')
      f.request.mockImplementation(async (url, options) => {
        const result = await normal(url, options)
        if (options.method === 'DELETE') f.loseContext()
        return result
      })
      await tick(f.scheduler)
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastResult: 'uploaded',
        lastStatus: 'retentionUncertain',
        retention: { lastResult: 'uncertain' }
      })
      expect(f.request.mock.calls.some(([, o]) => o.method === 'HEAD')).toBe(false)
    })
  })
  it('starts a fresh owned set on every authorization epoch and cannot adopt earlier files even with the same session prefix', async () => {
    await fixture(async (f) => {
      await f.arm(2)
      await tick(f.scheduler)
      await tick(f.scheduler)
      const old = [...f.created]
      await f.scheduler.disarm({ id: f.account.id })
      await f.arm(1)
      expect(f.scheduler.state().entries[0].retention).toMatchObject({
        ownedCount: 0,
        deletedCount: 0
      })
      await tick(f.scheduler)
      await tick(f.scheduler)
      expect(old.every((url) => f.files.has(url))).toBe(true)
      expect(f.files.has(f.created[2])).toBe(false)
      expect(f.files.has(f.created[3])).toBe(true)
    })
  })
  it.each(['GET', 'DELETE'] as const)(
    'waits for a held owned-file %s on stop and preserves the separate upload result',
    async (method) => {
      await fixture(async (f) => {
        await f.arm(1)
        await tick(f.scheduler)
        const entered = Promise.withResolvers<void>(),
          gate = Promise.withResolvers<void>(),
          normal = f.request.getMockImplementation()
        if (!normal) throw new Error('missing request')
        f.request.mockImplementation(async (url, options) => {
          const value = await normal(url, options)
          if (options.method === method && (method === 'DELETE' || options.headers?.['If-Match'])) {
            entered.resolve()
            await gate.promise
          }
          return value
        })
        const advancing = vi.advanceTimersByTimeAsync(60000)
        await entered.promise
        let finished = false
        const stopping = f.scheduler.disarm({ id: f.account.id }).then(() => {
          finished = true
        })
        expect(finished).toBe(false)
        gate.resolve()
        await advancing
        await stopping
        expect(finished).toBe(true)
        expect(f.scheduler.state().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'uploaded',
          lastStatus: method === 'DELETE' ? 'retentionUncertain' : 'stopped',
          retention: { lastResult: method === 'DELETE' ? 'uncertain' : 'cancelled' }
        })
        expect(f.request.mock.calls.some(([, o]) => o.method === 'HEAD')).toBe(false)
        if (method === 'GET')
          expect(f.request.mock.calls.some(([, o]) => o.method === 'DELETE')).toBe(false)
      })
    }
  )
  it('does not register a readback whose strong version differs from the original PUT response', async () => {
    await fixture(async (f) => {
      const normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request')
      f.request.mockImplementation(async (url, options) => {
        const value = await normal(url, options)
        return options.method === 'GET'
          ? { ...value, headers: { etag: '"foreign-version"' } }
          : value
      })
      await f.arm(1)
      await tick(f.scheduler)
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastResult: 'uncertain',
        retention: { ownedCount: 0, deletedCount: 0 }
      })
      expect(f.request.mock.calls.some(([, o]) => o.method === 'DELETE')).toBe(false)
    })
  })
  it.each(['url', 'hash', 'size'] as const)(
    'rejects a forged private callback %s instead of granting deletion authority',
    async (field) => {
      await fixture(async (f) => {
        f.upload.mockImplementation((selected, bytes, signal, verify, guards) =>
          f.actual.upload(selected, bytes, signal, verify, {
            ...guards,
            verified: (receipt) =>
              guards?.verified?.({
                ...receipt,
                ...(field === 'url'
                  ? { url: 'https://foreign.example.test/fake.json' }
                  : field === 'hash'
                    ? { envelopeSHA256: 'f'.repeat(64) }
                    : { envelopeBytes: receipt.envelopeBytes + 1 })
              })
          })
        )
        await f.arm(1)
        await tick(f.scheduler)
        expect(f.scheduler.state().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'uploaded',
          retention: { lastResult: 'conflict', ownedCount: 0 }
        })
        expect(f.request.mock.calls.some(([, o]) => o.method === 'DELETE')).toBe(false)
      })
    }
  )
  it('verifies raw AGE envelope bytes for cleanup without requesting a private decryption key', async () => {
    const keys = await generateAgeKeyPair()
    await fixture(async (f) => {
      await f.arm(1)
      await tick(f.scheduler)
      await tick(f.scheduler)
      const value = f.files.get(f.created[1])
      expect(value).toBeDefined()
      expect(JSON.parse(value?.bytes.toString() ?? '{}').encoding).toBe('age')
      expect(f.scheduler.state().entries[0].retention).toMatchObject({
        deletedCount: 1,
        lastResult: 'pruned'
      })
      expect(
        f.request.mock.calls.every(([, o]) => !String(o.body ?? '').includes(keys.secretKey))
      ).toBe(true)
    }, keys.recipient)
  })
  it('binds callback digest and tag to the same original exact GET readback, without a later HEAD', async () => {
    const files = new Map<string, Buffer>(),
      request = vi.fn<typeof requestOnce>(async (url, options) => {
        if (options.method === 'PUT') {
          files.set(url, Buffer.from(options.body ?? ''))
          return response(201)
        }
        return response(200, files.get(url), '"original-get"')
      }),
      verified = vi.fn(),
      bytes = Buffer.from('same-response-fixture')
    expect(
      await createRemoteBackupTransport(request).upload(
        {
          provider: 'webdav',
          action: 'upload',
          proxyPort: 17891,
          url: 'https://backup.example.test/file.json',
          username: 'fixture',
          password: 'fixture'
        },
        bytes,
        new AbortController().signal,
        async () => undefined,
        { verified }
      )
    ).toMatchObject({ status: 'uploaded' })
    expect(verified).toHaveBeenCalledWith({
      url: 'https://backup.example.test/file.json',
      envelopeSHA256: sha(bytes),
      envelopeBytes: bytes.length,
      etag: '"original-get"'
    })
    expect(request.mock.calls.map(([, o]) => o.method)).toEqual(['PUT', 'GET'])
  })
})
