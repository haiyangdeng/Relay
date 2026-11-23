import assert from 'node:assert/strict'
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { it } from 'vitest'
import type { GeoResourceKind } from '../../src/shared/relay/geo-origins'
import { resourceCheckDefinition } from '../../src/main/relay/resources/check-definition'
import { stopOwnedChild } from '../../src/main/relay/core/shutdown'
import { probeLocalPort } from '../../src/main/relay/core/port'
import {
  createTunResourceInbox,
  type TunResourceInbox
} from '../../src/main/relay/tun/resource-inbox'
import {
  createTunResourcesChannel,
  type TunResourceBlobTicket,
  type TunResourcesChannel,
  type TunResourcesChannelResult,
  type TunResourcesNativeSnapshot
} from '../../src/main/relay/tun/resources-channel'
import { parseTunHostFrame } from '../../src/main/relay/tun/wire-json'
import { geositeFixture, geoipFixture } from './fixtures/rule-resources'

const coreProfile = process.env.RELAY_NATIVE_RESOURCE_CORE_PROFILE ?? 'provider-v1p1',
  selectedCore =
    coreProfile === 'provider-v1p1'
      ? {
          path: '../artifacts/core-geodata-provider-v1p1-pair-20261102/arm64/mihomo',
          sha256: 'a7dcd3ffe59be033ed1b4000a4ae90acdf2ab41450536e02445692ea124195c2',
          version: 'relay-geodata-v1p1-3f27'
        }
      : coreProfile === 'legacy-v1'
        ? {
            path: '../artifacts/core-geodata-v1-signed-core-20261102/darwin-arm64/mihomo',
            sha256: 'a1df3f473ece06215230d1b9d012e4e9a6e6c23f8d51fecc83045dfc8eb9431a',
            version: 'relay-geodata-v1-3f27'
          }
        : undefined
assert(selectedCore, 'Unknown test-only fixed Core profile')
const signedCore = resolve(selectedCore.path),
  signedCoreSHA256 = selectedCore.sha256,
  signedCoreVersion = selectedCore.version,
  classicalGeo = process.env.RELAY_NATIVE_RESOURCE_CLASSICAL === '1',
  hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex'),
  app = resolve('.'),
  uid = process.getuid?.()
interface Held {
  child: ChildProcess
  closed: Promise<void>
  role: string
  stdout: string
  stderr: string
  ready: boolean
  stopRequested: boolean
  failure?: Error
}
interface ResourceCase {
  name: string
  kind: GeoResourceKind
  selector: string
  old: Buffer
  next: Buffer
  positive: string
  negative: string
  rule: string
  afterPositive: string
  afterNegative: string
  loader: 'standard' | 'memconservative'
}
async function waitFor(check: () => boolean, milliseconds = 5000): Promise<void> {
  const deadline = performance.now() + milliseconds
  while (!check()) {
    assert(performance.now() < deadline, 'Private observable deadline')
    await delay(5)
  }
}
async function closeWithin(closed: Promise<void>, milliseconds = 3000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned fixture close deadline')), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
function held(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdio: StdioOptions,
  role: string
): Held {
  const child = spawn(command, args, { cwd, env, stdio, detached: false }),
    result: Held = {
      child,
      closed: new Promise<void>((done) => child.once('close', () => done())),
      role,
      stdout: '',
      stderr: '',
      ready: false,
      stopRequested: false
    }
  child.once('error', (error) => (result.failure = error))
  for (const key of ['stdout', 'stderr'] as const)
    child[key]?.on('data', (bytes: Buffer) => {
      result[key] += bytes.toString('utf8')
      if (Buffer.byteLength(result[key]) > 2 * 1024 * 1024) {
        result.failure ??= new Error('Owned output budget')
        child.kill('SIGTERM')
      }
    })
  return result
}
function live(child: Held): void {
  if (child.failure) throw child.failure
  assert.equal(child.child.exitCode, null, child.stderr)
  assert.equal(child.child.signalCode, null, child.stderr)
}
async function cleanup(children: Held[]): Promise<unknown[]> {
  const errors: unknown[] = []
  // Close the injected Native client before the exact Core child it addresses.
  for (const entry of [...children].reverse()) {
    try {
      if (entry.role === 'native') {
        entry.child.stdin?.end()
        try {
          await closeWithin(entry.closed, 5000)
        } catch (error) {
          if (entry.child.exitCode === null && entry.child.signalCode === null)
            await stopOwnedChild(entry.child, entry.closed, 'inert')
          throw error
        }
      } else if (entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.stopRequested = true
        await stopOwnedChild(
          entry.child,
          entry.closed,
          entry.role === 'core' ? 'localProxy' : 'inert'
        )
      }
      await closeWithin(entry.closed)
      if (entry.role === 'core' && !entry.ready && entry.stopRequested) {
        // An aborted startup may precede Mihomo installing its SIGTERM
        // handler. Record the real signal; it is not a successful Core run.
        assert(entry.child.exitCode === 0 || entry.child.signalCode === 'SIGTERM', entry.stderr)
      } else {
        assert.equal(entry.child.exitCode, 0, entry.stderr)
        assert.equal(entry.child.signalCode, null)
      }
    } catch (error) {
      errors.push(error)
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.child.kill('SIGKILL')
        try {
          await closeWithin(entry.closed)
        } catch (failure) {
          errors.push(failure)
        }
      }
    }
  }
  return errors
}
async function pinnedFixture(name: string): Promise<Buffer> {
  const directory = resolve('scripts/relay/fixtures/assets'),
    manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      files: { path: string; sha256: string }[]
    },
    pin = manifest.files.find((item) => item.path.endsWith('/' + name)),
    bytes = await readFile(join(directory, name))
  assert(pin)
  assert.equal(hash(bytes), pin.sha256)
  return bytes
}
function replaceOne(bytes: Buffer, old: Buffer, next: Buffer): Buffer {
  assert.equal(old.length, next.length)
  const index = bytes.indexOf(old)
  assert(index >= 0 && bytes.indexOf(old, index + 1) === -1)
  const result = Buffer.from(bytes)
  next.copy(result, index)
  return result
}
async function cases(): Promise<ResourceCase[]> {
  // Exact fixture construction reused from fixed Core formal actual7 runner.
  // No new Geo decoder, external data or geographic claims are introduced.
  const site = geositeFixture(),
    nextSite = Buffer.from(
      site.toString('latin1').split('fixture.invalid').join('changed.invalid'),
      'latin1'
    ),
    ip = geoipFixture(),
    nextIP = Buffer.from(ip),
    country = await pinnedFixture('GeoIP2-Country-Test.mmdb'),
    asn = await pinnedFixture('GeoLite2-ASN-Test.mmdb')
  let changed = 0
  for (let i = 0; i < nextIP.length - 3; ++i)
    if (nextIP.subarray(i, i + 4).equals(Buffer.from([127, 0, 0, 0]))) {
      nextIP[i] = 192
      ++changed
    }
  assert.equal(changed, 2)
  const standard: ResourceCase[] = [
      {
        name: 'geosite-standard',
        kind: 'geosite-dat',
        selector: 'RELAY',
        old: site,
        next: nextSite,
        positive: 'fixture.invalid',
        negative: 'changed.invalid',
        rule: 'GeoSite(RELAY)',
        afterPositive: 'Match',
        afterNegative: 'GeoSite(RELAY)',
        loader: 'standard'
      },
      {
        name: 'geoip-standard',
        kind: 'geoip-dat',
        selector: 'RELAY',
        old: ip,
        next: nextIP,
        positive: '127.0.0.2',
        negative: '192.0.2.1',
        rule: 'GeoIP(relay)',
        afterPositive: 'Match',
        afterNegative: 'GeoIP(relay)',
        loader: 'standard'
      },
      {
        name: 'country-standard',
        kind: 'country-mmdb',
        selector: 'GB',
        old: country,
        next: replaceOne(country, Buffer.from([0x42, 71, 66]), Buffer.from([0x42, 90, 90])),
        positive: '81.2.69.142',
        negative: '75.209.24.0',
        rule: 'GeoIP(gb)',
        afterPositive: 'Match',
        afterNegative: 'Match',
        loader: 'standard'
      },
      {
        name: 'asn-standard',
        kind: 'asn-mmdb',
        selector: '15169',
        old: asn,
        next: replaceOne(asn, Buffer.from([0xc2, 0x3b, 0x41]), Buffer.from([0xc2, 0x3b, 0x42])),
        positive: '1.0.0.1',
        negative: '1.128.0.1',
        rule: 'IPASN(15169)',
        afterPositive: 'Match',
        afterNegative: 'Match',
        loader: 'standard'
      }
    ],
    padded = Buffer.alloc(128 * 1024 * 1024)
  standard[2].next.copy(padded)
  return [
    ...standard,
    { ...standard[2], name: 'country-128MiB', next: padded },
    ...standard
      .filter((item) => item.kind.endsWith('-dat'))
      .map((item): ResourceCase => ({
        ...item,
        name: item.kind === 'geosite-dat' ? 'geosite-memconservative' : 'geoip-memconservative',
        loader: 'memconservative'
      }))
  ]
}
async function unixState(
  socketPath: string,
  read?: 'version' | 'configs',
  timeout = 3000
): Promise<Record<string, unknown>> {
  const bytes = read ? undefined : Buffer.from('{"version":1,"action":"state"}')
  return new Promise((done, reject) => {
    const req = request(
      {
        socketPath,
        path: read ? '/' + read : '/relay/geodata/v1',
        method: read ? 'GET' : 'POST',
        agent: false,
        headers: bytes
          ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length }
          : undefined
      },
      (reply) => {
        const chunks: Buffer[] = []
        let length = 0
        reply.on('data', (part: Buffer) => {
          length += part.length
          if (length > 8192) req.destroy(new Error('Private state limit'))
          else chunks.push(part)
        })
        reply.once('error', reject)
        reply.once('end', () => {
          try {
            assert.equal(reply.statusCode, 200)
            done(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.setTimeout(timeout, () =>
      req.destroy(Object.assign(new Error('Private state deadline'), { code: 'ETIMEDOUT' }))
    )
    req.once('error', reject)
    req.end(bytes)
  })
}
async function coreReady(
  core: Held,
  socketPath: string,
  port: number
): Promise<{
  version: Record<string, unknown>
  loaded: Record<string, unknown>
  attempts: number
  elapsedMilliseconds: number
}> {
  const began = performance.now(),
    deadline = began + 5000
  let attempts = 0
  while (true) {
    live(core)
    try {
      ++attempts
      const remaining = (): number => Math.max(1, Math.min(500, deadline - performance.now())),
        version = await unixState(socketPath, 'version', remaining())
      live(core)
      assert.equal(version.version, signedCoreVersion)
      const loaded = await unixState(socketPath, 'configs', remaining())
      live(core)
      assert.equal(loaded.port, port)
      assert.equal(loaded.mode, 'rule')
      assert(loaded.tun && typeof loaded.tun === 'object' && !Array.isArray(loaded.tun))
      assert.equal((loaded.tun as Record<string, unknown>).enable, false)
      assert(performance.now() < deadline, 'Private Core startup deadline')
      core.ready = true
      return { version, loaded, attempts, elapsedMilliseconds: performance.now() - began }
    } catch (error) {
      // Startup observations only. Mutating Core requests are never retried.
      live(core)
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        ['ECONNREFUSED', 'ENOENT', 'ETIMEDOUT'].includes(error.code)
      ))
        throw error
      assert(performance.now() < deadline, 'Private Unix Core readiness deadline')
      await delay(5)
    }
  }
}
function snapshot(
  result: TunResourcesChannelResult,
  status = 'snapshot'
): TunResourcesNativeSnapshot {
  assert.equal(result.status, status)
  assert('snapshot' in result)
  return result.snapshot
}

it.runIf(!!process.env.RELAY_NATIVE_RESOURCE_FIXTURE)(
  'pairs the production Node resource producer and pipe broker with Native authority and the signed sandbox Core',
  async () => {
    assert(uid && uid > 0 && uid === process.geteuid?.())
    assert.equal(process.arch, 'arm64')
    const fixture = await realpath(process.env.RELAY_NATIVE_RESOURCE_FIXTURE ?? ''),
      fixtureSHA = hash(await readFile(fixture))
    assert(fixture.startsWith('/private/tmp/relay-resources-core-fixture-'))
    assert.equal(fixtureSHA, process.env.RELAY_NATIVE_RESOURCE_FIXTURE_SHA256)
    assert.equal(hash(await readFile(signedCore)), signedCoreSHA256)
    const all = await cases(),
      selectedNames = (process.env.RELAY_NATIVE_RESOURCE_CASES ?? 'geosite-standard').split(','),
      selected =
        selectedNames[0] === 'all' ? all : all.filter((item) => selectedNames.includes(item.name)),
      results: Record<string, unknown>[] = []
    assert(
      selected.length && (selectedNames[0] === 'all' || selected.length === selectedNames.length)
    )
    if (classicalGeo) assert(selected.length === 1 && selected[0].name === 'geosite-standard')
    for (const item of selected) {
      const root = await mkdtemp(`/private/tmp/relay-session-${uid}-native-resource-`),
        children: Held[] = [],
        environment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        observations: Record<string, unknown>[] = []
      let core: Held | undefined,
        native: Held | undefined,
        inbox: TunResourceInbox | undefined,
        channel: TunResourcesChannel | undefined,
        failure: unknown[] = [],
        cleanupFailures: unknown[] = [],
        port = 0,
        socketPath = ''
      const report: Record<string, unknown> = {
        name: item.name,
        kind: item.kind,
        loader: item.loader,
        root,
        observations
      }
      results.push(report)
      try {
        const originalCalibration = await readFile(
            'core-extensions/mihomo-geodata-v1/tests/calibrate-sandbox.mjs',
            'utf8'
          ),
          needle = "'/private/tmp/relay-geo-local-proto-'",
          calibration = join(root, 'calibrate.mjs')
        assert.equal(originalCalibration.split(needle).length, 2)
        const adapted = originalCalibration.replace(
          needle,
          JSON.stringify(`/private/tmp/relay-session-${uid}-`)
        )
        await writeFile(calibration, adapted, { flag: 'wx', mode: 0o600 })
        const calibrator = held(
          process.execPath,
          ['--import', resolve('node_modules/tsx/dist/loader.mjs'), calibration, root, app],
          root,
          environment,
          ['ignore', 'pipe', 'pipe'],
          'calibrator'
        )
        children.push(calibrator)
        await closeWithin(calibrator.closed, 15000)
        assert.equal(calibrator.child.exitCode, 0, calibrator.stderr)
        const calibrationProof = JSON.parse(
          await readFile(join(root, 'sandbox-calibration.json'), 'utf8')
        ) as {
          status: string
          allowedPort: number
          socketPath: string
          policy: string
          acceptedBySentinel: number
        }
        assert.equal(calibrationProof.status, 'passed')
        assert.equal(calibrationProof.acceptedBySentinel, 0)
        port = calibrationProof.allowedPort
        socketPath = calibrationProof.socketPath
        const home = join(root, 'run'),
          descriptor = resourceCheckDefinition({
            name: 'Native resource fixture',
            kind: item.kind,
            behavior: null,
            selector: item.selector
          }),
          providerBody = Buffer.from('payload:\n - GEOSITE,RELAY\n'),
          providerPath = `relay-files/${hash(providerBody)}.yaml`,
          config = Buffer.from(
            JSON.stringify({
              ...descriptor.configuration,
              port,
              'geodata-loader': item.loader,
              'log-level': 'debug',
              ...(classicalGeo
                ? {
                    'rule-providers': {
                      ClassicalGeo: {
                        type: 'file',
                        behavior: 'classical',
                        format: 'yaml',
                        path: providerPath,
                        interval: 0
                      }
                    },
                    rules: ['RULE-SET,ClassicalGeo,REJECT', 'MATCH,REJECT']
                  }
                : {})
            })
          ),
          configurationSHA = hash(config),
          configPath = join(home, 'config.yaml'),
          targetPath = join(home, descriptor.filename)
        const absent = await lstat(socketPath).then(
          () => false,
          (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
        )
        assert(absent)
        await writeFile(configPath, config, { flag: 'wx', mode: 0o600 })
        await writeFile(targetPath, item.old, { flag: 'wx', mode: 0o600 })
        if (classicalGeo) {
          await mkdir(join(home, 'relay-files'), { mode: 0o700 })
          await writeFile(join(home, providerPath), providerBody, { flag: 'wx', mode: 0o600 })
        }
        const originalProvider = classicalGeo
          ? await lstat(join(home, providerPath), { bigint: true })
          : undefined
        const originalConfig = await lstat(configPath, { bigint: true }),
          oldIdentity = await lstat(targetPath, { bigint: true })
        core = held(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            calibrationProof.policy,
            signedCore,
            '-d',
            home,
            '-f',
            configPath,
            '-ext-ctl-unix',
            socketPath
          ],
          home,
          { ...environment, HOME: home, TMPDIR: home, RELAY_LOCAL_GEODATA_V1: '1' },
          ['ignore', 'pipe', 'pipe'],
          'core'
        )
        children.push(core)
        const coreSession = core
        await waitFor(() => {
          live(coreSession)
          return (
            coreSession.stdout.includes(`HTTP proxy listening at: 127.0.0.1:${port}`) ||
            coreSession.stderr.includes(`HTTP proxy listening at: 127.0.0.1:${port}`)
          )
        })
        const pid = core.child.pid
        assert(pid)
        const startup = await coreReady(coreSession, socketPath, port),
          { version } = startup,
          initialState = await unixState(socketPath)
        assert.equal(initialState.sequence, 0)
        inbox = await createTunResourceInbox()
        const producer = inbox
        const binding = {
            sessionId: randomUUID(),
            evidenceSHA256: hash(Buffer.from(item.name)),
            runtimeConfigurationSHA256: configurationSHA
          },
          descriptorPath = join(root, 'native-fixture.json')
        await writeFile(
          descriptorPath,
          JSON.stringify({
            home,
            sourceRoot: inbox.directory,
            binding,
            corePID: pid,
            kind: item.kind,
            initialSHA256: hash(item.old),
            initialBytes: item.old.length
          }),
          { flag: 'wx', mode: 0o600 }
        )
        native = held(
          fixture,
          [descriptorPath],
          root,
          environment,
          Array(9).fill('pipe') as 'pipe'[],
          'native'
        )
        children.push(native)
        const receiver = native
        const events = (): Record<string, unknown>[] =>
          receiver.stdout
            .slice(0, receiver.stdout.lastIndexOf('\n') + 1)
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        await waitFor(() => {
          live(receiver)
          return events().some((event) => event.event === 'CONTROL_READY')
        })
        receiver.ready = true
        const descriptors: readonly (Readable | Writable | null | undefined)[] =
          receiver.child.stdio
        const input = descriptors[7],
          output = descriptors[8]
        assert(input instanceof Writable && output instanceof Readable)
        channel = createTunResourcesChannel(
          {
            write: (frame) => {
              assert(!input.destroyed)
              input.write(frame)
            },
            onData: (callback) => {
              output.on('data', callback)
            },
            onGone: (callback) => {
              output.once('end', callback)
              output.once('close', callback)
            },
            onFault: (callback) => {
              output.once('error', callback)
              input.once('error', callback)
            },
            close: () => {
              input.destroy()
              output.destroy()
            }
          },
          { ...binding, launchClientSHA256: fixtureSHA, installationRevision: 'e'.repeat(64) }
        )
        const broker = channel,
          control = receiver.child.stdin
        assert(control)
        let wire = Buffer.alloc(0)
        const frames: Record<string, unknown>[] = []
        output.on('data', (part: Buffer) => {
          wire = Buffer.concat([wire, part])
          for (let end = wire.indexOf(10); end >= 0; end = wire.indexOf(10)) {
            const frame = parseTunHostFrame(wire.subarray(0, end))
            assert(frame && typeof frame === 'object' && !Array.isArray(frame))
            frames.push(frame as Record<string, unknown>)
            wire = wire.subarray(end + 1)
          }
          assert(wire.length <= 8192)
        })
        const assertLive = (): void => {
            live(coreSession)
            live(receiver)
          },
          signal = (): AbortSignal => new AbortController().signal,
          command = (value: string): void => {
            control.write(value + '\n')
          },
          countEvents = (name: string): number =>
            events().filter((event) => event.event === name).length,
          eventAfter = async (
            name: string,
            before: number,
            milliseconds = 5000
          ): Promise<Record<string, unknown>> => {
            await waitFor(() => {
              assertLive()
              return countEvents(name) > before
            }, milliseconds)
            const last = events()
              .filter((event) => event.event === name)
              .at(-1)
            assert(last)
            return last
          },
          stats = async (): Promise<Record<string, unknown>> => {
            const before = countEvents('state')
            command('state')
            return eventAfter('state', before)
          },
          stage = async (bytes: Buffer): Promise<TunResourceBlobTicket> =>
            producer.stage(
              {
                descriptor: {
                  name: 'Native resource fixture',
                  kind: item.kind,
                  behavior: null,
                  selector: item.selector
                },
                bytes,
                sha256: hash(bytes)
              },
              signal(),
              assertLive
            ),
          mutation = (current: TunResourcesNativeSnapshot, ticket: TunResourceBlobTicket) => ({
            configurationRevision: current.configurationRevision,
            expectedGenerationSHA256: current.generationSHA256,
            kind: item.kind,
            oldSHA256: current.resources[0].sha256,
            newSHA256: ticket.sha256,
            blobId: ticket.blobId,
            selector: ticket.selector,
            bytes: ticket.bytes
          }),
          discard = async (ticket: TunResourceBlobTicket): Promise<string> => {
            await broker.whenIdle()
            const status = await broker.discardBlob(ticket)
            assert(['discarded', 'absent'].includes(status))
            producer.acknowledgeDiscard(ticket)
            return status
          }
        let current = snapshot(await channel.read(signal(), assertLive))
        assert.equal(current.configurationRevision, configurationSHA)
        assert.equal(current.resources[0].active, true)
        const rawScope = JSON.stringify(current)
        for (const forbidden of [String(initialState.bootId), home, nonceMarker()])
          assert(!rawScope.includes(forbidden))
        const unchanged = await stage(item.old),
          beforeNoop = await stats()
        current = snapshot(
          await channel.replace(mutation(current, unchanged), signal(), assertLive),
          'unchanged'
        )
        assert.equal(await discard(unchanged), 'discarded')
        const afterNoop = await stats()
        for (const key of ['prepares', 'commits', 'cancels'])
          assert.equal(
            (afterNoop.counts as Record<string, unknown>)[key],
            (beforeNoop.counts as Record<string, unknown>)[key]
          )
        const cancelled = await stage(item.next),
          holdEvent = countEvents('holdReady')
        command('hold-prepare')
        await eventAfter('holdReady', holdEvent)
        const preparedEvent = countEvents('preparedHeld'),
          abort = new AbortController(),
          pending = channel.replace(mutation(current, cancelled), abort.signal, assertLive)
        await eventAfter('preparedHeld', preparedEvent, 30000)
        abort.abort()
        await waitFor(() => {
          assertLive()
          return frames.some((frame) => frame.action === 'cancel' && frame.pending === true)
        })
        assert(channel.isBusy())
        const drained = channel.whenIdle()
        command('release-prepare')
        assert.equal((await pending).status, 'cancelled')
        await drained
        assert.equal(await discard(cancelled), 'absent')
        const afterCancel = await unixState(socketPath)
        assert.equal(afterCancel.sequence, 0)
        assert.equal(hash(await readFile(targetPath)), hash(item.old))
        const decision = async (
          target: string,
          marker: number,
          expected: string
        ): Promise<void> => {
          let local = 0
          const stdoutOffset = coreSession.stdout.length,
            stderrOffset = coreSession.stderr.length
          await new Promise<void>((done, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port })
            socket.setTimeout(2000, () =>
              socket.destroy(new Error('Private reject inbound deadline'))
            )
            socket.once('connect', () => {
              assert.equal(socket.remoteAddress, '127.0.0.1')
              assert.equal(socket.remotePort, port)
              assert(socket.localPort)
              local = socket.localPort
              socket.write(
                `CONNECT ${target}:${marker} HTTP/1.1\r\nHost: ${target}:${marker}\r\n\r\n`
              )
            })
            socket.resume()
            socket.once('error', reject)
            socket.once('close', () => done())
          })
          let line: string | undefined
          await waitFor(() => {
            assertLive()
            line = (coreSession.stdout.slice(stdoutOffset) + coreSession.stderr.slice(stderrOffset))
              .split('\n')
              .find(
                (value) =>
                  value.includes(`${target}:${marker}`) &&
                  value.includes(`127.0.0.1:${local}`) &&
                  value.includes(`match ${expected}`) &&
                  value.includes('using REJECT')
              )
            return !!line
          }, 2000)
          observations.push({
            target,
            marker,
            source: `127.0.0.1:${local}`,
            expectedRule: expected,
            stdoutOffset,
            stderrOffset,
            line
          })
        }
        await decision(item.positive, 42001, classicalGeo ? 'RuleSet(ClassicalGeo)' : item.rule)
        await decision(item.negative, 42000, 'Match')
        const next = await stage(item.next),
          updateBegan = performance.now()
        current = snapshot(
          await channel.replace(mutation(current, next), signal(), assertLive),
          'updated'
        )
        const updateMS = performance.now() - updateBegan
        assert.equal(await discard(next), 'absent')
        assert.equal(current.resources[0].sha256, hash(item.next))
        assert.equal(hash(await readFile(targetPath)), hash(item.next))
        await decision(item.positive, 42002, item.afterPositive)
        await decision(
          item.negative,
          42003,
          classicalGeo ? 'RuleSet(ClassicalGeo)' : item.afterNegative
        )
        const firstTarget = await lstat(targetPath, { bigint: true }),
          firstState = await unixState(socketPath)
        assert.equal(firstState.sequence, 1)
        assert.equal(firstState.generationSHA256, current.generationSHA256)
        const retained = (await readdir(home)).filter((name) =>
          /^RelayGeo\.retained-[0-9a-f]{64}$/u.test(name)
        )
        assert.equal(retained.length, 1)
        const retainedOld = await lstat(join(home, retained[0]), { bigint: true })
        for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size'] as const)
          assert.equal(retainedOld[key], oldIdentity[key])
        assert.equal(hash(await readFile(join(home, retained[0]))), hash(item.old))
        const unknown = await stage(item.old),
          unknownEvent = countEvents('unknownReady')
        command('unknown-next')
        await eventAfter('unknownReady', unknownEvent)
        const uncertain = await channel.replace(mutation(current, unknown), signal(), assertLive)
        assert.equal(uncertain.status, 'uncertain')
        assert(!('snapshot' in uncertain))
        assert.equal(await discard(unknown), 'absent')
        const privateBefore = await stats(),
          isolatedRead = await channel.read(signal(), assertLive),
          privateAfter = await stats()
        assert.equal(isolatedRead.status, 'uncertain')
        assert(!('snapshot' in isolatedRead))
        assert.deepEqual(privateAfter.counts, privateBefore.counts)
        assert.equal(privateAfter.isolated, true)
        const actualAfterUnknown = await unixState(socketPath)
        assert.equal(actualAfterUnknown.sequence, 2)
        assert.equal(hash(await readFile(targetPath)), hash(item.old))
        await decision(item.positive, 42004, classicalGeo ? 'RuleSet(ClassicalGeo)' : item.rule)
        const secondRetained = (await readdir(home)).filter(
          (name) => /^RelayGeo\.retained-[0-9a-f]{64}$/u.test(name) && name !== retained[0]
        )
        assert.equal(secondRetained.length, 1)
        const displaced = await lstat(join(home, secondRetained[0]), { bigint: true })
        assert.equal(displaced.ino, firstTarget.ino)
        assert.equal(displaced.dev, firstTarget.dev)
        assert.equal(hash(await readFile(join(home, secondRetained[0]))), hash(item.next))
        assert.equal(hash(await readFile(configPath)), configurationSHA)
        const afterConfig = await lstat(configPath, { bigint: true })
        for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)
          assert.equal(afterConfig[key], originalConfig[key])
        if (classicalGeo) {
          assert(originalProvider)
          assert.equal(hash(await readFile(join(home, providerPath))), hash(providerBody))
          const afterProvider = await lstat(join(home, providerPath), { bigint: true })
          for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'] as const)
            assert.equal(afterProvider[key], originalProvider[key])
          report.classicalDependency = {
            provider: 'ClassicalGeo',
            kind: 'file',
            format: 'yaml',
            behavior: 'classical',
            rule: 'GEOSITE,RELAY',
            providerSHA256: hash(providerBody),
            inodeUnchanged: true,
            bodyUnchanged: true,
            providerPUTCount: 0,
            onlyGeoPrepareCommit: true
          }
        }
        assert.equal(core.child.pid, pid)
        assertLive()
        const disposal = await inbox.dispose()
        assert.equal(disposal.retained.length, 0)
        assert.equal(disposal.handlesClosed, true)
        report.status = 'passed'
        Object.assign(report, {
          pid,
          configurationSHA256: configurationSHA,
          initialGeneration: initialState.generationSHA256,
          confirmedGeneration: current.generationSHA256,
          observedUnknownGeneration: actualAfterUnknown.generationSHA256,
          oldSHA256: hash(item.old),
          newSHA256: hash(item.next),
          newBytes: item.next.length,
          updateMS,
          privateAfter,
          coreVersion: version.version,
          startup: { attempts: startup.attempts, elapsedMilliseconds: startup.elapsedMilliseconds },
          policy: calibrationProof.policy,
          calibration: {
            originalSHA256: hash(Buffer.from(originalCalibration)),
            adaptedSHA256: hash(Buffer.from(adapted)),
            acceptedBySentinel: 0
          },
          explicitUnknownTestTransactionWritesOldBytes: true,
          automaticRollbackOrRetry: false
        })
      } catch (error) {
        failure = [error]
        report.status = 'failed'
        report.error = String(error)
      } finally {
        if (channel?.isBusy()) {
          try {
            await channel.cancel()
            await channel.whenIdle()
          } catch (error) {
            failure.push(error)
          }
        }
        const disposal = await inbox?.dispose().catch((error: unknown) => {
          failure.push(error)
          return undefined
        })
        if (disposal) report.spool = disposal
        cleanupFailures = await cleanup(children)
        report.processes = children.map((entry) => ({
          role: entry.role,
          pid: entry.child.pid,
          exitCode: entry.child.exitCode,
          signal: entry.child.signalCode,
          stderr: entry.stderr,
          stdout: entry.stdout,
          ready: entry.ready,
          fixtureStopRequested: entry.stopRequested
        }))
        const releaseChecks = await Promise.allSettled([
          (async () => {
            if (!port) return
            const released = await probeLocalPort(port)
            report.portReleased = released
            assert(released, 'Owned port not released')
          })(),
          (async () => {
            if (!socketPath) return
            const connected = await new Promise<boolean>((done) => {
              const socket = createConnection(socketPath)
              socket.setTimeout(1000, () => {
                socket.destroy()
                done(false)
              })
              socket.once('connect', () => {
                socket.destroy()
                done(true)
              })
              socket.once('error', () => done(false))
            })
            report.unixReleased = !connected
            assert(!connected, 'Owned Unix listener not released')
          })()
        ])
        cleanupFailures.push(
          ...releaseChecks.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          )
        )
        report.cleanupErrors = cleanupFailures.map(String)
      }
      await writeFile(
        join(root, 'native-resource-result.json'),
        JSON.stringify(report, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 }
      )
      if (failure.length || cleanupFailures.length)
        throw new AggregateError(
          [...failure, ...cleanupFailures],
          'Native resource runtime or cleanup failed'
        )
    }
    await writeFile(
      resolve(
        process.env.RELAY_NATIVE_RESOURCE_OUTPUT ??
          '../evidence/native-resource-runtime-verification-20261102.json'
      ),
      JSON.stringify(
        {
          status: 'passed',
          cases: results,
          fixtureSHA256: fixtureSHA,
          signedCoreSHA256,
          coreProfile,
          classicalGeo,
          sourceCommit: '3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8',
          scope:
            'ordinary UID own sandbox Core; real Node producer/resource broker, Native Model/Inbox/Live; injected Native held-owner and test-only independent target oracle, not production AppSession/UID0/TUN/installation or user network',
          actualSystemConfigurationChanged: false,
          x64Executed: false
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
  },
  300000
)
function nonceMarker(): string {
  return '"nonce"'
}
