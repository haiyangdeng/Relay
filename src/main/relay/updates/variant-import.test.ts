import { describe, expect, it, vi } from 'vitest'
import { trustedUpdateCatalog, publicUpdateAsset } from './catalog'
import { UpdateCandidateStore } from './store'
import { createUpdateService } from './service'
import { candidateVariantImport } from './variant-import'

function fixture(target = 'core-alpha') {
  const catalog = trustedUpdateCatalog('arm64'),
    asset = catalog.find((asset) => asset.target === target)
  if (!asset) throw new Error('Missing fixed fixture asset.')
  const record = {
    ...publicUpdateAsset(asset),
    id: '00000000-0000-4000-8000-000000000039',
    payloadBytes: asset.payloadBytes,
    payloadSHA256: asset.payloadSHA256,
    stagedAt: 1,
    installed: false as const,
    applied: false as const
  }
  const candidate = { record, path: '/private/candidate/from-main-only' }
  const store = new UpdateCandidateStore(
    { home: '/private/test', stateRoot: '/private/test/Library/Application Support/Relay' },
    catalog
  )
  vi.spyOn(store, 'resolve').mockImplementation(async () => structuredClone(candidate))
  const adapters = {
    store,
    assertIdle: vi.fn(),
    assertImportIdle: vi.fn(),
    confirmDownload: vi.fn(async () => false),
    confirmRemove: vi.fn(async () => false),
    confirmImport: vi.fn(async () => false),
    importCandidate: vi.fn(async () => {})
  }
  return {
    asset,
    candidate,
    adapters,
    service: createUpdateService(adapters),
    input: { id: record.id }
  }
}
describe('Separate confirmed import of a verified update candidate', () => {
  it.each([
    'core',
    'core-alpha',
    'core-smart',
    'smart-model',
    'smart-model-middle',
    'smart-model-large'
  ])('maps %s only to its exact compiled variant pin', (target) => {
    const f = fixture(target)
    expect(candidateVariantImport(f.candidate)).toMatchObject({
      sourcePath: f.candidate.path,
      version: f.asset.version,
      sha256: f.asset.payloadSHA256,
      size: f.asset.payloadBytes,
      kind: target.startsWith('core') ? 'core' : 'smart'
    })
    expect(() =>
      candidateVariantImport({
        ...f.candidate,
        record: { ...f.candidate.record, version: 'foreign' }
      })
    ).toThrow()
  })
  it('refuses non-variant candidates and unknown fields without an import prompt', async () => {
    const f = fixture('substore-backend')
    await expect(f.service.importVariant(f.input)).rejects.toThrow('未完成')
    await expect(f.service.importVariant({ ...f.input, sourcePath: '/renderer' })).rejects.toThrow()
    expect(f.adapters.confirmImport).not.toHaveBeenCalled()
    expect(f.adapters.importCandidate).not.toHaveBeenCalled()
  })
  it('requires a fresh separate confirmation and never exposes the private path in prompt metadata', async () => {
    const f = fixture()
    expect(await f.service.importVariant(f.input)).toEqual({ status: 'cancelled' })
    expect(f.adapters.confirmImport.mock.calls[0][0]).not.toHaveProperty('sourcePath')
    expect(f.adapters.importCandidate).not.toHaveBeenCalled()
    f.adapters.confirmImport.mockResolvedValue(true)
    expect(await f.service.importVariant(f.input)).toEqual({ status: 'imported' })
    expect(f.adapters.importCandidate).toHaveBeenCalledExactlyOnceWith(
      candidateVariantImport(f.candidate)
    )
    expect(f.service.isBusy()).toBe(false)
  })
  it('waits on cancelled confirmations and rejects overlapping candidate operations', async () => {
    const f = fixture()
    let answer: (value: boolean) => void = () => {
      throw new Error('No prompt.')
    }
    f.adapters.confirmImport.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const importing = f.service.importVariant(f.input)
    await vi.waitFor(() => expect(f.adapters.confirmImport).toHaveBeenCalled())
    await expect(f.service.remove(f.input)).rejects.toThrow('等待')
    f.service.cancel()
    const idle = f.service.whenIdle()
    expect(f.service.isBusy()).toBe(true)
    answer(true)
    expect(await importing).toEqual({ status: 'cancelled' })
    await idle
    expect(f.adapters.importCandidate).not.toHaveBeenCalled()
  })
  it('rechecks expiry and core idleness after the native confirmation', async () => {
    for (const reason of ['expired', 'busy']) {
      const f = fixture()
      let now = 1,
        idle = true
      const service = createUpdateService({
        ...f.adapters,
        now: () => now,
        assertImportIdle: () => {
          if (!idle) throw new Error('Core became busy.')
        },
        confirmImport: async () => {
          if (reason === 'expired') now = 60002
          else idle = false
          return true
        }
      })
      await expect(service.importVariant(f.input)).rejects.toThrow('未完成')
      expect(f.adapters.importCandidate).not.toHaveBeenCalled()
    }
  })
  it('waits for an already authorized private copy to commit and reports its actual result', async () => {
    const f = fixture()
    let commit: () => void = () => {
      throw new Error('No copy.')
    }
    f.adapters.confirmImport.mockResolvedValue(true)
    f.adapters.importCandidate.mockImplementation(
      () =>
        new Promise((resolve) => {
          commit = resolve
        })
    )
    const importing = f.service.importVariant(f.input)
    await vi.waitFor(() => expect(f.adapters.importCandidate).toHaveBeenCalled())
    f.service.cancel()
    expect(f.service.isBusy()).toBe(true)
    commit()
    expect(await importing).toEqual({ status: 'imported' })
    await f.service.whenIdle()
  })
})
