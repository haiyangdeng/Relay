import { createHash } from 'crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubStoreResources } from '../substore/resources'
import { UpdateCandidateStore } from './store'
import { createUpdateService, type SubStoreCandidatePlan } from './service'
import type { TrustedUpdateAsset } from './catalog'

const homes: string[] = []
async function fixture() {
  const home = await realpath(await mkdtemp('/private/tmp/relay-substore-candidates-'))
  homes.push(home)
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
  const backend = Buffer.from('/* inert backend fixture, never executed */'),
    zip = new AdmZip()
  zip.addFile('dist/index.html', Buffer.from('<html>candidate fixture</html>'))
  const frontend = zip.toBuffer()
  const asset = (target: TrustedUpdateAsset['target'], bytes: Buffer): TrustedUpdateAsset => ({
    target,
    version: 'fixture',
    url: 'https://github.com/fixture/asset',
    releaseURL: 'https://github.com/fixture',
    downloadBytes: bytes.length,
    downloadSHA256: createHash('sha256').update(bytes).digest('hex'),
    encoding: 'identity',
    payloadBytes: bytes.length,
    payloadSHA256: createHash('sha256').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex')
  })
  const backendAsset = asset('substore-backend', backend),
    frontendAsset = asset('substore-frontend', frontend)
  const store = new UpdateCandidateStore(context, [backendAsset, frontendAsset])
  const backendRecord = await store.stage(backendAsset, backend),
    frontendRecord = await store.stage(frontendAsset, frontend)
  const pin = (asset: TrustedUpdateAsset) => ({
    version: asset.version,
    url: asset.url,
    releaseURL: asset.releaseURL,
    size: asset.payloadBytes,
    sha256: asset.payloadSHA256
  })
  const resources = new SubStoreResources(context.stateRoot, {
    schemaVersion: 1,
    backend: pin(backendAsset),
    frontend: pin(frontendAsset)
  })
  await resources.initialize()
  await writeFile(join(resources.dataRoot, 'data.json'), 'original business data', { mode: 0o600 })
  const confirmSubStore = vi.fn(async (_plan: SubStoreCandidatePlan) => false)
  const applySubStore = vi.fn(async (backend: Buffer, frontend: Buffer, signal: AbortSignal) => {
    await resources.install(backend, frontend, signal)
    await resources.load()
  })
  const adapters = {
    store,
    assertIdle: vi.fn(),
    assertSubStoreIdle: vi.fn(),
    confirmSubStore,
    applySubStore,
    confirmDownload: vi.fn(async () => false),
    confirmRemove: vi.fn(async () => false)
  }
  return {
    store,
    resources,
    backend,
    frontend,
    adapters,
    service: createUpdateService(adapters),
    input: { backendId: backendRecord.id, frontendId: frontendRecord.id }
  }
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('Separate application of an immutable Sub-Store candidate pair', () => {
  it('requires separate consent, copies exact private bytes, keeps business data and retains both candidates', async () => {
    const f = await fixture()
    expect(await f.service.applySubStore(f.input)).toEqual({ status: 'cancelled' })
    expect(f.adapters.applySubStore).not.toHaveBeenCalled()
    expect(JSON.stringify(f.adapters.confirmSubStore.mock.calls)).not.toContain('candidate.bin')
    f.adapters.confirmSubStore.mockResolvedValue(true)
    expect(await f.service.applySubStore(f.input)).toEqual({ status: 'applied' })
    expect(await readFile((await f.resources.load()).backendPath)).toEqual(f.backend)
    expect(await readFile(join(f.resources.dataRoot, 'data.json'), 'utf8')).toBe(
      'original business data'
    )
    expect((await f.store.list()).candidates).toHaveLength(2)
    expect(f.adapters.applySubStore).toHaveBeenCalledExactlyOnceWith(
      f.backend,
      f.frontend,
      expect.any(AbortSignal)
    )
  })
  it('refuses swapped IDs, unknown fields and a busy resource consumer before copying', async () => {
    const f = await fixture()
    await expect(f.service.applySubStore({ ...f.input, sourcePath: '/renderer' })).rejects.toThrow()
    await expect(
      f.service.applySubStore({ backendId: f.input.frontendId, frontendId: f.input.backendId })
    ).rejects.toThrow()
    f.adapters.assertSubStoreIdle.mockImplementation(() => {
      throw new Error('Consumer active.')
    })
    await expect(f.service.applySubStore(f.input)).rejects.toThrow()
    expect(f.adapters.applySubStore).not.toHaveBeenCalled()
    expect(f.adapters.confirmSubStore).not.toHaveBeenCalled()
  })
  it('revalidates candidate bytes and idleness after confirmation', async () => {
    const f = await fixture()
    f.adapters.confirmSubStore.mockImplementation(async () => {
      await writeFile((await f.store.resolve(f.input.frontendId)).path, 'tampered', { mode: 0o600 })
      return true
    })
    await expect(f.service.applySubStore(f.input)).rejects.toThrow('原件保留')
    expect(f.adapters.applySubStore).not.toHaveBeenCalled()
    expect((await f.store.list()).candidates).toHaveLength(1)
    expect((await f.store.list()).incomplete).toBe(1)
  })
  it('rechecks core-independent Sub-Store idleness after consent', async () => {
    const f = await fixture()
    f.adapters.confirmSubStore.mockImplementation(async () => {
      f.adapters.assertSubStoreIdle.mockImplementation(() => {
        throw new Error('Consumer became active.')
      })
      return true
    })
    await expect(f.service.applySubStore(f.input)).rejects.toThrow()
    expect(f.adapters.applySubStore).not.toHaveBeenCalled()
  })
  it('expires confirmation and does not start a resource transaction', async () => {
    const f = await fixture()
    let now = 1
    const service = createUpdateService({
      ...f.adapters,
      now: () => now,
      confirmSubStore: async () => {
        now = 60002
        return true
      }
    })
    await expect(service.applySubStore(f.input)).rejects.toThrow()
    expect(f.adapters.applySubStore).not.toHaveBeenCalled()
  })
  it('waits for cancelled consent and prevents concurrent candidate changes', async () => {
    const f = await fixture()
    let answer: (value: boolean) => void = () => {
      throw new Error('Missing prompt.')
    }
    f.adapters.confirmSubStore.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const operation = f.service.applySubStore(f.input)
    await vi.waitFor(() => expect(f.adapters.confirmSubStore).toHaveBeenCalled())
    await expect(f.service.remove({ id: f.input.backendId })).rejects.toThrow('等待')
    f.service.cancel()
    const idle = f.service.whenIdle()
    expect(f.service.isBusy()).toBe(true)
    answer(true)
    expect(await operation).toEqual({ status: 'cancelled' })
    await idle
    expect(f.adapters.applySubStore).not.toHaveBeenCalled()
  })
  it('reports failed private installation without losing either candidate or business data', async () => {
    const f = await fixture()
    f.adapters.confirmSubStore.mockResolvedValue(true)
    f.adapters.applySubStore.mockRejectedValue(new Error('PRIVATE injected failure'))
    await expect(f.service.applySubStore(f.input)).rejects.toThrow('原件保留')
    expect((await f.store.list()).candidates).toHaveLength(2)
    expect(await readFile(join(f.resources.dataRoot, 'data.json'), 'utf8')).toBe(
      'original business data'
    )
    expect(f.service.isBusy()).toBe(false)
  })
  it('waits for an already committed cache copy and returns its actual result after a late cancel', async () => {
    const f = await fixture()
    let finish: () => void = () => {
      throw new Error('No copy.')
    }
    let committed = false
    f.adapters.confirmSubStore.mockResolvedValue(true)
    f.adapters.applySubStore.mockImplementation(async (backend, frontend) => {
      await f.resources.install(backend, frontend, new AbortController().signal)
      committed = true
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    const operation = f.service.applySubStore(f.input)
    await vi.waitFor(() => expect(committed).toBe(true))
    f.service.cancel()
    expect(f.service.isBusy()).toBe(true)
    finish()
    expect(await operation).toEqual({ status: 'applied' })
    await f.service.whenIdle()
    expect((await f.resources.load()).files.has('/index.html')).toBe(true)
  })
})
