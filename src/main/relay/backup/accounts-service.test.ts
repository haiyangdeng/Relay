import { randomUUID } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  RelayRemoteBackupRequest,
  RelayRemoteBackupPlan
} from '../../../shared/relay/backup-remote'
import type {
  RelayRuntimeGistRequest,
  RelayRuntimeGistPlan
} from '../../../shared/relay/runtime-gist'
import { createBackupAccountsService } from './accounts-service'
import { backupAccountsFixture, webdavAccount, gistAccount } from './accounts.test-fixture'

function setup(store: Parameters<typeof createBackupAccountsService>[0]['store']) {
  let at = Date.now()
  const prepareRemote = vi.fn(
      async (
        request: RelayRemoteBackupRequest,
        _recheck: (phase?: 'transfer' | 'restore') => Promise<void>,
        _assertLive?: () => void
      ): Promise<RelayRemoteBackupPlan> => ({
        evidenceId: randomUUID(),
        provider: request.provider,
        action: request.action,
        ...(request.archiveFormat ? { archiveFormat: request.archiveFormat } : {}),
        endpoint: request.url ?? 'https://api.github.com/gists',
        proxyPort: request.proxyPort,
        encrypted: !!request.recipient,
        containsSecrets: request.action === 'upload' || request.action === 'download',
        expiresAt: at + 60000
      })
    ),
    prepareRuntime = vi.fn(
      async (
        request: RelayRuntimeGistRequest,
        _recheck: (phase?: 'transfer' | 'restore') => Promise<void>,
        _context?: () => void
      ): Promise<RelayRuntimeGistPlan> => ({
        evidenceId: randomUUID(),
        action: request.gistId ? 'update' : 'create',
        endpoint: 'https://api.github.com/gists',
        filename: 'clash-party.yaml',
        proxyPort: request.proxyPort,
        encrypted: !!request.recipient,
        containsSecrets: true,
        instanceId: 'owned-test-instance',
        configurationRevision: 'a'.repeat(64),
        configurationSHA256: 'b'.repeat(64),
        configurationBytes: 10,
        payloadSHA256: 'c'.repeat(64),
        payloadBytes: 10,
        expiresAt: at + 60000
      })
    ),
    cancelRemote = vi.fn(),
    cancelRuntime = vi.fn(),
    assertIdle = vi.fn(),
    service = createBackupAccountsService({
      store,
      prepareRemote,
      prepareRuntime,
      cancelRemote,
      cancelRuntime,
      assertIdle,
      now: () => at
    })
  return {
    service,
    prepareRemote,
    prepareRuntime,
    cancelRemote,
    cancelRuntime,
    assertIdle,
    advance: (delta: number) => {
      at += delta
    }
  }
}
describe('Saved-account main-only preparation guards', () => {
  it('passes only the per-operation runtime source and early renderer context through the saved credential path', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(gistAccount),
        api = setup(f.store),
        source = {
          kind: 'tun-managed' as const,
          sessionId: '11111111-1111-4111-8111-111111111111'
        },
        context = vi.fn()
      await api.service.prepareRuntime(
        { id: account.id, revision: account.revision, gistId: 'abcde', source },
        context
      )
      expect(api.prepareRuntime.mock.calls[0][0]).toMatchObject({
        source,
        proxyPort: account.proxyPort
      })
      expect(api.prepareRuntime.mock.calls[0][2]).toBe(context)
      expect(context).toHaveBeenCalled()
      expect(await f.store.read({ id: account.id, revision: account.revision })).not.toHaveProperty(
        'source'
      )
      context.mockImplementation(() => {
        throw new Error('renderer gone')
      })
      const calls = api.prepareRuntime.mock.calls.length
      await expect(
        api.service.prepareRuntime({ id: account.id, revision: account.revision, source }, context)
      ).rejects.toThrow('准备未通过')
      expect(api.prepareRuntime).toHaveBeenCalledTimes(calls)
    })
  })

  it('lists public metadata without accessing keychain or preparing a transfer', async () => {
    await backupAccountsFixture(async (f) => {
      await f.store.save(gistAccount)
      f.crypto.available.mockClear()
      f.crypto.decrypt.mockClear()
      const api = setup(f.store)
      expect((await api.service.list()).accounts).toHaveLength(1)
      expect(f.crypto.available).not.toHaveBeenCalled()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(api.prepareRemote).not.toHaveBeenCalled()
      expect(api.prepareRuntime).not.toHaveBeenCalled()
    })
  })
  it('supports a separate read-only idle gate without relaxing writes or decrypting metadata', async () => {
    await backupAccountsFixture(async (f) => {
      await f.store.save(gistAccount)
      f.crypto.decrypt.mockClear()
      const api = setup(f.store),
        assertListIdle = vi.fn(),
        service = createBackupAccountsService({
          store: f.store,
          assertIdle: () => {
            throw new Error('stable owned TUN blocks writes')
          },
          assertListIdle,
          prepareRemote: api.prepareRemote,
          prepareRuntime: api.prepareRuntime
        })
      expect((await service.list()).accounts).toHaveLength(1)
      expect(assertListIdle).toHaveBeenCalledOnce()
      expect(service.isBusy()).toBe(false)
      await expect(service.save(gistAccount)).rejects.toThrow('blocks writes')
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
    })
  })
  it('builds the fixed WebDAV operation main-only and invalidates its guard after an account revision changes', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(webdavAccount),
        api = setup(f.store),
        plan = await api.service.prepareRemote({
          id: account.id,
          revision: account.revision,
          action: 'download',
          filename: 'one.json'
        })
      expect(api.prepareRemote.mock.calls[0][0]).toMatchObject({
        url: webdavAccount.directoryURL + 'one.json',
        username: webdavAccount.username,
        password: webdavAccount.password,
        proxyPort: 17891
      })
      expect(JSON.stringify(plan)).not.toContain(webdavAccount.password)
      const guard = api.prepareRemote.mock.calls[0][1]
      await guard()
      const { password: _secret, ...metadata } = webdavAccount
      await f.store.save({
        ...metadata,
        id: account.id,
        revision: account.revision,
        name: 'Changed'
      })
      await expect(guard()).rejects.toThrow('修订已变化')
      await expect(api.service.verifyPrepared(plan.evidenceId)).rejects.toThrow('修订已变化')
    })
  })
  it.each([
    'https://foreign.example.test/one.json',
    '../one.json',
    'one%2Ftwo.json',
    'one.json?token=secret'
  ])(
    'rejects a target outside the safe basename contract before decrypting: %s',
    async (filename) => {
      await backupAccountsFixture(async (f) => {
        const account = await f.store.save(webdavAccount),
          api = setup(f.store)
        f.crypto.decrypt.mockClear()
        await expect(
          api.service.prepareRemote({
            id: account.id,
            revision: account.revision,
            action: 'download',
            filename
          })
        ).rejects.toThrow()
        expect(f.crypto.decrypt).not.toHaveBeenCalled()
        expect(api.prepareRemote).not.toHaveBeenCalled()
      })
    }
  )

  it('binds explicit raw WebDAV downloads without stored AGE recipient and preserves the early main context', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save({ ...webdavAccount, recipient: 'age1-public-stored' }),
        api = setup(f.store),
        live = vi.fn()
      const plan = await api.service.prepareRemote(
        {
          id: account.id,
          revision: account.revision,
          action: 'download',
          filename: 'old.zip',
          archiveFormat: 'legacy-zip'
        },
        live
      )
      const request = api.prepareRemote.mock.calls[0][0]
      expect(request).toMatchObject({
        provider: 'webdav',
        action: 'download',
        archiveFormat: 'legacy-zip',
        url: webdavAccount.directoryURL + 'old.zip'
      })
      expect(request).not.toHaveProperty('recipient')
      expect(request).not.toHaveProperty('secretKey')
      expect(api.prepareRemote.mock.calls[0][2]).toBe(live)
      expect(live).toHaveBeenCalled()
      expect(plan.archiveFormat).toBe('legacy-zip')
      expect(JSON.stringify(plan)).not.toContain(webdavAccount.password)
      expect((await f.store.read({ id: account.id, revision: account.revision })).recipient).toBe(
        'age1-public-stored'
      )
      api.prepareRemote.mockClear()
      await api.service.prepareRemote({
        id: account.id,
        revision: account.revision,
        action: 'download',
        filename: 'modern.json'
      })
      expect(api.prepareRemote.mock.calls[0]).toHaveLength(2)
      expect(api.prepareRemote.mock.calls[0][0]).not.toHaveProperty('archiveFormat')
    })
  })
  it('keeps account revision and cancellation guards after raw handoff while the local plan owns its fresh restore TTL', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(webdavAccount),
        api = setup(f.store)
      await api.service.prepareRemote({
        id: account.id,
        revision: account.revision,
        action: 'download',
        filename: 'old.zip',
        archiveFormat: 'legacy-zip'
      })
      const guard = api.prepareRemote.mock.calls[0][1]
      api.advance(60001)
      await expect(guard()).rejects.toThrow('失效')
      await expect(guard('transfer')).rejects.toThrow('失效')
      await expect(guard('restore')).resolves.toBeUndefined()
      await f.store.disable({ id: account.id, revision: account.revision })
      await expect(guard('restore')).rejects.toThrow()
      api.service.cancel()
      await expect(guard('restore')).rejects.toThrow('失效')
    })
  })
  it('rejects Gist formats and explicit raw AGE fields before decrypting', async () => {
    await backupAccountsFixture(async (f) => {
      const dav = await f.store.save(webdavAccount),
        gist = await f.store.save(gistAccount),
        api = setup(f.store)
      f.crypto.decrypt.mockClear()
      for (const archiveFormat of ['legacy-zip', 'relay-envelope'])
        await expect(
          api.service.prepareRemote({
            id: gist.id,
            revision: gist.revision,
            action: 'download',
            gistId: 'abcde',
            archiveFormat
          })
        ).rejects.toThrow()
      for (const secretKey of ['', undefined, 'AGE-SECRET-KEY-fixture'])
        await expect(
          api.service.prepareRemote({
            id: dav.id,
            revision: dav.revision,
            action: 'download',
            filename: 'old.zip',
            archiveFormat: 'legacy-zip',
            secretKey
          })
        ).rejects.toThrow()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(api.prepareRemote).not.toHaveBeenCalled()
    })
  })
  it('rejects raw preparation when its early renderer context is lost during credential await', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(webdavAccount),
        api = setup(f.store),
        actual = f.store.credential.bind(f.store)
      let live = true
      vi.spyOn(f.store, 'credential').mockImplementationOnce(async (selected) => {
        const result = await actual(selected)
        live = false
        return result
      })
      await expect(
        api.service.prepareRemote(
          {
            id: account.id,
            revision: account.revision,
            action: 'download',
            filename: 'old.zip',
            archiveFormat: 'legacy-zip'
          },
          () => {
            if (!live) throw new Error('lost renderer')
          }
        )
      ).rejects.toThrow('未通过')
      expect(api.prepareRemote).not.toHaveBeenCalled()
      expect(api.cancelRemote).toHaveBeenCalled()
    })
  })
  it('rejects a ZIP upload filename before decrypting because saved-account uploads contain a Relay JSON envelope', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(webdavAccount),
        api = setup(f.store)
      f.crypto.decrypt.mockClear()
      await expect(
        api.service.prepareRemote({
          id: account.id,
          revision: account.revision,
          action: 'upload',
          filename: 'backup.zip'
        })
      ).rejects.toThrow()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(api.prepareRemote).not.toHaveBeenCalled()
    })
  })
  it('rejects invalid provider operations before decrypting or invoking transport preparation', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(webdavAccount),
        api = setup(f.store)
      f.crypto.decrypt.mockClear()
      await expect(
        api.service.prepareRuntime({ id: account.id, revision: account.revision })
      ).rejects.toThrow('未通过')
      await expect(
        api.service.prepareRemote({
          id: account.id,
          revision: account.revision,
          action: 'list',
          page: 1
        })
      ).rejects.toThrow('未通过')
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(api.prepareRuntime).not.toHaveBeenCalled()
    })
  })
  it('binds runtime-Gist preparation to the saved Gist account without returning its token', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(gistAccount),
        api = setup(f.store),
        plan = await api.service.prepareRuntime({
          id: account.id,
          revision: account.revision,
          gistId: 'abcde'
        })
      expect(api.prepareRuntime.mock.calls[0][0]).toEqual({
        token: gistAccount.token,
        proxyPort: 17891,
        gistId: 'abcde'
      })
      expect(JSON.stringify(plan)).not.toContain(gistAccount.token)
      await api.prepareRuntime.mock.calls[0][1]()
      api.advance(60000)
      await expect(api.service.verifyPrepared(plan.evidenceId)).rejects.toThrow('失效')
    })
  })
  it('cancels an asynchronous preparation changed during archive collection and does not return an executable proof', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(webdavAccount),
        api = setup(f.store),
        normal = api.prepareRemote.getMockImplementation()
      if (!normal) throw new Error('missing adapter')
      api.prepareRemote.mockImplementationOnce(async (request, recheck) => {
        const { password: _secret, ...metadata } = webdavAccount
        await f.store.save({
          ...metadata,
          id: account.id,
          revision: account.revision,
          name: 'Changed during preparation'
        })
        return normal(request, recheck)
      })
      await expect(
        api.service.prepareRemote({ id: account.id, revision: account.revision, action: 'list' })
      ).rejects.toThrow('未通过')
      expect(api.cancelRemote).toHaveBeenCalled()
      expect(api.service.isBusy()).toBe(false)
    })
  })
  it('rejects a decrypt result arriving after cancellation and resolves idle waiters', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(gistAccount),
        api = setup(f.store),
        decrypt = f.crypto.decrypt.getMockImplementation()
      if (!decrypt) throw new Error('missing crypto adapter')
      let finish: (() => void) | undefined, entered: (() => void) | undefined
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      f.crypto.decrypt.mockImplementationOnce(async (bytes) => {
        entered?.()
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return decrypt(bytes)
      })
      const preparing = api.service.prepareRuntime({ id: account.id, revision: account.revision })
      await waiting
      const idle = api.service.whenIdle()
      expect(api.service.isBusy()).toBe(true)
      api.service.cancel()
      finish?.()
      await expect(preparing).rejects.toThrow('未通过')
      await idle
      expect(api.prepareRuntime).not.toHaveBeenCalled()
      expect(api.service.isBusy()).toBe(false)
    })
  })
  it('invalidates pending proofs on account save or disable without granting automatic network access', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(gistAccount),
        api = setup(f.store),
        plan = await api.service.prepareRuntime({ id: account.id, revision: account.revision })
      const updated = await api.service.save({
        id: account.id,
        revision: account.revision,
        name: 'Changed',
        provider: 'gist',
        proxyPort: 17891
      })
      await expect(api.service.verifyPrepared(plan.evidenceId)).rejects.toThrow('失效')
      const next = await api.service.prepareRuntime({ id: updated.id, revision: updated.revision })
      await api.service.disable({ id: updated.id, revision: updated.revision })
      await expect(api.service.verifyPrepared(next.evidenceId)).rejects.toThrow('失效')
      expect(api.cancelRuntime).toHaveBeenCalledTimes(2)
    })
  })
  it('only resets historical storage trust after an explicit confirmed restore callback', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(gistAccount),
        api = setup(f.store),
        plan = await api.service.prepareRuntime({ id: account.id, revision: account.revision }),
        clear = vi.spyOn(f.store, 'clearTrust')
      api.service.cancel()
      expect(clear).not.toHaveBeenCalled()
      api.service.dataRestored()
      expect(clear).toHaveBeenCalledTimes(1)
      await expect(api.service.verifyPrepared(plan.evidenceId)).rejects.toThrow('失效')
    })
  })
})
