export interface RelayBackupRestorePlan {
  id: string
  baselineSHA256: string
  targetSHA256: string
  archiveSHA256: string
  files: number
  replacedFiles: number
  removedFiles: number
  containsSecrets: true
  preparedAt: number
}
export interface RelayBackupResult {
  status: 'exported' | 'prepared' | 'restored' | 'cancelled' | 'uncertain'
  plan?: RelayBackupRestorePlan
}

export type RelayBackupKeyExportResult =
  { status: 'exported'; recipient: string } | { status: 'cancelled' }

export type RelayBackupRecoveryAction = 'resume' | 'rollback'
export interface RelayBackupRecoveryRecord {
  id: string
  version: 1 | 2 | 'unknown'
  phase: string
  actions: RelayBackupRecoveryAction[]
  reason?: string
  containsSecrets: true
}
export interface RelayBackupRecoveryPlan {
  evidenceId: string
  id: string
  action: RelayBackupRecoveryAction
  recordSHA256: string
  baselineSHA256: string
  targetSHA256: string
  currentSHA256: string
  files: number
  containsSecrets: true
  preparedAt: number
  expiresAt: number
}
export function backupRecoveryDestinationSHA256(plan: RelayBackupRecoveryPlan): string {
  return plan.action === 'rollback' ? plan.baselineSHA256 : plan.targetSHA256
}
export interface RelayBackupRecoveryResult {
  status: 'prepared' | 'restored' | 'rolled-back' | 'cancelled' | 'uncertain'
  plan?: RelayBackupRecoveryPlan
}
