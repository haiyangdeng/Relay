import type { EventEmitter } from 'events'
import { execFile, spawn } from 'child_process'
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  type FileHandle
} from 'fs/promises'
import type { Server } from 'net'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resourceHash } from '../resources/source'
import { SmartStateStore } from './smart-state-store'
import { smartStateKey } from './smart-state-schema'
import { startLocalProxyCore } from './local-proxy-runtime'
import type { OwnedCoreCleanupRegistration, RelayOwnedCore } from './owned-runtime'
import {
  SmartLearningRuntime,
  type SmartLearningContext,
  type SmartLearningStopResult
} from './smart-state-runtime'

const f = vi.hoisted(() => ({
  home: '',
  source: '',
  directory: '',
  version: 'alpha-smart-4624551',
  parsed: {} as Record<string, unknown>,
  model: Buffer.from('private synthetic model, trust is mocked only in this file'),
  server: undefined as Server | undefined,
  child: undefined as
    | (EventEmitter & {
        pid: number
        stdout: EventEmitter
        stderr: EventEmitter
        kill(signal: string): boolean
      })
    | undefined,
  signals: [] as string[],
  holdClose: false,
  holdParser: false,
  close: undefined as (() => void) | undefined,
  parser: undefined as (() => void) | undefined,
  parserReady: undefined as (() => void) | undefined,
  report: undefined as (() => SmartLearningStopResult | undefined) | undefined,
  stop: undefined as (() => Promise<void>) | undefined
}))
vi.mock('./resources', async (original) => ({
  ...(await original<typeof import('./resources')>()),
  verifyCoreResource: vi.fn(async () => {
    const { trustedCoreVariants } = await import('./trusted-variants'),
      pin = trustedCoreVariants().find(
        (item) => item.family === 'smart' && item.architecture === 'arm64'
      )
    if (!pin) throw new Error('missing fixed fixture pin')
    return { ...pin, executable: '/private/fixture/never-executed-core' }
  })
}))
vi.mock('./port', async (original) => ({
  ...(await original<typeof import('./port')>()),
  probeLocalPort: vi.fn(async () => true),
  ownsHttpListener: vi.fn(async () => true)
}))
vi.mock('./smart-runtime', async (original) => ({
  ...(await original<typeof import('./smart-runtime')>()),
  stageSmartRuntimeModel: vi.fn(async (_root, directory, _resource, _configuration, register) => {
    const { trustedSmartModels } = await import('./smart-models'),
      { resourceHash } = await import('../resources/source')
    const pin = { ...trustedSmartModels()[0], size: f.model.length, sha256: resourceHash(f.model) },
      file = await open(join(directory, 'Model.bin'), 'wx+', 0o600)
    if (register) register(file, pin)
    try {
      await file.writeFile(f.model)
      await file.sync()
    } finally {
      if (!register) await file.close()
    }
    return pin
  }),
  verifySmartRuntimeModel: vi.fn(async () => undefined)
}))
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    mkdtemp: vi.fn(async (prefix: string) => {
      const directory = await actual.mkdtemp(
        prefix.startsWith('/private/tmp/relay-proxy-') ? join(f.home, 'runtime-') : prefix
      )
      if (prefix.startsWith('/private/tmp/relay-proxy-')) f.directory = directory
      return directory
    })
  }
})
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events'),
    { createServer } = await import('net'),
    { chmodSync } = await import('fs'),
    { readFile } = await import('fs/promises')
  return {
    execFile: vi.fn(
      (
        _file: string,
        args: string[],
        _options: object,
        callback: (error: Error | null, out: string, err: string) => void
      ) => {
        const complete = (): void => {
          f.parser = undefined
          void readFile(args[args.indexOf('-f') + 1], 'utf8').then(
            (body) => {
              f.source = body
              f.parsed = JSON.parse(body)
              callback(null, '', '')
            },
            (error: Error) => callback(error, '', '')
          )
        }
        if (f.holdParser) {
          f.parser = complete
          f.parserReady?.()
        } else complete()
      }
    ),
    spawn: vi.fn((_file: string, args: string[]) => {
      const socket = args[args.indexOf('-ext-ctl-unix') + 1],
        server = createServer()
      f.server = server
      server.listen(socket, () => chmodSync(socket, 0o666))
      const child = Object.assign(new EventEmitter(), {
        pid: 1234,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: (signal: string): boolean => {
          f.signals.push(signal)
          f.close = () => {
            f.close = undefined
            server.close(() => child.emit('close', 0))
          }
          if (!f.holdClose) queueMicrotask(f.close)
          return true
        }
      })
      f.child = child
      return child
    })
  }
})
vi.mock('http', async (original) => {
  const actual = await original<typeof import('http')>(),
    { EventEmitter } = await import('events')
  return {
    ...actual,
    request: vi.fn(
      (
        options: { method: string; path: string },
        receive: (reply: EventEmitter & { statusCode: number }) => void
      ) => {
        const request = Object.assign(new EventEmitter(), {
          setTimeout: () => request,
          destroy: (error: Error) => {
            queueMicrotask(() => request.emit('error', error))
            return request
          },
          end: (body?: string) => {
            if (options.method === 'PUT' && body) f.parsed = JSON.parse(JSON.parse(body).payload)
            const data = options.path === '/version' ? { version: f.version } : f.parsed
            queueMicrotask(() => {
              const reply = Object.assign(new EventEmitter(), {
                statusCode: options.method === 'GET' ? 200 : 204
              })
              receive(reply)
              queueMicrotask(() => {
                if (options.method === 'GET') reply.emit('data', Buffer.from(JSON.stringify(data)))
                reply.emit('end')
                request.emit('close')
              })
            })
          }
        })
        return request
      }
    )
  }
})

let store: SmartStateStore,
  context: SmartLearningContext,
  profile: string,
  session: RelayOwnedCore | undefined
const source =
  'proxies:\n  - {name: Denied, type: socks5, server: 127.0.0.1, port: 19001}\nproxy-groups:\n  - {name: S, type: smart, proxies: [Denied], collectdata: true, url: "http://127.0.0.1:19002/health", interval: 3600, lazy: true}\nrules: ["MATCH,S"]\n'
beforeEach(async () => {
  vi.clearAllMocks()
  f.home = await realpath(await mkdtemp('/private/tmp/relay-owned-lifecycle-'))
  f.directory = ''
  f.source = ''
  f.parsed = {}
  f.signals = []
  f.holdClose = false
  f.holdParser = false
  f.close = undefined
  f.parser = undefined
  f.parserReady = undefined
  f.report = undefined
  f.stop = undefined
  f.server = undefined
  f.child = undefined
  profile = '00000000-0000-0000-0000-000000000001'
  store = new SmartStateStore({
    home: f.home,
    stateRoot: join(f.home, 'Library/Application Support/Relay-Preview')
  })
  context = { profileUUID: profile, store, assertOwner: () => undefined, mayPersist: () => true }
  session = undefined
})
afterEach(async () => {
  vi.useRealTimers()
  f.holdClose = false
  f.parser?.()
  f.close?.()
  await session?.stop()
  if (!session) await f.stop?.()
  if (f.server?.listening) await new Promise<void>((resolve) => f.server?.close(() => resolve()))
  vi.restoreAllMocks()
  await rm(f.home, { recursive: true, force: true })
})
const register: OwnedCoreCleanupRegistration = (stop, report) => {
  f.stop = stop
  f.report = report
}
const head = (): string =>
  join(
    f.home,
    'Library/Application Support/Relay-Preview/SmartState',
    smartStateKey(profile),
    'head.json'
  )
async function start(): Promise<RelayOwnedCore> {
  session = await startLocalProxyCore(
    '/private/fixture/no-resource-executed',
    source,
    18191,
    register,
    'off',
    undefined,
    context
  )
  return session
}

describe('Private owned-runtime Smart lifecycle: real files and synthetic held child only', () => {
  it('does not begin state preparation after cleanup is synchronously requested during registration', async () => {
    const prepare = vi.spyOn(SmartLearningRuntime, 'prepare')
    let stopping: Promise<void> | undefined
    const cancelled: OwnedCoreCleanupRegistration = (stop, report) => {
      register(stop, report)
      stopping = stop()
    }
    await expect(
      startLocalProxyCore('/not-executed', source, 18191, cancelled, 'off', undefined, context)
    ).rejects.toThrow('未就绪')
    await stopping
    expect(prepare).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
    expect(await readdir(f.directory)).toEqual([])
    expect(f.report?.()?.status).toBe('retained')
  })
  it('drains a pending state preparation instead of leaking a late helper capability after stop', async () => {
    let release: () => void = () => undefined,
      entered: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve
      }),
      prepare = SmartLearningRuntime.prepare.bind(SmartLearningRuntime)
    let prepared: SmartLearningRuntime | undefined
    vi.spyOn(SmartLearningRuntime, 'prepare').mockImplementation(async (...args) => {
      const runtime = await prepare(...args)
      prepared = runtime
      entered()
      await gate
      return runtime
    })
    const starting = start()
    await Promise.race([
      ready,
      starting.then(() => {
        throw new Error('startup unexpectedly completed')
      })
    ])
    const runtime = prepared
    if (!runtime || !f.stop) throw new Error('missing pending creator capability')
    const finished = vi.spyOn(runtime, 'finish'),
      root = Reflect.get(runtime, 'root') as FileHandle
    let stopSettled = false
    const stopping = f.stop().then(() => {
      stopSettled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const settledBeforeRelease = stopSettled
    release()
    try {
      await expect(starting).rejects.toThrow('未就绪')
      await stopping
      let rootStillOpen = true
      try {
        await root.stat()
      } catch {
        rootStillOpen = false
      }
      const facts = {
        settledBeforeRelease,
        helperFinishCallsBeforeFixtureCleanup: finished.mock.calls.length,
        helperRootStillOpen: rootStillOpen,
        spawnCalls: vi.mocked(spawn).mock.calls.length,
        CoreExecuted: false
      }
      const phase = process.env.RELAY_OWNED_PREPARE_PHASE ?? 'after'
      if (!['before', 'after'].includes(phase)) throw new Error('invalid private proof phase')
      await writeFile(
        join(
          process.env.RELAY_OWNED_PROOF_OUTPUT ??
            join(process.cwd(), '.relay-build/private/p34-smart-state-owned-runtime-20261103'),
          `prepare-pending-${phase}-facts.json`
        ),
        JSON.stringify(facts, null, 2) + '\n',
        { mode: 0o600 }
      )
      expect(finished.mock.calls.length).toBe(1)
      expect(rootStillOpen).toBe(false)
      expect(settledBeforeRelease).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      release()
      // Only the fixture closes the capability leaked by the before source.
      // This explicit cleanup is not counted as production retirement above.
      await runtime.finish(false)
    }
  })
  it('stages state before parser, drains a held close before save, then returns stopped with retained small evidence', async () => {
    const runtime = await start(),
      cache = join(runtime.directory, 'cache.db'),
      file = await open(cache, 'r+')
    try {
      await file.writeFile(Buffer.from('closed learned bytes'))
      await file.sync()
    } finally {
      await file.close()
    }
    f.holdClose = true
    const stopping = runtime.stop()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(lstat(head())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(runtime.directory)).toContain('Model.bin')
    f.close?.()
    await stopping
    expect(runtime.state()).toBe('stopped')
    expect(runtime.smartStateStopResult?.()).toMatchObject({
      status: 'persisted',
      retainedEvidence: true
    })
    expect(f.report?.()).toEqual(runtime.smartStateStopResult?.())
    expect((await store.prepare(profile, false)).copyFiles()[0].bytes).toEqual(
      Buffer.from('closed learned bytes')
    )
    expect(await readdir(runtime.directory)).toEqual([])
    expect(f.signals).toEqual(['SIGTERM'])
    expect(execFile).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledOnce()
  })
  it('waits for the parser callback before retiring an aborted startup, never spawning or publishing a head', async () => {
    f.holdParser = true
    const ready = new Promise<void>((resolve) => {
      f.parserReady = resolve
    })
    const starting = start()
    await Promise.race([
      ready,
      starting.then(() => {
        throw new Error('parser unexpectedly completed')
      })
    ])
    if (!f.parser || !f.stop) throw new Error('missing owned parser/cleanup barrier')
    const stopping = f.stop()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(lstat(head())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(f.directory)).toContain('Model.bin')
    f.parser()
    await expect(starting).rejects.toThrow('未就绪')
    await stopping
    expect(spawn).not.toHaveBeenCalled()
    expect(f.report?.()).toMatchObject({ status: 'retained', retainedEvidence: true })
    expect(await readdir(f.directory)).toContain('cache.db')
  })
  it('retains unknown work but reports stopped after its child actually drains', async () => {
    const runtime = await start()
    await writeFile(join(runtime.directory, 'cache.db.bak'), 'foreign', { flag: 'wx', mode: 0o600 })
    const before = await readdir(runtime.directory)
    await runtime.stop()
    expect(runtime.state()).toBe('stopped')
    expect(runtime.smartStateStopResult?.()?.status).toBe('retained')
    expect((await readdir(runtime.directory)).filter((name) => name !== 'api.sock')).toEqual(
      before.filter((name) => name !== 'api.sock')
    )
    await expect(lstat(head())).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not save or remove files if the held traffic child fails polite close', async () => {
    const runtime = await start()
    f.holdClose = true
    vi.useFakeTimers()
    const stopping = runtime.stop(),
      observed = expect(stopping).rejects.toThrow('仍未退出')
    await vi.advanceTimersByTimeAsync(3001)
    await observed
    vi.useRealTimers()
    expect(runtime.state()).toBe('stopping')
    await expect(lstat(head())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(runtime.directory)).toContain('cache.db')
    expect(f.signals).toEqual(['SIGTERM'])
    f.holdClose = false
    await runtime.stop()
    expect(runtime.state()).toBe('stopped')
    expect(f.signals).toEqual(['SIGTERM', 'SIGTERM'])
  })
  it('rejects UUID/CSV hot reload before applying but preserves a same-owner reload without reseeding', async () => {
    const runtime = await start(),
      cache = await lstat(join(runtime.directory, 'cache.db')),
      model = await lstat(join(runtime.directory, 'Model.bin'))
    const candidate = JSON.parse(f.source) as Record<string, unknown>
    candidate['log-level'] = 'debug'
    await expect(
      runtime.reload?.(
        JSON.stringify(candidate),
        resourceHash(Buffer.from(f.source)),
        '00000000-0000-0000-0000-000000000002'
      )
    ).rejects.toThrow('明确停止')
    const changed = JSON.parse(f.source) as Record<string, unknown>
    const groups = changed['proxy-groups'] as Record<string, unknown>[]
    groups[0] = { ...groups[0], collectdata: false }
    await expect(
      runtime.reload?.(JSON.stringify(changed), resourceHash(Buffer.from(f.source)), profile)
    ).rejects.toThrow('明确停止')
    await runtime.reload?.(JSON.stringify(candidate), resourceHash(Buffer.from(f.source)), profile)
    expect((await lstat(join(runtime.directory, 'cache.db'))).ino).toBe(cache.ino)
    expect((await lstat(join(runtime.directory, 'Model.bin'))).ino).toBe(model.ino)
    expect(await readdir(runtime.directory)).toContain('config.yaml')
    expect(await readFile(join(runtime.directory, 'config.yaml'), 'utf8')).toBe(f.source)
    expect(
      (await readdir(runtime.directory)).filter((name) => name.startsWith('reload-'))
    ).toHaveLength(1)
    await runtime.stop()
    expect(runtime.smartStateStopResult?.()?.status).toBe('persisted')
    expect(await readdir(runtime.directory)).toEqual([])
  })
  it('retains an abnormal reaped runtime without pretending traffic remains running or saving a head', async () => {
    const runtime = await start()
    if (!f.server || !f.child) throw new Error('missing synthetic held child')
    const child = f.child
    await new Promise<void>((resolve) =>
      f.server?.close(() => {
        child.emit('close', 1)
        resolve()
      })
    )
    expect(runtime.state()).toBe('unexpectedExit')
    await runtime.stop()
    expect(runtime.state()).toBe('stopped')
    expect(runtime.smartStateStopResult?.()?.status).toBe('retained')
    expect(await readdir(runtime.directory)).toContain('Model.bin')
    await expect(lstat(head())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.signals).toEqual([])
  })
})
