import { afterEach, describe, expect, it, vi } from 'vitest'
import { smartStateDigest, type SmartStateSeedV1 } from '../core/smart-state-schema'
import { createTunSmartStateChannel } from './smart-state-channel'

const identity = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  evidenceSHA256: 'a'.repeat(64),
  runtimeConfigurationSHA256: 'b'.repeat(64),
  launchClientSHA256: 'c'.repeat(64),
  installationRevision: 'd'.repeat(64)
}
const binding = {
  sessionId: identity.sessionId,
  evidenceSHA256: identity.evidenceSHA256,
  runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256
}
const executionSHA256 = 'e'.repeat(64),
  revision = 'f'.repeat(64)
const seed: SmartStateSeedV1 = {
  version: 1,
  key: '1'.repeat(64),
  previousRevision: null,
  files: [{ path: 'cache.db', sha256: smartStateDigest(Buffer.alloc(0)), size: 0 }]
}
const snapshot = { ...seed, executionSHA256, resultSHA256: '2'.repeat(64) }
const channels: ReturnType<typeof createTunSmartStateChannel>[] = []
const signal = () => new AbortController().signal
function fixture() {
  let receive: (bytes: Buffer) => void = () => {},
    gone: () => void = () => {}
  const frames: Record<string, unknown>[] = [],
    close = vi.fn()
  const channel = createTunSmartStateChannel(
    {
      write: (raw) => {
        frames.push(JSON.parse(raw))
      },
      onData: (cb) => {
        receive = cb
      },
      onGone: (cb) => {
        gone = cb
      },
      onFault: () => {},
      close
    },
    identity,
    executionSHA256,
    seed,
    false,
    100
  )
  channels.push(channel)
  const send = (raw: unknown) => receive(Buffer.from(JSON.stringify(raw) + '\n'))
  return {
    channel,
    frames,
    close,
    gone: () => gone(),
    send,
    hello: (changes = {}) =>
      send({ version: 1, kind: 'hello', capability: 'smart-state-v1', ...identity, ...changes }),
    reply: (status: string, current: unknown = snapshot) => {
      const last = frames.at(-1)!
      send({
        version: 1,
        id: last.id,
        action: last.action,
        ...binding,
        status,
        pending: false,
        snapshot: current
      })
    }
  }
}
async function request(f: ReturnType<typeof fixture>, count = 1) {
  for (let n = 0; n < 20 && f.frames.length < count; n++) await Promise.resolve()
  expect(f.frames).toHaveLength(count)
  return f.frames[count - 1]
}
afterEach(() => {
  for (const channel of channels.splice(0)) channel.invalidate()
  vi.useRealTimers()
})

describe('Smart state separate bound handoff channel', () => {
  it('exports then acknowledges a committed revision and returns cleanup proof', async () => {
    const f = fixture()
    f.hello()
    const exported = f.channel.export(signal(), () => {})
    expect((await request(f)).action).toBe('export')
    f.reply('exported')
    expect(await exported).toEqual({ status: 'snapshot', snapshot })
    const acknowledged = f.channel.acknowledge(revision, signal(), () => {})
    const frame = await request(f, 2)
    expect(frame).toMatchObject({
      action: 'ack',
      executionSHA256,
      key: seed.key,
      resultSHA256: snapshot.resultSHA256,
      committedRevision: revision
    })
    const ack = { ...snapshot, committedRevision: revision, cleanupNonce: '3'.repeat(64) }
    f.reply('acknowledged', ack)
    expect(await acknowledged).toEqual({ status: 'updated', snapshot: ack })
    expect(f.close).not.toHaveBeenCalled()
  })
  it('does not send ACK before export or for an invalid commit hash', async () => {
    const f = fixture()
    f.hello()
    expect(await f.channel.acknowledge(revision, signal(), () => {})).toEqual({
      status: 'unavailable'
    })
    expect(f.frames).toHaveLength(0)
    const exported = f.channel.export(signal(), () => {})
    await request(f)
    f.reply('exported')
    await exported
    expect(await f.channel.acknowledge('invalid', signal(), () => {})).toEqual({
      status: 'unavailable'
    })
    expect(f.frames).toHaveLength(1)
  })
  it.each([
    { executionSHA256: '0'.repeat(64) },
    { key: '0'.repeat(64) },
    { previousRevision: '0'.repeat(64) },
    { version: 2 },
    { extra: true },
    { files: [] },
    { files: [{ ...seed.files[0], path: '../cache.db' }] },
    { files: [{ ...seed.files[0], size: 134217729 }] },
    { cleanupNonce: '3'.repeat(64) },
    { resultSHA256: 'bad' }
  ])('rejects mismatched or widened export %j', async (patch) => {
    const f = fixture()
    f.hello()
    const pending = f.channel.export(signal(), () => {})
    await request(f)
    f.reply('exported', { ...snapshot, ...patch })
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(f.close).toHaveBeenCalledTimes(1)
  })
  it.each(['snapshot', 'updated', 'unchanged', 'acknowledged'])(
    'rejects wrong export status %s',
    async (status) => {
      const f = fixture()
      f.hello()
      const pending = f.channel.export(signal(), () => {})
      await request(f)
      f.reply(status)
      expect(await pending).toEqual({ status: 'unavailable' })
    }
  )
  it.each([
    { committedRevision: '0'.repeat(64) },
    { cleanupNonce: 'bad' },
    { cleanupNonce: undefined },
    { files: [{ ...seed.files[0], sha256: '4'.repeat(64), size: 1 }] },
    { resultSHA256: '0'.repeat(64) }
  ])('retains evidence after unconfirmed ACK %j', async (patch) => {
    const f = fixture()
    f.hello()
    const exported = f.channel.export(signal(), () => {})
    await request(f)
    f.reply('exported')
    await exported
    const pending = f.channel.acknowledge(revision, signal(), () => {})
    await request(f, 2)
    f.reply('acknowledged', {
      ...snapshot,
      committedRevision: revision,
      cleanupNonce: '3'.repeat(64),
      ...patch
    })
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(f.close).toHaveBeenCalledTimes(1)
  })
  it('loses only the state lane on EOF after export', async () => {
    const f = fixture()
    f.hello()
    const pending = f.channel.export(signal(), () => {})
    await request(f)
    f.gone()
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(f.close).toHaveBeenCalledTimes(1)
  })
})
