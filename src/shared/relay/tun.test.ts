import { describe, expect, it } from 'vitest'
import {
  tunHelperObservation,
  tunNetworkObservation,
  tunPlanRequest,
  tunEvidenceRequest,
  tunSessionRequest,
  tunSessionState,
  tunSessionResult,
  tunStatus,
  type TunHelperObservation,
  type TunNetworkObservation
} from './tun'

const helper: TunHelperObservation = {
  version: 1,
  source: 'native',
  observedAt: 100,
  revision: 'a'.repeat(64),
  state: 'unconfirmed',
  identity: 'unconfirmed',
  authorization: 'unconfirmed',
  rootOwned: false,
  runningAsRoot: false,
  clientUID: 501
}
const network: TunNetworkObservation = {
  version: 1,
  source: 'native',
  observedAt: 100,
  state: 'unavailable',
  revision: 'a'.repeat(64),
  routesSHA256: 'b'.repeat(64),
  dnsSHA256: 'c'.repeat(64),
  interfacesSHA256: 'd'.repeat(64),
  proxySHA256: 'e'.repeat(64),
  protectionSHA256: 'f'.repeat(64),
  existingTunnel: 'unconfirmed',
  recovery: 'unconfirmed'
}
describe('TUN preparation contracts', () => {
  it('accepts only the two complete-candidate digests from the caller', () => {
    const request = { configurationSHA256: 'a'.repeat(64), bundleSHA256: 'b'.repeat(64) }
    expect(tunPlanRequest(request)).toEqual(request)
    for (const extra of [
      { path: '/tmp/core' },
      { pid: 123 },
      { approved: true },
      { helper },
      { network },
      { canApply: true }
    ])
      expect(() => tunPlanRequest({ ...request, ...extra })).toThrow('仅接受')
    for (const value of ['', 'A'.repeat(64), 'x'.repeat(64), 123, undefined])
      expect(() => tunPlanRequest({ ...request, bundleSHA256: value })).toThrow()
  })
  it('validates native evidence without turning unknown facts into a pass', () => {
    expect(tunHelperObservation(helper)).toEqual(helper)
    expect(tunNetworkObservation(network)).toEqual(network)
    expect(tunHelperObservation(helper)).not.toBe(helper)
    expect(tunNetworkObservation(network)).not.toBe(network)
  })
  it.each([
    { source: 'renderer' },
    { state: 'installed' },
    { state: ['ready'] },
    { identity: ['authenticated'] },
    { authorization: ['approved'] },
    { rootOwned: 1 },
    { runningAsRoot: 'true' },
    { clientUID: 0 },
    { clientUID: -1 },
    { clientUID: 501.5 },
    { clientUID: 0x100000000 },
    { observedAt: NaN },
    { observedAt: -1 },
    { revision: '' },
    { helperSHA256: undefined },
    { coreSHA256: 'invalid' },
    { executable: '/tmp/core' }
  ])('rejects malformed helper observation %j', (patch) => {
    expect(() => tunHelperObservation({ ...helper, ...patch })).toThrow()
  })
  it.each([
    { source: 'fixture' },
    { state: 'ready' },
    { state: ['observed'] },
    { recovery: ['available'] },
    { existingTunnel: ['none'] },
    { routesSHA256: '' },
    { dnsSHA256: 'x'.repeat(64) },
    { protectionSHA256: undefined },
    { existingTunnel: false },
    { recovery: 'writable' },
    { observedAt: Infinity },
    { canRestore: true }
  ])('rejects malformed network observation %j', (patch) => {
    expect(() => tunNetworkObservation({ ...network, ...patch })).toThrow()
  })
})

describe('TUN renderer IPC contracts', () => {
  const evidenceId = '11111111-1111-4111-8111-111111111111',
    sessionId = '22222222-2222-4222-8222-222222222222',
    idle = {
      phase: 'idle',
      pending: false,
      owned: false,
      traffic: 'inactive',
      restorationVerified: false,
      protectionVerified: false,
      warnings: []
    }
  it('accepts only one opaque evidence or session identifier, never renderer runtime claims', () => {
    expect(tunEvidenceRequest({ evidenceId })).toEqual({ evidenceId })
    expect(tunSessionRequest({ sessionId })).toEqual({ sessionId })
    for (const patch of [
      { fd: 3 },
      { pid: 3 },
      { path: '/private/core' },
      { helper: 'ready' },
      { approved: true },
      { configurationSHA256: 'a'.repeat(64) }
    ]) {
      expect(() => tunEvidenceRequest({ evidenceId, ...patch })).toThrow('仅接受')
      expect(() => tunSessionRequest({ sessionId, ...patch })).toThrow('仅接受')
    }
    expect(() => tunEvidenceRequest({ evidenceId: 'invalid' })).toThrow()
  })
  it.each([
    { ...idle, phase: 'active', owned: true, sessionId, traffic: 'unconfirmed' },
    { ...idle, phase: 'active', traffic: 'forwarding' },
    { ...idle, phase: 'restored', restorationVerified: false },
    { ...idle, phase: 'restored', owned: true, sessionId, restorationVerified: true },
    { ...idle, owned: true },
    { ...idle, protectionVerified: true },
    { ...idle, warnings: ['x'.repeat(4097)] },
    { ...idle, pid: 100 }
  ])('does not convert inconsistent ownership or recovery into a UI success %#', (value) => {
    expect(() => tunSessionState(value)).toThrow()
  })
  it('keeps unknown helper state distinct and checks result evidence', () => {
    expect(
      tunStatus({ session: idle, helper: 'missing', warnings: ['manual installation required'] })
        .helper
    ).toBe('missing')
    expect(() => tunSessionResult({ status: 'started', state: idle })).toThrow()
    expect(() => tunSessionResult({ status: 'restored', state: idle })).toThrow()
    expect(() => tunStatus({ session: idle, helper: 'installed', warnings: [] })).toThrow()
    expect(() => tunStatus({ session: idle, helper: 'ready', warnings: [], fd: 3 })).toThrow()
  })
})
