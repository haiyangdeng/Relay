export type CoreOwnerPhase =
  | 'unavailable'
  | 'unknown'
  | 'absent'
  | 'reserved'
  | 'starting'
  | 'ready'
  | 'detachPrepared'
  | 'detached'
  | 'stopping'
  | 'closed'
  | 'uncertain'
  | 'released'
export interface CoreOwnerState {
  phase: CoreOwnerPhase
  pending: boolean
  hasRecord: boolean
  attached: boolean
  canDetach: boolean
  canReattach: boolean
  canStop: boolean
  canArchive: boolean
  canFinalize: boolean
  sessionId?: string
  httpPort?: number
  warnings: string[]
}
export function readCoreOwnerState(value: unknown): CoreOwnerState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('持久代理状态无效。')
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'phase',
          'pending',
          'hasRecord',
          'attached',
          'canDetach',
          'canReattach',
          'canStop',
          'canArchive',
          'canFinalize',
          'sessionId',
          'httpPort',
          'warnings'
        ].includes(key)
    ) ||
    ![
      'unavailable',
      'unknown',
      'absent',
      'reserved',
      'starting',
      'ready',
      'detachPrepared',
      'detached',
      'stopping',
      'closed',
      'uncertain',
      'released'
    ].includes(String(input.phase)) ||
    [
      'pending',
      'hasRecord',
      'attached',
      'canDetach',
      'canReattach',
      'canStop',
      'canArchive',
      'canFinalize'
    ].some((key) => typeof input[key] !== 'boolean') ||
    (input.sessionId !== undefined &&
      (typeof input.sessionId !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input.sessionId))) ||
    (input.httpPort !== undefined &&
      (typeof input.httpPort !== 'number' ||
        !Number.isInteger(input.httpPort) ||
        input.httpPort < 1024 ||
        input.httpPort > 65535)) ||
    !Array.isArray(input.warnings) ||
    input.warnings.length > 16 ||
    input.warnings.some((warning) => typeof warning !== 'string' || warning.length > 512)
  )
    throw new Error('持久代理状态或预算无效。')
  return {
    phase: input.phase as CoreOwnerPhase,
    pending: input.pending as boolean,
    hasRecord: input.hasRecord as boolean,
    attached: input.attached as boolean,
    canDetach: input.canDetach as boolean,
    canReattach: input.canReattach as boolean,
    canStop: input.canStop as boolean,
    canArchive: input.canArchive as boolean,
    canFinalize: input.canFinalize as boolean,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId as string }),
    ...(input.httpPort === undefined ? {} : { httpPort: input.httpPort as number }),
    warnings: [...input.warnings] as string[]
  }
}
export function coreOwnerAction(
  value: unknown
): 'inspect' | 'reattach' | 'stop' | 'archive' | 'finalize' {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'action' ||
    !['inspect', 'reattach', 'stop', 'archive', 'finalize'].includes(
      String((value as { action?: unknown }).action)
    )
  )
    throw new Error('持久代理操作只接受固定动作，不接受路径、PID或发布身份。')
  return (value as { action: 'inspect' | 'reattach' | 'stop' | 'archive' | 'finalize' }).action
}
