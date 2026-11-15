import { describe, expect, it } from 'vitest'
import { localProxyConfiguration } from './local-proxy-runtime'
import { ownedCoreConfiguration } from './owned-runtime'
import {
  assertDedicatedPinnedNodeUnchanged,
  canonicalDedicatedPinnedNode,
  dedicatedPinnedNodeHash
} from './dedicated-pinned-node'

const fixed = { name: 'Fixed AI', type: 'http', server: 'fixed.invalid', port: 443, tls: true }
const ordinary = { name: 'Ordinary', type: 'http', server: 'ordinary.invalid', port: 443 }
const plan = { httpPort: 17891, socksPort: 17890, route: fixed.name }
const source = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    'allow-lan': true,
    proxies: [ordinary],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['Ordinary', 'DIRECT'] }],
    rules: ['MATCH,PROXY'],
    ...patch
  })
const compile = (text = source(), node: Record<string, unknown> = fixed) =>
  localProxyConfiguration(text, 18191, 'off', plan, undefined, [], undefined, node)

describe('fixed AI node across ordinary subscription switches', () => {
  it('compares canonical identity independently of JSON field order', () => {
    expect(dedicatedPinnedNodeHash(fixed)).toBe(
      dedicatedPinnedNodeHash({
        tls: true,
        port: 443,
        server: fixed.server,
        type: 'http',
        name: fixed.name
      })
    )
    const copy = canonicalDedicatedPinnedNode(fixed, fixed.name)
    copy.server = 'changed.invalid'
    expect(fixed.server).toBe('fixed.invalid')
  })
  it('blocks direct owned-runtime reload attempts that change only node content', () => {
    const previous = { proxies: [fixed] }
    expect(() =>
      assertDedicatedPinnedNodeUnchanged(previous, { proxies: [ordinary, fixed] }, fixed.name)
    ).not.toThrow()
    expect(() =>
      assertDedicatedPinnedNodeUnchanged(
        previous,
        { proxies: [{ ...fixed, server: 'replacement.invalid' }] },
        fixed.name
      )
    ).toThrow('内容')
    expect(() =>
      assertDedicatedPinnedNodeUnchanged(previous, { proxies: [ordinary] }, fixed.name)
    ).toThrow()
  })
  it('retains the exact fixed endpoint while replacing ordinary nodes and rules', () => {
    const text = source()
    const built = compile(text)
    const runtime = ownedCoreConfiguration(built.configuration, 'localProxy').parsed
    expect(runtime.proxies).toEqual([ordinary, fixed])
    expect(runtime.rules).toEqual(['MATCH,PROXY'])
    expect(runtime['proxy-groups']).toEqual(JSON.parse(text)['proxy-groups'])
    expect(runtime.listeners).toEqual([
      {
        name: 'relay-ai-http',
        type: 'http',
        port: 17891,
        listen: '127.0.0.1',
        proxy: fixed.name,
        udp: false
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
    expect(runtime['allow-lan']).toBe(false)
    expect(runtime['bind-address']).toBe('127.0.0.1')
    expect(JSON.parse(text).proxies).toEqual([ordinary])
    expect(fixed.server).toBe('fixed.invalid')
  })
  it('reuses an identical node without duplication when switching back', () => {
    const runtime = JSON.parse(compile(source({ proxies: [ordinary, { ...fixed }] })).configuration)
    expect(runtime.proxies).toEqual([ordinary, fixed])
  })
  it('rejects a same-name different endpoint before changing either subscription', () => {
    expect(() =>
      compile(source({ proxies: [ordinary, { ...fixed, server: 'other.invalid' }] }))
    ).toThrow('同名')
  })
  it('rejects collisions with groups and provider nodes', () => {
    expect(() =>
      compile(
        source({
          'proxy-groups': [
            { name: fixed.name, type: 'select', proxies: ['Ordinary'] },
            { name: 'PROXY', type: 'select', proxies: ['Ordinary'] }
          ]
        })
      )
    ).toThrow('同名')
    expect(() =>
      compile(source({ 'proxy-providers': { P: { type: 'inline', payload: [fixed] } } }))
    ).toThrow('同名')
  })
  it.each(['include-all', 'include-all-proxies'])(
    'keeps the injected AI node outside ordinary %s groups',
    (flag) => {
      const built = compile(
        source({
          'proxy-groups': [
            { name: 'PROXY', type: 'select', [flag]: true, filter: 'Ordinary', proxies: ['DIRECT'] }
          ]
        })
      )
      const group = JSON.parse(built.configuration)['proxy-groups'][0]
      expect(group[flag]).toBe(true)
      expect(group.proxies).toEqual(['DIRECT'])
      expect(group.filter).toBe('Ordinary')
      expect(group['exclude-filter']).toBe('(?-imsx:\\AFixed AI\\z)')
      expect(built.groups[0].members).not.toContain(fixed.name)
    }
  )
  it('preserves include-all provider membership, filters and exclusions', () => {
    const built = compile(
      source({
        'proxy-providers': {
          P: { type: 'inline', payload: [{ ...ordinary, name: 'Provider Node' }] }
        },
        'proxy-groups': [
          {
            name: 'PROXY',
            type: 'select',
            'include-all': true,
            'exclude-filter': 'skip',
            'exclude-type': 'direct'
          }
        ]
      })
    )
    const group = JSON.parse(built.configuration)['proxy-groups'][0]
    expect(group['include-all']).toBe(true)
    expect(group.proxies).toBeUndefined()
    expect(group.use).toBeUndefined()
    expect(group['exclude-filter']).toBe('(?-imsx:\\AFixed AI\\z)|skip')
    expect(group['exclude-type']).toBe('direct')
    expect(built.groups[0].members).toContain('Provider Node')
    expect(built.groups[0].members).not.toContain(fixed.name)
  })
  it.each([
    { ...fixed, type: 'direct' },
    { ...fixed, 'dialer-proxy': 'Ordinary' },
    { ...fixed, certificate: '/private/cert.pem' },
    { ...fixed, unexpected: true },
    { ...fixed, name: 'Other' }
  ])('refuses invalid or dependent pin %j', (node) => {
    expect(() => compile(source(), node)).toThrow()
  })
})
