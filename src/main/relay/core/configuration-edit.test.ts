import { describe, expect, it } from 'vitest'
import { localProxyConfiguration } from './local-proxy-runtime'
import { ownedCoreConfiguration } from './owned-runtime'

const source = JSON.stringify({
  proxies: [{ name: 'A', type: 'http', server: '127.0.0.1', port: 1 }],
  'proxy-groups': [{ name: 'G', type: 'select', proxies: ['A'] }],
  rules: ['MATCH,G'],
  sniffer: { enable: true, sniff: { TLS: { ports: ['443'] } } }
})

describe('Sniffer edits in the owned runtime', () => {
  it('passes exact sniffer settings through the HTTP compiler and controlled boundary', () => {
    const built = localProxyConfiguration(source, 18191)
    const admitted = ownedCoreConfiguration(built.configuration, 'localProxy')
    expect(admitted.parsed.sniffer).toEqual(JSON.parse(source).sniffer)
    expect(admitted.parsed.tun).toEqual({ enable: false })
    expect(admitted.parsed['external-controller']).toBe('')
  })
  it('refuses malformed or unknown sniffer settings before spawning a child', () => {
    for (const sniffer of [{ enable: 'true' }, { unknown: true }])
      expect(() =>
        localProxyConfiguration(JSON.stringify({ ...JSON.parse(source), sniffer }), 18191)
      ).toThrow()
    const parsed = JSON.parse(localProxyConfiguration(source, 18191).configuration)
    parsed.sniffer.sniff.TLS.ports = [443]
    expect(() => ownedCoreConfiguration(JSON.stringify(parsed), 'localProxy')).toThrow()
  })
  it('admits only compiler-verified in-memory rule sets at the final owned HTTP boundary', () => {
    const input = {
      ...JSON.parse(source),
      'rule-providers': {
        Inline: { type: 'inline', behavior: 'ipcidr', payload: ['127.0.0.0/8'] }
      },
      rules: ['RULE-SET,Inline,G,no-resolve', 'MATCH,REJECT']
    }
    const built = localProxyConfiguration(JSON.stringify(input), 18191)
    expect(
      ownedCoreConfiguration(built.configuration, 'localProxy').parsed['rule-providers']
    ).toEqual(input['rule-providers'])
    for (const changed of [
      { path: '/private/not-read' },
      { url: 'https://private.invalid' },
      { type: 'file' },
      { behavior: 'classical', payload: ['GEOIP,CN'] }
    ]) {
      const raw = JSON.parse(built.configuration)
      Object.assign(raw['rule-providers'].Inline, changed)
      expect(() => ownedCoreConfiguration(JSON.stringify(raw), 'localProxy')).toThrow()
    }
    expect(() => ownedCoreConfiguration(built.configuration, 'inert')).toThrow()
  })
})
