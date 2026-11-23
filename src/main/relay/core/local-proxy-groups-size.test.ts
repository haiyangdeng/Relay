import { expect, it } from 'vitest'
import { persistentCoreConfiguration } from '../core-owner/runtime'
import { localProxyConfiguration } from './local-proxy-runtime'

function profile(groups: number, dynamic = false) {
  const nodes = Array.from({ length: 120 }, (_, index) => ({
    name: '节点-' + String(index).padStart(3, '0') + (dynamic ? 'X'.repeat(230) : '-Example'),
    type: 'http',
    server: '127.0.0.1',
    port: 9000 + index
  }))
  return JSON.stringify({
    proxies: nodes,
    'proxy-groups': Array.from({ length: groups }, (_, index) => ({
      name: 'Group ' + index,
      type: 'select',
      ...(dynamic ? { 'include-all-proxies': true } : { proxies: nodes.map((node) => node.name) })
    })),
    rules: ['MATCH,Group 0']
  })
}

it('keeps all 120 members of each of 25 groups in ordinary and persistent configurations', () => {
  const source = profile(25)
  for (const project of [localProxyConfiguration, persistentCoreConfiguration]) {
    const result = project(source, 18191)
    expect(result.groups).toHaveLength(25)
    expect(result.groups.every((group) => group.members.length === 120)).toBe(true)
    expect(result.groups[24].members.at(-1)).toBe('节点-119-Example')
  }
})

it('bounds both expanded dynamic definitions and the supported group count', () => {
  expect(() => localProxyConfiguration(profile(80, true), 18191)).toThrow('代理组展开超过2MiB')
  expect(() => localProxyConfiguration(profile(81), 18191)).toThrow('最多支持80个代理组')
})
