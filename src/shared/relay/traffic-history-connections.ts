import type { TrafficUsageConnectionSnapshot } from '../trafficUsage'
export const trafficHistoryConnectionsByteLimit = 512 * 1024
export function trafficHistoryConnections(input: unknown): TrafficUsageConnectionSnapshot {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('连接历史快照无效。')
    return value as Record<string, unknown>
  }
  const text = (value: unknown, required = false): string | undefined => {
    if (value === undefined && !required) return undefined
    if (
      typeof value !== 'string' ||
      value.length > 1024 ||
      (required && !value) ||
      [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new Error('连接历史名称无效。')
    return value
  }
  const count = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new Error('连接历史计数无效。')
    return value
  }
  const raw = object(input)
  if (
    Object.keys(raw).sort().join(',') !== 'connections,downloadTotal,uploadTotal' ||
    !Array.isArray(raw.connections) ||
    raw.connections.length > 10000
  )
    throw new Error('连接历史快照字段无效。')
  const connections = raw.connections.map((entry) => {
    const row = object(entry),
      metadata = object(row.metadata)
    if (
      Object.keys(row).some(
        (key) => !['id', 'start', 'upload', 'download', 'chains', 'metadata'].includes(key)
      ) ||
      Object.keys(metadata).some(
        (key) => !['sourceIP', 'host', 'destinationIP', 'process'].includes(key)
      )
    )
      throw new Error('连接历史快照字段无效。')
    const id = text(row.id, true),
      start = text(row.start, true)
    if (!id || !start) throw new Error('连接历史身份无效。')
    if (!Number.isFinite(Date.parse(start))) throw new Error('连接历史开始时间无效。')
    if (row.chains !== undefined && (!Array.isArray(row.chains) || row.chains.length > 64))
      throw new Error('连接历史出口无效。')
    const chains = (row.chains as unknown[] | undefined)?.map((value) => {
      const checked = text(value, true)
      if (!checked) throw new Error('连接历史出口无效。')
      return checked
    })
    return {
      id,
      start,
      upload: count(row.upload),
      download: count(row.download),
      chains: chains?.length ? chains : ['Unknown'],
      metadata: {
        sourceIP: text(metadata.sourceIP),
        host: text(metadata.host),
        destinationIP: text(metadata.destinationIP),
        process: text(metadata.process)
      }
    }
  })
  return {
    connections,
    uploadTotal: count(raw.uploadTotal),
    downloadTotal: count(raw.downloadTotal)
  }
}
