import { describe, expect, it } from 'vitest'
import {
  protocolFixtures,
  transportFixtures
} from '../../../../scripts/relay/fixtures/node-protocols'
import { compileProfileRuntime } from '../profiles/runtime'
import { inspectRuntimeConfiguration, runtimeListenerTypes, runtimeRootFields } from './schema'

describe('Complete fixed-core configuration schema without isolated field projection', () => {
  it('adds only fixed no-download controls for a typed Smart group and refuses source-controlled model downloads', () => {
    const group = {
      name: 'S',
      type: 'smart',
      proxies: ['REJECT'],
      url: 'http://127.0.0.1:1/health',
      uselightgbm: true
    }
    expect(
      inspectRuntimeConfiguration(JSON.stringify({ 'proxy-groups': [group] })).configuration
    ).toEqual({
      'proxy-groups': [group],
      'lgbm-auto-update': false,
      'lgbm-url': 'http://127.0.0.1:1/relay-model-download-disabled'
    })
    for (const extra of [
      { 'lgbm-auto-update': true },
      { 'lgbm-url': 'https://foreign.invalid' },
      { 'proxy-groups': [{ ...group, 'prefer-asn': 'true' }] },
      { 'proxy-groups': [{ ...group, uselightgbm: 'true' }] }
    ])
      expect(
        inspectRuntimeConfiguration(JSON.stringify({ 'proxy-groups': [group], ...extra }))
          .configuration
      ).toBeUndefined()
  })
  it('retains typed Smart ASN preference only in the complete configuration dependency path', () => {
    const source = JSON.stringify({
      proxies: [],
      'proxy-groups': [
        {
          name: 'SmartASN',
          type: 'smart',
          proxies: ['REJECT'],
          url: 'http://127.0.0.1:1/health',
          'prefer-asn': true
        }
      ],
      rules: ['MATCH,SmartASN']
    })
    expect(inspectRuntimeConfiguration(source).configuration?.['proxy-groups']).toMatchObject([
      { name: 'SmartASN', 'prefer-asn': true }
    ])
    expect(compileProfileRuntime(source).configuration).toBeUndefined()
  })
  it('retains port, DNS, policy, hosts, TUN, controller, NTP, listeners, sub-rules, and settings as declared', () => {
    const source = {
      port: 7890,
      'mixed-port': 7891,
      mode: 'global',
      ipv6: true,
      'allow-lan': true,
      'bind-address': '*',
      authentication: ['PRIVATE:secret'],
      'external-controller': '127.0.0.1:9090',
      secret: 'PRIVATE',
      dns: {
        enable: true,
        listen: '127.0.0.1:1053',
        'nameserver-policy': { '+.private.invalid': ['https://resolver.invalid/query#G'] },
        'proxy-server-nameserver': ['1.1.1.1']
      },
      hosts: { 'private.invalid': ['127.0.0.1', '::1'] },
      tun: { enable: true, 'auto-route': true, 'dns-hijack': ['any:53'] },
      ntp: { enable: true, 'write-to-system': true },
      'sub-rules': { private: ['MATCH,REJECT'] },
      sniffer: { enable: true, sniff: { TLS: { ports: ['443'], 'override-destination': false } } },
      listeners: [
        {
          name: 'Local',
          type: 'mixed',
          port: '18080',
          listen: '127.0.0.1',
          users: [{ username: 'PRIVATE', password: 'secret' }]
        }
      ],
      tunnels: [
        { network: ['tcp'], address: '127.0.0.1:18081', target: '127.0.0.1:18082', proxy: 'DIRECT' }
      ],
      rules: ['MATCH,REJECT']
    }
    const result = inspectRuntimeConfiguration(JSON.stringify(source))
    expect(result.issues).toEqual([])
    expect(result.configuration).toEqual(source)
  })
  it('covers the exact fixed root and listener inventory and all previously pinned node/transport fixtures', () => {
    expect(runtimeRootFields).toHaveLength(65)
    expect(runtimeListenerTypes).toHaveLength(20)
    for (const node of [
      ...protocolFixtures('-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----'),
      ...transportFixtures('-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----')
    ]) {
      expect(
        inspectRuntimeConfiguration(JSON.stringify({ proxies: [node] })).issues,
        String(node.name)
      ).toEqual([])
    }
  })
  it.each([
    { 'unknown-root': true },
    { dns: { 'unknown-dns': true } },
    { tun: { 'unknown-tun': true } },
    { 'proxy-groups': [{ name: 'G', type: 'select', 'unknown-group': true }] },
    { 'proxy-providers': { PRIVATE: { type: 'inline', 'unknown-provider': true } } },
    {
      'rule-providers': {
        PRIVATE: { type: 'inline', behavior: 'domain', 'unknown-provider': true }
      }
    },
    { listeners: [{ name: 'N', type: 'mixed', 'unknown-listener': true }] },
    {
      listeners: [
        { name: 'N', type: 'mixed', users: [{ username: 'u', password: 'p', unknown: true }] }
      ]
    },
    { 'proxy-providers': { PRIVATE: { type: 'inline', override: { 'unknown-override': true } } } },
    { proxies: [{ name: 'N', type: 'http', server: '127.0.0.1', port: 1, 'unknown-node': true }] },
    { port: '7890' },
    { ipv6: 'true' },
    { tun: { mtu: -1 } },
    { tun: { 'route-address': ['127.0.0.1/33'] } },
    { 'proxy-groups': [{ name: 'N', type: 'select', NAME: 'other' }] },
    { listeners: [{ name: 'N', type: 'mixed', 'routing-mark': 1, routing_mark: 2 }] }
  ])(
    'rejects unknown/ambiguous fields and type errors instead of silently omitting source data: %j',
    (value) => {
      const result = inspectRuntimeConfiguration(JSON.stringify(value))
      expect(result.configuration).toBeUndefined()
      expect(result.issues).toHaveLength(1)
      expect(JSON.stringify(result.issues)).not.toContain('PRIVATE')
    }
  )
  it('normalizes weak listener aliases and provider case folding but keeps map keys and header values intact', () => {
    const result = inspectRuntimeConfiguration(
      JSON.stringify({
        listeners: [{ name: 'N', type: 'mixed', routing_mark: 1 }],
        'proxy-providers': {
          Provider: {
            type: 'http',
            URL: 'https://PRIVATE.invalid',
            header: { 'X-Token': ['PRIVATE'] },
            override: {
              'additional-prefix': 'Prefix',
              'override-expr': ['.udp=true'],
              'proxy-name': [{ pattern: 'x', target: 'y' }]
            }
          }
        }
      })
    )
    expect(result.issues).toEqual([])
    expect(result.configuration).toMatchObject({
      listeners: [{ 'routing-mark': 1 }],
      'proxy-providers': {
        Provider: { url: 'https://PRIVATE.invalid', header: { 'X-Token': ['PRIVATE'] } }
      }
    })
  })
})

describe('Smart collector profile field at complete schema boundary', () => {
  it.each([1, 100, 256, 8589934591])(
    'retains exact positive safe MiB %s without adding an upstream maximum',
    (size) => {
      const input = {
        profile: { 'store-selected': true, 'smart-collector-size': size },
        rules: ['MATCH,REJECT']
      }
      expect(inspectRuntimeConfiguration(JSON.stringify(input)).configuration).toEqual(input)
    }
  )
  it.each([0, -1, 1.5, '100', null, true, 8589934592])(
    'rejects malformed or unsafe collector size %j',
    (size) => {
      expect(
        inspectRuntimeConfiguration(JSON.stringify({ profile: { 'smart-collector-size': size } }))
          .configuration
      ).toBeUndefined()
    }
  )
  it('retains strict profile keys and types beside the new field', () => {
    for (const profile of [
      { 'smart-collector-size': 4, unknown: true },
      { 'smart-collector-size': 4, 'store-selected': 'true' }
    ])
      expect(inspectRuntimeConfiguration(JSON.stringify({ profile })).configuration).toBeUndefined()
  })
})
