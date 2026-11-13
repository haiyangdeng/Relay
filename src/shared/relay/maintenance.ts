export const RELAY_MAINTENANCE_CHANNELS = [
  'relayMaintenanceState',
  'relayMaintenancePrepare',
  'relayMaintenanceExecute',
  'relayMaintenanceCancel',
  'relayMaintenanceRevealHeap'
] as const
export const relayMaintenanceActions = [
  'reset-interface',
  'restore-interface',
  'clear-renderer-cache',
  'export-heap'
] as const
export type RelayMaintenanceAction = (typeof relayMaintenanceActions)[number]
export interface RelayMaintenanceReset {
  id: string
  phase: 'intent' | 'reset' | 'restored' | 'uncertain'
  beforeRevision: string
  beforeSHA256: string
  afterRevision: string | null
}
export interface RelayMaintenancePlan {
  evidenceId: string
  action: RelayMaintenanceAction
  expiresAt: number
  backupId: string | null
}
export interface RelayMaintenanceState {
  pending: boolean
  phase: 'idle' | 'preparing' | 'confirming' | 'executing'
  reset: RelayMaintenanceReset | null
}
export interface RelayHeapExport {
  id: string
  fileName: string
  bytes: number
  sha256: string
  containsSecrets: true
}
export function maintenanceObject(
  raw: unknown,
  fields: readonly string[]
): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== [...fields].sort().join(',')
  )
    throw new Error('本地维护参数或回执无效。')
  return raw as Record<string, unknown>
}
export function maintenanceID(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(raw))
    throw new Error('维护凭据无效。')
  return raw
}
export function maintenanceAction(raw: unknown): RelayMaintenanceAction {
  if (typeof raw !== 'string' || !relayMaintenanceActions.includes(raw as RelayMaintenanceAction))
    throw new Error('本地维护动作未支持。')
  return raw as RelayMaintenanceAction
}
export function maintenanceReset(raw: unknown): RelayMaintenanceReset | null {
  if (raw === null) return null
  const o = maintenanceObject(raw, [
    'id',
    'phase',
    'beforeRevision',
    'beforeSHA256',
    'afterRevision'
  ])
  maintenanceID(o.id)
  if (
    !['intent', 'reset', 'restored', 'uncertain'].includes(String(o.phase)) ||
    typeof o.beforeRevision !== 'string' ||
    !/^(|[a-f0-9]{64})$/u.test(o.beforeRevision) ||
    typeof o.beforeSHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(o.beforeSHA256) ||
    (o.afterRevision !== null &&
      (typeof o.afterRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(o.afterRevision)))
  )
    throw new Error('维护记录未确认。')
  if (['reset', 'restored'].includes(String(o.phase)) && o.afterRevision === null)
    throw new Error('界面维护终态缺少已提交修订。')
  return o as unknown as RelayMaintenanceReset
}
export function readMaintenancePlan(raw: unknown): RelayMaintenancePlan {
  const o = maintenanceObject(raw, ['evidenceId', 'action', 'expiresAt', 'backupId'])
  maintenanceID(o.evidenceId)
  maintenanceAction(o.action)
  if (
    !Number.isSafeInteger(o.expiresAt) ||
    Number(o.expiresAt) < 1 ||
    (o.backupId !== null && typeof o.backupId !== 'string')
  )
    throw new Error('维护准备未确认。')
  if (o.backupId !== null) maintenanceID(o.backupId)
  return o as unknown as RelayMaintenancePlan
}
export function readMaintenanceState(raw: unknown): RelayMaintenanceState {
  const o = maintenanceObject(raw, ['pending', 'phase', 'reset'])
  if (
    typeof o.pending !== 'boolean' ||
    !['idle', 'preparing', 'confirming', 'executing'].includes(String(o.phase))
  )
    throw new Error('维护状态未知。')
  return {
    pending: o.pending,
    phase: o.phase as RelayMaintenanceState['phase'],
    reset: maintenanceReset(o.reset)
  }
}
