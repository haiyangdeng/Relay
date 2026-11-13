import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  symlink,
  readdir
} from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { encryptAgeContent, decryptAgeContent } from '../../utils/age'
import { RelayBackupStore } from './store'
import { createBackupArchive } from './archive'
import { createBackupService } from './service'
import { writeBackupKeyFile } from './key-file'
import { recoveryFixtureAdapters } from './recovery.test-fixture'

async function fixture(
  run: (context: {
    stateRoot: string
    store: RelayBackupStore
    service: ReturnType<typeof createBackupService>
    adapters: Parameters<typeof createBackupService>[0]
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-backup-service-'))
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
  await mkdir(join(context.stateRoot, 'Configuration'), { recursive: true, mode: 0o700 })
  await writeFile(join(context.stateRoot, 'Configuration/configuration-edit.json'), 'old', {
    mode: 0o600
  })
  const store = new RelayBackupStore(context, recoveryFixtureAdapters(context))
  const archive = createBackupArchive({
    directories: ['Configuration'],
    entries: [
      { path: 'Configuration/configuration-edit.json', mode: 0o600, bytes: Buffer.from('new') }
    ]
  })
  const adapters = {
    store,
    pickImport: vi.fn(async () => archive),
    writeExport: vi.fn(async () => true),
    confirmExport: vi.fn(async () => false),
    confirmRestore: vi.fn(async () => false),
    assertIdle: vi.fn()
  }
  try {
    await run({
      stateRoot: context.stateRoot,
      store,
      adapters,
      service: createBackupService(adapters)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('Backup service confirmation and main-process file selection', () => {
  it.each(['archive', 'identity'] as const)(
    'does not open a save dialog for the %s after its confirmation was invalidated',
    async (kind) => {
      await fixture(async ({ service, adapters }) => {
        const confirm = async (): Promise<boolean> => {
          service.invalidatePending()
          return true
        }
        const write = vi.fn(async () => true)
        adapters.confirmExport = confirm
        adapters.writeExport = write
        adapters.assertKeyExportIdle = vi.fn()
        adapters.confirmKeyExport = confirm
        adapters.writeKeyExport = write
        const result = await (kind === 'archive' ? service.export() : service.exportKey())
        expect(result).toEqual({ status: 'cancelled' })
        expect(write).not.toHaveBeenCalled()
        expect(service.isBusy()).toBe(false)
      })
    }
  )
  it('expires an approved backup while the native destination chooser is open', async () => {
    await fixture(async ({ service, adapters }) => {
      const chooser = Promise.withResolvers<() => boolean>()
      const selected = Promise.withResolvers<void>()
      const publish = vi.fn()
      adapters.confirmExport = async () => true
      adapters.writeExport = async (bytes, isCurrent) => {
        chooser.resolve(isCurrent)
        await selected.promise
        if (!isCurrent()) return false
        publish(bytes)
        return true
      }
      const exporting = service.export()
      const isCurrent = await chooser.promise
      expect(isCurrent()).toBe(true)
      service.invalidatePending()
      expect(isCurrent()).toBe(false)
      selected.resolve()
      await expect(exporting).resolves.toEqual({ status: 'cancelled' })
      expect(publish).not.toHaveBeenCalled()
    })
  })
  it('performs no IO on construction and does not export credential-containing bytes without consent', async () => {
    await fixture(async ({ service, adapters }) => {
      expect(adapters.pickImport).not.toHaveBeenCalled()
      expect(adapters.writeExport).not.toHaveBeenCalled()
      expect((await service.export()).status).toBe('cancelled')
      expect(adapters.confirmExport).toHaveBeenCalledWith(
        expect.objectContaining({ containsSecrets: true, files: 1 })
      )
      expect(adapters.writeExport).not.toHaveBeenCalled()
      adapters.confirmExport = async () => true
      expect((await service.export()).status).toBe('exported')
      expect(adapters.writeExport).toHaveBeenCalledTimes(1)
    })
  })
  it('separates import inspection from restore and consumes a cancelled confirmation', async () => {
    await fixture(async ({ service, stateRoot }) => {
      const plan = (await service.prepareImport()).plan
      expect(plan?.containsSecrets).toBe(true)
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'old'
      )
      expect((await service.restore({ id: plan?.id })).status).toBe('cancelled')
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'old'
      )
      await expect(service.restore({ id: plan?.id })).rejects.toThrow('失效')
      await expect(service.restore({ path: '/tmp/other' })).rejects.toThrow('凭据')
    })
  })
  it('restores only after explicit confirmation and refuses unknown edits made while confirmation is open', async () => {
    await fixture(async ({ service, stateRoot, adapters }) => {
      const first = (await service.prepareImport()).plan
      adapters.confirmRestore = async () => {
        await writeFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'external', {
          mode: 0o600
        })
        return true
      }
      await expect(service.restore({ id: first?.id })).rejects.toThrow('未知修改')
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'external'
      )
      const next = (await service.prepareImport()).plan
      adapters.confirmRestore = async () => true
      expect((await service.restore({ id: next?.id })).status).toBe('restored')
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'new'
      )
    })
  })
  it('keeps an in-flight file dialog behind one busy barrier and lets close wait for it', async () => {
    await fixture(async ({ service, adapters }) => {
      let finish: (value: Buffer | undefined) => void = () => {}
      adapters.pickImport = () =>
        new Promise((resolve) => {
          finish = resolve
        })
      const operation = service.prepareImport()
      expect(service.isBusy()).toBe(true)
      await expect(service.export()).rejects.toThrow('等待')
      let closed = false
      const waiting = service.whenIdle().then(() => {
        closed = true
      })
      await Promise.resolve()
      expect(closed).toBe(false)
      finish(undefined)
      expect((await operation).status).toBe('cancelled')
      await waiting
      expect(service.isBusy()).toBe(false)
      expect(closed).toBe(true)
    })
  })
})

describe('Restored state refresh', () => {
  it('reloads caches only after a successful restore and reports uncertain if reloading fails', async () => {
    await fixture(async ({ service, adapters }) => {
      const refreshed = vi.fn(async () => {
        throw new Error('cache invalid')
      })
      adapters.afterRestore = refreshed
      const first = (await service.prepareImport()).plan
      expect((await service.restore({ id: first?.id })).status).toBe('cancelled')
      expect(refreshed).not.toHaveBeenCalled()
      const next = (await service.prepareImport()).plan
      adapters.confirmRestore = async () => true
      expect((await service.restore({ id: next?.id })).status).toBe('uncertain')
      expect(refreshed).toHaveBeenCalledOnce()
    })
  })
})

describe('Remote staging cancellation', () => {
  it('discards a staged restore proof when the transfer is cancelled during staging', async () => {
    await fixture(async ({ service, adapters, store, stateRoot }) => {
      const bytes = await adapters.pickImport()
      if (!bytes) throw new Error('missing fixture archive')
      const stage = store.stageRestore.bind(store)
      const staged = Promise.withResolvers<Awaited<ReturnType<typeof stage>>>()
      const release = Promise.withResolvers<void>()
      vi.spyOn(store, 'stageRestore').mockImplementationOnce(async (bytes) => {
        const plan = await stage(bytes)
        staged.resolve(plan)
        await release.promise
        return plan
      })
      const discard = vi.spyOn(store, 'discard')
      const controller = new AbortController()
      const preparing = service.prepareArchive(bytes, controller.signal)
      const plan = await staged.promise
      controller.abort()
      release.resolve()
      expect((await preparing).status).toBe('cancelled')
      expect(discard).toHaveBeenCalledWith(plan.id)
      await expect(service.restore({ id: plan.id })).rejects.toThrow('失效')
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'old'
      )
    })
  })
  it('revokes a published local proof if the originating transfer aborts before its handoff completes', async () => {
    await fixture(async ({ service, adapters, store }) => {
      const bytes = await adapters.pickImport()
      if (!bytes) throw new Error('missing fixture archive')
      const controller = new AbortController()
      const discard = vi.spyOn(store, 'discard')
      const result = await service.prepareArchive(bytes, controller.signal)
      expect(result.status).toBe('prepared')
      controller.abort()
      expect(discard).toHaveBeenCalledWith(result.plan?.id)
      await expect(service.restore({ id: result.plan?.id })).rejects.toThrow('失效')
      expect(service.isBusy()).toBe(false)
    })
  })
})

describe('Native-only AGE identity export', () => {
  it('does not export without an enabled host and never asks the full core-idle gate', async () => {
    await fixture(async ({ service, adapters }) => {
      await expect(service.exportKey()).rejects.toThrow('尚未接通')
      expect(adapters.assertIdle).not.toHaveBeenCalled()
      adapters.assertKeyExportIdle = vi.fn()
      adapters.confirmKeyExport = vi.fn(async () => false)
      adapters.writeKeyExport = vi.fn(async () => true)
      expect(await service.exportKey()).toEqual({ status: 'cancelled' })
      expect(adapters.writeKeyExport).not.toHaveBeenCalled()
      expect(adapters.assertIdle).not.toHaveBeenCalled()
    })
  })
  it('exports a private file and returns only a recipient that encrypts successfully with its identity', async () => {
    await fixture(async ({ service, adapters, stateRoot, store }) => {
      const archive = vi.spyOn(store, 'archive')
      const path = join(stateRoot, 'new-age-identity.txt')
      let transient: Buffer | undefined
      adapters.assertKeyExportIdle = vi.fn()
      adapters.assertIdle = () => {
        throw new Error('A live core must not block key export')
      }
      adapters.confirmKeyExport = async () => true
      adapters.writeKeyExport = async (bytes) => {
        transient = bytes
        await writeBackupKeyFile(path, bytes)
        return true
      }
      const result = await service.exportKey()
      if (result.status !== 'exported') throw new Error('Expected exported identity')
      expect(Object.keys(result).sort()).toEqual(['recipient', 'status'])
      expect(result.recipient).toMatch(/^age1/)
      expect(archive).not.toHaveBeenCalled()
      const identity = await readFile(path, 'utf8')
      expect(identity).toContain(`# public key: ${result.recipient}`)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      const encrypted = await encryptAgeContent('private-backup-fixture', result.recipient)
      expect(encrypted).not.toContain('private-backup-fixture')
      expect(await decryptAgeContent(encrypted, identity)).toBe('private-backup-fixture')
      expect(transient?.every((byte) => byte === 0)).toBe(true)
    })
  })
  it('waits for the save dialog, refuses concurrent backup operations and releases cancelled key bytes', async () => {
    await fixture(async ({ service, adapters }) => {
      const saving = Promise.withResolvers<Buffer>()
      const finish = Promise.withResolvers<boolean>()
      adapters.assertKeyExportIdle = vi.fn()
      adapters.confirmKeyExport = async () => true
      adapters.writeKeyExport = async (bytes) => {
        saving.resolve(bytes)
        return finish.promise
      }
      const exporting = service.exportKey()
      const bytes = await saving.promise
      await expect(service.export()).rejects.toThrow('等待')
      await expect(service.exportKey()).rejects.toThrow('等待')
      expect(() => service.cancel()).toThrow('结束文件选择')
      let idle = false
      const waiting = service.whenIdle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(idle).toBe(false)
      finish.resolve(false)
      expect(await exporting).toEqual({ status: 'cancelled' })
      await waiting
      expect(bytes.every((byte) => byte === 0)).toBe(true)
      expect(service.isBusy()).toBe(false)
    })
  })
  it('rejects expired or newly blocked confirmations before generating or writing', async () => {
    await fixture(async ({ adapters }) => {
      let clock = 100
      adapters.assertKeyExportIdle = vi.fn()
      adapters.confirmKeyExport = async () => {
        clock += 60001
        return true
      }
      adapters.writeKeyExport = vi.fn(async () => true)
      const service = createBackupService({ ...adapters, now: () => clock })
      await expect(service.exportKey()).rejects.toThrow('未确认保存')
      expect(adapters.writeKeyExport).not.toHaveBeenCalled()
      adapters.confirmKeyExport = async () => true
      let checks = 0
      adapters.assertKeyExportIdle = () => {
        if (++checks > 1) throw new Error('quitting')
      }
      await expect(createBackupService(adapters).exportKey()).rejects.toThrow('未确认保存')
      expect(adapters.writeKeyExport).not.toHaveBeenCalled()
    })
  })
  it('preserves staged restoration and sanitizes errors while releasing transient private bytes', async () => {
    await fixture(async ({ service, adapters }) => {
      const plan = (await service.prepareImport()).plan
      let transient: Buffer | undefined
      adapters.assertKeyExportIdle = vi.fn()
      adapters.confirmKeyExport = async () => true
      adapters.writeKeyExport = async (bytes) => {
        transient = bytes
        throw new Error(bytes.toString())
      }
      await expect(service.exportKey()).rejects.toThrow(/^AGE密钥未确认保存/)
      expect(transient?.every((byte) => byte === 0)).toBe(true)
      adapters.confirmRestore = async () => true
      expect((await service.restore({ id: plan?.id })).status).toBe('restored')
    })
  })
  it('never replaces existing files or symlinks and removes unpublished private temporary files', async () => {
    await fixture(async ({ stateRoot }) => {
      const existing = join(stateRoot, 'existing.txt')
      const link = join(stateRoot, 'linked.txt')
      await writeFile(existing, 'original', { mode: 0o600 })
      await symlink(existing, link)
      await expect(writeBackupKeyFile(existing, Buffer.from('new-private-key'))).rejects.toThrow()
      await expect(writeBackupKeyFile(link, Buffer.from('new-private-key'))).rejects.toThrow()
      await expect(writeBackupKeyFile('relative.txt', Buffer.from('x'))).rejects.toThrow(
        'destination'
      )
      expect(await readFile(existing, 'utf8')).toBe('original')
      expect((await readdir(stateRoot)).some((path) => path.startsWith('.relay-age-'))).toBe(false)
    })
  })
})
