import { describe, expect, it } from 'vitest'
import type { LocalProxyPlan } from '../../../shared/relay/local-proxy-plan'
import { mergeConfiguration } from '../configuration/merge'
import { tunLocalPlanProjection } from './local-plan-projection'

const fixed = { name: 'Fixed AI', type: 'http', server: 'fixed.invalid', port: 443, tls: true }
const ordinary = { name: 'Ordinary', type: 'http', server: 'ordinary.invalid', port: 443 }
const plan: LocalProxyPlan = {
  httpPort: 7892,
  resolverMode: 'profile',
  ports: { http: 7892, socks: 7891, mixed: 7890, redir: 0 },
  dedicated: { route: fixed.name, httpPort: 17891, socksPort: 17890 }
}
const source = () => ({
  port: 18191,
  proxies: [ordinary, fixed],
  'proxy-groups': [{ name: 'Group', type: 'select', proxies: [ordinary.name, 'DIRECT'] }],
  listeners: [{ name: 'Old AI', type: 'socks', port: 17890, proxy: fixed.name }],
  rules: ['MATCH,Group'],
  tun: { enable: true, stack: 'mixed', 'auto-route': true },
  dns: { enable: true, nameserver: ['1.1.1.1'] }
})

describe('TUN handoff local entry points', () => {
  it('keeps ordinary and dedicated ports together without changing TUN or DNS settings', () => {
    const original = source(),
      before = structuredClone(original),
      controlled = tunLocalPlanProjection(original, plan),
      projected = mergeConfiguration(original, controlled)
    expect(projected).toMatchObject({
      port: 7892,
      'socks-port': 7891,
      'mixed-port': 7890,
      'redir-port': 0,
      'tproxy-port': 0,
      'allow-lan': false,
      'bind-address': '127.0.0.1',
      tun: before.tun,
      dns: before.dns,
      rules: before.rules
    })
    expect(projected.listeners).toEqual([
      {
        name: 'relay-ai-http',
        type: 'http',
        port: 17891,
        listen: '127.0.0.1',
        proxy: fixed.name
      },
      {
        name: 'relay-ai-socks',
        type: 'socks',
        port: 17890,
        listen: '127.0.0.1',
        proxy: fixed.name,
        udp: false
      }
    ])
    expect(projected.proxies).toEqual(before.proxies)
    expect(original).toEqual(before)
  })

  it('preserves composed nodes and excludes an appended private pin from include-all groups', () => {
    const composed = {
        proxies: [{ ...ordinary, server: 'overridden.invalid' }],
        'proxy-groups': [{ name: 'Group', type: 'select', 'include-all-proxies': true }]
      },
      before = structuredClone(composed),
      projected = tunLocalPlanProjection(composed, plan, fixed)
    expect(projected.proxies).toEqual([...before.proxies, fixed])
    expect(projected['proxy-groups']).toEqual([
      { ...before['proxy-groups'][0], 'exclude-filter': '(?-imsx:\\AFixed AI\\z)' }
    ])
    expect(composed).toEqual(before)
  })

  it('rejects a changed fixed endpoint and overlapping ports before handoff', () => {
    const changed = { ...source(), proxies: [ordinary, { ...fixed, server: 'other.invalid' }] }
    expect(() => tunLocalPlanProjection(changed, plan, fixed)).toThrow('同名')
    expect(() =>
      tunLocalPlanProjection(source(), {
        ...plan,
        dedicated: { route: fixed.name, httpPort: 7892 }
      })
    ).toThrow('重复')
  })

  it('carries a confirmed selector choice through the upstream default-selected option', () => {
    const original = source(),
      projected = tunLocalPlanProjection(original, plan, undefined, [
        { name: 'Group', type: 'select', now: 'DIRECT', confirmed: true }
      ])
    expect(projected['proxy-groups']).toEqual([
      { ...original['proxy-groups'][0], 'default-selected': 'DIRECT' }
    ])
    expect(original['proxy-groups'][0]).not.toHaveProperty('default-selected')
    expect(() =>
      tunLocalPlanProjection(original, plan, undefined, [
        { name: 'Removed group', type: 'select', now: 'DIRECT', confirmed: true }
      ])
    ).toThrow('未切换')
  })

  it('pins the cold selection in the checked TUN configuration before forwarding starts', () => {
    const original = source()
    const projected = tunLocalPlanProjection(
      original,
      plan,
      undefined,
      [],
      new Map([['Group', 'DIRECT']])
    )
    expect(projected['proxy-groups']).toEqual([
      { ...original['proxy-groups'][0], 'default-selected': 'DIRECT' }
    ])
    expect(original['proxy-groups'][0]).not.toHaveProperty('default-selected')
  })

  it('keeps automatic or unconfirmed group choices under the original group policy', () => {
    const original = source()
    expect(
      tunLocalPlanProjection(original, plan, undefined, [
        { name: 'Group', type: 'select', now: 'DIRECT', confirmed: false },
        { name: 'Automatic', type: 'url-test', now: ordinary.name, confirmed: true }
      ])['proxy-groups']
    ).toEqual(original['proxy-groups'])
  })

  it('retains the implicit GLOBAL choice and member order using a native explicit selector', () => {
    const original = source(),
      members = ['DIRECT', 'REJECT', ordinary.name, fixed.name, 'Group'],
      selection = {
        name: 'GLOBAL',
        type: 'select' as const,
        now: ordinary.name,
        confirmed: true,
        members
      },
      projected = tunLocalPlanProjection(original, plan, undefined, [selection])
    expect(projected['proxy-groups']).toEqual([
      ...original['proxy-groups'],
      { name: 'GLOBAL', type: 'select', proxies: members, 'default-selected': ordinary.name }
    ])
    expect(original['proxy-groups']).toHaveLength(1)
    expect(() =>
      tunLocalPlanProjection(original, plan, undefined, [{ ...selection, members: ['DIRECT'] }])
    ).toThrow('未完整确认')
  })

  it('keeps mixed-only startup plans and does not activate source-only listeners', () => {
    const projected = tunLocalPlanProjection(source(), {
      httpPort: 7890,
      resolverMode: 'off',
      ports: { http: 0, socks: 7891, mixed: 7890, redir: 0 }
    })
    expect(projected).toMatchObject({ port: 0, 'mixed-port': 7890, listeners: [] })
    expect(projected.proxies).toEqual(source().proxies)
    expect(projected).not.toHaveProperty('dns')
    expect(projected).not.toHaveProperty('tun')
  })
})
