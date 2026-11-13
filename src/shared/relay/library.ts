export type RelayLibraryKind = 'profile' | 'source'
export interface RelayLibraryItem {
  kind: RelayLibraryKind
  id: string
  name: string
  revision: string
  hidden: boolean
  active: boolean
  protectionReason?: string
  ownerRevision: string
  scheduled: boolean
}
export interface RelayLibraryInventory {
  revision: string
  items: RelayLibraryItem[]
}
export type RelayLibraryChange = {
  kind: RelayLibraryKind
  id: string
  expectedRevision: string
} & (
  | { action: 'rename'; name: string }
  | { action: 'hide' | 'restore' }
  | { action: 'move'; direction: 'up' | 'down' }
)
export const RELAY_LIBRARY_CHANNELS = ['relayLibraryList', 'relayLibraryChange'] as const
export const libraryId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value))
    throw new Error('库条目身份无效。')
  return value
}
export const libraryName = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim() !== value ||
    value.length > 120 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('库显示名称无效。')
  return value
}
export function libraryChange(input: unknown): RelayLibraryChange {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('库修改无效。')
  const raw = input as Record<string, unknown>
  if (
    (raw.kind !== 'profile' && raw.kind !== 'source') ||
    typeof raw.expectedRevision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(raw.expectedRevision)
  )
    throw new Error('请重新读取库列表。')
  const base: Pick<RelayLibraryChange, 'kind' | 'id' | 'expectedRevision'> = {
    kind: raw.kind,
    id: libraryId(raw.id),
    expectedRevision: raw.expectedRevision
  }
  const keys = Object.keys(raw).sort().join(',')
  if (raw.action === 'rename' && keys === 'action,expectedRevision,id,kind,name')
    return { ...base, action: 'rename', name: libraryName(raw.name) }
  if (
    (raw.action === 'hide' || raw.action === 'restore') &&
    keys === 'action,expectedRevision,id,kind'
  )
    return { ...base, action: raw.action }
  if (
    raw.action === 'move' &&
    (raw.direction === 'up' || raw.direction === 'down') &&
    keys === 'action,direction,expectedRevision,id,kind'
  )
    return { ...base, action: 'move', direction: raw.direction }
  throw new Error('库操作字段无效。')
}
