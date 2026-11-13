import { describe, expect, it } from 'vitest'
import { parseTunTopology } from './topology'

const devices = `en0: flags=8863<UP,BROADCAST,RUNNING> mtu 1500
\tinet 192.0.2.2 netmask 0xffffff00 broadcast 192.0.2.255
\tstatus: active
utun8: flags=8051<UP,POINTOPOINT,RUNNING> mtu 1500
\tinet6 fe80::1%utun8 prefixlen 64 scopeid 0x8
`
const routes = `Routing tables
Internet:
Destination Gateway Flags Netif Expire
default 192.0.2.1 UGScg en0
192.0.2 link#4 UCS en0 !
192.0.2.1 00:11:22:33:44:55 UHLWIir en0 1000
Internet6:
Destination Gateway Flags Netif Expire
default fe80::1%en0 UGcIg en0
fe80::%utun8 link#8 UcI utun8
`
describe('Configured network topology evidence', () => {
  it('ignores neighbor expiry/cache changes while retaining configured paths', () => {
    const before = parseTunTopology(devices, routes)
    expect(parseTunTopology(devices, routes.replace('1000', '999'))).toEqual(before)
    expect(
      parseTunTopology(devices, routes.replace('00:11:22:33:44:55', 'aa:bb:cc:dd:ee:ff'))
    ).toEqual(before)
    expect(
      parseTunTopology(devices, routes.replace('192.0.2.1 UGScg', '192.0.2.254 UGScg'))
    ).not.toEqual(before)
  })
  it('binds addresses and status to their actual interface', () => {
    const reassigned =
      devices.replace('\tinet 192.0.2.2 netmask 0xffffff00 broadcast 192.0.2.255\n', '') +
      '\tinet 192.0.2.2 netmask 0xffffff00 broadcast 192.0.2.255\n'
    expect(parseTunTopology(reassigned, routes).interfacesSHA256).not.toBe(
      parseTunTopology(devices, routes).interfacesSHA256
    )
    expect(
      parseTunTopology(devices.replace('status: active', 'status: inactive'), routes)
    ).not.toEqual(parseTunTopology(devices, routes))
  })
  it('distinguishes IPv4 and IPv6 paths with otherwise identical columns', () => {
    const first = 'Internet:\ndefault link#4 UGc en0\nInternet6:\n'
    const second = 'Internet:\nInternet6:\ndefault link#4 UGc en0\n'
    expect(parseTunTopology(devices, first).routesSHA256).not.toBe(
      parseTunTopology(devices, second).routesSHA256
    )
  })
  it('does not let row order or routing expiration fields change identity', () => {
    const reordered = routes.replace(
      'default 192.0.2.1 UGScg en0\n192.0.2 link#4 UCS en0 !',
      '192.0.2 link#4 UCS en0 400\ndefault 192.0.2.1 UGScg en0'
    )
    expect(parseTunTopology(devices, reordered)).toEqual(parseTunTopology(devices, routes))
  })
  it('detects an added interface and its connected routes', () => {
    expect(
      parseTunTopology(devices + 'utun9: flags=8051<UP,POINTOPOINT> mtu 9000\n', routes)
    ).not.toEqual(parseTunTopology(devices, routes))
    expect(parseTunTopology(devices, routes + '198.51.100 link#9 UCS utun9\n')).not.toEqual(
      parseTunTopology(devices, routes)
    )
  })
  it('refuses missing headers/defaults, unbound addresses and invalid output', () => {
    for (const [interfaces, paths] of [
      ['', routes],
      ['operation not permitted', routes],
      [devices, 'operation not permitted'],
      [devices, 'default 192.0.2.1 UGScg en0'],
      ['\tinet 192.0.2.2\n' + devices, routes],
      [devices, routes.replaceAll('default', 'specific')],
      [devices + '\0', routes]
    ])
      expect(() => parseTunTopology(interfaces, paths)).toThrow()
  })
})
