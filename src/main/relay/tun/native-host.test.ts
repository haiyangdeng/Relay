import { describe, expect, it, vi, afterEach } from 'vitest'
import { createTunHostChannel } from './native-host'
import type { TunHostObservation } from './service'

const binding = {
  sessionId: '12345678-1234-1234-1234-123456789abc',
  evidenceSHA256: 'a'.repeat(64),
  runtimeConfigurationSHA256: 'b'.repeat(64)
}
function observation(phase: TunHostObservation['phase'] = 'idle'): TunHostObservation {
  const states: Record<
    TunHostObservation['phase'],
    [TunHostObservation['core'], TunHostObservation['device'], TunHostObservation['network']]
  > = {
    idle: ['none', 'none', 'unchanged'],
    acquired: ['none', 'held', 'unchanged'],
    coreReady: ['running', 'held', 'unchanged'],
    active: ['running', 'held', 'active'],
    coreStopped: ['stopped', 'held', 'active'],
    released: ['stopped', 'released', 'restored'],
    restored: ['stopped', 'absent', 'restored'],
    unknown: ['unknown', 'unknown', 'unknown']
  }
  const [core, device, network] = states[phase]
  return { version: 1, ...binding, phase, core, device, network }
}
function fixture(
  notifyFailure = false,
  execution?: 'core-managed',
  proof?: () => string | undefined,
  supportsWorkDirectory = false
) {
  let data: (bytes: Buffer) => void = () => {},
    gone = () => {},
    fault = () => {}
  const write = vi.fn(),
    end = vi.fn(),
    uncertain = vi.fn(() => {
      if (notifyFailure) throw new Error('PRIVATE UI failure')
    }),
    channel = createTunHostChannel(
      {
        write,
        end,
        onData: (callback) => {
          data = callback
        },
        onGone: (callback) => {
          gone = callback
        },
        onFault: (callback) => {
          fault = callback
        }
      },
      binding,
      uncertain,
      1000,
      execution,
      proof,
      supportsWorkDirectory
    )
  function reply(id: number, action: string, phase?: TunHostObservation['phase']) {
    return {
      version: 1,
      id,
      action,
      ...(action === 'revokeActivation' || action === 'dispose'
        ? {
            ...binding,
            [action === 'dispose' ? 'closed' : 'revoked']: true,
            ...(action === 'dispose' && proof
              ? { stateDisposition: proof() ? 'removed' : 'retained-evidence' }
              : {})
          }
        : { observation: observation(phase) })
    }
  }
  const send = (value: unknown) => data(Buffer.from(JSON.stringify(value) + '\n'))
  const ready = async () => {
    send(reply(1, 'initialize'))
    await channel.ready
  }
  return {
    channel,
    write,
    end,
    uncertain,
    reply,
    send,
    data: (b: Buffer) => data(b),
    gone: () => gone(),
    fault: () => fault(),
    ready
  }
}
afterEach(() => vi.useRealTimers())

describe('TUN main-only persistent native control channel', () => {
  it('binds an optional work directory reply and preserves a normal denial', async () => {
    const old = fixture(false, 'core-managed')
    await old.ready()
    expect(old.channel.inspectWorkDirectory).toBeUndefined()
    expect(old.write).toHaveBeenCalledTimes(1)

    const f = fixture(false, 'core-managed', undefined, true)
    await f.ready()
    const inspect = f.channel.inspectWorkDirectory
    if (!inspect) throw new Error('fixture work directory capability missing')
    const request = { version: 1, id: 2, action: 'inspectWorkDirectory', ...binding }
    const read = inspect()
    expect(JSON.parse(f.write.mock.calls[1][0])).toEqual(request)
    f.send({ ...request, workDirectory: null })
    await expect(read).resolves.toBeNull()
    const proven = inspect()
    const workDirectory = { path: '/private/tmp/relay-session-501-fiXtUr', device: '3', inode: '9' }
    f.send({ ...request, id: 3, workDirectory })
    await expect(proven).resolves.toEqual(workDirectory)
    expect(f.uncertain).not.toHaveBeenCalled()
    const forged = inspect()
    f.send({ ...request, id: 4, runtimeConfigurationSHA256: 'c'.repeat(64), workDirectory })
    await expect(forged).rejects.toThrow('未确认')
    expect(f.uncertain).not.toHaveBeenCalled()
  })

  it('continues restoration and disposal when the optional directory reply never arrives', async () => {
    vi.useFakeTimers()
    const f = fixture(false, 'core-managed', undefined, true)
    await f.ready()
    const inspect = f.channel.inspectWorkDirectory
    if (!inspect) throw new Error('fixture work directory capability missing')
    const read = expect(inspect()).rejects.toThrow('未确认')
    const stop = f.channel.stopCore()
    f.send(f.reply(3, 'stopCore', 'coreStopped'))
    await stop
    await vi.advanceTimersByTimeAsync(1000)
    await read
    const release = f.channel.release()
    f.send(f.reply(4, 'release', 'released'))
    await release
    const restored = f.channel.verifyRestored()
    f.send(f.reply(5, 'verifyRestored', 'restored'))
    await restored
    const disposed = f.channel.dispose()
    f.send(f.reply(6, 'dispose'))
    f.gone()
    await disposed
    expect(f.uncertain).not.toHaveBeenCalled()
  })
  it.each([undefined, 'retained-evidence', 'unknown', 5])(
    'keeps state disposition separate from verified lifecycle closure (%s)',
    async (disposition) => {
      const f = fixture(false, 'core-managed', () => 'c'.repeat(64))
      await f.ready()
      const verification = f.channel.verifyRestored()
      f.send(f.reply(2, 'verifyRestored', 'restored'))
      await verification
      const disposed = f.channel.dispose(),
        response = f.reply(3, 'dispose') as Record<string, unknown>
      if (disposition === undefined) delete response.stateDisposition
      else response.stateDisposition = disposition
      f.send(response)
      f.gone()
      await disposed
      expect(f.channel.smartStateDisposition()).toBe(
        disposition === 'retained-evidence' ? disposition : undefined
      )
      expect(f.uncertain).not.toHaveBeenCalled()
    }
  )
  it.each([undefined, 'c'.repeat(64)])(
    'adds cleanup proof only to the final dispose (%s)',
    async (nonce) => {
      const f = fixture(false, 'core-managed', () => nonce)
      await f.ready()
      const verification = f.channel.verifyRestored()
      f.send(f.reply(2, 'verifyRestored', 'restored'))
      await verification
      expect(f.write.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
        { version: 1, id: 1, action: 'initialize', ...binding },
        { version: 1, id: 2, action: 'verifyRestored', ...binding }
      ])
      const disposed = f.channel.dispose()
      expect(JSON.parse(f.write.mock.calls[2][0])).toEqual({
        version: 1,
        id: 3,
        action: 'dispose',
        ...binding,
        ...(nonce ? { stateCleanupNonce: nonce } : {})
      })
      f.send(f.reply(3, 'dispose'))
      f.gone()
      await disposed
      expect(f.uncertain).not.toHaveBeenCalled()
    }
  )
  it('retains explicit recovery after a controlled unknown result and a rejected revocation', async () => {
    const f = fixture()
    await f.ready()
    const acquisition = f.channel.acquire()
    f.send(f.reply(2, 'acquire', 'unknown'))
    expect((await acquisition).phase).toBe('unknown')
    const revocation = f.channel.revokeActivation()
    f.send({ ...f.reply(3, 'revokeActivation'), revoked: false })
    await expect(revocation).rejects.toThrow('未确认')
    const stop = f.channel.stopCore()
    f.send(f.reply(4, 'stopCore', 'coreStopped'))
    await stop
    const release = f.channel.release()
    f.send(f.reply(5, 'release', 'released'))
    await release
    const verification = f.channel.verifyRestored()
    f.send(f.reply(6, 'verifyRestored', 'restored'))
    await verification
    expect(f.end).not.toHaveBeenCalled()
    expect(f.uncertain).toHaveBeenCalledTimes(2)
  })
  it('binds a control-only initialization and assembles split frames', async () => {
    const f = fixture()
    expect(JSON.parse(f.write.mock.calls[0][0])).toEqual({
      version: 1,
      id: 1,
      action: 'initialize',
      ...binding
    })
    const bytes = Buffer.from(JSON.stringify(f.reply(1, 'initialize')) + '\n')
    f.data(bytes.subarray(0, 12))
    f.data(bytes.subarray(12))
    expect(await f.channel.ready).toEqual(observation())
    const acquire = f.channel.acquire()
    f.send(f.reply(2, 'acquire', 'acquired'))
    expect((await acquire).device).toBe('held')
  })

  it('sends activation revocation immediately while activation is in flight', async () => {
    const f = fixture()
    await f.ready()
    const active = f.channel.activate(),
      revoke = f.channel.revokeActivation()
    expect(f.write.mock.calls.slice(1).map(([text]) => JSON.parse(text).action)).toEqual([
      'activate',
      'revokeActivation'
    ])
    f.send(f.reply(3, 'revokeActivation'))
    await revoke
    f.send(f.reply(2, 'activate', 'active'))
    expect((await active).phase).toBe('active')
    // The service generation gate, not transport receipt order, decides whether
    // the active receipt still belongs to valid user consent.
  })

  it('serializes ordinary commands and refuses duplicate in-flight revocation', async () => {
    const f = fixture()
    await f.ready()
    const active = f.channel.activate(),
      revoke = f.channel.revokeActivation()
    await expect(f.channel.startCore()).rejects.toThrow('未确认')
    await expect(f.channel.revokeActivation()).rejects.toThrow('未确认')
    expect(f.write).toHaveBeenCalledTimes(3)
    f.send(f.reply(2, 'activate', 'active'))
    f.send(f.reply(3, 'revokeActivation'))
    await Promise.all([active, revoke])
  })

  it('keeps recovery available on timeout and never retries, ends IO or adopts a late success', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.ready()
    const start = f.channel.startCore(),
      failure = expect(start).rejects.toThrow('未确认')
    await vi.advanceTimersByTimeAsync(1001)
    await failure
    expect(f.end).not.toHaveBeenCalled()
    await expect(f.channel.activate()).rejects.toThrow()
    const revoke = f.channel.revokeActivation()
    f.send(f.reply(3, 'revokeActivation'))
    await revoke
    f.send(f.reply(2, 'startCore', 'coreReady'))
    const inspect = f.channel.inspect()
    f.send(f.reply(4, 'inspect', 'unknown'))
    expect((await inspect).phase).toBe('unknown')
    expect(f.uncertain).toHaveBeenCalledTimes(2)
    expect(f.write).toHaveBeenCalledTimes(4)
  })

  it.each([
    {
      version: 1,
      id: 1,
      action: 'initialize',
      observation: { ...observation(), evidenceSHA256: 'c'.repeat(64) }
    },
    {
      version: 1,
      id: 1,
      action: 'initialize',
      observation: { ...observation(), device: 'absent' }
    },
    { version: 1, id: 1, action: 'acquire', observation: observation() },
    { version: 1, id: 5, action: 'initialize', observation: observation() },
    { version: 1, id: 1, action: 'initialize', observation: observation(), private: 'PRIVATE' }
  ])('rejects a forged, inconsistent or unsolicited response %#', async (response) => {
    const f = fixture(),
      rejected = expect(f.channel.ready).rejects.not.toThrow('PRIVATE')
    f.send(response)
    await rejected
    expect(f.uncertain).toHaveBeenCalledOnce()
    expect(f.end).not.toHaveBeenCalled()
    await expect(f.channel.inspect()).rejects.toThrow()
  })

  it('bounds an unterminated stream, malformed UTF-8 and frames in a large chunk', async () => {
    for (const bytes of [
      Buffer.alloc(8193, 65),
      Buffer.from([0xff, 10]),
      Buffer.concat([Buffer.alloc(8193, 65), Buffer.from('\n')]),
      Buffer.from('PRIVATE not JSON\n')
    ]) {
      const f = fixture(),
        rejected = expect(f.channel.ready).rejects.not.toThrow('PRIVATE')
      f.data(bytes)
      await rejected
      expect(f.end).not.toHaveBeenCalled()
    }
  })

  it('rejects duplicate wire fields instead of silently taking the last value', async () => {
    const f = fixture(),
      rejected = expect(f.channel.ready).rejects.toThrow('未确认')
    const frame = JSON.stringify(f.reply(1, 'initialize'))
    f.data(Buffer.from(frame.replace('"id":1', '"id":9,"id":1') + '\n'))
    await rejected
    expect(f.uncertain).toHaveBeenCalledOnce()
  })

  it('does not dispose until native restoration is explicitly verified', async () => {
    const f = fixture()
    await f.ready()
    await expect(f.channel.dispose()).rejects.toThrow()
    const inspect = f.channel.inspect()
    f.send(f.reply(2, 'inspect', 'restored'))
    await inspect
    await expect(f.channel.dispose()).rejects.toThrow()
    expect(f.write).toHaveBeenCalledTimes(2)
    expect(f.end).not.toHaveBeenCalled()
  })

  it('waits for close acknowledgement and the owned process IO exit before disposal completes', async () => {
    const f = fixture()
    await f.ready()
    const verified = f.channel.verifyRestored()
    f.send(f.reply(2, 'verifyRestored', 'restored'))
    await verified
    let disposed = false
    const disposal = f.channel.dispose().then(() => {
      disposed = true
    })
    f.send(f.reply(3, 'dispose'))
    await Promise.resolve()
    expect(f.end).toHaveBeenCalledOnce()
    expect(disposed).toBe(false)
    f.gone()
    await disposal
    expect(f.channel.gone()).toBe(true)
    expect(f.uncertain).not.toHaveBeenCalled()
  })

  it('does not equate an acknowledged close with process exit on timeout', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.ready()
    const verified = f.channel.verifyRestored()
    f.send(f.reply(2, 'verifyRestored', 'restored'))
    await verified
    const disposal = f.channel.dispose(),
      rejected = expect(disposal).rejects.toThrow()
    f.send(f.reply(3, 'dispose'))
    await vi.advanceTimersByTimeAsync(1001)
    await rejected
    expect(f.channel.gone()).toBe(false)
    expect(f.uncertain).toHaveBeenCalledOnce()
    f.gone()
    await f.channel.dispose()
    expect(f.end).toHaveBeenCalledOnce()
    expect(f.write).toHaveBeenCalledTimes(3)
  })

  it('retains a late close acknowledgement and can finish disposal without replaying work', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.ready()
    const verified = f.channel.verifyRestored()
    f.send(f.reply(2, 'verifyRestored', 'restored'))
    await verified
    const disposal = f.channel.dispose(),
      rejected = expect(disposal).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(1001)
    await rejected
    await expect(f.channel.inspect()).rejects.toThrow()
    f.send(f.reply(3, 'dispose'))
    f.gone()
    await f.channel.dispose()
    expect(f.write).toHaveBeenCalledTimes(3)
  })

  const releasedReply = (id = 3) => ({
    version: 1,
    id,
    action: 'disposeReleased',
    ...binding,
    closed: true,
    restorationVerified: false,
    reason: 'external-protection-changed',
    stateDisposition: 'retained-evidence'
  })

  it('releases stopped managed resources without claiming network restoration and waits for IO exit', async () => {
    const f = fixture(false, 'core-managed', () => 'c'.repeat(64))
    await f.ready()
    await expect(f.channel.disposeReleased?.()).rejects.toThrow()
    const stopped = f.channel.stopCore()
    f.send(f.reply(2, 'stopCore', 'coreStopped'))
    await stopped
    let completed = false
    const closing = f.channel.disposeReleased?.().then(() => {
      completed = true
    })
    expect(JSON.parse(f.write.mock.calls[2][0])).toEqual({
      version: 1,
      id: 3,
      action: 'disposeReleased',
      ...binding
    })
    f.send(releasedReply())
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(f.end).toHaveBeenCalledOnce()
    f.gone()
    await closing
    expect(f.channel.smartStateDisposition()).toBe('retained-evidence')
    expect(f.uncertain).not.toHaveBeenCalled()
  })

  it('allows resource-only release after a bound normal-disposal refusal', async () => {
    const f = fixture(false, 'core-managed')
    await f.ready()
    const stopped = f.channel.stopCore()
    f.send(f.reply(2, 'stopCore', 'coreStopped'))
    await stopped
    const verified = f.channel.verifyRestored()
    f.send(f.reply(3, 'verifyRestored', 'restored'))
    await verified
    const closed = f.channel.dispose(),
      rejected = expect(closed).rejects.toThrow()
    f.send({ ...f.reply(4, 'dispose'), closed: false })
    await rejected
    const released = f.channel.disposeReleased?.()
    f.send(releasedReply(5))
    await Promise.resolve()
    f.gone()
    await released
    expect(f.write).toHaveBeenCalledTimes(5)
  })

  it('does not expose resource-only disposal to descriptor hosts', async () => {
    const f = fixture()
    await f.ready()
    expect(f.channel.disposeReleased).toBeUndefined()
  })

  it.each([
    { restorationVerified: true },
    { reason: 'restored' },
    { stateDisposition: 'removed' },
    { sessionId: '00000000-0000-0000-0000-000000000000' },
    { unknown: true }
  ])('rejects invalid resource release proof %j', async (change) => {
    const f = fixture(false, 'core-managed')
    await f.ready()
    const stopped = f.channel.stopCore()
    f.send(f.reply(2, 'stopCore', 'coreStopped'))
    await stopped
    const closing = f.channel.disposeReleased?.()
    const rejected = expect(closing).rejects.toThrow()
    f.send({ ...releasedReply(), ...change })
    await rejected
    expect(f.end).not.toHaveBeenCalled()
  })

  it('allows normal restoration after a bound denial of resource-only release', async () => {
    const f = fixture(false, 'core-managed')
    await f.ready()
    const stopped = f.channel.stopCore()
    f.send(f.reply(2, 'stopCore', 'coreStopped'))
    await stopped
    const denied = f.channel.disposeReleased?.(),
      rejected = expect(denied).rejects.toThrow()
    f.send({ version: 1, id: 3, action: 'disposeReleased', ...binding, closed: false })
    await rejected
    await expect(f.channel.dispose()).rejects.toThrow()
    await expect(f.channel.startCore()).rejects.toThrow()
    const verified = f.channel.verifyRestored()
    f.send(f.reply(4, 'verifyRestored', 'restored'))
    await verified
    const retry = f.channel.dispose()
    f.send(f.reply(5, 'dispose'))
    await Promise.resolve()
    f.gone()
    await retry
    expect(f.write).toHaveBeenCalledTimes(5)
  })

  it.each(['acknowledged', 'late'] as const)(
    'retains %s resource release evidence without replaying terminal work',
    async (timing) => {
      vi.useFakeTimers()
      const f = fixture(false, 'core-managed')
      await f.ready()
      const stopped = f.channel.stopCore()
      f.send(f.reply(2, 'stopCore', 'coreStopped'))
      await stopped
      const closing = f.channel.disposeReleased?.(),
        rejected = expect(closing).rejects.toThrow()
      if (timing === 'acknowledged') f.send(releasedReply())
      await vi.advanceTimersByTimeAsync(1001)
      await rejected
      await expect(f.channel.dispose()).rejects.toThrow()
      if (timing === 'late') f.send(releasedReply())
      f.gone()
      await f.channel.disposeReleased?.()
      expect(f.channel.smartStateDisposition()).toBe('retained-evidence')
      expect(f.write).toHaveBeenCalledTimes(3)
    }
  )

  it('settles failures even if a UI uncertainty callback throws', async () => {
    vi.useFakeTimers()
    for (const mode of ['timeout', 'malformed'] as const) {
      const f = fixture(true)
      await f.ready()
      const request = f.channel.acquire(),
        rejected = expect(request).rejects.not.toThrow('PRIVATE')
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(1001)
      else expect(() => f.data(Buffer.from('PRIVATE\n'))).not.toThrow()
      await rejected
      expect(f.end).not.toHaveBeenCalled()
    }
  })

  it('refuses inherited, extra or accessor binding fields before writing or registering IO', () => {
    const io = {
      write: vi.fn(),
      end: vi.fn(),
      onData: vi.fn(),
      onGone: vi.fn(),
      onFault: vi.fn()
    }
    const accessor = { ...binding }
    Object.defineProperty(accessor, 'sessionId', { enumerable: true, get: () => binding.sessionId })
    for (const identity of [Object.create(binding), { ...binding, private: 'extra' }, accessor]) {
      expect(() => createTunHostChannel(io, identity, vi.fn())).toThrow()
    }
    expect(io.write).not.toHaveBeenCalled()
    expect(io.onData).not.toHaveBeenCalled()
  })

  it('rejects unexpected EOF, IO faults and writes without discarding recovery ownership', async () => {
    for (const action of ['gone', 'fault', 'write'] as const) {
      const f = fixture()
      await f.ready()
      if (action === 'write')
        f.write.mockImplementation(() => {
          throw new Error('PRIVATE')
        })
      const request = f.channel.acquire(),
        rejected = expect(request).rejects.not.toThrow('PRIVATE')
      if (action === 'gone') f.gone()
      if (action === 'fault') f.fault()
      await rejected
      expect(f.end).not.toHaveBeenCalled()
      expect(f.uncertain).toHaveBeenCalledOnce()
    }
  })

  it('requires an exact bound revocation acknowledgement', async () => {
    const f = fixture()
    await f.ready()
    const revoke = f.channel.revokeActivation(),
      rejected = expect(revoke).rejects.toThrow()
    f.send({ ...f.reply(2, 'revokeActivation'), sessionId: '12345678-1234-1234-1234-123456789abd' })
    await rejected
  })
})
