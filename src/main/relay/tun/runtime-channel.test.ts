import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTunRuntimeReader } from './runtime-channel'

const identity = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  evidenceSHA256: 'a'.repeat(64),
  runtimeConfigurationSHA256: 'b'.repeat(64),
  launchClientSHA256: 'c'.repeat(64),
  installationRevision: 'd'.repeat(64)
}
function fixture(telemetry = false) {
  let data = (_bytes: Buffer): void => {},
    gone = (): void => {},
    fault = (): void => {}
  const write = vi.fn(),
    reader = createTunRuntimeReader(
      {
        write,
        onData: (value) => {
          data = value
        },
        onGone: (value) => {
          gone = value
        },
        onFault: (value) => {
          fault = value
        }
      },
      identity,
      3000,
      telemetry ? 'runtime-telemetry-v2' : 'runtime-capture-v1'
    ),
    send = (raw: unknown) => data(Buffer.from(JSON.stringify(raw) + '\n')),
    hello = (changes = {}) =>
      send({
        version: telemetry ? 2 : 1,
        kind: 'hello',
        capability: telemetry ? 'runtime-telemetry-v2' : 'runtime-capture-v1',
        ...identity,
        ...changes
      }),
    reply = (id = 1, changes = {}) =>
      send({
        version: telemetry ? 2 : 1,
        id,
        action: 'capture',
        sessionId: identity.sessionId,
        evidenceSHA256: identity.evidenceSHA256,
        runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256,
        status: 'captured',
        snapshot: {
          originalLoadedSHA256: identity.runtimeConfigurationSHA256,
          originalLoadedBytes: 100,
          mode: 'rule',
          ports: [
            { kind: 'http', port: 18290, ownership: 'held-child-pcb-v1' },
            { kind: 'mixed', port: 18291, ownership: 'held-child-pcb-v1' }
          ]
        },
        ...changes
      })
  return {
    reader,
    write,
    data: (bytes: Buffer) => data(bytes),
    hello,
    reply,
    send,
    gone: () => gone(),
    fault: () => fault()
  }
}
afterEach(() => vi.useRealTimers())
describe('TUN dedicated runtime capture channel', () => {
  it('sends nothing before a positive hello and accepts only fixed metadata with increasing IDs', async () => {
    const f = fixture(),
      signal = new AbortController().signal
    const pending = f.reader.capture(signal)
    await Promise.resolve()
    expect(f.write).not.toHaveBeenCalled()
    f.hello()
    await Promise.resolve()
    expect(JSON.parse(f.write.mock.calls[0][0])).toEqual({
      version: 1,
      id: 1,
      action: 'capture',
      sessionId: identity.sessionId,
      evidenceSHA256: identity.evidenceSHA256,
      runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256
    })
    expect(await f.reader.capture(signal)).toEqual({ status: 'busy' })
    f.reply()
    expect(await pending).toMatchObject({
      status: 'captured',
      snapshot: { ports: [{ port: 18290 }, { port: 18291 }] }
    })
    const next = f.reader.capture(signal)
    await Promise.resolve()
    f.reply(2)
    expect((await next).status).toBe('captured')
  })
  it.each(['launchClientSHA256', 'installationRevision', 'sessionId'] as const)(
    'rejects an unbound hello %s without a request',
    async (field) => {
      const f = fixture()
      f.hello({ [field]: 'f'.repeat(64) })
      expect(await f.reader.capture(new AbortController().signal)).toEqual({
        status: 'unsupported'
      })
      expect(f.write).not.toHaveBeenCalled()
    }
  )
  it('bounds missing hello and response timeouts entirely inside the read channel', async () => {
    vi.useFakeTimers()
    const old = fixture(),
      pending = old.reader.capture(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toEqual({ status: 'unsupported' })
    expect(old.write).not.toHaveBeenCalled()
    const f = fixture()
    f.hello()
    const read = f.reader.capture(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await read).toEqual({ status: 'unavailable' })
    expect(f.reader.isAvailable()).toBe(false)
  })
  it('retires a cancelled ID and ignores its valid late reply without consuming the next request', async () => {
    const f = fixture(),
      abort = new AbortController()
    f.hello()
    const first = f.reader.capture(abort.signal)
    await Promise.resolve()
    abort.abort()
    expect(await first).toEqual({ status: 'unavailable' })
    expect(await f.reader.capture(new AbortController().signal)).toEqual({ status: 'busy' })
    expect(f.write).toHaveBeenCalledOnce()
    f.reply(1)
    expect(f.reader.isAvailable()).toBe(true)
    const second = f.reader.capture(new AbortController().signal)
    await Promise.resolve()
    f.reply(2)
    expect((await second).status).toBe('captured')
  })
  it('bounds a cancelled native flight with no late response instead of remaining busy forever', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      abort = new AbortController()
    f.hello()
    const pending = f.reader.capture(abort.signal)
    await Promise.resolve()
    abort.abort()
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(await f.reader.capture(new AbortController().signal)).toEqual({ status: 'busy' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.reader.isAvailable()).toBe(false)
    expect(await f.reader.capture(new AbortController().signal)).toEqual({ status: 'unsupported' })
    expect(f.write).toHaveBeenCalledOnce()
  })
  it.each(['duplicate-json', 'wrong-sha', 'extra-body', 'wrong-order', 'eof', 'fault'])(
    'fails closed on %s without any lifecycle command',
    async (failure) => {
      const f = fixture()
      f.hello()
      const pending = f.reader.capture(new AbortController().signal)
      await Promise.resolve()
      if (failure === 'eof') f.gone()
      else if (failure === 'fault') f.fault()
      else if (failure === 'duplicate-json') f.data(Buffer.from('{"version":1,"version":1}\n'))
      else if (failure === 'extra-body') f.reply(1, { body: 'PRIVATE' })
      else
        f.reply(1, {
          snapshot: {
            originalLoadedSHA256:
              failure === 'wrong-sha' ? 'e'.repeat(64) : identity.runtimeConfigurationSHA256,
            originalLoadedBytes: 100,
            mode: 'rule',
            ports: [
              { kind: 'mixed', port: 18291, ownership: 'held-child-pcb-v1' },
              { kind: 'http', port: 18290, ownership: 'held-child-pcb-v1' }
            ]
          }
        })
      expect(await pending).toEqual({ status: 'unavailable' })
      expect(f.reader.isAvailable()).toBe(false)
      expect(f.write).toHaveBeenCalledOnce()
      expect(JSON.parse(f.write.mock.calls[0][0]).action).toBe('capture')
    }
  )
})

describe('TUN positively versioned fixed traffic read', () => {
  const raw = '{"up":1,"down":2,"upTotal":3,"downTotal":4}\n'
  const reply = (f: ReturnType<typeof fixture>, changes = {}, id = 1): void =>
    f.send({
      version: 2,
      id,
      action: 'traffic',
      sessionId: identity.sessionId,
      evidenceSHA256: identity.evidenceSHA256,
      runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256,
      status: 'sampled',
      rawFrameBase64: Buffer.from(raw).toString('base64'),
      ...changes
    })
  it('keeps v1 capture-only and requires the explicit matching v2 hello', async () => {
    const old = fixture()
    old.hello()
    expect(await old.reader.traffic?.(new AbortController().signal)).toEqual({
      status: 'unsupported'
    })
    expect(old.write).not.toHaveBeenCalled()
    const f = fixture(true)
    f.hello({ capability: 'runtime-capture-v1' })
    expect(await f.reader.traffic?.(new AbortController().signal)).toEqual({
      status: 'unsupported'
    })
    expect(f.write).not.toHaveBeenCalled()
  })
  it('serializes v2 capture and traffic on the same owned lane without endpoint selectors', async () => {
    const f = fixture(true),
      signal = new AbortController().signal
    f.hello()
    const capture = f.reader.capture(signal)
    await Promise.resolve()
    expect(await f.reader.traffic?.(signal)).toEqual({ status: 'busy' })
    f.reply()
    expect((await capture).status).toBe('captured')
    const traffic = f.reader.traffic?.(signal)
    await Promise.resolve()
    expect(JSON.parse(f.write.mock.calls[1][0])).toEqual({
      version: 2,
      id: 2,
      action: 'traffic',
      sessionId: identity.sessionId,
      evidenceSHA256: identity.evidenceSHA256,
      runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256
    })
    expect(await f.reader.capture(signal)).toEqual({ status: 'busy' })
    reply(f, {}, 2)
    expect(await traffic).toEqual({
      status: 'sampled',
      frame: { up: 1, down: 2, upTotal: 3, downTotal: 4 }
    })
  })
  it.each([
    '',
    raw.trimEnd(),
    raw + raw,
    raw.replace('"up":1', '"up":-1'),
    raw.replace('"up":1', '"up":1.5'),
    raw.replace('"up":1', '"up":9007199254740992'),
    raw.replace('"up":1', '"up":1,"up":2'),
    raw.replace('"up":1', '"u' + String.fromCharCode(92) + 'u0070":1,"up":2'),
    raw.replace('"up":1', '"up":true'),
    raw.replace('"up":1', '"other":1'),
    ' '.repeat(4096) + raw
  ])('rejects malformed or unsafe original frame %j without control operations', async (bytes) => {
    const f = fixture(true)
    f.hello()
    const pending = f.reader.traffic?.(new AbortController().signal)
    await Promise.resolve()
    reply(f, { rawFrameBase64: Buffer.from(bytes).toString('base64') })
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(f.reader.isAvailable()).toBe(false)
    expect(f.write).toHaveBeenCalledOnce()
  })
  it.each(['bad-base64', 'duplicate-LF', 'wrong-action', 'extra-field'])(
    'rejects a malformed reply %s',
    async (kind) => {
      const f = fixture(true)
      f.hello()
      const pending = f.reader.traffic?.(new AbortController().signal)
      await Promise.resolve()
      reply(
        f,
        kind === 'bad-base64'
          ? { rawFrameBase64: Buffer.from(raw).toString('base64') + ' ' }
          : kind === 'duplicate-LF'
            ? { rawFrameBase64: Buffer.from(raw + '\n').toString('base64') }
            : kind === 'wrong-action'
              ? { action: 'capture' }
              : { endpoint: '/traffic' }
      )
      expect(await pending).toEqual({ status: 'unavailable' })
    }
  )
  it('retires cancelled traffic until its matching native reply drains', async () => {
    const f = fixture(true),
      abort = new AbortController()
    f.hello()
    const pending = f.reader.traffic?.(abort.signal)
    await Promise.resolve()
    abort.abort()
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(await f.reader.capture(new AbortController().signal)).toEqual({ status: 'busy' })
    reply(f)
    expect(f.reader.isAvailable()).toBe(true)
    const next = f.reader.capture(new AbortController().signal)
    await Promise.resolve()
    f.reply(2)
    expect((await next).status).toBe('captured')
  })
  it.each([false, true])(
    'checks original wall deadline on active/retired reply despite a delayed timer (%s)',
    async (retired) => {
      vi.useFakeTimers()
      vi.setSystemTime(1000)
      const f = fixture(true),
        abort = new AbortController()
      f.hello()
      const pending = f.reader.traffic?.(abort.signal)
      await Promise.resolve()
      if (retired) abort.abort()
      vi.setSystemTime(4000)
      reply(f)
      expect(await pending).toEqual({ status: 'unavailable' })
      expect(f.reader.isAvailable()).toBe(false)
    }
  )
})

it('rejects a backwards monotonic clock before accepting a traffic receipt', async () => {
  let mono = 1000
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => mono)
  const f = fixture(true)
  try {
    f.hello()
    const pending = f.reader.traffic?.(new AbortController().signal)
    await Promise.resolve()
    mono = 999
    f.send({
      version: 2,
      id: 1,
      action: 'traffic',
      sessionId: identity.sessionId,
      evidenceSHA256: identity.evidenceSHA256,
      runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256,
      status: 'sampled',
      rawFrameBase64: Buffer.from('{"up":1,"down":2,"upTotal":3,"downTotal":4}\n').toString(
        'base64'
      )
    })
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(f.reader.isAvailable()).toBe(false)
  } finally {
    f.gone()
    clock.mockRestore()
  }
})

it('keeps v2 capture and later traffic available after a single no-payload revoked read', async () => {
  const f = fixture(true)
  f.hello()
  const first = f.reader.traffic?.(new AbortController().signal)
  await Promise.resolve()
  f.send({
    version: 2,
    id: 1,
    action: 'traffic',
    sessionId: identity.sessionId,
    evidenceSHA256: identity.evidenceSHA256,
    runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256,
    status: 'unavailable'
  })
  expect(await first).toEqual({ status: 'unavailable' })
  expect(f.reader.isAvailable()).toBe(true)
  const capture = f.reader.capture(new AbortController().signal)
  await Promise.resolve()
  f.reply(2)
  expect((await capture).status).toBe('captured')
  const next = f.reader.traffic?.(new AbortController().signal)
  await Promise.resolve()
  f.send({
    version: 2,
    id: 3,
    action: 'traffic',
    sessionId: identity.sessionId,
    evidenceSHA256: identity.evidenceSHA256,
    runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256,
    status: 'sampled',
    rawFrameBase64: Buffer.from('{"up":1,"down":2,"upTotal":3,"downTotal":4}\n').toString('base64')
  })
  expect(await next).toEqual({
    status: 'sampled',
    frame: { up: 1, down: 2, upTotal: 3, downTotal: 4 }
  })
  f.gone()
})
