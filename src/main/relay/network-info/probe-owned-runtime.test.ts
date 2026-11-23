import type { EventEmitter } from 'events'
import { spawn, execFile } from 'child_process'
import { rm } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeDelayURL, type IsolatedProbeDelay } from '../../../shared/relay/isolated-probes'
import { startOwnedCore } from '../core/owned-runtime'
import { isolatedProbeConfiguration } from './probe-configuration'
import { startIsolatedProbe } from './probe-runtime'
import { createIsolatedProbes } from './probes'

// Keep both production launch layers real. Only OS/process/network edges are
// simulated, so a disagreement between probe construction and core admission
// fails before the synthetic core can return a latency.
const f = vi.hoisted(() => ({
  port: 18192,
  directory: '/f/Library/Application Support/Relay-Preview/Diagnostics/Probe/p-test',
  resolve4: vi.fn(),
  cancelDNS: vi.fn(),
  child: undefined as EventEmitter | undefined,
  configuration: undefined as Record<string, unknown> | undefined,
  requests: [] as { method: string; path: string }[],
  failure: false,
  holdDelay: false,
  activeDelays: 0,
  maximumDelays: 0,
  releaseDelays: [] as (() => void)[],
  release: vi.fn(),
  stop: vi.fn(),
  cleanup: undefined as (() => Promise<void>) | undefined
}))
vi.mock('dns/promises', () => ({
  Resolver: class {
    resolve4 = f.resolve4
    cancel = f.cancelDNS
  }
}))
vi.mock('net', async (original) => {
  const { EventEmitter } = await import('events')
  return {
    ...(await original<typeof import('net')>()),
    createServer: vi.fn(() => {
      const server = Object.assign(new EventEmitter(), {
        listen: (_options: unknown, callback: () => void) => queueMicrotask(callback),
        address: () => ({ address: '127.0.0.1', family: 'IPv4', port: f.port }),
        close: (callback?: (error?: Error) => void) => callback?.()
      })
      return server
    })
  }
})
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  networkInterfaces: () => ({})
}))
vi.mock('../core/resources', () => ({
  verifyCoreResource: vi.fn(async () => ({
    executable: '/fixture/never-executed-core',
    version: 'v1.19.33',
    architecture: 'arm64',
    sha256: 'a'.repeat(64)
  }))
}))
vi.mock('../core/port', async (original) => ({
  ...(await original<typeof import('../core/port')>()),
  probeLocalPort: vi.fn(async () => true),
  ownsHttpListener: vi.fn(async () => true)
}))
vi.mock('../core/probe-owners', () => ({
  inspectProbeWorkspaces: vi.fn(async () => ({ status: 'clear' })),
  registerHeldProbeWorkspace: vi.fn(() => f.release),
  writeProbeOwner: vi.fn(async () => {})
}))
vi.mock('../core/smart-runtime', () => ({
  checkSmartConfiguration: vi.fn(() => false),
  stageSmartRuntimeModel: vi.fn(async () => undefined),
  verifySmartRuntimeModel: vi.fn(async () => {})
}))
vi.mock('../core/shutdown', () => ({
  stopOwnedChild: f.stop
}))
vi.mock('../../resolve/plugin/http-client', () => ({
  requestOnce: vi.fn(async () => {
    throw new Error('Node delay must use the actual owned testDelay API')
  })
}))
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events')
  return {
    execFile: vi.fn(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => callback(null, '', '')
    ),
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: 1234,
        stdout: new EventEmitter(),
        stderr: new EventEmitter()
      })
      f.child = child
      return child
    })
  }
})
vi.mock('fs/promises', async (original) => ({
  ...(await original<typeof import('fs/promises')>()),
  mkdtemp: vi.fn(async () => f.directory),
  realpath: vi.fn(async (path: string) => path),
  writeFile: vi.fn(async (path: string, data: string) => {
    if (!path.endsWith('/config.yaml')) throw new Error('Unexpected fixture write')
    f.configuration = JSON.parse(data)
  }),
  rm: vi.fn(async () => {}),
  lstat: vi.fn(async (path: string) => ({
    dev: 1,
    ino: path.endsWith('/api.sock') ? 2 : 1,
    mode: 0o40700,
    uid: process.getuid?.(),
    isDirectory: () => !path.endsWith('/api.sock'),
    isSocket: () => path.endsWith('/api.sock'),
    isSymbolicLink: () => false
  }))
}))
vi.mock('http', async () => {
  const { EventEmitter } = await import('events')
  return {
    request: vi.fn(
      (
        options: { method: string; path: string },
        callback: (response: EventEmitter & { statusCode: number }) => void
      ) => {
        f.requests.push({ method: options.method, path: options.path })
        const req = Object.assign(new EventEmitter(), {
          setTimeout: () => req,
          destroy: (error: Error) => {
            queueMicrotask(() => {
              req.emit('error', error)
              req.emit('close')
            })
            return req
          },
          end: () => {
            const testing = /^\/proxies\/[^/]+\/delay\?/u.test(options.path)
            if (testing) {
              ++f.activeDelays
              f.maximumDelays = Math.max(f.maximumDelays, f.activeDelays)
            }
            const respond = () =>
              queueMicrotask(() => {
                const response = Object.assign(new EventEmitter(), {
                  statusCode: testing && f.failure ? 504 : 200
                })
                callback(response)
                queueMicrotask(() => {
                  response.emit(
                    'data',
                    Buffer.from(
                      JSON.stringify(
                        options.path === '/version'
                          ? { version: 'v1.19.33' }
                          : options.path === '/configs'
                            ? f.configuration
                            : testing
                              ? { delay: 178 }
                              : { unexpected: true }
                      )
                    )
                  )
                  if (testing) --f.activeDelays
                  response.emit('end')
                  req.emit('close')
                })
              })
            if (testing && f.holdDelay) f.releaseDelays.push(respond)
            else respond()
          }
        })
        return req
      }
    )
  }
})
const context = { home: '/f', stateRoot: '/f/Library/Application Support/Relay-Preview' }
const request = {
  profile: { id: '11111111-1111-4111-8111-111111111111', sha256: 'b'.repeat(64) },
  kind: 'nodeDelay' as const,
  target: 'node',
  provider: 'ip.sb' as const
}
const source = (server: string, node: Record<string, unknown> = {}) =>
  JSON.stringify({
    proxies: [{ name: 'node', type: 'socks5', server, port: 1080, ...node }],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['node', 'DIRECT'] }]
  })
const start = (server: string, node: Record<string, unknown> = {}) =>
  startIsolatedProbe({
    context,
    resourceRoot: '/fixture/resources',
    text: source(server, node),
    request,
    signal: new AbortController().signal,
    assertCurrent: () => {},
    registerCleanup: (cleanup) => {
      f.cleanup = cleanup
    }
  })

beforeEach(() => {
  vi.clearAllMocks()
  f.configuration = undefined
  f.child = undefined
  f.cleanup = undefined
  f.failure = false
  f.holdDelay = false
  f.activeDelays = 0
  f.maximumDelays = 0
  f.releaseDelays.length = 0
  f.requests.length = 0
  f.stop.mockImplementation(async () => {
    if (f.activeDelays) throw new Error('Cleanup raced unfinished delay requests')
    f.child?.emit('close', 0)
  })
  f.resolve4.mockImplementation(async (host: string) => {
    if (host !== 'proxy.example.com') throw new Error('Unexpected DNS request')
    return ['93.184.216.35']
  })
})
afterEach(async () => {
  await f.cleanup?.()
})

describe('Actual isolated probe and owned-core launch integration with synthetic OS edges', () => {
  it.each([
    {
      type: 'ss',
      cipher: 'aes-128-gcm',
      password: 'fixture',
      plugin: 'obfs',
      'plugin-opts': { mode: 'http', host: 'header.example.com' }
    },
    {
      type: 'ss',
      cipher: 'aes-128-gcm',
      password: 'fixture',
      plugin: 'obfs',
      'plugin-opts': { mode: 'tls', host: 'header.example.com' }
    },
    { type: 'mieru', username: 'fixture', password: 'fixture', transport: 'TCP' },
    { type: 'mieru', username: 'fixture', password: 'fixture', transport: 'UDP' }
  ])(
    'reuses the fixed built-in $type transport through the same admitted proxy server',
    async (node) => {
      const runtime = await start('proxy.example.com', node)
      expect(await runtime.delay('node', probeDelayURL)).toBe(178)
      expect(f.resolve4).toHaveBeenCalledExactlyOnceWith('proxy.example.com')
      expect(f.configuration?.hosts).toEqual({ 'proxy.example.com': '93.184.216.35' })
      expect(f.configuration?.proxies).toEqual([expect.objectContaining(node)])
      expect(spawn).toHaveBeenCalledOnce()
    }
  )
  it.each(['DIRECT', 'REJECT', 'PROXY'])(
    'runs explicit %s through actual core admission and the single-outbound endpoint',
    async (target) => {
      f.resolve4.mockResolvedValue(['93.184.216.35'])
      const delay = { url: probeDelayURL, timeout: 7000, selections: { PROXY: 'node' } }
      const runtime = await startIsolatedProbe({
        context,
        resourceRoot: '/fixture/resources',
        text: JSON.stringify({ ...JSON.parse(source('93.184.216.34')), 'unified-delay': true }),
        request: { ...request, target, delay },
        signal: new AbortController().signal,
        assertCurrent: () => {},
        registerCleanup: (cleanup) => {
          f.cleanup = cleanup
        }
      })
      expect(f.configuration?.['unified-delay']).toBe(true)
      expect(f.configuration?.['proxy-groups']).toEqual([
        { name: '__RELAY_ISOLATED_PROBE__', type: 'select', proxies: ['REJECT'] }
      ])
      expect(await runtime.delay(target, delay.url)).toBe(178)
      const actual = target === 'PROXY' ? 'node' : target
      const tests = f.requests.filter((item) => item.path.startsWith(`/proxies/${actual}/delay?`))
      expect(tests).toHaveLength(1)
      expect(new URL(tests[0].path, 'http://fixture.invalid').searchParams.get('timeout')).toBe(
        '7000'
      )
      expect(f.requests.every((item) => item.method === 'GET')).toBe(true)
      if (target === 'DIRECT')
        expect(f.configuration?.hosts).toEqual({ 'www.gstatic.com': '93.184.216.35' })
      await runtime.close()
      expect(f.stop).toHaveBeenCalledOnce()
    }
  )
  it('does not widen the built-in obfs exception to unreviewed plugins or modes', () => {
    for (const [plugin, mode] of [
      ['v2ray-plugin', 'websocket'],
      ['obfs', 'unexpected']
    ]) {
      expect(() =>
        isolatedProbeConfiguration(
          source('93.184.216.34', {
            type: 'ss',
            cipher: 'aes-128-gcm',
            password: 'fixture',
            plugin,
            'plugin-opts': { mode }
          }),
          request,
          f.port
        )
      ).toThrow('插件或额外端点')
    }
    expect(spawn).not.toHaveBeenCalled()
  })
  it('rejects explicitly IPv6-only resolution before URLTest instead of claiming a timeout', () => {
    for (const [server, node] of [
      ['proxy.example.com', { 'ip-version': 'ipv6' }],
      [
        '2606:4700:4700::1111',
        { type: 'mieru', username: 'fixture', password: 'fixture', transport: 'TCP' }
      ]
    ] as const) {
      expect(() => isolatedProbeConfiguration(source(server, node), request, f.port)).toThrow(
        'IPv6解析'
      )
    }
    expect(spawn).not.toHaveBeenCalled()
  })
  it.each(['93.184.216.34', '2606:4700:4700::1111'])(
    'passes a public literal server %s through actual admission to the delay result and cleanup',
    async (server) => {
      const runtime = await start(server)
      expect(await runtime.delay('node', probeDelayURL)).toBe(178)
      expect(f.configuration?.hosts).toEqual({})
      expect(f.resolve4).not.toHaveBeenCalled()
      expect(execFile).toHaveBeenCalledOnce()
      expect(spawn).toHaveBeenCalledOnce()
      const tests = f.requests.filter((item) => item.path.startsWith('/proxies/node/delay?'))
      expect(tests).toHaveLength(1)
      expect(new URL(tests[0].path, 'http://fixture.invalid').searchParams.get('url')).toBe(
        probeDelayURL
      )
      expect(new URL(tests[0].path, 'http://fixture.invalid').searchParams.get('timeout')).toBe(
        '5000'
      )
      expect(f.requests.every((item) => item.method === 'GET')).toBe(true)
      await runtime.close()
      expect(f.stop).toHaveBeenCalledOnce()
      expect(rm).toHaveBeenCalledExactlyOnceWith(f.directory, { recursive: true })
      expect(f.release).toHaveBeenCalledOnce()
    }
  )
  it('resolves and pins only a proxy hostname before the same real launch and measurement chain', async () => {
    const runtime = await start('proxy.example.com')
    expect(await runtime.delay('node', probeDelayURL)).toBe(178)
    expect(f.resolve4).toHaveBeenCalledExactlyOnceWith('proxy.example.com')
    expect(f.configuration?.hosts).toEqual({ 'proxy.example.com': '93.184.216.35' })
    expect(spawn).toHaveBeenCalledOnce()
  })
  it('rejects a hostname without a pinned address at actual owned-core startup', async () => {
    const config = isolatedProbeConfiguration(source('proxy.example.com'), request, f.port)
    await expect(
      startOwnedCore(
        '/fixture/resources',
        config.configuration,
        'localProxy',
        undefined,
        undefined,
        undefined,
        undefined,
        {
          context,
          purpose: 'isolated-probe-v1',
          hosts: {}
        }
      )
    ).rejects.toThrow('独立出站启动前须固定')
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
  it.each(['127.0.0.1', '192.168.1.2', '::1'])(
    'rejects a non-public server %s before launch',
    async (server) => {
      await expect(start(server)).rejects.toThrow('本机或私网')
      expect(execFile).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    }
  )
  it('rejects private proxy DNS and does not attempt a core launch', async () => {
    f.resolve4.mockResolvedValue(['127.0.0.1'])
    await expect(start('proxy.example.com')).rejects.toThrow()
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
  it('does not fake a delay or retry when the real owned API rejects the response', async () => {
    const runtime = await start('93.184.216.34')
    f.failure = true
    await expect(runtime.delay('node', probeDelayURL)).rejects.toThrow('响应格式或状态')
    expect(f.requests.filter((item) => item.path.startsWith('/proxies/node/delay?'))).toHaveLength(
      1
    )
    expect(f.requests.every((item) => item.method === 'GET')).toBe(true)
    await runtime.close()
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledOnce()
  })
})

function groupFixture(
  count: number,
  badNodes = false,
  target = 'GROUP',
  groups?: { name: string; type: string; proxies: string[] }[]
) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    name: `node-${index}`,
    type: 'socks5',
    server: '93.184.216.34',
    port: 1080
  }))
  if (badNodes) {
    nodes[0].server = '127.0.0.1'
    nodes[1].type = 'unsupported-protocol'
    nodes[2].server = 'unresolvable.example.com'
  }
  const savedGroups = groups ?? [
    { name: 'GROUP', type: 'select', proxies: nodes.map((row) => row.name) }
  ]
  let text = JSON.stringify({ proxies: nodes, 'proxy-groups': savedGroups })
  const service = createIsolatedProbes({
    context,
    resourceRoot: async () => '/fixture/resources',
    confirm: async () => true,
    independentNetwork: async () => 'unchanged-network',
    readProfile: async () => ({
      profile: {
        ...request.profile,
        name: 'Synthetic group',
        createdAt: '2026-11-10T00:00:00Z',
        summary: {
          proxies: count,
          groups: savedGroups.length,
          rules: 0,
          proxyProviders: 0,
          ruleProviders: 0
        }
      },
      text,
      revision: 'c'.repeat(64)
    })
  })
  return {
    service,
    change: () => {
      text = text.replace('1080', '1081')
    },
    prepare: (delay?: IsolatedProbeDelay, group = target) =>
      service.prepare(
        { ...request, kind: 'groupDelay', target: group, ...(delay ? { delay } : {}) },
        () => {}
      )
  }
}
const delayRequests = () => f.requests.filter((row) => /^\/proxies\/[^/]+\/delay\?/u.test(row.path))

describe('Whole static group measurement through the real service and launch chain', () => {
  it.each([38, 100])(
    'refreshes %i direct static nodes plus a child-group result for synthetic GLOBAL',
    async (count) => {
      const { service, prepare } = groupFixture(count, false, 'GLOBAL')
      const plan = await prepare()
      const result = await service.run({ evidenceId: plan.evidenceId }, () => {})
      const nodes = Array.from({ length: count }, (_, index) => `node-${index}`)
      expect(plan.nodes).toEqual([...nodes, 'GROUP'])
      expect(result.measurements.map((row) => row.name)).toEqual(plan.nodes)
      expect(result.measurements.find((row) => row.name === 'GROUP')).toMatchObject({
        milliseconds: null,
        error: expect.any(String)
      })
      expect(
        result.measurements
          .filter((row) => row.name !== 'GROUP')
          .every((row) => row.milliseconds === 178)
      ).toBe(true)
      expect(
        delayRequests()
          .map((row) => row.path.split('?')[0])
          .sort()
      ).toEqual(nodes.map((node) => `/proxies/${node}/delay`).sort())
      expect(f.requests.every((row) => row.method === 'GET')).toBe(true)
      expect(spawn).toHaveBeenCalledOnce()
      expect(f.stop).toHaveBeenCalledOnce()
      expect(f.release).toHaveBeenCalledOnce()
    }
  )
  it('dispatches only direct members of the requested group, preserving shared names and following one child selection', async () => {
    const groups = [
      { name: 'Left', type: 'select', proxies: ['node-0', 'node-1', 'Child'] },
      { name: 'Right', type: 'select', proxies: ['node-1', 'node-2'] },
      { name: 'Child', type: 'select', proxies: ['node-3', 'node-4'] }
    ]
    const { service, prepare } = groupFixture(6, false, 'Left', groups)
    const delay = { url: probeDelayURL, timeout: 5000, selections: { Child: 'node-3' } }
    const targets = () => delayRequests().map((row) => row.path.split('?')[0])
    const left = await prepare({ ...delay, members: ['node-1', 'Child'] })
    expect(left.nodes).toEqual(['node-1', 'Child'])
    const first = await service.run({ evidenceId: left.evidenceId }, () => {})
    expect(first.measurements).toEqual([
      { name: 'node-1', milliseconds: 178 },
      { name: 'Child', milliseconds: 178 }
    ])
    expect(targets().sort()).toEqual(['/proxies/node-1/delay', '/proxies/node-3/delay'])
    const firstCount = targets().length
    await expect(prepare({ ...delay, members: ['node-2'] })).rejects.toThrow('组成员已变化')
    expect(targets()).toHaveLength(firstCount)
    const right = await prepare(delay, 'Right')
    const second = await service.run({ evidenceId: right.evidenceId }, () => {})
    expect(second.measurements.map((row) => row.name)).toEqual(['node-1', 'node-2'])
    expect(targets().slice(firstCount).sort()).toEqual([
      '/proxies/node-1/delay',
      '/proxies/node-2/delay'
    ])
    expect(f.requests.every((row) => row.method === 'GET')).toBe(true)
  })
  it.each([38, 100])(
    'measures all %i members once on one temporary core with at most five simultaneous requests',
    async (count) => {
      const { service, prepare } = groupFixture(count)
      const plan = await prepare()
      const result = await service.run({ evidenceId: plan.evidenceId }, () => {})
      expect(plan.nodes).toHaveLength(count)
      expect(result.measurements).toEqual(
        Array.from({ length: count }, (_, i) => ({ name: `node-${i}`, milliseconds: 178 }))
      )
      expect(delayRequests()).toHaveLength(count)
      expect(f.maximumDelays).toBe(5)
      expect(spawn).toHaveBeenCalledOnce()
      expect(f.stop).toHaveBeenCalledOnce()
      expect(f.release).toHaveBeenCalledOnce()
      expect(service.isBlocking()).toBe(false)
    }
  )
  it('reports unsupported, private and unresolved members without probing them or failing other members', async () => {
    const { service, prepare } = groupFixture(38, true)
    const plan = await prepare()
    const result = await service.run({ evidenceId: plan.evidenceId }, () => {})
    expect(result.measurements).toHaveLength(38)
    expect(result.measurements.slice(0, 3)).toEqual([
      { name: 'node-0', milliseconds: null, error: '节点配置不支持独立测速' },
      { name: 'node-1', milliseconds: null, error: '节点配置不支持独立测速' },
      { name: 'node-2', milliseconds: null, error: '代理服务器地址不可用' }
    ])
    expect(result.measurements.slice(3).every((row) => row.milliseconds === 178)).toBe(true)
    expect(delayRequests()).toHaveLength(35)
    expect(delayRequests().some((row) => /\/node-[012]\//u.test(row.path))).toBe(false)
    expect(spawn).toHaveBeenCalledOnce()
    expect(f.stop).toHaveBeenCalledOnce()
  })
  it('returns explicit untestable results with no child when every member is rejected', async () => {
    const { service, prepare } = groupFixture(3, true)
    const plan = await prepare()
    const result = await service.run({ evidenceId: plan.evidenceId }, () => {})
    expect(result.measurements.every((row) => row.milliseconds === null && row.error)).toBe(true)
    expect(delayRequests()).toHaveLength(0)
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(service.isBlocking()).toBe(false)
  })
  it.each(['cancel', 'budget'] as const)(
    'does not dispatch another batch after %s and drains workers before cleanup',
    async (reason) => {
      const { service, prepare } = groupFixture(38)
      const plan = await prepare()
      f.holdDelay = true
      const running = service.run({ evidenceId: plan.evidenceId }, () => {})
      const rejected = expect(running).rejects.toThrow(reason === 'cancel' ? '取消' : '预算')
      await vi.waitFor(() => expect(f.releaseDelays).toHaveLength(5))
      const clock =
        reason === 'budget' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 90001) : undefined
      if (reason === 'cancel') service.cancel({ evidenceId: plan.evidenceId })
      try {
        f.releaseDelays.splice(0).forEach((release) => release())
        await rejected
        expect(delayRequests()).toHaveLength(5)
        expect(f.activeDelays).toBe(0)
        expect(f.stop).toHaveBeenCalledOnce()
        expect(f.release).toHaveBeenCalledOnce()
        expect(service.isBlocking()).toBe(false)
      } finally {
        clock?.mockRestore()
      }
    }
  )
  it('keeps the 100 member cap and refuses 101 before starting any core', async () => {
    const { prepare } = groupFixture(101)
    await expect(prepare()).rejects.toThrow('1至100')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('keeps request failures distinct from preflight exclusions when the whole group times out', async () => {
    const { service, prepare } = groupFixture(38)
    const plan = await prepare()
    f.failure = true
    const result = await service.run({ evidenceId: plan.evidenceId }, () => {})
    expect(result.measurements).toEqual(
      Array.from({ length: 38 }, (_, i) => ({ name: `node-${i}`, milliseconds: null }))
    )
    expect(delayRequests()).toHaveLength(38)
    expect(f.maximumDelays).toBe(5)
    expect(f.stop).toHaveBeenCalledOnce()
  })
  it('revalidates the original prepared candidate before starting even when source revision is unchanged', async () => {
    const { service, prepare, change } = groupFixture(38)
    const plan = await prepare()
    change()
    await expect(service.run({ evidenceId: plan.evidenceId }, () => {})).rejects.toThrow(
      '独立探测配置已变化'
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
  })
})
