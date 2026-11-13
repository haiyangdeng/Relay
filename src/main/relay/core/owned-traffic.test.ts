import { createServer, createConnection, type Socket } from 'net'
import { EventEmitter, once } from 'events'
import { mkdtemp, realpath, lstat, chmod, readdir, rmdir, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Stats } from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertOwnedTrafficSocket,
  createOwnedTrafficReader,
  ownedTrafficDeadlineMS,
  ownedTrafficByteLimit,
  OwnedTrafficReadError,
  type OwnedTrafficLease,
  type OwnedTrafficSample,
  type OwnedTrafficResponse
} from './owned-traffic'

const id = '00000000-0000-4000-8000-000000000038'
const id2 = '00000000-0000-4000-8000-000000000039'
const wire = (up = 12) =>
  Buffer.from(JSON.stringify({ up, down: 34, upTotal: 100, downTotal: 200 }) + '\n')
class Response extends EventEmitter {
  statusCode = 200
  destroys = 0
  constructor(readonly autoClose: boolean) {
    super()
  }
  destroy(): void {
    ++this.destroys
    if (this.autoClose) this.emit('close')
  }
}
class Request extends EventEmitter {
  destroys = 0
  ends = 0
  constructor(
    readonly autoClose: boolean,
    readonly receive: () => void
  ) {
    super()
  }
  destroy(): void {
    ++this.destroys
    if (this.autoClose) this.emit('close')
  }
  end(): void {
    ++this.ends
    this.receive()
  }
}
const flush = async (): Promise<void> => {
  for (let n = 0; n < 12; ++n) await Promise.resolve()
}
function fixture(autoClose = true, status = 200) {
  let wall = 10000,
    mono = 0,
    epoch = 1
  const requests: Request[] = [],
    responses: Response[] = []
  const createRequest = vi.fn((receive: (response: OwnedTrafficResponse) => void) => {
    const response = new Response(autoClose)
    response.statusCode = status
    const request = new Request(autoClose, () => receive(response))
    requests.push(request)
    responses.push(response)
    return request
  })
  const reader = createOwnedTrafficReader({
    createRequest,
    wallNow: () => wall,
    monotonicNow: () => mono
  })
  const controller = new AbortController()
  const recheckOwner = vi.fn(async () => {})
  const lease = {
    instanceId: id,
    configurationRevision: 'a'.repeat(64),
    signal: controller.signal,
    assertLive: vi.fn(() => {
      if (epoch !== 1) throw new Error('owner changed')
    }),
    recheckOwner
  }
  const read = (value: OwnedTrafficLease = lease) => {
    let settled = false
    const promise = reader.read(value).then(
      (sample) => {
        settled = true
        return { sample, error: undefined }
      },
      (error: unknown) => {
        settled = true
        return { sample: undefined, error }
      }
    )
    return { promise, settled: () => settled }
  }
  return {
    reader,
    lease,
    controller,
    requests,
    responses,
    createRequest,
    recheckOwner,
    read,
    wall: (value: number) => {
      wall = value
    },
    mono: (value: number) => {
      mono = value
    },
    revoke: () => {
      epoch = 2
    }
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Owned ordinary traffic first-frame transport', () => {
  it('takes exactly the first complete split NDJSON frame, then waits for both creator close receipts', async () => {
    const f = fixture(false),
      result = f.read()
    await flush()
    const bytes = wire()
    f.responses[0].emit('data', bytes.subarray(0, 5))
    expect(f.requests[0].destroys).toBe(0)
    f.responses[0].emit('data', Buffer.concat([bytes.subarray(5), wire(999)]))
    expect(f.requests[0].destroys).toBe(1)
    expect(f.responses[0].destroys).toBe(1)
    expect(result.settled()).toBe(false)
    f.requests[0].emit('close')
    await flush()
    expect(result.settled()).toBe(false)
    expect(f.recheckOwner).toHaveBeenCalledTimes(1)
    f.responses[0].emit('close')
    const outcome = await result.promise
    expect(outcome.sample).toEqual({
      instanceId: id,
      configurationRevision: 'a'.repeat(64),
      receivedAt: 10000,
      up: 12,
      down: 34,
      upTotal: 100,
      downTotal: 200
    })
    expect(f.recheckOwner).toHaveBeenCalledTimes(2)
    expect(f.reader.isBusy()).toBe(false)
  })
  it('does not treat error as close and cancellation does not await a hanging server end', async () => {
    const f = fixture(false),
      result = f.read()
    await flush()
    f.requests[0].emit('error', new Error('transport'))
    expect(f.reader.cancel()).toBeUndefined()
    expect(result.settled()).toBe(false)
    expect(f.reader.isBusy()).toBe(true)
    expect(f.requests[0].destroys).toBe(1)
    f.responses[0].emit('close')
    f.requests[0].emit('close')
    const outcome = await result.promise
    expect(outcome.error).toBeInstanceOf(OwnedTrafficReadError)
    expect(outcome.sample).toBeUndefined()
  })
  it.each(['wall', 'monotonic'] as const)(
    'rejects a late frame from the %s clock even when the timeout callback has not run',
    async (clock) => {
      const f = fixture(),
        result = f.read()
      await flush()
      if (clock === 'wall') f.wall(10000 + ownedTrafficDeadlineMS)
      else f.mono(ownedTrafficDeadlineMS)
      f.responses[0].emit('data', wire())
      const outcome = await result.promise
      expect(outcome.error).toMatchObject({ code: 'deadline' })
      expect(outcome.sample).toBeUndefined()
    }
  )
  it('includes socket close in the same original deadline', async () => {
    const f = fixture(false),
      result = f.read()
    await flush()
    f.wall(11999)
    f.mono(1999)
    f.responses[0].emit('data', wire())
    f.wall(12000)
    f.mono(2000)
    f.responses[0].emit('close')
    f.requests[0].emit('close')
    expect((await result.promise).error).toMatchObject({ code: 'deadline' })
  })
  it('fails a backwards clock and does not extend a lease', async () => {
    const f = fixture(),
      result = f.read()
    await flush()
    f.wall(9999)
    f.responses[0].emit('data', wire())
    expect((await result.promise).error).toMatchObject({ code: 'deadline' })
  })
  it('times out a never-ending response and destroys only its own request', async () => {
    const f = fixture(),
      result = f.read()
    await flush()
    await vi.advanceTimersByTimeAsync(ownedTrafficDeadlineMS)
    expect((await result.promise).error).toMatchObject({ code: 'deadline' })
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].destroys).toBe(1)
    expect(f.responses[0].destroys).toBe(1)
  })
  it('cannot publish after the last owner recheck exceeds the original deadline', async () => {
    const f = fixture()
    let release!: () => void
    f.recheckOwner
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
    const result = f.read()
    await flush()
    f.responses[0].emit('data', wire())
    await flush()
    expect(result.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(ownedTrafficDeadlineMS)
    expect((await result.promise).error).toMatchObject({ code: 'deadline' })
    release()
    await flush()
    expect(f.reader.isBusy()).toBe(false)
  })
  it('refuses an aborted read before any request or owner I/O', async () => {
    const f = fixture()
    f.controller.abort()
    expect((await f.read().promise).error).toMatchObject({ code: 'cancelled' })
    expect(f.createRequest).not.toHaveBeenCalled()
    expect(f.recheckOwner).not.toHaveBeenCalled()
  })
  it('does not create a request after cancellation while preflight is suspended', async () => {
    const f = fixture()
    let release!: () => void
    f.recheckOwner.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const result = f.read()
    f.reader.cancel()
    expect(f.createRequest).not.toHaveBeenCalled()
    await flush()
    expect(result.settled()).toBe(true)
    expect(f.reader.isBusy()).toBe(false)
    release()
    expect((await result.promise).error).toMatchObject({ code: 'cancelled' })
    expect(f.createRequest).not.toHaveBeenCalled()
  })
  it('ends a timed-out owner preflight without a traffic cap and never dispatches its late continuation', async () => {
    const f = fixture()
    let release!: () => void
    f.recheckOwner.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const first = f.read()
    await vi.advanceTimersByTimeAsync(ownedTrafficDeadlineMS)
    expect(first.settled()).toBe(true)
    expect((await first.promise).error).toMatchObject({ code: 'deadline' })
    expect(f.reader.isBusy()).toBe(false)
    expect(f.createRequest).not.toHaveBeenCalled()
    const next = f.read({ ...f.lease, instanceId: id2 })
    await flush()
    expect(f.createRequest).toHaveBeenCalledTimes(1)
    release()
    await flush()
    expect(f.createRequest).toHaveBeenCalledTimes(1)
    expect(next.settled()).toBe(false)
    f.responses[0].emit('data', wire(23))
    expect((await next.promise).sample).toMatchObject({ instanceId: id2, up: 23 })
  })
  it('ignores late old events after cancellation and keeps the next reader single-flight', async () => {
    const f = fixture(),
      first = f.read()
    await flush()
    const busy = f.read()
    expect((await busy.promise).error).toMatchObject({ code: 'busy' })
    f.reader.cancel()
    expect((await first.promise).error).toMatchObject({ code: 'cancelled' })
    const second = f.read({ ...f.lease, instanceId: id2, configurationRevision: 'b'.repeat(64) })
    await flush()
    f.responses[0].emit('data', wire(999))
    f.requests[0].emit('close')
    expect(second.settled()).toBe(false)
    expect(f.reader.isBusy()).toBe(true)
    f.responses[1].emit('data', wire(23))
    expect((await second.promise).sample).toMatchObject({
      instanceId: id2,
      configurationRevision: 'b'.repeat(64),
      up: 23
    })
    expect(f.createRequest).toHaveBeenCalledTimes(2)
  })
  it('captures owner metadata before the first await rather than rereading a mutable DTO', async () => {
    const f = fixture()
    let release!: () => void
    f.recheckOwner.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const result = f.read()
    f.lease.instanceId = id2
    f.lease.configurationRevision = 'b'.repeat(64)
    release()
    await flush()
    f.responses[0].emit('data', wire())
    expect((await result.promise).sample).toMatchObject({
      instanceId: id,
      configurationRevision: 'a'.repeat(64)
    })
  })
  it('refuses a changed owner after the frame and close, before publication', async () => {
    const f = fixture(false),
      result = f.read()
    await flush()
    f.responses[0].emit('data', wire())
    f.revoke()
    f.responses[0].emit('close')
    f.requests[0].emit('close')
    expect((await result.promise).sample).toBeUndefined()
    expect(f.reader.isBusy()).toBe(false)
  })
  it.each([204, 302, 500])('does not accept or redirect HTTP %s', async (status) => {
    const f = fixture(true, status),
      result = f.read()
    await flush()
    expect((await result.promise).error).toMatchObject({ code: 'invalid' })
    expect(f.createRequest).toHaveBeenCalledTimes(1)
  })
})

describe('Pinned /traffic four-field strict frame boundary', () => {
  it.each([
    Buffer.from('\n'),
    Buffer.from('{"up":1,"down":2,"upTotal":3,"downTotal":4,"up":5}\n'),
    Buffer.from('{"up":1,"down":2,"upTotal":3,"downTotal":4,"\\u0075p":5}\n'),
    Buffer.from('{"up":-1,"down":2,"upTotal":3,"downTotal":4}\n'),
    Buffer.from('{"up":1.2,"down":2,"upTotal":3,"downTotal":4}\n'),
    Buffer.from('{"up":1,"down":2,"upTotal":9007199254740992,"downTotal":4}\n'),
    Buffer.from('{"up":1,"down":2,"upTotal":3}\n'),
    Buffer.from('{"up":1,"down":2,"upTotal":3,"downTotal":4,"host":"foreign"}\n'),
    Buffer.from([0xff, 10]),
    Buffer.alloc(ownedTrafficByteLimit + 1, 65)
  ])('rejects malformed, duplicate, unsafe, incomplete or oversized frames %#', async (bytes) => {
    const f = fixture(),
      result = f.read()
    await flush()
    f.responses[0].emit('data', bytes)
    expect((await result.promise).error).toMatchObject({ code: 'invalid' })
    expect(f.reader.isBusy()).toBe(false)
  })
  it('requires LF rather than accepting an EOF partial final frame', async () => {
    const f = fixture(),
      result = f.read()
    await flush()
    f.responses[0].emit('data', wire().subarray(0, -1))
    f.responses[0].emit('end')
    expect((await result.promise).error).toMatchObject({ code: 'invalid' })
  })
  it('keeps numeric zero distinct from unavailable and forwards actual rates, not totals', async () => {
    const f = fixture(),
      result = f.read()
    await flush()
    f.responses[0].emit('data', Buffer.from('{"up":0,"down":0,"upTotal":9000,"downTotal":10000}\n'))
    const sample: OwnedTrafficSample | undefined = (await result.promise).sample
    expect(sample).toMatchObject({ up: 0, down: 0, upTotal: 9000, downTotal: 10000 })
  })
})

describe('Ordinary known UDS identity, independent from privileged TUN roles', () => {
  const fact = () => ({
    dev: 1,
    ino: 2,
    uid: 501,
    gid: 20,
    mode: 0o140666,
    nlink: 1,
    ctimeMs: 10,
    isSocket: () => true,
    isSymbolicLink: () => false
  })
  it.each([
    { ino: 3 },
    { uid: 0 },
    { gid: 0 },
    { mode: 0o140600 },
    { nlink: 2 },
    { ctimeMs: 11 },
    { isSocket: () => false },
    { isSymbolicLink: () => true }
  ])('rejects identity/type/owner/mode/link or timestamp replacement %#', (delta) => {
    const before = fact()
    expect(() =>
      assertOwnedTrafficSocket({ ...before, ...delta }, before, 501, 20, before)
    ).toThrow(OwnedTrafficReadError)
  })
  it('does not accept a synthetic UID0 socket even when a caller supplies UID0', () => {
    const socket = { ...fact(), uid: 0 }
    expect(() => assertOwnedTrafficSocket(socket, socket, 0, 20)).toThrow(OwnedTrafficReadError)
  })
  it('keeps socket facts stable across an actual own UID Unix connection and cleans only that finite layout', async () => {
    vi.useRealTimers()
    const uid = process.getuid?.(),
      gid = process.getgid?.()
    if (uid === undefined || gid === undefined || uid === 0)
      throw new Error('ordinary POSIX UID required')
    const root = await realpath(await mkdtemp('/private/tmp/relay-traffic-socket-'))
    const rootPin = await lstat(root),
      path = join(root, 'api.sock')
    const accepted: Promise<unknown>[] = [],
      sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      accepted.push(once(socket, 'close'))
      socket.on('end', () => socket.end())
    })
    let client: Socket | undefined, pin: Stats | undefined
    const cleanup = async (): Promise<void> => {
      client?.destroy()
      for (const socket of sockets) socket.destroy()
      await Promise.all(accepted)
      if (server.listening) {
        if (pin) {
          const current = await lstat(path)
          if (current.dev !== pin.dev || current.ino !== pin.ino || current.uid !== uid)
            throw new Error('foreign socket retained')
        }
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
      }
      try {
        const current = await lstat(path)
        if (!pin || current.dev !== pin.dev || current.ino !== pin.ino || current.uid !== uid)
          throw new Error('foreign socket retained')
        await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const currentRoot = await lstat(root)
      if (
        currentRoot.dev !== rootPin.dev ||
        currentRoot.ino !== rootPin.ino ||
        currentRoot.uid !== uid ||
        (await readdir(root)).length
      )
        throw new Error('unknown directory retained')
      await rmdir(root)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, resolve)
      })
      await chmod(path, 0o666)
      pin = await lstat(path)
      if (process.env.RELAY_TRAFFIC_PROOF_OUTPUT)
        await writeFile(
          join(process.env.RELAY_TRAFFIC_PROOF_OUTPUT, 'socket-facts.json'),
          JSON.stringify(
            {
              uid,
              processGID: gid,
              directory: { uid: rootPin.uid, gid: rootPin.gid, mode: rootPin.mode },
              socket: {
                dev: pin.dev,
                ino: pin.ino,
                uid: pin.uid,
                gid: pin.gid,
                mode: pin.mode,
                nlink: pin.nlink,
                ctimeMs: pin.ctimeMs
              }
            },
            null,
            2
          ) + '\n'
        )
      assertOwnedTrafficSocket(pin, pin, uid, rootPin.gid)
      client = createConnection({ path })
      const closed = once(client, 'close')
      await once(client, 'connect')
      client.end()
      await closed
      await Promise.all(accepted)
      assertOwnedTrafficSocket(await lstat(path), pin, uid, rootPin.gid, pin)
    } finally {
      await cleanup()
    }
  })
})
