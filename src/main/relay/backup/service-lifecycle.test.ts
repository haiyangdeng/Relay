import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayBackupRecoveryPlan, RelayBackupRestorePlan } from '../../../shared/relay/backup'
import type { LegacyClashMigrationReport } from '../../../shared/relay/legacy-clash'
import { backupSnapshotSHA256 } from './archive'
import { RelayBackupStore } from './store'
import { createBackupService } from './service'

afterEach(() => vi.restoreAllMocks())

// Only service capability boundaries are injected here; full file publication
// and native exclusive moves are exercised by store/record integration tests.
function fixture() {
  const baseline = { directories: [], entries: [] }
  const plan: RelayBackupRestorePlan = {
    id: '00000000-0000-0000-0000-000000000001',
    baselineSHA256: backupSnapshotSHA256(baseline),
    targetSHA256: 'b'.repeat(64),
    archiveSHA256: 'c'.repeat(64),
    files: 1,
    replacedFiles: 0,
    removedFiles: 0,
    containsSecrets: true,
    preparedAt: Date.now()
  }
  const recovery: RelayBackupRecoveryPlan = {
    evidenceId: '00000000-0000-0000-0000-000000000002',
    id: plan.id,
    action: 'resume',
    recordSHA256: 'd'.repeat(64),
    baselineSHA256: plan.baselineSHA256,
    targetSHA256: plan.targetSHA256,
    currentSHA256: plan.baselineSHA256,
    files: 1,
    containsSecrets: true,
    preparedAt: plan.preparedAt,
    expiresAt: plan.preparedAt + 60000
  }
  const report: LegacyClashMigrationReport = {
    format: 'clash-party-legacy-zip',
    archiveSHA256: 'e'.repeat(64),
    containsSecrets: true,
    files: [],
    profiles: [],
    counts: {
      profiles: 1,
      sources: 0,
      overrides: 0,
      rulePatches: 0,
      applied: 1,
      retained: 0,
      'decision-required': 0
    }
  }
  const store = new RelayBackupStore({
    home: '/private/tmp',
    stateRoot: '/private/tmp/Library/Application Support/Relay'
  })
  const calls = {
    stage: vi.spyOn(store, 'stageRestore').mockResolvedValue(plan),
    snapshot: vi.spyOn(store, 'snapshot').mockResolvedValue(baseline),
    discard: vi.spyOn(store, 'discard'),
    prepareRecovery: vi.spyOn(store, 'prepareRecovery').mockResolvedValue(recovery),
    commitRecovery: vi.spyOn(store, 'commitRecovery').mockResolvedValue('restored'),
    discardRecovery: vi.spyOn(store, 'discardRecovery'),
    commitRestore: vi.spyOn(store, 'commitRestore').mockResolvedValue('restored'),
    recordPlan: vi.fn(async () => {}),
    afterRestore: vi.fn(async () => {})
  }
  const converted = {
    archiveBytes: Buffer.from('merged-candidate'),
    expectedBaselineSHA256: plan.baselineSHA256,
    migrationId: '00000000-0000-0000-0000-000000000003',
    report,
    recordPlan: calls.recordPlan
  }
  const adapters: Parameters<typeof createBackupService>[0] = {
    store,
    pickImport: vi.fn(async () => Buffer.from('selected-archive')),
    writeExport: vi.fn(async () => false),
    confirmExport: vi.fn(async () => false),
    confirmRestore: vi.fn(async () => false),
    confirmRecovery: vi.fn(async () => false),
    prepareLegacyArchive: vi.fn(async () => converted),
    assertIdle: vi.fn(),
    afterRestore: calls.afterRestore,
    now: () => plan.preparedAt
  }
  return {
    service: createBackupService(adapters),
    adapters,
    calls,
    plan,
    recovery,
    report,
    converted,
    baseline
  }
}

describe('Legacy migration service publication gate', () => {
  it('binds the conversion baseline, retains its record and forwards the report only to native confirmation', async () => {
    const { service, adapters, calls, plan, converted, baseline, report } = fixture()
    const result = await service.prepareLegacyImport({ proxyPort: 17891 })
    expect(result).toEqual({ status: 'prepared', plan, report, migrationId: converted.migrationId })
    expect(adapters.pickImport).toHaveBeenCalledWith('legacy')
    expect(adapters.prepareLegacyArchive).toHaveBeenCalledWith(
      Buffer.from('selected-archive'),
      baseline,
      17891,
      expect.any(AbortSignal)
    )
    expect(calls.stage).toHaveBeenCalledWith(
      converted.archiveBytes,
      converted.expectedBaselineSHA256
    )
    expect(calls.recordPlan).toHaveBeenCalledWith(plan)
    expect(calls.commitRestore).not.toHaveBeenCalled()
    expect(await service.restore({ id: plan.id })).toEqual({ status: 'cancelled' })
    expect(adapters.confirmRestore).toHaveBeenCalledWith(plan, report)
    expect(calls.commitRestore).not.toHaveBeenCalled()
    await expect(service.restore({ id: plan.id })).rejects.toThrow('失效')
  })
  it('returns an inspection report without any restore capability when no profile can be converted', async () => {
    const { service, adapters, calls, converted, plan } = fixture()
    adapters.prepareLegacyArchive = async () => ({ ...converted, archiveBytes: undefined })
    expect(await service.prepareLegacyImport({})).toEqual({
      status: 'inspected',
      report: converted.report,
      migrationId: converted.migrationId
    })
    expect(calls.stage).not.toHaveBeenCalled()
    expect(calls.recordPlan).not.toHaveBeenCalled()
    await expect(service.restore({ id: plan.id })).rejects.toThrow('失效')
  })
  it('preserves cancellation through asynchronous staging and does not link a cancelled plan', async () => {
    const { service, calls, plan } = fixture()
    const staged = Promise.withResolvers<RelayBackupRestorePlan>()
    const started = Promise.withResolvers<void>()
    calls.stage.mockImplementationOnce(() => {
      started.resolve()
      return staged.promise
    })
    const operation = service.prepareLegacyImport({})
    await started.promise
    service.cancel()
    staged.resolve(plan)
    expect(await operation).toEqual({ status: 'cancelled' })
    expect(calls.discard).toHaveBeenCalledWith(plan.id)
    expect(calls.recordPlan).not.toHaveBeenCalled()
    await expect(service.restore({ id: plan.id })).rejects.toThrow('失效')
    expect(service.isBusy()).toBe(false)
  })
  it('discards a staged plan and sanitizes a failed private migration receipt', async () => {
    const { service, calls, plan } = fixture()
    calls.recordPlan.mockRejectedValueOnce(new Error('PRIVATE-original-token'))
    await expect(service.prepareLegacyImport({})).rejects.toThrow(/^旧备份迁移未完成/)
    expect(calls.discard).toHaveBeenCalledWith(plan.id)
    expect(calls.commitRestore).not.toHaveBeenCalled()
    await expect(service.restore({ id: plan.id })).rejects.toThrow('失效')
    expect(service.isBusy()).toBe(false)
  })
  it('expires a legacy restore while native confirmation is open without publishing the candidate', async () => {
    const { adapters, calls, plan } = fixture()
    let clock = plan.preparedAt
    adapters.now = () => clock
    adapters.confirmRestore = async () => {
      clock += 60001
      return true
    }
    const service = createBackupService(adapters)
    await service.prepareLegacyImport({})
    await expect(service.restore({ id: plan.id })).rejects.toThrow('过期')
    expect(calls.commitRestore).not.toHaveBeenCalled()
    expect(calls.discard).toHaveBeenCalledWith(plan.id)
    await expect(service.restore({ id: plan.id })).rejects.toThrow('失效')
  })
})

describe('Recovery service confirmation and lifecycle revocation', () => {
  it('rejects renderer-supplied paths and non-string directions before touching the store', async () => {
    const { service, calls, plan } = fixture()
    for (const raw of [
      { id: plan.id, action: 'resume', path: '/private/foreign' },
      { id: plan.id, action: { toString: () => 'resume' } },
      { id: plan.id, action: 'other' }
    ])
      await expect(service.prepareRecovery(raw)).rejects.toThrow()
    expect(calls.prepareRecovery).not.toHaveBeenCalled()
  })
  it('lists only metadata without the full idle gate, while sharing the busy barrier', async () => {
    const { service, adapters } = fixture()
    const records =
      Promise.withResolvers<Awaited<ReturnType<RelayBackupStore['listRecoveryRecords']>>>()
    const listing = vi
      .spyOn(adapters.store, 'listRecoveryRecords')
      .mockReturnValueOnce(records.promise)
    const operation = service.listRecoveryRecords()
    expect(listing).toHaveBeenCalledOnce()
    expect(adapters.assertIdle).not.toHaveBeenCalled()
    await expect(service.prepareRecovery({ id: 'fixture', action: 'resume' })).rejects.toThrow(
      '等待'
    )
    records.resolve([])
    expect(await operation).toEqual([])
    expect(service.isBusy()).toBe(false)
  })
  it('consumes native cancellation and never executes or refreshes state', async () => {
    const { service, adapters, calls, recovery } = fixture()
    await service.prepareRecovery({ id: recovery.id, action: 'resume' })
    expect(await service.commitRecovery({ evidenceId: recovery.evidenceId })).toEqual({
      status: 'cancelled'
    })
    expect(adapters.confirmRecovery).toHaveBeenCalledWith(recovery)
    expect(calls.commitRecovery).not.toHaveBeenCalled()
    expect(calls.afterRestore).not.toHaveBeenCalled()
    expect(calls.discardRecovery).toHaveBeenCalledWith(recovery.evidenceId)
    await expect(service.commitRecovery({ evidenceId: recovery.evidenceId })).rejects.toThrow(
      '失效'
    )
  })
  it('rechecks expiration and the idle gate after native confirmation', async () => {
    const { service, adapters, calls, recovery } = fixture()
    let clock = recovery.preparedAt
    adapters.now = () => clock
    const timed = createBackupService(adapters)
    adapters.confirmRecovery = async () => {
      clock = recovery.expiresAt
      return true
    }
    await timed.prepareRecovery({ id: recovery.id, action: 'resume' })
    await expect(timed.commitRecovery({ evidenceId: recovery.evidenceId })).rejects.toThrow('过期')
    expect(calls.commitRecovery).not.toHaveBeenCalled()
    clock = recovery.preparedAt
    adapters.confirmRecovery = async () => {
      adapters.assertIdle = () => {
        throw new Error('quitting')
      }
      return true
    }
    await service.prepareRecovery({ id: recovery.id, action: 'resume' })
    await expect(service.commitRecovery({ evidenceId: recovery.evidenceId })).rejects.toThrow(
      'quitting'
    )
    expect(calls.commitRecovery).not.toHaveBeenCalled()
  })
  it.each(['restored', 'rolled-back', 'uncertain'] as const)(
    'refreshes successful recovery only and preserves %s',
    async (status) => {
      const { service, adapters, calls, recovery } = fixture()
      adapters.confirmRecovery = async () => true
      calls.commitRecovery.mockResolvedValueOnce(status)
      await service.prepareRecovery({ id: recovery.id, action: 'resume' })
      expect(await service.commitRecovery({ evidenceId: recovery.evidenceId })).toEqual({ status })
      expect(calls.afterRestore).toHaveBeenCalledTimes(status === 'uncertain' ? 0 : 1)
    }
  )
  it('reports uncertain when restored cache refresh fails and consumes the proof', async () => {
    const { service, adapters, calls, recovery } = fixture()
    adapters.confirmRecovery = async () => true
    calls.afterRestore.mockRejectedValueOnce(new Error('PRIVATE-cache-body'))
    await service.prepareRecovery({ id: recovery.id, action: 'resume' })
    expect(await service.commitRecovery({ evidenceId: recovery.evidenceId })).toEqual({
      status: 'uncertain'
    })
    await expect(service.commitRecovery({ evidenceId: recovery.evidenceId })).rejects.toThrow(
      '失效'
    )
  })
  it('revokes a pending import selection and a recovery inspection across suspension', async () => {
    const { service, adapters, calls, plan, recovery } = fixture()
    const selected = Promise.withResolvers<Buffer | undefined>()
    adapters.pickImport = () => selected.promise
    const importing = service.prepareImport()
    service.invalidatePending()
    selected.resolve(Buffer.from('late-import'))
    expect(await importing).toEqual({ status: 'cancelled' })
    expect(calls.stage).not.toHaveBeenCalled()
    const inspected = Promise.withResolvers<RelayBackupRecoveryPlan>()
    calls.prepareRecovery.mockReturnValueOnce(inspected.promise)
    const preparing = service.prepareRecovery({ id: recovery.id, action: 'resume' })
    service.invalidatePending()
    inspected.resolve(recovery)
    expect(await preparing).toEqual({ status: 'cancelled' })
    expect(calls.discardRecovery).toHaveBeenCalledWith(recovery.evidenceId)
    await expect(service.restore({ id: plan.id })).rejects.toThrow('失效')
  })
  it.each(['restore', 'recovery'] as const)(
    'invalidates native %s confirmation before any transaction begins',
    async (kind) => {
      const { service, adapters, calls, plan, recovery } = fixture()
      const confirmed = Promise.withResolvers<boolean>()
      let committing: Promise<unknown>
      if (kind === 'restore') {
        await service.prepareLegacyImport({})
        adapters.confirmRestore = () => confirmed.promise
        committing = service.restore({ id: plan.id })
      } else {
        await service.prepareRecovery({ id: recovery.id, action: 'rollback' })
        adapters.confirmRecovery = () => confirmed.promise
        committing = service.commitRecovery({ evidenceId: recovery.evidenceId })
      }
      service.invalidatePending()
      confirmed.resolve(true)
      expect(await committing).toEqual({ status: 'cancelled' })
      expect(calls.commitRestore).not.toHaveBeenCalled()
      expect(calls.commitRecovery).not.toHaveBeenCalled()
      expect(calls.afterRestore).not.toHaveBeenCalled()
    }
  )
  it('does not cancel a file transaction already in progress when the window closes', async () => {
    const { service, adapters, calls, recovery } = fixture()
    const committed = Promise.withResolvers<'restored'>()
    const started = Promise.withResolvers<void>()
    adapters.confirmRecovery = async () => true
    calls.commitRecovery.mockImplementationOnce(() => {
      started.resolve()
      return committed.promise
    })
    await service.prepareRecovery({ id: recovery.id, action: 'resume' })
    const operation = service.commitRecovery({ evidenceId: recovery.evidenceId })
    await started.promise
    service.invalidatePending()
    expect(service.isBusy()).toBe(true)
    expect(() => service.cancel()).toThrow('结束文件选择')
    committed.resolve('restored')
    expect(await operation).toEqual({ status: 'restored' })
    expect(calls.afterRestore).toHaveBeenCalledOnce()
  })
})
