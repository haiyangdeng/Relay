import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { createBackupArchive } from './archive'
import { RelayBackupStore } from './store'
import { createBackupService } from './service'
import { createRemoteBackupService } from './remote-service'
import { recoveryFixtureAdapters } from './recovery.test-fixture'

const request = {
  provider: 'webdav',
  action: 'upload',
  proxyPort: 17891,
  url: 'https://dav.example/Relay/unique.json',
  username: 'fixture-user',
  password: 'fixture-password'
}
async function fixture(
  run: (state: {
    stateRoot: string
    store: RelayBackupStore
    local: ReturnType<typeof createBackupService>
    service: ReturnType<typeof createRemoteBackupService>
    adapters: Parameters<typeof createRemoteBackupService>[0]
    transport: {
      upload: ReturnType<typeof vi.fn>
      download: ReturnType<typeof vi.fn>
      list: ReturnType<typeof vi.fn>
    }
    restoreConfirmed: { value: boolean }
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-remote-backup-'))
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
  await mkdir(join(context.stateRoot, 'Configuration'), { recursive: true, mode: 0o700 })
  await writeFile(join(context.stateRoot, 'Configuration/configuration-edit.json'), 'old', {
    mode: 0o600
  })
  const store = new RelayBackupStore(context, recoveryFixtureAdapters(context))
  const bytes = createBackupArchive({
    directories: ['Configuration'],
    entries: [
      {
        path: 'Configuration/configuration-edit.json',
        mode: 0o600,
        bytes: Buffer.from('remote-new')
      }
    ]
  })
  const restoreConfirmed = { value: false }
  const local = createBackupService({
    store,
    pickImport: async () => undefined,
    writeExport: async () => false,
    confirmExport: async () => false,
    confirmRestore: async () => restoreConfirmed.value,
    assertIdle: () => {}
  })
  const transport = {
    list: vi.fn(async () => ({ page: 1, scanned: 0, entries: [] })),
    upload: vi.fn(async () => ({ status: 'uploaded' as const })),
    download: vi.fn(async () => bytes)
  }
  const adapters = {
    store,
    prepareArchive: (bytes: Buffer, signal: AbortSignal) => local.prepareArchive(bytes, signal),
    confirmTransfer: vi.fn(async () => false),
    assertIdle: vi.fn(),
    transport
  }
  try {
    await run({
      stateRoot: context.stateRoot,
      store,
      local,
      service: createRemoteBackupService(adapters),
      adapters,
      transport,
      restoreConfirmed
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('Remote backup service confirmation and local handoff', () => {
  it('revokes saved-account evidence after native confirmation without contacting the remote', async () => {
    await fixture(async ({ service, adapters, transport }) => {
      let active = true
      const recheck = vi.fn(async () => {
        if (!active) throw new Error('PRIVATE-account-password')
      })
      const plan = await service.prepare(
        { ...request, action: 'list', url: 'https://dav.example/Relay/' },
        recheck
      )
      adapters.confirmTransfer.mockImplementationOnce(async () => {
        active = false
        return true
      })
      await expect(service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('账号已变化')
      expect(transport.list).not.toHaveBeenCalled()
      expect(transport.upload).not.toHaveBeenCalled()
      expect(transport.download).not.toHaveBeenCalled()
      await expect(service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('失效')
    })
  })
  it('rechecks a saved account after downloaded bytes return and does not stage an unauthorized restore', async () => {
    await fixture(async ({ service, adapters, transport }) => {
      let active = true
      const plan = await service.prepare({ ...request, action: 'download' }, async () => {
        if (!active) throw new Error('Fixture account changed')
      })
      adapters.confirmTransfer.mockResolvedValue(true)
      const perform = transport.download.getMockImplementation()
      if (!perform) throw new Error('Missing download fixture')
      transport.download.mockImplementationOnce(async () => {
        const bytes = await perform()
        active = false
        return bytes
      })
      const stage = vi.spyOn(adapters, 'prepareArchive')
      await expect(service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('账号已变化')
      expect(stage).not.toHaveBeenCalled()
    })
  })
  it('aborts the delegated local proof if a saved account changes while local restore staging awaits', async () => {
    await fixture(async ({ service, adapters, local }) => {
      let active = true
      const plan = await service.prepare({ ...request, action: 'download' }, async () => {
        if (!active) throw new Error('Fixture account changed')
      })
      adapters.confirmTransfer.mockResolvedValue(true)
      const stage = adapters.prepareArchive
      let restoreId = ''
      vi.spyOn(adapters, 'prepareArchive').mockImplementationOnce(async (bytes, signal) => {
        const result = await stage(bytes, signal)
        restoreId = result.plan?.id ?? ''
        active = false
        return result
      })
      await expect(service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('账号已变化')
      expect(restoreId).not.toBe('')
      await expect(local.restore({ id: restoreId })).rejects.toThrow('失效')
    })
  })
  it('prepares Gist listing without reading a local archive, requires confirmation and never stages a restore', async () => {
    await fixture(async ({ service, adapters, transport, store }) => {
      const archive = vi.spyOn(store, 'archive'),
        restore = vi.spyOn(adapters, 'prepareArchive')
      const request = {
        provider: 'gist',
        action: 'list',
        token: 'fixture-token',
        proxyPort: 17891,
        page: 1
      }
      const first = await service.prepare(request)
      expect(first).toMatchObject({ action: 'list', encrypted: false, containsSecrets: false })
      expect(JSON.stringify(first)).not.toContain('fixture-token')
      expect(archive).not.toHaveBeenCalled()
      expect(transport.list).not.toHaveBeenCalled()
      expect(await service.execute({ evidenceId: first.evidenceId })).toEqual({
        status: 'cancelled'
      })
      adapters.confirmTransfer = async () => true
      const next = await service.prepare(request)
      expect(await service.execute({ evidenceId: next.evidenceId })).toEqual({
        status: 'listed',
        listing: { page: 1, scanned: 0, entries: [] }
      })
      expect(transport.list).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal))
      expect(restore).not.toHaveBeenCalled()
      expect(transport.download).not.toHaveBeenCalled()
      expect(transport.upload).not.toHaveBeenCalled()
    })
  })
  it('keeps a list request in the common close barrier and discards late results after cancellation', async () => {
    await fixture(async ({ service, adapters, transport }) => {
      let finish: (result: { page: number; scanned: number; entries: [] }) => void = () => {
        throw new Error('No request.')
      }
      transport.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      adapters.confirmTransfer = async () => true
      const plan = await service.prepare({
        provider: 'gist',
        action: 'list',
        token: 'fixture-token',
        proxyPort: 17891
      })
      const operation = service.execute({ evidenceId: plan.evidenceId })
      await vi.waitFor(() => expect(transport.list).toHaveBeenCalled())
      await expect(service.prepare(request)).rejects.toThrow('等待')
      service.cancel()
      const idle = service.whenIdle()
      expect(service.isBusy()).toBe(true)
      finish({ page: 1, scanned: 0, entries: [] })
      expect(await operation).toEqual({ status: 'cancelled' })
      await idle
    })
  })
  it('prepares a fixed archive without network and never returns credentials to the renderer', async () => {
    await fixture(async ({ service, transport, adapters }) => {
      const plan = await service.prepare(request)
      expect(plan).toMatchObject({
        provider: 'webdav',
        action: 'upload',
        endpoint: request.url,
        containsSecrets: true,
        encrypted: false
      })
      expect(JSON.stringify(plan)).not.toContain('fixture-password')
      expect(JSON.stringify(plan)).not.toContain('fixture-user')
      expect(transport.upload).not.toHaveBeenCalled()
      expect(transport.download).not.toHaveBeenCalled()
      expect((await service.execute({ evidenceId: plan.evidenceId })).status).toBe('cancelled')
      expect(adapters.confirmTransfer).toHaveBeenCalledWith(plan)
      expect(transport.upload).not.toHaveBeenCalled()
      await expect(service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('失效')
    })
  })
  it('binds transfer confirmation to the staged bytes and rechecks freshness after consent', async () => {
    await fixture(async ({ service, transport, adapters }) => {
      const plan = await service.prepare(request)
      adapters.confirmTransfer = async () => true
      expect((await service.execute({ evidenceId: plan.evidenceId })).status).toBe('uploaded')
      expect(transport.upload).toHaveBeenCalledWith(
        expect.objectContaining({ url: request.url, password: request.password }),
        expect.any(Buffer),
        expect.any(AbortSignal)
      )
      let clock = 1000
      const timed = createRemoteBackupService({
        ...adapters,
        now: () => clock,
        confirmTransfer: async () => {
          clock += 60001
          return true
        }
      })
      const next = await timed.prepare(request)
      await expect(timed.execute({ evidenceId: next.evidenceId })).rejects.toThrow('过期')
      expect(transport.upload).toHaveBeenCalledTimes(1)
      await expect(timed.execute({ evidenceId: next.evidenceId })).rejects.toThrow('失效')
    })
  })
  it('stages downloaded bytes through the common restore proof and still requires separate restore confirmation', async () => {
    await fixture(async ({ service, local, adapters, stateRoot, restoreConfirmed, transport }) => {
      const plan = await service.prepare({ ...request, action: 'download' })
      expect(transport.download).not.toHaveBeenCalled()
      adapters.confirmTransfer = async () => true
      const result = await service.execute({ evidenceId: plan.evidenceId })
      expect(result.status).toBe('prepared')
      expect(result.plan?.containsSecrets).toBe(true)
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'old'
      )
      expect((await local.restore({ id: result.plan?.id })).status).toBe('cancelled')
      const next = await service.prepare({ ...request, action: 'download' })
      const inspected = await service.execute({ evidenceId: next.evidenceId })
      restoreConfirmed.value = true
      expect((await local.restore({ id: inspected.plan?.id })).status).toBe('restored')
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'remote-new'
      )
      expect(transport.upload).not.toHaveBeenCalled()
    })
  })
  it('rejects unknown local changes between remote preflight and restore confirmation', async () => {
    await fixture(async ({ service, local, adapters, stateRoot, restoreConfirmed }) => {
      adapters.confirmTransfer = async () => true
      const plan = await service.prepare({ ...request, action: 'download' })
      const result = await service.execute({ evidenceId: plan.evidenceId })
      await writeFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'unknown-change', {
        mode: 0o600
      })
      restoreConfirmed.value = true
      await expect(local.restore({ id: result.plan?.id })).rejects.toThrow('未知修改')
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'unknown-change'
      )
    })
  })
  it('keeps transfer and local staging in one idle barrier and honors cancellation before staging', async () => {
    await fixture(async ({ service, transport, adapters }) => {
      let finish!: (bytes: Buffer) => void
      transport.download.mockImplementationOnce(
        () =>
          new Promise<Buffer>((resolve) => {
            finish = resolve
          })
      )
      adapters.confirmTransfer = async () => true
      const stage = vi.spyOn(adapters, 'prepareArchive')
      const plan = await service.prepare({ ...request, action: 'download' })
      const work = service.execute({ evidenceId: plan.evidenceId })
      await vi.waitFor(() => expect(transport.download).toHaveBeenCalled())
      expect(service.isBusy()).toBe(true)
      const idle = vi.fn()
      const waiting = service.whenIdle().then(idle)
      await expect(service.prepare(request)).rejects.toThrow('请等待')
      expect(idle).not.toHaveBeenCalled()
      service.cancel()
      expect(transport.download.mock.calls[0][1].aborted).toBe(true)
      finish(Buffer.from('unused'))
      expect((await work).status).toBe('cancelled')
      await waiting
      expect(stage).not.toHaveBeenCalled()
      expect(service.isBusy()).toBe(false)
    })
  })
  it('does not recreate an opaque proof when a pending archive preparation was cancelled', async () => {
    await fixture(async ({ service, store }) => {
      const archive = await store.archive()
      let finish!: (value: typeof archive) => void
      vi.spyOn(store, 'archive').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const preparing = service.prepare(request)
      const failed = expect(preparing).rejects.toThrow('已取消')
      service.cancel()
      finish(archive)
      await failed
      expect(service.isBusy()).toBe(false)
      await expect(service.execute({ evidenceId: 'cancelled' })).rejects.toThrow('失效')
    })
  })
  it('does not release the exit barrier between the completed download and local staging', async () => {
    await fixture(async ({ service, adapters }) => {
      let finish!: () => void
      adapters.confirmTransfer = async () => true
      const stage = adapters.prepareArchive
      adapters.prepareArchive = async (bytes, signal) => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return stage(bytes, signal)
      }
      const prepared = await service.prepare({ ...request, action: 'download' })
      const work = service.execute({ evidenceId: prepared.evidenceId })
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      const idle = vi.fn()
      const waiting = service.whenIdle().then(idle)
      expect(service.isBusy()).toBe(true)
      await expect(service.prepare(request)).rejects.toThrow('请等待')
      expect(idle).not.toHaveBeenCalled()
      finish()
      expect((await work).status).toBe('prepared')
      await waiting
      expect(service.isBusy()).toBe(false)
    })
  })
  it('returns cancelled and revokes the local proof when cancellation arrives inside the staging handoff', async () => {
    await fixture(async ({ service, adapters, local, stateRoot }) => {
      const published = Promise.withResolvers<Awaited<ReturnType<typeof local.prepareArchive>>>()
      const release = Promise.withResolvers<void>()
      const stage = adapters.prepareArchive
      adapters.prepareArchive = async (bytes, signal) => {
        const result = await stage(bytes, signal)
        published.resolve(result)
        await release.promise
        return result
      }
      adapters.confirmTransfer = async () => true
      const prepared = await service.prepare({ ...request, action: 'download' })
      const work = service.execute({ evidenceId: prepared.evidenceId })
      const result = await published.promise
      expect(result.plan).toBeDefined()
      expect(service.isBusy()).toBe(true)
      service.cancel()
      release.resolve()
      expect((await work).status).toBe('cancelled')
      await expect(local.restore({ id: result.plan?.id })).rejects.toThrow('失效')
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'old'
      )
    })
  })
})
