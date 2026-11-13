import { describe, expect, it } from 'vitest'
import { backupAccountMetadata, backupAccountRemoteRequest } from './backup-accounts'
import { remoteBackupRequest } from './backup-remote'
const selected = { id: '11111111-1111-4111-8111-111111111111', revision: '0'.repeat(64) }
describe('Backup account primitive enum boundaries', () => {
  it.each([Object('list'), { toString: () => 'list' }])(
    'rejects a boxed or coerced account action',
    (action) => {
      expect(() => backupAccountRemoteRequest({ ...selected, action })).toThrow()
    }
  )
  it.each([Object('active'), { toString: () => 'active' }])(
    'rejects a boxed or coerced persisted state',
    (state) => {
      expect(() =>
        backupAccountMetadata({
          id: selected.id,
          name: 'Name',
          provider: 'gist',
          proxyPort: 17891,
          state,
          hasCredential: true,
          createdAt: 1,
          updatedAt: 1
        })
      ).toThrow()
    }
  )
  it.each([
    { provider: Object('gist'), action: 'list' },
    { provider: 'gist', action: Object('list') }
  ])('rejects boxed transfer enums before request branching', (enums) => {
    expect(() =>
      remoteBackupRequest({ ...enums, proxyPort: 17891, token: 'test-only-token' })
    ).toThrow()
  })
  it('only accepts an explicit primitive download format and rejects raw AGE own fields', () => {
    expect(
      backupAccountRemoteRequest({
        ...selected,
        action: 'download',
        filename: 'old.zip',
        archiveFormat: 'legacy-zip'
      })
    ).toMatchObject({ archiveFormat: 'legacy-zip' })
    for (const archiveFormat of [undefined, 'unknown', Object('legacy-zip')])
      expect(() =>
        backupAccountRemoteRequest({ ...selected, action: 'download', archiveFormat })
      ).toThrow()
    for (const action of ['upload', 'list', 'delete'])
      expect(() =>
        backupAccountRemoteRequest({ ...selected, action, archiveFormat: 'legacy-zip' })
      ).toThrow()
    for (const secretKey of ['', undefined, 'AGE-SECRET-KEY-fixture'])
      expect(() =>
        backupAccountRemoteRequest({
          ...selected,
          action: 'download',
          archiveFormat: 'legacy-zip',
          secretKey
        })
      ).toThrow()
    expect(() =>
      backupAccountRemoteRequest({
        ...selected,
        action: 'download',
        archiveFormat: 'legacy-zip',
        recipient: ''
      })
    ).toThrow()
    expect(backupAccountRemoteRequest({ ...selected, action: 'download' })).not.toHaveProperty(
      'archiveFormat'
    )
  })
})
