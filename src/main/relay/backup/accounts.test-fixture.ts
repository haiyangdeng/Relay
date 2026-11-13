import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { vi } from 'vitest'
import { RelayBackupAccountsStore, type BackupAccountPublication } from './accounts-store'

// Unit tests use a private injected publisher and ephemeral AES key. Native
// pin-fd publication is exercised separately; no system keychain is touched.
export async function backupAccountsFixture(
  run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>
): Promise<void> {
  const f = await createFixture()
  try {
    await run(f)
  } finally {
    await rm(f.context.home, { recursive: true, force: true })
  }
}
async function createFixture() {
  const home = await realpath(await mkdtemp('/private/tmp/relay-backup-accounts-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
    key = randomBytes(32)
  await mkdir(context.stateRoot, { recursive: true, mode: 0o700 })
  const crypto = {
      available: vi.fn(async () => true),
      encrypt: vi.fn(async (text: string) => {
        const nonce = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', key, nonce)
        return Buffer.concat([
          nonce,
          cipher.update(text, 'utf8'),
          cipher.final(),
          cipher.getAuthTag()
        ])
      }),
      decrypt: vi.fn(async (bytes: Buffer) => {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
        decipher.setAuthTag(bytes.subarray(-16))
        return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
          'utf8'
        )
      })
    },
    publish = vi.fn(async (request: BackupAccountPublication) => {
      await writeFile(
        join(context.stateRoot, 'Configuration/BackupAccounts', request.id, request.name),
        request.bytes,
        { flag: 'wx', mode: 0o600 }
      )
    }),
    createDirectory = vi.fn(async ({ id }: { id: string }) => {
      const directory = join(context.stateRoot, 'Configuration/BackupAccounts', id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const { lstat } = await import('fs/promises')
      const value = await lstat(directory)
      return {
        dev: Number(value.dev),
        ino: Number(value.ino),
        uid: Number(value.uid),
        mode: Number(value.mode)
      }
    }),
    store = new RelayBackupAccountsStore(context, { crypto, publish, createDirectory }),
    reopen = () => new RelayBackupAccountsStore(context, { crypto, publish, createDirectory })
  return {
    context,
    crypto,
    publish,
    createDirectory,
    store,
    reopen,
    directory: (id: string) => join(context.stateRoot, 'Configuration/BackupAccounts', id)
  }
}
export const webdavAccount = {
  name: 'Private WebDAV',
  provider: 'webdav' as const,
  proxyPort: 17891,
  directoryURL: 'https://backup.example.test/relay/',
  username: '用户',
  password: 'do-not-persist-plain-password'
}
export const gistAccount = {
  name: 'Private Gist',
  provider: 'gist' as const,
  proxyPort: 17891,
  token: 'github-test-secret-only'
}
