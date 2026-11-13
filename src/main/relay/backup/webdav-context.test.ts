import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { requestOnce } from '../../resolve/plugin/http-client'
import { remoteBackupRequest } from '../../../shared/relay/backup-remote'
import { backupAccountsFixture, webdavAccount } from './accounts.test-fixture'
import { createRemoteBackupTransport } from './remote'
import { RelayBackupStore } from './store'
import { createWebdavBackupScheduler, type WebdavBackupSchedulePermit } from './webdav-scheduler'

const response = (status: number, bytes = Buffer.alloc(0)) => ({
  status,
  bytes,
  body: '',
  headers: {}
})
const input = remoteBackupRequest({
  provider: 'webdav',
  action: 'upload',
  url: 'https://backup.example.test/relay/only.json',
  username: 'fixture-user',
  password: 'fixture-only-password',
  proxyPort: 17891
})
const envelope = Buffer.from('private-fixture-envelope')
function requestFixture() {
  let uploaded = Buffer.alloc(0)
  return vi.fn<typeof requestOnce>(async (_url, options) => {
    if (options.method === 'PUT') {
      uploaded = Buffer.from(options.body ?? '')
      return response(201)
    }
    return response(200, uploaded)
  })
}
type AccountsFixture = Parameters<Parameters<typeof backupAccountsFixture>[0]>[0]
async function schedulerFixture(
  run: (f: AccountsFixture & Awaited<ReturnType<typeof setup>>) => Promise<void>
): Promise<void> {
  await backupAccountsFixture(async (f) => {
    const api = await setup(f)
    try {
      await run({ ...f, ...api })
    } finally {
      await api.scheduler.requestClose()
    }
  })
}
async function setup(f: AccountsFixture) {
  const account = await f.store.save(webdavAccount)
  let contextLive = true
  const request = requestFixture(),
    actual = createRemoteBackupTransport(request),
    upload = vi.fn(actual.upload),
    backups = new RelayBackupStore(f.context),
    archive = vi.spyOn(backups, 'archive'),
    permit: WebdavBackupSchedulePermit = {
      permission: {} as WebdavBackupSchedulePermit['permission'],
      isLive: vi.fn(() => contextLive),
      credential: vi.fn((signal) => {
        if (signal.aborted) throw new Error('cancelled')
        return f.store.credential({ id: account.id, revision: account.revision })
      }),
      revoke: vi.fn(() => {
        contextLive = false
      })
    },
    scheduler = createWebdavBackupScheduler({
      accounts: f.store,
      backups,
      authorize: async (scope) => {
        permit.permission = structuredClone(scope)
        return permit
      },
      canRun: () => true,
      timeZone: () => 'UTC',
      transport: { upload }
    })
  return {
    account,
    scheduler,
    permit,
    request,
    upload,
    archive,
    loseContext: () => {
      contextLive = false
    },
    arm: () =>
      scheduler.arm({
        id: account.id,
        revision: account.revision,
        schedule: { kind: 'interval', minutes: 1 }
      })
  }
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

describe('Private WebDAV upload context at the actual dispatch boundary', () => {
  it('keeps the established four-argument manual upload contract and exact readback', async () => {
    const request = requestFixture(),
      verify = vi.fn(async () => undefined)
    expect(
      await createRemoteBackupTransport(request).upload(
        input,
        envelope,
        new AbortController().signal,
        verify
      )
    ).toEqual({ status: 'uploaded', gistId: undefined })
    expect(request.mock.calls.map(([, options]) => options.method)).toEqual(['PUT', 'GET'])
    expect(verify).toHaveBeenCalledTimes(4)
  })
  it('does not dispatch or mark submitted when a microtask revokes context after the awaited account guard', async () => {
    let live = true
    const request = requestFixture(),
      submitted = vi.fn(),
      assertLive = () => {
        if (!live) throw new Error('context lost')
      }
    await expect(
      createRemoteBackupTransport(request).upload(
        input,
        envelope,
        new AbortController().signal,
        async () => {
          assertLive()
          queueMicrotask(() => {
            live = false
          })
        },
        { assertLive, submitted }
      )
    ).rejects.toThrow('尚未发送')
    expect(request).not.toHaveBeenCalled()
    expect(submitted).not.toHaveBeenCalled()
  })
  it('retains uncertainty and prevents GET when context is lost after the dispatched PUT', async () => {
    let live = true
    const request = requestFixture(),
      normal = request.getMockImplementation(),
      submitted = vi.fn(),
      assertLive = () => {
        if (!live) throw new Error('context lost')
      }
    if (!normal) throw new Error('missing request')
    request.mockImplementation(async (...args) => {
      const result = await normal(...args)
      live = false
      return result
    })
    expect(
      await createRemoteBackupTransport(request).upload(
        input,
        envelope,
        new AbortController().signal,
        async () => assertLive(),
        { assertLive, submitted }
      )
    ).toMatchObject({ status: 'uncertain' })
    expect(submitted).toHaveBeenCalledOnce()
    expect(request.mock.calls.map(([, options]) => options.method)).toEqual(['PUT'])
  })
  it('rechecks synchronously after the asynchronous post-response guard as well as before dispatch', async () => {
    let live = true,
      checks = 0
    const request = requestFixture(),
      submitted = vi.fn(),
      assertLive = () => {
        if (!live) throw new Error('context lost')
      }
    expect(
      await createRemoteBackupTransport(request).upload(
        input,
        envelope,
        new AbortController().signal,
        async () => {
          assertLive()
          if (++checks === 2)
            queueMicrotask(() => {
              live = false
            })
        },
        { assertLive, submitted }
      )
    ).toMatchObject({ status: 'uncertain' })
    expect(submitted).toHaveBeenCalledOnce()
    expect(request.mock.calls.map(([, options]) => options.method)).toEqual(['PUT'])
  })
  it.each(['false', 'throws'] as const)(
    'fails closed without archive/decrypt/network when the session observer %s',
    async (loss) => {
      await schedulerFixture(async (f) => {
        await f.arm()
        if (loss === 'false') f.loseContext()
        else
          vi.mocked(f.permit.isLive).mockImplementation(() => {
            throw new Error('destroyed getter')
          })
        f.crypto.decrypt.mockClear()
        await tick(f.scheduler)
        expect(f.archive).not.toHaveBeenCalled()
        expect(f.crypto.decrypt).not.toHaveBeenCalled()
        expect(f.request).not.toHaveBeenCalled()
        expect(f.scheduler.state().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'scopeChanged',
          lastStatus: 'scopeChanged'
        })
      })
    }
  )
  it('rejects a late Native permit whose liveness observer throws and installs no timer or credential work', async () => {
    await schedulerFixture(async (f) => {
      vi.mocked(f.permit.isLive).mockImplementation(() => {
        throw new Error('destroyed getter')
      })
      f.crypto.decrypt.mockClear()
      expect(await f.arm()).toMatchObject({
        status: 'cancelled',
        state: { entries: [], pending: false }
      })
      expect(f.permit.revoke).toHaveBeenCalledOnce()
      await tick(f.scheduler, 3600000)
      expect(f.archive).not.toHaveBeenCalled()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('checks context again after held credentials without any lifecycle event', async () => {
    await schedulerFixture(async (f) => {
      await f.arm()
      const entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>(),
        normal = f.permit.credential
      vi.mocked(f.permit.credential).mockImplementationOnce(async (signal) => {
        const pair = await normal(signal)
        entered.resolve()
        await gate.promise
        return pair
      })
      const advancing = vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      f.loseContext()
      gate.resolve()
      await advancing
      await f.scheduler.whenIdle()
      expect(f.request).not.toHaveBeenCalled()
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastResult: 'scopeChanged'
      })
    })
  })
  it('classifies a revoked final microtask as scopeChanged through the real transport, never as submitted uncertainty', async () => {
    await schedulerFixture(async (f) => {
      const actual = createRemoteBackupTransport(f.request)
      f.upload.mockImplementation((selected, bytes, signal, beforeSend, guards) =>
        actual.upload(
          selected,
          bytes,
          signal,
          async () => {
            await beforeSend?.()
            queueMicrotask(f.loseContext)
          },
          guards
        )
      )
      await f.arm()
      await tick(f.scheduler)
      expect(f.request).not.toHaveBeenCalled()
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'scopeChanged',
        lastResult: 'scopeChanged'
      })
    })
  })
  it('marks submitted only at PUT and stops without readback or retry when the context then disappears', async () => {
    await schedulerFixture(async (f) => {
      const normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request')
      f.request.mockImplementation(async (...args) => {
        const result = await normal(...args)
        f.loseContext()
        return result
      })
      await f.arm()
      await tick(f.scheduler)
      expect(f.scheduler.state().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'uncertain',
        lastResult: 'uncertain'
      })
      expect(f.request.mock.calls.map(([, options]) => options.method)).toEqual(['PUT'])
      await tick(f.scheduler, 3600000)
      expect(f.request).toHaveBeenCalledOnce()
    })
  })
})
