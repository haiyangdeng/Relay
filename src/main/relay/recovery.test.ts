import { describe, expect, it, vi } from 'vitest'
import {
  validateRecoveryPreflight,
  validateRecoverySelection,
  type RelayRecoveryStatus
} from '../../shared/relay/protocol'
import { createRecoveryService } from './recovery'
import { preflightFixture, recoveryFixture } from './__fixtures__/recovery'

describe('Read-only recovery selection and evidence', () => {
  const selection = { source: 'relay', id: 'fixture-record' }
  it('only inspects a main-observed record with a validated basename', async () => {
    const inspect = vi.fn(async () => preflightFixture())
    const service = createRecoveryService({ inventory: async () => recoveryFixture(), inspect })
    await expect(service.inspect(selection)).rejects.toThrow('先读取')
    await service.inventory()
    for (const input of [
      { ...selection, id: '../secrets' },
      { ...selection, path: '/injected' },
      { ...selection, allowLegacy: true },
      { source: 'other', id: 'fixture-record' },
      { ...selection, id: 'a'.repeat(201) },
      { ...selection, id: 'not-listed' }
    ])
      await expect(service.inspect(input)).rejects.toThrow()
    expect(inspect).not.toHaveBeenCalled()
    expect(await service.inspect(selection)).toMatchObject(preflightFixture())
    expect(inspect).toHaveBeenCalledWith(selection)
    service.clear()
    await expect(service.inspect(selection)).rejects.toThrow('先读取')
  })
  it('invalidates selections on a refresh failure and refuses late inventory results', async () => {
    let finish!: (status: RelayRecoveryStatus) => void
    const inventory = vi.fn(async () => recoveryFixture())
    const service = createRecoveryService({ inventory, inspect: async () => preflightFixture() })
    await service.inventory()
    inventory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const slow = service.inventory()
    const rejectedSlow = expect(slow).rejects.toThrow('过期')
    inventory.mockRejectedValueOnce(new Error('fixture failure'))
    await expect(service.inventory()).rejects.toThrow('fixture failure')
    finish(recoveryFixture())
    await rejectedSlow
    await expect(service.inspect(selection)).rejects.toThrow('先读取')
  })
  it('discards an in-flight result when inventory is refreshed or cleared', async () => {
    let finish!: (status: ReturnType<typeof preflightFixture>) => void
    const service = createRecoveryService({
      inventory: async () => recoveryFixture(),
      inspect: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    })
    await service.inventory()
    const result = service.inspect(selection)
    const rejected = expect(result).rejects.toThrow('失效')
    service.clear()
    finish(preflightFixture())
    await rejected
  })
  it('rejects mismatched records, enabled restore, malformed states and contradictory conclusions', async () => {
    const wrong = preflightFixture()
    wrong.selection.id = 'other'
    const service = createRecoveryService({
      inventory: async () => recoveryFixture(),
      inspect: async () => wrong
    })
    await service.inventory()
    await expect(service.inspect(selection)).rejects.toThrow('其他记录')
    for (const raw of [
      { ...preflightFixture(), restoreEnabled: true },
      { ...preflightFixture(), snapshotOnly: false },
      { ...preflightFixture(), version: 1 },
      { ...preflightFixture(), targets: [] },
      { ...preflightFixture(), revision: 'bad' },
      { ...preflightFixture(), fileChecksPassed: false },
      { ...preflightFixture(), issues: ['targetChanged'] },
      { ...preflightFixture(), browser: 'unconfirmed' },
      { ...preflightFixture(), issues: ['unknown'] },
      {
        ...preflightFixture(),
        targets: [{ ...preflightFixture().targets[0], current: ['installed'] }]
      },
      { ...preflightFixture(), targets: [{ ...preflightFixture().targets[0], target: 'unknown' }] }
    ])
      expect(() => validateRecoveryPreflight(raw)).toThrow()
    expect(() => validateRecoverySelection({ source: 'relay', id: '.hidden' })).toThrow()
  })
  it('preserves blocked and unverified states instead of turning them into verified evidence', () => {
    const old = preflightFixture()
    old.version = 1
    old.phase = 'legacy'
    old.requiresLegacyConfirmation = true
    old.targets[0].original = 'unverifiedLegacy'
    old.issues = ['legacyConfirmationRequired']
    expect(validateRecoveryPreflight(old)).toEqual(old)
    const changed = preflightFixture()
    changed.targets[0].current = 'changed'
    changed.fileChecksPassed = false
    changed.issues = ['targetChanged']
    expect(validateRecoveryPreflight(changed).fileChecksPassed).toBe(false)
    changed.targets[0].current = 'unverifiedMode'
    changed.issues = ['targetModeUnknown']
    expect(validateRecoveryPreflight(changed).targets[0].current).toBe('unverifiedMode')
    const malformed = preflightFixture()
    malformed.version = 0
    malformed.phase = 'unreadable'
    malformed.targets = []
    malformed.issues = ['manifestInvalid']
    malformed.fileChecksPassed = false
    expect(validateRecoveryPreflight(malformed).phase).toBe('unreadable')
  })
  it('defaults to cancellation, then consumes exactly one confirmed proof', async () => {
    const confirm = vi.fn(async () => false)
    const restore = vi.fn(async () => ({ status: 'restored' as const, warnings: [] }))
    const service = createRecoveryService({
      inventory: async () => recoveryFixture(),
      inspect: async () => preflightFixture(),
      confirm,
      restore
    })
    await service.inventory()
    const proof = await service.inspect(selection)
    expect((await service.restore({ evidenceId: proof.evidenceId })).status).toBe('cancelled')
    expect(restore).not.toHaveBeenCalled()
    confirm.mockResolvedValue(true)
    expect((await service.restore({ evidenceId: proof.evidenceId })).status).toBe('restored')
    expect(restore).toHaveBeenCalledWith(proof, false)
    await expect(service.restore({ evidenceId: proof.evidenceId })).rejects.toThrow('重新预检')
    expect(restore).toHaveBeenCalledTimes(1)
  })
  it('refuses forged, expired, or blocked proofs before admitting the action', async () => {
    let now = 1000
    const confirm = vi.fn(async () => true)
    const restore = vi.fn(async () => ({ status: 'restored' as const, warnings: [] }))
    const service = createRecoveryService({
      inventory: async () => recoveryFixture(),
      inspect: async () => preflightFixture(),
      confirm,
      restore,
      now: () => now
    })
    await service.inventory()
    const proof = await service.inspect(selection)
    for (const raw of [
      { evidenceId: 'a'.repeat(36) },
      { evidenceId: proof.evidenceId, allowLegacy: 'true' },
      { evidenceId: proof.evidenceId, path: '/injected' }
    ])
      await expect(service.restore(raw)).rejects.toThrow()
    now += 60001
    await expect(service.restore({ evidenceId: proof.evidenceId })).rejects.toThrow('重新预检')
    expect(confirm).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })
  it('requires explicit legacy-format permission without claiming a manual review', async () => {
    const old = preflightFixture()
    old.version = 1
    old.phase = 'legacy'
    old.requiresLegacyConfirmation = true
    old.targets[0].original = 'unverifiedLegacy'
    old.issues = ['legacyConfirmationRequired']
    const confirm = vi.fn(async () => true)
    const restore = vi.fn(async () => ({ status: 'restored' as const, warnings: [] }))
    const service = createRecoveryService({
      inventory: async () => recoveryFixture(),
      inspect: async () => old,
      confirm,
      restore
    })
    await service.inventory()
    const proof = await service.inspect(selection)
    await expect(service.restore({ evidenceId: proof.evidenceId })).rejects.toThrow('旧版备份')
    expect(restore).not.toHaveBeenCalled()
    expect(
      (await service.restore({ evidenceId: proof.evidenceId, allowLegacy: true })).status
    ).toBe('restored')
    expect(restore).toHaveBeenCalledWith(proof, true)
  })
  it('invalidates changed proof during its authority check and allows only one active restore', async () => {
    let finish!: (answer: boolean) => void
    const restore = vi.fn(async () => ({ status: 'restored' as const, warnings: [] }))
    const service = createRecoveryService({
      inventory: async () => recoveryFixture(),
      inspect: async () => preflightFixture(),
      confirm: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      restore
    })
    await service.inventory()
    const proof = await service.inspect(selection)
    const result = service.restore({ evidenceId: proof.evidenceId })
    const rejected = expect(result).rejects.toThrow('确认期间')
    expect(service.isRestoring()).toBe(true)
    await expect(service.restore({ evidenceId: proof.evidenceId })).rejects.toThrow('正在进行')
    let idle = false
    const waiting = service.whenIdle().then(() => {
      idle = true
    })
    await service.inventory()
    expect(idle).toBe(false)
    finish(true)
    await rejected
    await waiting
    expect(idle).toBe(true)
    expect(service.isRestoring()).toBe(false)
    expect(restore).not.toHaveBeenCalled()
  })
  it('reports a lost native response as uncertain and forces fresh inspection', async () => {
    const service = createRecoveryService({
      inventory: async () => recoveryFixture(),
      inspect: async () => preflightFixture(),
      confirm: async () => true,
      restore: async () => {
        throw new Error('response lost after possible commit')
      }
    })
    await service.inventory()
    const proof = await service.inspect(selection)
    const result = await service.restore({ evidenceId: proof.evidenceId })
    expect(result.status).toBe('uncertain')
    expect(result.warnings.join()).toContain('可能已有部分或全部')
    await expect(service.restore({ evidenceId: proof.evidenceId })).rejects.toThrow('重新预检')
    await service.whenIdle()
    expect(service.isRestoring()).toBe(false)
  })
})
