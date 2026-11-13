export interface ScopedStorageItem {
  id: string
  revision: string
  phase: 'legacy' | 'creating' | 'created' | 'attaching' | 'mounted' | 'detaching' | 'closed'
  canClose: boolean
  writeClosure: 'unconfirmed' | 'closedForOrdinarySandboxedWriters'
  descendantsExited: false
}
export interface ScopedStorageReport {
  status: 'ok' | 'refused' | 'uncertain'
  reason: string
  pending: boolean
  items: ScopedStorageItem[]
}
const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('私有磁盘数据无效。')
  return raw as Record<string, unknown>
}
export const scopedStorageID = (raw: unknown): string => {
  if (
    typeof raw !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(raw)
  )
    throw new Error('私有磁盘标识无效。')
  return raw
}
export const scopedStorageRevision = (raw: unknown): string => {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/u.test(raw)) throw new Error('私有磁盘版本无效。')
  return raw
}
export function scopedStorageRequest(
  raw: unknown
): { action: 'list' } | { action: 'close'; workspaceID: string; revision: string } {
  const value = object(raw)
  if (value.action === 'list' && Object.keys(value).join(',') === 'action')
    return { action: 'list' }
  if (
    value.action !== 'close' ||
    Object.keys(value).sort().join(',') !== 'action,revision,workspaceID'
  )
    throw new Error('只允许读取或确认关闭固定私有磁盘，不接受路径或设备。')
  return {
    action: 'close',
    workspaceID: scopedStorageID(value.workspaceID),
    revision: scopedStorageRevision(value.revision)
  }
}
export function scopedStorageReport(raw: unknown): ScopedStorageReport {
  const value = object(raw)
  if (
    Object.keys(value).sort().join(',') !== 'items,pending,reason,status' ||
    !['ok', 'refused', 'uncertain'].includes(String(value.status)) ||
    typeof value.reason !== 'string' ||
    !/^[a-zA-Z]{1,64}$/u.test(value.reason) ||
    typeof value.pending !== 'boolean' ||
    !Array.isArray(value.items) ||
    value.items.length > 64
  )
    throw new Error('私有磁盘回执未确认。')
  const seen = new Set<string>()
  const items = value.items.map((raw): ScopedStorageItem => {
    const item = object(raw),
      id = scopedStorageID(item.id)
    if (
      Object.keys(item).sort().join(',') !==
        'canClose,descendantsExited,id,phase,revision,writeClosure' ||
      seen.has(id) ||
      !['legacy', 'creating', 'created', 'attaching', 'mounted', 'detaching', 'closed'].includes(
        String(item.phase)
      ) ||
      typeof item.canClose !== 'boolean' ||
      item.descendantsExited !== false ||
      !['unconfirmed', 'closedForOrdinarySandboxedWriters'].includes(String(item.writeClosure)) ||
      (item.writeClosure === 'closedForOrdinarySandboxedWriters') !== (item.phase === 'closed') ||
      (item.canClose && !['mounted', 'detaching', 'closed'].includes(String(item.phase)))
    )
      throw new Error('私有磁盘状态未确认；不推断进程树退出。')
    seen.add(id)
    return {
      id,
      revision: scopedStorageRevision(item.revision),
      phase: item.phase as ScopedStorageItem['phase'],
      canClose: item.canClose,
      writeClosure: item.writeClosure as ScopedStorageItem['writeClosure'],
      descendantsExited: false
    }
  })
  return {
    status: value.status as ScopedStorageReport['status'],
    reason: value.reason,
    pending: value.pending,
    items
  }
}
