import { profileSelection, type RelayProfileSelection } from './runtime'

export type OwnedCoreObservation = 'none' | 'running' | 'unexpectedExit' | 'unconfirmed'
export interface CoreLifecycleState {
  phase: 'awake' | 'asleep' | 'checking' | 'attention'
  generation: number
  core: OwnedCoreObservation
  localProxy: OwnedCoreObservation
  automaticRestartEnabled: false
  observed: boolean
  warnings: string[]
}
export interface CoreRecordRecoveryReport {
  status: 'clear' | 'stale' | 'liveOrUnknown' | 'archived' | 'uncertain'
  canArchive: boolean
  revision?: string
  archiveID?: string
  warnings: string[]
}
export interface CoreRecordPreparation {
  evidenceId: string
  report: CoreRecordRecoveryReport
}
export interface CoreRecordRecoveryResult {
  status: 'cancelled' | 'archived' | 'failed' | 'uncertain'
  report?: CoreRecordRecoveryReport
  warnings: string[]
}
export interface CoreSelectionSnapshot {
  selection?: RelayProfileSelection
  revision: string
}
export function validateCoreSelectionSnapshot(raw: unknown): CoreSelectionSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('启动来源返回格式无效。')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).some((key) => !['selection', 'revision'].includes(key)) ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.revision)
  )
    throw new Error('启动来源返回内容无效。')
  return {
    revision: value.revision,
    ...(value.selection !== undefined ? { selection: profileSelection(value.selection) } : {})
  }
}
export function validateCoreRecordRecovery(raw: unknown): CoreRecordRecoveryReport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('核心记录返回格式无效。')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) => !['status', 'canArchive', 'revision', 'archiveID', 'warnings'].includes(key)
    ) ||
    !['clear', 'stale', 'liveOrUnknown', 'archived', 'uncertain'].includes(String(value.status)) ||
    typeof value.canArchive !== 'boolean' ||
    value.canArchive !== (value.status === 'stale') ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 16 ||
    value.warnings.some((line) => typeof line !== 'string' || line.length > 2048)
  )
    throw new Error('核心记录状态或说明无效。')
  if (
    value.status === 'clear'
      ? value.revision !== undefined
      : typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(value.revision)
  )
    throw new Error('核心记录修订无效。')
  const archived = value.status === 'archived' || value.status === 'uncertain'
  if (
    archived
      ? typeof value.archiveID !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.archiveID)
      : value.archiveID !== undefined
  )
    throw new Error('核心归档标识无效。')
  return {
    status: value.status as CoreRecordRecoveryReport['status'],
    canArchive: value.canArchive,
    ...(typeof value.revision === 'string' ? { revision: value.revision } : {}),
    ...(typeof value.archiveID === 'string' ? { archiveID: value.archiveID } : {}),
    warnings: value.warnings as string[]
  }
}
