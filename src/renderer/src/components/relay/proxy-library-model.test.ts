import { describe, expect, it } from 'vitest'
import type { RelayProfileGroups, RelayStoredProfile } from '../../../../shared/relay/profiles'
import type { SubscriptionSourceInfo } from '../../../../shared/relay/subscription-sources'
import { cachedProxyGroups, preferredCachedProfile } from './proxy-library-model'

const profile = (id: string): RelayStoredProfile => ({
  id,
  name: id,
  sha256: id.repeat(64),
  createdAt: '2026-11-09T00:00:00Z',
  summary: { proxies: 1, groups: 1, rules: 0, proxyProviders: 0, ruleProviders: 0 }
})
const snapshot = (
  groups: Record<string, unknown>[],
  targets = ['US', 'JP']
): RelayProfileGroups => ({
  profile: profile('a'),
  groups,
  targets,
  providers: ['subscription']
})
const source = (
  current: RelayStoredProfile,
  createdAt: string
): Pick<SubscriptionSourceInfo, 'createdAt' | 'versions'> => ({
  createdAt,
  versions: [
    {
      id: 'version',
      createdAt,
      action: 'update',
      profile: { id: current.id, sha256: current.sha256 }
    }
  ]
})

describe('cached proxy library', () => {
  it('keeps every explicit member of larger subscriptions without runtime claims or secrets', () => {
    const nodes = Array.from({ length: 140 }, (_, index) => `Node ${index}`)
    const result = cachedProxyGroups(
      snapshot(
        [
          {
            name: 'PROXY',
            type: 'select',
            proxies: [...nodes, 'AUTO', 'DIRECT', 'Missing'],
            password: 'private-password',
            url: 'https://secret.invalid/token',
            now: 'Node 0',
            alive: true,
            history: [{ delay: 10 }]
          },
          { name: 'AUTO', type: 'url-test', proxies: nodes }
        ],
        [...nodes, 'AUTO', 'PROXY', 'DIRECT']
      )
    )
    expect(result[0].members).toHaveLength(143)
    expect(result[0].totalMembers).toBe(143)
    expect(result[0].members.at(-4)).toEqual({ name: 'Node 139', kind: 'node' })
    expect(result[0].members.slice(-3)).toEqual([
      { name: 'AUTO', kind: 'group' },
      { name: 'DIRECT', kind: 'builtin' },
      { name: 'Missing', kind: 'unknown' }
    ])
    expect(result[1].members).toHaveLength(140)
    expect(result[1].typeLabel).toBe('自动测速')
    expect(result[0]).not.toHaveProperty('now')
    expect(result[0]).not.toHaveProperty('alive')
    expect(result[0]).not.toHaveProperty('history')
    expect(JSON.stringify(result)).not.toMatch(/private-password|secret\.invalid|delay/)
  })

  it('does not expand dynamic providers or evaluate Go regular expressions as JavaScript', () => {
    const result = cachedProxyGroups(
      snapshot([
        {
          name: 'DYNAMIC',
          type: 'fallback',
          proxies: ['US'],
          use: ['subscription'],
          'include-all-proxies': true,
          filter: '(?i)us',
          'exclude-filter': 'secret-pattern'
        }
      ])
    )[0]
    expect(result.members).toEqual([{ name: 'US', kind: 'node' }])
    expect(result.providers).toEqual(['subscription'])
    expect(result.unresolved).toBe(true)
    expect(result.unresolvedReasons).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('secret-pattern')
  })

  it('searches names without changing member totals or hiding matching group contents', () => {
    const input = snapshot([
      { name: 'Proxy', type: 'select', proxies: ['US', 'JP'] },
      { name: 'Hidden', type: 'select', hidden: true, proxies: ['US'] }
    ])
    const before = JSON.stringify(input)
    const byMember = cachedProxyGroups(input, { search: ' us ' })
    expect(byMember).toHaveLength(1)
    expect(byMember[0].members).toEqual([{ name: 'US', kind: 'node' }])
    expect(byMember[0].totalMembers).toBe(2)
    expect(cachedProxyGroups(input, { search: 'pRoXy' })[0].members).toHaveLength(2)
    expect(cachedProxyGroups(input, { search: 'us', showHidden: true })).toHaveLength(2)
    expect(cachedProxyGroups(input, { search: 'nothing' })).toEqual([])
    expect(JSON.stringify(input)).toBe(before)
  })

  it('does not mistake inherited property names for builtin labels or groups', () => {
    const result = cachedProxyGroups(
      snapshot([{ name: 'constructor', type: 'constructor', proxies: ['toString'] }], ['toString'])
    )[0]
    expect(result.typeLabel).toBe('其他代理组')
    expect(result.members).toEqual([{ name: 'toString', kind: 'node' }])
  })

  it('reports malformed declarations without serializing arbitrary objects', () => {
    const result = cachedProxyGroups(
      snapshot([
        { type: 'select', proxies: ['US'] },
        { name: 'PROXY', type: 'select', proxies: ['US', { password: 'secret' }], use: 123 }
      ])
    )
    expect(result).toHaveLength(1)
    expect(result[0].members).toEqual([{ name: 'US', kind: 'node' }])
    expect(result[0].unresolved).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})

describe('preferred cached profile', () => {
  const a = profile('a'),
    b = profile('b'),
    c = profile('c')
  const profiles = [a, b, c]
  const sources = [source(b, '2026-11-08T00:00:00Z'), source(c, '2026-11-09T00:00:00Z')]

  it('honors an explicit browse target, then the actual selection, without mutating either list', () => {
    const before = JSON.stringify({ profiles, sources })
    expect(
      preferredCachedProfile({ queryId: a.id, currentSelection: b.id, sources, profiles })
    ).toBe(a)
    expect(
      preferredCachedProfile({ queryId: 'missing', currentSelection: b.id, sources, profiles })
    ).toBe(b)
    expect(preferredCachedProfile({ sources, profiles })).toBe(a)
    expect(JSON.stringify({ profiles, sources })).toBe(before)
  })

  it('prefers the newest local configuration, and validates remote digests when no locals exist', () => {
    const invalid = source({ ...c, sha256: 'changed' }, '2026-11-10T00:00:00Z')
    expect(preferredCachedProfile({ sources: [sources[0], invalid], profiles })).toBe(a)
    expect(preferredCachedProfile({ sources: [sources[0], invalid], profiles: [b, c] })).toBe(b)
    expect(preferredCachedProfile({ sources: [invalid], profiles })).toBe(a)
    const newer = { ...a, id: 'new-local', createdAt: '2026-11-10T00:00:00Z' }
    expect(preferredCachedProfile({ sources, profiles: [...profiles, newer] })).toBe(newer)
  })

  it('uses only the latest version and tolerates empty sources or empty libraries', () => {
    const history = source(c, '2026-11-10T00:00:00Z')
    history.versions.push({
      id: 'new-version',
      createdAt: history.createdAt,
      action: 'restore',
      profile: { id: 'missing', sha256: 'missing' }
    })
    expect(preferredCachedProfile({ sources: [history], profiles })).toBe(a)
    expect(preferredCachedProfile({ sources: [{ createdAt: '', versions: [] }], profiles })).toBe(a)
    expect(preferredCachedProfile({ sources, profiles: [] })).toBeUndefined()
  })
})
