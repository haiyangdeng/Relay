import { describe, expect, it } from 'vitest'
import { projectTunNetwork } from './projection'
function config(tun: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return JSON.stringify({
    ipv6: false,
    tun: {
      enable: true,
      device: 'utun',
      stack: 'gvisor',
      'auto-route': true,
      'auto-detect-interface': true,
      'dns-hijack': [],
      ...tun
    },
    ...top
  })
}
describe('Complete configuration to owned macOS network projection', () => {
  it('preserves fixed-core address/default MTU semantics and splits the default route without replacing it', () => {
    const result = projectTunNetwork(config()),
      p = JSON.parse(result.projection)
    expect(result.managedMTU).toBe(9000)
    expect(p.addresses).toEqual([{ address: { family: 'ipv4', value: '198.18.0.1' }, length: 30 }])
    expect(
      p.routes.map((r: { destination: { address: { value: string }; length: number } }) => [
        r.destination.address.value,
        r.destination.length
      ])
    ).toEqual([
      ['0.0.0.0', 1],
      ['128.0.0.0', 1]
    ])
    expect(p.resolver).toBeNull()
  })
  it('subtracts direct exceptions while retaining explicit route and IPv6 intentions', () => {
    const p = JSON.parse(
      projectTunNetwork(
        config({ 'route-address': ['10.0.0.0/8'], 'route-exclude-address': ['10.0.0.0/9'] })
      ).projection
    )
    expect(p.routes).toEqual([
      {
        destination: { address: { family: 'ipv4', value: '10.128.0.0' }, length: 9 },
        scoped: false
      }
    ])
    const v6 = JSON.parse(projectTunNetwork(config({}, { ipv6: true })).projection)
    expect(v6.addresses[1]).toEqual({
      address: { family: 'ipv6', value: 'fdfe:dcba:9876::1' },
      length: 126
    })
    expect(v6.routes).toHaveLength(4)
  })
  it('coordinates system DNS only for explicit Darwin DNS mode with enabled core DNS', () => {
    const p = JSON.parse(
      projectTunNetwork(
        config(
          { 'dns-mode': 'native' },
          { dns: { enable: true, 'fake-ip-range': '198.19.0.1/16' } }
        )
      ).projection
    )
    expect(p.resolver).toMatchObject({
      servers: [{ family: 'ipv4', value: '198.19.0.2' }],
      matchDomains: [''],
      searchOrder: 1
    })
    expect(() => projectTunNetwork(config({ 'dns-mode': 'native' }))).toThrow('明确启用DNS')
  })
  it.each([
    { 'route-address': ['198.51.100.0/24'] },
    { 'route-exclude-address': ['198.18.0.2/32'] },
    { 'route-address': ['198.18.0.2/32'], 'auto-route': false }
  ])('rejects system DNS without an effective route: %j', (tun) => {
    expect(() =>
      projectTunNetwork(config({ ...tun, 'dns-mode': 'native' }, { dns: { enable: true } }))
    ).toThrow('TUN系统DNS地址 198.18.0.2 未被有效路由覆盖')
  })
  it('accepts explicit DNS host routes without adding other routes', () => {
    const p = JSON.parse(
      projectTunNetwork(
        config(
          {
            'dns-mode': 'native',
            'route-address': ['198.51.100.0/24', '198.18.0.2/32']
          },
          { dns: { enable: true } }
        )
      ).projection
    )
    expect(p.routes).toEqual([
      {
        destination: { address: { family: 'ipv4', value: '198.51.100.0' }, length: 24 },
        scoped: false
      },
      {
        destination: { address: { family: 'ipv4', value: '198.18.0.2' }, length: 32 },
        scoped: false
      }
    ])
    expect(p.resolver.servers).toEqual([{ family: 'ipv4', value: '198.18.0.2' }])
  })
  it('requires coverage for every enabled address family', () => {
    const tun = { 'dns-mode': 'native', 'route-address': ['198.18.0.2/32'] },
      top = { ipv6: true, dns: { enable: true } }
    expect(() => projectTunNetwork(config(tun, top))).toThrow(
      'TUN系统DNS地址 fdfe:dcba:9876::2 未被有效路由覆盖'
    )
    expect(() =>
      projectTunNetwork(
        config({ ...tun, 'route-address': [...tun['route-address'], 'fdfe:dcba:9876::2/128'] }, top)
      )
    ).not.toThrow()
    expect(() => projectTunNetwork(config({ 'dns-mode': 'native' }, top))).not.toThrow()
  })
  it('does not require resolver routes when system DNS coordination is disabled', () => {
    const p = JSON.parse(
      projectTunNetwork(
        config({ 'dns-mode': 'disabled', 'auto-route': false }, { dns: { enable: true } })
      ).projection
    )
    expect(p.routes).toEqual([])
    expect(p.resolver).toBeNull()
  })
  it('rejects unimplemented or malformed requests instead of silently dropping them', () => {
    for (const tun of [
      { 'auto-redirect': true },
      { 'include-interface': ['en0'] },
      { 'route-address': ['10.0.0.1/8'] },
      { mtu: 1200 }
    ])
      expect(() => projectTunNetwork(config(tun))).toThrow()
  })
})
