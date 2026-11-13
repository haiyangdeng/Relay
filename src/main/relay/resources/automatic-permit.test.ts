import { describe, expect, it, vi } from 'vitest'
import {
  issueGeoAutomaticPermit,
  revokeGeoAutomaticPermit,
  assertGeoAutomaticPermit,
  assertGeoAutomaticTunPermit,
  type GeoAutomaticOwner
} from './automatic-permit'

const origin = { id: '11111111-1111-4111-8111-111111111111', originRevision: 'a'.repeat(64) },
  owner = (): GeoAutomaticOwner => ({
    sessionId: '22222222-2222-4222-8222-222222222222',
    configurationRevision: 'b'.repeat(64),
    assertCurrent: vi.fn()
  })
describe('private in-memory Geo automatic authority', () => {
  it('does not admit a forged or serialized token', () => {
    const permit = issueGeoAutomaticPermit(origin)
    expect(JSON.stringify(permit)).toBe('{}')
    assertGeoAutomaticPermit(permit, origin)
    expect(() => assertGeoAutomaticPermit(structuredClone(permit), origin)).toThrow()
    expect(() => assertGeoAutomaticPermit(Object.assign({}, permit), origin)).toThrow()
  })
  it('binds source identity and stable origin revision while allowing a new cache head revision', () => {
    const permit = issueGeoAutomaticPermit(origin)
    expect(() =>
      assertGeoAutomaticPermit(permit, { ...origin, id: '33333333-3333-4333-8333-333333333333' })
    ).toThrow()
    expect(() =>
      assertGeoAutomaticPermit(permit, { ...origin, originRevision: 'c'.repeat(64) })
    ).toThrow()
    assertGeoAutomaticPermit(permit, { ...origin, ...{ revision: 'd'.repeat(64) } })
  })
  it('does not upgrade cache-only permission to any current TUN', () => {
    const permit = issueGeoAutomaticPermit(origin)
    expect(() => assertGeoAutomaticTunPermit(permit, origin, owner())).toThrow()
  })
  it('requires the exact held owner object even if a later session advertises equal public identifiers', () => {
    const held = owner(),
      permit = issueGeoAutomaticPermit(origin, held)
    assertGeoAutomaticTunPermit(permit, origin, held)
    expect(() => assertGeoAutomaticTunPermit(permit, origin, owner())).toThrow()
  })
  it('rejects a lost owner and a synchronously revoked grant without restoring authority', () => {
    const held = owner(),
      permit = issueGeoAutomaticPermit(origin, held)
    held.assertCurrent = () => revokeGeoAutomaticPermit(permit)
    expect(() => assertGeoAutomaticPermit(permit, origin)).toThrow()
    held.assertCurrent = () => {}
    expect(() => assertGeoAutomaticPermit(permit, origin)).toThrow()
  })
  it('propagates the private owner scope failure and revocation is idempotent', () => {
    const held = owner(),
      permit = issueGeoAutomaticPermit(origin, held)
    held.assertCurrent = () => {
      throw new Error('private owner loss')
    }
    expect(() => assertGeoAutomaticPermit(permit, origin)).toThrow()
    revokeGeoAutomaticPermit(permit)
    revokeGeoAutomaticPermit(permit)
    expect(() => assertGeoAutomaticPermit(permit, origin)).toThrow()
  })
})
