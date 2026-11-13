import { describe, expect, it, vi } from 'vitest'
import {
  validateEdgeInspection,
  validateEdgeAction,
  validateEdgeOpenResult,
  type RelayEdgeOpenResult
} from '../../shared/relay/edge'
import { validateDesktopReadiness, validateReadOnlyReport } from '../../shared/relay/protocol'
import { createEdgeService } from './edge'
import { edgeFixture } from './__fixtures__/edge'
import { desktopReadinessFixture } from './__fixtures__/desktop-readiness'
import { readOnlyFixture } from './__fixtures__/read-only'

const opened = (action: RelayEdgeOpenResult['action'] = 'openProfile'): RelayEdgeOpenResult => ({
  action,
  status: 'requested',
  installed: false,
  warnings: ['not installed']
})
function fixture() {
  const adapters = {
    inspect: vi.fn(async () => edgeFixture()),
    confirm: vi.fn(async () => false),
    openProfile: vi.fn(async () => opened()),
    openEntry: vi.fn(async (action: 'edgePolicy' | 'deviceManagement') => opened(action))
  }
  return { adapters, service: createEdgeService(adapters) }
}
describe('Edge inspection, confirmation and fixed entry workflow', () => {
  it('cancels without staging or opening, consumes the proof after an accepted request', async () => {
    const { adapters, service } = fixture()
    const report = await service.inspect()
    expect(adapters.confirm).not.toHaveBeenCalled()
    expect((await service.openProfile({ evidenceId: report.evidenceId })).status).toBe('cancelled')
    expect(adapters.openProfile).not.toHaveBeenCalled()
    adapters.confirm.mockResolvedValue(true)
    expect(await service.openProfile({ evidenceId: report.evidenceId })).toEqual(opened())
    expect(adapters.openProfile).toHaveBeenCalledWith(report.revision)
    await expect(service.openProfile({ evidenceId: report.evidenceId })).rejects.toThrow()
    expect(adapters.openProfile).toHaveBeenCalledTimes(1)
  })
  it('rejects injection, forged proofs, expired and not-ready checks before confirmation', async () => {
    let now = 1000
    const { adapters } = fixture(),
      service = createEdgeService({ ...adapters, now: () => now })
    const report = await service.inspect()
    for (const input of [
      { evidenceId: report.evidenceId, path: '/injected' },
      { evidenceId: 'forged' },
      { evidenceId: report.evidenceId, revision: report.revision }
    ])
      await expect(service.openProfile(input)).rejects.toThrow()
    now += 60001
    await expect(service.openProfile({ evidenceId: report.evidenceId })).rejects.toThrow()
    adapters.inspect.mockResolvedValue({
      ...edgeFixture(),
      reviewKeys: ['WebRtcIPHandlingUrl'],
      status: 'blocked',
      canOpenProfile: false
    })
    const blocked = await service.inspect()
    await expect(service.openProfile({ evidenceId: blocked.evidenceId })).rejects.toThrow()
    expect(adapters.confirm).not.toHaveBeenCalled()
  })
  it('rechecks age after confirmation and shares quit waiting while refusing overlapping operations', async () => {
    let now = 0,
      finish!: (value: boolean) => void
    const { adapters } = fixture()
    adapters.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const service = createEdgeService({ ...adapters, now: () => now })
    const report = await service.inspect(),
      opening = service.openProfile({ evidenceId: report.evidenceId })
    const rejected = expect(opening).rejects.toThrow('过期')
    let idle = false
    const waiting = service.whenIdle().then(() => {
      idle = true
    })
    expect(service.isBusy()).toBe(true)
    await expect(service.inspect()).rejects.toThrow()
    await expect(service.openEntry({ action: 'edgePolicy' })).rejects.toThrow()
    expect(idle).toBe(false)
    now = 60001
    finish(true)
    await rejected
    await waiting
    expect(idle).toBe(true)
    expect(adapters.openProfile).not.toHaveBeenCalled()
  })
  it('never retries an uncertain request and fixed entry opening invalidates prior installation proof', async () => {
    const { adapters, service } = fixture()
    adapters.confirm.mockResolvedValue(true)
    adapters.openProfile.mockRejectedValue(new Error('PRIVATE error'))
    const report = await service.inspect()
    const result = await service.openProfile({ evidenceId: report.evidenceId })
    expect(result.status).toBe('uncertain')
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    await expect(service.openProfile({ evidenceId: report.evidenceId })).rejects.toThrow()
    const next = await service.inspect()
    expect(await service.openEntry({ action: 'edgePolicy' })).toEqual(opened('edgePolicy'))
    await expect(service.openProfile({ evidenceId: next.evidenceId })).rejects.toThrow()
  })
  it('rejects late or explicitly invalidated checks and responses for another entry', async () => {
    const { adapters, service } = fixture()
    let finish!: (value: ReturnType<typeof edgeFixture>) => void
    adapters.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = service.inspect(),
      rejected = expect(pending).rejects.toThrow('过期')
    service.clear()
    finish(edgeFixture())
    await rejected
    adapters.openEntry.mockResolvedValue(opened('deviceManagement'))
    await expect(service.openEntry({ action: 'edgePolicy' })).rejects.toThrow('不符')
    expect(service.isBusy()).toBe(false)
  })
  it('does not accept contradictory or incomplete policy evidence as ready', () => {
    const good = edgeFixture()
    expect(validateEdgeInspection(good)).toEqual(good)
    for (const report of [
      { ...good, installed: true, runtimeVerified: true },
      { ...good, policySource: 'trusted' },
      { ...good, policies: [good.policies[0], ...good.policies.slice(0, 3)] },
      { ...good, policies: good.policies.map((p) => ({ ...p, valid: true })) },
      { ...good, reviewKeys: ['WebRtcIPHandlingUrl'] },
      { ...good, reviewKeys: ['UNKNOWN'] },
      { ...good, edgeInstalled: false },
      { ...good, revision: '../escape' }
    ])
      expect(() => validateEdgeInspection(report)).toThrow()
    for (const raw of [
      { action: 'openProfile' },
      { action: 'edgePolicy', url: 'https://injected' },
      { action: ['edgePolicy'] }
    ])
      expect(() => validateEdgeAction(raw)).toThrow()
    expect(() => validateEdgeOpenResult({ ...opened(), installed: true })).toThrow()
    const readiness = { ...desktopReadinessFixture(), edgeClosed: false, browserReady: false }
    expect(() => validateDesktopReadiness(readiness)).toThrow()
    expect(
      validateDesktopReadiness({ ...readiness, configurationReady: false }).configurationReady
    ).toBe(false)
    const diagnostics = { ...readOnlyFixture(), edgePolicyReviewKeys: ['WebRtcIPHandlingUrl'] }
    expect(() => validateReadOnlyReport(diagnostics)).toThrow('附加策略')
    diagnostics.checks = diagnostics.checks.map((check) =>
      check.id === 'browser-config' ? { ...check, state: 'attention' } : check
    )
    expect(validateReadOnlyReport(diagnostics).edgePolicyReviewKeys).toEqual([
      'WebRtcIPHandlingUrl'
    ])
  })
})
