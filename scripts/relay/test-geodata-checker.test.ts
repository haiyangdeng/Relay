import assert from 'assert/strict'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, writeFile, lstat } from 'fs/promises'
import { createConnection, createServer } from 'net'
import { join, resolve } from 'path'
import { it, vi } from 'vitest'
import { geoipFixture, geositeFixture } from './fixtures/rule-resources'
import { closeFixture, fixturePort } from './fixtures/local-network'

// Only this test's process adapter adds a sandbox. All verification, parsing,
// cache IO, controller HTTP, owned shutdown and checker results are production.
const observed = vi.hoisted(() => ({
  calls: [] as {
    action: string
    directory: string
    environment: NodeJS.ProcessEnv
    policy: string
  }[],
  children: [] as { child: ChildProcess; closed: Promise<void>; code: number | null }[]
}))
vi.mock('child_process', async (original) => {
  const cp = await original<typeof import('child_process')>()
  const sandbox = (socket?: string): string =>
    '(version 1) (allow default) (deny network*)' +
    (socket
      ? ` (allow network-bind (local unix-socket (path ${JSON.stringify(socket)}))) (allow network-inbound (local unix-socket (path ${JSON.stringify(socket)})))`
      : '')
  const admit = (file: string, args: readonly string[], cwd: string): void => {
    assert.equal(file, resolve('extra/relay/core-geodata-v1/darwin-arm64/mihomo'))
    assert.match(cwd, /^\/private\/tmp\/relay-(?:core-\d+-|complete-check-)/u)
    assert(args.includes('-f'))
  }
  const track = (child: ChildProcess): void => {
    const entry = { child, closed: Promise.resolve(), code: null as number | null }
    entry.closed = new Promise<void>((done) =>
      child.once('close', (code) => {
        entry.code = code
        done()
      })
    )
    observed.children.push(entry)
  }
  return {
    ...cp,
    execFile: (
      file: string,
      args: readonly string[],
      options: import('child_process').ExecFileOptions,
      callback: (
        error: import('child_process').ExecFileException | null,
        stdout: string,
        stderr: string
      ) => void
    ) => {
      const coreArgs = file === '/usr/bin/sandbox-exec' ? args.slice(3) : args,
        core = file === '/usr/bin/sandbox-exec' ? args[2] : file,
        cwd = String(options.cwd)
      admit(core, coreArgs, cwd)
      assert(coreArgs.includes('-t'))
      const policy = sandbox()
      observed.calls.push({
        action: 'parse',
        directory: cwd,
        environment: { ...options.env },
        policy
      })
      const child = cp.execFile(
        '/usr/bin/sandbox-exec',
        ['-p', policy, core, ...coreArgs],
        { ...options, encoding: 'utf8' },
        callback
      )
      track(child)
      return child
    },
    spawn: (
      file: string,
      args: readonly string[],
      options: import('child_process').SpawnOptions
    ) => {
      const cwd = String(options.cwd),
        socket = args[args.indexOf('-ext-ctl-unix') + 1]
      admit(file, args, cwd)
      assert.equal(socket, join(cwd, 'api.sock'))
      const policy = sandbox(socket)
      observed.calls.push({
        action: 'runtime',
        directory: cwd,
        environment: { ...options.env },
        policy
      })
      const child = cp.spawn('/usr/bin/sandbox-exec', ['-p', policy, file, ...args], options)
      track(child)
      return child
    }
  }
})

it('checks actual CUSTOM-only DAT through saved resource and complete configuration under deny-network', async () => {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.arch, 'arm64')
  assert((process.getuid?.() ?? 0) > 0)
  const expected = process.env.RELAY_GEODATA_CHECKER_EXPECT ?? 'passed',
    output = process.env.RELAY_GEODATA_CHECKER_OUTPUT
  assert(['rejected', 'passed'].includes(expected))
  assert(output)
  const root = await realpath(await mkdtemp('/private/tmp/relay-geo-checker-')),
    { spawn: realSpawn } = await vi.importActual<typeof import('child_process')>('child_process'),
    coreRoot = resolve('extra/relay/core-geodata-v1'),
    { verifyCoreResource } = await import('../../src/main/relay/core/resources'),
    core = await verifyCoreResource(coreRoot),
    { ResourceStore } = await import('../../src/main/relay/resources/store'),
    { createResourceService } = await import('../../src/main/relay/resources/service'),
    { checkResourceWithCore } = await import('../../src/main/relay/resources/checker'),
    { resourceCheckDefinition } = await import('../../src/main/relay/resources/check-definition'),
    { checkCompleteConfiguration } = await import('../../src/main/relay/configuration/checker'),
    { resourceHash } = await import('../../src/main/relay/resources/source'),
    cache = new ResourceStore({
      home: root,
      stateRoot: join(root, 'Library/Application Support/Relay-Preview')
    }),
    results: object[] = []
  assert.equal(core.capability, 'local-geodata-v1')
  let accepted = 0
  const sentinel = createServer((socket) => {
      accepted++
      socket.destroy()
    }),
    sentinelPort = await fixturePort(sentinel),
    calibrationSocket = join(root, 'calibration.sock'),
    policy = `(version 1) (allow default) (deny network*) (allow network-bind (local unix-socket (path ${JSON.stringify(calibrationSocket)}))) (allow network-inbound (local unix-socket (path ${JSON.stringify(calibrationSocket)})))`
  let calibration: ReturnType<typeof realSpawn> | undefined
  let calibrationClosed: Promise<void> | undefined
  let calibrationTimer: ReturnType<typeof setTimeout> | undefined
  try {
    // Same policy recipe: the child may bind/inbound only its exact Unix socket.
    calibration = realSpawn(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        policy,
        process.execPath,
        '-e',
        `
const net=require('node:net');let inbound=false,outbound=false;const finish=()=>{if(inbound&&outbound)server.close();};const server=net.createServer(s=>{s.end('OWNED');inbound=true;finish();});server.listen(${JSON.stringify(calibrationSocket)},()=>{console.log('READY');const s=net.createConnection({host:'127.0.0.1',port:${sentinelPort}});s.setTimeout(2000,()=>process.exit(1));s.once('connect',()=>process.exit(1));s.once('error',e=>{console.log(e.code);if(!['EPERM','EACCES'].includes(e.code))process.exitCode=1;s.destroy();outbound=true;finish();});});`
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root }
      }
    )
    let calibrationText = '',
      calibrationCode: number | null = null
    assert(calibration.stdout)
    calibration.stdout.on('data', (bytes: Buffer) => {
      calibrationText += bytes.toString()
    })
    calibrationClosed = new Promise<void>((done) =>
      calibration?.once('close', (code) => {
        calibrationCode = code
        done()
      })
    )
    calibrationTimer = setTimeout(() => calibration?.kill('SIGKILL'), 10000)
    await vi.waitFor(() => assert(calibrationText.includes('READY')), {
      timeout: 5000,
      interval: 10
    })
    const unixText = await new Promise<string>((done, reject) => {
      const socket = createConnection(calibrationSocket)
      let text = ''
      socket.setTimeout(2000, () => socket.destroy(new Error('Owned calibration timeout')))
      socket.on('data', (bytes: Buffer) => {
        text += bytes.toString()
      })
      socket.once('error', reject)
      socket.once('close', () => done(text))
    })
    await calibrationClosed
    clearTimeout(calibrationTimer)
    assert.equal(calibrationCode, 0)
    assert.equal(unixText, 'OWNED')
    assert.match(calibrationText, /EPERM|EACCES/u)
    assert.equal(accepted, 0)
    results.push({
      kind: 'sandbox-calibration',
      policy,
      unixText,
      outbound: calibrationText.trim(),
      accepted,
      code: calibrationCode
    })
    // Reuse the mature fixture generator, selecting its deterministic second
    // category and changing its label with exact protobuf fixture bytes only.
    // This is no DAT parser/decoder: source config.proto and existing generator
    // determine the fixed framing below (same fields as relay_init_test.go).
    for (const kind of ['geoip-dat', 'geosite-dat'] as const) {
      const generated = kind === 'geoip-dat' ? geoipFixture() : geositeFixture(),
        label = generated.indexOf(Buffer.from('RELAY')),
        original = generated.subarray(label - 4),
        bytes = Buffer.concat([
          Buffer.from([10, original[1] + 1, 10, 6]),
          Buffer.from('CUSTOM'),
          original.subarray(9)
        ])
      assert.equal(label > 4, true)
      assert.deepEqual(original.subarray(0, 4), Buffer.from([10, original.length - 2, 10, 5]))
      assert.equal(original.subarray(4, 9).toString(), 'RELAY')
      assert.equal(bytes.includes(Buffer.from('CN')), false)
      assert.equal(bytes.includes(Buffer.from('CUSTOM')), true)
      const descriptor = {
          name: 'Private CUSTOM only',
          kind,
          behavior: null,
          selector: 'CUSTOM'
        } as const,
        definition = resourceCheckDefinition(descriptor),
        service = createResourceService({
          cache,
          pick: async () => undefined,
          confirm: async () => true,
          download: async () => Buffer.from(bytes),
          check: (job) => checkResourceWithCore(coreRoot, job)
        })
      try {
        const plan = service.prepare({
            descriptor,
            expectedSHA256: resourceHash(bytes),
            source: {
              kind: 'http',
              url: 'https://fixture.invalid/private',
              proxyPort: 18080,
              headers: {}
            }
          }),
          acquired = await service.acquire({ evidenceId: plan.evidenceId })
        assert.equal(acquired.status, 'cached')
        assert(acquired.resource)
        const selected = { id: acquired.resource.id, sha256: acquired.resource.sha256 },
          stored = await cache.read(selected),
          checked = await service.check(selected)
        assert.equal(checked.status, 'checked')
        assert.equal(checked.check?.status, 'passed')
        assert.deepEqual(stored.bytes, bytes)
        for (const loader of ['standard', 'default-memconservative']) {
          const config = {
              ...definition.configuration,
              ...(loader === 'standard' ? { 'geodata-loader': 'standard' } : {})
            },
            source = JSON.stringify(config),
            result = await checkCompleteConfiguration(coreRoot, source, [
              { path: definition.filename, bytes: stored.bytes, sha256: stored.info.sha256 }
            ])
          results.push({
            kind,
            loader,
            resourceCheck: checked.check,
            resourceRevision: stored.revision,
            inputSHA256: stored.info.sha256,
            customOnly: true,
            complete: result
          })
          assert.equal(result.status, expected)
          assert.equal(result.configurationSHA256, resourceHash(Buffer.from(source)))
          assert.equal((await cache.read(selected)).revision, stored.revision)
        }
      } finally {
        service.clear()
        await service.requestClose()
      }
    }
    for (const entry of observed.children) {
      await entry.closed
      assert.equal(entry.child.exitCode !== null || entry.child.signalCode !== null, true)
    }
    for (const directory of new Set(observed.calls.map((call) => call.directory)))
      await assert.rejects(lstat(directory), { code: 'ENOENT' })
    const calls = observed.calls.map((call) => ({
      ...call,
      environment: {
        PATH: call.environment.PATH,
        capability: call.environment.RELAY_LOCAL_GEODATA_V1,
        inheritedPrivate: ['HTTP_PROXY', 'CLASH_CONFIG_STRING', 'SOME_TOKEN'].some(
          (key) => call.environment[key] !== undefined
        )
      }
    }))
    await writeFile(
      output,
      JSON.stringify(
        {
          status: 'passed',
          expectedCompleteStatus: expected,
          root,
          core,
          results,
          calls,
          children: observed.children.map((entry) => ({
            pid: entry.child.pid,
            code: entry.code,
            signal: entry.child.signalCode,
            closed: true
          })),
          limits:
            'No active Core/TUN/App/user roots; download and Native confirmation injected; actual signed ARM resource and complete parsers, own Unix controller, deny-network exact per-child policy; fixture root retained.'
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
  } finally {
    clearTimeout(calibrationTimer)
    if (calibration && calibration.exitCode === null && calibration.signalCode === null)
      calibration.kill('SIGKILL')
    await calibrationClosed
    for (const entry of observed.children) {
      if (entry.child.exitCode === null && entry.child.signalCode === null)
        entry.child.kill('SIGKILL')
      await entry.closed
    }
    await closeFixture(sentinel)
  }
}, 60000)
