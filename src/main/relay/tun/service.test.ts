import { createHash } from 'crypto'
import { chmod, lstat, mkdtemp, rm, rmdir, symlink } from 'fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { inspectRuntimeConfiguration } from '../configuration/schema'
import { validateBoundConfiguration } from '../configuration/checker'
import type { TunRuntimeRuleConfirmation } from '../../../shared/relay/tun-rules'
import type { GeoOriginCandidate } from '../resources/origin-candidate'
import { issueGeoAutomaticPermit } from '../resources/automatic-permit'
import type { RuleProviderResourceCandidate } from '../resources/rule-provider-candidate'
import { createReadonlyFloatingBridge } from '../../../preload/relay-floating'
import type { TunPlanEvidence } from './plan'
import {
  createTunSessionService,
  TunStartFailure,
  type TunHostObservation,
  type TunSessionBinding,
  type TunSessionHost,
  type TunWorkDirectoryProof
} from './service'
import type { TunRuntimeReadResult, TunRuntimeTrafficResult } from './runtime-channel'
import { createTunRulesChannel, type TunRulesChannel, type TunRulesResult } from './rules-channel'
import type {
  TunResourcesChannel,
  TunResourcesChannelResult,
  TunResourceBlobTicket
} from './resources-channel'
import type { TunResourceInbox } from './resource-inbox'
import type { TunRuleProvidersChannel } from './rule-providers-contract'

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
function fixture(
  execution?: 'core-managed',
  httpPort = 18290,
  clocks?: { wall(): number; mono(): number }
) {
  const configuration = {
      port: httpPort,
      mode: 'rule',
      'allow-lan': false,
      'geo-auto-update': false,
      'geox-url': { geoip: '', geosite: '', mmdb: '', asn: '' },
      tun: {
        enable: true,
        device: 'utun',
        stack: 'mixed',
        'auto-route': true,
        'auto-detect-interface': true,
        'dns-hijack': ['any:53'],
        'route-exclude-address': ['10.0.0.0/8'],
        mtu: 1500
      },
      dns: { enable: true, nameserver: ['https://cloudflare-dns.com/dns-query'] },
      proxies: [],
      rules: ['MATCH,REJECT']
    },
    source = JSON.stringify(configuration),
    request = {
      configurationSHA256: hash(source),
      bundleSHA256: hash(JSON.stringify({ configuration, assets: [], pins: [], unresolved: [] }))
    }
  const evidence: TunPlanEvidence = {
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
      runningAsRoot: true,
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
  const events: string[] = []
  if (execution)
    Object.assign(evidence.helper, {
      execution,
      runningAsRoot: false,
      privilegedCoreVerified: true
    })
  let time = 1000,
    binding: TunSessionBinding | undefined,
    current: TunHostObservation | undefined
  function report(phase: TunHostObservation['phase']): TunHostObservation {
    if (!binding) throw new Error('fixture not opened')
    const states: Record<
      TunHostObservation['phase'],
      [TunHostObservation['core'], TunHostObservation['device'], TunHostObservation['network']]
    > = {
      idle: ['none', 'none', 'unchanged'],
      acquired: ['none', 'held', 'unchanged'],
      coreReady: ['running', 'held', 'unchanged'],
      active: ['running', 'held', 'active'],
      coreStopped: ['stopped', 'held', 'active'],
      released: ['stopped', 'released', 'restored'],
      restored: ['stopped', 'absent', 'restored'],
      unknown: ['unknown', 'unknown', 'unknown']
    }
    const [core, device, network] = states[phase]
    return { version: 1, ...binding, phase, core, device, network }
  }
  const stage = (name: string, phase: TunHostObservation['phase']) =>
    vi.fn(async () => {
      events.push(name)
      current = report(phase)
      return structuredClone(current)
    })
  const host: TunSessionHost = {
    acquire: stage('acquire', 'acquired'),
    startCore: stage('startCore', execution ? 'active' : 'coreReady'),
    activate: stage('activate', 'active'),
    inspect: vi.fn(async () => {
      events.push('inspect')
      return structuredClone(current ?? report('idle'))
    }),
    stopCore: stage('stopCore', 'coreStopped'),
    release: stage('release', 'released'),
    verifyRestored: stage('verifyRestored', 'restored'),
    revokeActivation: vi.fn(async () => {
      events.push('revokeActivation')
    }),
    dispose: vi.fn(async () => {
      events.push('dispose')
    })
  }
  const recheck = vi.fn(async () => {
    events.push('recheck')
  })
  const adapters = {
    execution,
    readCandidate: vi.fn(async () => ({ evidence, recheck })),
    openHost: vi.fn(
      async (
        _runtime: Parameters<Parameters<typeof createTunSessionService>[0]['openHost']>[0],
        identity: TunSessionBinding,
        _launch: Parameters<Parameters<typeof createTunSessionService>[0]['openHost']>[2],
        register: (value: TunSessionHost) => void
      ) => {
        events.push('openHost')
        binding = identity
        register(host)
        return host
      }
    ),
    confirmStart: vi.fn(async () => {
      events.push('confirmStart')
      return true
    }),
    confirmStop: vi.fn(async () => {
      events.push('confirmStop')
      return true
    }),
    notify: vi.fn(),
    now: () => clocks?.wall() ?? time,
    monotonicNow: () => clocks?.mono() ?? time
  }
  const service = createTunSessionService(adapters)
  async function start() {
    const prepared = await service.prepare(request)
    return service.start({ evidenceId: prepared.evidenceId })
  }
  return {
    service,
    adapters,
    host,
    events,
    evidence,
    request,
    recheck,
    report,
    start,
    setTime: (value: number) => (time = value),
    setObserved: (value: TunHostObservation) => (current = value)
  }
}

describe('TUN work directory is limited to the live session and current directory identity', () => {
  it('opens the attested private directory and rejects foreign, changed or symlinked paths', async () => {
    const f = fixture('core-managed'),
      prefix = `/private/tmp/relay-session-${process.getuid?.()}-`,
      directory = await mkdtemp(prefix),
      other = await mkdtemp(prefix)
    try {
      const info = await lstat(directory, { bigint: true })
      const proof = { path: directory, device: info.dev.toString(), inode: info.ino.toString() }
      const open = vi.fn(async (_path: string) => {})
      await f.start()
      expect(f.service.captureWorkDirectory()).toBeUndefined()
      const receipt = vi.fn(async (): Promise<TunWorkDirectoryProof | null> => proof)
      f.host.inspectWorkDirectory = receipt
      const captured = f.service.captureWorkDirectory()
      if (!captured) throw new Error('fixture work directory capability missing')
      await captured(open)
      expect(open).toHaveBeenCalledExactlyOnceWith(directory)
      open.mockClear()

      for (const value of [
        null,
        { ...proof, path: directory + '\n' },
        { ...proof, path: '/tmp/' + directory.slice('/private/tmp/'.length) },
        { ...proof, path: other },
        { ...proof, inode: (info.ino + 1n).toString() }
      ]) {
        receipt.mockResolvedValueOnce(value)
        await expect(captured(open)).rejects.toThrow('归属未确认')
      }
      await chmod(directory, 0o755)
      await expect(captured(open)).rejects.toThrow('归属未确认')
      await rmdir(directory)
      await symlink(other, directory)
      await expect(captured(open)).rejects.toThrow('归属未确认')
      expect(open).not.toHaveBeenCalled()
      expect(f.service.state().phase).toBe('active')
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
    }
  })

  it.each(['stop', 'quit'])('discards an in-flight proof during %s', async (action) => {
    const f = fixture('core-managed'),
      started = await f.start(),
      open = vi.fn(async (_path: string) => {})
    let finish!: (proof: TunWorkDirectoryProof) => void
    f.host.inspectWorkDirectory = vi.fn(() => new Promise((resolve) => (finish = resolve)))
    const captured = f.service.captureWorkDirectory()
    if (!captured) throw new Error('fixture work directory capability missing')
    const rejected = expect(captured(open)).rejects.toThrow('归属未确认')
    if (action === 'quit') expect(await f.service.requestClose()).toBe(true)
    else {
      const stopped = await f.service.stop({ sessionId: started.state.sessionId })
      expect(stopped.status).toBe('restored')
    }
    finish({
      path: `/private/tmp/relay-session-${process.getuid?.()}-abc123`,
      device: '2',
      inode: '9'
    })
    await rejected
    await expect(captured(open)).rejects.toThrow('归属未确认')
    expect(f.host.inspectWorkDirectory).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })
})

function resourceFixture() {
  const f = fixture(),
    bytes = Buffer.from('payload:\n  - DOMAIN,example.com\n'),
    sha256 = hash(bytes.toString('utf8')),
    asset = { path: `relay-files/${sha256}.yaml`, sha256, bytes, expectedRules: 1 },
    configuration = {
      ...JSON.parse(f.evidence.configuration),
      'rule-providers': {
        local: {
          type: 'file',
          path: asset.path,
          format: 'yaml',
          behavior: 'classical',
          interval: 0
        }
      },
      rules: ['RULE-SET,local,REJECT', 'MATCH,REJECT']
    },
    pins: TunPlanEvidence['pins'] = [
      {
        namespace: 'resource',
        id: '00000000-0000-0000-0000-000000000001',
        sha256,
        revision: '4'.repeat(64)
      }
    ]
  f.evidence.configuration = JSON.stringify(configuration)
  f.evidence.assets = [asset]
  f.evidence.pins = pins
  f.request.configurationSHA256 = hash(f.evidence.configuration)
  f.evidence.parser.configurationSHA256 = f.request.configurationSHA256
  f.request.bundleSHA256 = hash(
    JSON.stringify({
      configuration,
      assets: [{ path: asset.path, sha256, expectedRules: 1 }],
      pins,
      unresolved: []
    })
  )
  f.recheck.mockImplementation(async () => {
    f.events.push('recheck')
    validateBoundConfiguration(f.evidence.configuration, f.evidence.assets)
    if (hash(f.evidence.configuration) !== f.request.configurationSHA256)
      throw new Error('source changed')
  })
  return { ...f, asset }
}

describe('TUN main-process owned session lifecycle', () => {
  it('refuses an elapsed candidate deadline before requesting confirmation or opening a host', async () => {
    const f = fixture('core-managed')
    Object.assign(f.evidence, { configurationExpiresAt: 1100 })
    const plan = await f.service.prepare(f.request)
    expect(plan.expiresAt).toBe(1100)
    f.setTime(1101)
    expect((await f.service.start({ evidenceId: plan.evidenceId })).status).toBe('failed')
    expect(f.adapters.confirmStart).not.toHaveBeenCalled()
    expect(f.adapters.openHost).not.toHaveBeenCalled()
    expect(f.service.isBlocking()).toBe(false)
  })

  it('refuses a candidate deadline reached during user confirmation without opening a host', async () => {
    const f = fixture('core-managed')
    Object.assign(f.evidence, { configurationExpiresAt: 1100 })
    const plan = await f.service.prepare(f.request)
    f.adapters.confirmStart.mockImplementation(async () => {
      f.setTime(1101)
      return true
    })
    expect((await f.service.start({ evidenceId: plan.evidenceId })).status).toBe('failed')
    expect(f.adapters.openHost).not.toHaveBeenCalled()
    expect(f.host.startCore).not.toHaveBeenCalled()
    expect(f.service.isBlocking()).toBe(false)
  })

  it('preserves Buffer assets for a referenced local rule provider through prepare, start and recheck', async () => {
    const f = resourceFixture(),
      prepared = await f.service.prepare(f.request)
    expect(prepared.readyForConfirmation).toBe(true)
    expect((await f.service.start({ evidenceId: prepared.evidenceId })).status).toBe('started')
    expect(f.recheck).toHaveBeenCalledTimes(2)
    expect(f.adapters.openHost.mock.calls[0][0].configuration).toContain(f.asset.path)
    const launch = f.adapters.openHost.mock.calls[0][2]
    expect(launch.assets).toHaveLength(1)
    expect(Buffer.isBuffer(launch.assets[0].bytes)).toBe(true)
    expect(launch.assets[0].bytes.equals(f.asset.bytes)).toBe(true)
    expect(launch.assets[0].bytes).not.toBe(f.asset.bytes)
    expect(launch.pins).toEqual(f.evidence.pins)
    expect(Buffer.isBuffer(f.asset.bytes)).toBe(true)
  })

  it('rejects a changed original bound resource before acquiring a native host', async () => {
    const f = resourceFixture(),
      prepared = await f.service.prepare(f.request)
    f.asset.bytes[0] = 0
    expect((await f.service.start({ evidenceId: prepared.evidenceId })).status).toBe('failed')
    expect(f.recheck).toHaveBeenCalledOnce()
    expect(f.adapters.openHost).not.toHaveBeenCalled()
  })

  it('keeps its private asset copy intact and rejects source mutation after native core readiness', async () => {
    const f = resourceFixture(),
      prepared = await f.service.prepare(f.request)
    vi.mocked(f.host.startCore).mockImplementation(async () => {
      f.asset.bytes[0] = 0
      return f.report('coreReady')
    })
    expect((await f.service.start({ evidenceId: prepared.evidenceId })).status).toBe('uncertain')
    expect(f.recheck).toHaveBeenCalledTimes(2)
    expect(f.host.startCore).toHaveBeenCalledOnce()
    expect(f.host.activate).not.toHaveBeenCalled()
    expect(f.service.state().owned).toBe(true)
  })

  it('uses the private complete candidate and gates activation on actual native core readiness', async () => {
    const f = fixture(),
      result = await f.start()
    expect(result.status).toBe('started')
    expect(f.events).toEqual([
      'confirmStart',
      'recheck',
      'openHost',
      'acquire',
      'startCore',
      'recheck',
      'activate'
    ])
    expect(result.state).toMatchObject({
      phase: 'active',
      owned: true,
      traffic: 'forwarding',
      protectionVerified: false,
      restorationVerified: false
    })
    expect(f.adapters.openHost.mock.calls[0][0].configuration).toContain('"file-descriptor":3')
    expect(result).not.toHaveProperty('configuration')
    expect(JSON.stringify(result)).not.toContain('nameserver')
  })

  it('consumes a cancelled start proof and never opens a native host', async () => {
    const f = fixture()
    f.adapters.confirmStart.mockResolvedValue(false)
    const prepared = await f.service.prepare(f.request)
    expect((await f.service.start({ evidenceId: prepared.evidenceId })).status).toBe('cancelled')
    await expect(f.service.start({ evidenceId: prepared.evidenceId })).rejects.toThrow('重新准备')
    expect(f.events).toEqual([])
    expect(f.service.isBlocking()).toBe(false)
    expect(f.service.state().phase).toBe('idle')
  })

  it('cannot promote a missing native executor into a start', async () => {
    const f = fixture()
    f.evidence.helper.state = 'missing'
    const plan = await f.service.prepare(f.request)
    expect(plan.readyForConfirmation).toBe(false)
    expect((await f.service.start({ evidenceId: plan.evidenceId })).status).toBe('failed')
    expect(f.adapters.confirmStart).not.toHaveBeenCalled()
    expect(f.adapters.openHost).not.toHaveBeenCalled()
  })

  it.each(['fd', 'path', 'pid', 'coreReady'])(
    'rejects renderer %s claims before reading private data',
    async (key) => {
      const f = fixture()
      await expect(f.service.prepare({ ...f.request, [key]: true })).rejects.toThrow()
      expect(f.adapters.readCandidate).not.toHaveBeenCalled()
      const plan = await f.service.prepare(f.request)
      await expect(f.service.start({ evidenceId: plan.evidenceId, [key]: true })).rejects.toThrow()
      expect(f.adapters.openHost).not.toHaveBeenCalled()
    }
  )

  it('rechecks private source and baseline after confirmation before opening a host', async () => {
    const f = fixture()
    f.recheck.mockRejectedValue(new Error('source changed'))
    expect((await f.start()).status).toBe('failed')
    expect(f.adapters.openHost).not.toHaveBeenCalled()
    expect(f.service.isBlocking()).toBe(false)
    expect(f.service.state().warnings).toContain('TUN启动失败阶段：candidate-recheck。')
    expect(JSON.stringify(f.service.state())).not.toContain('source changed')
  })

  it('distinguishes fixed native recheck failures without exposing underlying data', async () => {
    const f = fixture()
    f.recheck.mockRejectedValue(new TunStartFailure('native-baseline'))
    expect((await f.start()).status).toBe('failed')
    expect(f.service.state().warnings).toContain(
      'TUN启动失败阶段：candidate-recheck/native-baseline。'
    )
    expect(f.adapters.openHost).not.toHaveBeenCalled()
  })

  it('retains recovery ownership and reports the core stage on failure', async () => {
    const f = fixture()
    vi.mocked(f.host.startCore).mockRejectedValue(new Error('/private/secret/token'))
    expect((await f.start()).status).toBe('uncertain')
    expect(f.service.isBlocking()).toBe(true)
    expect(f.service.state().warnings).toContain('TUN启动失败阶段：core-start。')
    expect(JSON.stringify(f.service.state())).not.toContain('/private/secret/token')
    expect(f.host.revokeActivation).toHaveBeenCalledOnce()
  })

  it('invalidates an approval after suspension without performing any lifecycle operation', async () => {
    const f = fixture()
    f.adapters.confirmStart.mockImplementation(async () => {
      f.service.invalidatePending()
      return true
    })
    expect((await f.start()).status).toBe('failed')
    expect(f.adapters.openHost).not.toHaveBeenCalled()
    expect(f.host.stopCore).not.toHaveBeenCalled()
  })

  it('preserves a registered native capability when opening throws after side effects', async () => {
    const f = fixture()
    f.adapters.openHost.mockImplementation(async (_runtime, _binding, _launch, register) => {
      register(f.host)
      throw new Error('partial native opening')
    })
    expect((await f.start()).status).toBe('uncertain')
    expect(f.service.isBlocking()).toBe(true)
    expect(f.service.state().owned).toBe(true)
    expect(f.host.release).not.toHaveBeenCalled()
  })

  it.each(['acquire', 'startCore', 'activate'] as const)(
    'retains the session after a failed %s and does not automatically stop or retry',
    async (method) => {
      const f = fixture()
      vi.mocked(f.host[method]).mockRejectedValue(new Error('native failure'))
      expect((await f.start()).status).toBe('uncertain')
      expect(f.service.state()).toMatchObject({ owned: true, traffic: 'unconfirmed' })
      expect(f.service.isBlocking()).toBe(true)
      expect(f.host.stopCore).not.toHaveBeenCalled()
      expect(f.host.release).not.toHaveBeenCalled()
      if (method !== 'activate') expect(f.host.activate).not.toHaveBeenCalled()
    }
  )

  it('does not activate when a native ready receipt belongs to a different runtime', async () => {
    const f = fixture()
    vi.mocked(f.host.startCore).mockImplementation(async () => ({
      ...f.report('coreReady'),
      runtimeConfigurationSHA256: 'f'.repeat(64)
    }))
    expect((await f.start()).status).toBe('uncertain')
    expect(f.host.activate).not.toHaveBeenCalled()
  })

  it('rechecks again before activation and preserves an acquired device if time expires', async () => {
    const f = fixture()
    vi.mocked(f.host.startCore).mockImplementation(async () => {
      f.setTime(61001)
      return f.report('coreReady')
    })
    expect((await f.start()).status).toBe('uncertain')
    expect(f.host.activate).not.toHaveBeenCalled()
    expect(f.service.state().owned).toBe(true)
  })

  it('does not activate if private source or network recheck changes after core readiness', async () => {
    const f = fixture()
    f.recheck.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('baseline changed'))
    expect((await f.start()).status).toBe('uncertain')
    expect(f.host.startCore).toHaveBeenCalledOnce()
    expect(f.host.activate).not.toHaveBeenCalled()
    expect(f.host.stopCore).not.toHaveBeenCalled()
    expect(f.service.isBlocking()).toBe(true)
  })

  it('requires explicit stop consent and verifies full restoration before disposing ownership', async () => {
    const f = fixture(),
      started = await f.start(),
      input = { sessionId: started.state.sessionId }
    f.events.length = 0
    f.adapters.confirmStop.mockResolvedValueOnce(false)
    expect((await f.service.stop(input)).status).toBe('cancelled')
    expect(f.events).toEqual([])
    expect(f.service.state().owned).toBe(true)
    const stopped = await f.service.stop(input)
    expect(stopped.status).toBe('restored')
    expect(f.events).toEqual(['confirmStop', 'stopCore', 'release', 'verifyRestored', 'dispose'])
    expect(stopped.state).toMatchObject({
      owned: false,
      restorationVerified: true,
      traffic: 'inactive'
    })
    expect(f.service.isBlocking()).toBe(false)
  })

  it.each(['stopCore', 'release', 'verifyRestored', 'dispose'] as const)(
    'retains recovery ownership when %s fails',
    async (method) => {
      const f = fixture(),
        started = await f.start()
      vi.mocked(f.host[method]).mockRejectedValueOnce(new Error('restoration uncertain'))
      const input = { sessionId: started.state.sessionId }
      expect((await f.service.stop(input)).status).toBe('uncertain')
      const stages = {
        stopCore: 'core-stop',
        release: 'device-release',
        verifyRestored: 'restoration-check',
        dispose: 'host-dispose'
      }
      expect(f.service.state().warnings).toContain(`TUN停用失败阶段：${stages[method]}。`)
      expect(f.service.state().warnings.join()).not.toContain('restoration uncertain')
      expect(f.service.state()).toMatchObject({ owned: true, restorationVerified: false })
      expect(f.service.isBlocking()).toBe(true)
      expect((await f.service.stop(input)).status).toBe('restored')
    }
  )

  it('does not release or dispose a device if stopping its own core is not confirmed', async () => {
    const f = fixture(),
      started = await f.start()
    vi.mocked(f.host.stopCore).mockImplementation(async () => ({
      ...f.report('coreStopped'),
      core: 'running'
    }))
    expect((await f.service.stop({ sessionId: started.state.sessionId })).status).toBe('uncertain')
    expect(f.host.release).not.toHaveBeenCalled()
    expect(f.host.dispose).not.toHaveBeenCalled()
  })

  it('does not retire recovery ownership on a restored claim with a still-held device', async () => {
    const f = fixture(),
      started = await f.start()
    vi.mocked(f.host.verifyRestored).mockImplementation(async () => ({
      ...f.report('restored'),
      device: 'held'
    }))
    expect((await f.service.stop({ sessionId: started.state.sessionId })).status).toBe('uncertain')
    expect(f.host.dispose).not.toHaveBeenCalled()
    expect(f.service.state().restorationVerified).toBe(false)
    expect(f.service.isBlocking()).toBe(true)
  })

  it('revokes unexecuted activation on suspension and only observes on recheck', async () => {
    const f = fixture()
    await f.start()
    f.events.length = 0
    f.service.invalidatePending()
    expect(f.service.state().traffic).toBe('unconfirmed')
    await f.service.whenIdle()
    expect((await f.service.inspect()).traffic).toBe('forwarding')
    expect(f.events).toEqual(['revokeActivation', 'inspect'])
    expect(f.host.stopCore).not.toHaveBeenCalled()
    expect(f.host.startCore).toHaveBeenCalledOnce()
  })

  it('refuses overlapping actions while a native acquire is blocked', async () => {
    const f = fixture()
    let release: ((value: TunHostObservation) => void) | undefined
    vi.mocked(f.host.acquire).mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    )
    const started = f.start()
    await vi.waitFor(() => expect(f.host.acquire).toHaveBeenCalledOnce())
    await expect(f.service.prepare(f.request)).rejects.toThrow()
    await expect(f.service.inspect()).rejects.toThrow()
    await expect(f.service.stop({ sessionId: f.service.state().sessionId })).rejects.toThrow()
    release?.(f.report('acquired'))
    expect((await started).status).toBe('started')
  })

  it('retains an acquired device after suspension during native work without starting the core', async () => {
    const f = fixture()
    vi.mocked(f.host.acquire).mockImplementation(async () => {
      f.service.invalidatePending()
      return f.report('acquired')
    })
    expect((await f.start()).status).toBe('uncertain')
    expect(f.host.startCore).not.toHaveBeenCalled()
    expect(f.host.activate).not.toHaveBeenCalled()
    expect(f.host.release).not.toHaveBeenCalled()
    expect(f.service.isBlocking()).toBe(true)
  })

  it('quitting waits for the current writer and confirms recovery through the same held host', async () => {
    const f = fixture()
    await f.start()
    f.events.length = 0
    expect(await f.service.requestClose()).toBe(true)
    expect(f.adapters.confirmStop).toHaveBeenCalledWith(expect.anything(), 'quit')
    expect(f.events).toEqual([
      'revokeActivation',
      'confirmStop',
      'stopCore',
      'release',
      'verifyRestored',
      'dispose'
    ])
  })

  it('sends revocation while activation is still blocked and waits for its acknowledgment', async () => {
    const f = fixture()
    let finishActivation!: (value: TunHostObservation) => void, acknowledgeRevocation!: () => void
    vi.mocked(f.host.activate).mockImplementation(
      () => new Promise((resolve) => (finishActivation = resolve))
    )
    vi.mocked(f.host.revokeActivation).mockImplementation(
      () => new Promise((resolve) => (acknowledgeRevocation = resolve))
    )
    const started = f.start()
    await vi.waitFor(() => expect(f.host.activate).toHaveBeenCalledOnce())
    f.service.invalidatePending()
    expect(f.host.revokeActivation).toHaveBeenCalledOnce()
    expect(f.service.state()).toMatchObject({ phase: 'uncertain', pending: true, owned: true })
    const idle = vi.fn()
    void f.service.whenIdle().then(idle)
    finishActivation(f.report('active'))
    expect((await started).state).toMatchObject({ traffic: 'unconfirmed', pending: true })
    expect(f.host.revokeActivation).toHaveBeenCalledOnce()
    expect(idle).not.toHaveBeenCalled()
    await expect(f.service.inspect()).rejects.toThrow('请等待')
    acknowledgeRevocation()
    await f.service.whenIdle()
    expect(idle).toHaveBeenCalledOnce()
    expect(f.service.state().pending).toBe(false)
    expect(f.host.stopCore).not.toHaveBeenCalled()
    expect(f.host.release).not.toHaveBeenCalled()
  })

  it('revokes a host that registers after suspension and retains it for explicit recovery', async () => {
    const f = fixture(),
      open = f.adapters.openHost.getMockImplementation()
    if (!open) throw new Error('fixture opener missing')
    let registerLate!: () => Promise<void>
    f.adapters.openHost.mockImplementation(
      (...args) =>
        new Promise((resolve) => (registerLate = async () => resolve(await open(...args))))
    )
    const started = f.start()
    await vi.waitFor(() => expect(f.adapters.openHost).toHaveBeenCalledOnce())
    f.service.invalidatePending()
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
    await registerLate()
    expect((await started).status).toBe('uncertain')
    await f.service.whenIdle()
    expect(f.host.revokeActivation).toHaveBeenCalled()
    expect(f.host.acquire).not.toHaveBeenCalled()
    expect(f.service.state().owned).toBe(true)
  })

  it.each(['reject', 'throw'] as const)(
    'keeps failed %s revocation uncertain despite an active status receipt',
    async (failure) => {
      const f = fixture(),
        started = await f.start()
      if (failure === 'throw')
        vi.mocked(f.host.revokeActivation).mockImplementationOnce(() => {
          throw new Error('control unavailable')
        })
      else
        vi.mocked(f.host.revokeActivation).mockRejectedValueOnce(new Error('control unavailable'))
      f.service.invalidatePending()
      await f.service.whenIdle()
      expect((await f.service.inspect()).traffic).toBe('unconfirmed')
      expect(f.service.state()).toMatchObject({ phase: 'uncertain', owned: true })
      expect(f.host.stopCore).not.toHaveBeenCalled()
      expect(f.host.dispose).not.toHaveBeenCalled()
      expect((await f.service.stop({ sessionId: started.state.sessionId })).status).toBe('restored')
    }
  )

  it('joins one pending revocation across suspension and quit before asking to stop', async () => {
    const f = fixture()
    await f.start()
    let acknowledgeRevocation!: () => void
    vi.mocked(f.host.revokeActivation).mockImplementation(
      () => new Promise((resolve) => (acknowledgeRevocation = resolve))
    )
    f.service.invalidatePending()
    const close = f.service.requestClose()
    expect(f.host.revokeActivation).toHaveBeenCalledOnce()
    expect(f.adapters.confirmStop).not.toHaveBeenCalled()
    expect(f.host.stopCore).not.toHaveBeenCalled()
    acknowledgeRevocation()
    expect(await close).toBe(true)
    expect(f.adapters.confirmStop).toHaveBeenCalledWith(expect.anything(), 'quit')
    expect(f.service.state()).toMatchObject({ owned: false, restorationVerified: true })
  })

  it('does not let a throwing notification suppress revocation or strand its waiters', async () => {
    const f = fixture(),
      started = await f.start()
    f.adapters.notify.mockImplementation(() => {
      throw new Error('renderer closed')
    })
    vi.mocked(f.host.revokeActivation).mockRejectedValueOnce(new Error('revocation unavailable'))
    expect(() => f.service.invalidatePending()).not.toThrow()
    expect(f.host.revokeActivation).toHaveBeenCalledOnce()
    await f.service.whenIdle()
    expect(f.service.state()).toMatchObject({ owned: true, pending: false, phase: 'uncertain' })
    expect((await f.service.stop({ sessionId: started.state.sessionId })).status).toBe('restored')
  })

  it('preserves terminal recovery after disposal fails and retries only that same host disposal', async () => {
    const f = fixture(),
      started = await f.start(),
      input = { sessionId: started.state.sessionId }
    vi.mocked(f.host.dispose).mockRejectedValueOnce(new Error('exit timeout'))
    expect((await f.service.stop(input)).status).toBe('uncertain')
    expect(f.service.state()).toMatchObject({ owned: true, restorationVerified: false })
    expect((await f.service.inspect()).phase).toBe('uncertain')
    expect(f.host.inspect).not.toHaveBeenCalled()
    await expect(
      f.service.stop({ sessionId: '12345678-1234-1234-1234-123456789abc' })
    ).rejects.toThrow('已经变化')
    f.events.length = 0
    expect((await f.service.stop(input)).status).toBe('restored')
    expect(f.events).toEqual(['confirmStop', 'dispose'])
    expect(f.host.stopCore).toHaveBeenCalledOnce()
    expect(f.host.release).toHaveBeenCalledOnce()
    expect(f.host.verifyRestored).toHaveBeenCalledOnce()
    expect(f.host.dispose).toHaveBeenCalledTimes(2)
  })

  it('finishes a previously restored host on quit without repeating network recovery', async () => {
    const f = fixture(),
      started = await f.start()
    vi.mocked(f.host.dispose).mockRejectedValueOnce(new Error('exit timeout'))
    await f.service.stop({ sessionId: started.state.sessionId })
    vi.mocked(f.host.revokeActivation).mockImplementation(() => new Promise(() => {}))
    f.events.length = 0
    expect(await f.service.requestClose()).toBe(true)
    expect(f.events).toEqual(['confirmStop', 'dispose'])
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
    expect(f.service.state()).toMatchObject({ owned: false, restorationVerified: true })
  })

  it('refuses inherited observation objects from a native adapter', async () => {
    const f = fixture()
    vi.mocked(f.host.startCore).mockImplementation(async () =>
      Object.assign(Object.create({ injected: true }), f.report('coreReady'))
    )
    expect((await f.start()).status).toBe('uncertain')
    expect(f.host.activate).not.toHaveBeenCalled()
    expect(f.service.state().owned).toBe(true)
  })
})

describe('Mihomo-owned TUN session orchestration', () => {
  const readable = () => {
    const f = fixture('core-managed')
    let mode: 'rule' | 'global' | 'direct' = 'rule',
      available = true
    const capture = vi.fn(async (): Promise<TunRuntimeReadResult> => {
      const runtime = f.adapters.openHost.mock.calls[0][0]
      return {
        status: 'captured',
        snapshot: {
          originalLoadedSHA256: runtime.runtimeConfigurationSHA256,
          originalLoadedBytes: Buffer.byteLength(runtime.configuration),
          mode,
          ports: [{ kind: 'http', port: 18290, ownership: 'held-child-pcb-v1' }]
        }
      }
    })
    Object.assign(f.host, { runtimeReader: { capture, isAvailable: () => available } })
    return {
      ...f,
      capture,
      mode: (value: typeof mode) => {
        mode = value
      },
      gone: () => {
        available = false
      }
    }
  }
  it('publishes only fully active loaded bytes and projects observed mode without reading a candidate again', async () => {
    const f = readable(),
      signal = new AbortController().signal
    await f.service.prepare(f.request)
    expect(await f.service.captureRuntime(18290, signal)).toEqual({ status: 'unsupported' })
    expect(f.capture).not.toHaveBeenCalled()
    const started = await f.start()
    const captured = await f.service.captureRuntime(18290, signal)
    if (captured.status !== 'captured') throw new Error('capture missing')
    const runtime = f.adapters.openHost.mock.calls[0][0]
    expect(captured.capture.snapshot).toMatchObject({
      instanceId: started.state.sessionId,
      revision: runtime.runtimeConfigurationSHA256,
      proxyPort: 18290,
      source: { kind: 'tun-managed', sessionId: started.state.sessionId }
    })
    expect(JSON.parse(captured.capture.snapshot.configuration)).toEqual(
      JSON.parse(runtime.configuration)
    )
    expect(captured.capture.isCurrent()).toBe(true)
    f.mode('global')
    await captured.capture.assertOwner(signal)
    expect(captured.capture.isOwnerLive()).toBe(true)
    expect(captured.capture.isCurrent()).toBe(false)
    const next = await f.service.captureRuntime(18290, signal)
    if (next.status !== 'captured') throw new Error('capture missing')
    expect(JSON.parse(next.capture.snapshot.configuration).mode).toBe('global')
    expect(next.capture.snapshot.revision).toBe(runtime.runtimeConfigurationSHA256)
    expect(f.host.inspect).not.toHaveBeenCalled()
    expect(f.host.stopCore).not.toHaveBeenCalled()
  })
  it('keeps old hosts unsupported without sending any read or lifecycle command', async () => {
    const f = fixture('core-managed')
    await f.start()
    const before = [...f.events]
    expect(await f.service.captureRuntime(18290, new AbortController().signal)).toEqual({
      status: 'unsupported'
    })
    expect(f.events).toEqual(before)
    expect(f.service.state().phase).toBe('active')
  })
  it.each(['wrong-hash', 'wrong-size', 'wrong-port', 'throw', 'busy'])(
    'isolates %s read failure from the active TUN and recovery lifecycle',
    async (failure) => {
      const f = readable(),
        signal = new AbortController().signal
      await f.start()
      const value = await f.capture()
      if (value.status !== 'captured') throw new Error('fixture missing')
      if (failure === 'throw') f.capture.mockRejectedValueOnce(new Error('read pipe failed'))
      else if (failure === 'busy') f.capture.mockResolvedValueOnce({ status: 'busy' })
      else
        f.capture.mockResolvedValueOnce({
          status: 'captured',
          snapshot: {
            ...value.snapshot,
            ...(failure === 'wrong-hash' ? { originalLoadedSHA256: 'e'.repeat(64) } : {}),
            ...(failure === 'wrong-size' ? { originalLoadedBytes: 1 } : {}),
            ...(failure === 'wrong-port'
              ? { ports: [{ kind: 'http', port: 18291, ownership: 'held-child-pcb-v1' }] }
              : {})
          }
        })
      expect((await f.service.captureRuntime(18290, signal)).status).toBe(
        failure === 'busy' ? 'busy' : 'unavailable'
      )
      expect(f.service.state()).toMatchObject({
        phase: 'active',
        owned: true,
        traffic: 'forwarding'
      })
      expect(f.host.revokeActivation).not.toHaveBeenCalled()
      expect(f.host.stopCore).not.toHaveBeenCalled()
      expect(f.host.inspect).not.toHaveBeenCalled()
    }
  )
  it('does not wait for a pending read before stopping the owned core and rejects the late receipt', async () => {
    const f = readable(),
      finish = Promise.withResolvers<TunRuntimeReadResult>(),
      signal = new AbortController().signal
    await f.start()
    const value = await f.capture()
    f.capture.mockImplementationOnce(() => finish.promise)
    const pending = f.service.captureRuntime(18290, signal)
    await Promise.resolve()
    expect((await f.service.stop({ sessionId: f.service.state().sessionId })).status).toBe(
      'restored'
    )
    expect(f.host.stopCore).toHaveBeenCalledOnce()
    finish.resolve(value)
    expect(await pending).toEqual({ status: 'unavailable' })
  })
  it('keeps the owner live across a held ordinary inspect but prevents a fresh capture until it settles', async () => {
    const f = readable(),
      signal = new AbortController().signal
    await f.start()
    const captured = await f.service.captureRuntime(18290, signal)
    if (captured.status !== 'captured') throw new Error('capture missing')
    const finish = Promise.withResolvers<TunHostObservation>()
    vi.mocked(f.host.inspect).mockImplementationOnce(() => finish.promise)
    const pending = f.service.inspect()
    expect(captured.capture.isOwnerLive()).toBe(true)
    expect(captured.capture.isCurrent()).toBe(false)
    expect(await f.service.captureRuntime(18290, signal)).toEqual({ status: 'busy' })
    finish.resolve(f.report('active'))
    await pending
    expect(captured.capture.isCurrent()).toBe(true)
    f.gone()
    expect(captured.capture.isOwnerLive()).toBe(false)
    expect(f.service.state().phase).toBe('active')
  })
  it('starts the core once without acquiring or activating a helper-owned device', async () => {
    const f = fixture('core-managed')
    expect((await f.start()).status).toBe('started')
    expect(f.host.acquire).not.toHaveBeenCalled()
    expect(f.host.activate).not.toHaveBeenCalled()
    expect(f.host.startCore).toHaveBeenCalledTimes(1)
    const runtime = f.adapters.openHost.mock.calls[0][0]
    expect(runtime.version).toBe(2)
    expect(JSON.parse(runtime.configuration).tun).not.toHaveProperty('file-descriptor')
    expect((await f.service.stop({ sessionId: f.service.state().sessionId })).status).toBe(
      'restored'
    )
    expect(f.host.stopCore).toHaveBeenCalledTimes(1)
    expect(f.host.verifyRestored).toHaveBeenCalledTimes(1)
  })
  it('does not accept the old no-network coreReady phase as self-managed TUN activation', async () => {
    const f = fixture('core-managed')
    f.host.startCore = vi.fn(async () => f.report('coreReady'))
    expect((await f.start()).status).toBe('uncertain')
    expect(f.service.state().owned).toBe(true)
    expect(f.host.activate).not.toHaveBeenCalled()
    expect((await f.service.stop({ sessionId: f.service.state().sessionId })).status).toBe(
      'restored'
    )
  })
  it('retains recovery after a core launch error and does not repeat startup', async () => {
    const f = fixture('core-managed')
    f.host.startCore = vi.fn(async () => {
      throw new Error('owned child readiness failed')
    })
    expect((await f.start()).status).toBe('uncertain')
    expect(f.service.state().owned).toBe(true)
    expect(f.host.startCore).toHaveBeenCalledTimes(1)
    expect((await f.service.stop({ sessionId: f.service.state().sessionId })).status).toBe(
      'restored'
    )
    expect(f.host.startCore).toHaveBeenCalledTimes(1)
  })
})

function rulesFixture() {
  const f = fixture('core-managed')
  let disabled = false
  const snapshot = () => ({
      configurationRevision: f.adapters.openHost.mock.calls[0][1].runtimeConfigurationSHA256,
      rulesSHA256: 'f'.repeat(64),
      rules: [{ index: 0, type: 'Domain', payload: 'fixture.invalid', proxy: 'REJECT', disabled }]
    }),
    channel = {
      read: vi.fn(async (_signal: AbortSignal, assertUI: () => void): Promise<TunRulesResult> => {
        assertUI()
        return { status: 'snapshot', snapshot: snapshot() }
      }),
      change: vi.fn(
        async (
          input: Parameters<TunRulesChannel['change']>[0],
          _signal: AbortSignal,
          assertUI: () => void
        ): Promise<TunRulesResult> => {
          assertUI()
          disabled = input.disabled
          return { status: 'changed', snapshot: snapshot() }
        }
      ),
      cancel: vi.fn(async () => {}),
      invalidate: vi.fn(),
      isAvailable: vi.fn(() => true),
      isBusy: vi.fn(() => false),
      whenIdle: vi.fn(async () => {})
    } satisfies TunRulesChannel,
    confirmRule = vi.fn(async (_report: TunRuntimeRuleConfirmation) => true)
  Object.assign(f.host, { rulesChannel: channel })
  Object.assign(f.adapters, { confirmRule })
  return {
    ...f,
    channel,
    confirmRule,
    snapshot,
    selection: () => ({
      sessionId: f.service.state().sessionId,
      configurationRevision: snapshot().configurationRevision,
      rulesSHA256: snapshot().rulesSHA256,
      index: 0,
      disabled: true
    }),
    setDisabled: (value: boolean) => {
      disabled = value
    }
  }
}
function geoFixture() {
  const f = fixture('core-managed'),
    bytes = Buffer.from('private new Geo fixture'),
    sha256 = hash(bytes.toString()),
    origin: GeoOriginCandidate['origin'] = {
      id: '33333333-3333-4333-8333-333333333333',
      revision: 'e'.repeat(64),
      originRevision: 'a'.repeat(64),
      descriptor: { name: 'Geo fixture', kind: 'geosite-dat', behavior: null, selector: 'CN' },
      origin: 'https://fixture.invalid',
      proxyPort: 18191,
      hasPrivateHeaders: true,
      expectedSHA256: '',
      autoIntent: { requested: false, schedule: { kind: 'manual' } },
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z'
    },
    candidate = {
      origin,
      job: { descriptor: origin.descriptor, bytes, sha256 },
      recheck: vi.fn(async () => {})
    } satisfies GeoOriginCandidate,
    ticket: TunResourceBlobTicket = {
      blobId: '44444444-4444-4444-8444-444444444444',
      kind: 'geosite-dat',
      sha256,
      bytes: bytes.length,
      selector: 'CN'
    }
  let activeSHA = '1'.repeat(64),
    generationSHA = '2'.repeat(64)
  const snapshot = () => ({
      configurationRevision: f.adapters.openHost.mock.calls[0][1].runtimeConfigurationSHA256,
      generationSHA256: generationSHA,
      resources: [
        { kind: 'geosite-dat' as const, sha256: activeSHA, bytes: bytes.length, active: true }
      ]
    }),
    channel = {
      read: vi.fn(
        async (_signal: AbortSignal, live: () => void): Promise<TunResourcesChannelResult> => {
          live()
          return { status: 'snapshot', snapshot: snapshot() }
        }
      ),
      replace: vi.fn(
        async (
          input: Parameters<TunResourcesChannel['replace']>[0],
          _signal: AbortSignal,
          live: () => void
        ): Promise<TunResourcesChannelResult> => {
          live()
          activeSHA = input.newSHA256
          generationSHA = '3'.repeat(64)
          return { status: 'updated', snapshot: snapshot() }
        }
      ),
      discardBlob: vi.fn(
        async (
          _ticket: TunResourceBlobTicket
        ): Promise<'discarded' | 'absent' | 'busy' | 'unavailable'> => 'discarded'
      ),
      cancel: vi.fn(async () => {}),
      invalidate: vi.fn(),
      isAvailable: vi.fn(() => true),
      isBusy: vi.fn(() => false),
      whenIdle: vi.fn(async () => {})
    } satisfies TunResourcesChannel,
    report = () => ({
      directory: '/private/test-fixture-only',
      acceptingWrites: false,
      pending: false,
      handlesClosed: true,
      reservedBytes: 0,
      retained: [],
      diagnostics: []
    }),
    inbox = {
      directory: '/private/test-fixture-only',
      stage: vi.fn(
        async (_job: GeoOriginCandidate['job'], _signal: AbortSignal, live: () => void) => {
          live()
          return { ...ticket }
        }
      ),
      stageRuleProvider: vi.fn(async () => {
        throw new Error('Geo fixture has no rule-provider staging capability.')
      }),
      acknowledgeDiscard: vi.fn(),
      retained: report,
      isBusy: () => false,
      whenIdle: async () => {},
      dispose: async () => report()
    } satisfies TunResourceInbox,
    readCandidate = vi.fn(async () => candidate),
    confirm = vi.fn(async () => true)
  Object.assign(f.host, { resourcesChannel: channel, resourceInbox: inbox })
  Object.assign(f.adapters, { readResourceCandidate: readCandidate, confirmResource: confirm })
  return {
    ...f,
    channel,
    inbox,
    candidate,
    ticket,
    readCandidate,
    confirm,
    snapshot,
    selection: () => ({
      sessionId: f.service.state().sessionId,
      configurationRevision: snapshot().configurationRevision,
      expectedGenerationSHA256: snapshot().generationSHA256,
      origin: { id: origin.id, revision: origin.revision }
    })
  }
}

describe('TUN Geo resource source-to-active scope', () => {
  it('keeps an exact private owner stable across its own read and update busy state', async () => {
    const f = geoFixture()
    await f.start()
    const id = String(f.service.state().sessionId),
      owner = f.service.automaticResourceOwner(id)
    expect(owner).toBeDefined()
    if (!owner) throw new Error('missing fixture owner')
    expect(f.service.automaticResourceOwner(id)).toBe(owner)
    f.candidate.origin.autoIntent = { requested: true, schedule: { kind: 'interval', minutes: 1 } }
    const permit = issueGeoAutomaticPermit(f.candidate.origin, owner)
    expect(
      (await f.service.replaceResourceScheduled(f.selection(), permit, () => owner.assertCurrent()))
        .status
    ).toBe('updated')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.service.automaticResourceOwner(id)).toBe(owner)
    expect(f.host.stopCore).not.toHaveBeenCalled()
  })
  it('does not turn a cache-only or cloned token into an active replacement grant', async () => {
    const f = geoFixture()
    await f.start()
    f.candidate.origin.autoIntent = { requested: true, schedule: { kind: 'interval', minutes: 1 } }
    const cache = issueGeoAutomaticPermit(f.candidate.origin)
    expect((await f.service.replaceResourceScheduled(f.selection(), cache, () => {})).status).toBe(
      'cancelled'
    )
    expect(
      (await f.service.replaceResourceScheduled(f.selection(), structuredClone(cache), () => {}))
        .status
    ).toBe('cancelled')
    expect(f.inbox.stage).not.toHaveBeenCalled()
    expect(f.channel.replace).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('does not cancel granted background work merely because an interactive view disappears', async () => {
    const f = geoFixture()
    await f.start()
    const owner = f.service.automaticResourceOwner(String(f.service.state().sessionId))
    if (!owner) throw new Error('missing fixture owner')
    f.candidate.origin.autoIntent = { requested: true, schedule: { kind: 'interval', minutes: 1 } }
    const permit = issueGeoAutomaticPermit(f.candidate.origin, owner),
      gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>(),
      replace = f.channel.replace.getMockImplementation()
    if (!replace) throw new Error('missing fixture replace')
    let signal: AbortSignal | undefined
    f.channel.replace.mockImplementationOnce(async (...args) => {
      signal = args[1]
      entered.resolve()
      await gate.promise
      return replace(...args)
    })
    const pending = f.service.replaceResourceScheduled(f.selection(), permit, () =>
      owner.assertCurrent()
    )
    await entered.promise
    f.service.invalidateInteractiveResources()
    expect(signal?.aborted).toBe(false)
    expect(f.service.isBusy()).toBe(true)
    gate.resolve()
    expect((await pending).status).toBe('updated')
  })
  it('never recovers an automatic owner after resource authority becomes uncertain', async () => {
    const f = geoFixture()
    await f.start()
    const id = String(f.service.state().sessionId),
      owner = f.service.automaticResourceOwner(id)
    if (!owner) throw new Error('missing fixture owner')
    f.candidate.origin.autoIntent = { requested: true, schedule: { kind: 'interval', minutes: 1 } }
    const permit = issueGeoAutomaticPermit(f.candidate.origin, owner)
    f.channel.replace.mockResolvedValueOnce({ status: 'uncertain' })
    expect(
      (await f.service.replaceResourceScheduled(f.selection(), permit, () => owner.assertCurrent()))
        .status
    ).toBe('uncertain')
    expect(() => owner.assertCurrent()).toThrow()
    expect(f.service.automaticResourceOwner(id)).toBeUndefined()
    expect((await f.service.inspect(undefined)).phase).toBe('active')
    expect(f.service.automaticResourceOwner(id)).toBeUndefined()
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
  })
  it('reads an active opaque generation without changing sources, staging files or invoking consent', async () => {
    const f = geoFixture()
    await f.start()
    expect(
      await f.service.readResources({ sessionId: f.service.state().sessionId }, () => {})
    ).toEqual({
      status: 'snapshot',
      sessionId: f.service.state().sessionId,
      snapshot: { ...f.snapshot(), sessionId: f.service.state().sessionId }
    })
    expect(f.readCandidate).not.toHaveBeenCalled()
    expect(f.inbox.stage).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('binds consent, source rechecks and the producer ticket to one active replacement and cleanup ACK', async () => {
    const f = geoFixture()
    await f.start()
    const selected = f.selection()
    const result = await f.service.replaceResource(selected, () => {})
    expect(result.status).toBe('updated')
    expect(f.readCandidate).toHaveBeenCalledWith(selected.origin)
    expect(f.candidate.recheck).toHaveBeenCalledTimes(3)
    expect(f.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: selected.sessionId,
        configurationRevision: selected.configurationRevision,
        expectedGenerationSHA256: selected.expectedGenerationSHA256,
        newSHA256: f.ticket.sha256,
        oldSHA256: '1'.repeat(64)
      })
    )
    expect(f.channel.replace).toHaveBeenCalledWith(
      {
        blobId: f.ticket.blobId,
        kind: f.ticket.kind,
        bytes: f.ticket.bytes,
        selector: f.ticket.selector,
        configurationRevision: selected.configurationRevision,
        expectedGenerationSHA256: selected.expectedGenerationSHA256,
        oldSHA256: '1'.repeat(64),
        newSHA256: f.ticket.sha256
      },
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(f.channel.discardBlob).toHaveBeenCalledWith(f.ticket)
    expect(f.inbox.acknowledgeDiscard).toHaveBeenCalledWith(f.ticket)
    expect(f.service.state().phase).toBe('active')
    expect(f.host.stopCore).not.toHaveBeenCalled()
  })
  it('default-cancels a declined Native dialog before staging or replacing', async () => {
    const f = geoFixture()
    await f.start()
    f.confirm.mockResolvedValue(false)
    expect((await f.service.replaceResource(f.selection(), () => {})).status).toBe('cancelled')
    expect(f.inbox.stage).not.toHaveBeenCalled()
    expect(f.channel.replace).not.toHaveBeenCalled()
  })
  it.each(['configurationRevision', 'expectedGenerationSHA256'] as const)(
    'rejects stale selected %s before any cache or confirmation work',
    async (field) => {
      const f = geoFixture()
      await f.start()
      const selected = f.selection()
      selected[field] = '0'.repeat(64)
      expect((await f.service.replaceResource(selected, () => {})).status).toBe('stale')
      expect(f.readCandidate).not.toHaveBeenCalled()
      expect(f.confirm).not.toHaveBeenCalled()
    }
  )
  it('rejects source edits observed after the human dialog without writing a stage', async () => {
    const f = geoFixture()
    await f.start()
    f.candidate.recheck.mockRejectedValueOnce(new Error('private-cache-path'))
    expect((await f.service.replaceResource(f.selection(), () => {})).status).toBe('unavailable')
    expect(f.inbox.stage).not.toHaveBeenCalled()
    expect(f.channel.replace).not.toHaveBeenCalled()
  })
  it('keeps busy and only revokes resource authority while a Native dialog remains held', async () => {
    const f = geoFixture(),
      gate = Promise.withResolvers<boolean>()
    await f.start()
    f.confirm.mockReturnValueOnce(gate.promise)
    const pending = f.service.replaceResource(f.selection(), () => {})
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce())
    f.service.invalidateResources()
    expect(f.service.isBusy()).toBe(true)
    expect(f.service.state().phase).toBe('active')
    gate.resolve(true)
    expect((await pending).status).toBe('cancelled')
    expect(f.channel.replace).not.toHaveBeenCalled()
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
    expect(f.host.stopCore).not.toHaveBeenCalled()
  })
  it('withholds a late applied result after UI loss and cannot adopt it by an explicit reread', async () => {
    const f = geoFixture()
    await f.start()
    let live = true
    const replace = f.channel.replace.getMockImplementation()
    if (!replace) throw new Error('fixture replace adapter absent')
    f.channel.replace.mockImplementationOnce(async (...args) => {
      const result = await replace(...args)
      live = false
      return result
    })
    const result = await f.service.replaceResource(f.selection(), () => {
      if (!live) throw new Error('scope')
    })
    expect(result).toEqual({ status: 'uncertain', sessionId: f.service.state().sessionId })
    const reads = f.channel.read.mock.calls.length
    expect(
      await f.service.readResources({ sessionId: f.service.state().sessionId }, () => {})
    ).toEqual({ status: 'uncertain', sessionId: f.service.state().sessionId })
    expect(f.channel.read).toHaveBeenCalledTimes(reads)
    expect((await f.service.inspect(undefined)).phase).toBe('active')
    expect(f.host.stopCore).not.toHaveBeenCalled()
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
  })
  it('isolates uncertain Native replacements while preserving lifecycle and other capabilities', async () => {
    const f = geoFixture()
    await f.start()
    f.channel.replace.mockResolvedValueOnce({ status: 'uncertain' })
    expect((await f.service.replaceResource(f.selection(), () => {})).status).toBe('uncertain')
    expect(
      (await f.service.readResources({ sessionId: f.service.state().sessionId }, () => {})).status
    ).toBe('uncertain')
    expect(f.service.state().phase).toBe('active')
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
  })
  it('never releases a producer ticket after an unavailable cleanup receipt', async () => {
    const f = geoFixture()
    await f.start()
    f.channel.discardBlob.mockResolvedValueOnce('unavailable')
    expect((await f.service.replaceResource(f.selection(), () => {})).status).toBe('updated')
    expect(f.inbox.acknowledgeDiscard).not.toHaveBeenCalled()
  })
  it('retains the scope anchor through end observers and prevents reentrant work admission', async () => {
    const f = geoFixture()
    await f.start()
    let busyAtEnd = false
    f.adapters.notify.mockImplementation(() => {
      if (!f.service.state().pending) {
        busyAtEnd = f.service.isBusy()
        f.service.invalidateResources()
      }
    })
    expect((await f.service.replaceResource(f.selection(), () => {})).status).toBe('uncertain')
    expect(busyAtEnd).toBe(true)
    expect(f.service.isBusy()).toBe(false)
    expect(f.host.stopCore).not.toHaveBeenCalled()
  })
  it('does not accept a producer ticket for a different body or selector', async () => {
    const f = geoFixture()
    await f.start()
    f.inbox.stage.mockResolvedValueOnce({ ...f.ticket, selector: 'OTHER' })
    expect((await f.service.replaceResource(f.selection(), () => {})).status).toBe('unavailable')
    expect(f.channel.replace).not.toHaveBeenCalled()
  })
})

function connectedRulesPipe(f: ReturnType<typeof rulesFixture>) {
  const frames: Record<string, unknown>[] = []
  let data = (_bytes: Buffer): void => {}
  const identity = f.adapters.openHost.mock.calls[0][1],
    channel = createTunRulesChannel(
      {
        write: (line) => {
          frames.push(JSON.parse(line))
        },
        onData: (callback) => {
          data = callback
        },
        onGone: () => {},
        onFault: () => {},
        close: () => {}
      },
      { ...identity, launchClientSHA256: 'c'.repeat(64), installationRevision: 'd'.repeat(64) }
    ),
    send = (raw: unknown) => data(Buffer.from(JSON.stringify(raw) + '\n')),
    reply = (id: number, status: string, fields = {}) =>
      send({
        version: 1,
        id,
        action: frames.find((v) => v.id === id)?.action,
        ...identity,
        status,
        pending: false,
        ...fields
      })
  Object.assign(f.host, { rulesChannel: channel })
  send({
    version: 1,
    kind: 'hello',
    capability: 'runtime-rules-v1',
    ...identity,
    launchClientSHA256: 'c'.repeat(64),
    installationRevision: 'd'.repeat(64)
  })
  return { frames, channel, reply }
}
describe('TUN rules service scoped logical operations', () => {
  it('keeps old clients unsupported and returns a session-bound table without any full session state', async () => {
    const old = fixture('core-managed')
    await old.start()
    expect(
      await old.service.readRules({ sessionId: old.service.state().sessionId }, () => {})
    ).toMatchObject({ status: 'unsupported' })
    const f = rulesFixture()
    await f.start()
    const result = await f.service.readRules({ sessionId: f.service.state().sessionId }, () => {})
    expect(result).toEqual({
      status: 'snapshot',
      sessionId: f.service.state().sessionId,
      snapshot: { ...f.snapshot(), sessionId: f.service.state().sessionId }
    })
    expect(result).not.toHaveProperty('state')
    expect(f.confirmRule).not.toHaveBeenCalled()
  })
  it('defaults missing confirmation to cancel before any short prepare delegation', async () => {
    const f = rulesFixture()
    await f.start()
    Object.assign(f.adapters, { confirmRule: undefined })
    expect(await f.service.changeRule(f.selection(), () => {})).toMatchObject({
      status: 'cancelled'
    })
    expect(f.channel.change).not.toHaveBeenCalled()
    expect(f.host.stopCore).not.toHaveBeenCalled()
    expect(f.service.state().phase).toBe('active')
  })
  it('holds one busy scope across read, held Native confirmation, change and the real channel idle boundary', async () => {
    const f = rulesFixture(),
      consent = Promise.withResolvers<boolean>(),
      idle = Promise.withResolvers<void>()
    await f.start()
    f.confirmRule.mockImplementation(() => consent.promise)
    const pending = f.service.changeRule(f.selection(), () => {})
    await vi.waitFor(() => expect(f.confirmRule).toHaveBeenCalledOnce())
    expect(f.service.state().pending).toBe(true)
    expect(f.channel.change).not.toHaveBeenCalled()
    expect(
      await f.service.readRules({ sessionId: f.service.state().sessionId }, () => {})
    ).toMatchObject({ status: 'busy' })
    let finished = false
    void f.service.whenIdle().then(() => {
      finished = true
    })
    f.channel.whenIdle.mockImplementation(() => idle.promise)
    consent.resolve(true)
    await vi.waitFor(() => expect(f.channel.change).toHaveBeenCalledOnce())
    expect(finished).toBe(false)
    expect(f.service.isBusy()).toBe(true)
    expect(f.confirmRule.mock.calls[0][0]).toEqual({
      sessionId: f.selection().sessionId,
      configurationRevision: f.selection().configurationRevision,
      rulesSHA256: f.selection().rulesSHA256,
      disabled: true,
      rule: { ...f.snapshot().rules[0], disabled: false }
    })
    idle.resolve()
    expect((await pending).status).toBe('changed')
    await f.service.whenIdle()
    expect(finished).toBe(true)
    expect(f.service.state().phase).toBe('active')
  })
  it('returns a fresh already-desired bit without Native or another prepare', async () => {
    const f = rulesFixture()
    await f.start()
    f.setDisabled(true)
    expect((await f.service.changeRule(f.selection(), () => {})).status).toBe('unchanged')
    expect(f.confirmRule).not.toHaveBeenCalled()
    expect(f.channel.change).not.toHaveBeenCalled()
  })
  it.each(['revision', 'table', 'index'])(
    'rejects stale concrete %s before Native confirmation',
    async (field) => {
      const f = rulesFixture()
      await f.start()
      const selection = f.selection()
      if (field === 'revision') selection.configurationRevision = '0'.repeat(64)
      if (field === 'table') selection.rulesSHA256 = '0'.repeat(64)
      if (field === 'index') selection.index = 9
      expect((await f.service.changeRule(selection, () => {})).status).toBe('stale')
      expect(f.confirmRule).not.toHaveBeenCalled()
      expect(f.channel.change).not.toHaveBeenCalled()
    }
  )
  it('rechecks an eventless UI loss after Native and sends no change delegation', async () => {
    const f = rulesFixture()
    let live = true
    await f.start()
    f.confirmRule.mockImplementation(async () => {
      live = false
      return true
    })
    expect(
      (
        await f.service.changeRule(f.selection(), () => {
          if (!live) throw new Error('PRIVATE')
        })
      ).status
    ).toBe('cancelled')
    expect(f.channel.change).not.toHaveBeenCalled()
    expect(f.service.state().phase).toBe('active')
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
  })
  it('invalidates only rules during a held dialog and keeps busy until that dialog really returns', async () => {
    const f = rulesFixture(),
      consent = Promise.withResolvers<boolean>()
    await f.start()
    f.confirmRule.mockImplementation(() => consent.promise)
    const pending = f.service.changeRule(f.selection(), () => {})
    await vi.waitFor(() => expect(f.confirmRule).toHaveBeenCalledOnce())
    f.service.invalidateRules()
    expect(f.service.state().phase).toBe('active')
    expect(f.service.isBusy()).toBe(true)
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
    expect(f.host.stopCore).not.toHaveBeenCalled()
    consent.resolve(true)
    expect((await pending).status).toBe('cancelled')
    expect(f.channel.change).not.toHaveBeenCalled()
  })
  it('rejects source or capability replacement after read before native consent', async () => {
    const f = rulesFixture()
    await f.start()
    f.channel.read.mockImplementation(async () => {
      Object.assign(f.host, { rulesChannel: undefined })
      return { status: 'snapshot', snapshot: f.snapshot() }
    })
    expect((await f.service.changeRule(f.selection(), () => {})).status).toBe('cancelled')
    expect(f.confirmRule).not.toHaveBeenCalled()
    expect(f.channel.change).not.toHaveBeenCalled()
    expect(f.service.state().phase).toBe('active')
  })
  it('rejects a mismatched loaded-source SHA before returning a candidate or confirming', async () => {
    const f = rulesFixture()
    await f.start()
    f.channel.read.mockResolvedValue({
      status: 'snapshot',
      snapshot: { ...f.snapshot(), configurationRevision: '0'.repeat(64) }
    })
    expect(
      (await f.service.readRules({ sessionId: f.service.state().sessionId }, () => {})).status
    ).toBe('stale')
    expect((await f.service.changeRule(f.selection(), () => {})).status).toBe('stale')
    expect(f.confirmRule).not.toHaveBeenCalled()
  })
  it('returns only operation uncertainty after a write reply loses UI scope, never a whole-TUN uncertain transition', async () => {
    const f = rulesFixture()
    let live = true
    await f.start()
    f.channel.change.mockImplementation(async () => {
      f.setDisabled(true)
      live = false
      return { status: 'changed', snapshot: f.snapshot() }
    })
    expect(
      await f.service.changeRule(f.selection(), () => {
        if (!live) throw new Error('PRIVATE')
      })
    ).toEqual({ status: 'uncertain', sessionId: f.service.state().sessionId })
    expect(f.service.state().phase).toBe('active')
    expect(f.host.stopCore).not.toHaveBeenCalled()
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
    expect(f.channel.change).toHaveBeenCalledOnce()
  })
  it('does not let a synchronous guard cancellation enter the first channel read', async () => {
    const f = rulesFixture()
    await f.start()
    expect(
      (
        await f.service.readRules({ sessionId: f.service.state().sessionId }, () =>
          f.service.invalidateRules()
        )
      ).status
    ).toBe('cancelled')
    expect(f.channel.read).not.toHaveBeenCalled()
    expect(f.service.state().phase).toBe('active')
  })
  it('keeps the actual broker commit at zero when the queued prepare acknowledgement loses UI context', async () => {
    const f = rulesFixture()
    let live = true
    await f.start()
    const { frames, channel, reply } = connectedRulesPipe(f)
    try {
      const pending = f.service.changeRule(f.selection(), () => {
        if (!live) throw new Error('lost')
      })
      await vi.waitFor(() => expect(frames).toHaveLength(1))
      reply(1, 'snapshot', { snapshot: f.snapshot() })
      await vi.waitFor(() => expect(frames).toHaveLength(2))
      expect(f.confirmRule).toHaveBeenCalledOnce()
      reply(2, 'prepared', {
        prepared: {
          nonce: '22222222-2222-4222-8222-222222222222',
          operationId: 2,
          leaseMilliseconds: 2800,
          configurationRevision: f.snapshot().configurationRevision,
          rulesSHA256: f.snapshot().rulesSHA256,
          index: 0,
          disabled: true
        }
      })
      live = false
      await vi.waitFor(() => expect(frames).toHaveLength(3))
      expect(frames[2]).toMatchObject({ action: 'cancel', operationId: 2 })
      reply(3, 'cancelled')
      expect((await pending).status).toBe('cancelled')
      expect(frames.some((frame) => frame.action === 'commit')).toBe(false)
      expect(f.service.state().phase).toBe('active')
    } finally {
      channel.invalidate()
    }
  })
  it('preserves a missing wrapper bit as read-only rather than asking Native to write it', async () => {
    const f = rulesFixture()
    await f.start()
    f.channel.read.mockResolvedValue({
      status: 'snapshot',
      snapshot: {
        ...f.snapshot(),
        rules: [{ index: 0, type: 'Match', payload: '', proxy: 'REJECT' }]
      }
    })
    expect(
      (await f.service.readRules({ sessionId: f.service.state().sessionId }, () => {})).status
    ).toBe('snapshot')
    expect((await f.service.changeRule(f.selection(), () => {})).status).toBe('stale')
    expect(f.confirmRule).not.toHaveBeenCalled()
    expect(f.channel.change).not.toHaveBeenCalled()
  })
  it('retains logical busy through actual broker commit cancellation and returns only operation uncertainty', async () => {
    const f = rulesFixture()
    await f.start()
    const { channel, frames, reply } = connectedRulesPipe(f)
    try {
      const pending = f.service.changeRule(f.selection(), () => {})
      await vi.waitFor(() => expect(frames).toHaveLength(1))
      reply(1, 'snapshot', { snapshot: f.snapshot() })
      await vi.waitFor(() => expect(frames).toHaveLength(2))
      reply(2, 'prepared', {
        prepared: {
          nonce: '22222222-2222-4222-8222-222222222222',
          operationId: 2,
          leaseMilliseconds: 2800,
          configurationRevision: f.snapshot().configurationRevision,
          rulesSHA256: f.snapshot().rulesSHA256,
          index: 0,
          disabled: true
        }
      })
      await vi.waitFor(() => expect(frames).toHaveLength(3))
      expect(frames[2].action).toBe('commit')
      f.service.invalidateRules()
      await vi.waitFor(() => expect(frames).toHaveLength(4))
      expect(frames[3]).toMatchObject({ action: 'cancel', operationId: 2 })
      reply(4, 'uncertain', { pending: true })
      let idle = false
      void f.service.whenIdle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(f.service.isBusy()).toBe(true)
      expect(idle).toBe(false)
      expect(f.service.state().phase).toBe('active')
      reply(3, 'uncertain')
      expect(await pending).toEqual({ status: 'uncertain', sessionId: f.service.state().sessionId })
      await f.service.whenIdle()
      expect(idle).toBe(true)
      expect(frames.filter((frame) => frame.action === 'commit')).toHaveLength(1)
      expect(f.host.stopCore).not.toHaveBeenCalled()
      expect(f.host.revokeActivation).not.toHaveBeenCalled()
    } finally {
      channel.invalidate()
    }
  })
  it.each(['read', 'change'] as const)(
    'rechecks silent UI loss during final drain before publishing %s result',
    async (kind) => {
      const f = rulesFixture()
      let live = true
      await f.start()
      f.channel.whenIdle.mockImplementation(async () => {
        queueMicrotask(() => {
          live = false
        })
      })
      const assertUI = () => {
          if (!live) throw new Error('synthetic UI loss')
        },
        result =
          kind === 'read'
            ? await f.service.readRules({ sessionId: f.service.state().sessionId }, assertUI)
            : await f.service.changeRule(f.selection(), assertUI)
      expect(result).toEqual({
        status: kind === 'read' ? 'cancelled' : 'uncertain',
        sessionId: f.service.state().sessionId
      })
      expect(result).not.toHaveProperty('snapshot')
      expect(result).not.toHaveProperty('state')
      expect(f.service.isBusy()).toBe(false)
      expect(f.service.state().phase).toBe('active')
      if (kind === 'change') expect(f.snapshot().rules[0].disabled).toBe(true)
      expect(f.host.stopCore).not.toHaveBeenCalled()
    }
  )
  it.each(['read', 'change'] as const)(
    'retains rules-only revocation through final notification for %s',
    async (kind) => {
      const f = rulesFixture()
      await f.start()
      f.adapters.notify.mockImplementation(() => {
        if (!f.service.state().pending) f.service.invalidateRules()
      })
      const result =
        kind === 'read'
          ? await f.service.readRules({ sessionId: f.service.state().sessionId }, () => {})
          : await f.service.changeRule(f.selection(), () => {})
      expect(result).toEqual({
        status: kind === 'read' ? 'cancelled' : 'uncertain',
        sessionId: f.service.state().sessionId
      })
      expect(f.service.state().phase).toBe('active')
      expect(f.host.revokeActivation).not.toHaveBeenCalled()
      expect(f.channel.cancel).toHaveBeenCalledOnce()
    }
  )
  it('keeps an admitted mutation uncertain if final drain rejects without exposing the private error', async () => {
    const f = rulesFixture()
    await f.start()
    f.channel.whenIdle.mockRejectedValue(new Error('/private/synthetic-error'))
    const result = await f.service.changeRule(f.selection(), () => {})
    expect(result).toEqual({ status: 'uncertain', sessionId: f.service.state().sessionId })
    expect(f.snapshot().rules[0].disabled).toBe(true)
    expect(f.channel.invalidate).toHaveBeenCalledOnce()
    expect(f.service.isBusy()).toBe(false)
  })
})

function providerFixture() {
  const f = geoFixture(),
    bytes = Buffer.from('payload: [fixture.invalid]\n'),
    sha256 = hash(bytes.toString()),
    candidate: RuleProviderResourceCandidate = {
      job: {
        descriptor: { name: 'private source', kind: 'rule-yaml', behavior: 'domain', selector: '' },
        bytes,
        sha256
      },
      revision: 'e'.repeat(64),
      recheck: vi.fn(async () => {})
    }
  let updated = false
  const snapshot = () => ({
      configurationRevision: f.snapshot().configurationRevision,
      generationSHA256: (updated ? '4' : '5').repeat(64),
      groups: [['local']],
      providers: [
        {
          name: 'local',
          kind: 'rule-yaml' as const,
          behavior: 'domain' as const,
          fileSHA256: updated ? sha256 : '6'.repeat(64),
          bytes: bytes.length,
          ruleCount: 1
        }
      ]
    }),
    channel = {
      read: vi.fn(async () => ({ status: 'snapshot' as const, snapshot: snapshot() })),
      replace: vi.fn(async () => {
        updated = true
        return { status: 'updated' as const, snapshot: snapshot() }
      }),
      discardBlob: vi.fn(async () => 'discarded' as const),
      cancel: vi.fn(async () => {}),
      invalidate: vi.fn(),
      isAvailable: () => true,
      isBusy: () => false,
      whenIdle: vi.fn(async () => {})
    } satisfies TunRuleProvidersChannel,
    confirm = vi.fn(async () => true),
    inbox = {
      ...f.inbox,
      stageRuleProvider: vi.fn(async () => ({
        blobId: '77777777-7777-4777-8777-777777777777',
        kind: 'rule-yaml' as const,
        sha256,
        bytes: bytes.length,
        filename: '77777777-7777-4777-8777-777777777777.yaml'
      }))
    }
  Object.assign(f.host, { ruleProvidersChannel: channel, resourceInbox: inbox })
  Object.assign(f.adapters, {
    readRuleProviderCandidate: vi.fn(async () => candidate),
    confirmRuleProvider: confirm
  })
  return {
    ...f,
    providerChannel: channel,
    providerInbox: inbox,
    providerConfirm: confirm,
    providerSelection: () => ({
      sessionId: f.service.state().sessionId,
      configurationRevision: snapshot().configurationRevision,
      expectedGenerationSHA256: snapshot().generationSHA256,
      provider: 'local',
      resource: { id: '88888888-8888-4888-8888-888888888888', sha256 }
    })
  }
}

describe('TUN provider refresh shared admission and lifecycle isolation', () => {
  it('serializes provider consent against Geo, rule and stop operations until actual drain', async () => {
    const f = providerFixture()
    await f.start()
    let release!: () => void
    const consent = new Promise<boolean>((resolve) => {
      release = () => resolve(true)
    })
    f.providerConfirm.mockReturnValue(consent)
    const work = f.service.replaceRuleProvider(f.providerSelection(), () => {})
    for (let n = 0; n < 30 && !f.providerConfirm.mock.calls.length; ++n) await Promise.resolve()
    expect(f.providerConfirm).toHaveBeenCalledOnce()
    expect(f.service.isBusy()).toBe(true)
    expect(
      (await f.service.readResources({ sessionId: f.service.state().sessionId }, () => {})).status
    ).toBe('busy')
    expect(
      (await f.service.readRules({ sessionId: f.service.state().sessionId }, () => {})).status
    ).toBe('busy')
    await expect(f.service.stop({ sessionId: f.service.state().sessionId })).rejects.toThrow('等待')
    release()
    expect((await work).status).toBe('updated')
    expect(f.service.state().phase).toBe('active')
    expect(f.host.stopCore).not.toHaveBeenCalled()
    expect(f.service.isBusy()).toBe(false)
  })
  it('lost provider ACK leaves Geo reads and lifecycle inspection usable without adopting provider state', async () => {
    const f = providerFixture()
    await f.start()
    f.providerChannel.replace.mockRejectedValue(new Error('lost private ACK'))
    expect((await f.service.replaceRuleProvider(f.providerSelection(), () => {})).status).toBe(
      'uncertain'
    )
    expect(f.service.state().phase).toBe('active')
    expect(
      (await f.service.readResources({ sessionId: f.service.state().sessionId }, () => {})).status
    ).toBe('snapshot')
    expect((await f.service.inspect()).phase).toBe('active')
    expect(
      (await f.service.readRuleProviders({ sessionId: f.service.state().sessionId }, () => {}))
        .status
    ).toBe('uncertain')
    expect(f.providerChannel.replace).toHaveBeenCalledOnce()
    expect(f.host.stopCore).not.toHaveBeenCalled()
  })
  it('scope revocation in the shared final notification is retained after native success', async () => {
    const f = providerFixture()
    await f.start()
    f.adapters.notify.mockImplementation(() => {
      if (!f.service.state().pending) f.service.invalidateRuleProviders()
    })
    expect((await f.service.replaceRuleProvider(f.providerSelection(), () => {})).status).toBe(
      'uncertain'
    )
    expect(f.service.state().phase).toBe('active')
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
    expect(f.host.stopCore).not.toHaveBeenCalled()
    expect(f.service.isBusy()).toBe(false)
  })
})

function tunToolsFixture() {
  const f = fixture('core-managed')
  let configuration = JSON.parse(f.evidence.configuration)
  configuration['proxy-groups'] = [
    {
      name: 'CurrentSmart',
      type: 'smart',
      proxies: ['REJECT'],
      url: 'http://127.0.0.1:1/health',
      uselightgbm: false,
      collectdata: false
    }
  ]
  const normalized = inspectRuntimeConfiguration(JSON.stringify(configuration)).configuration
  if (!normalized) throw new Error('Smart fixture schema rejected')
  configuration = normalized
  f.evidence.configuration = JSON.stringify(configuration)
  f.request.configurationSHA256 = hash(f.evidence.configuration)
  f.evidence.parser.configurationSHA256 = f.request.configurationSHA256
  f.request.bundleSHA256 = hash(
    JSON.stringify({ configuration, assets: [], pins: [], unresolved: [] })
  )
  const revision = (): string => {
    const binding = f.adapters.openHost.mock.calls[0]?.[1]
    if (!binding) throw new Error('missing own binding')
    return binding.runtimeConfigurationSHA256
  }
  const weights = vi.fn(async (_signal: AbortSignal, check: () => void) => {
    check()
    return {
      status: 'snapshot' as const,
      pending: false,
      snapshot: {
        version: 1 as const,
        kind: 'weights' as const,
        configurationRevision: revision(),
        groups: [
          {
            name: 'CurrentSmart',
            status: 'ready' as const,
            weights: [{ Name: 'historical', Rank: '' as const, Weight: 0 }]
          }
        ]
      }
    }
  })
  const clear = vi.fn(async (_signal: AbortSignal, check: () => void) => {
    check()
    return {
      status: 'updated' as const,
      pending: false,
      snapshot: {
        version: 1 as const,
        kind: 'clear-cache' as const,
        configurationRevision: revision(),
        accepted: true as const
      }
    }
  })
  let available = true
  Object.assign(f.host, {
    smartToolsChannel: {
      weights,
      clearCache: clear,
      invalidate: () => {
        available = false
      },
      isAvailable: () => available,
      isBusy: () => false,
      whenIdle: async () => {}
    }
  })
  return { ...f, weights, clear }
}
describe('Smart tools TUN service separate IO boundary', () => {
  it('picks only declared current Smart group; requires separate clear confirmation and exact owner/revision', async () => {
    const f = tunToolsFixture(),
      start = await f.start()
    expect(start.status).toBe('started')
    const inspect = await f.service.smartTools({ action: 'inspect', target: 'tun' })
    expect(inspect.status).toBe('ready')
    if (inspect.status !== 'ready') throw new Error('fixture unavailable')
    const base = {
      target: 'tun',
      instanceId: inspect.inspection.instanceId,
      configurationRevision: inspect.inspection.configurationRevision
    }
    expect(
      await f.service.smartTools({ ...base, action: 'weights', group: 'CurrentSmart' })
    ).toEqual({ status: 'weights', weights: [{ Name: 'historical', Rank: '', Weight: 0 }] })
    expect(
      (await f.service.smartTools({ ...base, action: 'weights', group: 'history' })).status
    ).toBe('unavailable')
    expect((await f.service.smartTools({ ...base, action: 'clear-cache' })).status).toBe(
      'cancelled'
    )
    expect(f.clear).not.toHaveBeenCalled()
    expect(
      (await f.service.smartTools({ ...base, action: 'clear-cache' }, async () => true)).status
    ).toBe('accepted')
    expect(f.clear).toHaveBeenCalledOnce()
    expect((await f.service.stop({ sessionId: start.state.sessionId })).status).toBe('restored')
  })
  it('restores and disposes while tools GET is blocked, rejecting its late snapshot', async () => {
    const f = tunToolsFixture(),
      start = await f.start()
    expect(start.status).toBe('started')
    const inspect = await f.service.smartTools({ action: 'inspect', target: 'tun' })
    if (inspect.status !== 'ready') throw new Error('fixture unavailable')
    let done!: () => void, entered!: () => void
    const gate = new Promise<void>((r) => {
        done = r
      }),
      inside = new Promise<void>((r) => {
        entered = r
      }),
      original = f.weights.getMockImplementation()
    if (!original) throw new Error('missing fixture weights')
    f.weights.mockImplementation(async (signal, check) => {
      entered()
      await gate
      return original(signal, check)
    })
    const pending = f.service.smartTools({
      action: 'weights',
      target: 'tun',
      instanceId: inspect.inspection.instanceId,
      configurationRevision: inspect.inspection.configurationRevision,
      group: 'CurrentSmart'
    })
    await inside
    expect((await f.service.stop({ sessionId: start.state.sessionId })).status).toBe('restored')
    expect(f.events).toContain('dispose')
    done()
    expect((await pending).status).toBe('unavailable')
  })
})

describe('TUN display-only source-bound traffic', () => {
  const readable = (clocks?: Parameters<typeof fixture>[2]) => {
    const f = fixture('core-managed', 0, clocks)
    const traffic = vi.fn(async (_signal: AbortSignal): Promise<TunRuntimeTrafficResult> => ({
      status: 'sampled',
      frame: { up: 10, down: 20, upTotal: 100, downTotal: 200 }
    }))
    const capture = vi.fn(async () => ({ status: 'unsupported' as const }))
    Object.assign(f.host, { runtimeReader: { traffic, capture, isAvailable: () => true } })
    return { ...f, traffic, capture }
  }
  it('samples only an active held TUN without requiring HTTP ports or substituting an ordinary instance', async () => {
    const f = readable(),
      signal = new AbortController().signal
    expect(await f.service.readTraffic(signal)).toBeUndefined()
    expect(f.traffic).not.toHaveBeenCalled()
    await f.start()
    const before = [...f.events],
      result = await f.service.readTraffic(signal)
    const runtime = f.adapters.openHost.mock.calls[0][0]
    expect(result).toEqual({
      kind: 'tun-managed',
      sessionId: f.service.state().sessionId,
      evidenceSHA256: f.adapters.openHost.mock.calls[0][1].evidenceSHA256,
      runtimeConfigurationSHA256: runtime.runtimeConfigurationSHA256,
      up: 10,
      down: 20,
      upTotal: 100,
      downTotal: 200,
      receivedAt: 1000
    })
    expect(result).not.toHaveProperty('instanceId')
    expect(f.events).toEqual(before)
    expect(f.capture).not.toHaveBeenCalled()
    expect(f.service.state()).toMatchObject({ phase: 'active', pending: false, owned: true })
  })
  it('keeps old hosts unavailable and does not send capture or a lifecycle action', async () => {
    const f = fixture('core-managed')
    await f.start()
    const before = [...f.events]
    expect(await f.service.readTraffic(new AbortController().signal)).toBeUndefined()
    expect(f.events).toEqual(before)
  })
  it.each(['busy', 'unsupported', 'unavailable', 'throws', 'invalid-frame'])(
    'isolates %s telemetry from Core ownership and recovery',
    async (kind) => {
      const f = readable()
      await f.start()
      f.traffic.mockImplementation(async () => {
        if (kind === 'throws') throw new Error('private detail')
        if (kind === 'invalid-frame')
          return { status: 'sampled', frame: { up: -1, down: 0, upTotal: 0, downTotal: 0 } }
        if (kind === 'busy' || kind === 'unsupported' || kind === 'unavailable')
          return { status: kind }
        throw new Error('unexpected fixture')
      })
      expect(await f.service.readTraffic(new AbortController().signal)).toBeUndefined()
      expect(f.service.state()).toMatchObject({ phase: 'active', owned: true, pending: false })
      expect(f.host.stopCore).not.toHaveBeenCalled()
      expect(f.host.revokeActivation).not.toHaveBeenCalled()
    }
  )
  it('cancels only its caller lane on hiding, retains single-flight until drain, and rejects late results', async () => {
    const f = readable(),
      abort = new AbortController()
    let finish!: () => void, nativeSignal!: AbortSignal
    f.traffic.mockImplementation((signal) => {
      nativeSignal = signal
      return new Promise((resolve) => {
        finish = () =>
          resolve({ status: 'sampled', frame: { up: 1, down: 2, upTotal: 3, downTotal: 4 } })
      })
    })
    await f.start()
    const read = f.service.readTraffic(abort.signal)
    expect(await f.service.readTraffic(new AbortController().signal)).toBeUndefined()
    abort.abort()
    expect(nativeSignal.aborted).toBe(true)
    finish()
    expect(await read).toBeUndefined()
    expect(f.host.stopCore).not.toHaveBeenCalled()
    expect(f.host.revokeActivation).not.toHaveBeenCalled()
    expect(f.service.state().phase).toBe('active')
  })
  it('does not make an outstanding metrics read block a confirmed stop or revive its old owner', async () => {
    const f = readable()
    let finish!: () => void, nativeSignal!: AbortSignal
    f.traffic.mockImplementation((signal) => {
      nativeSignal = signal
      return new Promise((resolve) => {
        finish = () =>
          resolve({ status: 'sampled', frame: { up: 1, down: 2, upTotal: 3, downTotal: 4 } })
      })
    })
    await f.start()
    const read = f.service.readTraffic(new AbortController().signal)
    const stopped = await f.service.stop({ sessionId: f.service.state().sessionId })
    expect(stopped.status).toBe('restored')
    expect(nativeSignal.aborted).toBe(true)
    expect(f.host.stopCore).toHaveBeenCalledOnce()
    finish()
    expect(await read).toBeUndefined()
    expect(f.service.state()).toMatchObject({ phase: 'restored', owned: false })
  })
  it.each([999, 3000])('rejects a rollback or two-second-old result (%s)', async (time) => {
    const f = readable()
    await f.start()
    f.traffic.mockImplementation(async () => {
      f.setTime(time)
      return { status: 'sampled', frame: { up: 1, down: 2, upTotal: 3, downTotal: 4 } }
    })
    expect(await f.service.readTraffic(new AbortController().signal)).toBeUndefined()
    expect(f.service.state().phase).toBe('active')
  })
  it.each([
    { wallElapsed: 0, monoElapsed: 1500, expected: 8500 },
    { wallElapsed: 500, monoElapsed: 1500, expected: 9000 },
    { wallElapsed: 1500, monoElapsed: 1500, expected: 10000 },
    { wallElapsed: 1500, monoElapsed: 500, expected: 10000 },
    { wallElapsed: 0, monoElapsed: 1499.1, expected: 8500 }
  ])(
    'projects both observed clocks into a conservative receivedAt: %j',
    async ({ wallElapsed, monoElapsed, expected }) => {
      let wall = 1000,
        mono = 0
      const f = readable({ wall: () => wall, mono: () => mono })
      await f.start()
      wall = 10000
      f.traffic.mockImplementation(async () => {
        wall += wallElapsed
        mono += monoElapsed
        return { status: 'sampled', frame: { up: 1, down: 2, upTotal: 3, downTotal: 4 } }
      })
      expect((await f.service.readTraffic(new AbortController().signal))?.receivedAt).toBe(expected)
      expect(f.host.stopCore).not.toHaveBeenCalled()
    }
  )
  it('does not give a prepared frame a new two-second lifetime at the existing preload boundary', async () => {
    let wall = 1000,
      mono = 0
    const f = readable({ wall: () => wall, mono: () => mono })
    await f.start()
    wall = 10000
    f.traffic.mockImplementation(async () => {
      mono = 1500
      return { status: 'sampled', frame: { up: 1, down: 2, upTotal: 3, downTotal: 4 } }
    })
    const sample = await f.service.readTraffic(new AbortController().signal)
    const io = { on: vi.fn(), removeListener: vi.fn() },
      bridge = createReadonlyFloatingBridge(io, { now: () => wall, tick: () => mono }),
      listener = vi.fn()
    try {
      io.on.mock.calls[0][1]({}, { version: 1, status: 'ready', sample })
      bridge.api.onSnapshot(listener)
      expect(listener.mock.lastCall?.[0].status).toBe('ready')
      mono += 500
      bridge.api.onSnapshot(listener)
      expect(listener).toHaveBeenLastCalledWith({ version: 1, status: 'unavailable' })
    } finally {
      bridge.dispose()
    }
  })
  it('includes time observed by the final live check after validating the raw frame', async () => {
    let wall = 1000,
      mono = 0
    const f = readable({ wall: () => wall, mono: () => mono })
    await f.start()
    wall = 10000
    f.traffic.mockImplementation(async () => ({
      status: 'sampled',
      frame: {
        get up() {
          wall = 10500
          mono = 1700
          return 1
        },
        down: 2,
        upTotal: 3,
        downTotal: 4
      }
    }))
    expect((await f.service.readTraffic(new AbortController().signal))?.receivedAt).toBe(8800)
  })
  it('rounds the duration before subtracting a large epoch timestamp', async () => {
    let wall = 1000,
      mono = 0
    const f = readable({ wall: () => wall, mono: () => mono })
    await f.start()
    wall = 1700000000000
    f.traffic.mockImplementation(async () => {
      mono = 0.0001
      return { status: 'sampled', frame: { up: 1, down: 2, upTotal: 3, downTotal: 4 } }
    })
    expect((await f.service.readTraffic(new AbortController().signal))?.receivedAt).toBe(wall - 1)
  })
  it.each(['negative-projection', 'unsafe-wall', 'fractional-wall', 'sub-ms-remainder'] as const)(
    'fails closed when no trustworthy timestamp can be published: %s',
    async (kind) => {
      let wall = 1000,
        mono = 0
      const f = readable({ wall: () => wall, mono: () => mono })
      await f.start()
      if (kind === 'unsafe-wall') wall = Number.MAX_SAFE_INTEGER
      if (kind === 'sub-ms-remainder') wall = 10000
      f.traffic.mockImplementation(async () => {
        mono = 1500
        if (kind === 'sub-ms-remainder') mono = 1999.1
        if (kind === 'unsafe-wall') wall++
        if (kind === 'fractional-wall') wall += 0.5
        return { status: 'sampled', frame: { up: 1, down: 2, upTotal: 3, downTotal: 4 } }
      })
      expect(await f.service.readTraffic(new AbortController().signal)).toBeUndefined()
      expect(f.host.stopCore).not.toHaveBeenCalled()
    }
  )
})
