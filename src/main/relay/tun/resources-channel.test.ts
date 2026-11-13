import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTunResourcesChannel,
  type TunResourcesChannel,
  type TunResourcesMutation
} from './resources-channel'

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
  blobId = '22222222-2222-4222-8222-222222222222',
  revision = 'e'.repeat(64),
  digest = 'f'.repeat(64),
  newSHA256 = '1'.repeat(64),
  mutation: TunResourcesMutation = {
    configurationRevision: revision,
    expectedGenerationSHA256: digest,
    kind: 'geosite-dat',
    oldSHA256: '2'.repeat(64),
    newSHA256,
    blobId,
    selector: 'CN',
    bytes: 42
  },
  signal = () => new AbortController().signal,
  channels: TunResourcesChannel[] = []
function table(updated = false) {
  return {
    configurationRevision: revision,
    generationSHA256: updated ? '3'.repeat(64) : digest,
    resources: [
      {
        kind: 'geosite-dat',
        sha256: updated ? newSHA256 : mutation.oldSHA256,
        bytes: 42,
        active: true
      }
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
    channel = createTunResourcesChannel(
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
      send({
        version: 1,
        kind: 'hello',
        capability: 'runtime-resources-v1',
        ...identity,
        ...changes
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

describe('TUN dedicated runtime resources broker', () => {
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
  it('requires a positively bound hello and holds one logical operation until its terminal reply', async () => {
    const f = fixture(),
      pending = f.channel.read(signal(), () => {})
    expect(f.frames).toEqual([])
    expect(await f.channel.read(signal(), () => {})).toEqual({ status: 'busy' })
    f.hello()
    expect(await frame(f, 1)).toEqual({ version: 1, id: 1, action: 'read', ...binding })
    f.response(1, 'snapshot', { snapshot: table() })
    expect(await pending).toEqual({ status: 'snapshot', snapshot: table() })
    expect(f.channel.isBusy()).toBe(false)
  })
  it.each([
    'capability',
    'launchClientSHA256',
    'installationRevision',
    'sessionId',
    'evidenceSHA256',
    'runtimeConfigurationSHA256'
  ])('rejects a mismatched hello %s without writing', async (field) => {
    const f = fixture()
    f.hello({ [field]: field === 'capability' ? 'runtime-rules-v1' : '0'.repeat(64) })
    expect(await f.channel.read(signal(), () => {})).toEqual({ status: 'unsupported' })
    expect(f.frames).toHaveLength(0)
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('submits one complete replace and never exposes or accepts a Core prepare nonce', async () => {
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
    expect(f.frames).toHaveLength(1)
  })
  it('accepts unchanged only for the exact selected SHA and unchanged opaque generation', async () => {
    const f = fixture()
    f.hello()
    const selected = { ...mutation, newSHA256: mutation.oldSHA256 },
      pending = f.channel.replace(selected, signal(), () => {})
    await frame(f, 1)
    f.response(1, 'unchanged', { snapshot: table() })
    expect(await pending).toEqual({ status: 'unchanged', snapshot: table() })
  })
  it('rechecks cancellation after a synchronous context callback before writing any bytes', async () => {
    const f = fixture(),
      abort = new AbortController()
    f.hello()
    const pending = f.channel.replace(mutation, abort.signal, () => abort.abort())
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(f.frames).toHaveLength(0)
    expect(f.channel.isAvailable()).toBe(true)
  })
  it('does not free busy after a cancel ACK while the original Native replacement is still running', async () => {
    const f = fixture(),
      abort = new AbortController()
    f.hello()
    const pending = f.channel.replace(mutation, abort.signal, () => {})
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
    const drained = f.channel.whenIdle().then(() => (idle = true))
    await Promise.resolve()
    expect(idle).toBe(false)
    expect(await f.channel.read(signal(), () => {})).toEqual({ status: 'busy' })
    f.response(1, 'cancelled')
    expect(await pending).toEqual({ status: 'cancelled' })
    await drained
    expect(idle).toBe(true)
  })
  it('withholds a late successful replacement after UI cancellation and drains both replies', async () => {
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
  it('treats partial-write failure and a broken post-write pipe as uncertain without touching lifecycle IO', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.replace(mutation, signal(), () => {})
    await frame(f, 1)
    f.gone()
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.close).toHaveBeenCalledOnce()
    expect(
      await f.channel.discardBlob({
        blobId,
        kind: 'geosite-dat',
        sha256: newSHA256,
        bytes: 42,
        selector: 'CN'
      })
    ).toBe('unavailable')
  })
  it('retains a 30 second operation window instead of applying the old 3 second rules timeout', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.hello()
    const pending = f.channel.replace(mutation, signal(), () => {})
    await frame(f, 1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(f.channel.isBusy()).toBe(true)
    expect(f.close).not.toHaveBeenCalled()
    f.response(1, 'updated', { snapshot: table(true) })
    expect((await pending).status).toBe('updated')
  })
  it('closes only the resource capability on a deadline and cannot reuse the unknown result', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.hello()
    const pending = f.channel.replace(mutation, signal(), () => {})
    await frame(f, 1)
    await vi.advanceTimersByTimeAsync(30000)
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.channel.isAvailable()).toBe(false)
  })
  it.each([
    { configurationRevision: 'a'.repeat(64) },
    { generationSHA256: digest },
    { resources: [{ kind: 'geosite-dat', sha256: mutation.oldSHA256, bytes: 42, active: true }] },
    { resources: [{ kind: 'geosite-dat', sha256: newSHA256, bytes: 43, active: true }] },
    { resources: [{ kind: 'geosite-dat', sha256: newSHA256, bytes: 42, active: false }] }
  ])('withholds a mismatched applied snapshot %#', async (changes) => {
    const f = fixture()
    f.hello()
    const pending = f.channel.replace(mutation, signal(), () => {})
    await frame(f, 1)
    f.response(1, 'updated', { snapshot: { ...table(true), ...changes } })
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.close).toHaveBeenCalledOnce()
  })
  it.each([
    { resources: [...table().resources, ...table().resources] },
    { resources: [{ ...table().resources[0], path: '/private/file' }] },
    { resources: [{ ...table().resources[0], bytes: 0 }] },
    { resources: [{ ...table().resources[0], kind: 'rule-mrs' }] },
    { resources: [{ ...table().resources[0], sha256: 'A'.repeat(64) }] }
  ])('rejects malformed Native rows and drops the resource capability %#', async (changes) => {
    const f = fixture()
    f.hello()
    const pending = f.channel.read(signal(), () => {})
    await frame(f, 1)
    f.response(1, 'snapshot', { snapshot: { ...table(), ...changes } })
    expect((await pending).status).toBe('unavailable')
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('rejects a duplicate JSON key through the existing wire parser', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.read(signal(), () => {})
    await frame(f, 1)
    f.replies.write(
      Buffer.from(
        JSON.stringify({
          version: 1,
          id: 1,
          action: 'read',
          ...binding,
          status: 'snapshot',
          pending: false,
          snapshot: table()
        }).replace('"id":1', '"id":1,"id":1') + '\n'
      )
    )
    expect((await pending).status).toBe('unavailable')
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('uses a neutral exact blob ticket for cleanup and forgets nothing without a positive receipt', async () => {
    const f = fixture()
    f.hello()
    const ticket = {
        blobId,
        kind: 'geosite-dat' as const,
        sha256: newSHA256,
        bytes: 42,
        selector: 'CN'
      },
      pending = f.channel.discardBlob(ticket)
    expect(await frame(f, 1)).toEqual({
      version: 1,
      id: 1,
      action: 'discardBlob',
      ...binding,
      ...ticket
    })
    f.response(1, 'discarded')
    expect(await pending).toBe('discarded')
    const again = f.channel.discardBlob(ticket)
    await frame(f, 2)
    f.response(2, 'absent')
    expect(await again).toBe('absent')
  })
  it('rejects an arbitrary cleanup path, invalid UTF-8 selector budget and caller nonce before writing', async () => {
    const f = fixture()
    f.hello()
    expect(
      await f.channel.discardBlob(
        Object.assign(
          { blobId, kind: 'geosite-dat' as const, sha256: newSHA256, bytes: 42, selector: 'CN' },
          { path: '/tmp/arbitrary' }
        )
      )
    ).toBe('unavailable')
    expect(
      await f.channel.replace({ ...mutation, selector: '中'.repeat(86) }, signal(), () => {})
    ).toEqual({ status: 'unavailable' })
    expect(
      await f.channel.replace({ ...mutation, selector: '\ud800' }, signal(), () => {})
    ).toEqual({ status: 'unavailable' })
    expect(
      await f.channel.replace(
        Object.assign({ ...mutation }, { nonce: 'PRIVATE' }),
        signal(),
        () => {}
      )
    ).toEqual({ status: 'unavailable' })
    expect(f.frames).toHaveLength(0)
  })
})
