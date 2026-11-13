import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { it, vi } from 'vitest'
import {
  createTunRulesChannel,
  type TunRulesChannel,
  type TunRulesSnapshot
} from '../../src/main/relay/tun/rules-channel'
import { parseTunHostFrame } from '../../src/main/relay/tun/wire-json'

const identity = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  evidenceSHA256: 'a'.repeat(64),
  runtimeConfigurationSHA256: 'b'.repeat(64),
  launchClientSHA256: 'd'.repeat(64),
  installationRevision: 'e'.repeat(64)
}
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const expectedSources = {
  'src/main/relay/tun/rules-channel.ts':
    '44fd4ebb70fc9dc574c515a00334f7963856a861d5b544ded9317576f4817ff9',
  'src/main/relay/tun/wire-json.ts':
    '436d5748cd5172b9539a7d18cbc9f5abc18577d898db5522f7a95e15d3db839f',
  'native/tun/RelayTunRuntimeRules.swift':
    'b3629155e01807d01955c369ee2a43ec95310e0c95658306dbe42ab04439a072',
  'native/tun/RelayTunRuntimeRulesTests.swift':
    '7c91854f3b790b27b999aaa5b78bb4788d88969ea413954551932a680c459f57'
}
const sources = async () =>
  Object.fromEntries(
    await Promise.all(
      [...Object.keys(expectedSources), 'scripts/relay/test-tun-rules-channel.test.ts'].map(
        async (path) => [path, sha(await readFile(path))]
      )
    )
  )
async function bounded<T>(promise: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Private rules fixture deadline')), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function checkedBinary(): Promise<{ path: string; sha256: string }> {
  assert.equal(process.platform, 'darwin')
  assert.ok(process.getuid && process.geteuid && process.getgid && process.getegid)
  assert.ok(
    process.getuid() > 0 &&
      process.getuid() === process.geteuid() &&
      process.getgid() === process.getegid()
  )
  const path = resolve(process.env.RELAY_TUN_RULES_FIXTURE ?? ''),
    expected = process.env.RELAY_TUN_RULES_FIXTURE_SHA256
  assert.ok(
    path.startsWith('/private/tmp/') && basename(path) === 'RelayTunRuntimeRulesTests-arm64'
  )
  assert.match(expected ?? '', /^[a-f0-9]{64}$/u)
  const info = await lstat(path),
    parent = await lstat(dirname(path))
  assert.ok(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      info.nlink === 1 &&
      !(info.mode & 0o6022) &&
      !!(info.mode & 0o100)
  )
  assert.ok(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      parent.uid === process.getuid() &&
      (parent.mode & 0o7777) === 0o700
  )
  assert.equal(await realpath(path), path)
  assert.equal(sha(await readFile(path)), expected)
  return { path, sha256: expected ?? '' }
}
interface Wire {
  id: number
  action: string
  status?: string
  pending?: boolean
  operationId?: number
}
interface Counters {
  reads: number
  applies: number
  writes: number
}
const evidence: {
  name: string
  requests: Wire[]
  replies: Wire[]
  counters: Counters
  exited: boolean
  exitCode: number | null
  signalCode: string | null
}[] = []
async function fixture(
  name: string,
  work: (f: {
    channel: TunRulesChannel
    requests: Wire[]
    replies: Wire[]
    consent(): void
    onPrepared(callback: () => void): void
    command(command: string): Promise<void>
    state(): Promise<Counters>
    waitState(predicate: (value: Counters) => boolean): Promise<Counters>
    endRulesInput(): void
    dropCommitReplies(): void
    closeRulesOutput(): void
  }) => Promise<void>
): Promise<void> {
  let child: ChildProcess | undefined,
    channel: TunRulesChannel | undefined,
    closed: Promise<void> | undefined,
    failed: unknown[] = [],
    stopping = false,
    problem: Error | undefined,
    stdout = '',
    stderrBytes = 0,
    response = Buffer.alloc(0),
    consent = false,
    dropAfterCommit = false,
    dropping = false,
    prepared: (() => void) | undefined
  const requests: Wire[] = [],
    replies: Wire[] = [],
    lines: string[] = [],
    errors: unknown[] = []
  let last: Counters = { reads: 0, applies: 0, writes: 0 }
  try {
    const binary = await checkedBinary()
    child = spawn(binary.path, ['--rules-channel-fixture'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      detached: false,
      cwd: dirname(binary.path),
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        HOME: dirname(binary.path),
        TMPDIR: dirname(binary.path)
      }
    })
    const owned = child
    closed = new Promise<void>((done) => owned.once('close', () => done()))
    owned.on('error', () => {
      problem = new Error('Private test process failed')
    })
    for (const stream of owned.stdio)
      stream?.on('error', () => {
        if (!stopping && stream !== owned.stdio.at(5) && stream !== owned.stdio.at(6))
          problem = new Error('Private fixture stream failed')
      })
    owned.stdin?.on('error', () => {
      if (!stopping) problem = new Error('Private control input failed')
    })
    owned.stdout?.on('data', (bytes: Buffer) => {
      if (stdout.length + bytes.length > 65536) {
        problem = new Error('Private control output exceeded budget')
        return
      }
      stdout += bytes.toString('utf8')
      while (stdout.includes('\n')) {
        const end = stdout.indexOf('\n')
        lines.push(stdout.slice(0, end))
        stdout = stdout.slice(end + 1)
      }
      if (lines.length > 1000) problem = new Error('Private control line budget exceeded')
    })
    owned.stderr?.on('data', (bytes: Buffer) => {
      stderrBytes += bytes.length
      if (stderrBytes > 65536) problem = new Error('Private stderr exceeded budget')
    })
    const line = async (prefix: string, after = 0): Promise<string> =>
      vi.waitFor(
        () => {
          if (problem) throw problem
          const value = lines.slice(after).find((value) => value.startsWith(prefix))
          assert.ok(value, 'Private control response missing')
          return value
        },
        { timeout: 2000, interval: 10 }
      )
    assert.equal(await line('CONTROL_READY'), 'CONTROL_READY')
    const input = owned.stdio.at(5),
      output = owned.stdio.at(6)
    assert.ok(input && 'write' in input && output && 'read' in output)
    const request = input as Writable,
      reply = output as Readable
    channel = createTunRulesChannel(
      {
        write: (frame) => {
          const raw = parseTunHostFrame(Buffer.from(frame))
          assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw))
          const item = raw as Record<string, unknown>
          if (item.action === 'prepare')
            assert.ok(consent, 'Synthetic consent must precede prepare')
          requests.push({
            id: Number(item.id),
            action: String(item.action),
            ...(item.action === 'cancel' ? { operationId: Number(item.operationId) } : {})
          })
          if (item.action === 'commit' && dropAfterCommit) dropping = true
          request.write(frame)
        },
        onData: (callback) =>
          reply.on('data', (bytes: Buffer) => {
            if (dropping) return
            try {
              assert.ok(response.length + bytes.length <= 2 * 1024 * 1024 + 8192)
              response = Buffer.concat([response, bytes])
              for (;;) {
                const end = response.indexOf(10)
                if (end < 0) break
                const raw = parseTunHostFrame(response.subarray(0, end), 2 * 1024 * 1024 + 8192)
                response = response.subarray(end + 1)
                assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw))
                const item = raw as Record<string, unknown>
                if (typeof item.id === 'number')
                  replies.push({
                    id: item.id,
                    action: String(item.action),
                    status: String(item.status),
                    pending: Boolean(item.pending)
                  })
                if (item.status === 'prepared') prepared?.()
              }
            } catch {
              problem = new Error('Private response observation failed')
            }
            callback(bytes)
          }),
        onGone: (callback) => {
          reply.on('end', callback)
          reply.on('close', callback)
          owned.on('close', callback)
        },
        onFault: (callback) => {
          request.on('error', callback)
          reply.on('error', callback)
        },
        close: () => {
          request.destroy()
          reply.destroy()
        }
      },
      identity
    )
    const rules = channel,
      state = async (): Promise<Counters> => {
        const after = lines.length
        owned.stdin?.write('state\n')
        const value = (await line('fixture-state:', after)).split(':').slice(1).map(Number)
        assert.equal(value.length, 3)
        assert.ok(value.every((n) => Number.isSafeInteger(n) && n >= 0))
        last = { reads: value[0], applies: value[1], writes: value[2] }
        return last
      }
    await vi.waitFor(() => assert.ok(rules.isAvailable()), { timeout: 2000, interval: 10 })
    await work({
      channel: rules,
      requests,
      replies,
      consent: () => {
        consent = true
      },
      onPrepared: (callback) => {
        prepared = callback
      },
      async command(command) {
        const after = lines.length
        owned.stdin?.write(command + '\n')
        // Recognized fixture controls are silent. A later echo is their barrier.
        owned.stdin?.write('barrier-' + command + '\n')
        assert.equal(
          await line('control-alive:barrier-' + command, after),
          'control-alive:barrier-' + command
        )
      },
      state,
      async waitState(predicate) {
        const deadline = performance.now() + 1500
        do {
          const value = await state()
          if (predicate(value)) return value
        } while (performance.now() < deadline)
        throw new Error('Private counter state did not reach its observable boundary')
      },
      endRulesInput: () => request.end(),
      dropCommitReplies: () => {
        dropAfterCommit = true
      },
      closeRulesOutput: () => reply.destroy()
    })
    last = await state()
    assert.equal(problem, undefined)
  } catch (error) {
    failed = [error]
  }
  // Never let a capability-close failure skip control/child release.
  for (const result of await Promise.allSettled([
    Promise.resolve().then(() => channel?.invalidate()),
    Promise.resolve().then(() => {
      stopping = true
      child?.stdin?.end()
    })
  ]))
    if (result.status === 'rejected') errors.push(result.reason)
  if (child && closed) {
    try {
      await bounded(closed, 1500)
    } catch (error) {
      errors.push(error)
      child.kill('SIGTERM')
      try {
        await bounded(closed, 1500)
      } catch (error) {
        errors.push(error)
        child.kill('SIGKILL')
        try {
          await bounded(closed)
        } catch (error) {
          errors.push(error)
        }
      }
    }
    for (const result of await Promise.allSettled(
      child.stdio.map((stream) => Promise.resolve().then(() => stream?.destroy()))
    ))
      if (result.status === 'rejected') errors.push(result.reason)
    if (stderrBytes) errors.push(new Error('Private fixture stderr was not empty'))
    if (child.exitCode !== 0 || child.signalCode !== null)
      errors.push(new Error('Private fixture did not exit cleanly'))
    evidence.push({
      name,
      requests,
      replies,
      counters: last,
      exited: child.exitCode !== null || child.signalCode !== null,
      exitCode: child.exitCode,
      signalCode: child.signalCode
    })
  }
  if (failed.length || errors.length)
    throw new AggregateError([...failed, ...errors], 'Private cross-language rules fixture failed')
}
async function read(channel: TunRulesChannel): Promise<TunRulesSnapshot> {
  const result = await channel.read(new AbortController().signal, () => {})
  assert.equal(result.status, 'snapshot')
  assert.ok('snapshot' in result)
  return result.snapshot
}
const selection = (value: TunRulesSnapshot) => ({
  configurationRevision: value.configurationRevision,
  rulesSHA256: value.rulesSHA256,
  index: 0,
  disabled: true
})

it.runIf(process.env.RELAY_TUN_RULES_PIPE_TEST === '1')(
  'uses only the frozen ordinary-UID Native model and independent control/rules pipes',
  async () => {
    const binary = await checkedBinary(),
      sourceSHA256Before = await sources(),
      checks: string[] = []
    for (const [path, expected] of Object.entries(expectedSources))
      assert.equal(sourceSHA256Before[path], expected)
    await fixture('real Native opaque snapshot and one-bit commit', async (f) => {
      const before = await read(f.channel)
      assert.equal(before.rules[0].disabled, false)
      f.consent()
      const result = await f.channel.change(
        selection(before),
        new AbortController().signal,
        () => {}
      )
      assert.equal(result.status, 'changed')
      assert.ok('snapshot' in result)
      assert.equal(result.snapshot.rules[0].disabled, true)
      assert.notEqual(result.snapshot.rulesSHA256, before.rulesSHA256)
      const after = await read(f.channel)
      const repeated = await f.channel.change(
        selection(after),
        new AbortController().signal,
        () => {}
      )
      assert.equal(repeated.status, 'unchanged')
      assert.equal(f.requests.filter((r) => r.action === 'commit').length, 1)
      assert.equal((await f.state()).writes, 1)
    })
    checks.push(
      'Actual Native typed snapshot/opaque SHA and one-bit model commit; unchanged makes no second commit'
    )
    await fixture('cancelled read tombstone and control survival', async (f) => {
      await f.command('hold-read')
      const abort = new AbortController(),
        pending = f.channel.read(abort.signal, () => {})
      await f.waitState((s) => s.reads === 1)
      abort.abort()
      await vi.waitFor(
        () =>
          assert.ok(
            f.replies.some((r) => r.action === 'cancel' && r.status === 'cancelling' && r.pending)
          ),
        { timeout: 1000 }
      )
      assert.equal(f.channel.isBusy(), true)
      assert.equal((await f.channel.read(new AbortController().signal, () => {})).status, 'busy')
      await f.command('release-read')
      assert.equal((await pending).status, 'cancelled')
      assert.equal((await f.state()).writes, 0)
    })
    checks.push(
      'Actual Native pending cancel keeps one flight until original release; zero model writes, control survives'
    )
    await fixture('logical prepare ID cancellation during held apply', async (f) => {
      const before = await read(f.channel)
      await f.command('hold-apply')
      const abort = new AbortController()
      f.consent()
      const pending = f.channel.change(selection(before), abort.signal, () => {})
      await f.waitState((s) => s.applies === 1 && s.writes === 0)
      abort.abort()
      await vi.waitFor(
        () =>
          assert.ok(
            f.replies.some((r) => r.action === 'cancel' && r.status === 'cancelling' && r.pending)
          ),
        { timeout: 1000 }
      )
      const prepared = f.requests.find((r) => r.action === 'prepare'),
        commit = f.requests.find((r) => r.action === 'commit'),
        cancelled = f.requests.find((r) => r.action === 'cancel')
      assert.ok(prepared && commit && cancelled)
      assert.notEqual(prepared.id, commit.id)
      assert.equal(cancelled.operationId, prepared.id)
      assert.equal(f.channel.isBusy(), true)
      await f.command('release-apply')
      assert.equal((await pending).status, 'uncertain')
      assert.equal((await f.state()).writes, 0)
      assert.equal((await read(f.channel)).rules[0].disabled, false)
    })
    checks.push(
      'A real held pre-entry Native apply is cancelled by logical prepareID; zero model writes, conservative uncertain after commit delegation, fresh read remains possible'
    )
    await fixture('queued eventless UI loss before commit', async (f) => {
      const before = await read(f.channel)
      let live = true
      f.onPrepared(() =>
        queueMicrotask(() => {
          live = false
        })
      )
      f.consent()
      const result = await f.channel.change(selection(before), new AbortController().signal, () => {
        if (!live) throw new Error('synthetic UI loss')
      })
      assert.equal(result.status, 'cancelled')
      assert.equal(
        f.requests.some((r) => r.action === 'commit'),
        false
      )
      assert.equal((await f.state()).writes, 0)
      await f.command('still-live-after-ui-loss')
    })
    checks.push(
      'Real prepared response queued across synthetic eventless UI loss sends zero commit'
    )
    await fixture('held Native preparation loses its owner', async (f) => {
      const before = await read(f.channel)
      await f.command('hold-read')
      f.consent()
      const pending = f.channel.change(selection(before), new AbortController().signal, () => {})
      await f.waitState((s) => s.reads === 2)
      await f.command('owner-loss')
      await f.command('release-read')
      assert.equal((await pending).status, 'stale')
      assert.equal(
        f.requests.some((r) => r.action === 'commit'),
        false
      )
      assert.equal((await f.state()).writes, 0)
      await f.command('still-live-after-owner-loss')
    })
    checks.push(
      'Actual private owner generation loss during held preparation produces no nonce/commit/write and leaves fixture control alive'
    )
    await fixture('rules EOF does not close control', async (f) => {
      await f.command('hold-read')
      const pending = f.channel.read(new AbortController().signal, () => {})
      await f.waitState((s) => s.reads === 1)
      f.endRulesInput()
      assert.equal((await pending).status, 'unavailable')
      await f.command('release-read')
      await f.command('still-live-after-rules-eof')
      assert.equal((await f.state()).writes, 0)
    })
    checks.push('Actual FD5 EOF fails only rules capability; private control remains responsive')
    await fixture('committed model write with intentionally lost receipt', async (f) => {
      const before = await read(f.channel)
      f.dropCommitReplies()
      f.consent()
      const pending = f.channel.change(selection(before), new AbortController().signal, () => {})
      await f.waitState((s) => s.writes === 1)
      f.closeRulesOutput()
      assert.equal((await pending).status, 'uncertain')
      await f.command('still-live-after-unknown')
      assert.equal((await f.state()).writes, 1)
      assert.equal(f.requests.filter((r) => r.action === 'commit').length, 1)
    })
    checks.push(
      'Actual Native model admitted write but response intentionally dropped: uncertain/one commit/no retry/control alive'
    )
    await fixture('original three-second lease and control survival', async (f) => {
      await f.command('hold-read')
      const start = performance.now(),
        pending = f.channel.read(new AbortController().signal, () => {})
      assert.equal((await pending).status, 'expired')
      assert.ok(performance.now() - start >= 2800)
      assert.equal(f.channel.isAvailable(), false)
      await f.command('release-read')
      await f.command('still-live-after-rules-timeout')
      assert.equal((await f.state()).writes, 0)
    })
    checks.push(
      'Held native read expires on original three-second lease without ending independent control'
    )
    assert.equal((await checkedBinary()).sha256, binary.sha256)
    const sourceSHA256After = await sources()
    assert.deepEqual(sourceSHA256After, sourceSHA256Before)
    assert.ok(evidence.every((e) => e.exited))
    await writeFile(
      resolve(
        process.env.RELAY_TUN_RULES_PIPE_OUTPUT ??
          '../evidence/tun-rules-channel-native-pipe-verification-20261102.json'
      ),
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          passed: checks.length,
          failed: 0,
          checks,
          binary,
          sourceSHA256Before,
          sourceSHA256After,
          fixtures: evidence,
          scope:
            'Ordinary-UID standalone Native typed model over actual7stdio; synthetic consent/UI loss/response loss, no AppSession or Core.',
          actualModelPipe: true,
          actualCoreOrTUN: false,
          actualHelperOrUID0: false,
          systemNetworkChanged: false,
          currentClashOrMihomoStopped: false,
          limits: [
            'Native fixture owner revision differs deliberately from binding runtime SHA; this tests raw broker, not service loaded-source attestation.',
            'Control is fixture stdin/stdout echo, not shipping lifecycle recovery. FD3/4 are unused here.',
            'Nonce is private and omitted from request/reply evidence. Model write counter is memory mutation, not HTTP PATCH or TUN.',
            'Only held spawned process handles are closed; no process-name/PID adoption, user root, listener or installed helper is used.'
          ]
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
  },
  30000
)
