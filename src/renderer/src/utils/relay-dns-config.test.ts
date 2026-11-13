import { describe, expect, it } from 'vitest'
import { DEFAULT_MIHOMO_DNS_CONFIG } from '../../../shared/appConfig'
import {
  configurationEditDocument,
  defaultEditDocument,
  type ConfigurationEditDocument
} from '../../../shared/relay/configuration-edit'
import { composeRuntimeConfiguration } from '../../../main/relay/configuration/merge'
import {
  parseRelayDnsPolicy,
  relayDnsDocument,
  relayDnsDraft,
  relayDnsPolicy
} from './relay-dns-config'

function baseline(): ConfigurationEditDocument {
  return configurationEditDocument({
    globalOverrides: [{ id: 'global', kind: 'yaml', content: 'log-level: warning' }],
    profileId: '11111111-1111-1111-1111-111111111111',
    profileOverrides: [{ id: 'old', kind: 'js', content: 'function main(c) { return c }' }],
    profileOverrideSets: [
      {
        profileId: '22222222-2222-2222-2222-222222222222',
        overrides: [{ id: 'other', kind: 'yaml', content: 'ipv6: true' }]
      }
    ],
    profileRulePatchSets: [
      {
        profileId: '22222222-2222-2222-2222-222222222222',
        rulePatch: { prepend: ['DOMAIN,fixture.invalid,REJECT'] }
      }
    ],
    rulePatch: { append: ['MATCH,REJECT'] },
    overrideLibraryOrder: ['33333333-3333-4333-8333-333333333333'],
    confirmedDnsFingerprint: 'a'.repeat(64),
    controlled: {
      ipv6: true,
      'geodata-mode': false,
      sniffer: { enable: false },
      dns: {
        enable: true,
        ipv6: true,
        listen: '127.0.0.1:0',
        'prefer-h3': true,
        'direct-nameserver-follow-policy': true,
        'cache-algorithm': 'arc',
        'proxy-server-nameserver-policy': { private: 'resolver' },
        'fallback-filter': { geoip: true, geosite: ['private'] },
        'nameserver-policy': { scalar: 'one', array: ['one'], multi: ['two', 'three'] }
      },
      hosts: { scalar: '127.0.0.1', array: ['::1'] }
    }
  })
}

describe('Relay DNS private document projection', () => {
  it('uses independent cloned defaults without creating any persisted body', () => {
    const base = defaultEditDocument()
    const draft = relayDnsDraft(base)
    expect(draft).toMatchObject({
      enable: true,
      ipv6: false,
      useHosts: false,
      useSystemHosts: false,
      respectRules: false,
      controlDns: false,
      useNameserverPolicy: false,
      disableDnsOverrideGuard: false
    })
    draft.nameserver.push('private')
    expect(DEFAULT_MIHOMO_DNS_CONFIG.nameserver).not.toContain('private')
    expect(relayDnsDocument(base, draft, {})).toEqual(base)
    expect(base.controlled).toEqual({})
  })

  it('saves only selected flags, preserves the fingerprint and does not materialize DNS or hosts', () => {
    const base = configurationEditDocument({
      ...defaultEditDocument(),
      confirmedDnsFingerprint: 'a'.repeat(64),
      controlled: { ipv6: true }
    })
    const draft = relayDnsDraft(base)
    draft.controlDns = true
    draft.useNameserverPolicy = true
    draft.disableDnsOverrideGuard = true
    draft.hosts.push({ domain: 'new.invalid', value: '127.0.0.1' })
    const next = relayDnsDocument(base, draft, {
      controlDns: true,
      useNameserverPolicy: true,
      disableDnsOverrideGuard: true
    })
    expect(next).toEqual({
      ...base,
      controlDns: true,
      useNameserverPolicy: true,
      disableDnsOverrideGuard: true
    })
    expect(base).not.toHaveProperty('controlDns')
  })

  it('writes every explicit false including fallback geoip while preserving top-level ipv6 and other scopes', () => {
    const base = baseline()
    const original = structuredClone(base)
    const draft = relayDnsDraft(base)
    draft.enable = draft.ipv6 = draft.useHosts = draft.useSystemHosts = draft.respectRules = false
    draft.fallbackGeoip = false
    draft.controlDns = draft.useNameserverPolicy = draft.disableDnsOverrideGuard = false
    const next = relayDnsDocument(base, draft, {
      dns: true,
      controlDns: true,
      useNameserverPolicy: true,
      disableDnsOverrideGuard: true
    })
    expect(next.controlled.dns).toMatchObject({
      enable: false,
      ipv6: false,
      'use-hosts': false,
      'use-system-hosts': false,
      'respect-rules': false,
      'fallback-filter': { geoip: false }
    })
    expect(next).toMatchObject({
      controlDns: false,
      useNameserverPolicy: false,
      disableDnsOverrideGuard: false,
      confirmedDnsFingerprint: original.confirmedDnsFingerprint,
      controlled: { ipv6: true }
    })
    expect({ ...next, controlled: original.controlled }).toEqual({
      ...original,
      controlDns: false,
      useNameserverPolicy: false,
      disableDnsOverrideGuard: false
    })
    expect(base).toEqual(original)
    expect(relayDnsDraft(next).fallbackGeoip).toBe(false)
  })

  it('keeps hidden DNS/filter fields, inactive policy, hosts and scalar/array value shapes', () => {
    const base = baseline()
    const draft = relayDnsDraft(base)
    draft.enhancedMode = 'normal'
    draft.useNameserverPolicy = false
    draft.useHosts = false
    const next = relayDnsDocument(base, draft, { dns: true, useNameserverPolicy: true })
    expect(next.controlled.dns).toMatchObject({
      'enhanced-mode': 'normal',
      'fake-ip-range': draft.fakeIPRange,
      listen: '127.0.0.1:0',
      'prefer-h3': true,
      'direct-nameserver-follow-policy': true,
      'cache-algorithm': 'arc',
      'proxy-server-nameserver-policy': { private: 'resolver' },
      'fallback-filter': { geosite: ['private'] },
      'nameserver-policy': { scalar: 'one', array: ['one'], multi: ['two', 'three'] }
    })
    expect(next.controlled.hosts).toEqual(base.controlled.hosts)
    expect(relayDnsDraft(next).nameserverPolicy).toEqual(draft.nameserverPolicy)
    expect(relayDnsDraft(next).hosts).toEqual(draft.hosts)
  })

  it('allows editing and keeping hosts while use-hosts is false without creating DNS', () => {
    const base = defaultEditDocument()
    const draft = relayDnsDraft(base)
    draft.hosts = [
      { domain: 'scalar.invalid', value: '127.0.0.1' },
      { domain: 'array.invalid', value: ['127.0.0.1', '::1'] }
    ]
    const next = relayDnsDocument(base, draft, { hosts: true })
    expect(next.controlled).toEqual({
      hosts: { 'scalar.invalid': '127.0.0.1', 'array.invalid': ['127.0.0.1', '::1'] }
    })
    draft.hosts[1].value = 'changed'
    expect(relayDnsDraft(next).hosts[1].value).toEqual(['127.0.0.1', '::1'])
  })

  it('filters disabled policy only from the runtime copy and keeps stored inactive content', async () => {
    const base = defaultEditDocument()
    const draft = relayDnsDraft(base)
    draft.controlDns = true
    draft.nameserverPolicy = [{ domain: '+.fixture.invalid', value: ['resolver'] }]
    draft.fallbackGeoip = false
    const next = relayDnsDocument(base, draft, { dns: true, controlDns: true })
    const original = structuredClone(next)
    const result = await composeRuntimeConfiguration({
      profileId: 'fixture',
      source: 'dns: {enable: true}',
      ...next
    })
    expect(result.dns.effective).toBe(true)
    expect(result.configuration.dns).not.toHaveProperty('nameserver-policy')
    expect(result.configuration.dns).toHaveProperty('fallback-filter.geoip', false)
    expect(next).toEqual(original)
    expect(relayDnsDraft(next).nameserverPolicy).toEqual(draft.nameserverPolicy)
  })

  it('does not turn requested DNS or a saved unrelated fingerprint into a source guard bypass', async () => {
    const base = baseline()
    const next = relayDnsDocument(
      base,
      { ...relayDnsDraft(base), controlDns: true },
      {
        controlDns: true
      }
    )
    const result = await composeRuntimeConfiguration({
      ...next,
      profileId: 'fixture',
      source: 'dns: {nameserver-policy: {private: original}}',
      globalOverrides: [],
      profileOverrides: []
    })
    expect(result.dns).toMatchObject({ requested: true, effective: false, autoDisabled: true })
    expect(result.configuration.dns).toEqual({ 'nameserver-policy': { private: 'original' } })
    expect(next.confirmedDnsFingerprint).toBe(base.confirmedDnsFingerprint)
  })

  it.each([
    { dns: null },
    { dns: [] },
    { dns: { enable: null } },
    { dns: { enable: 0 } },
    { dns: { nameserver: [1] } },
    { dns: { 'enhanced-mode': 'unknown' } },
    { dns: { 'fallback-filter': { geoip: 'true' } } },
    { dns: { 'nameserver-policy': [] } },
    { hosts: { invalid: null } }
  ])(
    'refuses unprojectable existing values instead of replacing them with defaults: %j',
    (controlled) => {
      const base = { ...defaultEditDocument(), controlled }
      const original = structuredClone(base)
      expect(() => relayDnsDraft(base)).toThrow()
      expect(base).toEqual(original)
    }
  )

  it('validates only selected changed bodies and refuses unknown change scopes', () => {
    const base = defaultEditDocument()
    const draft = relayDnsDraft(base)
    draft.hosts = [{ domain: 'unfinished', value: '' }]
    expect(relayDnsDocument(base, draft, { controlDns: true }).controlled).toEqual({})
    expect(() => relayDnsDocument(base, draft, { hosts: true })).toThrow()
    expect(() =>
      relayDnsDocument(base, draft, JSON.parse('{"confirmedDnsFingerprint":true}'))
    ).toThrow('范围')
    expect(() => relayDnsDocument(base, draft, JSON.parse('{"dns":"true"}'))).toThrow('范围')
    expect(base).toEqual(defaultEditDocument())
  })
})

describe('Strict private DNS policy JSON and rows', () => {
  it('preserves scalar and array shapes, values containing commas and safe prototype-like keys', () => {
    const text = '{"scalar":"https://resolver.invalid/q?a=b,c","one":["x"],"__proto__":"y"}'
    const value = relayDnsPolicy(parseRelayDnsPolicy(text))
    expect(value).toEqual(JSON.parse(text))
    expect(Object.hasOwn(value, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(parseRelayDnsPolicy('{}')).toEqual([])
  })

  it.each([
    '',
    '{',
    'key: value',
    '{"key":"value",}',
    '{"key":"value"} // comment',
    'null',
    '[]',
    '"value"',
    '{"key":false}',
    '{"key":null}',
    '{"key":{}}',
    '{"key":[]}',
    '{"key":["ok",false]}',
    '{"key":" "}',
    '{"key":"first","key":"last"}',
    '{"key":"first","\\u006bey":"last"}'
  ])('rejects invalid or lossy policy input without a fallback map: %s', (text) => {
    expect(() => parseRelayDnsPolicy(text)).toThrow('DNS')
  })

  it('rejects duplicate/partial rows and only omits an entirely blank placeholder', () => {
    expect(relayDnsPolicy([{ domain: '', value: '' }])).toEqual({})
    expect(() => relayDnsPolicy([{ domain: 'key', value: '' }])).toThrow()
    expect(() => relayDnsPolicy([{ domain: '', value: 'resolver' }])).toThrow()
    expect(() =>
      relayDnsPolicy([
        { domain: ' key ', value: 'first' },
        { domain: 'key', value: ['second'] }
      ])
    ).toThrow('重复')
  })

  it('bounds UTF-8 input and keeps private URI contents out of errors', () => {
    expect(() => parseRelayDnsPolicy(JSON.stringify({ key: '界'.repeat(400000) }))).toThrow('过大')
    let failure: unknown
    try {
      parseRelayDnsPolicy('{"PRIVATE_TOKEN_URI":false}')
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain('PRIVATE_TOKEN_URI')
  })
})
