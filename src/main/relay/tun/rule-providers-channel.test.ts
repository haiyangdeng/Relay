import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTunAssetChannel } from './asset-channel'
import { createTunRuleProvidersChannel } from './rule-providers-channel'
import type {
  TunRuleProvidersChannel,
  TunRuleProvidersMutation,
  TunRuleProvidersNativeSnapshot
} from './rule-providers-contract'

const identity = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    evidenceSHA256: 'a'.repeat(64),
    runtimeConfigurationSHA256: 'b'.repeat(64),
    launchClientSHA256: 'c'.repeat(64),
    installationRevision: 'd'.repeat(64)
  },
  binding = {
    sessionId: identity.sessionId,
    evidenceSHA256: identity.evidenceSHA256,
    runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256
  },
  cfg = 'e'.repeat(64),
  gen = 'f'.repeat(64),
  old = '1'.repeat(64),
  next = '2'.repeat(64),
  blobId = '22222222-2222-4222-8222-222222222222',
  ticket = {
    blobId,
    kind: 'rule-yaml' as const,
    sha256: next,
    bytes: 42,
    filename: `${blobId}.yaml`
  },
  mutation: TunRuleProvidersMutation = {
    configurationRevision: cfg,
    expectedGenerationSHA256: gen,
    provider: 'First',
    oldSHA256: old,
    newSHA256: next,
    blobId,
    kind: ticket.kind,
    bytes: ticket.bytes,
    filename: ticket.filename,
    declaredRuleCount: 1
  },
  channels: TunRuleProvidersChannel[] = [],
  signal = () => new AbortController().signal
function table(updated = false): TunRuleProvidersNativeSnapshot {
  return {
    configurationRevision: cfg,
    generationSHA256: updated ? '3'.repeat(64) : gen,
    providers: ['First', 'Alias'].map((name, index) => ({
      name,
      kind: 'rule-yaml',
      behavior: index ? 'classical' : 'domain',
      fileSHA256: updated ? next : old,
      bytes: 42,
      ruleCount: 1
    })),
    groups: [['First', 'Alias']]
  }
}
function fixture(hook?: () => void) {
  const request = new PassThrough(),
    reply = new PassThrough(),
    frames: Record<string, unknown>[] = []
  let tail = ''
  request.on('data', (chunk: Buffer) => {
    tail += chunk.toString()
    for (;;) {
      const at = tail.indexOf('\n')
      if (at < 0) break
      frames.push(JSON.parse(tail.slice(0, at)))
      tail = tail.slice(at + 1)
    }
  })
  const close = vi.fn(() => {
      request.destroy()
      reply.destroy()
    }),
    io = {
      write: (line: string) => {
        request.write(line)
      },
      onData: (fn: (b: Buffer) => void) => {
        reply.on('data', fn)
      },
      onGone: (fn: () => void) => {
        reply.on('end', fn)
      },
      onFault: (fn: (error: Error) => void) => {
        reply.on('error', fn)
      },
      close
    },
    channel = hook
      ? createTunAssetChannel(io, identity, {
          capability: 'runtime-rule-providers-v1',
          frameByteLimit: 262144,
          label: '规则提供者',
          mutation: () => mutation,
          ticket: () => ticket,
          snapshot: () => table(true),
          verifyCommit: hook
        })
      : createTunRuleProvidersChannel(io, identity),
    send = (value: unknown) => reply.write(Buffer.from(JSON.stringify(value) + '\n')),
    response = (id: number, status: string, fields: Record<string, unknown> = {}) =>
      send({
        version: 1,
        id,
        action: frames.find((f) => f.id === id)?.action,
        ...binding,
        status,
        pending: false,
        ...fields
      }),
    hello = (changes: Record<string, unknown> = {}) =>
      send({
        version: 1,
        kind: 'hello',
        capability: 'runtime-rule-providers-v1',
        ...identity,
        ...changes
      })
  channels.push(channel)
  return { channel, request, reply, frames, close, send, response, hello }
}
async function frame(f: ReturnType<typeof fixture>, count: number) {
  for (let i = 0; i < 20 && f.frames.length < count; i++) await Promise.resolve()
  expect(f.frames).toHaveLength(count)
  return f.frames[count - 1]
}
afterEach(() => {
  for (const c of channels.splice(0)) c.invalidate()
  vi.useRealTimers()
})

describe('Dedicated runtime rule-provider asset broker', () => {
  it.each(['read', 'replace'] as const)(
    'preserves a bound Native unsupported %s result without closing the lane',
    async (action) => {
      const f = fixture()
      f.hello()
      const pending =
        action === 'read'
          ? f.channel.read(signal(), () => {})
          : f.channel.replace(mutation, signal(), () => {})
      await frame(f, 1)
      f.response(1, 'unsupported')
      expect(await pending).toEqual({ status: 'unsupported' })
      expect(f.channel.isBusy()).toBe(false)
      expect(f.channel.isAvailable()).toBe(true)
      expect(f.close).not.toHaveBeenCalled()
      const next = f.channel.read(signal(), () => {})
      await frame(f, 2)
      f.response(2, 'snapshot', { snapshot: table() })
      expect(await next).toEqual({ status: 'snapshot', snapshot: table() })
    }
  )
  it('binds a distinct capability and returns opaque file generations plus complete alias groups', async () => {
    const f = fixture(),
      pending = f.channel.read(signal(), () => {})
    expect(f.frames).toHaveLength(0)
    expect(await f.channel.read(signal(), () => {})).toEqual({ status: 'busy' })
    f.hello()
    expect(await frame(f, 1)).toEqual({ version: 1, id: 1, action: 'read', ...binding })
    f.response(1, 'snapshot', { snapshot: table() })
    expect(await pending).toEqual({ status: 'snapshot', snapshot: table() })
  })
  it.each([
    'capability',
    'launchClientSHA256',
    'installationRevision',
    'sessionId',
    'evidenceSHA256',
    'runtimeConfigurationSHA256'
  ])('rejects unbound hello %s with zero requests', async (key) => {
    const f = fixture()
    f.hello({ [key]: key === 'capability' ? 'runtime-resources-v1' : '0'.repeat(64) })
    expect(await f.channel.read(signal(), () => {})).toEqual({ status: 'unsupported' })
    expect(f.frames).toHaveLength(0)
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('sends the ticket and declared completeness constraint without a claimed acceptance count or Core nonce', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.replace(mutation, signal(), () => {})
    expect(await frame(f, 1)).toEqual({
      version: 1,
      id: 1,
      action: 'replace',
      ...binding,
      ...mutation
    })
    f.response(1, 'updated', { snapshot: table(true) })
    expect(await pending).toEqual({ status: 'updated', snapshot: table(true) })
  })
  it('accepts unchanged only for the same file SHA and same generation', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.replace({ ...mutation, newSHA256: old }, signal(), () => {})
    await frame(f, 1)
    f.response(1, 'unchanged', { snapshot: table() })
    expect(await pending).toEqual({ status: 'unchanged', snapshot: table() })
  })
  it('accepts the declared upper bound only with every linked actual counter matching it', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.replace(
      { ...mutation, declaredRuleCount: 2_000_000 },
      signal(),
      () => {}
    )
    expect(await frame(f, 1)).toMatchObject({ declaredRuleCount: 2_000_000 })
    const current = table(true)
    current.providers = current.providers.map((entry) => ({ ...entry, ruleCount: 2_000_000 }))
    f.response(1, 'updated', { snapshot: current })
    expect(await pending).toEqual({ status: 'updated', snapshot: current })
  })
  it.each([
    { filename: '../outside.yaml' },
    { kind: 'geoip-dat' },
    { provider: ' bad ' },
    { provider: '\ud800' },
    { provider: 'bad,name' },
    { expectedRuleCount: 1 },
    { declaredRuleCount: undefined },
    { declaredRuleCount: 0 },
    { declaredRuleCount: 1.5 },
    { declaredRuleCount: 2_000_001 },
    { path: '/private/secret' },
    { pid: 42 },
    { url: 'https://private.invalid' },
    { prepareNonce: 'NO_AUTHORITY' }
  ])('rejects mutated request %# before writing and keeps the read capability', async (changes) => {
    const f = fixture()
    f.hello()
    expect(
      await f.channel.replace(
        { ...mutation, ...changes } as TunRuleProvidersMutation,
        signal(),
        () => {}
      )
    ).toEqual({
      status: 'unavailable'
    })
    expect(f.frames).toHaveLength(0)
    expect(f.channel.isAvailable()).toBe(true)
  })
  it('reads a multibyte snapshot above the old 8KiB limit, bounded by the new 256KiB frame', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.read(signal(), () => {})
    await frame(f, 1)
    const snapshot = table()
    snapshot.providers = Array.from({ length: 80 }, (_, i) => ({
      ...table().providers[0],
      name: `条目${i}-` + 'x'.repeat(90)
    }))
    snapshot.groups = snapshot.providers.map((p) => [p.name])
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        id: 1,
        action: 'read',
        ...binding,
        status: 'snapshot',
        pending: false,
        snapshot
      }) + '\n'
    )
    expect(bytes.length).toBeGreaterThan(8192)
    expect(bytes.length).toBeLessThan(262144)
    const split = bytes.indexOf(Buffer.from('条')) + 1
    f.reply.write(bytes.subarray(0, split))
    f.reply.write(bytes.subarray(split))
    expect(await pending).toEqual({ status: 'snapshot', snapshot })
  })
  it('rejects an over-budget provider frame and closes only this pair', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.read(signal(), () => {})
    await frame(f, 1)
    f.reply.write(Buffer.from(' '.repeat(262145)))
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('requires groups to partition every returned name exactly once, with consistent file facts', async () => {
    for (const change of [
      (s: TunRuleProvidersNativeSnapshot) => {
        s.groups = [['First']]
      },
      (s: TunRuleProvidersNativeSnapshot) => {
        s.groups = [['First', 'Alias'], ['Alias']]
      },
      (s: TunRuleProvidersNativeSnapshot) => {
        s.groups = [[]]
      },
      (s: TunRuleProvidersNativeSnapshot) => {
        s.groups = [['First', 'Absent']]
      },
      (s: TunRuleProvidersNativeSnapshot) => {
        s.providers[1].fileSHA256 = next
      },
      (s: TunRuleProvidersNativeSnapshot) => {
        s.providers[1].bytes++
      },
      (s: TunRuleProvidersNativeSnapshot) => {
        s.providers[1].kind = 'rule-mrs'
      },
      (s: TunRuleProvidersNativeSnapshot) => {
        s.providers[1].name = 'First'
      }
    ]) {
      const f = fixture()
      f.hello()
      const pending = f.channel.read(signal(), () => {})
      await frame(f, 1)
      const s = table()
      change(s)
      f.response(1, 'snapshot', { snapshot: s })
      expect(await pending).toEqual({ status: 'unavailable' })
      expect(f.close).toHaveBeenCalledOnce()
    }
  })
  it('accepts reserved-looking data names without using object prototype lookup', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.read(signal(), () => {})
    await frame(f, 1)
    const s = table()
    s.providers[0].name = '__proto__'
    s.groups = [['__proto__', 'Alias']]
    f.response(1, 'snapshot', { snapshot: s })
    expect(await pending).toEqual({ status: 'snapshot', snapshot: s })
  })
  it.each([
    { ruleCount: -1 },
    { ruleCount: 1.2 },
    { behavior: ['domain'] },
    { bytes: 0 },
    { kind: 'runtime-file' },
    { fileSHA256: 'A'.repeat(64) },
    { loadedStrategySHA256: old }
  ])('rejects malformed provider facts %# without inventing strategy hashes', async (changes) => {
    const f = fixture()
    f.hello()
    const pending = f.channel.read(signal(), () => {})
    await frame(f, 1)
    const s = table()
    Object.assign(s.providers[0], changes)
    f.response(1, 'snapshot', { snapshot: s })
    expect(await pending).toEqual({ status: 'unavailable' })
  })
  it('checks entry and unique-file budgets without charging repeated aliases as separate files', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.read(signal(), () => {})
    await frame(f, 1)
    const s = table()
    s.providers = s.providers.map((p) => ({ ...p, bytes: 128 * 1024 * 1024, kind: 'rule-mrs' }))
    f.response(1, 'snapshot', { snapshot: s })
    expect((await pending).status).toBe('snapshot')
    for (const huge of [
      {
        providers: Array.from({ length: 201 }, (_, i) => ({
          ...table().providers[0],
          name: String(i)
        })),
        groups: []
      },
      {
        providers: Array.from({ length: 3 }, (_, i) => ({
          ...table().providers[0],
          name: String(i),
          bytes: 128 * 1024 * 1024,
          kind: 'rule-mrs'
        })),
        groups: [['0'], ['1'], ['2']]
      }
    ]) {
      const g = fixture()
      g.hello()
      const read = g.channel.read(signal(), () => {})
      await frame(g, 1)
      g.response(1, 'snapshot', { snapshot: { ...table(), ...huge } })
      expect(await read).toEqual({ status: 'unavailable' })
    }
  })
  it.each([
    { configurationRevision: old },
    { generationSHA256: gen },
    { providers: table().providers },
    { providers: table(true).providers.map((p) => ({ ...p, bytes: 43 })) },
    { providers: table(true).providers.map((p) => ({ ...p, ruleCount: 2 })) }
  ])('withholds mismatched file publication %# as uncertain', async (changes) => {
    const f = fixture()
    f.hello()
    const pending = f.channel.replace(mutation, signal(), () => {})
    await frame(f, 1)
    f.response(1, 'updated', { snapshot: { ...table(true), ...changes } })
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('never accepts the private Native published enum directly on the wire', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.replace(mutation, signal(), () => {})
    await frame(f, 1)
    f.response(1, 'published', { snapshot: table(true) })
    expect(await pending).toEqual({ status: 'uncertain' })
  })
  it('holds the one logical operation until both cancelling ACK and original reply settle', async () => {
    const f = fixture(),
      abort = new AbortController()
    f.hello()
    const pending = f.channel.replace(mutation, abort.signal, () => {})
    await frame(f, 1)
    abort.abort()
    expect(await frame(f, 2)).toMatchObject({ action: 'cancel', operationId: 1 })
    f.response(2, 'cancelling', { pending: true })
    let idle = false
    const done = f.channel.whenIdle().then(() => (idle = true))
    await Promise.resolve()
    expect(idle).toBe(false)
    expect(await f.channel.read(signal(), () => {})).toEqual({ status: 'busy' })
    f.response(1, 'cancelled')
    expect(await pending).toEqual({ status: 'cancelled' })
    await done
    expect(idle).toBe(true)
  })
  it('does not publish a late success after cancellation or release busy on only the main reply', async () => {
    const f = fixture(),
      abort = new AbortController()
    f.hello()
    const pending = f.channel.replace(mutation, abort.signal, () => {})
    await frame(f, 1)
    abort.abort()
    await frame(f, 2)
    f.response(1, 'updated', { snapshot: table(true) })
    expect(f.channel.isBusy()).toBe(true)
    f.response(2, 'stale')
    expect(await pending).toEqual({ status: 'uncertain' })
  })
  it('rechecks synchronous UI cancellation before the first write', async () => {
    const f = fixture(),
      abort = new AbortController()
    f.hello()
    expect(await f.channel.replace(mutation, abort.signal, () => abort.abort())).toEqual({
      status: 'cancelled'
    })
    expect(f.frames).toHaveLength(0)
  })
  it('keeps a final guard after newly extracted protocol validators', async () => {
    const abort = new AbortController(),
      f = fixture(() => abort.abort())
    f.hello()
    const pending = f.channel.replace(mutation, abort.signal, () => {})
    await frame(f, 1)
    f.response(1, 'updated', { snapshot: table(true) })
    await frame(f, 2)
    f.response(2, 'stale')
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.channel.isBusy()).toBe(false)
  })
  it('retains the original total 30s operation bound and closes only this capability on expiry', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.hello()
    const pending = f.channel.replace(mutation, signal(), () => {})
    await frame(f, 1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(f.channel.isBusy()).toBe(true)
    await vi.advanceTimersByTimeAsync(26000)
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.channel.isAvailable()).toBe(false)
  })
  it('treats post-dispatch EOF as unknown and never calls a lifecycle stop', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.replace(mutation, signal(), () => {})
    await frame(f, 1)
    f.reply.emit('end')
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('matches full shared-pool discard ACK while a user cancellation only waits for cleanup', async () => {
    const f = fixture()
    f.hello()
    const discard = f.channel.discardBlob(ticket)
    expect(await frame(f, 1)).toEqual({
      version: 1,
      id: 1,
      action: 'discardBlob',
      ...binding,
      ...ticket
    })
    const cancelled = f.channel.cancel()
    await Promise.resolve()
    expect(f.frames).toHaveLength(1)
    f.response(1, 'absent')
    expect(await discard).toBe('absent')
    await cancelled
  })
})

it('holds all 200 maximum escaped names within the bounded 256KiB provider frame', async () => {
  const f = fixture(),
    pending = f.channel.read(signal(), () => {})
  f.hello()
  await frame(f, 1)
  const snapshot = table()
  snapshot.providers = Array.from({ length: 200 }, (_, index) => ({
    ...table().providers[0],
    name: '"'.repeat(253) + String(index).padStart(3, '0')
  }))
  snapshot.groups = [snapshot.providers.map((row) => row.name)]
  const reply = {
      version: 1,
      id: 1,
      action: 'read',
      ...binding,
      status: 'snapshot',
      pending: false,
      snapshot
    },
    bytes = Buffer.from(JSON.stringify(reply) + '\n')
  expect(bytes.length).toBeGreaterThan(131072)
  expect(bytes.length).toBeLessThan(262144)
  f.reply.write(bytes)
  expect(await pending).toEqual({ status: 'snapshot', snapshot })
})
