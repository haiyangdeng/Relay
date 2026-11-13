import { randomUUID } from 'crypto'
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { backupFileNative } from '../native'
import { RelayBackupAccountsStore, type BackupAccountPublication } from './accounts-store'
import { backupAccountsFixture, webdavAccount } from './accounts.test-fixture'
import { RelayBackupStore } from './store'
import { createBackupService } from './service'
import { createBackupAccountsService } from './accounts-service'
import { recoveryFixtureAdapters } from './recovery.test-fixture'

function nativeAdapters(context: { home: string; stateRoot: string }) {
  const executable =
    process.env.RELAY_BACKUP_ACCOUNTS_EXECUTABLE ?? resolve('extra/relay/RelayNative')
  return {
    createDirectory: async ({
      id,
      stateIdentity
    }: Parameters<
      NonNullable<ConstructorParameters<typeof RelayBackupAccountsStore>[1]['createDirectory']>
    >[0]) =>
      (
        await backupFileNative(executable, context, {
          namespace: 'backup-account',
          id,
          directoryIdentity: stateIdentity,
          name: '',
          directory: true,
          mode: 0o700,
          bytes: ''
        })
      ).identity,
    publish: async (request: BackupAccountPublication) => {
      await backupFileNative(executable, context, {
        namespace: 'backup-account',
        id: request.id,
        directoryIdentity: request.directoryIdentity,
        name: request.name,
        mode: 0o600,
        bytes: request.bytes.toString('base64')
      })
    }
  }
}
describe('Saved account actual Darwin pinned-directory publication, no user data or keychain', () => {
  it('restores the exact encrypted account through the real backup transaction and resets trust only after confirmed restoration', async () => {
    await backupAccountsFixture(async (f) => {
      const accountStore = new RelayBackupAccountsStore(f.context, {
          crypto: f.crypto,
          ...nativeAdapters(f.context)
        }),
        accounts = createBackupAccountsService({
          store: accountStore,
          assertIdle: () => {},
          prepareRemote: async () => {
            throw new Error('Unexpected network preparation')
          },
          prepareRuntime: async () => {
            throw new Error('Unexpected runtime preparation')
          }
        }),
        saved = await accounts.save(webdavAccount),
        backupStore = new RelayBackupStore(f.context, recoveryFixtureAdapters(f.context)),
        original = await backupStore.archive(),
        { password: _secret, ...metadata } = webdavAccount,
        changed = await accounts.save({
          ...metadata,
          id: saved.id,
          revision: saved.revision,
          password: 'fixture-replaced-password'
        })
      expect(changed.revision).not.toBe(saved.revision)
      let restored = false
      const backup = createBackupService({
          store: backupStore,
          assertIdle: () => {},
          pickImport: async () => original.bytes,
          writeExport: async () => false,
          confirmExport: async () => false,
          confirmRestore: async () => true,
          afterRestore: async () => {
            await expect(
              accountStore.read({ id: saved.id, revision: saved.revision })
            ).rejects.toThrow('未知修改')
            accounts.dataRestored()
            restored = true
          }
        }),
        prepared = await backup.prepareImport()
      if (!prepared.plan) throw new Error('Missing restored-account candidate')
      expect((await backup.restore({ id: prepared.plan.id })).status).toBe('restored')
      expect(restored).toBe(true)
      expect((await accounts.list()).accounts).toEqual([saved])
      expect(
        (await accountStore.credential({ id: saved.id, revision: saved.revision })).secret
      ).toBe(webdavAccount.password)
      expect(await readdir(f.directory(saved.id))).toEqual(['account.json'])
      expect((await backupStore.unresolved()).length).toBe(0)
    })
  })
  it('creates private directories and publishes a contiguous immutable account chain', async () => {
    await backupAccountsFixture(async (f) => {
      const store = new RelayBackupAccountsStore(f.context, {
          crypto: f.crypto,
          ...nativeAdapters(f.context)
        }),
        account = await store.save(webdavAccount),
        { password: _secret, ...metadata } = webdavAccount,
        updated = await store.save({
          ...metadata,
          id: account.id,
          revision: account.revision,
          name: 'Native updated'
        })
      expect(await readdir(f.directory(account.id))).toEqual([
        'account.json',
        'revision-000001.json'
      ])
      expect((await lstat(f.directory(account.id))).mode & 0o7777).toBe(0o700)
      expect((await store.credential({ id: updated.id, revision: updated.revision })).secret).toBe(
        webdavAccount.password
      )
      expect(
        await readFile(join(f.directory(account.id), 'revision-000001.json'), 'utf8')
      ).not.toContain(webdavAccount.password)
    })
  })
  it('does not adopt a pre-existing account directory or write into it', async () => {
    await backupAccountsFixture(async (f) => {
      const adapters = nativeAdapters(f.context),
        id = randomUUID(),
        directory = f.directory(id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, 'FOREIGN'), 'keep', { mode: 0o600 })
      const value = await lstat(f.context.stateRoot)
      await expect(
        adapters.createDirectory({
          id,
          stateIdentity: {
            dev: Number(value.dev),
            ino: Number(value.ino),
            uid: Number(value.uid),
            mode: Number(value.mode)
          }
        })
      ).rejects.toThrow('事务结果未确认')
      expect(await readdir(directory)).toEqual(['FOREIGN'])
    })
  })
  it('refuses a replacement account directory after Node validation without adding ciphertext or metadata', async () => {
    await backupAccountsFixture(async (f) => {
      const adapters = nativeAdapters(f.context)
      let raced = false
      const store = new RelayBackupAccountsStore(f.context, {
          crypto: f.crypto,
          ...adapters,
          publish: async (request) => {
            if (!raced && request.name.startsWith('revision-')) {
              raced = true
              const path = f.directory(request.id)
              await rename(path, path + '-retained')
              await mkdir(path, { mode: 0o700 })
              await writeFile(join(path, 'FOREIGN'), 'keep', { mode: 0o600 })
            }
            await adapters.publish(request)
          }
        }),
        account = await store.save(webdavAccount),
        { password: _secret, ...metadata } = webdavAccount
      await expect(
        store.save({ ...metadata, id: account.id, revision: account.revision, name: 'Changed' })
      ).rejects.toThrow('结果未确认')
      expect(raced).toBe(true)
      expect(await readdir(f.directory(account.id))).toEqual(['FOREIGN'])
      expect(await readFile(join(f.directory(account.id), 'FOREIGN'), 'utf8')).toBe('keep')
    })
  })
  it('preserves a foreign revision arriving between Node checks and Native publication', async () => {
    await backupAccountsFixture(async (f) => {
      const adapters = nativeAdapters(f.context)
      let raced = false
      const store = new RelayBackupAccountsStore(f.context, {
          crypto: f.crypto,
          ...adapters,
          publish: async (request) => {
            if (!raced && request.name.startsWith('revision-')) {
              raced = true
              await writeFile(join(f.directory(request.id), request.name), 'FOREIGN-KEEP-EXACT', {
                mode: 0o600,
                flag: 'wx'
              })
            }
            await adapters.publish(request)
          }
        }),
        account = await store.save(webdavAccount),
        { password: _secret, ...metadata } = webdavAccount
      await expect(
        store.save({ ...metadata, id: account.id, revision: account.revision, name: 'Changed' })
      ).rejects.toThrow('结果未确认')
      expect(raced).toBe(true)
      expect(await readFile(join(f.directory(account.id), 'revision-000001.json'), 'utf8')).toBe(
        'FOREIGN-KEEP-EXACT'
      )
      expect(await readdir(f.directory(account.id))).toEqual([
        'account.json',
        'revision-000001.json'
      ])
    })
  })
  it('allows exactly one Native publisher for a revision instead of creating branches or replacing either body', async () => {
    await backupAccountsFixture(async (f) => {
      const adapters = nativeAdapters(f.context)
      let statuses: string[] = []
      const store = new RelayBackupAccountsStore(f.context, {
          crypto: f.crypto,
          ...adapters,
          publish: async (request) => {
            if (request.name === 'account.json') return adapters.publish(request)
            const attempts = await Promise.allSettled([
              adapters.publish(request),
              adapters.publish(request)
            ])
            statuses = attempts.map((result) => result.status).sort()
            if (statuses.join(',') !== 'fulfilled,rejected')
              throw new Error('exclusive publication was not unique')
          }
        }),
        account = await store.save(webdavAccount),
        { password: _secret, ...metadata } = webdavAccount,
        updated = await store.save({
          ...metadata,
          id: account.id,
          revision: account.revision,
          name: 'One winner'
        })
      expect(statuses).toEqual(['fulfilled', 'rejected'])
      expect((await store.list()).accounts).toEqual([updated])
      expect(await readdir(f.directory(account.id))).toEqual([
        'account.json',
        'revision-000001.json'
      ])
    })
  })
})
