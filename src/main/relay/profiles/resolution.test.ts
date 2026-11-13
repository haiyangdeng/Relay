import { describe, expect, it } from 'vitest'
import { localProxyConfiguration } from '../core/local-proxy-runtime'
import { profileRuntimeSource } from '../__fixtures__/profile-runtime'
import { ownedCoreConfiguration } from '../core/owned-runtime'
import { compileProfileResolution } from './resolution'
import { analyzeProfile } from './inspect'

const targets = new Set(['DIRECT', 'Group', 'Node'])
function source(): Record<string, unknown> {
  return {
    proxies: [{ name: 'Node', server: '127.0.0.1' }],
    hosts: { '+.internal.test': ['10.1.2.3', '::1'] },
    dns: {
      enable: true,
      listen: '0.0.0.0:53',
      nameserver: ['1.1.1.1'],
      'nameserver-policy': {
        '+.anthropic.com': 'https://cloudflare-dns.com/dns-query#Group',
        '+.internal.test': ['10.0.0.53']
      },
      'proxy-server-nameserver': ['10.0.0.53'],
      'use-hosts': true
    }
  }
}
describe('Configuration-local DNS/hosts compilation', () => {
  it('preserves configured resolver addresses, ordered policies and hosts without mutating source or opening DNS', () => {
    const input = source(),
      before = JSON.stringify(input)
    const result = compileProfileResolution(input, targets)
    expect(JSON.stringify(input)).toBe(before)
    expect(result.dns).toMatchObject({
      nameserver: ['1.1.1.1'],
      'default-nameserver': ['1.1.1.1'],
      'nameserver-policy': (input.dns as Record<string, unknown>)['nameserver-policy'],
      'proxy-server-nameserver': ['10.0.0.53'],
      listen: '',
      'fallback-filter': { geoip: false }
    })
    expect(result.hosts).toEqual(input.hosts)
    expect(result.summary).toMatchObject({
      enabled: true,
      hosts: 1,
      policies: 2,
      bootstrapDerived: true,
      listenerSuppressed: true
    })
    result.hosts['+.internal.test'] = []
    expect(input.hosts).not.toEqual(result.hosts)
  })
  it('never silently adds the core default public bootstrap resolvers', () => {
    const input = { dns: { enable: true, nameserver: ['https://cloudflare-dns.com/dns-query'] } }
    expect(() => compileProfileResolution(input, targets)).toThrow('未启动')
    const result = compileProfileResolution(
      { dns: { ...input.dns, 'default-nameserver': ['tcp://127.0.0.1:5353'] } },
      targets
    )
    expect(result.dns['default-nameserver']).toEqual(['tcp://127.0.0.1:5353'])
    expect(result.summary.bootstrapDerived).toBe(false)
  })
  it('requires independent node resolution for routed DNS and respect-rules', () => {
    const input = source()
    input.proxies = [{ name: 'Node', server: 'proxy.internal.test' }]
    const dns = input.dns as Record<string, unknown>
    delete dns['proxy-server-nameserver']
    expect(() => compileProfileResolution(input, targets)).toThrow()
    dns['proxy-server-nameserver'] = ['10.0.0.53']
    expect(compileProfileResolution(input, targets).dns['proxy-server-nameserver']).toEqual([
      '10.0.0.53'
    ])
    dns['proxy-server-nameserver'] = ['https://example.test/dns-query#Group']
    expect(() => compileProfileResolution(input, targets)).toThrow()
    delete dns['nameserver-policy']
    delete dns['proxy-server-nameserver']
    dns['respect-rules'] = true
    expect(() => compileProfileResolution(input, targets)).toThrow()
  })
  it('blocks implicit or explicit geographical fallback resources rather than changing their semantics', () => {
    for (const filter of [undefined, {}, { geoip: true }, { geoip: false, geosite: ['cn'] }]) {
      expect(() =>
        compileProfileResolution(
          {
            dns: {
              enable: true,
              nameserver: ['1.1.1.1'],
              fallback: ['8.8.8.8'],
              ...(filter ? { 'fallback-filter': filter } : {})
            }
          },
          targets
        )
      ).toThrow()
    }
    const dns = {
      enable: true,
      nameserver: ['1.1.1.1'],
      fallback: ['8.8.8.8'],
      'fallback-filter': { geoip: false, ipcidr: ['0.0.0.0/8'], domain: ['+.example.test'] }
    }
    expect(compileProfileResolution({ dns }, targets).dns.fallback).toEqual(['8.8.8.8'])
  })
  it('preserves Clash dormant geographical defaults only while fallback is empty', () => {
    const dns = {
      enable: true,
      nameserver: ['1.1.1.1'],
      fallback: [],
      'fallback-filter': {
        geoip: true,
        'geoip-code': 'CN',
        ipcidr: ['0.0.0.0/8'],
        domain: ['+.example.test']
      }
    }
    const before = structuredClone(dns)
    const input = { ...analyzeProfile(profileRuntimeSource).data, dns }
    const built = localProxyConfiguration(JSON.stringify(input), 18191, 'profile')
    const runtime = ownedCoreConfiguration(built.configuration, 'localProxy').parsed
    expect((runtime.dns as Record<string, unknown>)['fallback-filter']).toEqual(
      dns['fallback-filter']
    )
    expect(dns).toEqual(before)
    expect(() =>
      compileProfileResolution({ dns: { ...dns, fallback: ['8.8.8.8'] } }, targets)
    ).toThrow()
    expect(() =>
      compileProfileResolution({ dns: { ...dns, 'fallback-filter': { geoip: 'true' } } }, targets)
    ).toThrow()
  })
  it('preserves explicit DNS proxy and interface suffixes without guessing or rewriting destinations', () => {
    for (const name of ['Group', 'en0', '不存在的接口', 'PROXY']) {
      const server = 'https://1.1.1.1/dns-query#' + name
      const dns = {
        enable: true,
        nameserver: [server],
        'default-nameserver': ['1.1.1.1'],
        'proxy-server-nameserver': ['1.1.1.1']
      }
      expect(compileProfileResolution({ dns }, targets).dns.nameserver).toEqual([server])
    }
  })
  it('blocks external files, system/interface discovery and unsupported URL parameters', () => {
    for (const endpoint of [
      'file:///etc/resolv.conf',
      'system',
      'dhcp://en0',
      'tailscale://Node',
      'https://u:PRIVATE@example.test/dns-query',
      'https://example.test/dns-query?ignored=yes',
      'https://example.test/dns-query#%0aen0',
      'https://example.test/dns-query#Group&h3=true',
      'udp://127.0.0.1:0',
      '1.1.1.1\n'
    ]) {
      expect(() =>
        compileProfileResolution(
          { dns: { enable: true, nameserver: [endpoint], 'default-nameserver': ['1.1.1.1'] } },
          targets
        )
      ).toThrow()
    }
  })
  it('rejects resource policy keys, fake-ip rule resources and unknown DNS keys', () => {
    for (const patch of [
      { 'nameserver-policy': { 'geosite:cn': '1.1.1.1' } },
      { 'nameserver-policy': { 'rule-set:private': ['1.1.1.1'] } },
      { 'fake-ip-filter': ['geosite:private'] },
      { 'fake-ip-filter-mode': 'rule' },
      { 'listen-routing-mark': 1 },
      { unknown: 'PRIVATE' }
    ])
      expect(() =>
        compileProfileResolution(
          { dns: { enable: true, nameserver: ['1.1.1.1'], ...patch } },
          targets
        )
      ).toThrow()
  })
  it('validates shapes, IP families and budgets without silently dropping entries', () => {
    for (const patch of [
      { enable: false },
      { nameserver: [] },
      { ipv6: 'true' },
      { 'cache-max-size': -1 },
      { 'fake-ip-range': '::1/128' },
      { 'nameserver-policy': { '*.test': [] } },
      { nameserver: Array(33).fill('1.1.1.1') }
    ])
      expect(() =>
        compileProfileResolution(
          { dns: { enable: true, nameserver: ['1.1.1.1'], ...patch } },
          targets
        )
      ).toThrow()
    for (const hosts of [
      { 'a.test': 'lan' },
      { 'a.test': 'alias.test' },
      { 'a.test': ['invalid'] },
      { 'a.test.': '127.0.0.1' },
      Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`a${i}.test`, '127.0.0.1']))
    ])
      expect(() =>
        compileProfileResolution({ dns: { enable: true, nameserver: ['1.1.1.1'] }, hosts }, targets)
      ).toThrow()
  })
  it('has idempotent materialized DNS boundaries and explicitly controlled IPv6', () => {
    const first = compileProfileResolution({ ...source(), ipv6: true }, targets)
    const second = compileProfileResolution(first, targets)
    expect(second.dns).toEqual(first.dns)
    expect(second.hosts).toEqual(first.hosts)
    expect(second.ipv6).toBe(true)
  })
  it('keeps the prior default off and only materializes DNS after explicit selection', () => {
    const data = analyzeProfile(profileRuntimeSource).data
    if (!data) throw new Error('fixture missing')
    const raw = JSON.stringify({ ...data, dns: source().dns, hosts: source().hosts })
    expect(JSON.parse(localProxyConfiguration(raw, 18191).configuration).dns).toEqual({
      enable: false
    })
    const result = localProxyConfiguration(raw, 18191, 'profile')
    expect(result.resolution.enabled).toBe(true)
    expect(JSON.parse(result.configuration)).toMatchObject({
      dns: { enable: true, listen: '' },
      tun: { enable: false },
      hosts: source().hosts
    })
  })
})
