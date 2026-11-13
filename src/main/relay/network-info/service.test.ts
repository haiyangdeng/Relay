import { describe, expect, it } from 'vitest'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import { createRuntimeInfoService, readNetworkInterfaces } from './service'
import {
  isolatedProbeConfiguration,
  isolatedProbeGroup,
  isolatedProbeTargets
} from './probe-configuration'

function state(overrides: Partial<LocalProxyState> = {}): LocalProxyState {
  return {
    phase: 'running',
    pending: false,
    owned: true,
    hasRecord: true,
    uncertain: false,
    httpPort: 17800,
    pid: 4242,
    traffic: 'listening',
    groups: [],
    systemProxyChanged: false,
    liveGuardEnabled: false,
    warnings: [],
    ...overrides
  }
}

describe('readNetworkInterfaces', () => {
  it('returns at least one non-empty interface on the host', () => {
    const ifaces = readNetworkInterfaces()
    expect(ifaces.length).toBeGreaterThan(0)
    expect(ifaces.some((i) => i.addresses.length > 0)).toBe(true)
  })
  it('only includes IPv4/IPv6 addresses and omits MAC fields', () => {
    for (const iface of readNetworkInterfaces())
      for (const addr of iface.addresses) {
        expect(['IPv4', 'IPv6']).toContain(addr.family)
        expect(Object.keys(addr).sort()).toEqual(['address', 'family', 'internal'])
      }
  })
})

describe('runtime info service', () => {
  it('reports the owned process identity and real interfaces', async () => {
    const service = createRuntimeInfoService({
      memory: async () => undefined,
      state: () => state(),
      connections: async () => ({ download: 1024, upload: 512 })
    })
    const info = await service.inspect()
    expect(info.process.pid).toBe(4242)
    expect(info.process.httpPort).toBe(17800)
    expect(info.interfaces.length).toBeGreaterThan(0)
    expect(info.traffic).toEqual({ download: 1024, upload: 512 })
  })
  it('warns when the core is running but connections cannot be read', async () => {
    const service = createRuntimeInfoService({
      memory: async () => undefined,
      state: () => state(),
      connections: async () => {
        throw new Error('unavailable')
      }
    })
    const info = await service.inspect()
    expect(info.traffic).toBeUndefined()
    expect(info.warnings.some((w) => w.includes('连接总数'))).toBe(true)
  })
  it('marks external IP lookup and remote latency probe as not wired', async () => {
    const service = createRuntimeInfoService({
      memory: async () => undefined,
      state: () => state({ phase: 'idle', pid: undefined }),
      connections: async () => undefined
    })
    const info = await service.inspect()
    expect(info.externalIpLookupWired).toBe(false)
    expect(info.remoteLatencyProbeWired).toBe(false)
  })
})

describe('independent static group delay configuration', () => {
  const builtins = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'PASS-RULE', 'COMPATIBLE']
  const profile = (members: string[], otherGroups: Record<string, unknown>[] = []): string =>
    JSON.stringify({
      proxies: [{ name: 'node', type: 'socks5', server: 'proxy.example.com', port: 1080 }],
      'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: members }, ...otherGroups],
      rules: ['MATCH,PROXY']
    })
  const compile = (text: string) =>
    isolatedProbeConfiguration(text, { kind: 'groupDelay', target: 'PROXY' }, 49152)

  it('tests only the real proxy when a static group also contains built-in outbounds', () => {
    const built = compile(profile(['node', ...builtins])),
      configuration = JSON.parse(built.configuration)
    expect(built.nodes).toEqual(['node'])
    expect(configuration.proxies.map((node: { name: string }) => node.name)).toEqual(['node'])
    expect(configuration['proxy-groups']).toEqual([
      { name: isolatedProbeGroup, type: 'select', proxies: ['REJECT'] }
    ])
    expect(configuration.rules).toEqual([`MATCH,${isolatedProbeGroup}`])
  })

  it('skips built-ins in nested groups and measures each real node only once', () => {
    const built = compile(
      profile(
        ['nested', 'node', 'DIRECT'],
        [{ name: 'nested', type: 'url-test', proxies: ['node', ...builtins] }]
      )
    )
    expect(built.nodes).toEqual(['node'])
  })

  it('projects synthetic GLOBAL to all saved static nodes without admitting built-ins or providers', () => {
    const text = JSON.stringify({
      ...JSON.parse(
        profile(
          ['nested', 'node', 'DIRECT'],
          [{ name: 'nested', type: 'select', proxies: ['node', 'REJECT'], use: ['provider'] }]
        )
      ),
      'proxy-providers': { provider: { type: 'file', path: './not-read.yaml' } }
    })
    expect(isolatedProbeTargets(text).groups).toEqual(['GLOBAL', 'PROXY', 'nested'])
    const built = isolatedProbeConfiguration(text, { kind: 'groupDelay', target: 'GLOBAL' }, 49152)
    expect(built.nodes).toEqual(['node'])
    expect(JSON.parse(built.configuration)['proxy-groups']).toEqual([
      { name: isolatedProbeGroup, type: 'select', proxies: ['REJECT'] }
    ])
  })

  it('refuses groups without any real proxy instead of falling back to DIRECT', () => {
    expect(() => compile(profile(builtins))).toThrow('1至100个静态节点')
  })

  it.each(['missing', 'GLOBAL', 'direct', 'REJECT-UNKNOWN'])(
    'keeps rejecting the unresolved member %s',
    (member) => {
      expect(() => compile(profile(['node', member]))).toThrow(/保存配置|不解析动态提供者/u)
    }
  )

  it('still rejects cyclic groups and provider-dependent groups', () => {
    expect(() => compile(profile(['node', 'DIRECT', 'PROXY']))).toThrow(/保存配置|循环/u)
    expect(() =>
      compile(
        profile(
          ['nested', 'DIRECT'],
          [{ name: 'nested', type: 'select', proxies: ['node'], use: ['provider'] }]
        )
      )
    ).toThrow(/保存配置|不解析动态提供者/u)
  })

  it('does not admit built-ins as a standalone node probe', () => {
    expect(() =>
      isolatedProbeConfiguration(
        profile(['node', 'DIRECT']),
        { kind: 'nodeDelay', target: 'DIRECT' },
        49152
      )
    ).toThrow('请选择已保存的静态节点')
  })
})

describe('explicit delay snapshots', () => {
  const text = JSON.stringify({
    'unified-delay': true,
    proxies: [{ name: 'node', type: 'socks5', server: '93.184.216.34', port: 1080 }],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['node', 'DIRECT'] }]
  })
  const delay = {
    url: 'https://www.gstatic.com/generate_204',
    timeout: 5000,
    selections: { PROXY: 'node', GLOBAL: 'PROXY' }
  }
  it('includes actual builtins and group snapshots, keeping the HTTP default rejected and 1-RTT inherited', () => {
    const built = isolatedProbeConfiguration(
      text,
      { kind: 'groupDelay', target: 'GLOBAL', delay },
      49152
    )
    expect(new Set(built.nodes)).toEqual(new Set(['node', 'PROXY', 'GLOBAL', 'DIRECT', 'REJECT']))
    expect(Object.fromEntries(built.delayTargets)).toEqual({
      node: 'node',
      PROXY: 'node',
      GLOBAL: 'node',
      DIRECT: 'DIRECT',
      REJECT: 'REJECT'
    })
    expect(built.failures.size).toBe(0)
    expect(JSON.parse(built.configuration)).toMatchObject({
      'unified-delay': true,
      'proxy-groups': [{ name: isolatedProbeGroup, type: 'select', proxies: ['REJECT'] }]
    })
  })
  it('admits explicit DIRECT-only delay without exposing a direct HTTP proxy or requiring a proxy node', () => {
    const built = isolatedProbeConfiguration(
      text,
      { kind: 'nodeDelay', target: 'DIRECT', delay },
      49152,
      { 'www.gstatic.com': '93.184.216.35' }
    )
    expect(built.runnableNodes).toEqual(['DIRECT'])
    expect(JSON.parse(built.configuration).proxies).toEqual([])
    expect(JSON.parse(built.configuration)['proxy-groups'][0].proxies).toEqual(['REJECT'])
  })
  it('never introduces DIRECT as fallback when a group snapshot is missing or invalid', () => {
    for (const selections of [{}, { PROXY: 'other' }]) {
      const built = isolatedProbeConfiguration(
        text,
        { kind: 'nodeDelay', target: 'PROXY', delay: { ...delay, selections } },
        49152
      )
      expect(built.runnableNodes).toEqual([])
      expect(built.failures.get('PROXY')).toContain('选中路径未确认')
    }
  })
  it.each(['ip', 'latency'] as const)('does not widen %s to DIRECT', (kind) => {
    expect(() => isolatedProbeConfiguration(text, { kind, target: 'DIRECT' }, 49152)).toThrow(
      '静态节点'
    )
  })
})

describe('independent delay boundaries', () => {
  const delay = {
    url: 'https://www.gstatic.com/generate_204',
    timeout: 5000,
    selections: { PROXY: 'node', DYNAMIC: 'node' }
  }
  const profile = (unified?: unknown) =>
    JSON.stringify({
      ...(unified === undefined ? {} : { 'unified-delay': unified }),
      proxies: [{ name: 'node', type: 'socks5', server: '93.184.216.34', port: 1080 }],
      'proxy-groups': [
        { name: 'PROXY', type: 'select', proxies: ['node'] },
        { name: 'DYNAMIC', type: 'select', proxies: ['node'], use: ['provider'] }
      ],
      'proxy-providers': { provider: { type: 'file', path: './not-read.yaml' } }
    })
  it('refreshes GLOBAL static nodes when a dynamic alias is unavailable, without admitting the provider', () => {
    const built = isolatedProbeConfiguration(
      profile(),
      { kind: 'groupDelay', target: 'GLOBAL', delay },
      49152
    )
    expect(built.runnableNodes).toContain('node')
    expect(built.failures.get('DYNAMIC')).toContain('动态代理组')
    expect(JSON.parse(built.configuration)['proxy-providers']).toEqual({})
  })
  it.each([undefined, false, true])(
    'inherits explicit 1-RTT %s and preserves Mihomo default when absent',
    (value) => {
      const built = isolatedProbeConfiguration(
        profile(value),
        { kind: 'nodeDelay', target: 'node', delay },
        49152
      )
      expect(JSON.parse(built.configuration)['unified-delay']).toBe(value === true)
    }
  )
  it('rejects invalid 1-RTT values instead of silently changing the metric', () => {
    expect(() =>
      isolatedProbeConfiguration(
        profile('true'),
        { kind: 'nodeDelay', target: 'node', delay },
        49152
      )
    ).toThrow('1-RTT')
  })
})
