import type { RuntimeAsset } from '../configuration/bindings'
import { validateBoundConfiguration } from '../configuration/checker'
import type { ProfileRuntimeGeography } from '../profiles/runtime'
import { controlledListeners, validateDedicatedRoute } from './dedicated-listeners'

export const localProxyGeoControls = {
  'geo-auto-update': false,
  'geox-url': { geoip: '', geosite: '', mmdb: '', asn: '' }
}

export function sameLocalProxyGeoAssets(
  left: readonly RuntimeAsset[] = [],
  right: readonly RuntimeAsset[] = []
): boolean {
  const fingerprint = (assets: readonly RuntimeAsset[]): string =>
    JSON.stringify(
      assets.map(({ path, sha256 }) => [path, sha256]).sort(([a], [b]) => a.localeCompare(b))
    )
  return fingerprint(left) === fingerprint(right)
}

// Mihomo may retain loaded databases across ApplyConfig. A reload may use a
// subset of the pinned files or add a new filename, never replace pinned bytes.
export function compatibleLocalProxyGeoAssets(
  pinned: readonly RuntimeAsset[] = [],
  next: readonly RuntimeAsset[] = []
): boolean {
  return next.every((asset) => {
    const existing = pinned.find((item) => item.path === asset.path)
    return !existing || existing.sha256 === asset.sha256
  })
}

// The complete configuration binder supplies fixed local files. This ordinary
// HTTP path admits databases referenced by top-level GEO rules and DNS policies.
export function localProxyGeography(
  configuration: Record<string, unknown>,
  assets: readonly RuntimeAsset[] = []
): ProfileRuntimeGeography {
  const rules = Array.isArray(configuration.rules) ? configuration.rules : []
  const dns = configuration.dns as Record<string, unknown> | undefined
  const geoip = rules.some(
    (rule) => typeof rule === 'string' && rule.split(',')[0].trim() === 'GEOIP'
  )
  const geosite =
    rules.some((rule) => typeof rule === 'string' && rule.split(',')[0].trim() === 'GEOSITE') ||
    (dns?.enable === true &&
      ['nameserver-policy', 'proxy-server-nameserver-policy'].some(
        (key) =>
          dns[key] &&
          typeof dns[key] === 'object' &&
          !Array.isArray(dns[key]) &&
          Object.keys(dns[key]).some((name) => name.startsWith('geosite:'))
      ))
  const required = new Set<string>([
    ...(geoip ? [configuration['geodata-mode'] === true ? 'GeoIP.dat' : 'Country.mmdb'] : []),
    ...(geosite ? ['GeoSite.dat'] : [])
  ])
  if (
    !Array.isArray(assets) ||
    assets.length !== required.size ||
    new Set(assets.map((asset) => asset.path)).size !== assets.length ||
    assets.some((asset) => !required.has(asset.path) || asset.expectedRules !== undefined)
  )
    throw new Error('地理规则需要已固定的本地数据库；请先同步或导入对应缓存。')
  return { geoip, geosite }
}

export function validateLocalProxyGeoAssets(
  configuration: Record<string, unknown>,
  assets: readonly RuntimeAsset[] = []
): void {
  localProxyGeography(configuration, assets)
  if (assets.length) {
    const dedicated = controlledListeners(configuration.listeners)
    if (dedicated) validateDedicatedRoute(dedicated, configuration)
    // These exact owned listeners cannot reference files. Check all other
    // resource dependencies without passing their projection-only fields to
    // the generic inbound schema; the actual runtime keeps its listeners.
    validateBoundConfiguration(JSON.stringify({ ...configuration, listeners: [] }), assets)
  }
}
