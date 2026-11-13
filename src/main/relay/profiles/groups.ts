import { healthURL } from '../../../shared/relay/health'
export { healthURL } from '../../../shared/relay/health'
// Schemas pinned to Mihomo v1.19.33. Regex matching stays in the core:
// upstream uses regexp2, whose semantics must not be replaced by JS RegExp.
export type GroupType = 'select' | 'url-test' | 'fallback' | 'load-balance' | 'smart'
export const SMART_MODEL_CONTROLS = {
  'lgbm-auto-update': false,
  'lgbm-url': 'http://127.0.0.1:1/relay-model-download-disabled'
} as const
export const groupTypes: Readonly<Record<GroupType, string>> = {
  select: 'Selector',
  'url-test': 'URLTest',
  fallback: 'Fallback',
  'load-balance': 'LoadBalance',
  smart: 'Smart'
}
type Item = Record<string, unknown>
const object = (value: unknown): value is Item =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown, limit = 4096): value is string =>
  typeof value === 'string' &&
  value.length <= limit &&
  Array.from(value).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
const integer = (value: unknown, max: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const booleanFields = new Set([
  'lazy',
  'disable-udp',
  'include-all',
  'include-all-proxies',
  'include-all-providers',
  'hidden'
])
const stringFields = new Set([
  'name',
  'type',
  'url',
  'empty-fallback',
  'filter',
  'exclude-filter',
  'exclude-type',
  'expected-status',
  'icon'
])
export function supportedGroup(
  value: Item,
  inheritedURL?: unknown,
  options: { allowASNDependency?: boolean } = {}
): boolean {
  if (typeof value.type !== 'string' || !Object.hasOwn(groupTypes, value.type)) return false
  for (const [key, item] of Object.entries(value)) {
    if (booleanFields.has(key)) {
      if (typeof item !== 'boolean') return false
    } else if (stringFields.has(key)) {
      if (!string(item)) return false
    } else if (key === 'proxies' || key === 'use') {
      if (!Array.isArray(item) || item.length > 2000 || item.some((v) => !string(v, 256) || !v))
        return false
    } else if (key === 'interval' || key === 'max-failed-times') {
      if (!integer(item, 2147483647)) return false
    } else if (key === 'timeout') {
      if (!integer(item, 30000)) return false
    } else if (key === 'tolerance' && ['url-test', 'smart'].includes(String(value.type))) {
      if (!integer(item, 65535)) return false
    } else if (
      value.type === 'smart' &&
      ['uselightgbm', 'collectdata', 'prefer-asn'].includes(key)
    ) {
      // vernesong/mihomo@4624551 uses ASN.mmdb for Smart prefer-asn.
      // Only the complete-configuration dependency/binding path can carry ASN.
      // The isolated HTTP projection has no resource assets and stays closed.
      if (
        typeof item !== 'boolean' ||
        (key === 'prefer-asn' && item && !options.allowASNDependency)
      )
        return false
    } else if (value.type === 'smart' && key === 'sample-rate') {
      if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0 || item > 1) return false
    } else if (value.type === 'smart' && key === 'policy-priority') {
      if (!string(item)) return false
    } else if (key === 'default-selected' && value.type === 'select') {
      if (!string(item, 256)) return false
    } else if (key === 'strategy' && value.type === 'load-balance') {
      if (!['consistent-hashing', 'round-robin', 'sticky-sessions'].includes(String(item)))
        return false
    } else if (key === 'hash-key' && value.type === 'load-balance') {
      if (!['', 'in-user'].includes(String(item))) return false
    } else return false
  }
  const hasMembers =
    (Array.isArray(value.proxies) && value.proxies.length > 0) ||
    (Array.isArray(value.use) && value.use.length > 0) ||
    value['include-all'] ||
    value['include-all-proxies'] ||
    value['include-all-providers']
  if (!hasMembers) return false
  try {
    // No implicit upstream public health endpoint. Select without an interval
    // has no automatic probes; other groups require an explicit target.
    if (value.url !== undefined || inheritedURL !== undefined) healthURL(value.url || inheritedURL)
    if ((value.type !== 'select' || Number(value.interval) > 0) && !value.url && !inheritedURL)
      return false
  } catch {
    return false
  }
  return true
}
export function supportedInlineProvider(value: unknown, node: (item: Item) => boolean): boolean {
  if (
    !object(value) ||
    value.type !== 'inline' ||
    !Array.isArray(value.payload) ||
    value.payload.length < 1 ||
    value.payload.length > 2000 ||
    value.payload.some((item) => !object(item) || !node(item))
  )
    return false
  for (const [key, item] of Object.entries(value)) {
    if (['type', 'payload'].includes(key)) continue
    if (['filter', 'exclude-filter', 'exclude-type'].includes(key)) {
      if (!string(item)) return false
    } else if (key === 'health-check') {
      if (
        !object(item) ||
        Object.keys(item).some(
          (k) => !['enable', 'url', 'interval', 'timeout', 'lazy', 'expected-status'].includes(k)
        )
      )
        return false
      for (const [k, v] of Object.entries(item)) {
        if (['enable', 'lazy'].includes(k)) {
          if (typeof v !== 'boolean') return false
        } else if (k === 'interval') {
          if (!integer(v, 2147483647)) return false
        } else if (k === 'timeout') {
          if (!integer(v, 30000)) return false
        } else if (!string(v)) return false
      }
      try {
        if (item.url !== undefined) healthURL(item.url)
      } catch {
        return false
      }
      if (item.enable === true && !item.url) return false
    } else return false
  }
  return true
}
