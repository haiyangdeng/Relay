import { describe, expect, it } from 'vitest'
import { deepMerge } from '../../utils/merge'
import {
  composeRuntimeConfiguration,
  mergeConfiguration,
  protectedDnsFingerprint,
  type RuntimeMergeOptions
} from './merge'

const input = (patch: Partial<RuntimeMergeOptions> = {}): RuntimeMergeOptions => ({
  profileId: 'profile',
  source: '{}',
  globalOverrides: [],
  profileOverrides: [],
  controlled: {},
  ...patch
})

describe('Complete configuration stage ordering and fixed factory merge semantics', () => {
  it('applies a selected source patch after the shared patch and before Smart without changing the default order', async () => {
    const composed = await composeRuntimeConfiguration(
      input({
        source: 'rules: ["MATCH,REJECT"]',
        rulePatch: { prepend: ['DOMAIN,shared.test,REJECT'] },
        profileRulePatch: {
          prepend: ['1,DOMAIN,source.test,REJECT'],
          delete: ['DOMAIN,shared.test,REJECT']
        },
        profileOverrides: [{ id: 'smart', role: 'smart', kind: 'js', content: 'not-executed-here' }]
      }),
      async (_script, configuration) => {
        expect(configuration.rules).toEqual(['DOMAIN,source.test,REJECT', 'MATCH,REJECT'])
        return { configuration, logs: [] }
      }
    )
    expect(composed.order).toEqual(['profile-rules', 'smart', 'controlled-settings'])
    await expect(
      composeRuntimeConfiguration(
        input({ profileRulePatch: { prepend: ['1.5,DOMAIN,bad.test,REJECT'] } })
      )
    ).rejects.toThrow('整数')
  })
  it.each([
    [{ dns: { enable: false, nameserver: ['old'] } }, { dns: { nameserver: ['new'] } }, false],
    [{ list: ['old'] }, { '+list': ['first'], 'list+': ['last'] }, true],
    [{ map: { old: 1 }, list: ['old'] }, { 'map!': { new: 2 }, list: ['new'] }, true],
    [{ list: ['old'] }, { '<list>': ['new'], scalar: false }, true]
  ] as const)(
    'agrees with the fixed pure upstream merge for supported data: %j',
    (base, overlay, override) => {
      expect(mergeConfiguration(structuredClone(base), structuredClone(overlay), override)).toEqual(
        deepMerge(structuredClone(base), structuredClone(overlay), override)
      )
    }
  )
  it('deduplicates global/profile overrides, applies rules before Smart, and applies controlled settings last without mutating inputs', async () => {
    const global = {
      id: 'G',
      kind: 'yaml' as const,
      content: 'list+: [global]\nproxies: [{name: N, type: direct}]'
    }
    const options = input({
      source: 'list: [base]\nrules: ["MATCH,REJECT"]',
      globalOverrides: [global],
      profileOverrides: [
        global,
        { id: 'P', kind: 'yaml', content: '+list: [profile]' },
        { id: 'smart-core-override', kind: 'js', content: 'SMART' }
      ],
      rulePatch: { prepend: ['DOMAIN,example.invalid,N'] },
      controlled: { mode: 'global' }
    })
    const before = structuredClone(options)
    const composed = await composeRuntimeConfiguration(options, async (script, configuration) => {
      expect(script).toBe('SMART')
      expect(configuration.rules).toEqual(['DOMAIN,example.invalid,N', 'MATCH,REJECT'])
      return { configuration: { ...configuration, mode: 'rule' }, logs: ['private script log'] }
    })
    expect(composed.order).toEqual([
      'G',
      'P',
      'profile-rules',
      'smart-core-override',
      'controlled-settings'
    ])
    expect(composed.configuration).toMatchObject({
      list: ['profile', 'base', 'global'],
      mode: 'global'
    })
    expect(options).toEqual(before)
    expect(composed.logs).toEqual([{ id: 'smart-core-override', lines: ['private script log'] }])
  })
  it('preserves fixed rule offset, prepend/append and exact deletion behavior', async () => {
    const value = await composeRuntimeConfiguration(
      input({
        source: 'rules: ["DOMAIN,a,N", "DOMAIN,b,N", "MATCH,REJECT"]',
        rulePatch: {
          prepend: ['1,DOMAIN,p,N', 'DOMAIN,first,N'],
          append: ['1,DOMAIN,q,N', 'DOMAIN,last,N'],
          delete: ['DOMAIN,b,N']
        }
      })
    )
    expect(value.configuration.rules).toEqual([
      'DOMAIN,first,N',
      'DOMAIN,a,N',
      'DOMAIN,p,N',
      'DOMAIN,q,N',
      'MATCH,REJECT',
      'DOMAIN,last,N'
    ])
    await expect(
      composeRuntimeConfiguration(input({ rulePatch: { prepend: ['1.5,DOMAIN,a,N'] } }))
    ).rejects.toThrow('整数')
  })
  it('protects original source DNS before scripts; confirmation binds profile identity and content', async () => {
    const source = {
      dns: {
        'nameserver-policy': { '+.private.invalid': ['https://resolver.invalid/query'] },
        enable: true
      },
      hosts: { 'local.invalid': '127.0.0.1' }
    }
    const options = input({
      source: JSON.stringify(source),
      controlDns: true,
      controlSniff: false,
      controlled: {
        dns: { enable: true, nameserver: ['controlled'] },
        hosts: { replace: '1.2.3.4' },
        sniffer: { enable: true }
      }
    })
    const protectedValue = await composeRuntimeConfiguration(options)
    expect(protectedValue.dns).toMatchObject({
      requested: true,
      effective: false,
      autoDisabled: true
    })
    expect(protectedValue.configuration).toEqual(source)
    const confirmed = await composeRuntimeConfiguration({
      ...options,
      confirmedDnsFingerprint: protectedValue.dns.fingerprint
    })
    expect(confirmed.dns.effective).toBe(true)
    expect(confirmed.configuration.dns).toMatchObject({
      nameserver: ['controlled'],
      'nameserver-policy': source.dns['nameserver-policy']
    })
    expect(
      (
        await composeRuntimeConfiguration({
          ...options,
          profileId: 'other',
          confirmedDnsFingerprint: protectedValue.dns.fingerprint
        })
      ).dns.effective
    ).toBe(false)
    expect(
      (await composeRuntimeConfiguration({ ...options, disableDnsOverrideGuard: true })).dns
        .effective
    ).toBe(true)
    expect(
      protectedDnsFingerprint('id', { dns: { 'nameserver-policy': { b: [1, 2], a: 'x' } } })
    ).toBe(protectedDnsFingerprint('id', { dns: { 'nameserver-policy': { a: 'x', b: [1, 2] } } }))
    expect(
      protectedDnsFingerprint('id', { dns: { 'nameserver-policy': { b: [2, 1], a: 'x' } } })
    ).not.toBe(
      protectedDnsFingerprint('id', { dns: { 'nameserver-policy': { a: 'x', b: [1, 2] } } })
    )
  })
  it('retains protected source DNS even if an override later removes that source field', async () => {
    const result = await composeRuntimeConfiguration(
      input({
        source: 'dns: {proxy-server-nameserver: [1.1.1.1]}',
        controlDns: true,
        globalOverrides: [{ id: 'remove', kind: 'yaml', content: 'dns!: {enable: false}' }],
        controlled: { dns: { enable: true } }
      })
    )
    expect(result.dns.autoDisabled).toBe(true)
    expect(result.configuration.dns).toEqual({ enable: false })
  })
  it('filters controlled DNS, policy, sniffer, empty LAN and disabled UI using original defaults', async () => {
    const result = await composeRuntimeConfiguration(
      input({
        source: 'tun: {enable: false, dns-hijack: ["any:53"]}',
        controlled: {
          dns: { enable: true },
          hosts: { private: '1.1.1.1' },
          sniffer: { enable: true },
          'lan-allowed-ips': [],
          'external-controller': '',
          'external-ui': '/PRIVATE',
          'external-ui-url': 'https://PRIVATE.invalid',
          'external-controller-cors': { 'allow-origins': ['*'] }
        }
      })
    )
    expect(result.configuration).toEqual({
      tun: { enable: false, 'dns-hijack': [] },
      sniffer: { enable: true }
    })
    const policy = await composeRuntimeConfiguration(
      input({
        controlDns: true,
        controlled: { dns: { enable: true, 'nameserver-policy': { x: '1.1.1.1' } } }
      })
    )
    expect(policy.configuration.dns).toEqual({ enable: true })
  })
  it('adds Smart node IP exclusions only after controlled TUN merge, with deduplication and no domain resolution', async () => {
    const options = input({
      source: JSON.stringify({
        proxies: [
          { server: '127.0.0.1' },
          { server: '[::1]' },
          { server: 'resolver.invalid' },
          { server: '127.0.0.1' }
        ]
      }),
      globalOverrides: [{ id: 'S', kind: 'yaml', role: 'smart', content: '{}' }],
      controlled: { tun: { enable: true, 'route-exclude-address': ['::1/128'] } }
    })
    expect((await composeRuntimeConfiguration(options)).configuration.tun).toEqual({
      enable: true,
      'dns-hijack': [],
      'route-exclude-address': ['::1/128', '127.0.0.1/32']
    })
    expect(
      (await composeRuntimeConfiguration({ ...options, globalOverrides: [] })).configuration.tun
    ).toEqual({ enable: true, 'dns-hijack': [], 'route-exclude-address': ['::1/128'] })
  })
  it('rejects conflicting stage identities, malformed data and normalized prototype keys without exposing source text', async () => {
    await expect(
      composeRuntimeConfiguration(
        input({
          globalOverrides: [{ id: 'same', kind: 'yaml', content: '{}' }],
          profileOverrides: [{ id: 'same', kind: 'yaml', content: 'mode: global' }]
        })
      )
    ).rejects.toThrow('身份')
    for (const name of ['<constructor>', 'prototype!', '+__proto__', '<__proto__>+']) {
      expect(() =>
        mergeConfiguration(
          {},
          { [name]: name.endsWith('!') || name.startsWith('<constructor') ? {} : [] },
          true
        )
      ).toThrow('名称')
    }
    expect(() => mergeConfiguration({ dns: false }, { dns: {} })).toThrow('冲突')
    await expect(
      composeRuntimeConfiguration(
        input({ globalOverrides: [{ id: 'script', kind: 'js', content: 'PRIVATE' }] })
      )
    ).rejects.toThrow('原生工作进程')
    await expect(
      composeRuntimeConfiguration(
        input({ globalOverrides: [{ id: 'script', kind: 'js', content: '' }] }),
        async () => {
          throw new Error('script failed')
        }
      )
    ).rejects.toThrow('script failed')
  })
})
