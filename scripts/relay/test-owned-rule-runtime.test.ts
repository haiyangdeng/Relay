import assert from 'node:assert/strict'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer, type Server } from 'node:net'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { localProxyConfiguration } from '../../src/main/relay/core/local-proxy-runtime'
import { startOwnedCore, type RelayOwnedCore } from '../../src/main/relay/core/owned-runtime'
import {
  localProxyRulesSHA256,
  readLocalProxyRules
} from '../../src/main/relay/core/local-proxy-rules'
import { probeLocalPort } from '../../src/main/relay/core/port'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { stopOwnedChild } from '../../src/main/relay/core/shutdown'
import { resourceHash } from '../../src/main/relay/resources/source'
import { closeFixture, fixturePort } from './fixtures/local-network'

const launch = vi.hoisted(() => ({
  executable: '',
  port: 0,
  policy: '',
  socket: '',
  children: [] as { child: ChildProcess; closed: Promise<void> }[]
}))

// Only the launcher is adapted for this integration fixture. The binary,
// directory/socket checks, HTTP client, rule PATCH, readback and reload are the
// actual production code, talking to the actual pinned shipping Core.
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn(command: string, args: string[], options: SpawnOptions) {
      const socket = args[args.indexOf('-ext-ctl-unix') + 1]
      if (command !== launch.executable || !socket?.startsWith('/private/tmp/relay-proxy-'))
        throw new Error('Unexpected fixture launch')
      launch.socket = socket
      launch.policy =
        '(version 1)\n(allow default)\n(deny network*)\n' +
        `(allow network* (literal ${JSON.stringify(socket)}))\n` +
        `(allow network-bind (local tcp4 "localhost:${launch.port}"))\n` +
        `(allow network-inbound (local tcp4 "localhost:${launch.port}"))\n`
      const child = actual.spawn(
        '/usr/bin/sandbox-exec',
        ['-p', launch.policy, command, ...args],
        options
      )
      launch.children.push({
        child,
        closed: new Promise<void>((done) => child.once('close', () => done()))
      })
      return child
    }
  }
})

async function awaitFixtureClose(closed: Promise<void>, milliseconds = 2000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Held fixture did not close')), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function cleanupRuleFixture(
  primary: (() => Promise<void>) | undefined,
  children: readonly { child: ChildProcess; closed: Promise<void> }[],
  servers: readonly Server[]
): Promise<unknown[]> {
  const first = await Promise.allSettled(
    [
      () => primary?.(),
      ...servers.map((server) => () => server.listening && closeFixture(server))
    ].map((close) => Promise.resolve().then<void | false>(close))
  )
  const held = await Promise.allSettled(
    children.map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          await stopOwnedChild(child, closed, 'localProxy')
        } catch (error) {
          // Test-only fallback, bound to the newly spawned object. Never adopt
          // a PID or stop a user-owned core; an unsuccessful polite close still
          // makes this fixture fail even if its exact child is then released.
          child.kill('SIGKILL')
          await awaitFixtureClose(closed)
          throw error
        }
      }
      await awaitFixtureClose(closed)
    })
  )
  return [...first, ...held].flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
}

function throwFixtureFailures(original: unknown[], cleanup: unknown[]): void {
  const errors = [...original, ...cleanup]
  if (errors.length) throw new AggregateError(errors, 'Owned rule fixture or cleanup failed')
}

afterEach(() => vi.restoreAllMocks())

it.runIf(!!process.env.RELAY_NATIVE_RULES_CORE_FIXTURE)(
  'uses the production Native fixed Unix reader and writer against the sandboxed shipping Core',
  async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('child_process'),
      run = promisify(actual.execFile),
      fixture = await realpath(process.env.RELAY_NATIVE_RULES_CORE_FIXTURE ?? ''),
      fixtureSHA256 = resourceHash(await readFile(fixture)),
      resource = await verifyCoreResource(resolve('extra/relay/core')),
      reserve = createServer((socket) => socket.destroy()),
      sentinel = createServer((socket) => {
        accepted++
        socket.destroy()
      }),
      decisions: string[] = [],
      replies: unknown[] = []
    assert.ok(fixture.startsWith(resolve('.relay-build/private') + '/'))
    assert.equal(fixtureSHA256, process.env.RELAY_NATIVE_RULES_CORE_FIXTURE_SHA256)
    let accepted = 0,
      core: RelayOwnedCore | undefined,
      cleanup: (() => Promise<void>) | undefined,
      failure: unknown[] = [],
      cleanupFailures: unknown[] = []
    launch.executable = resource.executable
    launch.children = []
    try {
      launch.port = await fixturePort(reserve)
      await closeFixture(reserve)
      sentinel.listen(0, '127.0.0.1')
      await once(sentinel, 'listening')
      const address = sentinel.address()
      assert.ok(address && typeof address === 'object')
      assert.notEqual(address.port, launch.port)
      const configuration = JSON.stringify({
        ...JSON.parse(
          localProxyConfiguration(
            'proxies: []\nproxy-groups: []\nrules: ["DOMAIN,fixture.invalid,REJECT", "MATCH,REJECT"]\n',
            launch.port
          ).configuration
        ),
        'log-level': 'info'
      })
      core = await startOwnedCore(
        resolve('extra/relay/core'),
        configuration,
        'localProxy',
        (stop) => {
          cleanup = stop
        }
      )
      const session = core,
        pid = session.pid,
        before = readLocalProxyRules(await session.read('rules')),
        probe = await run(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            launch.policy,
            process.execPath,
            '-e',
            'const s=require("node:net").connect({host:"127.0.0.1",port:Number(process.argv[1])});s.on("connect",()=>process.exit(2));s.on("error",e=>{console.log(e.code);process.exit(e.code==="EPERM"?0:3)});',
            String(address.port)
          ],
          { timeout: 3000 }
        )
      assert.equal(probe.stdout.trim(), 'EPERM')
      assert.equal(accepted, 0)
      assert.equal(before.rules[0]?.disabled, false)
      const traffic = async (expected: 'Domain' | 'Match'): Promise<void> => {
        const from = session.logs?.().length ?? 0
        await new Promise<void>((done) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: launch.port,
              method: 'GET',
              path: 'http://fixture.invalid/native-rule-probe',
              agent: false,
              timeout: 2000,
              headers: { Host: 'fixture.invalid', Connection: 'close' }
            },
            (response) => {
              response.resume()
              response.once('end', done)
              response.once('error', () => done())
            }
          )
          req.once('error', () => done())
          req.once('timeout', () => req.destroy(new Error('Native/Core fixture traffic timeout')))
          req.end()
        })
        await vi.waitFor(() => {
          const line = session
            .logs?.()
            .slice(from)
            .find(
              (value) =>
                value.includes('fixture.invalid') &&
                value.includes(`match ${expected}`) &&
                value.includes('REJECT')
            )
          assert.ok(line, `Missing Native/Core ${expected} decision`)
          decisions.push(line)
        })
      }
      await traffic('Domain')
      for (const disabled of [true, false]) {
        const result = await run(fixture, [session.directory, String(pid), String(disabled)], {
          timeout: 10000,
          maxBuffer: 1024 * 1024
        })
        assert.equal(result.stderr, '')
        const reply = JSON.parse(result.stdout)
        assert.equal(reply.peerPID, pid)
        assert.ok(reply.peerChecks >= 6)
        assert.equal(reply.after.status, 'changed')
        assert.equal(reply.after.snapshot.rules[0].disabled, disabled)
        replies.push(reply)
        assert.equal(readLocalProxyRules(await session.read('rules')).rules[0]?.disabled, disabled)
        assert.equal(session.pid, pid)
        assert.equal(session.state(), 'running')
        await traffic(disabled ? 'Match' : 'Domain')
      }
      assert.equal(readLocalProxyRules(await session.read('rules')).rulesSHA256, before.rulesSHA256)
      assert.equal(accepted, 0)
    } catch (error) {
      failure = [error]
    } finally {
      cleanupFailures = await cleanupRuleFixture(cleanup, launch.children, [reserve, sentinel])
    }
    throwFixtureFailures(failure, cleanupFailures)
    assert.ok(core)
    assert.equal(core.state(), 'stopped')
    assert.equal(launch.children.length, 1)
    assert.ok(await probeLocalPort(launch.port))
    await writeFile(
      resolve(
        process.env.RELAY_NATIVE_RULES_CORE_OUTPUT ??
          '../evidence/native-rules-core-root-verification-20261102.json'
      ),
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          fixture,
          fixtureSHA256,
          coreSHA256: resource.sha256,
          coreVersion: resource.version,
          architecture: process.arch,
          peerPID: core.pid,
          policy: launch.policy,
          actualUnixSocket: launch.socket,
          replies,
          decisions,
          sentinelAccepted: accepted,
          sentinelOutbound: 'EPERM',
          heldCoreChildrenClosed: launch.children.length,
          coreStopped: core.state() === 'stopped',
          scope:
            'Actual pinned Core, real production Native Live fixed HTTP/1.0 GET/PATCH and Rules controller, plus independent Node readback and actual REJECT rule decisions. Injected Native owner; no ManagedCore/AppSession, TUN, root/setuid or Main dialog. Only Core and outbound sentinel are sandboxed; source -v/-t and standalone Native client are not.',
          systemNetworkChanged: false,
          currentClashOrMihomoStopped: false,
          productAcceptance: 'pending'
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
  },
  30000
)

it.runIf(process.env.RELAY_OWNED_RULE_RUNTIME_TEST === '1')(
  'uses the real sandboxed shipping Core and production Unix API for temporary rule state and reload reset',
  async () => {
    assert.equal(process.platform, 'darwin')
    const actual = await vi.importActual<typeof import('node:child_process')>('child_process'),
      root = await realpath(await mkdtemp('/private/tmp/relay-rule-runtime-proof-')),
      resource = await verifyCoreResource(resolve('extra/relay/core')),
      reserve = createServer((socket) => socket.destroy()),
      sentinel = createServer((socket) => {
        accepted++
        socket.destroy()
      }),
      rows: string[] = [],
      decisions: string[] = []
    let accepted = 0,
      port = 0,
      core: RelayOwnedCore | undefined,
      cleanup: (() => Promise<void>) | undefined,
      failure: unknown[] = [],
      cleanupFailures: unknown[] = []
    launch.executable = resource.executable
    launch.children = []
    try {
      port = await fixturePort(reserve)
      launch.port = port
      await closeFixture(reserve)
      sentinel.listen(0, '127.0.0.1')
      await once(sentinel, 'listening')
      const address = sentinel.address()
      assert.ok(address && typeof address === 'object')
      const sentinelPort = address.port
      assert.notEqual(sentinelPort, port)
      const source =
          'proxies: []\nproxy-groups: []\nrules: ["DOMAIN,fixture.invalid,REJECT", "MATCH,REJECT"]\n',
        compiled = JSON.parse(localProxyConfiguration(source, port).configuration),
        configuration = JSON.stringify({ ...compiled, 'log-level': 'info' })
      core = await startOwnedCore(
        resolve('extra/relay/core'),
        configuration,
        'localProxy',
        (stop) => {
          cleanup = stop
        }
      )
      const session = core,
        patch = session.patchRule
      assert.ok(patch)
      const pid = session.pid,
        first = readLocalProxyRules(await session.read('rules')),
        target = first.rules.find(
          (rule) => rule.type === 'Domain' && rule.payload === 'fixture.invalid'
        )
      assert.ok(target)
      assert.equal(target.disabled, false)
      assert.equal(first.rules.length, 2)
      rows.push(
        'Actual production start/Unix GET returns the pinned Core ordered table and supported disabled=false bit'
      )

      const outbound = actual.spawn(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          launch.policy,
          process.execPath,
          '-e',
          `const n=require('node:net');const c=n.connect({host:'127.0.0.1',port:${sentinelPort}});c.on('connect',()=>{console.log('CONNECTED');c.destroy();process.exitCode=2});c.on('error',e=>{console.log(e.code);process.exitCode=e.code==='EPERM'?0:3})`
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, killSignal: 'SIGTERM' }
      )
      const outboundClosed = once(outbound, 'close')
      let outboundText = '',
        outboundError = ''
      outbound.stdout.on('data', (chunk: Buffer) => (outboundText += chunk.toString()))
      outbound.stderr.on('data', (chunk: Buffer) => (outboundError += chunk.toString()))
      const [outboundCode] = await outboundClosed
      assert.equal(outboundCode, 0, outboundError)
      assert.equal(outboundText.trim(), 'EPERM')
      assert.equal(accepted, 0)
      rows.push(
        'The exact same Core policy denies TCP outbound with EPERM and zero sentinel accepts'
      )

      const traffic = async (expected: 'Domain' | 'Match'): Promise<void> => {
        const start = session.logs?.().length ?? 0
        await new Promise<void>((done) => {
          const req = request(
            {
              host: '127.0.0.1',
              port,
              method: 'GET',
              path: 'http://fixture.invalid/private-rule-probe',
              agent: false,
              timeout: 2000,
              headers: { Host: 'fixture.invalid', Connection: 'close' }
            },
            (response) => {
              response.resume()
              response.once('end', done)
              response.once('error', () => done())
            }
          )
          // Both rules deliberately REJECT. Their exact rule log, rather than
          // an HTTP success code or connection-close shape, is the oracle.
          req.once('error', () => done())
          req.once('timeout', () => req.destroy(new Error('Owned fixture traffic timeout')))
          req.end()
        })
        await vi.waitFor(() => {
          const line = session
            .logs?.()
            .slice(start)
            .find(
              (value) =>
                value.includes('fixture.invalid') &&
                value.includes(`match ${expected}`) &&
                value.includes('REJECT')
            )
          assert.ok(line, `Missing actual ${expected} decision`)
          decisions.push(line)
        })
      }
      await traffic('Domain')
      assert.equal(readLocalProxyRules(await session.read('rules')).rulesSHA256, first.rulesSHA256)
      let submitted = 0
      const guards = {
        assertLive: () => assert.equal(session.state(), 'running'),
        submitted: () => submitted++
      }
      await patch(target.index, true, guards)
      const disabled = readLocalProxyRules(await session.read('rules'))
      assert.equal(
        disabled.rulesSHA256,
        localProxyRulesSHA256(
          first.rules.map((rule) =>
            rule.index === target.index ? { ...rule, disabled: true } : rule
          )
        )
      )
      await traffic('Match')
      rows.push(
        'Production fixed single-index PATCH is confirmed by a whole-table expected digest and actual Domain-to-Match route decision'
      )

      await patch(target.index, false, guards)
      assert.equal(readLocalProxyRules(await session.read('rules')).rulesSHA256, first.rulesSHA256)
      await traffic('Domain')
      rows.push(
        'Explicit reverse PATCH restores the actual Domain rule decision without a persistent edit or new Core'
      )

      await patch(target.index, true, guards)
      assert.ok(session.reload)
      await session.reload(configuration, resourceHash(Buffer.from(configuration)))
      assert.equal(session.pid, pid)
      assert.equal(readLocalProxyRules(await session.read('rules')).rulesSHA256, first.rulesSHA256)
      rows.push(
        'Actual same-instance configuration reparse/reload resets upstream temporary disabled bits'
      )

      let live = true,
        blockedSubmissions = 0
      await assert.rejects(
        patch(target.index, true, {
          assertLive() {
            assert.equal(live, true)
            queueMicrotask(() => (live = false))
          },
          submitted: () => blockedSubmissions++
        })
      )
      assert.equal(blockedSubmissions, 0)
      assert.equal(readLocalProxyRules(await session.read('rules')).rulesSHA256, first.rulesSHA256)
      assert.equal(submitted, 3)
      rows.push(
        'Eventless microtask loss across real filesystem awaits prevents dispatch and changes no actual Core rule bit'
      )
    } catch (error) {
      failure = [error]
    } finally {
      cleanupFailures = await cleanupRuleFixture(cleanup, launch.children, [reserve, sentinel])
    }
    throwFixtureFailures(failure, cleanupFailures)
    assert.equal(core?.state(), 'stopped')
    assert.ok(await probeLocalPort(port))
    assert.equal(accepted, 0)
    rows.push(
      'Only the newly held Core was stopped; all held children closed and its private listener was released'
    )
    const inputs = [
        'src/main/relay/core/owned-runtime.ts',
        'src/main/relay/core/local-proxy-rules.ts',
        'scripts/relay/test-owned-rule-runtime.test.ts'
      ],
      sourceHashes = Object.fromEntries(
        await Promise.all(inputs.map(async (path) => [path, resourceHash(await readFile(path))]))
      )
    await writeFile(
      resolve(
        process.env.RELAY_OWNED_RULE_RUNTIME_OUTPUT ??
          '../evidence/owned-rule-runtime-root-verification-20261101.json'
      ),
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          passed: rows.length,
          failed: 0,
          sourceHashes,
          coreSHA256: resource.sha256,
          architecture: process.arch,
          coreVersion: resource.version,
          fixtureRoot: root,
          policy: launch.policy,
          actualUnixSocket: launch.socket,
          rows,
          decisions,
          sentinelAccepted: accepted,
          heldCoreChildrenClosed: launch.children.length,
          scope:
            'Actual shipping Core and production Owned API; only launch is wrapped in the exact sandbox policy. No Main dialog, TUN, real DNS, user network or Intel acceptance.',
          systemNetworkChanged: false,
          currentClashOrMihomoStopped: false,
          productAcceptance: 'pending'
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
    expect(rows).toHaveLength(7)
  },
  30000
)

it.runIf(process.env.RELAY_OWNED_RULE_RUNTIME_TEST === '1')(
  'closes held fixture resources even when primary cleanup rejects without hiding the original error',
  async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('child_process'),
      sentinel = createServer((socket) => socket.destroy()),
      children: { child: ChildProcess; closed: Promise<void> }[] = [],
      original = new Error('Synthetic original assertion'),
      cleanup = new Error('Synthetic directory identity refusal')
    let port = 0,
      failure: unknown[] = [],
      cleanupFailures: unknown[] = []
    try {
      port = await fixturePort(sentinel)
      const child = actual.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: ['ignore', 'ignore', 'ignore']
        }),
        closed = new Promise<void>((done) => child.once('close', () => done()))
      children.push({ child, closed })
      await once(child, 'spawn')
      const errors = await cleanupRuleFixture(
        async () => {
          throw cleanup
        },
        children,
        [sentinel]
      )
      assert.throws(
        () => throwFixtureFailures([original], errors),
        (error) => {
          assert.ok(error instanceof AggregateError)
          assert.equal(error.errors[0], original)
          assert.ok(error.errors.includes(cleanup))
          return true
        }
      )
      assert.equal(sentinel.listening, false)
      assert.ok(await probeLocalPort(port))
      assert.ok(child.exitCode !== null || child.signalCode !== null)
      await closed
    } catch (error) {
      failure = [error]
    } finally {
      cleanupFailures = await cleanupRuleFixture(undefined, children, [sentinel])
    }
    throwFixtureFailures(failure, cleanupFailures)
  },
  10000
)
