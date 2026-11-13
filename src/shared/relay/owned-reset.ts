export const RELAY_OWNED_RESET_CHANNELS = ['relayOwnedResetState', 'relayOwnedResetAction'] as const
export type OwnedResetMode = 'normal' | 'maintenance'
export type OwnedResetObservedMode = OwnedResetMode | 'unacquired'
export const ownedResetPhases = [
  'unavailable',
  'idle',
  'held',
  'resetScheduled',
  'restoreScheduled',
  'resetCompleted',
  'restoreCompleted',
  'cancelled',
  'uncertain'
] as const
export interface OwnedResetReport {
  phase: (typeof ownedResetPhases)[number]
  mode: OwnedResetObservedMode
  lockHeld: boolean
  canReset: boolean
  canRestore: boolean
  evidenceID?: string
  restartRequired: boolean
  rootPathSHA256?: string
  reason?: string
}
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
export function ownedResetID(raw: unknown): string {
  if (typeof raw !== 'string' || !uuid.test(raw)) throw new Error('自有数据维护凭据无效。')
  return raw
}
export function ownedResetReport(raw: unknown): OwnedResetReport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('自有数据维护状态未确认。')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'phase',
          'mode',
          'lockHeld',
          'canReset',
          'canRestore',
          'evidenceID',
          'restartRequired',
          'reason',
          'rootPathSHA256'
        ].includes(key)
    ) ||
    typeof value.phase !== 'string' ||
    !ownedResetPhases.includes(value.phase as OwnedResetReport['phase']) ||
    !['normal', 'maintenance', 'unacquired'].includes(String(value.mode)) ||
    ['lockHeld', 'canReset', 'canRestore', 'restartRequired'].some(
      (key) => typeof value[key] !== 'boolean'
    ) ||
    (value.reason !== undefined &&
      (typeof value.reason !== 'string' ||
        value.reason.length > 1024 ||
        Array.from(value.reason).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )))
  )
    throw new Error('自有数据维护状态未知。')
  if (value.evidenceID !== undefined) ownedResetID(value.evidenceID)
  if (
    value.rootPathSHA256 !== undefined &&
    (typeof value.rootPathSHA256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.rootPathSHA256))
  )
    throw new Error('原生数据根身份未知。')
  if (value.lockHeld === true && !value.rootPathSHA256) throw new Error('持锁回执缺少固定根身份。')
  if (
    (value.canReset === true || value.canRestore === true) &&
    (!value.lockHeld || !value.evidenceID)
  )
    throw new Error('维护准入缺少原生独占凭据。')
  if (
    value.mode === 'unacquired' &&
    (value.lockHeld || value.canReset || value.canRestore || value.evidenceID)
  )
    throw new Error('未取得原生模式不能签发维护能力。')
  if (value.phase === 'unavailable' && (value.canReset || value.canRestore))
    throw new Error('不可用状态不能提供维护动作。')
  if (
    value.mode === 'normal' &&
    ['resetScheduled', 'restoreScheduled'].includes(value.phase) &&
    value.restartRequired !== true
  )
    throw new Error('待启动维护记录必须保留启动屏障。')
  return value as unknown as OwnedResetReport
}
