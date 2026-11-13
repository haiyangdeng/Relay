import type { Stats } from 'fs'
import { parseTunHostFrame } from '../tun/wire-json'

export const ownedTrafficByteLimit = 4096
export const ownedTrafficDeadlineMS = 2000
export interface OwnedTrafficFrame {
  readonly up: number
  readonly down: number
  readonly upTotal: number
  readonly downTotal: number
}
export interface OwnedTrafficSample extends OwnedTrafficFrame {
  readonly instanceId: string
  readonly configurationRevision: string
  readonly receivedAt: number
}
export interface OwnedTrafficLease {
  readonly instanceId: string
  readonly configurationRevision: string
  readonly signal: AbortSignal
  assertLive(): void
  recheckOwner(): Promise<void>
}
export interface OwnedTrafficRequest {
  once(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  end(): unknown
  destroy(error?: Error): unknown
}
export interface OwnedTrafficResponse {
  readonly statusCode?: number
  on(event: 'data', listener: (chunk: unknown) => void): unknown
  on(event: 'end' | 'close' | 'aborted', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  destroy(): unknown
}
export type OwnedTrafficSocketFact = Pick<
  Stats,
  'dev' | 'ino' | 'uid' | 'gid' | 'mode' | 'nlink' | 'ctimeMs' | 'isSocket' | 'isSymbolicLink'
>

// Facts come from the caller's held ordinary Core/known startup socket, never
// a renderer path/name. This predicate does not attest a kernel connected peer.
export function assertOwnedTrafficSocket(
  current: OwnedTrafficSocketFact,
  known: { dev: number; ino: number },
  uid: number,
  gid: number,
  previous?: OwnedTrafficSocketFact
): void {
  if (
    !Number.isSafeInteger(uid) ||
    uid < 1 ||
    !Number.isSafeInteger(gid) ||
    gid < 0 ||
    !Number.isSafeInteger(known.dev) ||
    !Number.isSafeInteger(known.ino) ||
    !current.isSocket() ||
    current.isSymbolicLink() ||
    current.uid !== uid ||
    current.gid !== gid ||
    (current.mode & 0o7777) !== 0o666 ||
    current.nlink !== 1 ||
    current.dev !== known.dev ||
    current.ino !== known.ino ||
    (previous &&
      (current.dev !== previous.dev ||
        current.ino !== previous.ino ||
        current.uid !== previous.uid ||
        current.gid !== previous.gid ||
        current.mode !== previous.mode ||
        current.nlink !== previous.nlink ||
        current.ctimeMs !== previous.ctimeMs))
  )
    throw new OwnedTrafficReadError('owner')
}

export class OwnedTrafficReadError extends Error {
  constructor(readonly code: 'busy' | 'cancelled' | 'deadline' | 'invalid' | 'owner' | 'io') {
    super('本次核心流量读取未确认。')
  }
}

export function parseOwnedTrafficFrame(bytes: Uint8Array): OwnedTrafficFrame {
  // Reuse only the existing pure strict JSON grammar, not a TUN command/capability.
  const value = parseTunHostFrame(bytes, ownedTrafficByteLimit)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'down,downTotal,up,upTotal'
  )
    throw new OwnedTrafficReadError('invalid')
  const record = value as Record<string, unknown>
  for (const key of ['up', 'down', 'upTotal', 'downTotal'])
    if (typeof record[key] !== 'number' || !Number.isSafeInteger(record[key]) || record[key] < 0)
      throw new OwnedTrafficReadError('invalid')
  return {
    up: Number(record.up),
    down: Number(record.down),
    upTotal: Number(record.upTotal),
    downTotal: Number(record.downTotal)
  }
}

// One bounded NDJSON frame on a creator-owned HTTP request. cancel() only
// destroys that read socket and never waits for server EOF or holds lifecycle
// busy. A read can publish only after request/response close and a fresh owner
// check; an error/abort is never substituted for the close receipts.
export function createOwnedTrafficReader(adapters: {
  createRequest(receive: (response: OwnedTrafficResponse) => void): OwnedTrafficRequest
  wallNow?(): number
  monotonicNow?(): number
}) {
  const createRequest = adapters.createRequest,
    wallNow = adapters.wallNow ?? Date.now,
    monotonicNow = adapters.monotonicNow ?? (() => performance.now())
  let pending: { cancel(): void; promise: Promise<OwnedTrafficSample> } | undefined
  return {
    isBusy: (): boolean => !!pending,
    cancel(): void {
      pending?.cancel()
    },
    whenIdle: async (): Promise<void> => {
      await pending?.promise.catch(() => {})
    },
    read(lease: OwnedTrafficLease): Promise<OwnedTrafficSample> {
      if (pending) return Promise.reject(new OwnedTrafficReadError('busy'))
      // Capture the Main-owned DTO/functions before any callback or await.
      const instanceId = lease.instanceId,
        configurationRevision = lease.configurationRevision,
        signal = lease.signal,
        assertLive = lease.assertLive,
        recheckOwner = lease.recheckOwner,
        wallStart = wallNow(),
        monoStart = monotonicNow()
      if (
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(instanceId) ||
        !/^[a-f0-9]{64}$/u.test(configurationRevision) ||
        !Number.isFinite(wallStart) ||
        !Number.isFinite(monoStart)
      )
        return Promise.reject(new OwnedTrafficReadError('owner'))
      if (signal.aborted) return Promise.reject(new OwnedTrafficReadError('cancelled'))
      let resolve!: (sample: OwnedTrafficSample) => void,
        reject!: (error: OwnedTrafficReadError) => void
      const promise = new Promise<OwnedTrafficSample>((done, failed) => {
        resolve = done
        reject = failed
      })
      let request: OwnedTrafficRequest | undefined, response: OwnedTrafficResponse | undefined
      let requestClosed = false,
        responseClosed = false,
        requestDestroyCalled = false,
        responseDestroyCalled = false,
        preflightDone = false,
        dispatchAttempted = false,
        completing = false,
        settled = false,
        cancelled = false
      let failure: OwnedTrafficReadError | undefined, sample: OwnedTrafficSample | undefined
      const chunks: Buffer[] = []
      let length = 0
      const clock = (): number => {
        const wall = wallNow(),
          mono = monotonicNow()
        if (
          !Number.isFinite(wall) ||
          !Number.isFinite(mono) ||
          wall < wallStart ||
          mono < monoStart ||
          wall - wallStart >= ownedTrafficDeadlineMS ||
          mono - monoStart >= ownedTrafficDeadlineMS
        )
          throw new OwnedTrafficReadError('deadline')
        return wall
      }
      const live = (): number => {
        if (settled || failure) throw failure ?? new OwnedTrafficReadError('cancelled')
        const at = clock()
        if (cancelled || signal.aborted) throw new OwnedTrafficReadError('cancelled')
        assertLive()
        if (cancelled || signal.aborted) throw new OwnedTrafficReadError('cancelled')
        clock()
        // Last synchronous fence, after both clock reads, with no observer/await
        // between this check and request dispatch or sample publication.
        assertLive()
        return at
      }
      const destroyOwn = (): void => {
        if (response && !responseDestroyCalled) {
          responseDestroyCalled = true
          try {
            response.destroy()
          } catch {
            failure ??= new OwnedTrafficReadError('io')
          }
        }
        if (request && !requestDestroyCalled) {
          requestDestroyCalled = true
          try {
            request.destroy()
          } catch {
            failure ??= new OwnedTrafficReadError('io')
          }
        }
      }
      const settle = (error?: OwnedTrafficReadError): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (pending === operation) pending = undefined
        if (error) reject(error)
        else if (sample) resolve(sample)
        else reject(new OwnedTrafficReadError('invalid'))
      }
      const complete = (): void => {
        if (settled) return
        // No traffic capability exists during the first owner preflight. End a
        // failed read immediately, but never skip factory registration/drain.
        if (failure && !dispatchAttempted && !request && !response) {
          settle(failure)
          return
        }
        if (!preflightDone || (request && !requestClosed) || (response && !responseClosed)) return
        if (failure) {
          settle(failure)
          return
        }
        if (!sample || !request || !response) {
          settle(new OwnedTrafficReadError('invalid'))
          return
        }
        if (completing) return
        completing = true
        void (async () => {
          live()
          await recheckOwner()
          live()
          settle()
        })().catch((error: unknown) => {
          failure ??=
            error instanceof OwnedTrafficReadError ? error : new OwnedTrafficReadError('owner')
          complete()
        })
      }
      const fail = (error: OwnedTrafficReadError): void => {
        if (settled) return
        failure ??= error
        destroyOwn()
        complete()
      }
      const abort = (): void => {
        cancelled = true
        fail(new OwnedTrafficReadError('cancelled'))
      }
      const operation = { cancel: abort, promise }
      pending = operation
      const timer = setTimeout(
        () => fail(new OwnedTrafficReadError('deadline')),
        ownedTrafficDeadlineMS
      )
      signal.addEventListener('abort', abort, { once: true })
      const receive = (incoming: OwnedTrafficResponse): void => {
        if (settled || response) {
          incoming.destroy()
          return
        }
        response = incoming
        incoming.on('close', () => {
          responseClosed = true
          complete()
        })
        incoming.on('error', () => {
          if (!sample) fail(new OwnedTrafficReadError('io'))
        })
        incoming.on('aborted', () => {
          if (!sample) fail(new OwnedTrafficReadError('io'))
        })
        incoming.on('end', () => {
          if (!sample) fail(new OwnedTrafficReadError('invalid'))
        })
        incoming.on('data', (chunk) => {
          if (settled || failure || sample) return
          try {
            const at = live()
            if (!Buffer.isBuffer(chunk) || length + chunk.length > ownedTrafficByteLimit)
              throw new OwnedTrafficReadError('invalid')
            chunks.push(chunk)
            length += chunk.length
            const bytes = Buffer.concat(chunks, length),
              line = bytes.indexOf(10)
            if (line < 0) return
            sample = {
              ...parseOwnedTrafficFrame(bytes.subarray(0, line)),
              instanceId,
              configurationRevision,
              receivedAt: at
            }
            destroyOwn()
            complete()
          } catch (error) {
            fail(
              error instanceof OwnedTrafficReadError ? error : new OwnedTrafficReadError('invalid')
            )
          }
        })
        if (incoming.statusCode !== 200) fail(new OwnedTrafficReadError('invalid'))
        if (failure || cancelled) destroyOwn()
      }
      void (async () => {
        try {
          live()
          await recheckOwner()
          live()
          dispatchAttempted = true
          request = createRequest(receive)
          request.once('close', () => {
            requestClosed = true
            complete()
          })
          request.on('error', () => {
            if (!sample) fail(new OwnedTrafficReadError('io'))
          })
          if (failure || sample || cancelled) destroyOwn()
          else {
            live()
            request.end()
          }
        } catch (error) {
          fail(error instanceof OwnedTrafficReadError ? error : new OwnedTrafficReadError('owner'))
        } finally {
          preflightDone = true
          complete()
        }
      })()
      return promise
    }
  }
}
