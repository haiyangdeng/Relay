import { createHash, randomUUID } from 'crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'fs/promises'
import { join, resolve } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { backupFileNative } from '../native'
import { backupPath } from './archive'
import {
  RelayWebdavReceiptStore,
  type WebdavOwnedReceipt,
  type WebdavReceiptInventory
} from './webdav-receipts'

function head(value: WebdavReceiptInventory): string {
  if (!value.headSHA256) throw new Error('Missing recorded head')
  return value.headSHA256
}

async function fixture(run: (f: Awaited<ReturnType<typeof open>>) => Promise<void>): Promise<void> {
  const f = await open()
  try {
    await run(f)
  } finally {
    await rm(f.context.home, { recursive: true, force: true })
  }
}
async function open() {
  const home = await realpath(await mkdtemp('/private/tmp/relay-webdav-receipts-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
    binding = {
      accountId: randomUUID(),
      directoryURL: 'https://backup.example.test/relay/',
      username: 'fixture-user'
    },
    directory = join(context.stateRoot, 'RemoteBackupReceipts', binding.accountId),
    executable = process.env.RELAY_WEBDAV_RECEIPT_NATIVE,
    getIdentity = async (path: string) => {
      const info = await lstat(path)
      return {
        dev: Number(info.dev),
        ino: Number(info.ino),
        uid: Number(info.uid),
        mode: Number(info.mode)
      }
    }
  await mkdir(context.stateRoot, { recursive: true, mode: 0o700 })
  type Adapters = ConstructorParameters<typeof RelayWebdavReceiptStore>[1]
  const adapters: Adapters = {
    createDirectory: vi.fn(async ({ id, stateIdentity }) => {
      if (executable)
        return (
          await backupFileNative(resolve(executable), context, {
            namespace: 'backup-receipt',
            id,
            directoryIdentity: stateIdentity,
            directory: true,
            name: '',
            mode: 0o700,
            bytes: ''
          })
        ).identity
      await mkdir(join(context.stateRoot, 'RemoteBackupReceipts'), { mode: 0o700, recursive: true })
      await mkdir(directory, { mode: 0o700 })
      return getIdentity(directory)
    }),
    publish: vi.fn(async (request) => {
      if (executable) {
        await backupFileNative(resolve(executable), context, {
          namespace: 'backup-receipt',
          id: request.id,
          directoryIdentity: request.directoryIdentity,
          name: request.name,
          mode: 0o600,
          bytes: request.bytes.toString('base64')
        })
      } else
        await writeFile(join(directory, request.name), request.bytes, { flag: 'wx', mode: 0o600 })
    })
  }
  const store = new RelayWebdavReceiptStore(context, adapters),
    reopen = () => new RelayWebdavReceiptStore(context, adapters),
    uploaded = (): WebdavOwnedReceipt => {
      const filename = `relay-${randomUUID()}-${randomUUID()}.json`
      return {
        url: new URL(filename, binding.directoryURL).href,
        filename,
        etag: '"v-' + randomUUID() + '"',
        envelopeSHA256: createHash('sha256').update(filename).digest('hex'),
        envelopeBytes: 1024
      }
    }
  return { context, binding, directory, store, adapters, reopen, uploaded }
}

describe('WebDAV durable facts, never persisted deletion grants', () => {
  it('reopens verified receipts and keeps this namespace out of backup/restore paths', async () => {
    await fixture(async (f) => {
      expect((await f.store.inspect(f.binding)).headSHA256).toBeNull()
      const initial = await f.store.open(f.binding, null),
        item = f.uploaded(),
        saved = await f.store.recordUploaded(f.binding, head(initial), item)
      expect(await f.reopen().inspect(f.binding)).toEqual(saved)
      expect(saved.owned).toEqual([item])
      expect(() =>
        backupPath(`RemoteBackupReceipts/${f.binding.accountId}/receipt-000000.json`)
      ).toThrow()
      const raw = (
        await Promise.all(
          (await readdir(f.directory)).map((name) => readFile(join(f.directory, name), 'utf8'))
        )
      ).join('')
      expect(raw).not.toMatch(/password|token|configuration|sessionOnly|keepCount|authorization/)
    })
  })
  it('keeps crash-stranded deletion intents out of future candidates without replay or adoption', async () => {
    await fixture(async (f) => {
      const initial = await f.store.open(f.binding, null),
        old = f.uploaded(),
        saved = await f.store.recordUploaded(f.binding, head(initial), old),
        started = await f.store.beginDeletion(f.binding, head(saved), old.url),
        next = f.reopen()
      expect((await next.inspect(f.binding)).uncertain).toEqual([old])
      await expect(next.finishDeletion(f.binding, started.ticket, 'not-submitted')).rejects.toThrow(
        '在途能力'
      )
      const fresh = f.uploaded(),
        later = await next.recordUploaded(f.binding, head(started.inventory), fresh)
      expect(later.owned).toEqual([fresh])
      expect(later.uncertain).toEqual([old])
      await expect(next.beginDeletion(f.binding, head(later), old.url)).rejects.toThrow('不属于')
    })
  })
  it('restores original completion order only with the process-held not-submitted ticket', async () => {
    await fixture(async (f) => {
      let state = await f.store.open(f.binding, null)
      const first = f.uploaded(),
        second = f.uploaded()
      state = await f.store.recordUploaded(f.binding, head(state), first)
      state = await f.store.recordUploaded(f.binding, head(state), second)
      const intent = await f.store.beginDeletion(f.binding, head(state), first.url)
      await expect(
        f.store.finishDeletion(f.binding, { ...intent.ticket }, 'not-submitted')
      ).rejects.toThrow('在途能力')
      state = await f.store.finishDeletion(f.binding, intent.ticket, 'not-submitted')
      expect(state.owned).toEqual([first, second])
      expect(state.uncertain).toEqual([])
      await expect(
        f.store.finishDeletion(f.binding, intent.ticket, 'not-submitted')
      ).rejects.toThrow('在途能力')
    })
  })
  it('records confirmed deletion once while never allowing the same URL to be reclaimed', async () => {
    await fixture(async (f) => {
      const initial = await f.store.open(f.binding, null),
        item = f.uploaded(),
        saved = await f.store.recordUploaded(f.binding, head(initial), item),
        intent = await f.store.beginDeletion(f.binding, head(saved), item.url),
        done = await f.store.finishDeletion(f.binding, intent.ticket, 'deleted')
      expect(done.owned).toEqual([])
      expect(done.uncertain).toEqual([])
      await expect(f.reopen().recordUploaded(f.binding, head(done), item)).rejects.toThrow('重复')
    })
  })
  it('rejects a stale head before appending or creating a directory', async () => {
    await fixture(async (f) => {
      const opened = await f.store.open(f.binding, null)
      await expect(f.store.open(f.binding, null)).rejects.toThrow('重新授权')
      await expect(f.store.recordUploaded(f.binding, 'f'.repeat(64), f.uploaded())).rejects.toThrow(
        '变化'
      )
      expect((await f.store.inspect(f.binding)).headSHA256).toBe(opened.headSHA256)
      expect(f.adapters.publish).toHaveBeenCalledTimes(1)
    })
  })
  it('does not reuse account facts after the username or canonical directory identity changes', async () => {
    await fixture(async (f) => {
      await f.store.open(f.binding, null)
      await expect(f.reopen().inspect({ ...f.binding, username: 'other' })).rejects.toThrow('来源')
      await expect(
        f.reopen().inspect({ ...f.binding, directoryURL: 'https://backup.example.test/elsewhere/' })
      ).rejects.toThrow('来源')
    })
  })
  it('rejects copied history in a newly created directory even with identical file bytes', async () => {
    await fixture(async (f) => {
      await f.store.open(f.binding, null)
      const bytes = await readFile(join(f.directory, 'receipt-000000.json'))
      await rename(f.directory, f.directory + '-original')
      await mkdir(f.directory, { mode: 0o700 })
      await writeFile(join(f.directory, 'receipt-000000.json'), bytes, { flag: 'wx', mode: 0o600 })
      await expect(f.reopen().inspect(f.binding)).rejects.toThrow('目录已变化')
      expect(await readFile(join(f.directory + '-original', 'receipt-000000.json'))).toEqual(bytes)
    })
  })
  it('detects same-process history truncation and preserves the remaining data', async () => {
    await fixture(async (f) => {
      const initial = await f.store.open(f.binding, null)
      await f.store.recordUploaded(f.binding, head(initial), f.uploaded())
      await rm(join(f.directory, 'receipt-000001.json'))
      await expect(f.store.inspect(f.binding)).rejects.toThrow('回退')
      expect(await readdir(f.directory)).toEqual(['receipt-000000.json'])
    })
  })
  it('refuses unknown files, a linked frame and corrupt parent chains without repairing them', async () => {
    await fixture(async (f) => {
      await f.store.open(f.binding, null)
      await writeFile(join(f.directory, 'foreign'), 'keep', { mode: 0o600 })
      await expect(f.reopen().inspect(f.binding)).rejects.toThrow('未知')
      await rm(join(f.directory, 'foreign'))
      await symlink('receipt-000000.json', join(f.directory, 'receipt-000001.json'))
      await expect(f.reopen().inspect(f.binding)).rejects.toThrow()
      expect(await readFile(join(f.directory, 'receipt-000000.json'), 'utf8')).toContain('created')
    })
  })
  it('rejects foreign filenames, weak tags, unexpected fields and invalid envelope bounds', async () => {
    await fixture(async (f) => {
      const initial = await f.store.open(f.binding, null),
        good = f.uploaded()
      for (const item of [
        { ...good, url: 'https://foreign.example.test/old.json' },
        { ...good, filename: '../old.json' },
        { ...good, etag: 'W/"weak"' },
        { ...good, envelopeBytes: 0 },
        { ...good, grant: true }
      ])
        await expect(f.store.recordUploaded(f.binding, head(initial), item)).rejects.toThrow()
      expect(await readdir(f.directory)).toEqual(['receipt-000000.json'])
    })
  })
  it('keeps a published-but-unacknowledged frame and cannot retry the same fact', async () => {
    await fixture(async (f) => {
      const initial = await f.store.open(f.binding, null),
        publish = f.adapters.publish,
        item = f.uploaded()
      if (!publish) throw new Error('Missing injected publisher')
      f.adapters.publish = async (request) => {
        await publish(request)
        throw new Error('lost Native reply')
      }
      await expect(f.store.recordUploaded(f.binding, head(initial), item)).rejects.toThrow(
        'lost Native'
      )
      f.adapters.publish = publish
      const after = await f.reopen().inspect(f.binding)
      expect(after.owned).toEqual([item])
      await expect(f.store.recordUploaded(f.binding, head(initial), item)).rejects.toThrow()
    })
  })
  it('does not write through a JS fallback when Native adapters are absent', async () => {
    await fixture(async (f) => {
      const store = new RelayWebdavReceiptStore(f.context, {})
      await expect(store.open(f.binding, null)).rejects.toThrow('发布器不可用')
      expect(await readdir(f.context.stateRoot)).toEqual([])
    })
  })
})
