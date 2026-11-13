export type RelayCoreMode = 'rule' | 'global' | 'direct'
export interface RelayCoreState {
  phase: 'unknown' | 'idle' | 'starting' | 'running' | 'stopping' | 'blocked' | 'failed'
  mode: RelayCoreMode
  pending: boolean
  hasRecord: boolean
  owned: boolean
  uncertain: boolean
  trafficEnabled: false
  version?: string
  warnings: string[]
}
export interface RelayCorePreparation {
  evidenceId: string
  mode: RelayCoreMode
  version: string
  canStart: boolean
  hasRecord: boolean
  warnings: string[]
}
export interface RelayCoreResult {
  status: 'cancelled' | 'started' | 'stopped' | 'failed' | 'uncertain'
  state: RelayCoreState
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('核心消息格式无效。')
  return raw as Record<string, unknown>
}
export function validateCoreMode(raw: unknown): RelayCoreMode {
  if (raw !== 'rule' && raw !== 'global' && raw !== 'direct') throw new Error('核心模式无效。')
  return raw
}
export function validateCorePrepare(raw: unknown): RelayCoreMode {
  const input = object(raw)
  if (Object.keys(input).length !== 1) throw new Error('核心准备只接受模式，不接受路径或配置文本。')
  return validateCoreMode(input.mode)
}
export function validateCoreAction(
  raw: unknown
): { action: 'start'; evidenceId: string } | { action: 'stop' } {
  const value = object(raw)
  if (value.action === 'stop' && Object.keys(value).length === 1) return { action: 'stop' }
  if (
    value.action === 'start' &&
    Object.keys(value).sort().join(',') === 'action,evidenceId' &&
    typeof value.evidenceId === 'string' &&
    /^[a-f0-9-]{36}$/u.test(value.evidenceId)
  )
    return { action: 'start', evidenceId: value.evidenceId }
  throw new Error('只接受固定的核心启动证据或停止当前实例操作。')
}
