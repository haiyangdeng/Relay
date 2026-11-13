import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTunRulesChannel, type TunRulesChannel, type TunRulesMutation } from './rules-channel'
import { parseTunHostFrame } from './wire-json'

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
  nonce = '22222222-2222-4222-8222-222222222222',
  revision = 'e'.repeat(64),
  digest = 'f'.repeat(64),
  mutation: TunRulesMutation = {
    configurationRevision: revision,
    rulesSHA256: digest,
    index: 0,
    disabled: true
  },
  signal = () => new AbortController().signal,
  channels: TunRulesChannel[] = []
function table(disabled = false) {
  return {
    configurationRevision: revision,
    rulesSHA256: digest,
    rules: [
      { index: 0, type: 'Domain', payload: 'fixture.invalid', proxy: 'REJECT', size: -1, disabled },
      { index: 1, type: 'Match', payload: '', proxy: 'REJECT' }
    ]
  }
}
function fixture() {
  const requests = new PassThrough(),
    replies = new PassThrough(),
    frames: Record<string, unknown>[] = []
  let tail = ''
  requests.on('data', (bytes: Buffer) => {
    tail += bytes.toString()
    for (;;) {
      const end = tail.indexOf('\n')
      if (end < 0) break
      frames.push(JSON.parse(tail.slice(0, end)))
      tail = tail.slice(end + 1)
    }
  })
  const close = vi.fn(() => {
      requests.destroy()
      replies.destroy()
    }),
    channel = createTunRulesChannel(
      {
        write: (frame) => {
          requests.write(frame)
        },
        onData: (callback) => {
          replies.on('data', callback)
        },
        onGone: (callback) => {
          replies.on('end', callback)
        },
        onFault: (callback) => {
          replies.on('error', callback)
        },
        close
      },
      identity
    ),
    send = (raw: unknown) => replies.write(Buffer.from(JSON.stringify(raw) + '\n')),
    response = (id: number, status: string, fields: Record<string, unknown> = {}) =>
      send({
        version: 1,
        id,
        action: frames.find((frame) => frame.id === id)?.action,
        ...binding,
        status,
        pending: false,
        ...fields
      })
  channels.push(channel)
  return {
    channel,
    frames,
    close,
    requests,
    replies,
    send,
    response,
    hello: (changes: Record<string, unknown> = {}) =>
      send({ version: 1, kind: 'hello', capability: 'runtime-rules-v1', ...identity, ...changes }),
    prepared: (id = 1, changes: Record<string, unknown> = {}) =>
      response(id, 'prepared', {
        prepared: {
          nonce,
          operationId: id,
          leaseMilliseconds: 2800,
          ...mutation,
          ...changes
        }
      }),
    gone: () => replies.emit('end')
  }
}
async function frame(f: ReturnType<typeof fixture>, count: number) {
  for (let n = 0; n < 20 && f.frames.length < count; ++n) await Promise.resolve()
  expect(f.frames.length).toBe(count)
  return f.frames[count - 1]
}
afterEach(() => {
  for (const channel of channels.splice(0)) channel.invalidate()
  vi.useRealTimers()
})

describe('TUN dedicated runtime rules broker', () => {
  it('requires positive hello, bounds one flight and accepts a Native opaque SHA without recomputing it', async () => {
    const f = fixture(),
      pending = f.channel.read(signal(), () => {})
    await Promise.resolve()
    expect(f.frames).toEqual([])
    expect(f.channel.isBusy()).toBe(true)
    expect(await f.channel.read(signal(), () => {})).toEqual({ status: 'busy' })
    f.hello()
    expect(await frame(f, 1)).toEqual({ version: 1, id: 1, action: 'read', ...binding })
    f.response(1, 'snapshot', { snapshot: table() })
    expect(await pending).toEqual({ status: 'snapshot', snapshot: table() })
    expect(f.channel.isBusy()).toBe(false)
    const next = f.channel.read(signal(), () => {})
    await frame(f, 2)
    f.response(2, 'snapshot', { snapshot: table() })
    expect((await next).status).toBe('snapshot')
  })
  it.each([
    'capability',
    'launchClientSHA256',
    'installationRevision',
    'sessionId',
    'evidenceSHA256',
    'runtimeConfigurationSHA256'
  ])('rejects old or unbound hello %s without any rules request', async (field) => {
    const f = fixture()
    f.hello({ [field]: field === 'capability' ? 'runtime-capture-v1' : '0'.repeat(64) })
    expect(await f.channel.read(signal(), () => {})).toEqual({ status: 'unsupported' })
    expect(f.frames).toEqual([])
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('keeps the short nonce private and writes one guarded prepare then commit with distinct monotonic frame IDs', async () => {
    const f = fixture(),
      liveAtWrite: boolean[] = []
    let live = true
    f.requests.on('data', () => liveAtWrite.push(live))
    f.hello()
    const pending = f.channel.change(mutation, signal(), () => {
      if (!live) throw new Error('lost')
    })
    expect(await frame(f, 1)).toEqual({
      version: 1,
      id: 1,
      action: 'prepare',
      ...binding,
      ...mutation
    })
    f.prepared()
    expect(await frame(f, 2)).toEqual({ version: 1, id: 2, action: 'commit', ...binding, nonce })
    f.response(2, 'changed', { snapshot: table(true) })
    const result = await pending
    expect(result).toEqual({ status: 'changed', snapshot: table(true) })
    expect(JSON.stringify(result)).not.toContain(nonce)
    expect(liveAtWrite).toEqual([true, true])
    expect(f.frames.every((value) => Buffer.byteLength(JSON.stringify(value)) <= 8192)).toBe(true)
    live = false
  })
  it('returns an unchanged verified table without producing a commit', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.change(mutation, signal(), () => {})
    await frame(f, 1)
    f.response(1, 'unchanged', { snapshot: table(true) })
    expect(await pending).toEqual({ status: 'unchanged', snapshot: table(true) })
    expect(f.frames).toHaveLength(1)
  })
  it('cancels before hello with no pipe frame and no native slot to retire', async () => {
    const f = fixture(),
      abort = new AbortController(),
      pending = f.channel.read(abort.signal, () => {})
    abort.abort()
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(f.frames).toEqual([])
    expect(f.channel.isBusy()).toBe(false)
  })
  it('retains an aborted native flight as a tombstone until the original callback really settles', async () => {
    const f = fixture(),
      abort = new AbortController()
    f.hello()
    const pending = f.channel.change(mutation, abort.signal, () => {})
    await frame(f, 1)
    abort.abort()
    expect(await frame(f, 2)).toEqual({
      version: 1,
      id: 2,
      action: 'cancel',
      ...binding,
      operationId: 1
    })
    f.response(2, 'cancelling', { pending: true })
    let idle = false
    void f.channel.whenIdle().then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)
    expect(f.channel.isBusy()).toBe(true)
    expect(await f.channel.read(signal(), () => {})).toEqual({ status: 'busy' })
    f.response(1, 'cancelled')
    expect(await pending).toEqual({ status: 'cancelled' })
    await f.channel.whenIdle()
    expect(idle).toBe(true)
    expect(f.frames.some((value) => value.action === 'commit')).toBe(false)
  })
  it.each(['abort', 'eventless-frame'])(
    'revokes a queued prepared nonce before any commit on %s',
    async (kind) => {
      const f = fixture(),
        abort = new AbortController()
      let live = true
      f.hello()
      const pending = f.channel.change(mutation, abort.signal, () => {
        if (!live) throw new Error('lost')
      })
      await frame(f, 1)
      f.prepared()
      if (kind === 'abort') abort.abort()
      else live = false
      expect((await frame(f, 2)).action).toBe('cancel')
      f.response(2, 'cancelled')
      expect(await pending).toEqual({ status: 'cancelled' })
      expect(f.frames.map((value) => value.action)).toEqual(['prepare', 'cancel'])
    }
  )
  it('bounds a missing positive hello without sending an old client any rules request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const f = fixture(),
      pending = f.channel.read(signal(), () => {})
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toEqual({ status: 'unsupported' })
    expect(f.frames).toEqual([])
    expect(f.channel.isAvailable()).toBe(false)
  })
  it('closes only the rules capability when a read never returns by the original deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const f = fixture()
    f.hello()
    const pending = f.channel.read(signal(), () => {})
    await frame(f, 1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toEqual({ status: 'expired' })
    await f.channel.whenIdle()
    expect(f.frames).toHaveLength(1)
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('rechecks after a reentrant UI guard callback instead of writing a revoked commit', async () => {
    const f = fixture()
    let prepared = false,
      guards = 0
    f.hello()
    const pending = f.channel.change(mutation, signal(), () => {
      if (prepared && ++guards === 3) void f.channel.cancel()
    })
    await frame(f, 1)
    prepared = true
    f.prepared()
    expect((await frame(f, 2)).action).toBe('cancel')
    f.response(Number(f.frames[1].id), 'cancelled')
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(f.frames.some((value) => value.action === 'commit')).toBe(false)
  })
  it('treats EOF after a commit attempt as uncertain and never retries or touches other capability pipes', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.change(mutation, signal(), () => {})
    await frame(f, 1)
    f.prepared()
    await frame(f, 2)
    f.gone()
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.frames.map((value) => value.action)).toEqual(['prepare', 'commit'])
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('classifies a possibly partial commit write failure as uncertain without leaking the IO error', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.change(mutation, signal(), () => {})
    await frame(f, 1)
    const write = vi.spyOn(f.requests, 'write').mockImplementationOnce(() => {
      throw new Error('PRIVATE')
    })
    f.prepared()
    const result = await pending
    expect(result).toEqual({ status: 'uncertain' })
    expect(write).toHaveBeenCalledOnce()
    expect(f.close).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
  it('returns no writable candidate when EOF interrupts preparation', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.change(mutation, signal(), () => {})
    await frame(f, 1)
    f.gone()
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(f.frames.map((value) => value.action)).toEqual(['prepare'])
  })
  it('preserves the original total deadline across prepare, commit and cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const f = fixture(),
      abort = new AbortController()
    f.hello()
    const pending = f.channel.change(mutation, abort.signal, () => {})
    await frame(f, 1)
    await vi.advanceTimersByTimeAsync(1500)
    f.prepared()
    await frame(f, 2)
    abort.abort()
    await frame(f, 3)
    f.response(3, 'uncertain', { pending: true })
    await vi.advanceTimersByTimeAsync(1499)
    expect(f.channel.isBusy()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.channel.isBusy()).toBe(false)
    expect(f.channel.isAvailable()).toBe(false)
    expect(f.frames.map((value) => value.action)).toEqual(['prepare', 'commit', 'cancel'])
  })
  it('keeps commit cancellation busy until the original terminal reply and reports uncertainty', async () => {
    const f = fixture(),
      abort = new AbortController()
    f.hello()
    const pending = f.channel.change(mutation, abort.signal, () => {})
    await frame(f, 1)
    f.prepared()
    await frame(f, 2)
    abort.abort()
    await frame(f, 3)
    f.response(3, 'uncertain', { pending: true })
    expect(f.channel.isBusy()).toBe(true)
    f.response(2, 'uncertain')
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.channel.isBusy()).toBe(false)
  })
  it('never extends a shorter Native lease while waiting for commit readback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const f = fixture()
    f.hello()
    const pending = f.channel.change(mutation, signal(), () => {})
    await frame(f, 1)
    f.prepared(1, { leaseMilliseconds: 50 })
    await frame(f, 2)
    await vi.advanceTimersByTimeAsync(49)
    expect(f.channel.isBusy()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.frames.map((value) => value.action)).toEqual(['prepare', 'commit'])
  })
  it('rejects an already expired nonce without attempting a commit', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.change(mutation, signal(), () => {})
    await frame(f, 1)
    f.prepared(1, { leaseMilliseconds: 0 })
    expect(await pending).toEqual({ status: 'expired' })
    expect(f.frames.map((value) => value.action)).toEqual(['prepare'])
  })
  it('removes old abort callbacks so they cannot cancel a newer logical operation', async () => {
    const f = fixture(),
      old = new AbortController()
    f.hello()
    const first = f.channel.read(old.signal, () => {})
    await frame(f, 1)
    f.response(1, 'snapshot', { snapshot: table() })
    await first
    const second = f.channel.read(signal(), () => {})
    await frame(f, 2)
    old.abort()
    expect(f.frames).toHaveLength(2)
    f.response(2, 'snapshot', { snapshot: table() })
    expect((await second).status).toBe('snapshot')
  })
  it.each([
    { operationId: 19 },
    { configurationRevision: '0'.repeat(64) },
    { rulesSHA256: '0'.repeat(64) },
    { index: 1 },
    { disabled: false }
  ])('cancels mismatched prepared scope without committing it: %j', async (fields) => {
    const f = fixture()
    f.hello()
    const pending = f.channel.change(mutation, signal(), () => {})
    await frame(f, 1)
    f.prepared(1, fields)
    expect((await frame(f, 2)).action).toBe('cancel')
    f.response(2, 'cancelled')
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(f.frames.some((value) => value.action === 'commit')).toBe(false)
  })
  it('does not accept a changed acknowledgement whose actual target bit differs', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.change(mutation, signal(), () => {})
    await frame(f, 1)
    f.prepared()
    await frame(f, 2)
    f.response(2, 'changed', { snapshot: table(false) })
    expect((await frame(f, 3)).action).toBe('cancel')
    f.response(3, 'stale')
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.frames.filter((value) => value.action === 'commit')).toHaveLength(1)
  })
  it.each([
    null,
    undefined,
    { ...mutation, disabled: 1 },
    { ...mutation, index: -1 },
    { ...mutation, url: 'PRIVATE' }
  ])('rejects an invalid private mutation without falling back to a read: %j', async (value) => {
    const f = fixture()
    f.hello()
    expect(await f.channel.change(value as TunRulesMutation, signal(), () => {})).toEqual({
      status: 'unavailable'
    })
    expect(f.frames).toEqual([])
  })
  it('does not route a duplicate late ID into a newer flight', async () => {
    const f = fixture()
    f.hello()
    const first = f.channel.read(signal(), () => {})
    await frame(f, 1)
    f.response(1, 'snapshot', { snapshot: table() })
    await first
    const next = f.channel.read(signal(), () => {})
    await frame(f, 2)
    f.response(1, 'snapshot', { snapshot: table() })
    expect(await next).toEqual({ status: 'unavailable' })
    expect(f.channel.isAvailable()).toBe(false)
  })
  it('captures caller mutation fields before any asynchronous hello and ignores later object changes', async () => {
    const f = fixture(),
      input = { ...mutation },
      pending = f.channel.change(input, signal(), () => {})
    input.disabled = false
    input.index = 9
    f.hello()
    expect(await frame(f, 1)).toMatchObject(mutation)
    f.response(1, 'unchanged', { snapshot: table(true) })
    expect((await pending).status).toBe('unchanged')
  })
  it('accepts a full 10000-row response over8KiB without lifting the old control scanner default', async () => {
    const f = fixture(),
      value = {
        ...table(),
        rules: Array.from({ length: 10000 }, (_, index) => ({
          index,
          type: 'Domain',
          payload: 'fixture-' + index + '.invalid',
          proxy: 'REJECT',
          disabled: false
        }))
      }
    f.hello()
    const pending = f.channel.read(signal(), () => {})
    await frame(f, 1)
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        id: 1,
        action: 'read',
        ...binding,
        status: 'snapshot',
        pending: false,
        snapshot: value
      }) + '\n'
    )
    expect(bytes.length).toBeGreaterThan(8192)
    expect(() => parseTunHostFrame(bytes.subarray(0, -1))).toThrow()
    for (let offset = 0; offset < bytes.length; offset += 16384)
      f.replies.write(bytes.subarray(offset, offset + 16384))
    const result = await pending
    expect(result.status).toBe('snapshot')
    if (result.status === 'snapshot') expect(result.snapshot.rules).toHaveLength(10000)
  })
  it.each([
    'duplicate-key',
    'utf8',
    'wrong-action',
    'extra-field',
    'wrong-pending',
    'oversized',
    'bad-row',
    'row-budget',
    'eof',
    'fault'
  ])('fails only this rules capability on %s', async (failure) => {
    const f = fixture()
    f.hello()
    const pending = f.channel.read(signal(), () => {})
    await frame(f, 1)
    if (failure === 'duplicate-key')
      f.replies.write(Buffer.from('{"version":1,"vers\\u0069on":1}\n'))
    else if (failure === 'utf8') f.replies.write(Buffer.from([0xff, 10]))
    else if (failure === 'oversized') f.replies.write(Buffer.alloc(2 * 1024 * 1024 + 8193, 32))
    else if (failure === 'wrong-action')
      f.response(1, 'snapshot', { action: 'commit', snapshot: table() })
    else if (failure === 'extra-field')
      f.response(1, 'snapshot', { snapshot: table(), token: 'PRIVATE' })
    else if (failure === 'wrong-pending')
      f.response(1, 'snapshot', { snapshot: table(), pending: true })
    else if (failure === 'bad-row')
      f.response(1, 'snapshot', {
        snapshot: { ...table(), rules: [{ ...table().rules[0], disabled: null }] }
      })
    else if (failure === 'row-budget')
      f.response(1, 'snapshot', {
        snapshot: {
          ...table(),
          rules: Array.from({ length: 10001 }, (_, index) => ({
            index,
            type: 'Match',
            payload: '',
            proxy: 'REJECT'
          }))
        }
      })
    else if (failure === 'fault') f.replies.emit('error', new Error('PRIVATE'))
    else f.gone()
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.frames).toHaveLength(1)
  })
  it('keeps the reusable strict scanner limit finite, bounded, and strict on duplicate decoded keys', () => {
    const bytes = Buffer.from('{"payload":"' + 'x'.repeat(9000) + '"}')
    expect(() => parseTunHostFrame(bytes)).toThrow()
    expect(parseTunHostFrame(bytes, 10000)).toEqual({ payload: 'x'.repeat(9000) })
    for (const limit of [0, -1, 1.5, Infinity, NaN, 2 * 1024 * 1024 + 8193])
      expect(() => parseTunHostFrame(bytes, limit)).toThrow()
    expect(() => parseTunHostFrame(Buffer.from('{"id":1,"\\u0069d":2}'), 10000)).toThrow()
  })
})
