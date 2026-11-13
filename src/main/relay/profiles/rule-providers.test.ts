import { describe, expect, it } from 'vitest'
import { supportedInlineRuleProvider } from './rule-providers'

describe('In-memory rule provider boundary', () => {
  it('admits bounded inline domain and IPv4/IPv6 CIDR payloads without rewriting their values', () => {
    for (const value of [
      {
        type: 'inline',
        behavior: 'domain',
        payload: ['+.example.test', '*.fixture.test', 'localhost']
      },
      {
        type: 'inline',
        behavior: 'ipcidr',
        format: 'yaml',
        payload: ['127.0.0.0/8', '::1/128', '192.0.2.1/32']
      }
    ]) {
      const original = JSON.stringify(value)
      expect(supportedInlineRuleProvider(value)).toBe(true)
      expect(JSON.stringify(value)).toBe(original)
    }
  })
  it('admits only the five pure classical domain/CIDR primitives and preserves their exact payload bytes', () => {
    const value = {
      type: 'inline',
      behavior: 'classical',
      payload: [
        'DOMAIN,example.test',
        'DOMAIN-SUFFIX,example.test',
        'DOMAIN-KEYWORD,example',
        'IP-CIDR,192.0.2.0/24,no-resolve',
        'IP-CIDR6,::1/128'
      ]
    }
    const before = JSON.stringify(value)
    expect(supportedInlineRuleProvider(value)).toBe(true)
    expect(JSON.stringify(value)).toBe(before)
  })
  it.each([
    'GEOIP,CN',
    'GEOSITE,cn',
    'IP-ASN,123',
    'RULE-SET,Nested',
    'AND,((NETWORK,TCP))',
    'PROCESS-NAME,process',
    'DOMAIN-REGEX,.*',
    'DOMAIN,example.test,DIRECT',
    'IP-CIDR,127.0.0.0/8,src',
    'IP-CIDR6,127.0.0.1/32',
    'DOMAIN,https://never-requested.invalid',
    'IP-CIDR,127.0.0.0/33'
  ])('refuses dependent or out-of-scope classical entry %s', (entry) => {
    expect(
      supportedInlineRuleProvider({ type: 'inline', behavior: 'classical', payload: [entry] })
    ).toBe(false)
  })
  it.each([
    { type: 'file', behavior: 'domain', payload: ['example.test'], path: '/private/file' },
    { type: 'http', behavior: 'domain', payload: ['example.test'], url: 'https://private.invalid' },
    { type: 'inline', behavior: 'classical', payload: ['GEOIP,CN'] },
    { type: 'inline', behavior: 'domain', payload: ['example.test'], interval: 0 },
    { type: 'inline', behavior: 'domain', payload: ['example.test'], header: {} },
    { type: 'inline', behavior: 'domain', payload: ['example.test'], proxy: 'DIRECT' },
    { type: 'inline', behavior: 'domain', payload: ['example.test'], 'path-in-bundle': 'file' },
    { type: 'inline', behavior: 'domain', payload: ['example.test'], format: 'mrs' },
    { type: 'inline', behavior: 'domain', payload: ['https://private.invalid'] },
    { type: 'inline', behavior: 'domain', payload: ['bad\nname'] },
    { type: 'inline', behavior: 'domain', payload: [] },
    { type: 'inline', behavior: 'ipcidr', payload: ['127.0.0.1'] },
    { type: 'inline', behavior: 'ipcidr', payload: ['127.0.0.1/33'] },
    { type: 'inline', behavior: 'ipcidr', payload: ['::1/129'] },
    { type: 'inline', behavior: 'ipcidr', payload: ['fe80::1%en0/64'] },
    { type: 'inline', behavior: 'ipcidr', payload: ['127.0.0.0/8/extra'] },
    { type: 'inline', behavior: 'domain', payload: Array(20001).fill('example.test') },
    { type: 'inline', behavior: 'domain', payload: Array(200).fill('x'.repeat(4096)) }
  ])('refuses external material, allocation excess and invalid data (case %#)', (value) => {
    expect(supportedInlineRuleProvider(value)).toBe(false)
  })
})
