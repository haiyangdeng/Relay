import type { EventEmitter } from 'events'
import { execFile, spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { profileRuntimeSource } from '../__fixtures__/profile-runtime'
import { checkResourceWithCore } from '../resources/checker'
import { resourceHash } from '../resources/source'
import { isolatedCoreConfiguration } from './configuration'
import { localProxyConfiguration } from './local-proxy-runtime'
import { startOwnedCore, type RelayOwnedCore } from './owned-runtime'
import { probeLocalPort, probeLocalUdpPort, ownsHttpListener, ownsUdpListener } from './port'
import { stopOwnedChild } from './shutdown'

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing synthetic fixture value')
  return value
}

const f = vi.hoisted(() => ({
  directory: '/private/tmp/relay-owned-rules-fixture',
  live: true,
  badDirectory: false,
  badSocket: false,
  revokeAfterSocketAwait: false,
  revokeInSocketGetter: false,
  revokeAtResponse: false,
  holdWrite: false,
  throwRequest: false,
  releaseWrite: undefined as (() => void) | undefined,
  stageGate: undefined as (() => Promise<void>) | undefined,
  modelGate: undefined as (() => Promise<void>) | undefined,
  stopGate: undefined as (() => Promise<void>) | undefined,
  holdParser: false,
  parserDurationMs: 0,
  parserError: undefined as Error | undefined,
  releaseParser: undefined as (() => void) | undefined,
  revokeAtConfig: false,
  resourceBytes: Buffer.from('synthetic Geo fixture'),
  geoCapability: false,
  reloadConfigs: false,
  ports: { http: 18191, socks: 0, mixed: 0, redir: 0 },
  evidence: new Map<string, Buffer>(),
  child: undefined as EventEmitter | undefined,
  requests: [] as { method: string; path: string; body?: string; live: boolean }[]
}))
vi.mock('./resources', () => ({
  verifyCoreResource: vi.fn(async () => ({
    executable: '/fixture/never-executed-core',
    version: 'v1.19.33',
    architecture: 'arm64',
    sha256: 'a'.repeat(64),
    ...(f.geoCapability ? { capability: 'local-geodata-v1' } : {})
  }))
}))
vi.mock('./port', async (original) => ({
  ...(await original<typeof import('./port')>()),
  probeLocalPort: vi.fn(async () => true),
  probeLocalUdpPort: vi.fn(async () => true),
  ownsHttpListener: vi.fn(async () => true),
  ownsUdpListener: vi.fn(async () => true)
}))
vi.mock('./smart-runtime', () => ({
  checkSmartConfiguration: vi.fn(() => false),
  stageSmartRuntimeModel: vi.fn(async () => {
    await f.stageGate?.()
    return undefined
  }),
  verifySmartRuntimeModel: vi.fn(async () => {
    await f.modelGate?.()
  })
}))
vi.mock('../resources/source', async (original) => ({
  ...(await original<typeof import('../resources/source')>()),
  readBinaryResource: vi.fn(async (path: string) =>
    Buffer.from(f.evidence.get(path) ?? f.resourceBytes)
  )
}))
vi.mock('./shutdown', () => ({
  stopOwnedChild: vi.fn(async () => {
    await f.stopGate?.()
    f.child?.emit('close', 0)
  })
}))
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events')
  return {
    execFile: vi.fn(
      (
        _file: string,
        _args: string[],
        options: { timeout?: number },
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (f.parserDurationMs) {
          const timeout = options.timeout && options.timeout > 0 ? options.timeout : Infinity
          setTimeout(
            () => {
              if (timeout < f.parserDurationMs)
                callback(
                  Object.assign(new Error('PRIVATE parser command and configuration'), {
                    code: null,
                    killed: true,
                    signal: 'SIGKILL'
                  }),
                  'PRIVATE parser stdout',
                  'PRIVATE parser stderr'
                )
              else callback(null, '', '')
            },
            Math.min(timeout, f.parserDurationMs)
          )
        } else if (f.parserError) callback(f.parserError, 'PRIVATE stdout', 'PRIVATE stderr')
        else if (f.holdParser) f.releaseParser = () => callback(null, '', '')
        else callback(null, '', '')
      }
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
  writeFile: vi.fn(async () => {}),
  open: vi.fn(async (path: string) => ({
    writeFile: async (data: string) => {
      f.evidence.set(path, Buffer.from(data))
    },
    sync: async () => {},
    close: async () => {}
  })),
  rm: vi.fn(async () => {}),
  lstat: vi.fn(async (path: string) => {
    const socket = path.endsWith('/api.sock')
    if (socket && f.revokeAfterSocketAwait)
      queueMicrotask(() => {
        f.live = false
      })
    return {
      dev: 1,
      ino: socket ? (f.badSocket ? 999 : 2) : f.badDirectory ? 999 : 1,
      mode: 0o40700,
      get uid() {
        if (socket && f.revokeInSocketGetter) f.live = false
        return process.getuid?.()
      },
      isDirectory: () => !socket,
      isSocket: () => socket,
      isSymbolicLink: () => false
    }
  })
}))
vi.mock('http', async () => {
  const { EventEmitter } = await import('events')
  return {
    request: vi.fn(
      (
        options: { method: string; path: string },
        callback: (response: EventEmitter & { statusCode: number }) => void
      ) => {
        const call = { ...options, body: undefined as string | undefined, live: f.live }
        f.requests.push(call)
        if (f.throwRequest) throw new Error('synchronous constructor failure')
        const req = Object.assign(new EventEmitter(), {
          setTimeout: () => req,
          destroy: (error: Error) => {
            queueMicrotask(() => {
              req.emit('error', error)
              req.emit('close')
            })
            return req
          },
          end: (body?: string) => {
            call.body = body
            const reply = () =>
              queueMicrotask(() => {
                if (f.revokeAtResponse || (f.revokeAtConfig && options.path === '/configs'))
                  f.live = false
                const response = Object.assign(new EventEmitter(), {
                  statusCode: ['PATCH', 'PUT'].includes(options.method) ? 204 : 200
                })
                callback(response)
                queueMicrotask(() => {
                  if (options.method === 'GET')
                    response.emit(
                      'data',
                      Buffer.from(
                        JSON.stringify(
                          options.path === '/version'
                            ? { version: 'v1.19.33' }
                            : options.path === '/configs'
                              ? {
                                  port: f.reloadConfigs ? f.ports.http : 0,
                                  mode: 'rule',
                                  'socks-port': f.ports.socks,
                                  'mixed-port': f.ports.mixed,
                                  'redir-port': f.ports.redir,
                                  tun: { enable: false }
                                }
                              : { rules: [] }
                        )
                      )
                    )
                  response.emit('end')
                  req.emit('close')
                })
              })
            if (f.holdWrite && options.method === 'PATCH') f.releaseWrite = reply
            else reply()
            return req
          }
        })
        return req
      }
    )
  }
})

let core: RelayOwnedCore | undefined
beforeEach(() => {
  Object.assign(f, {
    live: true,
    badDirectory: false,
    badSocket: false,
    revokeAfterSocketAwait: false,
    revokeInSocketGetter: false,
    revokeAtResponse: false,
    holdWrite: false,
    throwRequest: false,
    releaseWrite: undefined,
    stageGate: undefined,
    modelGate: undefined,
    stopGate: undefined,
    holdParser: false,
    parserDurationMs: 0,
    parserError: undefined,
    releaseParser: undefined,
    revokeAtConfig: false,
    geoCapability: false,
    reloadConfigs: false,
    ports: { http: 18191, socks: 0, mixed: 0, redir: 0 },
    resourceBytes: Buffer.from('synthetic Geo fixture')
  })
  f.requests.length = 0
  f.evidence.clear()
})
afterEach(async () => {
  f.badDirectory = false
  f.badSocket = false
  await core?.stop()
  core = undefined
  vi.useRealTimers()
})
const live = () => {
  if (!f.live) throw new Error('context lost')
}
const geographyFixture = () => {
  const assets = ['GeoSite.dat', 'Country.mmdb'].map((path) => ({
    path,
    bytes: Buffer.from(f.resourceBytes),
    sha256: resourceHash(f.resourceBytes)
  }))
  const source = JSON.stringify({
    proxies: [{ name: 'A', type: 'http', server: '127.0.0.1', port: 1 }],
    'proxy-groups': [{ name: 'G', type: 'select', proxies: ['A'] }],
    rules: ['GEOSITE,CN,DIRECT', 'GEOIP,cn,DIRECT', 'MATCH,G']
  })
  return {
    assets,
    configuration: localProxyConfiguration(source, 18191, 'off', undefined, undefined, assets)
      .configuration
  }
}
describe('Owned HTTP geography lifecycle (mock processes and files only)', () => {
  beforeEach(() => vi.clearAllMocks())
  it('hot-reloads a smaller resource set, stages new filenames once, and keeps pinned bytes immutable', async () => {
    f.geoCapability = true
    const fGeo = geographyFixture(),
      full = JSON.parse(fGeo.configuration)
    const subset = JSON.stringify({ ...full, rules: ['GEOIP,cn,DIRECT', 'MATCH,G'] })
    const country = fGeo.assets.filter((asset) => asset.path === 'Country.mmdb')
    core = await startOwnedCore(
      '/fixture',
      subset,
      'localProxy',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      country
    )
    f.reloadConfigs = true
    let current = subset
    for (const [next, assets] of [
      [fGeo.configuration, fGeo.assets],
      [subset, country],
      [fGeo.configuration, fGeo.assets]
    ] as const) {
      await core.reload?.(next, resourceHash(Buffer.from(current)), undefined, assets)
      current = next
    }
    expect(spawn).toHaveBeenCalledOnce()
    expect(stopOwnedChild).not.toHaveBeenCalled()
    expect(f.requests.filter((item) => item.method === 'PUT').map((item) => item.path)).toEqual(
      Array(3).fill('/configs?force=false')
    )
    for (const asset of fGeo.assets)
      expect(
        vi.mocked(writeFile).mock.calls.filter(([path]) => path === `${f.directory}/${asset.path}`)
      ).toHaveLength(1)
    const changed = fGeo.assets.map((asset) => ({ ...asset, sha256: '0'.repeat(64) }))
    await expect(
      core.reload?.(fGeo.configuration, resourceHash(Buffer.from(current)), undefined, changed)
    ).rejects.toThrow('数据库已变化')
    expect(f.requests.filter((item) => item.method === 'PUT')).toHaveLength(3)
  })
  it('requires the fixed local-only core before creating any workspace', async () => {
    const fGeo = geographyFixture()
    await expect(
      startOwnedCore(
        '/fixture',
        fGeo.configuration,
        'localProxy',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        fGeo.assets
      )
    ).rejects.toThrow('本地数据库核心')
    expect(mkdtemp).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
  it('stages private databases before the parser and preserves local-only mode at launch', async () => {
    f.geoCapability = true
    const fGeo = geographyFixture()
    core = await startOwnedCore(
      '/fixture',
      fGeo.configuration,
      'localProxy',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fGeo.assets
    )
    for (const asset of fGeo.assets)
      expect(writeFile).toHaveBeenCalledWith(`${f.directory}/${asset.path}`, asset.bytes, {
        flag: 'wx',
        mode: 0o600
      })
    expect(execFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-t']),
      expect.objectContaining({ env: expect.objectContaining({ RELAY_LOCAL_GEODATA_V1: '1' }) }),
      expect.any(Function)
    )
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ RELAY_LOCAL_GEODATA_V1: '1' }) })
    )
    const mutated = fGeo.assets.map((asset) => ({ ...asset, sha256: '0'.repeat(64) }))
    await expect(
      core.reload?.(
        fGeo.configuration,
        resourceHash(Buffer.from(fGeo.configuration)),
        undefined,
        mutated
      )
    ).rejects.toThrow('数据库已变化')
    expect(f.requests.some((item) => item.method === 'PUT')).toBe(false)
  })
  it('rechecks staged bytes after parser completion and never spawns after tampering', async () => {
    f.geoCapability = true
    f.holdParser = true
    const fGeo = geographyFixture()
    const starting = startOwnedCore(
      '/fixture',
      fGeo.configuration,
      'localProxy',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fGeo.assets
    )
    const rejected = expect(starting).rejects.toThrow('已结束本次实例')
    await vi.waitFor(() => expect(f.releaseParser).toBeTypeOf('function'))
    f.resourceBytes = Buffer.from('changed local file')
    present(f.releaseParser)()
    await rejected
    expect(spawn).not.toHaveBeenCalled()
  })
})
async function start(kind: 'localProxy' | 'inert' = 'localProxy') {
  core = await startOwnedCore(
    '/fixture',
    kind === 'localProxy'
      ? localProxyConfiguration(profileRuntimeSource, 18191).configuration
      : JSON.stringify(isolatedCoreConfiguration('rule')),
    kind
  )
  f.requests.length = 0
  return core
}
describe('Owned rule HTTP dispatch boundary (mock child/filesystem/HTTP, no Core)', () => {
  it('constructs only the fixed one-index PATCH and reports dispatch after request/end', async () => {
    const current = await start(),
      submitted = vi.fn(() => {
        expect(f.requests).toHaveLength(1)
        expect(f.requests[0].body).toBe('{"0":false}')
      })
    await current.patchRule?.(0, false, { assertLive: live, submitted })
    expect(f.requests).toMatchObject([{ method: 'PATCH', path: '/rules/disable', live: true }])
    expect(submitted).toHaveBeenCalledOnce()
  })
  it('never exposes the mutator for an inert instance or invalid scalar parameters', async () => {
    const inert = await start('inert')
    await expect(inert.patchRule?.(0, true, { assertLive: live })).rejects.toThrow()
    expect(f.requests).toHaveLength(0)
  })
  it.each(['badDirectory', 'badSocket', 'revokeAfterSocketAwait', 'revokeInSocketGetter'] as const)(
    'does not dispatch after the final filesystem await/identity check: %s',
    async (fault) => {
      const current = await start(),
        submitted = vi.fn()
      f[fault] = true
      await expect(current.patchRule?.(0, true, { assertLive: live, submitted })).rejects.toThrow()
      expect(f.requests).toHaveLength(0)
      expect(submitted).not.toHaveBeenCalled()
    }
  )
  it('guards readonly rules at the same final dispatch and response boundaries', async () => {
    const current = await start()
    f.revokeAfterSocketAwait = true
    await expect(current.read('rules', { assertLive: live })).rejects.toThrow()
    expect(f.requests).toHaveLength(0)
    f.revokeAfterSocketAwait = false
    f.live = true
    f.revokeAtResponse = true
    await expect(current.read('rules', { assertLive: live })).rejects.toThrow()
    expect(f.requests).toHaveLength(1)
  })
  it('keeps an observer failure pending until the already submitted response drains', async () => {
    const current = await start()
    f.holdWrite = true
    let settled = false
    const pending = present(current.patchRule)(0, true, {
      assertLive: live,
      submitted: () => {
        f.live = false
        throw new Error('observer failure')
      }
    }).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.waitFor(() => expect(f.releaseWrite).toBeDefined())
    expect(settled).toBe(false)
    expect(f.requests).toHaveLength(1)
    present(f.releaseWrite)()
    await pending
    expect(settled).toBe(true)
    expect(f.requests).toHaveLength(1)
  })
  it('marks a synchronous request attempt as submitted without retrying it', async () => {
    const current = await start(),
      submitted = vi.fn()
    f.throwRequest = true
    await expect(current.patchRule?.(0, true, { assertLive: live, submitted })).rejects.toThrow()
    expect(submitted).toHaveBeenCalledOnce()
    expect(f.requests).toHaveLength(1)
  })
})

describe('Owned core configuration parser deadline (mock processes only)', () => {
  const configuration = JSON.stringify(isolatedCoreConfiguration('rule')),
    timeoutWarning = '核心配置检查超时（30 秒），未启动核心；请重试。'
  beforeEach(() => vi.clearAllMocks())

  it('allows a valid twelve-second first parse before starting the core', async () => {
    vi.useFakeTimers()
    f.parserDurationMs = 12000
    const pending = startOwnedCore('/fixture', configuration, 'inert').then(
      (started) => (core = started),
      (error) => error
    )
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledOnce())
    expect(spawn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(12000)
    expect(await pending).toMatchObject({ pid: 1234 })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('ends an over-budget parser without spawning or exposing private error fields', async () => {
    vi.useFakeTimers()
    f.parserDurationMs = 60000
    const pending = startOwnedCore('/fixture', configuration, 'inert').catch((error) => error)
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledOnce())
    await vi.runAllTimersAsync()
    const failure = await pending
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe(timeoutWarning)
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('PRIVATE')
    expect(failure.cause).toBeUndefined()
    expect(spawn).not.toHaveBeenCalled()
    expect(rm).toHaveBeenCalledOnce()
  })

  it.each([
    { code: 1, killed: true, signal: 'SIGKILL' },
    { code: null, killed: false, signal: 'SIGKILL' },
    { code: null, killed: true, signal: 'SIGTERM' },
    { code: 'ENOENT' }
  ])('does not misclassify an ordinary parser failure: %j', async (details) => {
    f.parserError = Object.assign(new Error('PRIVATE parser failure'), details)
    const failure = await startOwnedCore('/fixture', configuration, 'inert').catch((error) => error)
    expect(failure.message).toContain('隔离核心未就绪')
    expect(failure.message).not.toContain(timeoutWarning)
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('PRIVATE')
    expect(spawn).not.toHaveBeenCalled()
    expect(rm).toHaveBeenCalledOnce()
  })

  it('prioritizes unconfirmed cleanup over the parser timeout diagnosis', async () => {
    f.parserError = Object.assign(new Error('PRIVATE parser timeout'), {
      code: null,
      killed: true,
      signal: 'SIGKILL'
    })
    vi.mocked(rm).mockRejectedValueOnce(new Error('PRIVATE cleanup failure'))
    const failure = await startOwnedCore('/fixture', configuration, 'inert').catch((error) => error)
    expect(failure.message).toContain('退出/清理未确认')
    expect(failure.message).not.toContain(timeoutWarning)
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('PRIVATE')
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('Private resource-check launch guard (mock processes only)', () => {
  const inert = JSON.stringify(isolatedCoreConfiguration('rule'))
  beforeEach(() => {
    vi.clearAllMocks()
  })
  const startGuarded = (register = vi.fn()) =>
    startOwnedCore('/fixture', inert, 'inert', register, undefined, live)
  it('rejects invalid context after immutable verification before creating a directory', async () => {
    f.live = false
    await expect(startGuarded()).rejects.toThrow()
    expect(mkdtemp).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
  })
  it('registers cleanup before a newly-created directory can encounter a failed guard', async () => {
    const register = vi.fn(() => {
      f.live = false
    })
    await expect(startGuarded(register)).rejects.toThrow('已结束本次实例')
    expect(register).toHaveBeenCalledOnce()
    expect(mkdtemp).toHaveBeenCalledOnce()
    expect(rm).toHaveBeenCalledOnce()
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
  it('waits actual preparation then prevents parser admission after context loss', async () => {
    const entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>()
    f.stageGate = async () => {
      entered.resolve()
      await gate.promise
    }
    const pending = startGuarded(),
      rejected = expect(pending).rejects.toThrow('已结束本次实例')
    await entered.promise
    f.live = false
    expect(rm).not.toHaveBeenCalled()
    gate.resolve()
    await rejected
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(rm).toHaveBeenCalledOnce()
  })
  it('waits an admitted parser and refuses spawn after its completion loses context', async () => {
    f.holdParser = true
    const pending = startGuarded(),
      rejected = expect(pending).rejects.toThrow('已结束本次实例')
    await vi.waitFor(() => expect(f.releaseParser).toBeDefined())
    f.live = false
    expect(rm).not.toHaveBeenCalled()
    present(f.releaseParser)()
    await rejected
    expect(execFile).toHaveBeenCalledOnce()
    expect(spawn).not.toHaveBeenCalled()
    expect(rm).toHaveBeenCalledOnce()
  })
  it('rechecks the last awaited model verification before spawn', async () => {
    const entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>()
    f.modelGate = async () => {
      entered.resolve()
      await gate.promise
    }
    const pending = startGuarded(),
      rejected = expect(pending).rejects.toThrow('已结束本次实例')
    await entered.promise
    f.live = false
    gate.resolve()
    await rejected
    expect(execFile).toHaveBeenCalledOnce()
    expect(spawn).not.toHaveBeenCalled()
    expect(rm).toHaveBeenCalledOnce()
  })
  it('drains only its acquired child when guarded readiness loses context', async () => {
    f.revokeAtResponse = true
    await expect(startGuarded()).rejects.toThrow('已结束本次实例')
    expect(spawn).toHaveBeenCalledOnce()
    expect(stopOwnedChild).toHaveBeenCalledOnce()
    expect(rm).toHaveBeenCalledOnce()
    expect(f.requests).toHaveLength(1)
  })
  const geoJob = () => ({
    descriptor: {
      name: 'Synthetic',
      kind: 'country-mmdb' as const,
      behavior: null,
      selector: 'cn'
    },
    bytes: Buffer.from(f.resourceBytes),
    sha256: resourceHash(f.resourceBytes)
  })
  it('passes guard into configs read and waits actual cleanup despite invalid authority', async () => {
    f.revokeAtConfig = true
    const entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>()
    f.stopGate = async () => {
      entered.resolve()
      await gate.promise
    }
    let settled = false
    const pending = checkResourceWithCore('/fixture', geoJob(), live).then((r) => {
      settled = true
      return r
    })
    await entered.promise
    expect(settled).toBe(false)
    expect(rm).not.toHaveBeenCalled()
    gate.resolve()
    const result = await pending
    expect(result.status).toBe('notVerified')
    expect(stopOwnedChild).toHaveBeenCalledOnce()
    expect(rm).toHaveBeenCalledOnce()
    expect(f.requests.map((r) => r.path)).toEqual(['/version', '/configs'])
  })
  it('withholds a passed check if authority is lost during actual cleanup', async () => {
    f.stopGate = async () => {
      f.live = false
    }
    const result = await checkResourceWithCore('/fixture', geoJob(), live)
    expect(result.status).toBe('notVerified')
    expect(result.warnings.join(' ')).toContain('范围已失效')
    expect(stopOwnedChild).toHaveBeenCalledOnce()
    expect(rm).toHaveBeenCalledOnce()
  })
})

describe('ordinary multiport owned child lifecycle', () => {
  const ports = { http: 0, socks: 18192, mixed: 18194, redir: 18195 }
  const configuration = () =>
    localProxyConfiguration(
      profileRuntimeSource,
      ports.mixed,
      'off',
      undefined,
      undefined,
      [],
      ports
    ).configuration
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(probeLocalPort).mockResolvedValue(true)
    vi.mocked(probeLocalUdpPort).mockResolvedValue(true)
    vi.mocked(ownsHttpListener).mockResolvedValue(true)
    vi.mocked(ownsUdpListener).mockResolvedValue(true)
    f.ports = { ...ports }
    f.reloadConfigs = true
  })
  it('checks every ordinary TCP and UDP listener before and after launch', async () => {
    core = await startOwnedCore('/fixture', configuration(), 'localProxy')
    expect(
      vi
        .mocked(probeLocalPort)
        .mock.calls.map(([port]) => port)
        .sort()
    ).toEqual([18192, 18194, 18195])
    expect(
      vi
        .mocked(probeLocalUdpPort)
        .mock.calls.map(([port]) => port)
        .sort()
    ).toEqual([18192, 18194])
    expect(
      vi
        .mocked(ownsHttpListener)
        .mock.calls.map(([, port]) => port)
        .sort()
    ).toEqual([18192, 18194, 18195])
    expect(
      vi
        .mocked(ownsUdpListener)
        .mock.calls.map(([, port]) => port)
        .sort()
    ).toEqual([18192, 18194])
    const changed = JSON.parse(configuration())
    changed['redir-port'] += 1
    await expect(
      core.reload?.(JSON.stringify(changed), resourceHash(Buffer.from(configuration())))
    ).rejects.toThrow('不能更换')
    expect(f.requests.filter((request) => request.method === 'PUT')).toEqual([])
    await core.reload?.(configuration(), resourceHash(Buffer.from(configuration())))
    expect(f.requests.filter((request) => request.method === 'PUT')).toHaveLength(1)
  })
  it('refuses a UDP conflict before spawning the live child', async () => {
    vi.mocked(probeLocalUdpPort).mockResolvedValue(false)
    await expect(startOwnedCore('/fixture', configuration(), 'localProxy')).rejects.toThrow()
    expect(spawn).not.toHaveBeenCalled()
  })
  it('cleans up its own child when UDP ownership cannot be confirmed', async () => {
    vi.mocked(ownsUdpListener).mockResolvedValue(false)
    await expect(startOwnedCore('/fixture', configuration(), 'localProxy')).rejects.toThrow()
    expect(spawn).toHaveBeenCalledOnce()
    expect(stopOwnedChild).toHaveBeenCalledOnce()
  })
})
