import { describe, expect, it, vi } from 'vitest'
import { parse } from '../../utils/yaml'
import { inspectProfile, PROFILE_BYTE_LIMIT } from './inspect'

export const sample = `# preserved comment
proxies:
  - {name: Node, type: vless, server: test.invalid, port: 443, uuid: PRIVATE-token, reality-opts: {short-id: 001122}}
proxy-groups:
  - {name: Select, type: select, proxies: [Node, DIRECT], use: [Remote]}
proxy-providers:
  Remote: {type: http, url: 'https://test.invalid/sub?PRIVATE-token', path: /PRIVATE/file}
rule-providers:
  Block: {type: file, path: /PRIVATE/rules}
rules: ['MATCH,Select']
dns: {enable: true, nameserver-policy: {test.invalid: 'https://test.invalid/dns'}}
tun: {enable: true}
unknown-option: {keep: true}
`
describe('Non-executing bounded profile structure inspection', () => {
  it('summarizes local nodes/groups/providers without exposing secrets or claiming engine validation', () => {
    const report = inspectProfile(sample)
    expect(report).toMatchObject({
      structure: 'passed',
      active: false,
      coreCompatibility: 'notVerified',
      summary: { proxies: 1, groups: 1, rules: 1, proxyProviders: 1, ruleProviders: 1 }
    })
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect(
      (parse(sample) as { proxies: { 'reality-opts': { 'short-id': string } }[] }).proxies[0][
        'reality-opts'
      ]['short-id']
    ).toBe('001122')
    expect(inspectProfile(JSON.stringify({ rules: ['MATCH,DIRECT'] })).structure).toBe('passed')
  })
  it.each([
    'proxies: [{name: A, type: ss}, {name: A, type: ss}]',
    'proxies: [{name: DIRECT, type: direct}]',
    'proxy-groups: [{name: G, type: select, proxies: [Missing]}]',
    'proxy-groups: [{name: G, type: select, use: [Missing]}]',
    'proxy-groups: [{name: A, type: select, proxies: [B]}, {name: B, type: select, proxies: [A]}]',
    'proxy-groups: [{name: G, type: select, proxies: [G]}]',
    'rules: [42]',
    'proxy-providers: []',
    'proxies: {}'
  ])('rejects inconsistent static structure: %s', (text) => {
    expect(inspectProfile(text).structure).toBe('rejected')
  })
  it('rejects hostile YAML shapes with controlled errors and no raw parser logging', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const value of [
        'rules: []\nrules: []',
        'key: [PRIVATE',
        'key: !PRIVATE tag',
        '!!set {PRIVATE: null}',
        '&cycle [*cycle]',
        'a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
        'x: .nan',
        'x: {__proto__: {polluted: true}}',
        '[{}]',
        '',
        'null',
        'x: ' + '['.repeat(45) + '0' + ']'.repeat(45),
        ' '.repeat(PROFILE_BYTE_LIMIT + 1)
      ]) {
        const report = inspectProfile(value)
        expect(report.structure).toBe('rejected')
        expect(JSON.stringify(report)).not.toContain('PRIVATE')
      }
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })
  it('accepts ordinary merge anchors and acyclic group dependencies', () => {
    const report = inspectProfile(`base: &base {type: select, proxies: [DIRECT]}
proxy-groups:
  - {<<: *base, name: Base}
  - {name: A, type: select, proxies: [Base]}
  - {name: B, type: select, proxies: [Base, A]}
`)
    expect(report.structure).toBe('passed')
  })
  it('bounds expanded scalar bytes as well as alias and node counts', () => {
    const source = 'a: &a "' + 'x'.repeat(800000) + '"\nb: [*a, *a, *a]\n'
    expect(Buffer.byteLength(source)).toBeLessThan(PROFILE_BYTE_LIMIT)
    expect(inspectProfile(source).structure).toBe('rejected')
  })
})
