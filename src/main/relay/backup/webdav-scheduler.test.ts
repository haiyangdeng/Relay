import { writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestOnce } from '../../resolve/plugin/http-client'
import { generateAgeKeyPair } from '../../utils/age'
import type { RelayBackupAccount } from '../../../shared/relay/backup-accounts'
import type { RelayWebdavBackupScope } from '../../../shared/relay/backup-scheduler'
import { RelayBackupStore } from './store'
import { readBackupArchive } from './archive'
import * as remote from './remote'
import { backupAccountsFixture, webdavAccount, gistAccount } from './accounts.test-fixture'
import { createWebdavBackupScheduler, type WebdavBackupSchedulePermit } from './webdav-scheduler'

const response = (status: number, bytes = Buffer.alloc(0)) => ({
  status,
  bytes,
  body: '',
  headers: {}
})
type BaseFixture = Parameters<Parameters<typeof backupAccountsFixture>[0]>[0]
async function fixture(
  run: (f: BaseFixture & ReturnType<typeof setup>) => Promise<void>,
  recipient?: string
): Promise<void> {
  await backupAccountsFixture(async (f) => {
    const account = await f.store.save({ ...webdavAccount, ...(recipient ? { recipient } : {}) }),
      setupData = setup(f, account)
    await writeFile(
      join(f.context.stateRoot, 'Configuration/user.json'),
      'PRIVATE-BACKUP-FIXTURE',
      { mode: 0o600 }
    )
    try {
      await run({ ...f, ...setupData })
    } finally {
      await setupData.scheduler.requestClose()
    }
  })
}
function setup(f: BaseFixture, account: RelayBackupAccount) {
  let runnable = true,
    zone = 'UTC'
  const sent = new Map<string, Buffer>(),
    permits: WebdavBackupSchedulePermit[] = [],
    request = vi.fn<typeof requestOnce>(async (url, options) => {
      if (options.method === 'PUT') {
        sent.set(url, Buffer.from(options.body ?? ''))
        return response(201)
      }
      return response(200, sent.get(url) ?? Buffer.alloc(0))
    }),
    authorize = vi.fn(
      async (scope: RelayWebdavBackupScope): Promise<WebdavBackupSchedulePermit | undefined> => {
        let active = true
        const permit: WebdavBackupSchedulePermit = {
          permission: structuredClone(scope),
          isLive: vi.fn(() => active),
          revoke: vi.fn(() => {
            active = false
          }),
          credential: vi.fn(async (signal) => {
            if (!active || signal.aborted) throw new Error('revoked')
            return f.store.credential({ id: scope.id, revision: scope.revision })
          })
        }
        permits.push(permit)
        return permit
      }
    ),
    backups = new RelayBackupStore(f.context),
    archive = vi.spyOn(backups, 'archive'),
    scheduler = createWebdavBackupScheduler({
      accounts: f.store,
      backups,
      authorize,
      canRun: () => runnable,
      timeZone: () => zone,
      transport: remote.createRemoteBackupTransport(request)
    })
  return {
    scheduler,
    account,
    authorize,
    permits,
    request,
    sent,
    archive,
    backups,
    setRunnable: (value: boolean) => {
      runnable = value
    },
    setZone: (value: string) => {
      zone = value
    },
    arm: () =>
      scheduler.arm({
        id: account.id,
        revision: account.revision,
        schedule: { kind: 'interval', minutes: 1 }
      })
  }
}
async function tick(
  scheduler: ReturnType<typeof createWebdavBackupScheduler>,
  ms = 60000
): Promise<void> {
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
  vi.unstubAllEnvs()
})

describe('Session-only WebDAV backup scheduling with private authorization', () => {
  it('starts inert and includes the complete secret-free upload scope in explicit authorization', async () => {
    await fixture(async (f) => {
      f.crypto.decrypt.mockClear()
      expect(f.scheduler.state()).toEqual({ pending: false, suspended: false, entries: [] })
      expect(f.authorize).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
      const armed = await f.arm()
      expect(armed.status).toBe('armed')
      expect(armed.state.pending).toBe(false)
      expect(f.authorize.mock.calls[0][0]).toMatchObject({
        id: f.account.id,
        revision: f.account.revision,
        directoryURL: webdavAccount.directoryURL,
        username: webdavAccount.username,
        proxyPort: 17891,
        containsSecrets: true,
        encrypted: false,
        sessionOnly: true,
        overwrite: false,
        delete: false,
        timeZone: 'UTC',
        nextAt: '2026-11-01T00:01:00.000Z',
        schedule: { kind: 'interval', minutes: 1 },
        filenameSuffix: '.json'
      })
      expect(JSON.stringify(f.scheduler.state())).not.toContain(webdavAccount.password)
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.archive).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('keeps a cancelled authorization inert and returns an idle public state', async () => {
    await fixture(async (f) => {
      f.authorize.mockResolvedValueOnce(undefined)
      const result = await f.arm()
      expect(result).toMatchObject({ status: 'cancelled', state: { pending: false, entries: [] } })
      await tick(f.scheduler, 600000)
      expect(f.request).not.toHaveBeenCalled()
      expect(f.archive).not.toHaveBeenCalled()
    })
  })
  it('rejects invalid or implicit schedules before authorization and never accepts a Gist account', async () => {
    await fixture(async (f) => {
      for (const schedule of [
        { kind: 'manual' },
        { kind: 'interval', minutes: 0 },
        { kind: 'interval', minutes: '1' },
        { kind: 'cron', expression: 'bad' }
      ])
        await expect(
          f.scheduler.arm({ id: f.account.id, revision: f.account.revision, schedule })
        ).rejects.toThrow()
      const gist = await f.store.save(gistAccount)
      await expect(
        f.scheduler.arm({
          id: gist.id,
          revision: gist.revision,
          schedule: { kind: 'interval', minutes: 1 }
        })
      ).rejects.toThrow('WebDAV')
      expect(f.authorize).not.toHaveBeenCalled()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
    })
  })
  it('rejects a private permit whose returned scope differs and revokes it before reading credentials', async () => {
    await fixture(async (f) => {
      const normal = f.authorize.getMockImplementation()
      if (!normal) throw new Error('missing authorization')
      f.authorize.mockImplementationOnce(async (scope) => {
        const permit = await normal(scope)
        if (permit) permit.permission.directoryURL = 'https://foreign.example.test/'
        return permit
      })
      await expect(f.arm()).rejects.toThrow('授权范围不符')
      expect(f.scheduler.state()).toMatchObject({ pending: false, entries: [] })
      expect(f.permits[0].revoke).toHaveBeenCalled()
      expect(f.permits[0].credential).not.toHaveBeenCalled()
      await tick(f.scheduler, 600000)
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('creates a verified JSON envelope from the actual double-snapshot backup store, using only PUT-new and GET via the selected proxy', async () => {
    await fixture(async (f) => {
      await f.arm()
      await tick(f.scheduler)
      expect(f.archive).toHaveBeenCalledOnce()
      expect(f.request.mock.calls.map(([, options]) => options.method)).toEqual(['PUT', 'GET'])
      const [url, options] = f.request.mock.calls[0]
      expect(url).toMatch(/^https:\/\/backup\.example\.test\/relay\/relay-[a-f0-9-]+\.json$/u)
      expect(options.headers).toMatchObject({ 'If-None-Match': '*' })
      expect(options.proxy).toEqual({ host: '127.0.0.1', port: 17891 })
      const envelope = f.sent.get(url)
      if (!envelope) throw new Error('missing fixture envelope')
      const archive = await remote.decodeRemoteArchive(envelope),
        snapshot = readBackupArchive(archive).snapshot
      expect(
        snapshot.entries.find((entry) => entry.path === 'Configuration/user.json')?.bytes.toString()
      ).toBe('PRIVATE-BACKUP-FIXTURE')
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: true,
        lastStatus: 'uploaded',
        lastResult: 'uploaded',
        nextAt: '2026-11-01T00:02:00.000Z'
      })
      expect(JSON.stringify(f.scheduler.state())).not.toContain('PRIVATE-BACKUP-FIXTURE')
    })
  })
  it('does not combine a previous successful backup with a new pending or failed archive attempt', async () => {
    await fixture(async (f) => {
      await f.arm()
      await tick(f.scheduler)
      const first = f.scheduler.state().entries[0]
      expect(first).toMatchObject({ lastStatus: 'uploaded', lastResult: 'uploaded' })
      const entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>()
      f.archive.mockImplementationOnce(async () => {
        entered.resolve()
        await gate.promise
        throw new Error('PRIVATE-capture-failure')
      })
      await vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      const pending = f.scheduler.state()
      expect(pending.pending).toBe(true)
      expect(pending.entries[0]).toMatchObject({
        lastStatus: 'running',
        lastAttemptAt: '2026-11-01T00:02:00.000Z'
      })
      expect(pending.entries[0].lastResult).toBeUndefined()
      expect(pending.entries[0].lastCompletedAt).toBeUndefined()
      expect(pending.entries[0].lastArchiveSHA256).toBeUndefined()
      expect(pending.entries[0].lastFilename).not.toBe(first.lastFilename)
      gate.resolve()
      await f.scheduler.whenIdle()
      const failed = f.scheduler.state().entries[0]
      expect(failed).toMatchObject({
        enabled: false,
        lastStatus: 'failed',
        lastResult: 'failed',
        lastCompletedAt: '2026-11-01T00:02:00.000Z'
      })
      expect(failed.lastArchiveSHA256).toBeUndefined()
      expect(failed.lastFilename).not.toBe(first.lastFilename)
      expect(f.request).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(failed)).not.toContain('PRIVATE-capture-failure')
    })
  })
  it('uses the existing AGE envelope implementation when the approved account has a recipient', async () => {
    const pair = await generateAgeKeyPair()
    await fixture(async (f) => {
      await f.arm()
      await tick(f.scheduler)
      const envelope = [...f.sent.values()][0]
      expect(JSON.parse(envelope.toString('utf8')).encoding).toBe('age')
      const archive = await remote.decodeRemoteArchive(envelope, pair.secretKey)
      expect(
        readBackupArchive(archive).snapshot.entries.some(
          (entry) => entry.path === 'Configuration/user.json'
        )
      ).toBe(true)
      expect(f.authorize.mock.calls[0][0]).toMatchObject({
        encrypted: true,
        recipient: pair.recipient
      })
    }, pair.recipient)
  })
  it('defers only foreground-busy starts without reading or decrypting and then runs normally', async () => {
    await fixture(async (f) => {
      await f.arm()
      f.setRunnable(false)
      f.crypto.decrypt.mockClear()
      await tick(f.scheduler)
      expect(f.archive).not.toHaveBeenCalled()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: true,
        lastStatus: 'busy',
        nextAt: '2026-11-01T00:02:00.000Z'
      })
      f.setRunnable(true)
      await tick(f.scheduler)
      expect(f.archive).toHaveBeenCalledOnce()
      expect(f.request).toHaveBeenCalledTimes(2)
      expect(f.authorize).toHaveBeenCalledOnce()
    })
  })
  it('runs single-flight and schedules the next interval from completion with a fresh unique filename', async () => {
    await fixture(async (f) => {
      const gate = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>(),
        normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request adapter')
      f.request.mockImplementationOnce(async (url, options) => {
        entered.resolve()
        await gate.promise
        return normal(url, options)
      })
      await f.arm()
      await vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      await vi.advanceTimersByTimeAsync(180000)
      expect(f.request).toHaveBeenCalledOnce()
      gate.resolve()
      await f.scheduler.whenIdle()
      expect(f.scheduler.state().entries[0].nextAt).toBe('2026-11-01T00:05:00.000Z')
      await vi.advanceTimersByTimeAsync(59999)
      expect(f.request).toHaveBeenCalledTimes(2)
      await tick(f.scheduler, 1)
      expect(f.request).toHaveBeenCalledTimes(4)
      expect(f.request.mock.calls[0][0]).not.toBe(f.request.mock.calls[2][0])
    })
  })
  it('disarms changed account revisions before reading backup bytes or secrets', async () => {
    await fixture(async (f) => {
      await f.arm()
      const { password: _secret, ...metadata } = webdavAccount
      await f.store.save({
        ...metadata,
        id: f.account.id,
        revision: f.account.revision,
        name: 'Changed'
      })
      f.crypto.decrypt.mockClear()
      await tick(f.scheduler)
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'accountChanged'
      })
      expect(f.archive).not.toHaveBeenCalled()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
      expect(f.permits[0].revoke).toHaveBeenCalled()
    })
  })
  it('binds proxy, recipient, username and directory in addition to the revision', async () => {
    await fixture(async (f) => {
      await f.arm()
      const read = vi.spyOn(f.store, 'read')
      read.mockResolvedValue({ ...f.account, proxyPort: 17892 })
      await tick(f.scheduler)
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'accountChanged'
      })
      expect(f.archive).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('stops rather than retrying when the approved system credential cannot be read', async () => {
    await fixture(async (f) => {
      await f.arm()
      f.crypto.available.mockResolvedValue(false)
      await tick(f.scheduler)
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'credentials',
        lastResult: 'credentials'
      })
      expect(f.request).not.toHaveBeenCalled()
      expect(f.permits[0].revoke).toHaveBeenCalled()
      await tick(f.scheduler, 3600000)
      expect(f.archive).toHaveBeenCalledOnce()
    })
  })
  it('serializes accounts and an account-specific revocation does not invalidate another entered upload', async () => {
    await fixture(async (f) => {
      const second = await f.store.save({ ...webdavAccount, name: 'Second WebDAV' }),
        gate = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>(),
        normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request')
      f.request.mockImplementationOnce(async (url, options) => {
        entered.resolve()
        await gate.promise
        return normal(url, options)
      })
      await f.arm()
      await f.scheduler.arm({
        id: second.id,
        revision: second.revision,
        schedule: { kind: 'interval', minutes: 1 }
      })
      await vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      expect(f.scheduler.state().entries.find((entry) => entry.id === second.id)).toMatchObject({
        enabled: true,
        lastStatus: 'busy'
      })
      await f.scheduler.accountChanged({ id: second.id })
      gate.resolve()
      await f.scheduler.whenIdle()
      expect(f.request).toHaveBeenCalledTimes(2)
      expect(f.scheduler.state().entries.find((entry) => entry.id === f.account.id)).toMatchObject({
        enabled: true,
        lastStatus: 'uploaded'
      })
      expect(f.scheduler.state().entries.find((entry) => entry.id === second.id)).toMatchObject({
        enabled: false,
        lastStatus: 'accountChanged'
      })
    })
  })
  it('does not send a readback or retry when account authorization changes after the PUT may have reached the server', async () => {
    await fixture(async (f) => {
      const normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request adapter')
      f.request.mockImplementationOnce(async (url, options) => {
        const result = await normal(url, options),
          { password: _secret, ...metadata } = webdavAccount
        await f.store.save({
          ...metadata,
          id: f.account.id,
          revision: f.account.revision,
          name: 'Changed during PUT'
        })
        return result
      })
      await f.arm()
      await tick(f.scheduler)
      expect(f.request.mock.calls.map(([, options]) => options.method)).toEqual(['PUT'])
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'uncertain',
        lastResult: 'uncertain'
      })
      await tick(f.scheduler, 3600000)
      expect(f.request).toHaveBeenCalledOnce()
    })
  })
  it('reports cancellation without uncertainty when revoked at the guarded transport boundary before any write', async () => {
    await fixture(async (f) => {
      const entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>(),
        actual = remote.createRemoteBackupTransport(f.request),
        scheduler = createWebdavBackupScheduler({
          accounts: f.store,
          backups: f.backups,
          authorize: f.authorize,
          canRun: () => true,
          timeZone: () => 'UTC',
          transport: {
            upload: async (...args) => {
              entered.resolve()
              await gate.promise
              return actual.upload(...args)
            }
          }
        })
      await scheduler.arm({
        id: f.account.id,
        revision: f.account.revision,
        schedule: { kind: 'interval', minutes: 1 }
      })
      await vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      const stopped = scheduler.disarm({ id: f.account.id })
      gate.resolve()
      await stopped
      expect(f.request).not.toHaveBeenCalled()
      expect(scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'stopped',
        lastResult: 'cancelled'
      })
      await scheduler.requestClose()
    })
  })
  it('waits for an entered write when stopped, preserves uncertainty and never retries after the late response', async () => {
    await fixture(async (f) => {
      const gate = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>(),
        normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request adapter')
      f.request.mockImplementationOnce(async (url, options) => {
        const result = await normal(url, options)
        entered.resolve()
        await gate.promise
        return result
      })
      await f.arm()
      await vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      let stopped = false
      const stopping = f.scheduler.disarm({ id: f.account.id }).then(() => {
        stopped = true
      })
      expect(stopped).toBe(false)
      gate.resolve()
      await stopping
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'uncertain',
        lastResult: 'uncertain'
      })
      await tick(f.scheduler, 3600000)
      expect(f.request).toHaveBeenCalledOnce()
    })
  })
  it('revokes late asynchronous authorization on sleep and resume never installs or restores a timer', async () => {
    await fixture(async (f) => {
      const entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>(),
        normal = f.authorize.getMockImplementation()
      if (!normal) throw new Error('missing authorization')
      f.authorize.mockImplementationOnce(async (scope) => {
        entered.resolve()
        await gate.promise
        return normal(scope)
      })
      const arming = f.arm()
      await entered.promise
      const suspending = f.scheduler.suspend()
      gate.resolve()
      expect((await arming).status).toBe('cancelled')
      await suspending
      f.scheduler.resume()
      expect(f.permits[0].revoke).toHaveBeenCalled()
      expect(f.scheduler.state().entries).toEqual([])
      await tick(f.scheduler, 600000)
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('rejects authorization that takes longer than its displayed approval window without reading credentials', async () => {
    await fixture(async (f) => {
      const entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>(),
        normal = f.authorize.getMockImplementation()
      if (!normal) throw new Error('missing authorization')
      f.authorize.mockImplementationOnce(async (scope) => {
        entered.resolve()
        await gate.promise
        return normal(scope)
      })
      const arming = f.arm()
      await entered.promise
      await vi.advanceTimersByTimeAsync(60000)
      gate.resolve()
      expect(await arming).toMatchObject({
        status: 'cancelled',
        state: { pending: false, entries: [] }
      })
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('rejects a credential returned after suspension and waits for it without reviving authority', async () => {
    await fixture(async (f) => {
      await f.arm()
      const pair = await f.store.credential({ id: f.account.id, revision: f.account.revision }),
        entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<typeof pair>()
      vi.mocked(f.permits[0].credential).mockImplementationOnce(async () => {
        entered.resolve()
        return gate.promise
      })
      await vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      const stopped = f.scheduler.suspend()
      gate.resolve(pair)
      await stopped
      f.scheduler.resume()
      await tick(f.scheduler, 600000)
      expect(f.request).not.toHaveBeenCalled()
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'suspended',
        lastResult: 'cancelled'
      })
    })
  })
  it('revokes an operation while existing AGE/encoding work is awaiting and does not decrypt credentials afterwards', async () => {
    await fixture(async (f) => {
      const encode = remote.encodeRemoteArchive,
        entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>()
      vi.spyOn(remote, 'encodeRemoteArchive').mockImplementationOnce(async (bytes, recipient) => {
        entered.resolve()
        await gate.promise
        return encode(bytes, recipient)
      })
      await f.arm()
      f.crypto.decrypt.mockClear()
      await vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      const closing = f.scheduler.requestClose()
      gate.resolve()
      await closing
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
      expect(f.scheduler.state().entries[0].enabled).toBe(false)
    })
  })
  it('rejects inconsistent snapshots from the actual archive collector and stops without decrypting or retrying', async () => {
    await fixture(async (f) => {
      const snapshot = f.backups.snapshot.bind(f.backups)
      vi.spyOn(f.backups, 'snapshot')
        .mockImplementationOnce(snapshot)
        .mockImplementationOnce(async () => {
          await writeFile(
            join(f.context.stateRoot, 'Configuration/user.json'),
            'CHANGED-DURING-CAPTURE',
            { mode: 0o600 }
          )
          return snapshot()
        })
      await f.arm()
      f.crypto.decrypt.mockClear()
      await tick(f.scheduler)
      expect(f.scheduler.state().entries[0]).toMatchObject({ enabled: false, lastStatus: 'failed' })
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
      await tick(f.scheduler, 3600000)
      expect(f.archive).toHaveBeenCalledOnce()
    })
  })
  it('disarms on changed timezone and never fires an annual cron early at Node timer chunk boundaries', async () => {
    await fixture(async (f) => {
      await f.scheduler.arm({
        id: f.account.id,
        revision: f.account.revision,
        schedule: { kind: 'cron', expression: '0 0 1 1 *' }
      })
      expect(Date.parse(f.scheduler.state().entries[0].nextAt ?? '') - Date.now()).toBeGreaterThan(
        2147483647
      )
      await tick(f.scheduler, 2147483647)
      expect(f.archive).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
      await f.scheduler.disarm({ id: f.account.id })
      await f.arm()
      f.setZone('Asia/Taipei')
      await tick(f.scheduler)
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'scopeChanged'
      })
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('clears grants on restoration and starts a new service with no inherited authority', async () => {
    await fixture(async (f) => {
      await f.arm()
      await f.scheduler.dataRestored()
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'restored'
      })
      const fresh = createWebdavBackupScheduler({
        accounts: f.store,
        backups: f.backups,
        authorize: f.authorize,
        canRun: () => true,
        transport: remote.createRemoteBackupTransport(f.request)
      })
      expect(fresh.state().entries).toEqual([])
      await tick(f.scheduler, 600000)
      expect(f.request).not.toHaveBeenCalled()
      await fresh.requestClose()
    })
  })
})
