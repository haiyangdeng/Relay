import { describe, expect, it } from 'vitest'
import { canSelectCachedGroupMember } from '../../../shared/relay/profiles'
import { localProxyConfiguration } from '../core/local-proxy-runtime'
import { compileProfileRuntime } from './runtime'

const node = { name: 'Node', type: 'http', server: '127.0.0.1', port: 12345 }
const base = { proxies: [node], rules: ['MATCH,Group'] }
const build = (group: Record<string, unknown>) =>
  compileProfileRuntime(JSON.stringify({ ...base, 'proxy-groups': [{ name: 'Group', ...group }] }))
describe('Pinned dynamic groups and provider compilation boundary', () => {
  it('allows only known declared members in unambiguous selectable offline groups', () => {
    const group = (name: string, type: string) => ({
      name,
      type,
      proxies: ['A', 'provider-only', name]
    })
    const snapshot = {
      targets: ['A', 'B', 'select'],
      groups: [
        ...['select', 'url-test', 'fallback', 'smart', 'load-balance'].map((type) =>
          group(type, type)
        ),
        { ...group('filtered', 'select'), 'exclude-filter': 'A' },
        group('duplicate', 'select'),
        group('duplicate', 'select'),
        { name: 'external', type: 'select', use: ['provider'] }
      ]
    }
    for (const type of ['select', 'url-test', 'fallback', 'smart'])
      expect(canSelectCachedGroupMember(snapshot, type, 'A')).toBe(true)
    for (const name of ['load-balance', 'filtered', 'duplicate', 'external', 'missing'])
      expect(canSelectCachedGroupMember(snapshot, name, 'A')).toBe(false)
    for (const name of ['B', 'provider-only', 'select'])
      expect(canSelectCachedGroupMember(snapshot, 'select', name)).toBe(false)
    expect(canSelectCachedGroupMember({ ...snapshot, targets: ['B'] }, 'select', 'A')).toBe(false)
  })
  it('retains controlled Smart settings and replaces implicit model updates with fixed local controls', () => {
    const result = build({
      type: 'smart',
      proxies: ['Node'],
      url: 'http://127.0.0.1:1/probe',
      uselightgbm: true,
      collectdata: false,
      'prefer-asn': false,
      'sample-rate': 0.5,
      tolerance: 10,
      'policy-priority': ''
    })
    expect(result.issues).toEqual([])
    expect(JSON.parse(result.configuration ?? '{}')).toMatchObject({
      'lgbm-auto-update': false,
      'lgbm-url': 'http://127.0.0.1:1/relay-model-download-disabled',
      'proxy-groups': [{ type: 'smart', uselightgbm: true, collectdata: false, 'sample-rate': 0.5 }]
    })
    expect(
      localProxyConfiguration(
        JSON.stringify({
          ...base,
          'proxy-groups': [
            {
              name: 'Group',
              type: 'smart',
              proxies: ['Node'],
              url: 'http://127.0.0.1:1/probe',
              uselightgbm: true
            }
          ]
        }),
        18191
      ).groups[0]
    ).toMatchObject({ type: 'smart', selectable: true })
  })
  it.each([
    { 'prefer-asn': true },
    { uselightgbm: 'true' },
    { collectdata: 1 },
    { 'sample-rate': 0 },
    { 'sample-rate': 1.1 },
    { tolerance: 65536 },
    { 'policy-priority': {} },
    { 'model-path': '/PRIVATE/model' }
  ])('blocks unsupported or mistyped Smart settings: %j', (extra) => {
    expect(
      build({ type: 'smart', proxies: ['Node'], url: 'http://127.0.0.1:1/probe', ...extra })
        .configuration
    ).toBeUndefined()
  })
  it.each(['select', 'url-test', 'fallback', 'load-balance'])(
    'retains %s fields without converting core regexes',
    (type) => {
      const group = {
        type,
        proxies: ['Node'],
        url: 'https://example.invalid',
        interval: 300,
        timeout: 5000,
        lazy: true,
        'max-failed-times': 3,
        'exclude-filter': '(?<=blocked)-suffix',
        'empty-fallback': 'REJECT',
        'expected-status': '200/204',
        'disable-udp': true
      }
      const result = build(group)
      expect(result.issues).toEqual([])
      expect(JSON.parse(result.configuration ?? '{}')['proxy-groups'][0]).toEqual({
        name: 'Group',
        ...group
      })
    }
  )
  it.each([
    { type: 'url-test', proxies: ['Node'] },
    { type: 'select', proxies: ['Node'], interval: 1 },
    { type: 'fallback', proxies: ['Node'], url: 'file:///PRIVATE' },
    { type: 'url-test', proxies: ['Node'], url: 'https://user:PRIVATE@example.invalid' },
    {
      type: 'load-balance',
      proxies: ['Node'],
      url: 'https://example.invalid',
      strategy: 'unknown'
    },
    { type: 'select', proxies: ['Node'], filter: { bad: true } },
    { type: 'url-test', proxies: ['Node'], url: 'http://example.invalid', timeout: -1 },
    { type: 'select', proxies: ['Node'], 'interface-name': 'en0' },
    { type: 'relay', proxies: ['Node'] }
  ])('blocks implicit requests and unsupported fields: %j', (group) => {
    const result = build(group)
    expect(result.configuration).toBeUndefined()
    expect(JSON.stringify(result.issues)).not.toContain('PRIVATE')
  })
  it('retains provider filtering and explicit inherited health targets without acquiring an external source', () => {
    const source = JSON.stringify({
      'proxy-providers': {
        P: {
          type: 'inline',
          payload: [node],
          filter: 'Node',
          'health-check': { enable: true, url: 'http://fixture.invalid', interval: 300 }
        }
      },
      'proxy-groups': [{ name: 'Group', type: 'url-test', 'include-all-providers': true }],
      rules: ['MATCH,Group']
    })
    expect(compileProfileRuntime(source).configuration).toBeDefined()
    const group = localProxyConfiguration(source, 18191).groups[0]
    expect(group).toMatchObject({
      type: 'url-test',
      dynamic: true,
      providers: ['P'],
      testURL: 'http://fixture.invalid',
      emptyFallback: 'COMPATIBLE'
    })
    expect(group.members).toEqual(['Node', 'COMPATIBLE'])
  })
  it('rejects provider collisions, missing explicit target and unsupported override without mutation', () => {
    for (const extra of [
      { payload: [node, node] },
      { payload: [node], override: { udp: true } },
      { payload: [node], 'health-check': { enable: true } }
    ]) {
      const source = JSON.stringify({
        'proxy-providers': { P: { type: 'inline', ...extra } },
        'proxy-groups': [{ name: 'Group', type: 'select', use: ['P'] }],
        rules: ['MATCH,Group']
      })
      expect(compileProfileRuntime(source).configuration).toBeUndefined()
    }
  })
})
