import { describe, expect, it } from 'vitest'
import { validateDesktopReadiness } from '../../shared/relay/protocol'
import { desktopReadinessFixture } from './__fixtures__/desktop-readiness'

describe('Desktop readiness boundary', () => {
  it('allows installed Edge without Chrome or wrapper while granting no login or restore', () => {
    const fixture = desktopReadinessFixture()
    expect(fixture).not.toHaveProperty('wrapperInstalled')
    expect(fixture).not.toHaveProperty('chromeInstalled')
    expect(validateDesktopReadiness(fixture)).toEqual(fixture)
    expect(
      validateDesktopReadiness({ ...fixture, wrapperInstalled: false, chromeInstalled: false })
    ).toEqual(fixture)
    for (const patch of [
      { startEnabled: true },
      { readOnly: false },
      { locks: 'held' },
      { proxy: 'verified' }
    ])
      expect(() => validateDesktopReadiness({ ...desktopReadinessFixture(), ...patch })).toThrow()
  })
  it('rejects incomplete, duplicate and inconsistent browser/record evidence', () => {
    const fixture = desktopReadinessFixture()
    for (const patch of [
      { edgeInstalled: false },
      { edgePoliciesReady: false },
      { edgeClosed: false },
      { records: [fixture.records[0], fixture.records[0]] },
      { browserReady: false },
      { sharedDefaults: false },
      { defaults: { http: 'com.apple.Safari' } },
      { defaults: { http: '/private/path', https: '/private/path' } }
    ])
      expect(() => validateDesktopReadiness({ ...fixture, ...patch })).toThrow()
  })
  it.each(['edgeInstalled', 'edgePoliciesReady', 'edgeClosed'] as const)(
    'blocks configuration when %s is false and rejects missing or malformed evidence',
    (key) => {
      const fixture = desktopReadinessFixture()
      const blocked = {
        ...fixture,
        [key]: false,
        browserReady: false,
        configurationReady: false
      }
      expect(validateDesktopReadiness(blocked)).toEqual(blocked)
      expect(() => validateDesktopReadiness({ ...blocked, browserReady: true })).toThrow(
        'Edge 登录条件'
      )
      for (const invalid of [undefined, null, 'false', 0])
        expect(() => validateDesktopReadiness({ ...blocked, [key]: invalid })).toThrow()
    }
  )
  it('rejects a legacy browser-only readiness response without new Edge evidence', () => {
    const { edgeInstalled, edgePoliciesReady, edgeClosed, ...old } = desktopReadinessFixture()
    expect(edgeInstalled && edgePoliciesReady && edgeClosed).toBe(true)
    expect(() =>
      validateDesktopReadiness({ ...old, wrapperInstalled: true, chromeInstalled: true })
    ).toThrow()
  })
  it('retains unknown, external-change and malformed-record states as blocking evidence', () => {
    const fixture = desktopReadinessFixture()
    fixture.edgeClosed = false
    fixture.browserReady = false
    fixture.configurationReady = false
    fixture.records[1] = {
      source: 'legacy',
      state: 'pending',
      phase: 'restoring',
      decisions: { http: 'blocked', https: 'unconfirmed' }
    }
    expect(validateDesktopReadiness(fixture).records[1].decisions.http).toBe('blocked')
    fixture.records[1].state = 'invalid'
    fixture.records[1].phase = 'invalid'
    expect(() => validateDesktopReadiness(fixture)).toThrow()
    fixture.records[1].decisions.http = 'unconfirmed'
    expect(validateDesktopReadiness(fixture).configurationReady).toBe(false)
  })
  it.each(['relay', 'legacy'] as const)(
    'retains %s recovery evidence when Edge is absent or still running',
    (source) => {
      const fixture = desktopReadinessFixture()
      fixture.edgeInstalled = false
      fixture.edgeClosed = false
      fixture.browserReady = false
      fixture.configurationReady = false
      fixture.records = fixture.records.map((entry) =>
        entry.source === source
          ? {
              source,
              state: 'pending',
              phase: 'restoring',
              decisions: { http: 'alreadyOriginal', https: 'restoreEligible' }
            }
          : entry
      )
      expect(validateDesktopReadiness(fixture)).toEqual(fixture)
    }
  )
})
