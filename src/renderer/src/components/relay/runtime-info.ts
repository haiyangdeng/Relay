import { includesIgnoreCase } from '../../utils/includes'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import type {
  ConnectionSnapshot,
  RuntimeInfoSnapshot,
  RuntimeLogSnapshot
} from '../../../../shared/relay/observability'

export type RuntimeInfoChannel =
  'relayLocalProxyState' | 'relayConnections' | 'relayLogSnapshot' | 'relayRuntimeInfo'

export interface RuntimeObservation {
  state: LocalProxyState
  info: RuntimeInfoSnapshot
  connections: ConnectionSnapshot | undefined
  logs: RuntimeLogSnapshot
  sampledAt: number
}

export function sameObservedRuntime(a: LocalProxyState, b: LocalProxyState): boolean {
  return (
    a.instanceId === b.instanceId &&
    a.configurationRevision === b.configurationRevision &&
    a.pid === b.pid &&
    a.phase === b.phase &&
    a.pending === b.pending &&
    a.uncertain === b.uncertain &&
    a.traffic === b.traffic &&
    a.owned === b.owned
  )
}

export async function readRuntimeObservation(
  invoke: (channel: RuntimeInfoChannel) => Promise<unknown>,
  now = () => performance.now()
): Promise<RuntimeObservation> {
  const before = (await invoke('relayLocalProxyState')) as LocalProxyState
  if (before.pending) throw new Error('本次核心操作尚未结束。')
  const [info, { connections, sampledAt }, logs] = (await Promise.all([
    invoke('relayRuntimeInfo'),
    invoke('relayConnections').then((connections) => ({ connections, sampledAt: now() })),
    invoke('relayLogSnapshot')
  ])) as [
    RuntimeInfoSnapshot,
    { connections: ConnectionSnapshot | undefined; sampledAt: number },
    RuntimeLogSnapshot
  ]
  const after = (await invoke('relayLocalProxyState')) as LocalProxyState
  if (
    !sameObservedRuntime(before, after) ||
    info.process.instanceId !== after.instanceId ||
    info.process.configurationRevision !== after.configurationRevision ||
    info.process.pid !== after.pid ||
    info.process.phase !== after.phase
  )
    throw new Error('读取期间实例或配置已变化，请重新读取。')
  if (after.phase === 'running' && !connections) throw new Error('本次核心连接快照未能读取。')
  if (!logs || !Array.isArray(logs.lines)) throw new Error('本次核心日志快照未能读取。')
  return { state: after, info, connections, logs, sampledAt }
}

export function observedTrafficRate(
  previous: RuntimeObservation | undefined,
  current: RuntimeObservation
): { download: number; upload: number } | undefined {
  if (
    !previous ||
    !sameObservedRuntime(previous.state, current.state) ||
    !previous.connections ||
    !current.connections ||
    current.sampledAt <= previous.sampledAt
  )
    return undefined
  const download = current.connections.download - previous.connections.download,
    upload = current.connections.upload - previous.connections.upload,
    seconds = (current.sampledAt - previous.sampledAt) / 1000
  return download >= 0 && upload >= 0
    ? { download: download / seconds, upload: upload / seconds }
    : undefined
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''

export interface ObservedConnection {
  id: string
  target: string
  source?: string
  protocol?: string
  rule?: string
  process: string
  route: string
  startedAt?: number
  upload?: number
  download?: number
}

interface ObservedConnectionRates {
  uploadRate?: number
  downloadRate?: number
}

const measuredBytes = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

function connectionId(value: unknown): string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
    ? value
    : ''
}

export function observedConnection(value: unknown): ObservedConnection {
  const connection = record(value),
    metadata = record(connection.metadata),
    startedAt = typeof connection.start === 'string' ? Date.parse(connection.start) : NaN
  return {
    id: connectionId(connection.id),
    target: `${text(metadata.host) || text(metadata.destinationIP) || '未知目标'}${metadata.destinationPort ? `:${text(metadata.destinationPort)}` : ''}`,
    source: text(metadata.sourceIP) || undefined,
    protocol:
      [text(metadata.type), text(metadata.network).toUpperCase()].filter(Boolean).join(' · ') ||
      undefined,
    rule:
      [text(connection.rule), text(connection.rulePayload)].filter(Boolean).join(': ') || undefined,
    process: text(metadata.process) || text(metadata.processPath) || '未提供进程信息',
    route: Array.isArray(connection.chains)
      ? connection.chains.filter((item): item is string => typeof item === 'string').join(' → ')
      : '',
    startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
    upload: measuredBytes(connection.upload),
    download: measuredBytes(connection.download)
  }
}

export const observedConnectionLimit = 200
export type ObservedConnectionOrder =
  'snapshot' | 'startedAt' | 'upload' | 'download' | 'uploadRate' | 'downloadRate'

function comparableConnectionSamples(
  previous: RuntimeObservation | undefined,
  current: RuntimeObservation
): { before: ConnectionSnapshot; after: ConnectionSnapshot; seconds: number } | undefined {
  const state = current.state
  if (
    !previous?.connections ||
    !current.connections ||
    !state.owned ||
    state.phase !== 'running' ||
    !state.instanceId ||
    !state.configurationRevision ||
    !state.pid ||
    state.pending ||
    state.uncertain ||
    !sameObservedRuntime(previous.state, state)
  )
    return undefined
  const seconds = (current.sampledAt - previous.sampledAt) / 1000
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return { before: previous.connections, after: current.connections, seconds }
}

function uniqueObservedConnections(
  connections: readonly unknown[]
): Map<string, ObservedConnection | null> {
  const samples = new Map<string, ObservedConnection | null>()
  for (const raw of connections.slice(0, observedConnectionLimit)) {
    const sample = observedConnection(raw)
    if (sample.id) samples.set(sample.id, samples.has(sample.id) ? null : sample)
  }
  return samples
}

export function observedConnectionRates(
  previous: RuntimeObservation | undefined,
  current: RuntimeObservation
): ReadonlyMap<string, ObservedConnectionRates> {
  const rates = new Map<string, ObservedConnectionRates>()
  const samples = comparableConnectionSamples(previous, current)
  if (!samples) return rates
  const { before, after, seconds } = samples
  const perSecond = (before?: number, after?: number): number | undefined =>
    before === undefined || after === undefined
      ? undefined
      : measuredBytes((after - before) / seconds)
  const prior = uniqueObservedConnections(before.connections)
  for (const [id, row] of uniqueObservedConnections(after.connections)) {
    const last = prior.get(id)
    if (!last || row?.startedAt === undefined || row.startedAt !== last.startedAt) continue
    const uploadRate = perSecond(last.upload, row.upload)
    const downloadRate = perSecond(last.download, row.download)
    if (uploadRate !== undefined || downloadRate !== undefined)
      rates.set(id, { uploadRate, downloadRate })
  }
  return rates
}

export function observedClosedConnections(
  previous: RuntimeObservation | undefined,
  current: RuntimeObservation,
  retained: readonly ObservedConnection[]
): ObservedConnection[] {
  const samples = comparableConnectionSamples(previous, current)
  if (!samples) return []
  const candidates = new Map<string, ObservedConnection>()
  for (const [id, row] of uniqueObservedConnections(samples.before.connections)) {
    if (row?.startedAt !== undefined) candidates.set(id, row)
  }
  for (const row of retained) {
    if (!candidates.has(row.id)) candidates.set(row.id, row)
  }
  // Read the full response. A row that falls out of the visible prefix can
  // still be active, and an unreadable ID cannot establish a disappearance.
  for (const raw of samples.after.connections) {
    const id = connectionId(record(raw).id)
    if (!id) return []
    candidates.delete(id)
  }
  return Array.from(candidates.values()).slice(0, observedConnectionLimit)
}

export function displayedConnections(
  connections: readonly unknown[],
  query: string,
  order: ObservedConnectionOrder,
  descending: boolean,
  rates?: ReadonlyMap<string, ObservedConnectionRates>
): (ObservedConnection & ObservedConnectionRates & { position: number })[] {
  // The Main icon lease covers this exact bounded prefix. Sorting or filtering
  // must not introduce rows outside the lease's snapshot.
  const rows = connections.slice(0, observedConnectionLimit).map((value) => {
    const row = observedConnection(value)
    return { ...row, ...rates?.get(row.id) }
  })
  return displayedObservedConnections(rows, query, order, descending)
}

export function displayedObservedConnections(
  connections: readonly (ObservedConnection & ObservedConnectionRates)[],
  query: string,
  order: ObservedConnectionOrder,
  descending: boolean
): (ObservedConnection & ObservedConnectionRates & { position: number })[] {
  const filter = query.trim()
  const rows = connections.map((row, position) => ({ ...row, position }))
  const visible = filter
    ? rows.filter((row) =>
        [row.target, row.source, row.process, row.route, row.protocol, row.rule].some(
          (value) => value !== undefined && includesIgnoreCase(value, filter)
        )
      )
    : rows
  if (order === 'snapshot') return visible
  return visible.sort((a, b) => {
    const first = a[order],
      second = b[order]
    if (first === undefined) return second === undefined ? 0 : 1
    if (second === undefined) return -1
    return descending ? second - first : first - second
  })
}

export interface RuntimeLogCursor {
  instanceId: string
  pid: number
  sequence: number
}

export function runtimeLogCursor(observation: RuntimeObservation): RuntimeLogCursor | undefined {
  const { owned, instanceId, pid } = observation.state
  if (owned && instanceId && pid) return { instanceId, pid, sequence: observation.logs.sequence }
  return undefined
}

export function runtimeLogLines(
  observation: RuntimeObservation | undefined,
  cleared: RuntimeLogCursor | undefined
): string[] {
  if (!observation) return []
  const current = runtimeLogCursor(observation)
  const after =
    cleared && current?.instanceId === cleared.instanceId && current.pid === cleared.pid
      ? cleared.sequence
      : 0
  return observation.logs.lines.filter((line) => line.sequence > after).map((line) => line.text)
}

const logLevels = { error: 0, warning: 1, info: 2, debug: 3 } as const
export type ObservedLogLevel = 'all' | keyof typeof logLevels

export function observedLog(
  line: string
): { type: Exclude<ObservedLogLevel, 'all'>; time: string; payload: string } | undefined {
  // Parse only the Core's leading logfmt fields. A message containing "level="
  // must never manufacture a severity, and historical logs keep their own time.
  const match =
    /^time="([^"\r\n]+)" level=(error|warn(?:ing)?|info|debug) msg=("(?:[^"\\]|\\.)*")(.*)$/u.exec(
      line
    )
  if (!match) return undefined
  try {
    const message: unknown = JSON.parse(match[3])
    if (typeof message !== 'string') return undefined
    return {
      type: (match[2] === 'warn' ? 'warning' : match[2]) as Exclude<ObservedLogLevel, 'all'>,
      time: match[1],
      payload: `${message}${match[4]}`
    }
  } catch {
    return undefined
  }
}

export function displayedLogs(
  lines: readonly string[],
  query: string,
  maximumLevel: ObservedLogLevel
): string[] {
  const filter = query.trim()
  return lines.filter((line) => {
    if (filter && !includesIgnoreCase(line, filter)) return false
    if (maximumLevel === 'all') return true
    // The bundled Core produces a logfmt timestamp and level before its message.
    const rawLevel = /^time="[^"\r\n]+" level=(error|warn(?:ing)?|info|debug)(?=\s|$)/u.exec(
      line
    )?.[1]
    const level = rawLevel === 'warn' ? 'warning' : rawLevel
    return (
      level !== undefined && logLevels[level as keyof typeof logLevels] <= logLevels[maximumLevel]
    )
  })
}

export function formatTraffic(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '未读取'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let unit = 0
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024
    ++unit
  }
  return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`
}
