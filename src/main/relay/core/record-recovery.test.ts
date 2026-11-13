import { describe, expect, it, vi } from 'vitest'
import {
  validateCoreRecordRecovery,
  type CoreRecordRecoveryReport
} from '../../../shared/relay/lifecycle'
import { createCoreRecordRecovery } from './record-recovery'

function fixture() {
  const report: CoreRecordRecoveryReport = {
    status: 'stale',
    canArchive: true,
    revision: 'a'.repeat(64),
    warnings: ['PID absent']
  }
  const adapters = {
    inspect: vi.fn(async () => structuredClone(report)),
    archive: vi.fn(async () => ({
      ...report,
      status: 'archived' as const,
      canArchive: false,
      archiveID: '00000000-0000-0000-0000-000000000001'
    })),
    held: vi.fn(() => false),
    confirm: vi.fn(async () => false)
  }
  return { adapters, report, service: createCoreRecordRecovery(adapters) }
}
describe('Confirmed stale core record archive without process takeover', () => {
  it('does not inspect automatically, refuses PID/path injection, and defaults to cancelling a single-use archive', async () => {
    const f = fixture()
    expect(f.adapters.inspect).not.toHaveBeenCalled()
    await expect(f.service.prepare({ pid: 1234 })).rejects.toThrow('不接受')
    const plan = await f.service.prepare(undefined)
    expect((await f.service.archive({ evidenceId: plan.evidenceId })).status).toBe('cancelled')
    await expect(f.service.archive({ evidenceId: plan.evidenceId })).rejects.toThrow('重新检查')
    expect(f.adapters.archive).not.toHaveBeenCalled()
  })
  it('rechecks native PID absence and revision after consent before passing only the fixed revision', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    const plan = await f.service.prepare(undefined),
      result = await f.service.archive({ evidenceId: plan.evidenceId })
    expect(result.status).toBe('archived')
    expect(f.adapters.inspect).toHaveBeenCalledTimes(2)
    expect(f.adapters.archive).toHaveBeenCalledWith('a'.repeat(64))
  })
  it.each(['revision', 'pid', 'owner'] as const)(
    'refuses %s changes that arrive during the confirmation',
    async (reason) => {
      const f = fixture(),
        plan = await f.service.prepare(undefined)
      f.adapters.confirm.mockImplementation(async () => {
        if (reason === 'revision') f.report.revision = 'b'.repeat(64)
        else if (reason === 'pid') {
          f.report.canArchive = false
          f.report.status = 'liveOrUnknown'
        } else f.adapters.held.mockReturnValue(true)
        return true
      })
      expect((await f.service.archive({ evidenceId: plan.evidenceId })).status).toBe('failed')
      expect(f.adapters.archive).not.toHaveBeenCalled()
    }
  )
  it('preserves uncertainty when the native archive acknowledgement is lost and never retries', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    f.adapters.archive.mockRejectedValue(new Error('lost ack'))
    const plan = await f.service.prepare(undefined)
    expect((await f.service.archive({ evidenceId: plan.evidenceId })).status).toBe('uncertain')
    await expect(f.service.archive({ evidenceId: plan.evidenceId })).rejects.toThrow()
    expect(f.adapters.archive).toHaveBeenCalledOnce()
  })
  it('rejects invalid native status/revision/archive combinations', () => {
    for (const report of [
      { status: 'stale', canArchive: false, revision: 'a'.repeat(64), warnings: [] },
      { status: 'clear', canArchive: false, revision: 'a'.repeat(64), warnings: [] },
      {
        status: 'archived',
        canArchive: false,
        revision: 'a'.repeat(64),
        archiveID: '/PRIVATE/path',
        warnings: []
      }
    ])
      expect(() => validateCoreRecordRecovery(report)).toThrow()
  })
})
