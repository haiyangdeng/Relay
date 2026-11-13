export interface RelayDesktopSnapshot {
  phase: 'idle' | 'starting' | 'active' | 'restoring' | 'recoveryNeeded' | 'blocked'
  busy: boolean
  hasRecord: boolean
  source?: 'relay' | 'legacy'
  canClose: boolean
  requiresRecoveryConsent: boolean
  warnings: string[]
}
export interface RelayDesktopState {
  host: 'absent' | 'running' | 'lost'
  pending: boolean
  uncertain: boolean
  snapshot?: RelayDesktopSnapshot
}
export type RelayDesktopAction = 'start' | 'restore' | 'finish' | 'cancel'
export interface RelayDesktopResult {
  status: 'completed' | 'cancelled' | 'uncertain'
  state: RelayDesktopState
}
export interface RelayDesktopResponse {
  version: 1
  id: number
  snapshot: RelayDesktopSnapshot
  closing: boolean
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('会话消息格式异常。')
  return raw as Record<string, unknown>
}
export function validateDesktopAction(raw: unknown): RelayDesktopAction {
  const value = object(raw)
  if (
    Object.keys(value).length !== 1 ||
    typeof value.action !== 'string' ||
    !['start', 'restore', 'finish', 'cancel'].includes(value.action)
  )
    throw new Error('只接受固定的登录会话操作。')
  return value.action as RelayDesktopAction
}
export function validateDesktopResponse(raw: unknown): RelayDesktopResponse {
  const value = object(raw),
    snapshot = object(value.snapshot)
  if (
    value.version !== 1 ||
    !Number.isInteger(value.id) ||
    Number(value.id) < 1 ||
    Number(value.id) > 1_000_000_000 ||
    typeof value.closing !== 'boolean'
  )
    throw new Error('后台会话响应无效。')
  if (
    !['idle', 'starting', 'active', 'restoring', 'recoveryNeeded', 'blocked'].includes(
      String(snapshot.phase)
    ) ||
    ['busy', 'hasRecord', 'canClose', 'requiresRecoveryConsent'].some(
      (key) => typeof snapshot[key] !== 'boolean'
    ) ||
    !Array.isArray(snapshot.warnings) ||
    snapshot.warnings.length > 16 ||
    snapshot.warnings.some((item) => typeof item !== 'string' || item.length > 1024)
  )
    throw new Error('后台会话状态无效。')
  const source = snapshot.source === undefined ? undefined : snapshot.source
  if (
    (source !== undefined && source !== 'relay' && source !== 'legacy') ||
    snapshot.hasRecord !== (source !== undefined) ||
    (snapshot.busy && snapshot.canClose) ||
    (snapshot.phase === 'active' && (!snapshot.hasRecord || snapshot.canClose)) ||
    (snapshot.requiresRecoveryConsent && (!snapshot.hasRecord || snapshot.canClose)) ||
    (value.closing && (!snapshot.canClose || snapshot.busy || snapshot.hasRecord))
  )
    throw new Error('后台会话结论与证据不一致。')
  return {
    version: 1,
    id: Number(value.id),
    closing: value.closing,
    snapshot: {
      phase: snapshot.phase as RelayDesktopSnapshot['phase'],
      busy: snapshot.busy as boolean,
      hasRecord: snapshot.hasRecord as boolean,
      source,
      canClose: snapshot.canClose as boolean,
      requiresRecoveryConsent: snapshot.requiresRecoveryConsent as boolean,
      warnings: snapshot.warnings as string[]
    }
  }
}
