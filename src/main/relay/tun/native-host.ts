import { tunDigest } from '../../../shared/relay/tun'
import { parseTunHostFrame } from './wire-json'
import {
  validateTunHostObservation,
  type TunHostObservation,
  type TunSessionBinding,
  type TunSessionHost,
  type TunWorkDirectoryProof
} from './service'

type Action =
  | 'initialize'
  | Exclude<
      keyof TunSessionHost,
      | 'dispose'
      | 'runtimeReader'
      | 'rulesChannel'
      | 'resourcesChannel'
      | 'resourceInbox'
      | 'ruleProvidersChannel'
      | 'smartToolsChannel'
    >
  | 'dispose'
type ObservingAction = Exclude<Action, 'revokeActivation' | 'dispose' | 'inspectWorkDirectory'>
export interface TunHostIO {
  write(frame: string): void
  end(): void
  onData(callback: (bytes: Buffer) => void): void
  onGone(callback: () => void): void
  onFault(callback: () => void): void
}
export interface TunHostChannel extends TunSessionHost {
  ready: Promise<TunHostObservation>
  gone(): boolean
  smartStateDisposition(): 'removed' | 'retained-evidence' | undefined
}
const frameLimit = 8192
const recovery = new Set<Action>([
  'inspect',
  'revokeActivation',
  'stopCore',
  'release',
  'verifyRestored',
  'dispose'
])
const expected: Partial<Record<ObservingAction, TunHostObservation['phase']>> = {
  initialize: 'idle',
  acquire: 'acquired',
  startCore: 'coreReady',
  activate: 'active',
  stopCore: 'coreStopped',
  release: 'released',
  verifyRestored: 'restored'
}
interface Response {
  version: 1
  id: number
  action: Action
  observation?: TunHostObservation
  workDirectory?: TunWorkDirectoryProof | null
  acknowledged?: boolean
  stateDisposition?: 'removed' | 'retained-evidence'
}

// Main-only control channel for one already-owned native host. The launcher
// must register recovery before starting that host, pin its executable and
// privately hand it the checked bundle. This module never spawns a process or
// sends configuration, paths, credentials, FD numbers or PIDs. The optional
// work-directory reply is read-only and stays in Main.
export function createTunHostChannel(
  io: TunHostIO,
  identity: TunSessionBinding,
  onUncertain: () => void,
  timeout = 30000,
  execution?: 'core-managed',
  stateCleanupProof?: () => string | undefined,
  supportsWorkDirectory = false
): TunHostChannel {
  if (
    !identity ||
    Object.getPrototypeOf(identity) !== Object.prototype ||
    Object.keys(identity).sort().join(',') !==
      'evidenceSHA256,runtimeConfigurationSHA256,sessionId' ||
    Reflect.ownKeys(identity).length !== 3 ||
    Object.keys(identity).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(identity, key)
      return !descriptor || !Object.hasOwn(descriptor, 'value')
    }) ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(identity.sessionId) ||
    !tunDigest(identity.evidenceSHA256) ||
    !tunDigest(identity.runtimeConfigurationSHA256) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 60000
  )
    throw new Error('TUN宿主绑定或通信期限无效。')
  const binding = { ...identity },
    pending = new Map<
      number,
      {
        action: Action
        resolve(value: Response): void
        reject(error: Error): void
        timer: ReturnType<typeof setTimeout>
      }
    >(),
    retired = new Map<number, Action>()
  let nextID = 0,
    ended = false,
    faulted = false,
    uncertain = false,
    initialized = false,
    restored = false,
    closing = false,
    closed = false,
    disposeRequested = false,
    disposalRestorationVerified = false,
    inputEnded = false,
    stateDisposition: Response['stateDisposition'],
    buffer = Buffer.alloc(0),
    exitWaiter: { resolve(): void; reject(error: Error): void } | undefined
  const error = (): Error => new Error('TUN宿主通信结果未确认；保留本次恢复能力，请复核。')
  const markUncertain = (): void => {
    uncertain = true
    restored = false
    try {
      onUncertain()
    } catch {
      // UI notification failure cannot suppress rejection, revoke or recovery.
    }
  }
  const fail = (): void => {
    if (faulted) return
    faulted = true
    markUncertain()
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error())
    }
    pending.clear()
    exitWaiter?.reject(error())
    // No kill, EOF-triggered recovery, retry or disposal on an unknown result.
    // The process/XPC/FD ownership remains with the registered recovery owner.
  }
  const parse = (line: Buffer): Response => {
    const raw = parseTunHostFrame(line)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error()
    const value = raw as Record<string, unknown>
    if (value.version !== 1 || !Number.isSafeInteger(value.id) || (value.id as number) < 1)
      throw error()
    const id = value.id as number,
      action = pending.get(id)?.action ?? retired.get(id)
    if (!action || value.action !== action) throw error()
    if (action === 'inspectWorkDirectory') {
      if (
        Object.keys(value).sort().join(',') !==
          'action,evidenceSHA256,id,runtimeConfigurationSHA256,sessionId,version,workDirectory' ||
        value.sessionId !== binding.sessionId ||
        value.evidenceSHA256 !== binding.evidenceSHA256 ||
        value.runtimeConfigurationSHA256 !== binding.runtimeConfigurationSHA256
      )
        return { version: 1, id, action }
      const proof = value.workDirectory as Record<string, unknown> | null
      const workDirectory =
        proof &&
        typeof proof === 'object' &&
        Object.keys(proof).sort().join(',') === 'device,inode,path' &&
        typeof proof.path === 'string' &&
        typeof proof.device === 'string' &&
        typeof proof.inode === 'string'
          ? { path: proof.path, device: proof.device, inode: proof.inode }
          : null
      return { version: 1, id, action, workDirectory }
    }
    if (action === 'revokeActivation' || action === 'dispose') {
      const flag = action === 'dispose' ? 'closed' : 'revoked'
      const stateField = action === 'dispose' && stateCleanupProof && 'stateDisposition' in value
      if (
        Object.keys(value).sort().join(',') !==
          [
            'version',
            'id',
            'action',
            ...Object.keys(binding),
            flag,
            ...(stateField ? ['stateDisposition'] : [])
          ]
            .sort()
            .join(',') ||
        typeof value[flag] !== 'boolean' ||
        value.sessionId !== binding.sessionId ||
        value.evidenceSHA256 !== binding.evidenceSHA256 ||
        value.runtimeConfigurationSHA256 !== binding.runtimeConfigurationSHA256
      )
        throw error()
      return {
        version: 1,
        id,
        action,
        acknowledged: value[flag] as boolean,
        ...(stateField &&
        (value.stateDisposition === 'removed' || value.stateDisposition === 'retained-evidence')
          ? { stateDisposition: value.stateDisposition }
          : {})
      }
    }
    if (Object.keys(value).sort().join(',') !== 'action,id,observation,version') throw error()
    const observation = validateTunHostObservation(value.observation, binding),
      expectedPhase =
        action === 'startCore' && execution === 'core-managed' ? 'active' : expected[action]
    if (expectedPhase && observation.phase !== expectedPhase && observation.phase !== 'unknown')
      throw error()
    return { version: 1, id, action, observation }
  }
  io.onFault(fail)
  io.onGone(() => {
    ended = true
    if (!closed || buffer.length || pending.size) fail()
    else exitWaiter?.resolve()
  })
  io.onData((chunk) => {
    if (faulted) return
    // Process a stream of bounded frames without first concatenating an
    // arbitrarily large chunk into a second allocation.
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset),
        end = newline < 0 ? chunk.length : newline,
        part = chunk.subarray(offset, end)
      if (buffer.length + part.length > frameLimit) {
        fail()
        return
      }
      buffer = Buffer.concat([buffer, part])
      if (newline < 0) return
      const line = buffer
      buffer = Buffer.alloc(0)
      offset = newline + 1
      try {
        if (closed) throw error()
        const response = parse(line),
          entry = pending.get(response.id)
        if (!entry) {
          // Validate and retire one late reply, but never promote its state or
          // replay its operation after a timeout. The terminal close ack may
          // still prove closure of an already-restored session; no further
          // network command can have followed that dispose request.
          if (response.action === 'dispose' && response.acknowledged) closed = true
          retired.delete(response.id)
          continue
        }
        pending.delete(response.id)
        clearTimeout(entry.timer)
        if (response.acknowledged === false) {
          markUncertain()
          entry.reject(error())
          continue
        }
        if (entry.action === 'initialize') initialized = true
        if (response.observation?.phase === 'unknown') markUncertain()
        if (entry.action === 'verifyRestored' && response.observation?.phase === 'restored')
          restored = true
        if (entry.action === 'dispose') {
          closed = true
          stateDisposition = response.stateDisposition
          for (const [id, read] of pending) {
            if (read.action !== 'inspectWorkDirectory') continue
            clearTimeout(read.timer)
            pending.delete(id)
            read.reject(error())
          }
        }
        entry.resolve(response)
      } catch {
        fail()
        return
      }
    }
  })
  const request = (action: Action): Promise<Response> =>
    new Promise((resolve, reject) => {
      // Revocation must bypass activation, and lifecycle operations must bypass
      // the optional directory read. A timed-out mutation still admits only recovery.
      const readDirectory = action === 'inspectWorkDirectory'
      const occupied = readDirectory
        ? pending.size > 0 || [...retired.values()].includes(action)
        : [...pending.values()].some(
            (entry) =>
              entry.action !== 'inspectWorkDirectory' &&
              (action === 'revokeActivation'
                ? entry.action === 'revokeActivation'
                : entry.action !== 'revokeActivation')
          )
      if (
        ended ||
        faulted ||
        closed ||
        (closing && action !== 'dispose') ||
        (disposeRequested && action !== 'dispose') ||
        occupied ||
        (action !== 'initialize' && !initialized && !recovery.has(action)) ||
        (uncertain && !recovery.has(action)) ||
        (action === 'dispose' &&
          ((!restored && !disposalRestorationVerified) ||
            [...pending.values()].some((entry) => entry.action !== 'inspectWorkDirectory') ||
            [...retired.values()].some((action) => action !== 'inspectWorkDirectory')))
      ) {
        reject(error())
        return
      }
      const id = ++nextID,
        timer = setTimeout(
          () => {
            pending.delete(id)
            retired.set(id, action)
            if (!readDirectory) markUncertain()
            reject(error())
            if (retired.size > 32) fail()
          },
          readDirectory ? Math.min(3000, timeout) : timeout
        )
      pending.set(id, { action, resolve, reject, timer })
      if (!readDirectory && !recovery.has(action)) restored = false
      if (action === 'dispose') {
        disposeRequested = true
        disposalRestorationVerified = true
      }
      try {
        const nonce = action === 'dispose' ? stateCleanupProof?.() : undefined
        if (nonce !== undefined && (execution !== 'core-managed' || !tunDigest(nonce)))
          throw error()
        io.write(
          JSON.stringify({
            version: 1,
            id,
            action,
            ...binding,
            ...(nonce !== undefined ? { stateCleanupNonce: nonce } : {})
          }) + '\n'
        )
      } catch {
        fail()
      }
    })
  const observe = async (action: ObservingAction): Promise<TunHostObservation> => {
    const response = await request(action)
    if (!response.observation) throw error()
    return response.observation
  }
  return {
    ready: observe('initialize'),
    gone: () => ended,
    smartStateDisposition: () => stateDisposition,
    acquire: () => observe('acquire'),
    startCore: () => observe('startCore'),
    activate: () => observe('activate'),
    inspect: () => observe('inspect'),
    ...(supportsWorkDirectory && execution === 'core-managed'
      ? {
          async inspectWorkDirectory(): Promise<TunWorkDirectoryProof | null> {
            const response = await request('inspectWorkDirectory')
            if (response.workDirectory === undefined) throw error()
            return response.workDirectory
          }
        }
      : {}),
    stopCore: () => observe('stopCore'),
    release: () => observe('release'),
    verifyRestored: () => observe('verifyRestored'),
    async revokeActivation(): Promise<void> {
      await request('revokeActivation')
    },
    async dispose(): Promise<void> {
      if (closing) throw error()
      // A native close acknowledgement alone does not prove its process and
      // all inherited FD references exited. Also wait for the owned IO close.
      closing = true
      try {
        // An acknowledged close is bound to the earlier verified restoration.
        // If process exit was slow, retry only its exit observation, never a
        // command against an ended channel or a previously restored network.
        if (!closed) await request('dispose')
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            markUncertain()
            reject(error())
          }, timeout)
          exitWaiter = {
            resolve: () => {
              clearTimeout(timer)
              resolve()
            },
            reject: (failure) => {
              clearTimeout(timer)
              reject(failure)
            }
          }
          if (faulted) exitWaiter.reject(error())
          else if (ended) exitWaiter.resolve()
          else if (!inputEnded) {
            try {
              inputEnded = true
              io.end()
            } catch {
              fail()
            }
          }
        })
      } finally {
        closing = false
      }
    }
  }
}
