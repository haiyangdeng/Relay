import { describe, expect, it } from 'vitest'
import type { RuntimeAsset } from '../configuration/bindings'
import { resourceHash } from '../resources/source'
import { compileProfileRuntime } from '../profiles/runtime'
import { localProxyConfiguration } from './local-proxy-runtime'
import { ownedCoreConfiguration } from './owned-runtime'
import { injectDedicatedListeners } from './dedicated-listeners'
import {
  compatibleLocalProxyGeoAssets,
  sameLocalProxyGeoAssets,
  validateLocalProxyGeoAssets
} from './local-proxy-geo'

const source = {
  proxies: [{ name: 'A', type: 'http', server: '127.0.0.1', port: 1 }],
  'proxy-groups': [{ name: 'G', type: 'select', proxies: ['A'] }],
  rules: ['GEOSITE,CN,DIRECT', 'GEOIP,cn,DIRECT', 'MATCH,G']
}
const asset = (path: string): RuntimeAsset => {
  const bytes = Buffer.from('synthetic offline geography fixture')
  return { path, bytes, sha256: resourceHash(bytes) }
}
describe('HTTP runtime local Geo resources', () => {
  it.each([
    { dat: false, ports: { http: 18191, socks: 18192, mixed: 0, redir: 0 } },
    { dat: true, ports: { http: 18191, socks: 18192, mixed: 0, redir: 0 } },
    { dat: false, ports: { http: 0, socks: 0, mixed: 18191, redir: 0 } },
    { dat: true, ports: { http: 0, socks: 0, mixed: 18191, redir: 0 } }
  ])(
    'admits dedicated HTTP/SOCKS and ordinary ports with pinned Geo rules and DNS (%j)',
    ({ dat, ports }) => {
      const input = JSON.stringify({
        ...source,
        'geodata-mode': dat,
        'unified-delay': true,
        listeners: [{ name: 'foreign-source', type: 'http', port: 29999, listen: '0.0.0.0' }],
        dns: {
          enable: true,
          nameserver: ['1.1.1.1'],
          'default-nameserver': ['1.1.1.1'],
          'nameserver-policy': { 'geosite:cn': ['1.1.1.1'] }
        }
      })
      const assets = [asset('GeoSite.dat'), asset(dat ? 'GeoIP.dat' : 'Country.mmdb')]
      const dedicated = { httpPort: 17891, socksPort: 17892, route: 'A' }
      const built = localProxyConfiguration(
        input,
        ports.http || ports.mixed,
        'profile',
        dedicated,
        undefined,
        assets,
        ports
      )
      const admitted = ownedCoreConfiguration(
        built.configuration,
        'localProxy',
        undefined,
        undefined,
        assets
      )
      expect(admitted.parsed.listeners).toEqual([
        {
          name: 'relay-ai-http',
          type: 'http',
          port: 17891,
          listen: '127.0.0.1',
          proxy: 'A',
          udp: false
        },
        {
          name: 'relay-ai-socks',
          type: 'socks',
          port: 17892,
          listen: '127.0.0.1',
          proxy: 'A',
          udp: false
        }
      ])
      expect(admitted.parsed.port).toBe(ports.http)
      expect(admitted.parsed['socks-port']).toBe(ports.socks)
      expect(admitted.parsed['mixed-port']).toBe(ports.mixed)
      expect(admitted.parsed['redir-port']).toBe(ports.redir)
      expect(built.ports).toEqual(ports)
      expect(admitted.parsed.rules).toEqual(source.rules)
      expect(admitted.parsed['unified-delay']).toBe(true)
      expect(admitted.parsed['geo-auto-update']).toBe(false)
      expect((admitted.parsed.dns as Record<string, unknown>)['nameserver-policy']).toEqual({
        'geosite:cn': ['1.1.1.1']
      })
      expect(JSON.parse(built.configuration).listeners).toEqual(admitted.parsed.listeners)
      expect(admitted.parsed.listeners).not.toContainEqual(
        expect.objectContaining({ name: 'foreign-source' })
      )
    }
  )
  it('keeps dedicated-listener and resource boundaries strict when checking Geo assets', () => {
    const assets = [asset('GeoSite.dat'), asset('Country.mmdb')]
    const baseline = JSON.parse(
      localProxyConfiguration(JSON.stringify(source), 18191, 'off', undefined, undefined, assets)
        .configuration
    )
    injectDedicatedListeners(baseline, { httpPort: 17891, socksPort: 17892, route: 'A' })
    const [http, socks] = baseline.listeners
    for (const listeners of [
      [{ ...http, name: 'foreign' }],
      [{ ...http, certificate: '/unbound/private.pem' }],
      [{ ...http, listen: '0.0.0.0' }],
      [http, { ...socks, udp: true }],
      [{ ...http, proxy: 'DIRECT' }],
      [{ ...http, proxy: 'G' }],
      [http, { ...socks, proxy: 'missing' }]
    ]) {
      const changed = { ...baseline, listeners }
      expect(() => validateLocalProxyGeoAssets(changed, assets)).toThrow()
      expect(() =>
        ownedCoreConfiguration(JSON.stringify(changed), 'localProxy', undefined, undefined, assets)
      ).toThrow()
    }
    for (const patch of [
      { proxies: [{ ...source.proxies[0], 'dialer-proxy': 'G' }] },
      { 'geo-auto-update': true },
      { 'geox-url': { geoip: 'https://example.invalid/geoip.dat' } },
      { tls: { certificate: '/unbound/private.pem' } }
    ])
      expect(() => validateLocalProxyGeoAssets({ ...baseline, ...patch }, assets)).toThrow()
    for (const changedAssets of [
      assets.slice(0, 1),
      [{ ...assets[0], bytes: Buffer.from('changed') }, assets[1]]
    ])
      expect(() => validateLocalProxyGeoAssets(baseline, changedAssets)).toThrow()
    expect(() =>
      ownedCoreConfiguration(
        JSON.stringify({ ...baseline, listeners: [{ ...http, port: baseline.port }] }),
        'localProxy',
        undefined,
        undefined,
        assets
      )
    ).toThrow('AI 专用监听端口不能与普通监听端口重复。')
  })
  it('preserves Geo DNS policies and static rcode responses only with a pinned site database', () => {
    const input = {
      ...source,
      rules: ['MATCH,G'],
      dns: {
        enable: true,
        nameserver: ['https://1.1.1.1/dns-query#ImportedName'],
        'default-nameserver': ['1.1.1.1'],
        'nameserver-policy': {
          'geosite:category-ads-all': 'rcode://success',
          'geosite:cn,geolocation-cn': ['1.1.1.1']
        }
      }
    }
    const assets = [asset('GeoSite.dat')],
      before = JSON.stringify(input)
    expect(() => localProxyConfiguration(before, 18191, 'profile')).toThrow()
    const built = localProxyConfiguration(before, 18191, 'profile', undefined, undefined, assets)
    const admitted = ownedCoreConfiguration(
      built.configuration,
      'localProxy',
      undefined,
      undefined,
      assets
    )
    expect((admitted.parsed.dns as Record<string, unknown>)['nameserver-policy']).toEqual(
      input.dns['nameserver-policy']
    )
    expect(JSON.stringify(input)).toBe(before)
    expect(localProxyConfiguration(before, 18191, 'off').resolution.enabled).toBe(false)
    for (const invalid of [
      'rcode://unknown',
      'rcode://success#DIRECT',
      'rcode://success?ignored=yes'
    ]) {
      const changed = {
        ...input,
        dns: { ...input.dns, 'nameserver-policy': { 'geosite:cn': invalid } }
      }
      expect(() =>
        localProxyConfiguration(
          JSON.stringify(changed),
          18191,
          'profile',
          undefined,
          undefined,
          assets
        )
      ).toThrow()
    }
  })
  it('admits subscription Geo URL metadata without forwarding automatic download endpoints', () => {
    const input = { ...source, 'geox-url': { metadb: 'https://example.invalid/geoip.metadb' } }
    const assets = [asset('GeoSite.dat'), asset('Country.mmdb')]
    const built = localProxyConfiguration(
      JSON.stringify(input),
      18191,
      'off',
      undefined,
      undefined,
      assets
    )
    expect(JSON.parse(built.configuration)['geox-url']).toEqual({
      geoip: '',
      geosite: '',
      mmdb: '',
      asn: ''
    })
    expect(() =>
      localProxyConfiguration(
        JSON.stringify({ ...input, 'geox-url': { metadb: 'file:///PRIVATE' } }),
        18191,
        'off',
        undefined,
        undefined,
        assets
      )
    ).toThrow()
  })
  it('allows resource subsets and new filenames but never replacing an already pinned database', () => {
    const pinned = [asset('Country.mmdb'), asset('GeoSite.dat')]
    expect(compatibleLocalProxyGeoAssets(pinned, [pinned[0]])).toBe(true)
    expect(compatibleLocalProxyGeoAssets([pinned[0]], pinned)).toBe(true)
    expect(compatibleLocalProxyGeoAssets(pinned, [])).toBe(true)
    expect(compatibleLocalProxyGeoAssets(pinned, [{ ...pinned[0], sha256: '0'.repeat(64) }])).toBe(
      false
    )
  })
  it.each([false, true])(
    'preserves both geographic rules with explicitly bound databases (dat=%s)',
    (dat) => {
      const input = JSON.stringify({ ...source, 'geodata-mode': dat })
      const assets = [asset('GeoSite.dat'), asset(dat ? 'GeoIP.dat' : 'Country.mmdb')]
      expect(compileProfileRuntime(input).configuration).toBeUndefined()
      const built = localProxyConfiguration(input, 18191, 'off', undefined, undefined, assets)
      const admitted = ownedCoreConfiguration(
        built.configuration,
        'localProxy',
        undefined,
        undefined,
        assets
      )
      expect(admitted.parsed.rules).toEqual(source.rules)
      expect(admitted.parsed['geodata-mode']).toBe(dat)
      expect(admitted.parsed['geo-auto-update']).toBe(false)
      expect(admitted.parsed['geox-url']).toEqual({ geoip: '', geosite: '', mmdb: '', asn: '' })
      expect(admitted.parsed.tun).toEqual({ enable: false })
      expect(() => ownedCoreConfiguration(built.configuration, 'localProxy')).toThrow()
      expect(() =>
        ownedCoreConfiguration(built.configuration, 'inert', undefined, undefined, assets)
      ).toThrow()
      assets[0].bytes.fill(0)
      expect(admitted.runtimeAssets[0].bytes.equals(assets[0].bytes)).toBe(false)
    }
  )
  it('rejects missing, duplicate, extra, traversing and mutated resources before runtime admission', () => {
    const good = [asset('GeoSite.dat'), asset('Country.mmdb')]
    for (const assets of [
      [],
      [good[0]],
      [...good, good[0]],
      [...good, asset('ASN.mmdb')],
      [asset('../GeoSite.dat'), good[1]],
      [{ ...good[0], bytes: Buffer.from('changed') }, good[1]]
    ])
      expect(() =>
        localProxyConfiguration(JSON.stringify(source), 18191, 'off', undefined, undefined, assets)
      ).toThrow()
    expect(sameLocalProxyGeoAssets(good, [...good].reverse())).toBe(true)
    expect(sameLocalProxyGeoAssets(good, [good[0], { ...good[1], sha256: '0'.repeat(64) }])).toBe(
      false
    )
  })
  it('does not admit additional geographic syntax or automatic downloads through the final boundary', () => {
    const assets = [asset('GeoSite.dat'), asset('Country.mmdb')]
    const built = localProxyConfiguration(
      JSON.stringify(source),
      18191,
      'off',
      undefined,
      undefined,
      assets
    )
    const parsed = JSON.parse(built.configuration)
    for (const patch of [
      { 'geo-auto-update': true },
      { 'geox-url': { geoip: 'https://example.invalid/geoip.dat' } },
      { rules: ['GEOIP,cn,DIRECT,unsupported', 'GEOSITE,CN,DIRECT', 'MATCH,G'] },
      { rules: ['GEOSITE,CN,missing', 'GEOIP,cn,DIRECT', 'MATCH,G'] }
    ])
      expect(() =>
        ownedCoreConfiguration(
          JSON.stringify({ ...parsed, ...patch }),
          'localProxy',
          undefined,
          undefined,
          assets
        )
      ).toThrow()
  })
})
