import { beforeEach, describe, expect, it, vi } from 'vitest'
import { probeDelayURL } from '../../../shared/relay/isolated-probes'
import { startIsolatedProbe } from './probe-runtime'

const f = vi.hoisted(() => ({
  resolve4: vi.fn(),
  cancel: vi.fn(),
  start: vi.fn(),
  owner: vi.fn(),
  http: vi.fn(),
  delay: vi.fn(),
  select: vi.fn(),
  group: vi.fn(),
  stop: vi.fn(),
  alive: true,
  config: {} as { port: number; mode: string; ipv6: boolean; hosts: Record<string, string> }
}))
vi.mock('dns/promises', () => ({
  Resolver: class {
    resolve4 = f.resolve4
    cancel = f.cancel
  }
}))
vi.mock('os', () => ({ networkInterfaces: () => ({}) }))
vi.mock('../../resolve/plugin/http-client', () => ({ requestOnce: f.http }))
vi.mock('../core/port', async (original) => ({
  ...(await original<typeof import('../core/port')>()),
  ownsHttpListener: f.owner
}))
vi.mock('../core/owned-runtime', async (original) => ({
  ...(await original<typeof import('../core/owned-runtime')>()),
  startOwnedCore: f.start
}))
const request = {
  profile: { id: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64) },
  target: 'node',
  kind: 'nodeDelay' as const,
  provider: 'ip.sb' as const
}
function start(server = '93.184.216.34', signal = new AbortController().signal) {
  return startIsolatedProbe({
    context: { home: '/fixture', stateRoot: '/fixture/state' },
    resourceRoot: '/fixture/resources',
    text: JSON.stringify({
      proxies: [{ name: 'node', type: 'socks5', server, port: 1080 }],
      'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['node', 'DIRECT'] }]
    }),
    request,
    signal,
    assertCurrent: () => {
      if (signal.aborted) throw new Error('cancelled')
    },
    registerCleanup: vi.fn()
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  f.alive = true
  f.owner.mockResolvedValue(true)
  f.delay.mockResolvedValue(42)
  f.resolve4.mockImplementation(async (host: string) => {
    if (host === 'proxy.example.com') return ['93.184.216.35']
    throw new Error('Local test-destination DNS is unavailable or poisoned')
  })
  f.start.mockImplementation(async (_root, configuration, _kind, cleanup) => {
    const config = JSON.parse(configuration)
    f.config = config
    cleanup(f.stop)
    return {
      pid: 1234,
      state: () => (f.alive ? 'running' : 'stopped'),
      read: vi.fn(async () => config),
      testDelay: f.delay,
      select: f.select,
      group: f.group,
      stop: f.stop
    }
  })
})

describe('Isolated node delay uses the same Mihomo test as upstream', () => {
  it('does not locally resolve or pin the test site, so a broken local site lookup cannot break node testing', async () => {
    const runtime = await start()
    expect(await runtime.delay('node', probeDelayURL)).toBe(42)
    expect(f.resolve4).not.toHaveBeenCalled()
    expect(f.config.hosts).toEqual({})
    expect(f.delay).toHaveBeenCalledExactlyOnceWith(
      'node',
      'https://www.gstatic.com/generate_204',
      5000
    )
    expect(f.http).not.toHaveBeenCalled()
    expect(f.select).not.toHaveBeenCalled()
    expect(f.group).not.toHaveBeenCalled()
    await runtime.close()
    expect(f.stop).toHaveBeenCalledOnce()
  })
  it('still resolves, validates and pins the actual proxy server before starting the temporary core', async () => {
    const runtime = await start('proxy.example.com')
    expect(f.resolve4).toHaveBeenCalledExactlyOnceWith('proxy.example.com')
    expect(f.config.hosts).toEqual({ 'proxy.example.com': '93.184.216.35' })
    expect(await runtime.delay('node', probeDelayURL)).toBe(42)
  })
  it('rejects private proxy resolution without starting a child', async () => {
    f.resolve4.mockResolvedValue(['127.0.0.1'])
    await expect(start('proxy.example.com')).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled()
  })
  it('does not permit an arbitrary destination or built-in direct outbound', async () => {
    const runtime = await start()
    await expect(runtime.delay('DIRECT', probeDelayURL)).rejects.toThrow('固定静态节点')
    await expect(runtime.delay('node', 'https://private.invalid')).rejects.toThrow('固定静态节点')
    expect(f.delay).not.toHaveBeenCalled()
  })
  it('rejects lost ownership before request, and cancellation or lost ownership after request', async () => {
    const abort = new AbortController(),
      runtime = await start(undefined, abort.signal)
    f.owner.mockResolvedValue(false)
    await expect(runtime.delay('node', probeDelayURL)).rejects.toThrow('监听身份')
    expect(f.delay).not.toHaveBeenCalled()
    f.owner.mockResolvedValue(true)
    f.delay.mockImplementationOnce(async () => {
      abort.abort()
      return 1
    })
    await expect(runtime.delay('node', probeDelayURL)).rejects.toThrow('cancelled')
    const next = await start()
    f.delay.mockImplementationOnce(async () => {
      f.alive = false
      return 1
    })
    await expect(next.delay('node', probeDelayURL)).rejects.toThrow('所有权')
  })
  it('propagates a failed core measurement without selecting, falling back or retrying', async () => {
    const runtime = await start()
    f.delay.mockRejectedValueOnce(new Error('test timed out'))
    await expect(runtime.delay('node', probeDelayURL)).rejects.toThrow('timed out')
    expect(f.delay).toHaveBeenCalledOnce()
    expect(f.select).not.toHaveBeenCalled()
    expect(f.http).not.toHaveBeenCalled()
  })
})

describe('isolated builtin and selected-group delay', () => {
  const delay = {
    url: 'https://test.example.com/204',
    timeout: 7000,
    selections: { PROXY: 'node' }
  }
  async function snapshot(
    target: string,
    kind: 'nodeDelay' | 'groupDelay' = 'nodeDelay',
    registerCleanup = vi.fn()
  ) {
    return startIsolatedProbe({
      context: { home: '/fixture', stateRoot: '/fixture/state' },
      resourceRoot: '/fixture/resources',
      text: JSON.stringify({
        'unified-delay': true,
        proxies: [{ name: 'node', type: 'socks5', server: '93.184.216.34', port: 1080 }],
        'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['node', 'DIRECT', 'REJECT'] }]
      }),
      request: { ...request, target, kind, delay },
      signal: new AbortController().signal,
      assertCurrent: () => {},
      registerCleanup
    })
  }
  it('uses the selected leaf with inherited 1-RTT, requested URL and timeout, without selecting the live group', async () => {
    const runtime = await snapshot('PROXY')
    expect(f.config).toMatchObject({ 'unified-delay': true })
    expect(await runtime.delay('PROXY', delay.url)).toBe(42)
    expect(f.delay).toHaveBeenCalledExactlyOnceWith('node', delay.url, 7000)
    expect(f.select).not.toHaveBeenCalled()
    await runtime.close()
  })
  it('pins the public DIRECT destination only in a separate rejecting instance and closes both', async () => {
    f.resolve4.mockResolvedValue(['93.184.216.35'])
    const cleanup = vi.fn(),
      runtime = await snapshot('PROXY', 'groupDelay', cleanup)
    expect(await runtime.delay('node', delay.url)).toBe(42)
    expect(await runtime.delay('DIRECT', delay.url)).toBe(42)
    expect(f.start).toHaveBeenCalledTimes(2)
    const parent = JSON.parse(f.start.mock.calls[0][1]),
      direct = JSON.parse(f.start.mock.calls[1][1])
    expect(parent.hosts).toEqual({})
    expect(direct.hosts).toEqual({ 'test.example.com': '93.184.216.35' })
    expect(direct.proxies).toEqual([])
    expect(parent['proxy-groups'][0].proxies).toEqual(['REJECT'])
    expect(direct['proxy-groups'][0].proxies).toEqual(['REJECT'])
    expect(f.delay.mock.calls).toEqual([
      ['node', delay.url, 7000],
      ['DIRECT', delay.url, 7000]
    ])
    expect(cleanup).toHaveBeenCalledOnce()
    await cleanup.mock.calls[0][0]()
    expect(f.stop).toHaveBeenCalledTimes(2)
  })
  it('rejects private DIRECT DNS without disturbing the already measured proxy', async () => {
    f.resolve4.mockResolvedValue(['127.0.0.1'])
    const runtime = await snapshot('PROXY', 'groupDelay')
    expect(await runtime.delay('node', delay.url)).toBe(42)
    await expect(runtime.delay('DIRECT', delay.url)).rejects.toThrow()
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.delay).toHaveBeenCalledOnce()
    await runtime.close()
    expect(f.stop).toHaveBeenCalledOnce()
  })
  it('performs a real REJECT URLTest failure rather than synthesizing a delay', async () => {
    const runtime = await snapshot('REJECT')
    f.delay.mockRejectedValueOnce(new Error('rejected'))
    await expect(runtime.delay('REJECT', delay.url)).rejects.toThrow('rejected')
    expect(f.delay).toHaveBeenCalledExactlyOnceWith('REJECT', delay.url, 7000)
    expect(f.resolve4).not.toHaveBeenCalled()
    await runtime.close()
  })
})

it('does not fall through to unpinned DIRECT when direct-only group destination DNS fails', async () => {
  f.resolve4.mockRejectedValue(new Error('DNS unavailable'))
  await expect(
    startIsolatedProbe({
      context: { home: '/fixture', stateRoot: '/fixture/state' },
      resourceRoot: '/fixture/resources',
      text: JSON.stringify({
        proxies: [],
        'proxy-groups': [{ name: 'ONLY', type: 'select', proxies: ['DIRECT', 'REJECT'] }]
      }),
      request: {
        ...request,
        kind: 'groupDelay',
        target: 'ONLY',
        delay: { url: probeDelayURL, timeout: 5000, selections: { ONLY: 'DIRECT' } }
      },
      signal: new AbortController().signal,
      assertCurrent: () => {},
      registerCleanup: vi.fn()
    })
  ).rejects.toThrow()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.delay).not.toHaveBeenCalled()
})
