import { describe, expect, it, vi } from 'vitest'
import { validateGuardReadiness, type RelayGuardReadiness } from '../../shared/relay/guard'
import { createGuardReadinessService } from './guard'
import { guardReadinessFixture } from './__fixtures__/guard'

function matching(): RelayGuardReadiness {
  const report = guardReadinessFixture()
  for (const item of [report.application, report.extensionComponent])
    Object.assign(item, {
      presence: 'present',
      identity: 'matches',
      signature: 'staticValid',
      networkEntitlement: true
    })
  report.application.installEntitlement = true
  report.extensionComponent.sandboxEntitlement = true
  report.sameSigningTeam = 'matches'
  report.sameVersion = 'matches'
  report.bundleMetadataMatches = true
  return report
}
describe('Read-only guard build status', () => {
  it('does no startup work and shares only an in-flight request, with isolated responses', async () => {
    let finish!: (report: RelayGuardReadiness) => void
    const read = vi.fn(
      () =>
        new Promise<RelayGuardReadiness>((resolve) => {
          finish = resolve
        })
    )
    const service = createGuardReadinessService(read)
    expect(read).not.toHaveBeenCalled()
    const a = service.read(),
      b = service.read()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(1)
    finish(guardReadinessFixture())
    const first = await a,
      second = await b
    first.application.presence = 'present'
    expect(second.application.presence).toBe('notBundled')
    const next = service.read()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(2)
    finish(guardReadinessFixture())
    await next
  })
  it('rejects paths before reading and propagates failure without an old success cache', async () => {
    const read = vi.fn(async () => guardReadinessFixture()),
      service = createGuardReadinessService(read)
    for (const value of [{ app: '/injected.app' }, {}, null, []])
      expect(() => service.read(value)).toThrow('不接受')
    expect(read).not.toHaveBeenCalled()
    await service.read()
    read.mockRejectedValueOnce(new Error('controlled unavailable'))
    await expect(service.read()).rejects.toThrow('unavailable')
    expect(await service.read()).toEqual(guardReadinessFixture())
  })
  it('keeps matching signed resources distinct from runtime protection and system state', () => {
    const good = matching()
    expect(validateGuardReadiness(good).bundleMetadataMatches).toBe(true)
    expect(validateGuardReadiness(good).protectionVerified).toBe(false)
    for (const report of [
      { ...good, protectionVerified: true },
      { ...good, systemExtension: 'enabled' },
      { ...good, filterConfiguration: 'disabled' },
      { ...good, liveOperationsAvailable: true },
      { ...good, runtimeEnforcement: 'verified' },
      { ...good, buildMode: 'live' }
    ])
      expect(() => validateGuardReadiness(report)).toThrow()
  })
  it('rejects contradictory identity, permission, signature and paired component conclusions', () => {
    const good = matching()
    for (const component of [
      { ...good.application, presence: 'missing' },
      { ...good.application, signature: 'adHoc' },
      { ...good.application, identity: 'mismatch' },
      { ...good.application, installEntitlement: false },
      { ...good.application, networkEntitlement: 'true' }
    ])
      expect(() => validateGuardReadiness({ ...good, application: component })).toThrow()
    const absent = guardReadinessFixture()
    expect(() => validateGuardReadiness({ ...absent, sameVersion: 'matches' })).toThrow()
    expect(() => validateGuardReadiness({ ...absent, sameSigningTeam: 'matches' })).toThrow()
    expect(() => validateGuardReadiness({ ...absent, bundleMetadataMatches: true })).toThrow()
    expect(() =>
      validateGuardReadiness({
        ...absent,
        extensionComponent: { ...absent.extensionComponent, presence: 'present' }
      })
    ).toThrow()
  })
})
