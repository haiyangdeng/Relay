import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { connect as tlsConnect, createSecureContext, type TLSSocket } from 'node:tls'
import { defaultEditDocument } from '../../src/shared/relay/configuration-edit'
import { ConfigurationEditStore } from '../../src/main/relay/configuration/edit-store'
import { createConfigurationEditService } from '../../src/main/relay/configuration/edit-service'
import { coreEnvironment } from '../../src/main/relay/core/configuration'
import { localProxyConfiguration } from '../../src/main/relay/core/local-proxy-runtime'
import { ownedCoreConfiguration } from '../../src/main/relay/core/owned-runtime'
import { ownsHttpListener, probeLocalPort } from '../../src/main/relay/core/port'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { stopOwnedChild } from '../../src/main/relay/core/shutdown'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { resourceHash } from '../../src/main/relay/resources/source'
import { closeFixture, fixturePort, freeFixturePort } from './fixtures/local-network'

// Test-only held children, synthetic private stores, one exact loopback inbound.
// The sandbox grants no business outbound, DNS, UDP, Unix or TUN capability.
assert.equal(process.platform, 'darwin')
for (const name of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_OPTIONS'
])
  assert.ok(!process.env[name], `Unset ${name} for the isolated fixture process`)
interface OwnedChild {
  child: ChildProcess
  closed: Promise<void>
  text(): string
  stdout(): string
  code(): number | null
  until(predicate: (text: string) => boolean): Promise<void>
  stop(): Promise<void>
}
const root = await realpath(await mkdtemp('/private/tmp/relay-sniffer-match-')),
  rootIdentity = await lstat(root),
  coreRoot = resolve('extra/relay/core'),
  core = await verifyCoreResource(coreRoot),
  owned = new Set<OwnedChild>(),
  sockets = new Set<Socket>(),
  ports = new Set<number>(),
  observations: Record<string, unknown>[] = [],
  sourceCommit = '3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8',
  maximumOutputBytes = 256 * 1024,
  secureContext = createSecureContext(),
  policy = (port: number): string =>
    `(version 1)\n(allow default)\n(deny network*)\n(allow network-bind (local tcp4 "localhost:${port}"))\n(allow network-inbound (local tcp4 "localhost:${port}"))\n`
let interrupted = false
function launch(
  executable: string,
  args: string[],
  directory: string,
  sandbox: string
): OwnedChild {
  assert.equal(interrupted, false)
  const child = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, executable, ...args], {
    cwd: directory,
    env: coreEnvironment({ ...process.env, HOME: directory, TMPDIR: directory }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })
  let stdout = '',
    combined = '',
    bytes = 0,
    ended = false,
    failure: Error | undefined,
    code: number | null = null
  const capture = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    bytes += chunk.length
    if (bytes > maximumOutputBytes) {
      failure = new Error('Owned fixture output limit exceeded')
      child.kill('SIGKILL')
      return
    }
    combined += chunk.toString('utf8')
    if (stream === 'stdout') stdout += chunk.toString('utf8')
  }
  child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk))
  child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))
  child.once('error', (error) => {
    failure = error
  })
  const closed = new Promise<void>((done) =>
      child.once('close', (exitCode) => {
        ended = true
        code = exitCode
        done()
      })
    ),
    timer = setTimeout(() => {
      failure = new Error('Owned fixture deadline exceeded')
      child.kill('SIGKILL')
    }, 15000)
  const handle = {
    child,
    closed,
    text: () => combined,
    stdout: () => stdout,
    code: () => code,
    async until(predicate: (text: string) => boolean): Promise<void> {
      const deadline = performance.now() + 8000
      while (!predicate(combined)) {
        if (failure) throw failure
        if (ended || interrupted || performance.now() > deadline)
          throw new Error('Owned fixture ended or observation timed out: ' + combined.slice(-8192))
        await delay(10)
      }
      if (failure) throw failure
    },
    async stop(): Promise<void> {
      try {
        if (!ended) await stopOwnedChild(child, closed, 'inert')
        else await closed
      } finally {
        clearTimeout(timer)
        if (ended) owned.delete(handle)
      }
    }
  }
  owned.add(handle)
  return handle
}
const interrupt = (): void => {
  interrupted = true
  for (const socket of sockets) socket.destroy()
  for (const handle of owned) handle.child.kill('SIGTERM')
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
function track(socket: Socket): void {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
}
async function checkSandbox(port: number): Promise<void> {
  const syntax = launch('/usr/bin/true', [], root, policy(port))
  try {
    await syntax.closed
    assert.equal(syntax.code(), 0, syntax.text())
  } finally {
    await syntax.stop()
  }
  let accepted = 0
  const sentinel = createServer((socket) => {
      accepted++
      socket.destroy()
    }),
    sentinelPort = await fixturePort(sentinel)
  let control: OwnedChild | undefined
  try {
    assert.notEqual(port, sentinelPort)
    control = launch(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import{createConnection}from'node:net';const s=createConnection({host:'127.0.0.1',port:${sentinelPort}});s.setTimeout(2000,()=>{process.exitCode=1;s.destroy()});s.once('connect',()=>{console.log('UNEXPECTED_CONNECTED');process.exitCode=1;s.destroy()});s.once('error',e=>{console.log(JSON.stringify({code:e.code}));process.exitCode=['EPERM','EACCES'].includes(e.code)?0:1});`
      ],
      root,
      policy(port)
    )
    await control.closed
    assert.equal(control.code(), 0, control.text())
    assert.match(control.stdout(), /"code":"(?:EPERM|EACCES)"/u)
    assert.equal(accepted, 0)
    observations.push({
      kind: 'sandbox-negative-control',
      sandbox: policy(port),
      destination: 'owned-random-loopback-sentinel',
      accepted,
      errno: JSON.parse(control.stdout().trim()).code,
      childExitCode: control.code()
    })
  } finally {
    try {
      await control?.stop()
      if (control)
        await writeFile(join(root, 'sandbox-control.log'), control.text(), {
          flag: 'wx',
          mode: 0o600
        })
    } finally {
      await closeFixture(sentinel)
      assert.equal(await probeLocalPort(sentinelPort), true)
    }
  }
}
interface ProbeResult {
  sourceTuple: string
  proxyTuple: string
  connectStatus: number
  tlsDiagnostic: string
}
// HTTP CONNECT contains only a reserved IP. SNI enters exclusively through
// OpenSSL on this already connected, address-checked socket (no second dial).
async function sendSNI(port: number, marker: number): Promise<ProbeResult> {
  return new Promise((done, reject) => {
    let raw: Socket | undefined,
      tls: TLSSocket | undefined,
      settled = false
    const timer = setTimeout(() => finish(new Error('Owned TLS probe deadline exceeded')), 5000),
      req = request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: `192.0.2.1:${marker}`,
        headers: { Host: `192.0.2.1:${marker}` },
        agent: false
      })
    function finish(error?: Error, result?: ProbeResult): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      tls?.destroy()
      raw?.destroy()
      req.destroy()
      if (error) reject(error)
      else {
        assert.ok(result)
        done(result)
      }
    }
    req.once('socket', (socket) => {
      raw = socket
      track(socket)
    })
    req.once('error', (error) => finish(error))
    req.once('response', () => finish(new Error('CONNECT did not establish a tunnel')))
    req.once('connect', (response, socket, head) => {
      try {
        assert.equal(response.statusCode, 200)
        assert.equal(socket.remoteAddress, '127.0.0.1')
        assert.equal(socket.remotePort, port)
        assert.equal(socket.localAddress, '127.0.0.1')
        assert.ok(socket.localPort)
        assert.equal(head.length, 0)
        const result: ProbeResult = {
          sourceTuple: `127.0.0.1:${socket.localPort}`,
          proxyTuple: `127.0.0.1:${port}`,
          connectStatus: response.statusCode,
          tlsDiagnostic: 'closed-before-secureConnect'
        }
        tls = tlsConnect({
          socket,
          secureContext,
          servername: 'fixture.invalid',
          rejectUnauthorized: true
        })
        track(tls)
        tls.once('secureConnect', () =>
          finish(new Error('Unexpected TLS peer beyond REJECT rules'))
        )
        tls.once('error', (error: NodeJS.ErrnoException) => {
          result.tlsDiagnostic = error.code ?? error.message
        })
        tls.once('close', () => finish(undefined, result))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.end()
  })
}

let failure: string | undefined
try {
  const firstPort = await freeFixturePort()
  await checkSandbox(firstPort)
  const context = { home: root, stateRoot: join(root, 'Library/Application Support/Relay') },
    profiles = new ProfileStore(context),
    store = new ConfigurationEditStore(context),
    service = createConfigurationEditService({ store, profiles }),
    base = JSON.stringify({
      proxies: [],
      'proxy-groups': [],
      rules: ['DOMAIN,fixture.invalid,REJECT', 'MATCH,REJECT']
    }),
    profile = await profiles.save('Synthetic TLS SNI fixture', base),
    selection = { id: profile.id, sha256: profile.sha256 }
  for (const [index, enable] of [true, false].entries()) {
    const port = index === 0 ? firstPort : await freeFixturePort(),
      marker = 18443 + index,
      directory = join(root, enable ? 'enabled' : 'disabled'),
      sandbox = policy(port)
    ports.add(port)
    await mkdir(directory, { mode: 0o700 })
    const previous = await service.read(),
      sniffer = {
        enable,
        'parse-pure-ip': true,
        'force-dns-mapping': false,
        sniff: { TLS: { ports: ['18443-18444'], 'override-destination': true } },
        'force-domain': [],
        'skip-domain': [],
        'skip-src-address': [],
        'skip-dst-address': []
      },
      saved = await service.saveChecked({
        expectedRevision: previous.revision,
        document: { ...defaultEditDocument(), controlSniff: true, controlled: { sniffer } }
      }),
      reread = await service.read(),
      edited = await service.readRuntimeProfile(selection),
      projection = localProxyConfiguration(edited.text, port),
      parsed: Record<string, unknown> = JSON.parse(projection.configuration)
    assert.equal(reread.revision, saved.revision)
    assert.deepEqual(reread.document.controlled.sniffer, sniffer)
    assert.deepEqual(JSON.parse(edited.text).sniffer, sniffer)
    assert.equal((await profiles.read(selection)).text, base)
    parsed['log-level'] = 'debug'
    const source = JSON.stringify(parsed),
      admitted = ownedCoreConfiguration(source, 'localProxy')
    assert.equal(admitted.port, port)
    assert.deepEqual(admitted.parsed, parsed)
    assert.deepEqual(parsed.sniffer, sniffer)
    assert.deepEqual(parsed.rules, ['DOMAIN,fixture.invalid,REJECT', 'MATCH,REJECT'])
    for (const key of ['socks-port', 'mixed-port', 'redir-port', 'tproxy-port'])
      assert.equal(parsed[key], 0)
    for (const key of ['proxies', 'proxy-groups', 'listeners']) assert.deepEqual(parsed[key], [])
    for (const key of ['proxy-providers', 'rule-providers']) assert.deepEqual(parsed[key], {})
    assert.equal((parsed.dns as Record<string, unknown>).enable, false)
    assert.equal((parsed.tun as Record<string, unknown>).enable, false)
    assert.equal((parsed.ntp as Record<string, unknown>).enable, false)
    assert.equal(parsed['geo-auto-update'], false)
    assert.equal(parsed['external-controller'], '')
    assert.equal(parsed['external-controller-tls'], '')
    assert.equal(parsed['external-controller-unix'] ?? '', '')
    await writeFile(join(directory, 'config.json'), source, { flag: 'wx', mode: 0o600 })
    await writeFile(join(directory, 'sandbox.sb'), sandbox, { flag: 'wx', mode: 0o600 })
    assert.equal((await verifyCoreResource(coreRoot)).sha256, core.sha256)
    const child = launch(
      core.executable,
      ['-d', directory, '-f', join(directory, 'config.json')],
      directory,
      sandbox
    )
    try {
      await child.until((text) => text.includes(`HTTP proxy listening at: 127.0.0.1:${port}`))
      assert.ok(child.child.pid)
      assert.equal(await ownsHttpListener(child.child.pid, port), true)
      const before = child.text().length,
        probe = await sendSNI(port, marker),
        destination = `${enable ? 'fixture.invalid' : '192.0.2.1'}:${marker}`,
        decision = (line: string): boolean =>
          line.includes(`[TCP] ${probe.sourceTuple} --> ${destination}`) &&
          line.includes(
            enable ? ' match Domain(fixture.invalid) using REJECT' : ' match Match using REJECT'
          ),
        replacement = (line: string): boolean =>
          line.includes(
            `[Sniffer] Sniff tcp [${probe.sourceTuple}]-->[192.0.2.1:${marker}] success, replace domain []-->[fixture.invalid]`
          )
      await child.until(
        (text) =>
          text.slice(before).split('\n').some(decision) &&
          (!enable || text.slice(before).split('\n').some(replacement))
      )
      const logs = child.text().slice(before).split('\n'),
        decisionLines = logs.filter(decision),
        replacementLines = logs.filter(replacement)
      assert.ok(decisionLines.length)
      assert.equal(replacementLines.length > 0, enable)
      if (!enable)
        assert.ok(
          !logs.some(
            (line) => line.includes(probe.sourceTuple) && line.includes('Domain(fixture.invalid)')
          )
        )
      assert.equal(
        resourceHash(await readFile(join(directory, 'config.json'))),
        resourceHash(Buffer.from(source))
      )
      observations.push({
        kind: 'tls-sni-rule-decision',
        enable,
        marker,
        originalCONNECTDestination: `192.0.2.1:${marker}`,
        servername: 'fixture.invalid',
        probeDiagnostics: probe,
        ruleType: enable ? 'Domain' : 'Match',
        target: 'REJECT',
        decisionLines,
        replacementLines,
        sandbox,
        checkedEditRevision: saved.revision,
        runtimeRevision: edited.revision,
        originalProfileSHA256: profile.sha256,
        runtimeSourceSHA256: resourceHash(Buffer.from(edited.text)),
        configurationSHA256: resourceHash(Buffer.from(source)),
        childPID: child.child.pid,
        configuration: parsed
      })
    } finally {
      try {
        await child.stop()
      } finally {
        await writeFile(join(directory, 'core.log'), child.text(), { flag: 'wx', mode: 0o600 })
        if (!owned.has(child)) assert.equal(await probeLocalPort(port), true)
      }
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
}
for (const socket of sockets) socket.destroy()
const cleanup = await Promise.allSettled([...owned].map((child) => child.stop()))
process.removeListener('SIGINT', interrupt)
process.removeListener('SIGTERM', interrupt)
if (cleanup.some((result) => result.status === 'rejected') || owned.size)
  failure = [failure, 'Owned child cleanup not confirmed'].filter(Boolean).join('; ')
// Socket.close is asynchronous even after destroy; wait for held sockets only.
await Promise.all(
  [...sockets].map(
    (socket) =>
      new Promise<void>((done) => {
        if (socket.closed) done()
        else socket.once('close', done)
      })
  )
)
const released = await Promise.all(
  [...ports].map(async (port) => ({ port, released: await probeLocalPort(port) }))
)
if (released.some((row) => !row.released))
  failure = [failure, 'Owned fixture port release not confirmed'].filter(Boolean).join('; ')
const current = await lstat(root)
assert.ok(
  current.isDirectory() &&
    !current.isSymbolicLink() &&
    current.dev === rootIdentity.dev &&
    current.ino === rootIdentity.ino &&
    current.uid === process.getuid?.() &&
    (current.mode & 0o7777) === 0o700 &&
    (await realpath(root)) === root
)
const proof = {
  verifiedAt: new Date().toISOString(),
  scope: 'shipping-core-synthetic-TLS-SNI-actual-rule-decisions',
  architecture: process.arch,
  core: { version: core.version, sha256: core.sha256, sourceCommit },
  runnerSHA256: resourceHash(await readFile(new URL(import.meta.url))),
  sourceReuseRecord: '../evidence/sniffer-upstream-source-20261101.json',
  sourceReuseSHA256: resourceHash(
    await readFile('../evidence/sniffer-upstream-source-20261101.json')
  ),
  observations,
  passed: !failure && observations.length === 3,
  failure,
  ownedChildrenStopped: owned.size === 0,
  ownedSocketsClosed: sockets.size === 0,
  released,
  privateFixtureDirectory: root,
  privateFixtureIdentity: {
    dev: current.dev,
    ino: current.ino,
    uid: current.uid,
    mode: current.mode & 0o7777
  },
  privateFixtureDirectoryRetained: true,
  outboundExceptions: [],
  dnsOrTunOrSystemChanges: false,
  existingAppOrCoreTouched: false,
  limits: [
    'TLS SNI minimum loop only, not HTTP/QUIC/TUN or all Sniffer settings',
    'Exact correlated replacement and rule logs are the oracle; CONNECT/TLS status is diagnostics',
    'Disabled REJECT may close before consuming the ClientHello; equal received payload is not claimed',
    'No business target outbound, resource update, external DNS or system configuration was permitted',
    'Tested architecture only; private synthetic files retained without recursive pathname cleanup',
    'Batch 33 and product acceptance are not closed by this fixture'
  ]
}
await writeFile(
  '../evidence/sniffer-rule-match-verification-20261101.json',
  JSON.stringify(proof, null, 2) + '\n',
  { mode: 0o600 }
)
process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
if (!proof.passed) throw new Error(failure ?? 'Incomplete Sniffer observations')
