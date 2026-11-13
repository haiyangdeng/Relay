import { createHash } from 'crypto'
import { lstat, readFile, readdir, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { RelayBackupAccountsStore } from './accounts-store'
import { backupAccountsFixture, webdavAccount, gistAccount } from './accounts.test-fixture'

describe('Saved backup accounts, isolated storage and injected crypto', () => {
  it('saves only encrypted secret material and lists metadata across restart without decrypting', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(webdavAccount),
        bytes = await readFile(join(f.directory(account.id), 'account.json'), 'utf8')
      expect(bytes).not.toContain(webdavAccount.password)
      expect(bytes).not.toContain('"secret"')
      expect((await lstat(f.directory(account.id))).mode & 0o7777).toBe(0o700)
      expect((await lstat(join(f.directory(account.id), 'account.json'))).mode & 0o7777).toBe(0o600)
      f.crypto.available.mockClear()
      f.crypto.decrypt.mockClear()
      expect(await f.reopen().list()).toEqual({ accounts: [account], incomplete: 0 })
      expect(f.crypto.available).not.toHaveBeenCalled()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(JSON.stringify(account)).not.toMatch(/password|token|encryptedCredential/u)
      expect(
        (await f.reopen().credential({ id: account.id, revision: account.revision })).secret
      ).toBe(webdavAccount.password)
    })
  })
  it('fails closed without a publisher or usable system encryption and does not create account files', async () => {
    await backupAccountsFixture(async (f) => {
      const noPublisher = new RelayBackupAccountsStore(f.context, { crypto: f.crypto })
      await expect(noPublisher.save(gistAccount)).rejects.toThrow('发布尚未接通')
      expect(f.crypto.available).not.toHaveBeenCalled()
      f.crypto.available.mockResolvedValue(false)
      await expect(f.store.save(gistAccount)).rejects.toThrow('加密不可用')
      expect(f.publish).not.toHaveBeenCalled()
      expect(await f.store.list()).toEqual({ accounts: [], incomplete: 0 })
    })
  })
  it('updates public metadata without decrypting or replacing immutable credential records', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(gistAccount),
        anchor = await readFile(join(f.directory(account.id), 'account.json'))
      f.crypto.encrypt.mockClear()
      f.crypto.decrypt.mockClear()
      const updated = await f.store.save({
        id: account.id,
        revision: account.revision,
        name: 'Renamed',
        provider: 'gist',
        proxyPort: 17892
      })
      expect(updated.revision).not.toBe(account.revision)
      expect(updated.name).toBe('Renamed')
      expect(await readFile(join(f.directory(account.id), 'account.json'))).toEqual(anchor)
      expect(f.crypto.encrypt).not.toHaveBeenCalled()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      await expect(f.store.read({ id: account.id, revision: account.revision })).rejects.toThrow(
        '修订已变化'
      )
      expect(
        (await f.store.credential({ id: updated.id, revision: updated.revision })).secret
      ).toBe(gistAccount.token)
    })
  })
  it.each(['directoryURL', 'username'] as const)(
    'requires a newly supplied secret when changing %s',
    async (field) => {
      await backupAccountsFixture(async (f) => {
        const account = await f.store.save(webdavAccount),
          { password: _password, ...metadata } = webdavAccount,
          changed = {
            ...metadata,
            id: account.id,
            revision: account.revision,
            [field]: field === 'directoryURL' ? 'https://other.example.test/relay/' : 'other-user'
          }
        await expect(f.store.save(changed)).rejects.toThrow('重新输入秘密')
        expect(await readdir(f.directory(account.id))).toEqual(['account.json'])
        const updated = await f.store.save({ ...changed, password: 'replacement-secret' })
        expect(
          (await f.store.credential({ id: updated.id, revision: updated.revision })).secret
        ).toBe('replacement-secret')
      })
    }
  )
  it.each(['other-account', 'changed-endpoint'] as const)(
    'rejects ciphertext replay into %s after restart',
    async (change) => {
      await backupAccountsFixture(async (f) => {
        const first = await f.store.save(webdavAccount),
          second = await f.store.save({ ...webdavAccount, name: 'Second' }),
          path = join(f.directory(second.id), 'account.json'),
          raw = JSON.parse(await readFile(path, 'utf8'))
        if (change === 'other-account')
          raw.encryptedCredential = JSON.parse(
            await readFile(join(f.directory(first.id), 'account.json'), 'utf8')
          ).encryptedCredential
        else raw.account.directoryURL = 'https://changed.example.test/relay/'
        await writeFile(path, JSON.stringify(raw), { mode: 0o600 })
        const reopened = f.reopen(),
          listed = (await reopened.list()).accounts.find((a) => a.id === second.id)
        if (!listed) throw new Error('metadata should remain visible without decrypting')
        await expect(
          reopened.credential({ id: listed.id, revision: listed.revision })
        ).rejects.toThrow('绑定不符')
      })
    }
  )
  it('preserves unknown files and refuses gaps instead of selecting an older record', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(gistAccount)
      await f.store.save({
        id: account.id,
        revision: account.revision,
        name: 'New name',
        provider: 'gist',
        proxyPort: 17891
      })
      await rename(
        join(f.directory(account.id), 'revision-000001.json'),
        join(f.directory(account.id), 'revision-000002.json')
      )
      expect(await f.reopen().list()).toEqual({ accounts: [], incomplete: 1 })
      expect(await readdir(f.directory(account.id))).toContain('revision-000002.json')
    })
  })
  it('disables via an immutable record, rejects use and never claims to erase historical ciphertext', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(gistAccount),
        disabled = await f.store.disable({ id: account.id, revision: account.revision })
      expect(disabled.state).toBe('disabled')
      f.crypto.decrypt.mockClear()
      await expect(
        f.store.credential({ id: disabled.id, revision: disabled.revision })
      ).rejects.toThrow('停用')
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(await readdir(f.directory(account.id))).toEqual([
        'account.json',
        'revision-000001.json'
      ])
    })
  })
  it('recovers the exact attempted new record after a publication acknowledgment fails without automatic retry', async () => {
    await backupAccountsFixture(async (f) => {
      const real = f.publish.getMockImplementation()
      if (!real) throw new Error('missing publisher')
      f.publish.mockImplementationOnce(async (request) => {
        await real(request)
        throw new Error('published but reply lost')
      })
      await expect(f.store.save(gistAccount)).rejects.toThrow('结果未确认')
      expect(f.publish).toHaveBeenCalledTimes(1)
      const listed = await f.store.list()
      expect(listed.incomplete).toBe(0)
      expect(listed.accounts).toHaveLength(1)
    })
  })
  it('does not forget a known head on ordinary refresh and only accepts an explicit restored prefix after clearTrust', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save(gistAccount)
      await f.store.save({
        id: account.id,
        revision: account.revision,
        name: 'New revision',
        provider: 'gist',
        proxyPort: 17891
      })
      await rename(
        join(f.directory(account.id), 'revision-000001.json'),
        join(f.context.home, 'retained-for-confirmed-restore')
      )
      expect(await f.store.list()).toEqual({ accounts: [], incomplete: 1 })
      f.store.clearTrust()
      expect(await f.store.list()).toEqual({ accounts: [account], incomplete: 0 })
      expect(
        (await f.store.credential({ id: account.id, revision: account.revision })).secret
      ).toBe(gistAccount.token)
    })
  })
  it('reserves the final bounded revision for disabling without encrypting, decrypting or overwriting history', async () => {
    await backupAccountsFixture(async (f) => {
      const initial = await f.store.save(gistAccount),
        anchor = await readFile(join(f.directory(initial.id), 'account.json')),
        base = JSON.parse(anchor.toString('utf8'))
      let parent = initial.revision
      // An existing bounded history from earlier sessions, not 99 redundant UI writes.
      for (let sequence = 1; sequence <= 99; ++sequence) {
        const bytes = Buffer.from(JSON.stringify({ ...base, sequence, parentSHA256: parent }))
        await writeFile(
          join(f.directory(initial.id), 'revision-' + String(sequence).padStart(6, '0') + '.json'),
          bytes,
          { mode: 0o600, flag: 'wx' }
        )
        parent = createHash('sha256').update(bytes).digest('hex')
      }
      const reopened = f.reopen(),
        selected = { id: initial.id, revision: parent }
      f.crypto.encrypt.mockClear()
      f.crypto.decrypt.mockClear()
      await expect(reopened.save({ ...gistAccount, ...selected })).rejects.toThrow('请停用后新建')
      expect(f.crypto.encrypt).not.toHaveBeenCalled()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect((await reopened.disable(selected)).state).toBe('disabled')
      expect((await readdir(f.directory(initial.id))).length).toBe(101)
      expect(await readFile(join(f.directory(initial.id), 'account.json'))).toEqual(anchor)
      expect(f.crypto.encrypt).not.toHaveBeenCalled()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
    })
  })
  it('supports an explicitly supplied empty WebDAV password without treating it as missing', async () => {
    await backupAccountsFixture(async (f) => {
      const account = await f.store.save({ ...webdavAccount, password: '' })
      expect(
        (await f.store.credential({ id: account.id, revision: account.revision })).secret
      ).toBe('')
    })
  })
})
