import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile
} from 'node:fs/promises'
import { request } from 'node:http'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { it } from 'vitest'
import { isolatedCoreConfiguration } from '../../src/main/relay/core/configuration'
import { stopOwnedChild } from '../../src/main/relay/core/shutdown'
import { resourceRuleEntries } from '../../src/main/relay/resources/check-definition'
import { readRuleProviderCandidate } from '../../src/main/relay/resources/rule-provider-candidate'
import { ResourceStore } from '../../src/main/relay/resources/store'
import { createTunResourceInbox } from '../../src/main/relay/tun/resource-inbox'
import { createTunRuleProvidersChannel } from '../../src/main/relay/tun/rule-providers-channel'
import type { TunRuleProviderBlobTicket } from '../../src/main/relay/tun/rule-provider-ticket'
import type {
  TunRuleProvidersChannelResult,
  TunRuleProvidersNativeSnapshot
} from '../../src/main/relay/tun/rule-providers-contract'

import { freeFixturePort } from './fixtures/local-network'

const signedCore = resolve('../artifacts/core-geodata-provider-v1p1-pair-20261102/arm64/mihomo'),
  coreSHA256 = 'e9327b2ce0e5c4405ce2640145339be9e315943bdeb63ffee4b3f4fe18bee419',
  hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex'),
  uid = process.getuid?.()
interface Held {
  child: ChildProcess
  closed: Promise<void>
  stdout: string
  stderr: string
}
function held(executable: string, args: string[], cwd: string, descriptors: number): Held {
  const child = spawn(executable, args, {
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        HOME: cwd,
        TMPDIR: cwd,
        RELAY_LOCAL_GEODATA_V1: '1'
      },
      stdio: Array(descriptors).fill('pipe') as 'pipe'[]
    }),
    value: Held = {
      child,
      closed: new Promise((done) => child.once('close', () => done())),
      stdout: '',
      stderr: ''
    }
  for (const name of ['stdout', 'stderr'] as const)
    child[name]?.on('data', (part: Buffer) => {
      value[name] += part.toString()
      if (Buffer.byteLength(value[name]) > 2 * 1024 * 1024) child.kill('SIGTERM')
    })
  return value
}
function live(value: Held): void {
  assert.equal(value.child.exitCode, null, value.stderr)
  assert.equal(value.child.signalCode, null, value.stderr)
}
async function waitFor(check: () => boolean, limit = 15000): Promise<void> {
  const until = performance.now() + limit
  while (!check()) {
    assert(performance.now() < until, 'Owned fixture deadline')
    await delay(10)
  }
}
async function api(socketPath: string, path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((done, fail) => {
    const req = request({ socketPath, path, method: 'GET', agent: false, timeout: 2000 }, (res) => {
      const parts: Buffer[] = []
      let size = 0
      res.on('data', (part: Buffer) => {
        size += part.length
        if (size > 2 * 1024 * 1024) req.destroy(new Error('Response bound'))
        else parts.push(part)
      })
      res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }))
    })
    req.once('error', fail)
    req.once('timeout', () => req.destroy(new Error('Own Unix read deadline')))
    req.end()
  })
}
function snapshot(value: TunRuleProvidersChannelResult): TunRuleProvidersNativeSnapshot {
  assert('snapshot' in value, JSON.stringify(value))
  return value.snapshot
}

async function mrs(root: string, name: string): Promise<Buffer> {
  const source = join(root, name + '.text'),
    target = join(root, name + '.mrs')
  await writeFile(source, name + '.synthetic.invalid\n', { flag: 'wx', mode: 0o600 })
  const own = held(
    '/usr/bin/sandbox-exec',
    [
      '-p',
      '(version 1)(allow default)(deny network*)',
      signedCore,
      'convert-ruleset',
      'domain',
      'text',
      source,
      target
    ],
    root,
    3
  )
  try {
    await Promise.race([
      own.closed,
      delay(5000).then(() => {
        throw new Error('Own MRS converter deadline')
      })
    ])
    assert.equal(own.child.exitCode, 0, own.stderr)
    assert.equal(own.child.signalCode, null)
    return await readFile(target)
  } finally {
    if (own.child.exitCode === null && own.child.signalCode === null)
      await stopOwnedChild(own.child, own.closed, 'inert')
  }
}

it
  .runIf(!!process.env.RELAY_NATIVE_PROVIDER_FIXTURE)
  .each(
    process.env.RELAY_NATIVE_PROVIDER_ROUTE
      ? (['yaml'] as const)
      : (['yaml', 'text', 'mrs'] as const)
  )(
  'pairs actual Node candidate/shared inbox/provider broker with Native Channel/Model/Files and same signed Core Probe acceptance (%s)',
  async (format) => {
    assert.equal(process.platform, 'darwin')
    assert.equal(process.arch, 'arm64')
    assert(uid && uid > 0 && uid === process.geteuid?.())
    const fixture = await realpath(process.env.RELAY_NATIVE_PROVIDER_FIXTURE ?? ''),
      fixtureSHA = hash(await readFile(fixture))
    assert(fixture.startsWith('/private/tmp/relay-provider-core-fixture-'))
    assert.equal(fixtureSHA, process.env.RELAY_NATIVE_PROVIDER_FIXTURE_SHA256)
    const executable = await readFile(signedCore)
    assert.equal(hash(executable), coreSHA256)
    const root = await realpath(await mkdtemp(`/private/tmp/relay-session-${uid}-provider-joint-`)),
      home = join(root, 'runtime'),
      routePort = process.env.RELAY_NATIVE_PROVIDER_ROUTE ? await freeFixturePort() : 0,
      names = ['Only', 'Literal%2F'],
      behavior = format === 'mrs' ? ('domain' as const) : ('classical' as const),
      kind =
        format === 'mrs'
          ? ('rule-mrs' as const)
          : format === 'text'
            ? ('rule-text' as const)
            : ('rule-yaml' as const),
      original =
        format === 'mrs'
          ? await mrs(root, 'old')
          : Buffer.from(
              format === 'text'
                ? 'DOMAIN,old.synthetic.invalid\n'
                : 'payload:\n - DOMAIN,old.synthetic.invalid\n'
            ),
      next =
        format === 'mrs'
          ? await mrs(root, 'new')
          : Buffer.from(
              format === 'text'
                ? 'DOMAIN,new.synthetic.invalid\n'
                : 'payload:\n - DOMAIN,new.synthetic.invalid\n'
            ),
      partial = Buffer.from(
        format === 'text'
          ? 'DOMAIN,new.synthetic.invalid\nNOT_A_RULE,never.synthetic.invalid\n'
          : 'payload:\n - DOMAIN,new.synthetic.invalid\n - NOT_A_RULE,never.synthetic.invalid\n'
      ),
      path = `relay-files/${hash(original)}.${format}`,
      cache = new ResourceStore({
        home: root,
        stateRoot: join(root, 'Library/Application Support/Relay-Preview')
      }),
      producer = await createTunResourceInbox(),
      records: Record<string, unknown>[] = [],
      failures: unknown[] = [],
      cleanupErrors: unknown[] = []
    let core: Held | undefined,
      native: Held | undefined,
      broker: ReturnType<typeof createTunRuleProvidersChannel> | undefined
    const sources: {
      id: string
      sha256: string
      metadata: Buffer
      inode: bigint
      bytes: Buffer
    }[] = []
    let report: Record<string, unknown> = {
      root,
      format,
      behavior,
      coreSHA256,
      fixtureSHA,
      records
    }
    try {
      await mkdir(home, { mode: 0o700 })
      await mkdir(join(home, 'relay-files'), { mode: 0o700 })
      await writeFile(join(home, path), original, { flag: 'wx', mode: 0o600 })
      await writeFile(join(home, 'mihomo-probe'), executable, { flag: 'wx', mode: 0o500 })
      await chmod(join(home, 'mihomo-probe'), 0o500)
      await writeFile(join(home, 'cache.db'), '', { flag: 'wx', mode: 0o600 })
      const config = Buffer.from(
          JSON.stringify({
            ...isolatedCoreConfiguration(),
            mode: 'rule',
            port: routePort,
            'log-level': routePort ? 'info' : 'silent',
            ...(routePort
              ? {
                  hosts: {
                    'old.synthetic.invalid': '127.0.0.1',
                    'new.synthetic.invalid': '127.0.0.1'
                  }
                }
              : {}),
            'geo-auto-update': false,
            'geox-url': { geoip: '', geosite: '', mmdb: '', asn: '' },
            'rule-providers': Object.fromEntries(
              names.map((name) => [name, { type: 'file', format, behavior, path, interval: 0 }])
            ),
            rules: [...names.map((name) => `RULE-SET,${name},REJECT`), 'MATCH,REJECT']
          })
        ),
        configPath = join(home, 'config.yaml'),
        socketPath = join(home, 'api.sock')
      await writeFile(configPath, config, { flag: 'wx', mode: 0o600 })
      const initialConfig = await lstat(configPath, { bigint: true }),
        originalTarget = await lstat(join(home, path), { bigint: true }),
        policy =
          '(version 1)\n(allow default)\n(deny network*)\n' +
          `(allow network-bind (literal ${JSON.stringify(socketPath)}))\n(allow network-inbound (literal ${JSON.stringify(socketPath)}))\n` +
          (routePort
            ? `(allow network-bind (local tcp4 "localhost:${routePort}"))\n(allow network-inbound (local tcp4 "localhost:${routePort}"))\n`
            : '')
      core = held(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          policy,
          join(home, 'mihomo-probe'),
          '-d',
          home,
          '-f',
          configPath,
          '-ext-ctl-unix',
          socketPath
        ],
        home,
        3
      )
      const active = core,
        initialPID = active.child.pid
      // Startup reads are the only retrying operations. Never retry a PUT.
      async function readyCore(): Promise<void> {
        const until = performance.now() + 15000
        while (performance.now() < until) {
          live(active)
          try {
            const version = await api(socketPath, '/version')
            if (version.status === 200) {
              assert.equal(JSON.parse(version.body.toString()).version, 'relay-geodata-v1p1-3f27')
              return
            }
          } catch {
            /* still starting */
          }
          await delay(10)
        }
        throw new Error('Own Core startup deadline')
      }
      await readyCore()
      const binding = {
          sessionId: randomUUID(),
          evidenceSHA256: hash(Buffer.from(root)),
          runtimeConfigurationSHA256: hash(config)
        },
        descriptor = join(root, 'native-fixture.json')
      await writeFile(
        descriptor,
        JSON.stringify({
          home,
          sourceRoot: producer.directory,
          binding,
          corePID: active.child.pid,
          path,
          names,
          format,
          behavior
        }),
        { flag: 'wx', mode: 0o600 }
      )
      native = held(fixture, [descriptor], root, 11)
      const receiver = native
      const events = (): Record<string, unknown>[] =>
        receiver.stdout
          .slice(0, receiver.stdout.lastIndexOf('\n') + 1)
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      await waitFor(() => {
        live(receiver)
        return events().some((e) => e.event === 'CONTROL_READY')
      })
      const input = receiver.child.stdio.at(9),
        output = receiver.child.stdio.at(10)
      assert(input instanceof Writable && output instanceof Readable)
      broker = createTunRuleProvidersChannel(
        {
          write: (frame) => {
            input.write(frame)
          },
          onData: (fn) => {
            output.on('data', fn)
          },
          onGone: (fn) => {
            output.once('end', fn)
            output.once('close', fn)
          },
          onFault: (fn) => {
            output.once('error', fn)
            input.once('error', fn)
          },
          close: () => {
            input.destroy()
            output.destroy()
          }
        },
        { ...binding, launchClientSHA256: fixtureSHA, installationRevision: 'e'.repeat(64) }
      )
      const channel = broker,
        signal = (): AbortSignal => new AbortController().signal,
        assertLive = (): void => {
          live(active)
          live(receiver)
        },
        eventCount = (name: string): number => events().filter((e) => e.event === name).length,
        command = async (line: string, event: string): Promise<Record<string, unknown>> => {
          const before = eventCount(event)
          assert(receiver.child.stdin)
          receiver.child.stdin.write(line + '\n')
          await waitFor(() => {
            live(receiver)
            return eventCount(event) > before
          })
          const latest = events()
            .filter((e) => e.event === event)
            .at(-1)
          assert(latest)
          return latest
        },
        stage = async (
          body: Buffer
        ): Promise<{ ticket: TunRuleProviderBlobTicket; declaredRuleCount: number }> => {
          const info = await cache.save(
              { name: 'Private joint candidate', kind, behavior, selector: '' },
              body
            ),
            candidate = await readRuleProviderCandidate(
              cache,
              { id: info.id, sha256: info.sha256 },
              { kind, behavior }
            ),
            entries = resourceRuleEntries(candidate.job),
            metadataPath = join(cache.directory, info.id, 'metadata.json')
          assert(entries.expected)
          await candidate.recheck()
          sources.push({
            id: info.id,
            sha256: info.sha256,
            metadata: await readFile(metadataPath),
            inode: (await lstat(join(cache.directory, info.id, 'resource.bin'), { bigint: true }))
              .ino,
            bytes: Buffer.from(body)
          })
          const ticket = await producer.stageRuleProvider(candidate.job, signal(), assertLive)
          await candidate.recheck()
          return { ticket, declaredRuleCount: entries.expected }
        },
        mutation = (
          current: TunRuleProvidersNativeSnapshot,
          staged: Awaited<ReturnType<typeof stage>>
        ) => ({
          configurationRevision: current.configurationRevision,
          expectedGenerationSHA256: current.generationSHA256,
          provider: names[0],
          oldSHA256: current.providers[0].fileSHA256,
          newSHA256: staged.ticket.sha256,
          blobId: staged.ticket.blobId,
          kind: staged.ticket.kind,
          bytes: staged.ticket.bytes,
          filename: staged.ticket.filename,
          declaredRuleCount: staged.declaredRuleCount
        }),
        discard = async (ticket: TunRuleProviderBlobTicket): Promise<void> => {
          await channel.whenIdle()
          const status = await channel.discardBlob(ticket)
          assert(['discarded', 'absent'].includes(status))
          producer.acknowledgeDiscard(ticket)
        }
      // Reuse the fixed upstream/provider prototype matcher witness. Each
      // fresh HTTP request captures its actual source TCP port and only reads
      // future log bytes, so earlier/late buffered decisions cannot satisfy it.
      const usedSourcePorts = new Set<number>()
      const routeDecision = async (
        host: 'old.synthetic.invalid' | 'new.synthetic.invalid',
        expected: 'RuleSet' | 'Match'
      ): Promise<Record<string, unknown>> => {
        assert(routePort > 0)
        assertLive()
        const futureOffset = active.stdout.length,
          nonce = randomUUID()
        let sourcePort = 0,
          response: number | string = ''
        await new Promise<void>((done, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: routePort,
              method: 'GET',
              path: `http://${host}:80/owned-provider-match-${nonce}`,
              agent: false,
              timeout: 2000,
              headers: { Host: host, Connection: 'close' }
            },
            (res) => {
              response = res.statusCode ?? 0
              res.resume()
              res.once('end', done)
              res.once('error', reject)
            }
          )
          req.once('socket', (socket) =>
            socket.once('connect', () => {
              sourcePort = socket.localPort ?? 0
            })
          )
          req.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ECONNRESET') {
              response = error.code
              done()
            } else reject(error)
          })
          req.once('timeout', () => req.destroy(new Error('Own REJECT matcher deadline')))
          req.end()
        })
        assert(sourcePort > 0 && !usedSourcePorts.has(sourcePort))
        usedSourcePorts.add(sourcePort)
        let line = ''
        await waitFor(() => {
          assertLive()
          line =
            active.stdout
              .slice(futureOffset)
              .split('\n')
              .find(
                (value) =>
                  new RegExp(`127\\.0\\.0\\.1:${sourcePort}\\b`, 'u').test(value) &&
                  value.includes(`${host}:80`) &&
                  value.includes('match ') &&
                  value.includes('using REJECT')
              ) ?? ''
          return !!line
        }, 3000)
        assert(line.includes(expected === 'RuleSet' ? 'match RuleSet(Only)' : 'match Match'), line)
        return {
          host,
          expected,
          sourcePort,
          nonce,
          futureOffset,
          line,
          response,
          activeCorePID: initialPID
        }
      }
      let current = snapshot(await channel.read(signal(), assertLive))
      assert.equal(current.providers.length, 2)
      assert.deepEqual(current.groups, [names.slice().sort()])
      const zero = await command('state', 'state'),
        unchanged = await stage(original)
      assert.equal(
        (await channel.replace(mutation(current, unchanged), signal(), assertLive)).status,
        'unchanged'
      )
      await discard(unchanged.ticket)
      const afterNoop = await command('state', 'state')
      for (const name of ['probes', 'stages', 'swaps', 'puts'])
        assert.equal(
          (afterNoop.counts as Record<string, number>)[name],
          (zero.counts as Record<string, number>)[name]
        )
      records.push({ case: 'noop', status: 'unchanged', zeroProbeStageSwapPUT: true })
      const beforeMatch = routePort
        ? [
            await routeDecision('old.synthetic.invalid', 'RuleSet'),
            await routeDecision('new.synthetic.invalid', 'Match')
          ]
        : []
      const good = await stage(next),
        applied = await channel.replace(mutation(current, good), signal(), assertLive)
      assert.equal(applied.status, 'updated', JSON.stringify(applied))
      current = snapshot(applied)
      await discard(good.ticket)
      assert(current.providers.every((r) => r.fileSHA256 === hash(next) && r.ruleCount === 1))
      assert.equal(hash(await readFile(join(home, path))), hash(next))
      records.push({
        case: format + ' alias2 literal-percent name actual complete Probe + real both PUT',
        status: 'updated',
        state: await command('state', 'state')
      })
      if (routePort) {
        const afterMatch = [
          await routeDecision('old.synthetic.invalid', 'Match'),
          await routeDecision('new.synthetic.invalid', 'RuleSet')
        ]
        records.push({
          case: 'samecount1 loaded rule matching reverses on same active Core',
          ruleCountBefore: 1,
          ruleCountAfter: current.providers[0].ruleCount,
          before: beforeMatch,
          after: afterMatch
        })
      }
      if (format !== 'mrs') {
        const invalid = await stage(partial),
          beforePartial = await command('state', 'state'),
          rejected = await channel.replace(mutation(current, invalid), signal(), assertLive)
        assert.equal(rejected.status, 'unavailable')
        await discard(invalid.ticket)
        const afterPartial = await command('state', 'state')
        assert.equal(
          (afterPartial.counts as Record<string, number>).swaps,
          (beforePartial.counts as Record<string, number>).swaps
        )
        assert.equal(hash(await readFile(join(home, path))), hash(next))
        records.push({
          case: 'actual Core partial parse rejected before active stage/swap',
          status: rejected.status,
          declaredCount: 2,
          before: beforePartial,
          after: afterPartial
        })
      } else {
        const raw = zstdDecompressSync(next),
          invalidBodies = [
            next.subarray(0, next.length - 3),
            zstdCompressSync(raw.subarray(0, raw.length - 1))
          ]
        const beforeMalformed = await command('state', 'state')
        for (const [index, body] of invalidBodies.entries()) {
          const info = await cache.save(
            { name: 'MRS truncated body', kind, behavior, selector: '' },
            body
          )
          const candidate = await readRuleProviderCandidate(
            cache,
            { id: info.id, sha256: info.sha256 },
            { kind, behavior }
          )
          sources.push({
            id: info.id,
            sha256: info.sha256,
            metadata: await readFile(join(cache.directory, info.id, 'metadata.json')),
            inode: (await lstat(join(cache.directory, info.id, 'resource.bin'), { bigint: true }))
              .ino,
            bytes: Buffer.from(body)
          })
          if (index === 0) {
            // Node's mature decoder returns the full inner body despite this
            // missing stream trailer. Its count is not Core acceptance: the
            // actual same-Core Probe must reject the incomplete compressed file.
            assert.equal(resourceRuleEntries(candidate.job).expected, 1)
            const staged = await stage(body),
              result = await channel.replace(mutation(current, staged), signal(), assertLive)
            assert.equal(result.status, 'unavailable', JSON.stringify(result))
            await discard(staged.ticket)
          } else {
            assert.throws(() => resourceRuleEntries(candidate.job))
            const retained = producer.retained().retained.length
            await assert.rejects(producer.stageRuleProvider(candidate.job, signal(), assertLive))
            assert.equal(producer.retained().retained.length, retained)
          }
          assert.deepEqual(await readFile(join(cache.directory, info.id, 'resource.bin')), body)
        }
        const afterMalformed = await command('state', 'state')
        for (const name of ['stages', 'swaps', 'puts'])
          assert.equal(
            (afterMalformed.counts as Record<string, number>)[name],
            (beforeMalformed.counts as Record<string, number>)[name]
          )
        assert.equal(
          (afterMalformed.counts as Record<string, number>).probes,
          (beforeMalformed.counts as Record<string, number>).probes + 1
        )
        assert.equal(hash(await readFile(join(home, path))), hash(next))
        records.push({
          case: 'MRS truncated compressed stream passes Node body/count preflight but actual Core Probe rejects; truncated inner body rejected by bounded preflight',
          zeroActiveStageSwapPUT: true,
          before: beforeMalformed,
          after: afterMalformed
        })
      }
      await command('hold-stage', 'holdReady')
      const cancel = await stage(original),
        cancellation = new AbortController(),
        beforeHold = eventCount('stageHeld'),
        cancelled = channel.replace(mutation(current, cancel), cancellation.signal, assertLive)
      await waitFor(() => {
        assertLive()
        return eventCount('stageHeld') > beforeHold
      })
      cancellation.abort()
      await delay(20)
      assert(receiver.child.stdin)
      receiver.child.stdin.write('release-stage\n')
      assert.equal((await cancelled).status, 'cancelled')
      await discard(cancel.ticket)
      assert.equal(hash(await readFile(join(home, path))), hash(next))
      records.push({
        case: 'cancel after actual Probe before first active write',
        status: 'cancelled',
        state: await command('state', 'state')
      })
      await command('lose-next', 'loseReady')
      const unknown = await stage(original),
        lost = await channel.replace(mutation(current, unknown), signal(), assertLive)
      assert.equal(lost.status, 'uncertain')
      assert.equal((await channel.read(signal(), assertLive)).status, 'uncertain')
      assert.equal(hash(await readFile(join(home, path))), hash(original))
      const unknownState = await command('state', 'state')
      assert.equal(unknownState.sequence, 1)
      assert.equal(unknownState.isolated, true)
      records.push({
        case: 'lost acknowledgement after actual swap and alias PUT; no retry/read adoption',
        status: 'uncertain',
        state: unknownState,
        retainedNodeTickets: producer.retained().retained.length
      })
      const configAfter = await lstat(configPath, { bigint: true })
      assert.equal(configAfter.ino, initialConfig.ino)
      assert.equal(hash(await readFile(configPath)), hash(config))
      assert.equal(active.child.pid, initialPID)
      assert.notEqual((await lstat(join(home, path), { bigint: true })).ino, originalTarget.ino)
      for (const source of sources) {
        assert.deepEqual(
          await readFile(join(cache.directory, source.id, 'metadata.json')),
          source.metadata
        )
        assert.deepEqual(
          await readFile(join(cache.directory, source.id, 'resource.bin')),
          source.bytes
        )
        assert.equal(
          (await lstat(join(cache.directory, source.id, 'resource.bin'), { bigint: true })).ino,
          source.inode
        )
      }
      await stopOwnedChild(active.child, active.closed, 'localProxy')
      assert.equal(active.child.exitCode, 0)
      assert.equal(active.child.signalCode, null)
      const cleaned = await command('core-closed-cleanup', 'cleaned')
      assert.equal(cleaned.event, 'cleaned')
      assert.equal(hash(await readFile(join(home, path))), hash(original))
      assert(!(await readdir(home)).includes('RelayRuleProviderStages'))
      report = {
        ...report,
        status: 'passed',
        corePID: active.child.pid,
        configurationInodeSHAUnchanged: true,
        allSourceCacheBodiesMetadataInodesUnchanged: true,
        finitePrivateRetainedCleanupAfterOwnCoreReaped: true,
        sandbox: policy
      }
    } catch (error) {
      failures.push(error)
      report.status = 'failed'
    } finally {
      try {
        await broker?.cancel()
        await broker?.whenIdle()
        broker?.invalidate()
        await producer.dispose()
      } catch (error) {
        cleanupErrors.push(error)
      }
      for (const entry of [native, core])
        if (entry) {
          try {
            if (entry.child.exitCode === null && entry.child.signalCode === null) {
              if (entry === native) {
                entry.child.stdin?.end()
                await Promise.race([
                  entry.closed,
                  delay(5000).then(() => {
                    throw new Error('Native drain deadline')
                  })
                ])
              } else await stopOwnedChild(entry.child, entry.closed, 'localProxy')
            }
            assert.equal(entry.child.exitCode, 0, entry.stderr)
            assert.equal(entry.child.signalCode, null, entry.stderr)
          } catch (error) {
            cleanupErrors.push(error)
            if (entry.child.exitCode === null && entry.child.signalCode === null) {
              entry.child.kill('SIGKILL')
              await entry.closed
            }
          }
        }
      report.nativeStderr = native?.stderr
      report.coreStderr = core?.stderr
      report.failures = failures.map(String)
      report.cleanupErrors = cleanupErrors.map(String)
      await writeFile(join(root, 'provider-joint-result.json'), JSON.stringify(report, null, 2), {
        flag: 'wx',
        mode: 0o600
      })
      await writeFile(
        resolve(
          process.env.RELAY_NATIVE_PROVIDER_OUTPUT ??
            '../evidence/native-rule-provider-runtime-verification-20261102.json'
        ).replace(/\.json$/u, `-${format}${routePort ? '-route' : ''}.json`),
        JSON.stringify(
          {
            ...report,
            scope:
              'ordinary UID owned sandbox Core; real Node cache/candidate/sharedInbox/broker and Native Channel/Model/Files/Readiness/actual Probe.Session. Injected held owner/peer; not production AppSession, TUN, installed, Intel or user acceptance.'
          },
          null,
          2
        ) + '\n'
      )
    }
    if (failures.length || cleanupErrors.length)
      throw new AggregateError(
        [...failures, ...cleanupErrors],
        'Private provider joint workflow or cleanup failed'
      )
  },
  120000
)
