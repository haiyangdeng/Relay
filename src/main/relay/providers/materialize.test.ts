import { describe, expect, it } from 'vitest'
import { providerHeaders } from '../subscriptions/transfer'
import {
  materializeProviders,
  parseProviderResource,
  providerDescriptors,
  resourceBinding
} from './materialize'

const node = { name: 'Node', type: 'http', server: '127.0.0.1', port: 12345, password: 'PRIVATE' }
const base = () => ({
  dns: { enable: true, nameserver: ['10.0.0.53'] },
  'proxy-providers': { P: { type: 'inline', payload: [node] } },
  'proxy-groups': [{ name: 'Group', type: 'select', use: ['P'] }],
  rules: ['MATCH,Group']
})
describe('Provider declaration inspection and static conversion', () => {
  it('recognizes all three sources without reading paths/URLs or disclosing headers through the public item', () => {
    const { descriptors } = providerDescriptors(
      JSON.stringify({
        'proxy-providers': {
          I: { type: 'inline', payload: [node] },
          F: { type: 'file', path: '/PRIVATE' },
          H: {
            type: 'http',
            url: 'https://p.invalid/PRIVATE?token=PRIVATE',
            header: { Authorization: ['Bearer PRIVATE'] },
            'size-limit': 1024
          }
        }
      })
    )
    expect(descriptors.map((d) => d.item.kind)).toEqual(['inline', 'file', 'http'])
    expect(descriptors.every((d) => d.item.canAcquire)).toBe(true)
    expect(JSON.stringify(descriptors.map((d) => d.item))).not.toContain('PRIVATE')
    expect(descriptors[2].headers).toEqual({ authorization: 'Bearer PRIVATE' })
    expect(descriptors[2].limit).toBe(1024)
  })
  it('rejects wrong payload shapes, duplicate names, root instructions and oversized inline sets', () => {
    for (const value of [
      { payload: [node] },
      { proxies: [] },
      { proxies: [node, node] },
      { proxies: [node], rules: [] },
      { proxies: [{ name: 'DIRECT', type: 'http' }] },
      { proxies: Array.from({ length: 2001 }, (_, i) => ({ ...node, name: 'N' + i })) }
    ])
      expect(() => parseProviderResource(JSON.stringify(value))).toThrow()
  })
  it('expands ordered select use into a separate static copy and preserves all unrelated top-level data', () => {
    const data = base(),
      raw = JSON.stringify(data),
      result = materializeProviders(raw, { P: JSON.stringify({ proxies: [node] }) })
    const copy = JSON.parse(result.text)
    expect(JSON.stringify(data)).toBe(raw)
    expect(copy.dns).toEqual(data.dns)
    expect(copy['proxy-providers']).toEqual({})
    expect(copy['proxy-groups']).toEqual([{ name: 'Group', type: 'select', proxies: ['Node'] }])
    expect(copy.proxies).toEqual([node])
  })
  it('retains core-native filtering, rejects unimplemented transforms and requires explicit dynamic health URLs', () => {
    const data = base(),
      resource = { P: JSON.stringify({ proxies: [node] }) }
    expect(() =>
      materializeProviders(JSON.stringify({ ...data, proxies: [node] }), resource)
    ).toThrow('冲突')
    expect(
      JSON.parse(
        materializeProviders(
          JSON.stringify({
            ...data,
            'proxy-providers': { P: { ...data['proxy-providers'].P, filter: 'Node' } }
          }),
          resource
        ).text
      )['proxy-providers'].P
    ).toMatchObject({ type: 'inline', filter: 'Node', payload: [node] })
    expect(() =>
      materializeProviders(
        JSON.stringify({
          ...data,
          'proxy-providers': { P: { ...data['proxy-providers'].P, override: { udp: true } } }
        }),
        resource
      )
    ).toThrow('变换')
    expect(() =>
      materializeProviders(
        JSON.stringify({
          ...data,
          'proxy-groups': [{ name: 'Group', type: 'url-test', use: ['P'] }]
        }),
        resource
      )
    ).toThrow('动态组')
    expect(() => materializeProviders(JSON.stringify(data), {})).toThrow('全部')
  })
  it('binds cache naming to both profile identity and source revision', () => {
    const key = resourceBinding('00000000-0000-0000-0000-000000000001', 'a'.repeat(64), 'PRIVATE')
    expect(key.length).toBeLessThanOrEqual(120)
    expect(key).not.toContain('PRIVATE')
    expect(key).not.toBe(
      resourceBinding('00000000-0000-0000-0000-000000000001', 'b'.repeat(64), 'PRIVATE')
    )
  })
  it('validates header cardinality, syntax, routing headers and byte budgets without sending anything', () => {
    expect(providerHeaders({ 'User-Agent': ['test'], Authorization: ['Bearer PRIVATE'] })).toEqual({
      'user-agent': 'test',
      authorization: 'Bearer PRIVATE'
    })
    for (const headers of [
      { Host: ['PRIVATE'] },
      { authorization: ['a', 'b'] },
      { authorization: ['a'], Authorization: ['b'] },
      { Authorization: ['PRIVATE\r\nHost: bad'] },
      { 'Accept-Encoding': ['gzip'] },
      { X: ['x'.repeat(4097)] }
    ])
      expect(() => providerHeaders(headers)).toThrow()
  })
})
