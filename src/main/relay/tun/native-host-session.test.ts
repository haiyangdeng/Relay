import { ChildProcess, type spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logPath } from '../../utils/dirs'
import { createTunHostChannel, type TunHostChannel } from './native-host'
import type { TunPlanEvidence } from './plan'
import { openTunNativeHost, type TunInstallation } from './transport'
import { createTunSessionService, type TunHostObservation, type TunSessionBinding } from './service'

vi.mock('../../utils/dirs', () => ({ logPath: vi.fn() }))
let logDirectory: string
beforeEach(async () => {
  logDirectory = await mkdtemp('/private/tmp/relay-tun-channel-log-test-')
  vi.mocked(logPath).mockReturnValue(logDirectory + '/app.log')
})

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function fixture(execution?: 'core-managed', useTransport = false) {
  const configuration = {
      port: 0,
      mode: 'rule',
      'allow-lan': false,
      'geo-auto-update': false,
      'geox-url': { geoip: '', geosite: '', mmdb: '', asn: '' },
      tun: {
        enable: true,
        device: 'utun',
        stack: 'gvisor',
        'auto-route': true,
        'auto-detect-interface': true,
        'dns-hijack': []
      },
      proxies: [],
      rules: ['MATCH,REJECT']
    },
    source = JSON.stringify(configuration),
    request = {
      configurationSHA256: hash(source),
      bundleSHA256: hash(JSON.stringify({ configuration, assets: [], pins: [], unresolved: [] }))
    },
    evidence: TunPlanEvidence = {
      configurationExpiresAt: 61000,
      configuration: source,
      assets: [],
      pins: [],
      parser: {
        status: 'passed',
        scope: 'complete-parser',
        configurationSHA256: request.configurationSHA256,
        coreVersion: 'v1.19.33',
        active: false,
        runtimeAccepted: false,
        warnings: []
      },
      helper: {
        version: 1,
        source: 'native',
        observedAt: 1000,
        revision: 'a'.repeat(64),
        state: 'ready',
        identity: 'authenticated',
        authorization: 'approved',
        rootOwned: true,
        runningAsRoot: !execution,
        ...(execution ? { execution, privilegedCoreVerified: true } : {}),
        clientUID: 501,
        helperSHA256: 'b'.repeat(64),
        coreSHA256: 'c'.repeat(64)
      },
      network: {
        version: 1,
        source: 'native',
        observedAt: 1000,
        state: 'observed',
        revision: 'd'.repeat(64),
        routesSHA256: 'e'.repeat(64),
        dnsSHA256: 'f'.repeat(64),
        interfacesSHA256: '1'.repeat(64),
        proxySHA256: '2'.repeat(64),
        protectionSHA256: '3'.repeat(64),
        existingTunnel: 'none',
        recovery: 'available'
      },
      expectedHelperSHA256: 'b'.repeat(64),
      expectedCoreSHA256: 'c'.repeat(64),
      currentUID: 501
    }
  type Frame = TunSessionBinding & { version: 1; id: number; action: string }
  const frames: Frame[] = [],
    held = new Set<string>(),
    recheck = vi.fn(async () => {}),
    confirmStart = vi.fn(async () => true),
    confirmStop = vi.fn(async () => true),
    notify = vi.fn()
  let data: (bytes: Buffer) => void = () => {},
    gone = () => {},
    autoExit = true,
    channel: TunHostChannel | undefined,
    nativePhase: TunHostObservation['phase'] = 'idle'
  const combinations: Record<
    TunHostObservation['phase'],
    [TunHostObservation['core'], TunHostObservation['device'], TunHostObservation['network']]
  > = {
    idle: ['none', 'none', 'unchanged'],
    acquired: ['none', 'held', 'unchanged'],
    coreReady: ['running', 'held', 'unchanged'],
    active: ['running', 'held', 'active'],
    coreStopped: execution ? ['stopped', 'unknown', 'unknown'] : ['stopped', 'held', 'active'],
    released: ['stopped', 'released', 'restored'],
    restored: ['stopped', 'absent', 'restored'],
    unknown: ['unknown', 'unknown', 'unknown']
  }
  function reply(frame: Frame, override: Partial<TunSessionBinding> = {}): void {
    const { sessionId, evidenceSHA256, runtimeConfigurationSHA256, id, action } = frame,
      identity = { sessionId, evidenceSHA256, runtimeConfigurationSHA256, ...override }
    if (action === 'revokeActivation' || action === 'dispose') {
      data(
        Buffer.from(
          JSON.stringify({
            version: 1,
            id,
            action,
            ...identity,
            [action === 'dispose' ? 'closed' : 'revoked']: true
          }) + '\n'
        )
      )
      return
    }
    const phases: Record<string, TunHostObservation['phase']> = {
      initialize: 'idle',
      acquire: 'acquired',
      startCore: execution ? 'active' : 'coreReady',
      activate: 'active',
      stopCore: 'coreStopped',
      release: 'released',
      verifyRestored: 'restored'
    }
    nativePhase = action === 'inspect' ? nativePhase : phases[action]
    const [core, device, network] = combinations[nativePhase]
    data(
      Buffer.from(
        JSON.stringify({
          version: 1,
          id,
          action,
          observation: { version: 1, ...identity, phase: nativePhase, core, device, network }
        }) + '\n'
      )
    )
  }
  const end = vi.fn(() => {
    if (autoExit) gone()
  })
  const nativeSpawn = vi.fn<typeof spawn>(),
    installation: TunInstallation = {
      execution,
      revision: evidence.helper.revision,
      helperSHA256: evidence.helper.helperSHA256,
      coreSHA256: evidence.helper.coreSHA256,
      clientSHA256: '4'.repeat(64)
    }
  let openError: unknown
  let bootstrap:
    | {
        version: number
        action: string
        directory: string
        installationRevision?: string
        projection?: string
        managedMTU?: number
      }
    | undefined
  // All reported device, core and network facts come from this in-memory peer.
  // This composes the actual service/channel logic without a production host,
  // process, descriptor, helper, file, socket or system network operation.
  const service = createTunSessionService({
    execution,
    readCandidate: async () => ({ evidence, recheck }),
    openHost: async (runtime, identity, launch, register) => {
      if (useTransport) {
        // Actual private staging and transport framing, with an in-memory
        // child only. No installed client, core or helper is executed.
        const child = new ChildProcess(),
          input = new PassThrough(),
          output = new PassThrough()
        child.stdin = input
        child.stdout = output
        child.stderr = new PassThrough()
        data = (bytes) => {
          output.emit('data', bytes)
        }
        input.on('data', (bytes: Buffer) => {
          const frame = JSON.parse(bytes.toString()) as Frame
          if (frame.action === 'bootstrap') {
            bootstrap = JSON.parse(bytes.toString())
            return
          }
          frames.push(frame)
          if (!held.has(frame.action)) reply(frame)
        })
        input.on('finish', () => {
          child.emit('close', 0)
        })
        nativeSpawn.mockReturnValue(child)
        channel = await openTunNativeHost(
          installation,
          {
            networkSHA256: '5'.repeat(64),
            protectionSHA256: '6'.repeat(64)
          },
          runtime,
          identity,
          launch,
          register,
          () => service.invalidatePending(),
          {
            readInstallation: async () => installation,
            spawn: nativeSpawn
          }
        ).catch((error: unknown) => {
          openError = error
          throw error
        })
        return channel
      }
      channel = createTunHostChannel(
        {
          write: (text) => {
            const frame = JSON.parse(text) as Frame
            frames.push(frame)
            if (!held.has(frame.action)) reply(frame)
          },
          end,
          onData: (listener) => (data = listener),
          onGone: (listener) => (gone = listener),
          onFault: () => {}
        },
        identity,
        () => service.invalidatePending(),
        1000
      )
      register(channel)
      await channel.ready
      return channel
    },
    confirmStart,
    confirmStop,
    notify,
    now: () => 1000
  })
  async function start() {
    const prepared = await service.prepare(request)
    return service.start({ evidenceId: prepared.evidenceId })
  }
  const frame = (action: string): Frame => {
    const value = frames.find((candidate) => candidate.action === action)
    if (!value) throw new Error('fixture frame missing: ' + action)
    return value
  }
  return {
    service,
    start,
    bootstrap: () => bootstrap,
    openError: () => openError,
    nativeSpawn,
    frames,
    actions: () => frames.map(({ action }) => action),
    held,
    frame,
    reply,
    gone: () => gone(),
    end,
    notify,
    confirmStart,
    confirmStop,
    recheck,
    channel: () => channel,
    preventAutomaticExit: () => (autoExit = false)
  }
}
afterEach(async () => {
  vi.useRealTimers()
  await rm(logDirectory, { recursive: true, force: true })
})

describe('TUN service composed with actual persistent host channel and injected peer', () => {
  it('prepares, starts, confirms stop and retires only after bound restoration and IO exit', async () => {
    const f = fixture(),
      started = await f.start()
    expect(started.state).toMatchObject({ owned: true, traffic: 'forwarding' })
    expect(f.actions()).toEqual(['initialize', 'acquire', 'startCore', 'activate'])
    expect(f.recheck).toHaveBeenCalledTimes(2)
    expect(await f.service.stop({ sessionId: started.state.sessionId })).toMatchObject({
      status: 'restored',
      state: { owned: false, restorationVerified: true, traffic: 'inactive' }
    })
    expect(f.actions()).toEqual([
      'initialize',
      'acquire',
      'startCore',
      'activate',
      'stopCore',
      'release',
      'verifyRestored',
      'dispose'
    ])
    expect(f.end).toHaveBeenCalledOnce()
    expect(f.channel()?.gone()).toBe(true)
    expect(f.service.isBlocking()).toBe(false)
    expect(JSON.stringify(f.frames)).not.toContain('MATCH')
  })

  it('connects managed runtime, private staging, v2 bootstrap and persistent channel through final disposal', async () => {
    const f = fixture('core-managed', true),
      started = await f.start(),
      bootstrap = f.bootstrap()
    expect(f.openError()).toBeUndefined()
    expect(started.state, JSON.stringify({ started, actions: f.actions() })).toMatchObject({
      owned: true,
      traffic: 'forwarding'
    })
    expect(f.nativeSpawn).toHaveBeenCalledWith(
      '/Library/Application Support/Relay/TunManaged/RelayTunClient',
      ['--managed-session'],
      expect.anything()
    )
    expect(bootstrap).toMatchObject({
      version: 2,
      action: 'bootstrap',
      installationRevision: 'a'.repeat(64)
    })
    expect(bootstrap).not.toHaveProperty('projection')
    expect(bootstrap).not.toHaveProperty('managedMTU')
    if (!bootstrap) throw new Error('missing managed bootstrap')
    const configuration = JSON.parse(await readFile(bootstrap.directory + '/config.json', 'utf8'))
    expect(configuration.tun).not.toHaveProperty('file-descriptor')
    expect(configuration.tun.device).toMatch(/^utun[0-9]+$/)
    expect(configuration.rules).toEqual(['MATCH,REJECT'])
    expect(f.actions()).toEqual(['initialize', 'startCore'])
    expect(await f.service.stop({ sessionId: started.state.sessionId })).toMatchObject({
      status: 'restored',
      state: { owned: false, restorationVerified: true }
    })
    expect(f.actions()).toEqual([
      'initialize',
      'startCore',
      'stopCore',
      'release',
      'verifyRestored',
      'dispose'
    ])
    expect(f.nativeSpawn).toHaveBeenCalledOnce()
    await expect(stat(bootstrap.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('sends revocation before a blocked activation resolves and rejects that late activation as start success', async () => {
    const f = fixture()
    f.held.add('activate')
    f.held.add('revokeActivation')
    const starting = f.start()
    await vi.waitFor(() => expect(f.actions()).toContain('activate'))
    f.service.invalidatePending()
    expect(f.actions().slice(-2)).toEqual(['activate', 'revokeActivation'])
    f.reply(f.frame('activate'))
    expect(await starting).toMatchObject({
      status: 'uncertain',
      state: { owned: true, traffic: 'unconfirmed', pending: true }
    })
    expect(f.actions().filter((action) => action === 'revokeActivation')).toHaveLength(1)
    const close = f.service.requestClose()
    expect(f.confirmStop).not.toHaveBeenCalled()
    f.reply(f.frame('revokeActivation'))
    f.held.delete('revokeActivation')
    expect(await close).toBe(true)
    expect(f.confirmStop).toHaveBeenCalledWith(expect.anything(), 'quit')
    expect(f.service.state()).toMatchObject({ owned: false, restorationVerified: true })
    expect(f.actions().filter((action) => action === 'activate')).toHaveLength(1)
  })

  it('keeps an active session when quit consent is cancelled, then recovers through the same held channel', async () => {
    const f = fixture()
    await f.start()
    f.confirmStop.mockResolvedValueOnce(false)
    expect(await f.service.requestClose()).toBe(false)
    expect(f.actions().slice(-1)).toEqual(['revokeActivation'])
    expect(f.service.state()).toMatchObject({ owned: true, traffic: 'unconfirmed' })
    expect((await f.service.inspect()).traffic).toBe('forwarding')
    expect(await f.service.requestClose()).toBe(true)
    expect(f.actions().filter((action) => action === 'initialize')).toHaveLength(1)
    expect(f.actions().filter((action) => action === 'stopCore')).toHaveLength(1)
  })

  it.each(['lateCloseAck', 'lateExit'] as const)(
    'retains terminal recovery across %s timeout and completes without replaying network commands',
    async (mode) => {
      vi.useFakeTimers()
      const f = fixture(),
        started = await f.start(),
        input = { sessionId: started.state.sessionId }
      f.preventAutomaticExit()
      if (mode === 'lateCloseAck') f.held.add('dispose')
      const stopping = f.service.stop(input)
      await vi.waitFor(() => expect(f.actions()).toContain('dispose'))
      await vi.advanceTimersByTimeAsync(1001)
      expect(await stopping).toMatchObject({
        status: 'uncertain',
        state: { owned: true, restorationVerified: false }
      })
      const framesBeforeRetry = f.frames.length
      expect((await f.service.inspect()).phase).toBe('uncertain')
      expect(f.frames).toHaveLength(framesBeforeRetry)
      f.notify.mockImplementation(() => {
        throw new Error('renderer closed')
      })
      f.service.invalidatePending()
      expect(f.frames).toHaveLength(framesBeforeRetry)
      if (mode === 'lateCloseAck') f.reply(f.frame('dispose'))
      f.gone()
      if (mode === 'lateCloseAck') expect((await f.service.stop(input)).status).toBe('restored')
      else expect(await f.service.requestClose()).toBe(true)
      expect(f.frames).toHaveLength(framesBeforeRetry)
      expect(f.service.state()).toMatchObject({ owned: false, restorationVerified: true })
      for (const action of ['stopCore', 'release', 'verifyRestored', 'dispose'])
        expect(f.actions().filter((value) => value === action)).toHaveLength(1)
      expect(f.actions()).not.toContain('revokeActivation')
    }
  )

  it('does not promote forged late closure into restored service ownership', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      started = await f.start(),
      input = { sessionId: started.state.sessionId }
    f.held.add('dispose')
    const stopping = f.service.stop(input)
    await vi.waitFor(() => expect(f.actions()).toContain('dispose'))
    await vi.advanceTimersByTimeAsync(1001)
    expect((await stopping).status).toBe('uncertain')
    f.reply(f.frame('dispose'), { evidenceSHA256: 'f'.repeat(64) })
    f.gone()
    expect((await f.service.stop(input)).status).toBe('uncertain')
    expect(f.service.state()).toMatchObject({ owned: true, restorationVerified: false })
    expect(f.actions().filter((action) => action === 'dispose')).toHaveLength(1)
    expect(f.end).not.toHaveBeenCalled()
  })
})
