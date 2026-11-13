import { stripProfileControls } from './profiles'

export function healthURL(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    stripProfileControls(value) !== value ||
    /[\s\\]/u.test(value)
  )
    throw new Error('测速URL无效。')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('测速URL无效。')
  // The core keys per-target histories by the original URL string.
  return value
}

// A Core URLTest updates the same health state read by automatic groups.
// Native confirmation cannot prove that an active Claude route is unaffected.
export const ownedHealthTestPolicy = Object.freeze({
  available: false,
  reason: '节点测速可能影响自动选路，当前保护要求下暂不开放在用核心测速。'
})
export function assertOwnedHealthTestAvailable(): void {
  if (!ownedHealthTestPolicy.available) throw new Error(ownedHealthTestPolicy.reason)
}
