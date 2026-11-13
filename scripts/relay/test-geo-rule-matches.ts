import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, lstat, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { coreEnvironment } from '../../src/main/relay/core/configuration'
import { ownsHttpListener, probeLocalPort } from '../../src/main/relay/core/port'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { stopOwnedChild } from '../../src/main/relay/core/shutdown'
import { resourceCheckDefinition } from '../../src/main/relay/resources/check-definition'
import { resourceHash } from '../../src/main/relay/resources/source'
import { closeFixture, fixturePort, freeFixturePort } from './fixtures/local-network'
import { geoipFixture, geositeFixture } from './fixtures/rule-resources'
import fixtureManifest from './fixtures/assets/manifest.json'

// Explicitly opt-in, owned test processes only. There is no system proxy, DNS,
// TUN, existing core, public target connection, resource fetch or decoder here.
assert.equal(process.platform, 'darwin')
interface OwnedChild {
  child: ChildProcess
  closed: Promise<void>
  text(): string
  stdout(): string
  code(): number | null
  until(predicate: (text: string) => boolean): Promise<void>
  stop(): Promise<void>
}
const root = await realpath(await mkdtemp('/private/tmp/relay-geo-match-')),
  rootIdentity = await lstat(root),
  coreRoot = resolve('extra/relay/core'),
  core = await verifyCoreResource(coreRoot),
  owned = new Set<OwnedChild>(),
  observations: Record<string, unknown>[] = [],
  maximumOutputBytes = 256 * 1024,
  sourceCommit = '3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8',
  expectedSource = `https://github.com/maxmind/MaxMind-DB/blob/${fixtureManifest.commit}/source-data/`,
  ruleSource = `https://github.com/MetaCubeX/mihomo/blob/${sourceCommit}/tunnel/tunnel.go#L590`
let interrupted = false

// network-inbound implies bind on Darwin; keep both explicit. No outbound,
// UDP, Unix controller or wildcard port exceptions are granted to the child.
const policy = (port: number): string =>
  `(version 1)\n(allow default)\n(deny network*)\n(allow network-bind (local tcp4 "localhost:${port}"))\n(allow network-inbound (local tcp4 "localhost:${port}"))\n`

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
  for (const handle of owned) handle.child.kill('SIGTERM')
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)

async function connectOnlyToFixture(port: number, host: string, marker: number): Promise<string> {
  return new Promise((done, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let received = '',
      failed: Error | undefined
    socket.setTimeout(3000, () => socket.destroy(new Error('Owned request timeout')))
    socket.once('connect', () =>
      socket.write(`CONNECT ${host}:${marker} HTTP/1.1\r\nHost: ${host}:${marker}\r\n\r\n`)
    )
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      if (Buffer.byteLength(received) > 4096)
        socket.destroy(new Error('Owned response limit exceeded'))
    })
    socket.once('error', (error) => {
      failed = error
    })
    socket.once('close', () => {
      if (failed && (failed as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(failed)
      else done(received.split('\r\n')[0])
    })
  })
}

// The profile's negative control targets only this newly owned random loopback
// sentinel. It never tests an external address, DNS server or user port.
async function checkSandbox(port: number, directory: string): Promise<void> {
  const syntax = launch('/usr/bin/true', [], directory, policy(port))
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
  })
  const sentinelPort = await fixturePort(sentinel)
  assert.notEqual(port, sentinelPort)
  const sandbox = policy(port),
    control = launch(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import{createConnection}from'node:net';const s=createConnection({host:'127.0.0.1',port:${sentinelPort}});s.setTimeout(2000,()=>{process.exitCode=1;s.destroy()});s.once('connect',()=>{console.log('UNEXPECTED_CONNECTED');process.exitCode=1;s.destroy()});s.once('error',e=>{console.log(JSON.stringify({code:e.code}));process.exitCode=['EPERM','EACCES'].includes(e.code)?0:1});`
      ],
      directory,
      sandbox
    )
  try {
    await control.until((text) => text.includes('"code"') || text.includes('UNEXPECTED_CONNECTED'))
    await control.closed
    assert.equal(control.code(), 0, control.text())
    assert.match(control.stdout(), /"code":"(?:EPERM|EACCES)"/u)
    assert.equal(accepted, 0)
    observations.push({
      kind: 'sandbox-negative-control',
      sandbox,
      destination: 'owned-random-loopback-sentinel',
      errno: JSON.parse(control.stdout().trim()).code,
      accepted,
      childExitCode: control.code()
    })
  } finally {
    try {
      await control.stop()
    } finally {
      try {
        await writeFile(join(directory, 'sandbox-control.log'), control.text(), {
          flag: 'wx',
          mode: 0o600
        })
      } finally {
        await closeFixture(sentinel)
        assert.equal(await probeLocalPort(sentinelPort), true)
      }
    }
  }
}

const mmdb = async (name: string): Promise<Buffer> => {
  const pin = fixtureManifest.files.find((file) => file.path.endsWith('/' + name))
  assert.ok(pin)
  const bytes = await readFile(pin.path)
  assert.equal(bytes.length, pin.size)
  assert.equal(resourceHash(bytes), pin.sha256)
  return bytes
}

const cases = [
  {
    kind: 'country-mmdb',
    bytes: await mmdb('GeoIP2-Country-Test.mmdb'),
    selector: 'GB',
    ruleType: 'GeoIP',
    payload: 'gb',
    positive: '81.2.69.142',
    negative: '75.209.24.0',
    expectedSource: expectedSource + 'GeoIP2-Country-Test.json',
    expectedPositive: 'GB',
    expectedNegative: 'US'
  },
  {
    kind: 'geoip-dat',
    bytes: geoipFixture(),
    selector: 'RELAY',
    ruleType: 'GeoIP',
    payload: 'relay',
    positive: '127.0.0.2',
    negative: '192.0.2.1',
    expectedSource: 'scripts/relay/fixtures/rule-resources.ts',
    expectedPositive: '127.0.0.0/8',
    expectedNegative: 'outside 127.0.0.0/8'
  },
  {
    kind: 'geosite-dat',
    bytes: geositeFixture(),
    selector: 'RELAY',
    ruleType: 'GeoSite',
    payload: 'RELAY',
    positive: 'fixture.invalid',
    negative: 'unmatched.invalid',
    expectedSource: 'scripts/relay/fixtures/rule-resources.ts',
    expectedPositive: 'full exact fixture.invalid',
    expectedNegative: 'not in fixture domains'
  },
  {
    kind: 'asn-mmdb',
    bytes: await mmdb('GeoLite2-ASN-Test.mmdb'),
    selector: '15169',
    ruleType: 'IPASN',
    payload: '15169',
    positive: '1.0.0.1',
    negative: '1.128.0.1',
    expectedSource: expectedSource + 'GeoLite2-ASN-Test.json',
    expectedPositive: 15169,
    expectedNegative: 1221
  }
] as const

let failure: string | undefined
try {
  for (const [index, item] of cases.entries()) {
    const directory = join(root, item.kind)
    await mkdir(directory, { mode: 0o700 })
    const port = await freeFixturePort(),
      sandbox = policy(port)
    await writeFile(join(directory, 'sandbox.sb'), sandbox, { flag: 'wx', mode: 0o600 })
    if (index === 0) await checkSandbox(port, directory)
    const definition = resourceCheckDefinition({
        name: 'Offline actual rule match fixture',
        kind: item.kind,
        behavior: null,
        selector: item.selector
      }),
      configuration: Record<string, unknown> = {
        ...definition.configuration,
        port,
        'log-level': 'debug'
      },
      source = JSON.stringify(configuration),
      config = join(directory, 'config.json')
    // Fail closed if the reused production definition ever changes scope.
    for (const key of ['socks-port', 'mixed-port', 'redir-port', 'tproxy-port'])
      assert.equal(configuration[key], 0)
    for (const key of ['dns', 'tun', 'ntp', 'sniffer'])
      assert.deepEqual(configuration[key], { enable: false })
    for (const key of ['external-controller', 'external-controller-tls', 'external-ui'])
      assert.equal(configuration[key], '')
    for (const key of ['proxy-providers', 'rule-providers', 'geox-url'])
      assert.ok(
        Object.values(configuration[key] as Record<string, unknown>).every((value) => value === '')
      )
    for (const key of ['proxies', 'proxy-groups', 'listeners'])
      assert.deepEqual(configuration[key], [])
    assert.equal(configuration['geo-auto-update'], false)
    assert.deepEqual(configuration.rules, [
      `${item.ruleType === 'GeoSite' ? 'GEOSITE' : item.ruleType === 'IPASN' ? 'IP-ASN' : 'GEOIP'},${item.selector},REJECT${item.ruleType === 'GeoSite' ? '' : ',no-resolve'}`,
      'MATCH,REJECT'
    ])
    await writeFile(join(directory, definition.filename), item.bytes, { flag: 'wx', mode: 0o600 })
    await writeFile(config, source, { flag: 'wx', mode: 0o600 })
    assert.equal((await verifyCoreResource(coreRoot)).sha256, core.sha256)
    const child = launch(core.executable, ['-d', directory, '-f', config], directory, sandbox)
    const decisions: Record<string, unknown>[] = []
    try {
      await child.until((text) => text.includes(`HTTP proxy listening at: 127.0.0.1:${port}`))
      assert.ok(child.child.pid)
      assert.equal(await ownsHttpListener(child.child.pid, port), true)
      for (const [offset, host] of [item.positive, item.negative].entries()) {
        const marker = 18001 + index * 2 + offset,
          positive = offset === 0,
          expectedType = positive ? item.ruleType : 'Match',
          expectedPayload = positive ? item.payload : '',
          before = child.text().length,
          statusLine = await connectOnlyToFixture(port, host, marker),
          matches = (line: string): boolean =>
            line.includes(`--> ${host}:${marker}`) &&
            (line.includes(
              ` match ${expectedType}${expectedPayload ? '(' + expectedPayload + ')' : ''} using REJECT`
            ) ||
              line.includes(`dial REJECT (match ${expectedType}/${expectedPayload})`))
        await child.until((text) => text.slice(before).split('\n').some(matches))
        const lines = child.text().slice(before).split('\n').filter(matches)
        assert.ok(lines.length > 0)
        decisions.push({
          positive,
          metadataDestination: `${host}:${marker}`,
          ruleType: expectedType,
          payload: expectedPayload,
          target: 'REJECT',
          statusLineForDiagnosticsOnly: statusLine,
          matchedLogLines: lines
        })
      }
      assert.equal(
        resourceHash(await readFile(join(directory, definition.filename))),
        resourceHash(item.bytes)
      )
      assert.equal(resourceHash(await readFile(config)), resourceHash(Buffer.from(source)))
      observations.push({
        kind: item.kind,
        filename: definition.filename,
        fixtureSHA256: resourceHash(item.bytes),
        fixtureBytes: item.bytes.length,
        configurationSHA256: resourceHash(Buffer.from(source)),
        files: await Promise.all(
          [definition.filename, 'config.json', 'sandbox.sb'].map(async (name) => {
            const file = await lstat(join(directory, name))
            assert.ok(file.isFile() && !file.isSymbolicLink() && file.nlink === 1)
            assert.equal(file.uid, process.getuid?.())
            assert.equal(file.mode & 0o7777, 0o600)
            return {
              name,
              sha256: resourceHash(await readFile(join(directory, name))),
              bytes: file.size,
              identity: { dev: file.dev, ino: file.ino, uid: file.uid, mode: file.mode & 0o7777 }
            }
          })
        ),
        sandbox,
        expectedSource: item.expectedSource,
        expectedPositive: item.expectedPositive,
        expectedNegative: item.expectedNegative,
        decisions
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
} finally {
  const cleanup = await Promise.allSettled([...owned].map((child) => child.stop()))
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  if (cleanup.some((result) => result.status === 'rejected') || owned.size)
    failure = 'Owned child cleanup was not confirmed; private fixture evidence retained'
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
    scope: 'pinned-shipping-core-actual-geo-rule-matches-with-owned-loopback-inbound-only',
    architecture: process.arch,
    core: { version: core.version, sha256: core.sha256, sourceCommit, ruleSource },
    fixtureCommit: fixtureManifest.commit,
    runnerSHA256: resourceHash(await readFile(new URL(import.meta.url))),
    fixtureBuilderSHA256: resourceHash(await readFile('scripts/relay/fixtures/rule-resources.ts')),
    observations,
    actualRuleDecisions:
      observations.filter((row) => row.kind !== 'sandbox-negative-control').length * 2,
    passed: !failure && observations.length === 5,
    failure,
    childNetworkPolicy: 'deny network*; only exact per-case 127.0.0.1 TCP bind/inbound allowed',
    sandboxSyntax: {
      addressFilter: 'local tcp4 localhost:P; actual listener verified as 127.0.0.1:P',
      firstAttempt: 'Literal 127.0.0.1 is rejected by Darwin SBPL before any Core launch',
      compilationControl: '/usr/bin/true under the exact first per-case policy'
    },
    outboundExceptions: [],
    dnsOrTunOrSystemChanges: false,
    existingAppOrCoreTouched: false,
    ownedChildrenStopped: owned.size === 0,
    privateFixtureDirectory: root,
    privateFixtureDirectoryRetained: true,
    limits: [
      'Artificial fixture match semantics only; no public geolocation accuracy is claimed',
      'Both positive and negative requests end at REJECT; exact per-request rule logs are the oracle',
      'No business target socket is allowed by the child sandbox',
      'Default core IP-ASN is not Smart prefer-asn selection, TUN activation or product acceptance',
      'Private non-secret fixture files are retained; no recursive removal of a replaceable path'
    ]
  }
  await writeFile(
    '../evidence/geo-rule-match-verification-20261101.json',
    JSON.stringify(proof, null, 2) + '\n',
    { mode: 0o600 }
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
}
if (failure) throw new Error(failure)
