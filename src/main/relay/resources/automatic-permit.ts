import type { GeoOriginInfo } from '../../../shared/relay/geo-origins'

export interface GeoAutomaticOwner {
  readonly sessionId: string
  readonly configurationRevision: string
  assertCurrent(): void
}
const brand: unique symbol = Symbol('GeoAutomaticPermit')
export interface GeoAutomaticPermit {
  readonly [brand]: true
}
interface Grant {
  id: string
  originRevision: string
  owner?: GeoAutomaticOwner
}
const grants = new WeakMap<GeoAutomaticPermit, Grant>()

// Main-only. The coordinator calls this after default-cancel Native consent,
// selected-record recheck and the last private scope/epoch check. No token is
// returned by renderer IPC or serialized into an origin/backup document.
export function issueGeoAutomaticPermit(
  origin: Pick<GeoOriginInfo, 'id' | 'originRevision'>,
  owner?: GeoAutomaticOwner
): GeoAutomaticPermit {
  const permit = Object.freeze({ [brand]: true as const })
  grants.set(permit, { id: origin.id, originRevision: origin.originRevision, owner })
  return permit
}
export function revokeGeoAutomaticPermit(permit: GeoAutomaticPermit): void {
  grants.delete(permit)
}
export function assertGeoAutomaticPermit(
  permit: GeoAutomaticPermit,
  origin: Pick<GeoOriginInfo, 'id' | 'originRevision'>
): void {
  const grant = grants.get(permit),
    matches = (): boolean =>
      !!grant &&
      grants.get(permit) === grant &&
      grant.id === origin.id &&
      grant.originRevision === origin.originRevision
  if (!matches()) throw new Error('本次地理来源自动更新权限已失效。')
  grant?.owner?.assertCurrent()
  // Owner callbacks may synchronously revoke the grant or change its context.
  if (!matches()) throw new Error('本次地理来源自动更新权限已失效。')
}
export function assertGeoAutomaticTunPermit(
  permit: GeoAutomaticPermit,
  origin: Pick<GeoOriginInfo, 'id' | 'originRevision'>,
  owner: GeoAutomaticOwner
): void {
  assertGeoAutomaticPermit(permit, origin)
  if (grants.get(permit)?.owner !== owner) throw new Error('自动更新权限未绑定本次活动TUN实例。')
  owner.assertCurrent()
  assertGeoAutomaticPermit(permit, origin)
}
