import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { readFileSync, statSync } from 'fs'
import type { spawn } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logPath } from '../../utils/dirs'
import { setAppLogDisabled } from '../../utils/logger'
import { resourceHash } from '../resources/source'
import geodataManifest from '../core/geodata-manifest.json'
import type { CoreExecutionReceiptV2 } from '../configuration/core-snapshot-prototype'
import { createTunStartDiagnostics, openTunNativeHost } from './transport'
import type { TunDescriptorRuntime, TunCoreRuntime } from './runtime'
import type { TunSessionBinding, TunSessionHost } from './service'
import runtimeCaptureClient from './runtime-capture-client.json'
import { compiledExecutionCoreV2 } from './execution-installation'
import { encodeCheckedTunExecutionV2 } from './checked-execution'

vi.mock('../../utils/dirs', () => ({ logPath: vi.fn() }))

let logDirectory: string
beforeEach(async () => {
  logDirectory = await mkdtemp('/private/tmp/relay-tun-log-test-')
  vi.mocked(logPath).mockReturnValue(logDirectory + '/logs/app.log')
  setAppLogDisabled(false)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  setAppLogDisabled(false)
  vi.restoreAllMocks()
  await rm(logDirectory, { recursive: true, force: true })
})

const binding: TunSessionBinding = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  evidenceSHA256: 'a'.repeat(64),
  runtimeConfigurationSHA256: 'b'.repeat(64)
}
const installation = {
  revision: 'c'.repeat(64),
  helperSHA256: 'd'.repeat(64),
  clientSHA256: 'e'.repeat(64),
  coreSHA256: 'f'.repeat(64)
}
const baseline = { networkSHA256: '1'.repeat(64), protectionSHA256: '2'.repeat(64) }
function candidate() {
  const source = {
      ipv6: false,
      mode: 'rule',
      port: 0,
      'geo-auto-update': false,
      'geox-url': { geoip: '', geosite: '', mmdb: '', asn: '' },
      tun: {
        enable: true,
        device: 'utun',
        stack: 'gvisor',
        mtu: 1500,
        'auto-route': false,
        'auto-detect-interface': false,
        'dns-hijack': []
      },
      rules: ['MATCH,REJECT']
    },
    sourceConfiguration = JSON.stringify(source),
    configuration = JSON.stringify({ ...source, tun: { ...source.tun, 'file-descriptor': 3 } })
  const runtime = {
    version: 1,
    descriptor: 3,
    sourceConfigurationSHA256: resourceHash(Buffer.from(sourceConfiguration)),
    runtimeConfigurationSHA256: resourceHash(Buffer.from(configuration)),
    configuration,
    preparation: {
      bundleSHA256: resourceHash(
        Buffer.from(JSON.stringify({ configuration: source, assets: [], pins: [], unresolved: [] }))
      )
    }
  } as TunDescriptorRuntime
  return {
    runtime,
    launch: { sourceConfiguration, assets: [], pins: [] },
    identity: { ...binding, runtimeConfigurationSHA256: runtime.runtimeConfigurationSHA256 }
  }
}
function checkedManagedCandidate(profile: 'stable' | 'alpha' | 'local-geodata-v1') {
  const c = candidate(),
    core = compiledExecutionCoreV2(profile, process.arch as 'arm64' | 'x64'),
    receipt: CoreExecutionReceiptV2 = {
      version: 2,
      profile,
      architecture: core.architecture,
      core: { version: core.version, sha256: core.sha256, size: core.size },
      configurationSHA256: c.runtime.sourceConfigurationSHA256,
      selectionSHA256: '1'.repeat(64),
      snapshotSHA256: '2'.repeat(64),
      expiresAt: Date.now() + 60000,
      assets: []
    },
    execution = { ...encodeCheckedTunExecutionV2(receipt), recheck: vi.fn(async () => {}) },
    runtime: TunCoreRuntime = {
      version: 2,
      execution: 'core-managed',
      device: 'utun',
      configuration: c.launch.sourceConfiguration,
      sourceConfigurationSHA256: c.runtime.sourceConfigurationSHA256,
      runtimeConfigurationSHA256: c.runtime.sourceConfigurationSHA256,
      preparation: { ...c.runtime.preparation, evidenceSHA256: binding.evidenceSHA256 },
      checkedExecution: execution,
      active: false,
      runtimeVerified: false,
      protectionVerified: false
    },
    installed = {
      ...installation,
      execution: 'core-managed' as const,
      executionCore: core,
      coreSHA256: core.sha256
    },
    identity = { ...binding, runtimeConfigurationSHA256: runtime.runtimeConfigurationSHA256 }
  return { runtime, launch: c.launch, execution, installed, identity }
}
function nativeFixture(change?: (response: Record<string, unknown>) => Record<string, unknown>) {
  const runtimeInput = new PassThrough(),
    runtimeOutput = new PassThrough(),
    rulesInput = new PassThrough(),
    rulesOutput = new PassThrough(),
    resourcesInput = new PassThrough(),
    resourcesOutput = new PassThrough(),
    providersInput = new PassThrough(),
    providersOutput = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 123456,
      stdio: [] as PassThrough[]
    }),
    frames: Record<string, unknown>[] = []
  child.stdio = [
    child.stdin,
    child.stdout,
    child.stderr,
    runtimeInput,
    runtimeOutput,
    rulesInput,
    rulesOutput,
    resourcesInput,
    resourcesOutput,
    providersInput,
    providersOutput
  ]
  let identity: TunSessionBinding,
    buffer = ''
  child.stdin.on('data', (data: Buffer) => {
    buffer += data.toString()
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'),
        raw = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      frames.push(raw)
      if (raw.action === 'bootstrap') {
        identity = raw.binding
        continue
      }
      const phase: Record<string, string> = {
        initialize: 'idle',
        acquire: 'acquired',
        startCore: 'coreReady',
        activate: 'active',
        inspect: 'active',
        stopCore: 'coreStopped',
        release: 'released',
        verifyRestored: 'restored'
      }
      const state: Record<string, string[]> = {
        idle: ['none', 'none', 'unchanged'],
        acquired: ['none', 'held', 'unchanged'],
        coreReady: ['running', 'held', 'unchanged'],
        active: ['running', 'held', 'active'],
        coreStopped: ['stopped', 'held', 'active'],
        released: ['stopped', 'released', 'restored'],
        restored: ['stopped', 'absent', 'restored']
      }
      const response =
        raw.action === 'dispose' ||
        raw.action === 'disposeReleased' ||
        raw.action === 'revokeActivation'
          ? {
              version: 1,
              id: raw.id,
              action: raw.action,
              ...identity,
              [raw.action === 'revokeActivation' ? 'revoked' : 'closed']: true,
              ...(raw.action === 'disposeReleased'
                ? {
                    restorationVerified: false,
                    reason: 'external-protection-changed',
                    stateDisposition: 'retained-evidence'
                  }
                : {})
            }
          : {
              version: 1,
              id: raw.id,
              action: raw.action,
              observation: {
                version: 1,
                ...identity,
                phase: phase[raw.action],
                core: state[phase[raw.action]][0],
                device: state[phase[raw.action]][1],
                network: state[phase[raw.action]][2]
              }
            }
      child.stdout.write(JSON.stringify(change ? change(response) : response) + '\n')
    }
  })
  child.stdin.on('finish', () => child.emit('close', 0))
  return {
    child,
    frames,
    runtimeInput,
    runtimeOutput,
    rulesInput,
    rulesOutput,
    resourcesInput,
    resourcesOutput,
    providersInput,
    providersOutput,
    spawn: vi.fn(() => child) as unknown as typeof spawn
  }
}
describe('Production TUN launcher private bundle and persistent control wiring', () => {
  it('retains the private staged evidence when releasing owned resources after external proxy changes', async () => {
    const c = checkedManagedCandidate('local-geodata-v1'),
      f = nativeFixture()
    const host = await openTunNativeHost(
      c.installed,
      baseline,
      c.runtime,
      c.identity,
      c.launch,
      vi.fn(),
      vi.fn(),
      { readInstallation: async () => c.installed, spawn: f.spawn, execution: c.execution }
    )
    const directory = String(f.frames[0].directory)
    try {
      await host.stopCore()
      await host.disposeReleased?.()
      expect(f.frames.map((frame) => frame.action)).toEqual([
        'bootstrap',
        'initialize',
        'stopCore',
        'disposeReleased'
      ])
      expect(await readFile(directory + '/source.json', 'utf8')).toBe(c.launch.sourceConfiguration)
      expect(await readFile(directory + '/execution.json', 'utf8')).toBe(c.execution.raw)
      expect((await lstat(directory)).mode & 0o7777).toBe(0o700)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['stable', 'alpha', 'local-geodata-v1'] as const)(
    'hands exact %s wire3 bytes to the separate v2 flag without Geo/provider write lanes',
    async (profile) => {
      const c = checkedManagedCandidate(profile),
        f = nativeFixture(),
        uncertain = vi.fn()
      const host = await openTunNativeHost(
        c.installed,
        baseline,
        c.runtime,
        c.identity,
        c.launch,
        vi.fn(),
        uncertain,
        {
          readInstallation: async () => c.installed,
          spawn: f.spawn,
          execution: c.execution
        }
      )
      expect(vi.mocked(f.spawn).mock.calls[0][1]).toEqual(['--managed-session-execution-v2'])
      expect(vi.mocked(f.spawn).mock.calls[0][2]?.stdio).toHaveLength(7)
      const bootstrap = f.frames[0],
        directory = String(bootstrap.directory)
      expect(bootstrap).toMatchObject({
        version: 3,
        executionPath: 'execution.json',
        executionSHA256: c.execution.sha256,
        installationRevision: c.installed.revision
      })
      expect(await readFile(directory + '/execution.json', 'utf8')).toBe(c.execution.raw)
      expect(await readFile(directory + '/source.json', 'utf8')).toBe(c.launch.sourceConfiguration)
      expect(host.resourcesChannel).toBeUndefined()
      expect(host.ruleProvidersChannel).toBeUndefined()
      await host.stopCore()
      await host.release()
      await host.verifyRestored()
      await host.dispose()
      await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(uncertain).not.toHaveBeenCalled()
    }
  )
  it('rejects corrupt in-memory receipt bytes before rechecking the core or spawning', async () => {
    const c = checkedManagedCandidate('alpha'),
      f = nativeFixture(),
      execution = { ...c.execution, raw: c.execution.raw + ' ' }
    await expect(
      openTunNativeHost(
        c.installed,
        baseline,
        { ...c.runtime, checkedExecution: execution },
        c.identity,
        c.launch,
        vi.fn(),
        vi.fn(),
        { readInstallation: async () => c.installed, spawn: f.spawn, execution }
      )
    ).rejects.toThrow('原始回执摘要')
    expect(execution.recheck).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it.each(['missing', 'wrong-core', 'legacy', 'stale'] as const)(
    'refuses %s execution before spawning a Native host',
    async (defect) => {
      const c = checkedManagedCandidate('alpha'),
        f = nativeFixture()
      const installed =
        defect === 'legacy' ? { ...c.installed, executionCore: undefined } : c.installed
      if (defect === 'wrong-core')
        installed.executionCore = compiledExecutionCoreV2(
          'stable',
          c.execution.receipt.architecture
        )
      if (defect === 'stale') c.execution.recheck.mockRejectedValueOnce(new Error('source-changed'))
      await expect(
        openTunNativeHost(installed, baseline, c.runtime, c.identity, c.launch, vi.fn(), vi.fn(), {
          readInstallation: async () => installed,
          spawn: f.spawn,
          execution: defect === 'missing' ? undefined : c.execution
        })
      ).rejects.toThrow()
      expect(f.spawn).not.toHaveBeenCalled()
    }
  )
  it('preserves an explicit zero rule count in staged private asset metadata', async () => {
    const fixture = nativeFixture(),
      c = candidate(),
      bytes = Buffer.from('private metadata fixture; not an accepted empty MRS'),
      sha256 = resourceHash(bytes),
      asset = { path: `relay-files/${sha256}.bin`, sha256, bytes, expectedRules: 0 },
      metadata = [{ path: asset.path, sha256, expectedRules: 0 }],
      launch = { ...c.launch, assets: [asset] },
      runtime = {
        ...c.runtime,
        preparation: {
          ...c.runtime.preparation,
          bundleSHA256: resourceHash(
            Buffer.from(
              JSON.stringify({
                configuration: JSON.parse(launch.sourceConfiguration),
                assets: metadata,
                pins: [],
                unresolved: []
              })
            )
          )
        }
      }
    const host = await openTunNativeHost(
      installation,
      baseline,
      runtime,
      c.identity,
      launch,
      vi.fn(),
      vi.fn(),
      { readInstallation: async () => installation, spawn: fixture.spawn }
    )
    const bootstrap = fixture.frames[0],
      directory = bootstrap.directory as string
    expect(bootstrap.assets).toEqual(metadata)
    expect(JSON.parse((await readFile(directory + '/bundle.json')).toString()).assets).toEqual(
      metadata
    )
    expect(await readFile(directory + '/' + asset.path)).toEqual(bytes)
    await host.acquire()
    await host.startCore()
    await host.activate()
    await host.stopCore()
    await host.release()
    await host.verifyRestored()
    await host.dispose()
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('starts the hello deadline after a slow verified bootstrap and preserves a buffered private hello', async () => {
    vi.useFakeTimers()
    const f = nativeFixture(),
      c = candidate(),
      configuration = c.launch.sourceConfiguration,
      runtime: TunCoreRuntime = {
        version: 2,
        execution: 'core-managed',
        device: 'utun',
        sourceConfigurationSHA256: c.runtime.sourceConfigurationSHA256,
        runtimeConfigurationSHA256: resourceHash(Buffer.from(configuration)),
        configuration,
        preparation: c.runtime.preparation,
        active: false,
        runtimeVerified: false,
        protectionVerified: false
      },
      identity = { ...c.identity, runtimeConfigurationSHA256: runtime.runtimeConfigurationSHA256 },
      installed = { ...installation, execution: 'core-managed' as const }
    f.child.stdout.pause()
    try {
      const pending = openTunNativeHost(
        installed,
        baseline,
        runtime,
        identity,
        c.launch,
        vi.fn(),
        vi.fn(),
        {
          readInstallation: async () => installed,
          spawn: f.spawn,
          runtimeCapturePin: {
            version: 1,
            capability: 'runtime-capture-v1',
            clientSHA256: installed.clientSHA256
          }
        }
      )
      await vi.waitFor(() =>
        expect(f.frames.some((frame) => frame.action === 'initialize')).toBe(true)
      )
      await vi.advanceTimersByTimeAsync(4000)
      f.runtimeOutput.write(
        JSON.stringify({
          version: 1,
          kind: 'hello',
          capability: 'runtime-capture-v1',
          ...identity,
          launchClientSHA256: installed.clientSHA256,
          installationRevision: installed.revision
        }) + '\n'
      )
      f.child.stdout.resume()
      const host = await pending
      await vi.advanceTimersByTimeAsync(0)
      expect(host.runtimeReader?.isAvailable()).toBe(true)
      f.runtimeOutput.emit('end')
      await rm(String(f.frames[0].directory), { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })
  it.each([false, true])(
    'uses new argv and independent pipes only for a known launch client pin (%s)',
    async (known) => {
      const f = nativeFixture(),
        c = candidate(),
        configuration = c.launch.sourceConfiguration,
        runtime: TunCoreRuntime = {
          version: 2,
          execution: 'core-managed',
          device: 'utun',
          sourceConfigurationSHA256: c.runtime.sourceConfigurationSHA256,
          runtimeConfigurationSHA256: resourceHash(Buffer.from(configuration)),
          configuration,
          preparation: c.runtime.preparation,
          active: false,
          runtimeVerified: false,
          protectionVerified: false
        },
        identity = {
          ...c.identity,
          runtimeConfigurationSHA256: runtime.runtimeConfigurationSHA256
        },
        installed = { ...installation, execution: 'core-managed' as const },
        uncertain = vi.fn()
      const host = await openTunNativeHost(
        installed,
        baseline,
        runtime,
        identity,
        c.launch,
        vi.fn(),
        uncertain,
        {
          readInstallation: async () => installed,
          spawn: f.spawn,
          runtimeCapturePin: {
            version: 1,
            capability: 'runtime-capture-v1',
            clientSHA256: known ? installed.clientSHA256 : '0'.repeat(64)
          }
        }
      )
      const [, argv, options] = vi.mocked(f.spawn).mock.calls[0]
      expect(argv).toEqual([known ? '--managed-session-runtime-capture-v1' : '--managed-session'])
      expect(options?.stdio).toHaveLength(known ? 5 : 3)
      if (!known) expect(host.runtimeReader).toBeUndefined()
      else {
        const requests: unknown[] = []
        f.runtimeInput.on('data', (bytes: Buffer) => requests.push(JSON.parse(bytes.toString())))
        f.runtimeOutput.write(
          JSON.stringify({
            version: 1,
            kind: 'hello',
            capability: 'runtime-capture-v1',
            ...identity,
            launchClientSHA256: installed.clientSHA256,
            installationRevision: installed.revision
          }) + '\n'
        )
        const pending = host.runtimeReader?.capture(new AbortController().signal)
        await Promise.resolve()
        expect(requests).toEqual([{ version: 1, id: 1, action: 'capture', ...identity }])
        f.runtimeOutput.emit('end')
        expect(await pending).toEqual({ status: 'unavailable' })
        expect(uncertain).not.toHaveBeenCalled()
        expect((await host.inspect()).phase).toBe('active')
        expect(f.frames.map((frame) => frame.action)).toEqual([
          'bootstrap',
          'initialize',
          'inspect'
        ])
      }
      const bootstrap = f.frames[0]
      await rm(String(bootstrap.directory), { recursive: true, force: true })
    }
  )
  it.runIf(process.env.RELAY_TUN_RECOVERY_CONTRACT)(
    'persists every recovery code emitted by the compiled native session tests',
    () => {
      const contract = process.env.RELAY_TUN_RECOVERY_CONTRACT
      if (!contract) throw new Error('Native recovery contract path is required')
      const { recoveryDiagnosticCodes } = JSON.parse(readFileSync(contract, 'utf8')) as {
        recoveryDiagnosticCodes: string[]
      }
      expect(recoveryDiagnosticCodes.length).toBeGreaterThanOrEqual(10)
      for (const code of recoveryDiagnosticCodes) {
        const report = vi.fn(),
          consume = createTunStartDiagnostics(vi.fn(), report)
        consume(Buffer.from(`RELAY_TUN_RECOVERY_FAILURE ${code}\n`))
        expect(report.mock.calls).toEqual([[code]])
      }
    }
  )
  it.runIf(process.env.RELAY_TUN_DIAGNOSTIC_CONTRACT)(
    'accepts every diagnostic code emitted by the compiled native readiness test',
    () => {
      const contract = process.env.RELAY_TUN_DIAGNOSTIC_CONTRACT
      if (!contract) throw new Error('Native diagnostic contract path is required')
      const { diagnosticCodes } = JSON.parse(readFileSync(contract, 'utf8')) as {
        diagnosticCodes: string[]
      }
      expect(diagnosticCodes.length).toBeGreaterThan(30)
      for (const code of diagnosticCodes) {
        const report = vi.fn(),
          consume = createTunStartDiagnostics(report)
        for (const byte of Buffer.from(`RELAY_TUN_START_FAILURE ${code}\n`))
          consume(Buffer.from([byte]))
        expect(report.mock.calls).toEqual([[code]])
      }
    }
  )
  it('accepts the fixed missing TUN stack diagnostic without forwarding core output', () => {
    const report = vi.fn(),
      consume = createTunStartDiagnostics(report)
    for (const byte of Buffer.from('RELAY_TUN_START_FAILURE core.tun.stack.unavailable\n'))
      consume(Buffer.from([byte]))
    consume(Buffer.from('gVisor is not included in this build, private-node private-token\n'))
    consume(Buffer.from('RELAY_TUN_START_FAILURE core.tun.stack.unavailable private-token\n'))
    expect(report.mock.calls).toEqual([['core.tun.stack.unavailable']])
  })
  it('discards unknown fields, response values and credentials in detailed diagnostics', () => {
    const report = vi.fn(),
      consume = createTunStartDiagnostics(report)
    for (const code of [
      'readiness.field.secret',
      'readiness.field.tun.enable=false',
      'readiness.io.proxies.receive',
      'readiness.io.configs.private-value',
      'readiness.http.configs 401 private-token',
      'readiness.json.configs\u0000private',
      'readiness.field.' + 'x'.repeat(200)
    ])
      consume(Buffer.from(`RELAY_TUN_START_FAILURE ${code}\n`))
    expect(report).not.toHaveBeenCalled()
    consume(Buffer.from('RELAY_TUN_START_FAILURE readiness.field.tun.enable\n'))
    expect(report.mock.calls).toEqual([['readiness.field.tun.enable']])
  })
  it('preserves only fixed recovery codes across chunks with an independent bound', () => {
    const start = vi.fn(),
      recovery = vi.fn(),
      consume = createTunStartDiagnostics(start, recovery)
    for (let i = 0; i < 20; i++) consume(Buffer.from('RELAY_TUN_START_FAILURE managed.state\n'))
    for (const code of [
      'restore.baseline-read',
      'restore.interface-deadline',
      'restore.network-deadline',
      'restore.protection',
      'stop.child-exit',
      'dispose.bundle',
      'dispose.lock',
      'session.baseline'
    ]) {
      for (const byte of Buffer.from(`RELAY_TUN_RECOVERY_FAILURE ${code}\n`))
        consume(Buffer.from([byte]))
    }
    expect(start).toHaveBeenCalledTimes(16)
    expect(recovery).toHaveBeenCalledTimes(8)
    for (const code of [
      'restore.network-deadline /private/token',
      'restore.secret',
      'x'.repeat(200),
      'dispose.record\r',
      'restore.protection\u0000private'
    ])
      consume(Buffer.from(`RELAY_TUN_RECOVERY_FAILURE ${code}\n`))
    expect(recovery).toHaveBeenCalledTimes(8)
    for (let i = 0; i < 20; i++) consume(Buffer.from('RELAY_TUN_RECOVERY_FAILURE restore.state\n'))
    expect(recovery).toHaveBeenCalledTimes(16)
  })
  it('reports only complete bounded native stage codes across stderr chunks', () => {
    const report = vi.fn(),
      consume = createTunStartDiagnostics(report)
    consume(Buffer.from('RELAY_TUN_START_'))
    expect(report).not.toHaveBeenCalled()
    consume(Buffer.from('FAILURE session.baseline\n'))
    consume(
      Buffer.from('private configuration\nRELAY_TUN_START_FAILURE host.spawn /private/secret\n')
    )
    consume(
      Buffer.from(
        'RELAY_TUN_START_FAILURE ' + 'x'.repeat(200) + '\nRELAY_TUN_START_FAILURE readiness.peer\n'
      )
    )
    consume(
      Buffer.from('RELAY_TUN_START_FAILURE session.bundle\r\nRELAY_TUN_START_FAILURE unknown\n')
    )
    consume(
      Buffer.from(
        'RELAY_TUN_START_FAILURE managed.resource\nRELAY_TUN_START_FAILURE managed.lock\n'
      )
    )
    consume(Buffer.from('RELAY_TUN_START_FAILURE managed.spawn /private/secret\n'))
    expect(report.mock.calls).toEqual([
      ['session.baseline'],
      ['readiness.peer'],
      ['managed.resource'],
      ['managed.lock']
    ])
    for (let i = 0; i < 20; i++) consume(Buffer.from('RELAY_TUN_START_FAILURE host.admission\n'))
    expect(report).toHaveBeenCalledTimes(16)
  })
  it('registers recovery before spawning and writes the exact private source/runtime/bundle before bootstrap', async () => {
    const fixture = nativeFixture(),
      c = candidate(),
      events: string[] = []
    const actualSpawn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      expect(readFileSync(logPath(), 'utf8')).toMatch(/diagnostic-ready=[a-f0-9-]{36}\n/)
      expect(statSync(logDirectory + '/logs').mode & 0o7777).toBe(0o700)
      events.push('spawn')
      return fixture.spawn(...args)
    }) as typeof spawn
    let registered: TunSessionHost | undefined
    const host = await openTunNativeHost(
      installation,
      baseline,
      c.runtime,
      c.identity,
      c.launch,
      (value) => {
        events.push('register')
        registered = value
      },
      vi.fn(),
      { readInstallation: async () => installation, spawn: actualSpawn }
    )
    const bootstrap = fixture.frames[0],
      directory = bootstrap.directory as string
    try {
      expect(events).toEqual(['register', 'spawn'])
      expect(registered).toBe(host)
      expect(fixture.frames.slice(0, 2).map((f) => f.action)).toEqual(['bootstrap', 'initialize'])
      expect((await lstat(directory)).mode & 0o7777).toBe(0o700)
      for (const path of ['source.json', 'config.json', 'bundle.json'])
        expect((await lstat(directory + '/' + path)).mode & 0o7777).toBe(0o600)
      expect((await readFile(directory + '/source.json')).toString()).toBe(
        c.launch.sourceConfiguration
      )
      expect(resourceHash(await readFile(directory + '/config.json'))).toBe(
        c.identity.runtimeConfigurationSHA256
      )
      expect(resourceHash(await readFile(directory + '/bundle.json'))).toBe(
        c.runtime.preparation.bundleSHA256
      )
      expect(bootstrap.baseline).toEqual(baseline)
      expect(bootstrap.controlLossPolicy).toBe('restore-owned-session')
      expect(bootstrap.configurationPath).toBe('config.json')
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        fixture.child.stderr.write('private-error\nRELAY_TUN_START_FAILURE host.')
        fixture.child.stderr.write('admission\nRELAY_TUN_START_FAILURE readiness.peer\n')
        await expect.poll(() => warning.mock.calls.length).toBe(2)
        expect(warning.mock.calls).toEqual([
          [`[tun-native] session=${c.identity.sessionId} start-failure=host.admission`, ''],
          [`[tun-native] session=${c.identity.sessionId} start-failure=readiness.peer`, '']
        ])
      } finally {
        warning.mockRestore()
      }
      expect(JSON.parse(bootstrap.projection as string)).toMatchObject({
        version: 1,
        device: 'utun',
        mtu: 1500,
        routes: [],
        resolver: null
      })
      expect((await host.acquire()).phase).toBe('acquired')
      await host.startCore()
      await host.activate()
      await host.stopCore()
      await host.release()
      await host.verifyRestored()
      await host.dispose()
      const persisted = await readFile(logDirectory + '/logs/app.log', 'utf8')
      expect(persisted).toContain(`session=${c.identity.sessionId} start-failure=host.admission`)
      expect(persisted).toContain(`session=${c.identity.sessionId} start-failure=readiness.peer`)
      expect(persisted).not.toContain('private-error')
      expect(persisted).not.toContain(c.runtime.configuration)
      await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('preserves changed private staging rather than recursively deleting it on disposal', async () => {
    const fixture = nativeFixture(),
      c = candidate()
    const host = await openTunNativeHost(
      installation,
      baseline,
      c.runtime,
      c.identity,
      c.launch,
      () => {},
      vi.fn(),
      { readInstallation: async () => installation, spawn: fixture.spawn }
    )
    const directory = fixture.frames[0].directory as string
    try {
      await host.verifyRestored()
      await writeFile(directory + '/source.json', 'changed', { mode: 0o600 })
      await expect(host.dispose()).rejects.toThrow('改变')
      expect((await readFile(directory + '/source.json')).toString()).toBe('changed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it.each(['disabled', 'blocked-parent', 'swallowed-write-error', 'symlink'] as const)(
    'refuses native spawn before diagnostics are available: %s',
    async (failure) => {
      const fixture = nativeFixture(),
        c = candidate(),
        register = vi.fn(),
        error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const path = logPath()
      if (failure === 'blocked-parent') {
        await writeFile(logDirectory + '/logs', 'not a directory')
      } else if (failure === 'symlink') {
        await mkdir(logDirectory + '/logs', { mode: 0o700 })
        await writeFile(logDirectory + '/target', 'preserve')
        await symlink(logDirectory + '/target', path)
      } else {
        await mkdir(logDirectory + '/logs', { mode: 0o700 })
        await writeFile(path, `session=${c.identity.sessionId} diagnostic-ready=old-marker\n`)
        if (failure === 'disabled') setAppLogDisabled(true)
        else {
          await writeFile(logDirectory + '/blocked', 'not a directory')
          vi.mocked(logPath)
            .mockReturnValueOnce(path)
            .mockReturnValueOnce(logDirectory + '/blocked/app.log')
        }
      }
      await expect(
        openTunNativeHost(
          installation,
          baseline,
          c.runtime,
          c.identity,
          c.launch,
          register,
          vi.fn(),
          { readInstallation: async () => installation, spawn: fixture.spawn }
        )
      ).rejects.toThrow('TUN诊断日志无法写入或已关闭')
      expect(register).not.toHaveBeenCalled()
      expect(fixture.spawn).not.toHaveBeenCalled()
      if (failure === 'symlink')
        expect(await readFile(logDirectory + '/target', 'utf8')).toBe('preserve')
      if (failure === 'swallowed-write-error') expect(error).toHaveBeenCalled()
    }
  )
  it('flushes accepted diagnostics on disposal without relying on a terminal', async () => {
    const fixture = nativeFixture(),
      c = candidate(),
      warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await openTunNativeHost(
      installation,
      baseline,
      c.runtime,
      c.identity,
      c.launch,
      () => {},
      vi.fn(),
      { readInstallation: async () => installation, spawn: fixture.spawn }
    )
    const directory = fixture.frames[0].directory as string
    try {
      fixture.child.stderr.write('RELAY_TUN_START_FAILURE managed.spawn\n')
      fixture.child.stderr.write('RELAY_TUN_START_FAILURE readiness.peer\n')
      fixture.child.stderr.write('RELAY_TUN_START_FAILURE readiness.field.tun.enable\n')
      fixture.child.stderr.write('RELAY_TUN_START_FAILURE readiness.http.configs\n')
      fixture.child.stderr.write('RELAY_TUN_RECOVERY_FAILURE restore.network-')
      fixture.child.stderr.write(
        'deadline\nRELAY_TUN_RECOVERY_FAILURE dispose.bundle /private/token\n'
      )
      await host.verifyRestored()
      await host.dispose()
      const persisted = await readFile(logDirectory + '/logs/app.log', 'utf8')
      expect(persisted.match(/start-failure=[\w.-]+/g)).toEqual([
        'start-failure=managed.spawn',
        'start-failure=readiness.peer',
        'start-failure=readiness.field.tun.enable',
        'start-failure=readiness.http.configs'
      ])
      expect(persisted).toContain(`session=${c.identity.sessionId}`)
      expect(persisted.match(/recovery-failure=[\w.-]+/g)).toEqual([
        'recovery-failure=restore.network-deadline'
      ])
      expect(persisted).not.toContain('/private/token')
    } finally {
      warning.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('keeps restoration usable when the existing application log cannot be written', async () => {
    const fixture = nativeFixture(),
      c = candidate(),
      warning = vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = await openTunNativeHost(
      installation,
      baseline,
      c.runtime,
      c.identity,
      c.launch,
      () => {},
      vi.fn(),
      { readInstallation: async () => installation, spawn: fixture.spawn }
    )
    const directory = fixture.frames[0].directory as string
    try {
      await writeFile(logDirectory + '/blocked', 'not a directory')
      vi.mocked(logPath).mockReturnValue(logDirectory + '/blocked/app.log')
      fixture.child.stderr.write('RELAY_TUN_START_FAILURE managed.spawn\n')
      fixture.child.stderr.write('RELAY_TUN_RECOVERY_FAILURE restore.network-deadline\n')
      await host.stopCore()
      await host.release()
      await host.verifyRestored()
      await host.dispose()
      expect(error).toHaveBeenCalled()
      await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      warning.mockRestore()
      error.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })
  it.each(['unknown', 'missing-record', 'dispose-channel', 'dispose-staging'] as const)(
    'retains fixed failure evidence for %s without discarding its recovery capability',
    async (scenario) => {
      let rejectDispose = scenario === 'dispose-channel'
      const f = nativeFixture((response) => {
          if (scenario === 'unknown' && response.action === 'stopCore')
            return {
              ...response,
              observation: {
                ...(response.observation as object),
                phase: 'unknown',
                core: 'unknown',
                device: 'unknown',
                network: 'unknown'
              }
            }
          if (rejectDispose && response.action === 'dispose') return { ...response, closed: false }
          return response
        }),
        c = candidate()
      const host = await openTunNativeHost(
        installation,
        baseline,
        c.runtime,
        c.identity,
        c.launch,
        () => {},
        vi.fn(),
        { readInstallation: async () => installation, spawn: f.spawn }
      )
      const directory = f.frames[0].directory as string
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        if (scenario === 'missing-record') {
          f.child.emit('close', 0)
          await expect(host.stopCore()).rejects.toThrow()
          await expect(host.dispose()).rejects.toThrow()
        } else {
          if (scenario === 'unknown') expect((await host.stopCore()).phase).toBe('unknown')
          await host.verifyRestored()
          if (scenario === 'dispose-staging')
            await writeFile(directory + '/unowned.txt', 'retained')
          if (scenario.startsWith('dispose-')) {
            await expect(host.dispose()).rejects.toThrow()
            expect((await lstat(directory)).isDirectory()).toBe(true)
            rejectDispose = false
            if (scenario === 'dispose-staging') await rm(directory + '/unowned.txt')
          }
          await host.dispose()
          await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
        }
        const persisted = await readFile(logPath(), 'utf8')
        const expected = {
          unknown: 'channel.stopCore.unknown',
          'missing-record': 'channel.stopCore.rejected',
          'dispose-channel': 'dispose.channel.rejected',
          'dispose-staging': 'dispose.staging.rejected'
        }
        expect(persisted).toContain(
          `session=${c.identity.sessionId} recovery-failure=${expected[scenario]}`
        )
        expect(persisted).not.toContain(directory)
        expect(persisted).not.toContain('unowned.txt')
      } finally {
        warning.mockRestore()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
  it('rejects changed installation or unsupported network intent before any process is spawned', async () => {
    const fixture = nativeFixture(),
      c = candidate(),
      register = vi.fn()
    await expect(
      openTunNativeHost(
        installation,
        baseline,
        c.runtime,
        c.identity,
        c.launch,
        register,
        vi.fn(),
        { readInstallation: async () => undefined, spawn: fixture.spawn }
      )
    ).rejects.toThrow('安装变化')
    expect(register).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })
  it('accepts a lost-control restoration only with the bound private record, clean exit and fresh baseline', async () => {
    const fixture = nativeFixture(),
      c = candidate(),
      inspect = vi.fn(async () => ({
        baseline: { ...baseline },
        helper: {} as never,
        network: {} as never
      }))
    const host = await openTunNativeHost(
      installation,
      baseline,
      c.runtime,
      c.identity,
      c.launch,
      () => {},
      vi.fn(),
      { readInstallation: async () => installation, spawn: fixture.spawn, inspect }
    )
    const directory = fixture.frames[0].directory as string
    try {
      fixture.child.emit('close', 0)
      await expect(host.inspect()).rejects.toMatchObject({ code: 'ENOENT' })
      const record = {
        version: 1,
        ...c.identity,
        baseline,
        status: 'restored',
        ownedRecoveryRetained: false
      }
      await writeFile(directory + '/recovery.json', JSON.stringify(record), { mode: 0o600 })
      inspect.mockResolvedValueOnce({
        baseline: { ...baseline, networkSHA256: '9'.repeat(64) },
        helper: {} as never,
        network: {} as never
      })
      await expect(host.inspect()).rejects.toThrow('又有变化')
      expect((await host.inspect()).phase).toBe('restored')
      await host.revokeActivation()
      expect((await host.stopCore()).core).toBe('stopped')
      expect((await host.release()).device).toBe('absent')
      await host.verifyRestored()
      await host.dispose()
      await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(fixture.frames.map((frame) => frame.action)).toEqual(['bootstrap', 'initialize'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function managedRulesCandidate() {
  const c = candidate(),
    configuration = c.launch.sourceConfiguration,
    runtime: TunCoreRuntime = {
      version: 2,
      execution: 'core-managed',
      device: 'utun',
      sourceConfigurationSHA256: c.runtime.sourceConfigurationSHA256,
      runtimeConfigurationSHA256: resourceHash(Buffer.from(configuration)),
      configuration,
      preparation: c.runtime.preparation,
      active: false,
      runtimeVerified: false,
      protectionVerified: false
    }
  return {
    ...c,
    runtime,
    identity: { ...c.identity, runtimeConfigurationSHA256: runtime.runtimeConfigurationSHA256 }
  }
}
describe('Positive pinned TUN rules launcher capability', () => {
  it.each([
    'matched',
    'core-mismatch',
    'null-core',
    'client-mismatch',
    'legacy-rules',
    'legacy-capture'
  ] as const)(
    'admits the nine-FD resource launcher only for both positively pinned client and Core (%s)',
    async (kind) => {
      const f = nativeFixture(),
        c = managedRulesCandidate(),
        uncertain = vi.fn(),
        installed = {
          ...installation,
          execution: 'core-managed' as const,
          clientSHA256:
            kind === 'legacy-rules'
              ? 'c1be9951f5f4d092f866c55c058a73d3d64ee28f50d577fb9e00c955fe17b3d4'
              : kind === 'legacy-capture'
                ? '14949766f12f2ee6db44b14d7b800f112f482639b9c7e181ca6da82045853460'
                : installation.clientSHA256
        },
        host = await openTunNativeHost(
          installed,
          baseline,
          c.runtime,
          c.identity,
          c.launch,
          vi.fn(),
          uncertain,
          {
            readInstallation: async () => installed,
            spawn: f.spawn,
            runtimeCapturePin: { ...runtimeCaptureClient, clientSHA256: '0'.repeat(64) },
            runtimeRulesPin: { capability: 'runtime-rules-v1', clientSHA256: null },
            runtimeResourcesPin: {
              version: 1,
              capability: 'runtime-resources-v1',
              clientSHA256: kind === 'client-mismatch' ? '0'.repeat(64) : installed.clientSHA256,
              cores: {
                arm64:
                  kind === 'null-core'
                    ? null
                    : kind === 'core-mismatch'
                      ? '0'.repeat(64)
                      : installation.coreSHA256,
                x64:
                  kind === 'null-core'
                    ? null
                    : kind === 'core-mismatch'
                      ? '0'.repeat(64)
                      : installation.coreSHA256
              }
            }
          }
        )
      const matched = kind === 'matched',
        rules = matched || kind === 'legacy-rules',
        capture = rules || kind === 'legacy-capture'
      try {
        const [, argv, options] = vi.mocked(f.spawn).mock.calls[0]
        expect(argv).toEqual([
          matched
            ? '--managed-session-runtime-resources-v1'
            : rules
              ? '--managed-session-runtime-rules-v1'
              : capture
                ? '--managed-session-runtime-capture-v1'
                : '--managed-session'
        ])
        expect(options?.stdio).toHaveLength(matched ? 9 : rules ? 7 : capture ? 5 : 3)
        expect(Boolean(host.resourcesChannel)).toBe(matched)
        expect(Boolean(host.resourceInbox)).toBe(matched)
        if (matched)
          expect(f.frames[0]).toHaveProperty('resourceInboxRoot', host.resourceInbox?.directory)
        else expect(f.frames[0]).not.toHaveProperty('resourceInboxRoot')
      } finally {
        host.resourcesChannel?.invalidate()
        host.rulesChannel?.invalidate()
        f.runtimeOutput.emit('end')
        await host.resourceInbox?.dispose()
        if (host.resourceInbox)
          await rm(host.resourceInbox.directory, { recursive: true, force: true })
        await rm(String(f.frames[0].directory), { recursive: true, force: true })
      }
      expect(uncertain).not.toHaveBeenCalled()
    }
  )
  it.each([
    'new',
    'capture149',
    'capture149-current-changed',
    'capture149-rules-mis-pin',
    'unknown',
    'null'
  ] as const)(
    'selects dedicated seven-FD argv only for a positively pinned new client (%s)',
    async (kind) => {
      const legacy = kind.startsWith('capture149'),
        f = nativeFixture(),
        c = managedRulesCandidate(),
        uncertain = vi.fn(),
        installed = {
          ...installation,
          execution: 'core-managed' as const,
          clientSHA256: legacy
            ? '14949766f12f2ee6db44b14d7b800f112f482639b9c7e181ca6da82045853460'
            : installation.clientSHA256
        },
        host = await openTunNativeHost(
          installed,
          baseline,
          c.runtime,
          c.identity,
          c.launch,
          vi.fn(),
          uncertain,
          {
            readInstallation: async () => installed,
            spawn: f.spawn,
            runtimeCapturePin: {
              ...runtimeCaptureClient,
              clientSHA256:
                kind === 'capture149-current-changed' || kind === 'capture149-rules-mis-pin'
                  ? installation.clientSHA256
                  : runtimeCaptureClient.clientSHA256
            },
            ...(kind === 'null'
              ? {}
              : {
                  runtimeRulesPin: {
                    capability: 'runtime-rules-v1',
                    clientSHA256:
                      kind === 'new' || kind === 'capture149-rules-mis-pin'
                        ? installed.clientSHA256
                        : kind === 'unknown'
                          ? '0'.repeat(64)
                          : null
                  }
                })
          }
        )
      try {
        const [, argv, options] = vi.mocked(f.spawn).mock.calls[0]
        expect(argv).toEqual([
          kind === 'new'
            ? '--managed-session-runtime-rules-v1'
            : legacy
              ? '--managed-session-runtime-capture-v1'
              : '--managed-session'
        ])
        expect(options?.stdio).toHaveLength(kind === 'new' ? 7 : legacy ? 5 : 3)
        expect(Boolean(host.rulesChannel)).toBe(kind === 'new')
        expect(Boolean(host.runtimeReader)).toBe(kind === 'new' || legacy)
        expect(f.rulesInput.readableLength).toBe(0)
        if (kind === 'new') {
          const hello = {
            version: 1,
            kind: 'hello',
            ...c.identity,
            launchClientSHA256: installed.clientSHA256,
            installationRevision: installed.revision
          }
          f.runtimeOutput.write(
            JSON.stringify({ ...hello, capability: 'runtime-capture-v1' }) + '\n'
          )
          f.rulesOutput.write(JSON.stringify({ ...hello, capability: 'runtime-rules-v1' }) + '\n')
          await vi.waitFor(() => expect(host.rulesChannel?.isAvailable()).toBe(true))
          expect(host.runtimeReader?.isAvailable()).toBe(true)
          f.rulesOutput.emit('end')
          expect(host.rulesChannel?.isAvailable()).toBe(false)
          expect(f.rulesInput.destroyed).toBe(true)
          expect(f.runtimeInput.destroyed).toBe(false)
          expect(f.runtimeOutput.destroyed).toBe(false)
          expect(f.child.stdin.destroyed).toBe(false)
          expect(host.runtimeReader?.isAvailable()).toBe(true)
          expect((await host.inspect()).phase).toBe('active')
          expect(uncertain).not.toHaveBeenCalled()
        }
      } finally {
        host.rulesChannel?.invalidate()
        f.runtimeOutput.emit('end')
        f.rulesInput.destroy()
        f.rulesOutput.destroy()
        await rm(String(f.frames[0].directory), { recursive: true, force: true })
      }
    }
  )
  it('starts both capability hellos only after a slow verified control bootstrap and preserves early buffered frames', async () => {
    vi.useFakeTimers()
    const f = nativeFixture(),
      c = managedRulesCandidate(),
      installed = { ...installation, execution: 'core-managed' as const }
    f.child.stdout.pause()
    let host: Awaited<ReturnType<typeof openTunNativeHost>> | undefined
    try {
      const pending = openTunNativeHost(
        installed,
        baseline,
        c.runtime,
        c.identity,
        c.launch,
        vi.fn(),
        vi.fn(),
        {
          readInstallation: async () => installed,
          spawn: f.spawn,
          runtimeRulesPin: { capability: 'runtime-rules-v1', clientSHA256: installed.clientSHA256 }
        }
      )
      await vi.waitFor(() =>
        expect(f.frames.some((frame) => frame.action === 'initialize')).toBe(true)
      )
      await vi.advanceTimersByTimeAsync(4000)
      const hello = {
        version: 1,
        kind: 'hello',
        ...c.identity,
        launchClientSHA256: installed.clientSHA256,
        installationRevision: installed.revision
      }
      f.runtimeOutput.write(JSON.stringify({ ...hello, capability: 'runtime-capture-v1' }) + '\n')
      f.rulesOutput.write(JSON.stringify({ ...hello, capability: 'runtime-rules-v1' }) + '\n')
      f.child.stdout.resume()
      host = await pending
      await vi.advanceTimersByTimeAsync(0)
      expect(host.rulesChannel?.isAvailable()).toBe(true)
      expect(host.runtimeReader?.isAvailable()).toBe(true)
    } finally {
      host?.rulesChannel?.invalidate()
      f.runtimeOutput.emit('end')
      f.rulesInput.destroy()
      f.rulesOutput.destroy()
      await rm(String(f.frames[0].directory), { recursive: true, force: true })
      vi.useRealTimers()
    }
  })
  it('waits for a cancelled native rules flight before disposing the restored lifecycle and staging directory', async () => {
    const f = nativeFixture(),
      c = managedRulesCandidate(),
      installed = { ...installation, execution: 'core-managed' as const },
      host = await openTunNativeHost(
        installed,
        baseline,
        c.runtime,
        c.identity,
        c.launch,
        vi.fn(),
        vi.fn(),
        {
          readInstallation: async () => installed,
          spawn: f.spawn,
          runtimeRulesPin: { capability: 'runtime-rules-v1', clientSHA256: installed.clientSHA256 }
        }
      ),
      frames: Record<string, unknown>[] = []
    f.rulesInput.on('data', (bytes: Buffer) => frames.push(JSON.parse(bytes.toString())))
    const send = (raw: unknown) => f.rulesOutput.write(JSON.stringify(raw) + '\n'),
      reply = (id: number, status: string, pending = false) =>
        send({
          version: 1,
          id,
          action: frames.find((frame) => frame.id === id)?.action,
          ...c.identity,
          status,
          pending
        })
    send({
      version: 1,
      kind: 'hello',
      capability: 'runtime-rules-v1',
      ...c.identity,
      launchClientSHA256: installed.clientSHA256,
      installationRevision: installed.revision
    })
    const rules = host.rulesChannel
    expect(rules).toBeDefined()
    if (!rules) throw new Error('fixture rules capability absent')
    try {
      const read = rules.read(new AbortController().signal, () => {})
      await vi.waitFor(() => expect(frames).toHaveLength(1))
      await host.stopCore()
      await host.release()
      await host.verifyRestored()
      const disposal = host.dispose()
      await vi.waitFor(() => expect(frames).toHaveLength(2))
      expect(frames[1]).toMatchObject({ action: 'cancel', operationId: 1 })
      reply(2, 'cancelling', true)
      expect(f.frames.some((frame) => frame.action === 'dispose')).toBe(false)
      expect(rules.isBusy()).toBe(true)
      reply(1, 'cancelled')
      expect(await read).toEqual({ status: 'cancelled' })
      await disposal
      expect(f.frames.filter((frame) => frame.action === 'dispose')).toHaveLength(1)
      expect(f.rulesInput.destroyed && f.rulesOutput.destroyed).toBe(true)
      await expect(lstat(String(f.frames[0].directory))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      rules.invalidate()
      f.runtimeOutput.emit('end')
      await rm(String(f.frames[0].directory), { recursive: true, force: true })
    }
  })
})

const providerCore = geodataManifest.assets[process.arch as 'arm64' | 'x64'].sha256,
  providerClient = '8'.repeat(64),
  legacyResources = 'c586cd3ae1497630f63975c5a1b80e33bd8df1986b3eb7fcbe658936fe16e26d',
  legacyResourceCore =
    process.arch === 'arm64'
      ? 'a1df3f473ece06215230d1b9d012e4e9a6e6c23f8d51fecc83045dfc8eb9431a'
      : 'd7250be4fb4963ebd2fc82aab0177d348f4806da2fa56aa826e10574b8065c4b'
function providerLaunch() {
  const f = nativeFixture(),
    c = managedRulesCandidate(),
    uncertain = vi.fn(),
    installed = {
      ...installation,
      execution: 'core-managed' as const,
      clientSHA256: providerClient,
      coreSHA256: providerCore
    },
    pin = {
      version: 1,
      capability: 'runtime-rule-providers-v1',
      clientSHA256: providerClient as string | null,
      cores: {
        arm64: geodataManifest.assets.arm64.sha256 as string | null,
        x64: geodataManifest.assets.x64.sha256 as string | null
      }
    }
  const open = (overrides: Partial<Parameters<typeof openTunNativeHost>[7]> = {}) =>
    openTunNativeHost(installed, baseline, c.runtime, c.identity, c.launch, vi.fn(), uncertain, {
      readInstallation: async () => installed,
      spawn: f.spawn,
      runtimeCapturePin: { ...runtimeCaptureClient, clientSHA256: '0'.repeat(64) },
      runtimeRulesPin: { capability: 'runtime-rules-v1', clientSHA256: null },
      runtimeResourcesPin: {
        version: 1,
        capability: 'runtime-resources-v1',
        clientSHA256: null,
        cores: { arm64: null, x64: null }
      },
      runtimeRuleProvidersPin: pin,
      ...overrides
    })
  const hello = (capability: string, output: PassThrough) =>
    output.write(
      JSON.stringify({
        version: 1,
        kind: 'hello',
        capability,
        ...c.identity,
        launchClientSHA256: installed.clientSHA256,
        installationRevision: installed.revision
      }) + '\n'
    )
  const clean = async (host: Awaited<ReturnType<typeof open>>) => {
    host.ruleProvidersChannel?.invalidate()
    host.resourcesChannel?.invalidate()
    host.rulesChannel?.invalidate()
    f.runtimeOutput.emit('end')
    await host.resourceInbox?.dispose()
    if (host.resourceInbox) await rm(host.resourceInbox.directory, { recursive: true, force: true })
    await rm(String(f.frames[0].directory), { recursive: true, force: true })
  }
  return { f, c, installed, pin, open, hello, clean, uncertain }
}
describe('Positive provider client and serialized-Core transport admission', () => {
  it.each([
    'matched',
    'null',
    'core-mismatch',
    'installed-core-mismatch',
    'client-mismatch',
    'wrong-capability',
    'default-pin',
    'legacy149',
    'legacy7',
    'legacy9'
  ] as const)(
    'uses11FD only for a positive new pair and preserves the exact older capability (%s)',
    async (kind) => {
      const p = providerLaunch()
      if (kind === 'null') p.pin.clientSHA256 = null
      if (kind === 'core-mismatch') p.pin.cores = { arm64: '0'.repeat(64), x64: '0'.repeat(64) }
      if (kind === 'installed-core-mismatch') p.installed.coreSHA256 = legacyResourceCore
      if (kind === 'client-mismatch') p.pin.clientSHA256 = '7'.repeat(64)
      if (kind === 'wrong-capability') p.pin.capability = 'runtime-resources-v1'
      if (kind === 'legacy149')
        p.installed.clientSHA256 =
          '14949766f12f2ee6db44b14d7b800f112f482639b9c7e181ca6da82045853460'
      if (kind === 'legacy7')
        p.installed.clientSHA256 =
          'c1be9951f5f4d092f866c55c058a73d3d64ee28f50d577fb9e00c955fe17b3d4'
      if (kind === 'legacy9') {
        p.installed.clientSHA256 = legacyResources
        p.installed.coreSHA256 = legacyResourceCore
      }
      if (kind.startsWith('legacy')) p.pin.clientSHA256 = p.installed.clientSHA256
      const host = await p.open(
        kind === 'default-pin' ? { runtimeRuleProvidersPin: undefined } : {}
      )
      try {
        const [, argv, options] = vi.mocked(p.f.spawn).mock.calls[0],
          expected =
            kind === 'matched'
              ? 11
              : kind === 'legacy9'
                ? 9
                : kind === 'legacy7'
                  ? 7
                  : kind === 'legacy149'
                    ? 5
                    : 3
        expect(options?.stdio).toHaveLength(expected)
        expect(argv).toEqual([
          expected === 11
            ? '--managed-session-runtime-rule-providers-v1'
            : expected === 9
              ? '--managed-session-runtime-resources-v1'
              : expected === 7
                ? '--managed-session-runtime-rules-v1'
                : expected === 5
                  ? '--managed-session-runtime-capture-v1'
                  : '--managed-session'
        ])
        expect(Boolean(host.ruleProvidersChannel)).toBe(expected === 11)
        expect(Boolean(host.resourceInbox)).toBe(expected >= 9)
        expect(p.f.providersInput.readableLength).toBe(0)
      } finally {
        await p.clean(host)
      }
      expect(p.uncertain).not.toHaveBeenCalled()
    }
  )
  it('starts provider hello deadline only after slow control.ready and keeps EOF isolated', async () => {
    vi.useFakeTimers()
    const p = providerLaunch()
    p.f.child.stdout.pause()
    let host: Awaited<ReturnType<typeof p.open>> | undefined
    try {
      const pending = p.open()
      await vi.waitFor(() =>
        expect(p.f.frames.some((frame) => frame.action === 'initialize')).toBe(true)
      )
      await vi.advanceTimersByTimeAsync(4000)
      p.hello('runtime-rule-providers-v1', p.f.providersOutput)
      p.f.child.stdout.resume()
      host = await pending
      await vi.advanceTimersByTimeAsync(0)
      expect(host.ruleProvidersChannel?.isAvailable()).toBe(true)
      p.f.providersOutput.emit('end')
      expect(host.ruleProvidersChannel?.isAvailable()).toBe(false)
      expect(p.f.rulesInput.destroyed).toBe(false)
      expect(p.f.resourcesInput.destroyed).toBe(false)
      expect((await host.inspect()).phase).toBe('active')
      expect(p.uncertain).not.toHaveBeenCalled()
    } finally {
      if (host) await p.clean(host)
      vi.useRealTimers()
    }
  })
  it('routes retained provider and Geo tickets only to their own drained capability', async () => {
    const p = providerLaunch(),
      host = await p.open(),
      geo: Record<string, unknown>[] = [],
      providers: Record<string, unknown>[] = []
    for (const [input, output, frames] of [
      [p.f.resourcesInput, p.f.resourcesOutput, geo],
      [p.f.providersInput, p.f.providersOutput, providers]
    ] as const) {
      input.on('data', (bytes: Buffer) => {
        const frame = JSON.parse(bytes.toString())
        frames.push(frame)
        output.write(
          JSON.stringify({
            version: 1,
            id: frame.id,
            action: frame.action,
            ...p.c.identity,
            status: 'discarded',
            pending: false
          }) + '\n'
        )
      })
    }
    try {
      p.hello('runtime-resources-v1', p.f.resourcesOutput)
      p.hello('runtime-rule-providers-v1', p.f.providersOutput)
      await host.resourceInbox?.stage(
        {
          descriptor: { name: 'Geo', kind: 'geosite-dat', behavior: null, selector: 'private' },
          bytes: Buffer.from('geo'),
          sha256: resourceHash(Buffer.from('geo'))
        },
        new AbortController().signal,
        () => {}
      )
      await host.resourceInbox?.stageRuleProvider(
        {
          descriptor: { name: 'Rule', kind: 'rule-yaml', behavior: 'domain', selector: '' },
          bytes: Buffer.from('payload: [one.invalid]'),
          sha256: resourceHash(Buffer.from('payload: [one.invalid]'))
        },
        new AbortController().signal,
        () => {}
      )
      await host.stopCore()
      await host.release()
      await host.verifyRestored()
      await host.dispose()
      expect(geo.map((frame) => frame.kind)).toEqual(['geosite-dat'])
      expect(providers.map((frame) => frame.kind)).toEqual(['rule-yaml'])
      expect(host.resourceInbox?.retained().retained).toHaveLength(0)
      expect(p.f.frames.filter((frame) => frame.action === 'discardBlob')).toHaveLength(0)
      expect(p.uncertain).not.toHaveBeenCalled()
    } finally {
      await p.clean(host)
    }
  })
})

it('drains the provider terminal plus cancel ACK before closing the restored control scope', async () => {
  const p = providerLaunch(),
    host = await p.open(),
    frames: Record<string, unknown>[] = []
  p.f.providersInput.on('data', (bytes: Buffer) => frames.push(JSON.parse(bytes.toString())))
  p.hello('runtime-rule-providers-v1', p.f.providersOutput)
  const providers = host.ruleProvidersChannel
  if (!providers) throw new Error('private provider fixture missing')
  const reply = (id: number, status: string, pending = false) =>
    p.f.providersOutput.write(
      JSON.stringify({
        version: 1,
        id,
        action: frames.find((frame) => frame.id === id)?.action,
        ...p.c.identity,
        status,
        pending
      }) + '\n'
    )
  try {
    const reading = providers.read(new AbortController().signal, () => {})
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    await host.stopCore()
    await host.release()
    await host.verifyRestored()
    const closing = host.dispose()
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    expect(frames[1]).toMatchObject({ action: 'cancel', operationId: 1 })
    reply(2, 'cancelling', true)
    expect(providers.isBusy()).toBe(true)
    expect(p.f.frames.some((frame) => frame.action === 'dispose')).toBe(false)
    reply(1, 'cancelled')
    expect(await reading).toEqual({ status: 'cancelled' })
    await closing
    expect(p.f.frames.filter((frame) => frame.action === 'dispose')).toHaveLength(1)
    expect(p.f.providersInput.destroyed && p.f.providersOutput.destroyed).toBe(true)
    expect(p.uncertain).not.toHaveBeenCalled()
  } finally {
    await p.clean(host)
  }
})

async function checkedSmartToolsCandidate(home: string) {
  const { SmartStateStore } = await import('../core/smart-state-store'),
    catalog = await import('../core/variants-manifest.json')
  const model = catalog.default.models[0],
    core = compiledExecutionCoreV2('smart', process.arch as 'arm64' | 'x64'),
    seed = await new SmartStateStore({
      home,
      stateRoot: home + '/Library/Application Support/Relay-Preview'
    }).prepare('11111111-2222-4333-8444-555555555555', false)
  const c = candidate(),
    source = JSON.parse(c.launch.sourceConfiguration)
  source['proxy-groups'] = [
    {
      name: 'CurrentSmart',
      type: 'smart',
      proxies: ['REJECT'],
      url: 'http://127.0.0.1:1/health',
      collectdata: false
    }
  ]
  const sourceConfiguration = JSON.stringify(source),
    configurationSHA256 = resourceHash(Buffer.from(sourceConfiguration)),
    assets = [
      {
        path: 'Model.bin',
        sha256: model.sha256,
        bytes: await readFile(
          new URL('../../../../.relay-build/variant-reference/model-Model.bin', import.meta.url)
        )
      }
    ],
    pins: never[] = []
  // The runner root is the isolated source copy; cached model input is explicit.
  const checked = encodeCheckedTunExecutionV2(
    {
      version: 2,
      profile: 'smart',
      architecture: core.architecture,
      core: { version: core.version, sha256: core.sha256, size: core.size },
      model: { version: model.version, sha256: model.sha256, size: model.size, path: 'Model.bin' },
      configurationSHA256,
      selectionSHA256: '1'.repeat(64),
      snapshotSHA256: '2'.repeat(64),
      expiresAt: Date.now() + 60000,
      assets: [{ path: 'Model.bin', sha256: model.sha256, size: model.size }]
    },
    seed.receipt
  )
  const installed = {
      ...installation,
      execution: 'core-managed' as const,
      executionCore: core,
      coreSHA256: core.sha256
    },
    store = new SmartStateStore({
      home,
      stateRoot: home + '/Library/Application Support/Relay-Preview'
    })
  const runtime: TunCoreRuntime = {
    version: 2,
    execution: 'core-managed',
    device: 'utun',
    configuration: sourceConfiguration,
    sourceConfigurationSHA256: configurationSHA256,
    runtimeConfigurationSHA256: configurationSHA256,
    preparation: {
      ...c.runtime.preparation,
      bundleSHA256: resourceHash(
        Buffer.from(
          JSON.stringify({
            configuration: source,
            assets: assets.map(({ path, sha256 }) => ({ path, sha256 })),
            pins,
            unresolved: []
          })
        )
      ),
      evidenceSHA256: binding.evidenceSHA256
    },
    checkedExecution: checked,
    active: false,
    runtimeVerified: false,
    protectionVerified: false
  }
  return {
    installed,
    runtime,
    launch: { sourceConfiguration, assets, pins },
    identity: { ...binding, runtimeConfigurationSHA256: configurationSHA256 },
    execution: { ...checked, recheck: () => seed.recheck(), smartState: { prepared: seed, store } }
  }
}
describe('Smart tools positive-pin and independent inherited descriptors', () => {
  it.each([
    'positive',
    'positive-telemetry',
    'work-directory',
    'wrong-work-directory',
    'null',
    'wrong-client',
    'wrong-capability'
  ] as const)('selects eleven descriptors only for exact Smart capability %s', async (kind) => {
    const c = await checkedSmartToolsCandidate(logDirectory),
      f = nativeFixture(),
      uncertain = vi.fn()
    const pin = {
      version: 1,
      capability: kind === 'wrong-capability' ? 'runtime-resources-v1' : 'runtime-smart-tools-v1',
      clientSHA256:
        kind === 'null'
          ? null
          : kind === 'wrong-client' || kind === 'work-directory'
            ? '0'.repeat(64)
            : c.installed.clientSHA256
    }
    const host = await openTunNativeHost(
      c.installed,
      baseline,
      c.runtime,
      c.identity,
      c.launch,
      vi.fn(),
      uncertain,
      {
        readInstallation: async () => c.installed,
        spawn: f.spawn,
        execution: c.execution,
        runtimeSmartToolsPin: pin,
        runtimeTelemetryPin:
          kind === 'positive-telemetry' || kind === 'work-directory'
            ? {
                version: 2,
                capability: 'runtime-telemetry-v2',
                clientSHA256: kind === 'work-directory' ? '0'.repeat(64) : c.installed.clientSHA256
              }
            : { version: 2, capability: 'runtime-telemetry-v2', clientSHA256: null },
        runtimeWorkDirectoryPin: {
          version: 1,
          capability: 'runtime-work-directory-v1',
          clientSHA256:
            kind === 'work-directory'
              ? c.installed.clientSHA256
              : kind === 'wrong-work-directory'
                ? '0'.repeat(64)
                : null
        }
      }
    )
    const enabled = [
        'positive',
        'positive-telemetry',
        'work-directory',
        'wrong-work-directory'
      ].includes(kind),
      argv = vi.mocked(f.spawn).mock.calls[0]
    expect(argv[1]).toEqual([
      kind === 'positive-telemetry' || kind === 'work-directory'
        ? '--managed-session-execution-v2-smart-tools-v1-runtime-telemetry-v2'
        : enabled
          ? '--managed-session-execution-v2-smart-tools-v1'
          : '--managed-session-execution-v2'
    ])
    expect(argv[2]?.stdio).toHaveLength(enabled ? 11 : 9)
    expect(!!host.smartToolsChannel).toBe(enabled)
    expect(!!host.inspectWorkDirectory).toBe(kind === 'work-directory')
    expect(host.resourcesChannel).toBeUndefined()
    expect(host.ruleProvidersChannel).toBeUndefined()
    const stage = String(f.frames[0].directory)
    expect(await readFile(stage + '/execution.json', 'utf8')).toBe(c.execution.raw)
    if (enabled) {
      const lane = host.smartToolsChannel
      if (!lane) throw new Error('missing admitted tools lane')
      f.providersOutput.write(
        JSON.stringify({
          version: 1,
          ...c.identity,
          kind: 'hello',
          capability: 'runtime-smart-tools-v1',
          launchClientSHA256: c.installed.clientSHA256,
          installationRevision: c.installed.revision
        }) + '\n'
      )
      f.providersInput.once('data', (bytes: Buffer) => {
        const q = JSON.parse(bytes.toString())
        f.providersOutput.write(
          JSON.stringify({
            version: 1,
            ...c.identity,
            id: q.id,
            action: 'weights',
            status: 'weights',
            pending: false,
            snapshot: {
              version: 1,
              kind: 'weights',
              configurationRevision: c.identity.runtimeConfigurationSHA256,
              groups: [
                {
                  name: 'CurrentSmart',
                  status: 'ready',
                  weights: [{ Name: 'n', Rank: '', Weight: 0 }]
                }
              ]
            }
          }) + '\n'
        )
      })
      expect((await lane.weights(new AbortController().signal, () => {})).status).toBe('snapshot')
      f.providersOutput.end()
      await new Promise<void>((done) => setImmediate(done))
      expect(lane.isAvailable()).toBe(false)
      expect(uncertain).not.toHaveBeenCalled()
    }
    await host.stopCore()
    await host.release()
    await host.verifyRestored()
    await host.dispose()
    expect(host.smartStateDisposition()).toBeUndefined()
    expect(uncertain).not.toHaveBeenCalled()
    // This synthetic peer never exports; exact seed/stage files remain under the
    // test creator. Enumerate the closed fixture union before finite cleanup.
    const { unlink, rmdir, readdir } = await import('fs/promises')
    expect((await readdir(stage)).sort()).toEqual(
      [
        'Model.bin',
        'bundle.json',
        'config.json',
        'execution.json',
        'source.json',
        'state-result',
        'state-seed'
      ].sort()
    )
    expect(await readdir(stage + '/state-result')).toEqual([])
    expect(await readdir(stage + '/state-seed')).toEqual(['cache.db'])
    await unlink(stage + '/state-seed/cache.db')
    await rmdir(stage + '/state-seed')
    await rmdir(stage + '/state-result')
    for (const name of ['Model.bin', 'bundle.json', 'config.json', 'execution.json', 'source.json'])
      await unlink(stage + '/' + name)
    await rmdir(stage)
  })
})

describe('Positive telemetry v2 fixed launch admission', () => {
  it.each(['matched', 'null', 'wrong-version', 'wrong-capability', 'wrong-client', 'capture-only'])(
    'upgrades only a complete provider capability with its new exact pin (%s)',
    async (kind) => {
      const p = providerLaunch(),
        pin = {
          version: 2,
          capability: 'runtime-telemetry-v2',
          clientSHA256: p.installed.clientSHA256 as string | null
        }
      if (kind === 'null') pin.clientSHA256 = null
      if (kind === 'wrong-client') pin.clientSHA256 = '0'.repeat(64)
      if (kind === 'wrong-version') pin.version = 1
      if (kind === 'wrong-capability') pin.capability = 'runtime-capture-v1'
      const host = await p.open({
        runtimeTelemetryPin: pin,
        ...(kind === 'capture-only'
          ? {
              runtimeRuleProvidersPin: { ...p.pin, clientSHA256: null },
              runtimeCapturePin: { ...runtimeCaptureClient, clientSHA256: p.installed.clientSHA256 }
            }
          : {})
      })
      try {
        const enabled = kind === 'matched',
          [, argv, options] = vi.mocked(p.f.spawn).mock.calls[0]
        expect(argv).toEqual([
          kind === 'capture-only'
            ? '--managed-session-runtime-capture-v1'
            : '--managed-session-runtime-rule-providers-v1' +
              (enabled ? '-runtime-telemetry-v2' : '')
        ])
        expect(options?.stdio).toHaveLength(kind === 'capture-only' ? 5 : 11)
        p.f.runtimeOutput.write(
          JSON.stringify({
            version: enabled ? 2 : 1,
            kind: 'hello',
            capability: enabled ? 'runtime-telemetry-v2' : 'runtime-capture-v1',
            ...p.c.identity,
            launchClientSHA256: p.installed.clientSHA256,
            installationRevision: p.installed.revision
          }) + '\n'
        )
        await vi.waitFor(() => expect(host.runtimeReader?.isAvailable()).toBe(true))
        if (enabled) {
          p.f.runtimeInput.once('data', (bytes: Buffer) => {
            const q = JSON.parse(bytes.toString())
            expect(q).toMatchObject({ version: 2, action: 'traffic' })
            p.f.runtimeOutput.write(
              JSON.stringify({
                ...q,
                status: 'sampled',
                rawFrameBase64: Buffer.from(
                  '{"up":0,"down":1,"upTotal":2,"downTotal":3}\n'
                ).toString('base64')
              }) + '\n'
            )
          })
          expect(await host.runtimeReader?.traffic?.(new AbortController().signal)).toEqual({
            status: 'sampled',
            frame: { up: 0, down: 1, upTotal: 2, downTotal: 3 }
          })
          p.f.runtimeOutput.emit('end')
          expect((await host.inspect()).phase).toBe('active')
          expect(p.uncertain).not.toHaveBeenCalled()
        } else
          expect(await host.runtimeReader?.traffic?.(new AbortController().signal)).toEqual({
            status: 'unsupported'
          })
      } finally {
        await p.clean(host)
      }
    }
  )
  it.each(['stable', 'alpha'] as const)(
    'admits the new execution-v2 suffix only with a separately matching telemetry pin (%s)',
    async (profile) => {
      const c = checkedManagedCandidate(profile),
        f = nativeFixture(),
        uncertain = vi.fn()
      const host = await openTunNativeHost(
        c.installed,
        baseline,
        c.runtime,
        c.identity,
        c.launch,
        vi.fn(),
        uncertain,
        {
          readInstallation: async () => c.installed,
          spawn: f.spawn,
          execution: c.execution,
          runtimeTelemetryPin: {
            version: 2,
            capability: 'runtime-telemetry-v2',
            clientSHA256: c.installed.clientSHA256
          }
        }
      )
      try {
        expect(vi.mocked(f.spawn).mock.calls[0][1]).toEqual([
          '--managed-session-execution-v2-runtime-telemetry-v2'
        ])
        expect(vi.mocked(f.spawn).mock.calls[0][2]?.stdio).toHaveLength(7)
        f.runtimeOutput.write(
          JSON.stringify({
            version: 2,
            kind: 'hello',
            capability: 'runtime-telemetry-v2',
            ...c.identity,
            launchClientSHA256: c.installed.clientSHA256,
            installationRevision: c.installed.revision
          }) + '\n'
        )
        await vi.waitFor(() => expect(host.runtimeReader?.isAvailable()).toBe(true))
        f.runtimeOutput.emit('end')
        expect((await host.inspect()).phase).toBe('active')
        expect(uncertain).not.toHaveBeenCalled()
      } finally {
        host.rulesChannel?.invalidate()
        f.runtimeOutput.emit('end')
        await rm(String(f.frames[0].directory), { recursive: true, force: true })
      }
    }
  )
})
