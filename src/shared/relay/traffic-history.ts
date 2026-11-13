import {
  TRAFFIC_USAGE_RESOLUTIONS,
  TRAFFIC_USAGE_MIGRATION_CHUNK_SIZE,
  type TrafficUsageDimension,
  type TrafficUsageImportBatch,
  type TrafficUsageBreakdownQuery
} from '../trafficUsage'

export interface TrafficHistoryOwner {
  instanceId: string
  configurationRevision: string
  kind?: 'tun-managed'
  evidenceSHA256?: string
}
export interface TrafficHistoryState {
  recording: boolean
  pending: boolean
  owner?: TrafficHistoryOwner
  availableOwner?: TrafficHistoryOwner
  importAuthorized: boolean
  writeRecoveryRequired: boolean
  clearRecoveryRequired: boolean
  sampledSnapshots: number
  droppedRecords: number
  passiveOnly: true
  warning?: string
}
export const TRAFFIC_HISTORY_CHANNELS = [
  'relayTrafficHistoryState',
  'relayTrafficHistoryReadTun',
  'relayTrafficHistoryRecord',
  'relayTrafficHistoryStop',
  'relayTrafficHistoryRetry',
  'relayTrafficHistoryImportAuthorize'
] as const
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('历史统计消息无效。')
  return value as Record<string, unknown>
}
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('历史统计数值无效。')
  return value
}
const label = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('历史统计名称无效。')
  return value
}
export function trafficHistoryDimension(value: unknown): TrafficUsageDimension {
  if (value !== 'sourceIP' && value !== 'host' && value !== 'outbound' && value !== 'process')
    throw new Error('历史统计维度无效。')
  return value
}
export function trafficHistoryRange(start: unknown, end: unknown): { start: number; end: number } {
  const from = integer(start),
    to = integer(end)
  if (from > to || to - from > 31 * 86400000) throw new Error('历史统计最多查询31天。')
  return { start: from, end: to }
}
export function trafficHistoryBucket(value: unknown): number {
  const bucket = integer(value)
  if (bucket < TRAFFIC_USAGE_RESOLUTIONS[0] || bucket > 86400000 || bucket % 60000 !== 0)
    throw new Error('历史统计时间桶无效。')
  return bucket
}
export function trafficHistoryBreakdown(input: unknown): TrafficUsageBreakdownQuery {
  const raw = object(input)
  if (Object.keys(raw).sort().join(',') !== 'endTime,filters,groupBy,startTime')
    throw new Error('历史统计明细字段无效。')
  const range = trafficHistoryRange(raw.startTime, raw.endTime),
    filters = object(raw.filters)
  const accepted: TrafficUsageBreakdownQuery['filters'] = {}
  if (Object.keys(filters).length > 4) throw new Error('历史统计筛选过多。')
  for (const [key, value] of Object.entries(filters))
    accepted[trafficHistoryDimension(key)] = label(value)
  return {
    groupBy: trafficHistoryDimension(raw.groupBy),
    filters: accepted,
    startTime: range.start,
    endTime: range.end
  }
}
export function trafficHistoryOwner(input: unknown): TrafficHistoryOwner {
  const raw = object(input)
  if (
    Object.keys(raw).sort().join(',') !==
      (raw.kind === 'tun-managed'
        ? 'configurationRevision,evidenceSHA256,instanceId,kind'
        : 'configurationRevision,instanceId') ||
    typeof raw.instanceId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(raw.instanceId) ||
    typeof raw.configurationRevision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(raw.configurationRevision)
  )
    throw new Error('请选择当前已确认的自有核心。')
  if (raw.kind === 'tun-managed') {
    if (typeof raw.evidenceSHA256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.evidenceSHA256))
      throw new Error('TUN历史实例证据无效。')
    return {
      kind: 'tun-managed',
      instanceId: raw.instanceId,
      configurationRevision: raw.configurationRevision,
      evidenceSHA256: raw.evidenceSHA256
    }
  }
  return { instanceId: raw.instanceId, configurationRevision: raw.configurationRevision }
}
export function trafficHistoryImport(input: unknown): TrafficUsageImportBatch {
  const raw = object(input)
  if (
    Object.keys(raw).sort().join(',') !== 'id,records' ||
    typeof raw.id !== 'string' ||
    !/^[a-zA-Z0-9:._-]{1,200}$/u.test(raw.id) ||
    !Array.isArray(raw.records) ||
    !raw.records.length ||
    raw.records.length > TRAFFIC_USAGE_MIGRATION_CHUNK_SIZE
  )
    throw new Error('历史导入批次无效或超过500条。')
  const records = raw.records.map((entry) => {
    const record = object(entry)
    if (
      Object.keys(record).sort().join(',') !==
      'bucket,count,download,host,outbound,process,resolution,sourceIP,upload'
    )
      throw new Error('历史导入条目字段无效。')
    const resolution = integer(record.resolution),
      bucket = integer(record.bucket)
    if (
      !TRAFFIC_USAGE_RESOLUTIONS.some((value) => value === resolution) ||
      bucket % resolution !== 0
    )
      throw new Error('历史导入时间桶无效。')
    return {
      resolution,
      bucket,
      sourceIP: label(record.sourceIP),
      host: label(record.host),
      outbound: label(record.outbound),
      process: label(record.process),
      upload: integer(record.upload),
      download: integer(record.download),
      count: integer(record.count)
    }
  })
  return { id: raw.id, records }
}
