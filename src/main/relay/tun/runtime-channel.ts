import {
  trafficHistoryConnections,
  trafficHistoryConnectionsByteLimit
} from '../../../shared/relay/traffic-history-connections'
import type { TrafficUsageConnectionSnapshot } from '../../../shared/trafficUsage'
import {
  ownedTrafficByteLimit,
  parseOwnedTrafficFrame,
  type OwnedTrafficFrame
} from '../core/owned-traffic'
import type { TunSessionBinding } from './service'
import { parseTunHostFrame } from './wire-json'

export interface TunRuntimeSnapshot {
  originalLoadedSHA256: string
  originalLoadedBytes: number
  mode: 'rule' | 'global' | 'direct'
  ports: { kind: 'http' | 'mixed'; port: number; ownership: 'held-child-pcb-v1' }[]
}
export type TunRuntimeReadResult =
  | { status: 'captured'; snapshot: TunRuntimeSnapshot }
  | { status: 'busy' | 'unsupported' | 'unavailable' }
export type TunRuntimeTrafficResult =
  | { status: 'sampled'; frame: OwnedTrafficFrame }
  | { status: 'busy' | 'unsupported' | 'unavailable' }
export type TunRuntimeConnectionsResult =
  | { status: 'connections'; snapshot: TrafficUsageConnectionSnapshot }
  | { status: 'busy' | 'unsupported' | 'unavailable' }
type RuntimeResult = TunRuntimeReadResult | TunRuntimeTrafficResult | TunRuntimeConnectionsResult
type ReadAction = 'capture' | 'traffic' | 'connections'
export interface TunRuntimeReader {
  capture(signal: AbortSignal): Promise<TunRuntimeReadResult>
  isAvailable(): boolean
  // Missing on legacy hosts. This fixed action grants no endpoint selector.
  traffic?(signal: AbortSignal): Promise<TunRuntimeTrafficResult>
  connections?(signal: AbortSignal): Promise<TunRuntimeConnectionsResult>
  supportsConnections?(): boolean
}
export interface TunRuntimeReadIO {
  write(frame: string): void
  onData(callback: (bytes: Buffer) => void): void
  onGone(callback: () => void): void
  onFault(callback: () => void): void
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: string): boolean =>
  Object.keys(value).sort().join(',') === expected.split(',').sort().join(',')

// Dedicated inherited pipes only. A read failure never ends the lifecycle pipe
// or calls its uncertain/recovery handlers. The launcher admits known new bytes.
export function createTunRuntimeReader(
  io: TunRuntimeReadIO,
  identity: TunSessionBinding & { launchClientSHA256: string; installationRevision: string },
  timeout = 3000,
  capability:
    'runtime-capture-v1' | 'runtime-telemetry-v2' | 'runtime-history-v3' = 'runtime-capture-v1'
): TunRuntimeReader {
  const binding = { ...identity },
    version =
      capability === 'runtime-history-v3' ? 3 : capability === 'runtime-telemetry-v2' ? 2 : 1,
    frameLimit = version === 3 ? 768 * 1024 : 8192
  let available = false,
    failed = false,
    nextID = 0,
    buffer = Buffer.alloc(0),
    active: { id: number; action: ReadAction; finish(value: RuntimeResult): void } | undefined
  const retired = new Map<
    number,
    { action: ReadAction; remaining(): number; timer: ReturnType<typeof setTimeout> }
  >()
  let helloDone!: (value: boolean) => void
  const hello = new Promise<boolean>((resolve) => (helloDone = resolve)),
    helloTimer = setTimeout(() => fail(), timeout)
  const fail = (): void => {
    failed = true
    available = false
    clearTimeout(helloTimer)
    helloDone(false)
    active?.finish({ status: 'unavailable' })
    for (const value of retired.values()) clearTimeout(value.timer)
    retired.clear()
  }
  const bound = (raw: Record<string, unknown>): boolean =>
    raw.version === version &&
    raw.sessionId === binding.sessionId &&
    raw.evidenceSHA256 === binding.evidenceSHA256 &&
    raw.runtimeConfigurationSHA256 === binding.runtimeConfigurationSHA256
  const receive = (bytes: Buffer): void => {
    const raw = parseTunHostFrame(bytes, frameLimit)
    if (!object(raw) || !bound(raw)) throw new Error('只读回执身份无效。')
    if (!available) {
      if (
        failed ||
        !keys(
          raw,
          'version,kind,capability,sessionId,evidenceSHA256,runtimeConfigurationSHA256,launchClientSHA256,installationRevision'
        ) ||
        raw.kind !== 'hello' ||
        raw.capability !== capability ||
        raw.launchClientSHA256 !== binding.launchClientSHA256 ||
        raw.installationRevision !== binding.installationRevision
      )
        throw new Error('只读能力未确认。')
      available = true
      clearTimeout(helloTimer)
      helloDone(true)
      return
    }
    if (
      (raw.action !== 'capture' &&
        !(version >= 2 && raw.action === 'traffic') &&
        !(version === 3 && raw.action === 'connections')) ||
      !Number.isInteger(raw.id) ||
      Number(raw.id) < 1 ||
      Number(raw.id) > 0x7fffffff ||
      !keys(
        raw,
        `version,id,action,sessionId,evidenceSHA256,runtimeConfigurationSHA256,status${raw.status === 'captured' ? ',snapshot' : raw.status === 'sampled' ? ',rawFrameBase64' : raw.status === 'connections' ? ',rawConnectionsBase64' : ''}`
      )
    )
      throw new Error('只读响应无效。')
    const action = raw.action as ReadAction
    let result: RuntimeResult
    if (raw.status === 'captured' && action === 'capture') {
      const value = raw.snapshot
      if (
        !object(value) ||
        !keys(value, 'originalLoadedSHA256,originalLoadedBytes,mode,ports') ||
        value.originalLoadedSHA256 !== binding.runtimeConfigurationSHA256 ||
        !Number.isInteger(value.originalLoadedBytes) ||
        Number(value.originalLoadedBytes) < 1 ||
        Number(value.originalLoadedBytes) > 512 * 1024 ||
        (value.mode !== 'rule' && value.mode !== 'global' && value.mode !== 'direct') ||
        !Array.isArray(value.ports) ||
        value.ports.length < 1 ||
        value.ports.length > 2
      )
        throw new Error('已加载正文证据无效。')
      const ports: TunRuntimeSnapshot['ports'] = []
      for (const port of value.ports) {
        if (
          !object(port) ||
          !keys(port, 'kind,port,ownership') ||
          (port.kind !== 'http' && port.kind !== 'mixed') ||
          port.ownership !== 'held-child-pcb-v1' ||
          !Number.isInteger(port.port) ||
          Number(port.port) < 1024 ||
          Number(port.port) > 65535 ||
          ports.some((before) => before.kind === port.kind || before.port === port.port) ||
          (ports.length > 0 && port.kind !== 'mixed')
        )
          throw new Error('持有监听证据无效。')
        ports.push({ kind: port.kind, port: Number(port.port), ownership: port.ownership })
      }
      result = {
        status: 'captured',
        snapshot: {
          originalLoadedSHA256: value.originalLoadedSHA256,
          originalLoadedBytes: Number(value.originalLoadedBytes),
          mode: value.mode,
          ports
        }
      }
    } else if (raw.status === 'connections' && action === 'connections' && version === 3) {
      const encoded = raw.rawConnectionsBase64
      if (
        typeof encoded !== 'string' ||
        encoded.length > Math.ceil(trafficHistoryConnectionsByteLimit / 3) * 4
      )
        throw new Error('连接历史快照超限。')
      const bytes = Buffer.from(encoded, 'base64')
      if (
        !bytes.length ||
        bytes.toString('base64') !== encoded ||
        bytes.length > trafficHistoryConnectionsByteLimit
      )
        throw new Error('连接历史快照无效。')
      result = {
        status: 'connections',
        snapshot: trafficHistoryConnections(
          parseTunHostFrame(bytes, trafficHistoryConnectionsByteLimit)
        )
      }
    } else if (raw.status === 'sampled' && action === 'traffic') {
      const encoded = raw.rawFrameBase64
      if (typeof encoded !== 'string' || encoded.length > Math.ceil(ownedTrafficByteLimit / 3) * 4)
        throw new Error('统计帧超限。')
      const bytes = Buffer.from(encoded, 'base64')
      if (
        bytes.toString('base64') !== encoded ||
        bytes.length < 2 ||
        bytes.length > ownedTrafficByteLimit ||
        bytes.at(-1) !== 10 ||
        bytes.indexOf(10) !== bytes.length - 1
      )
        throw new Error('统计帧无效。')
      result = { status: 'sampled', frame: parseOwnedTrafficFrame(bytes.subarray(0, -1)) }
    } else if (
      raw.status === 'busy' ||
      raw.status === 'unsupported' ||
      raw.status === 'unavailable'
    )
      result = { status: raw.status }
    else throw new Error('只读状态无效。')
    const retiredFlight = retired.get(Number(raw.id))
    if (retiredFlight) {
      if (retiredFlight.action !== action || retiredFlight.remaining() <= 0)
        throw new Error('只读请求类型或期限不匹配。')
      clearTimeout(retiredFlight.timer)
      retired.delete(Number(raw.id))
      return
    }
    if (!active || active.id !== raw.id || active.action !== action)
      throw new Error('只读请求不匹配。')
    active.finish(result)
  }
  io.onGone(fail)
  io.onFault(fail)
  io.onData((chunk) => {
    if (failed) return
    let offset = 0
    try {
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset),
          end = newline < 0 ? chunk.length : newline,
          part = chunk.subarray(offset, end)
        if (buffer.length + part.length > frameLimit) throw new Error('只读帧超限。')
        buffer = Buffer.concat([buffer, part])
        if (newline < 0) return
        const line = buffer
        buffer = Buffer.alloc(0)
        offset = newline + 1
        receive(line)
      }
    } catch {
      fail()
    }
  })
  const read = async (action: ReadAction, signal: AbortSignal): Promise<RuntimeResult> => {
    if ((action === 'traffic' && version < 2) || (action === 'connections' && version !== 3))
      return { status: 'unsupported' }
    const wallStart = Date.now(),
      monoStart = performance.now()
    let lastWall = wallStart,
      lastMono = monoStart
    const remaining = (): number => {
      const wall = Date.now(),
        mono = performance.now()
      if (!Number.isFinite(wall) || !Number.isFinite(mono) || wall < lastWall || mono < lastMono)
        return 0
      lastWall = wall
      lastMono = mono
      return Math.max(0, Math.min(timeout - (wall - wallStart), timeout - (mono - monoStart)))
    }
    if (signal.aborted) return { status: 'unavailable' }
    if (!(await hello) || failed) return { status: 'unsupported' }
    if (signal.aborted) return { status: 'unavailable' }
    if (active || retired.size) return { status: 'busy' }
    const timeLeft = remaining()
    if (timeLeft <= 0) return { status: 'unavailable' }
    if (nextID >= 0x7fffffff) {
      fail()
      return { status: 'unavailable' }
    }
    return new Promise<RuntimeResult>((resolve) => {
      const id = ++nextID,
        abort = (): void => {
          // Native still owns this single flight. Cancellation releases the
          // caller, not the pending native slot or its original deadline.
          retired.set(id, { action, remaining, timer: setTimeout(fail, remaining()) })
          active?.finish({ status: 'unavailable' })
        },
        timer = setTimeout(fail, timeLeft),
        finish = (value: RuntimeResult): void => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          active = undefined
          if (remaining() <= 0) {
            fail()
            resolve({ status: 'unavailable' })
          } else resolve(value)
        }
      active = { id, action, finish }
      signal.addEventListener('abort', abort, { once: true })
      try {
        io.write(
          JSON.stringify({
            version,
            id,
            action,
            sessionId: binding.sessionId,
            evidenceSHA256: binding.evidenceSHA256,
            runtimeConfigurationSHA256: binding.runtimeConfigurationSHA256
          }) + '\n'
        )
      } catch {
        fail()
      }
    })
  }
  return {
    isAvailable: () => available && !failed,
    supportsConnections: () => version === 3 && available && !failed,
    async capture(signal) {
      const result = await read('capture', signal)
      return result.status === 'sampled' || result.status === 'connections'
        ? { status: 'unavailable' }
        : result
    },
    async traffic(signal) {
      const result = await read('traffic', signal)
      return result.status === 'captured' || result.status === 'connections'
        ? { status: 'unavailable' }
        : result
    },
    async connections(signal) {
      const result = await read('connections', signal)
      return result.status === 'captured' || result.status === 'sampled'
        ? { status: 'unavailable' }
        : result
    }
  }
}
