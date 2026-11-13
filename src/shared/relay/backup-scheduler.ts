import type { RelayBackupAccountSelection } from './backup-accounts'
import type { SourceSchedule } from './subscription-sources'

export type RelayWebdavBackupSchedule = Exclude<SourceSchedule, { kind: 'manual' }>
export interface RelayWebdavRetentionPolicy {
  kind: 'session-owned' | 'recorded-owned'
  keepCount: number
}
export function webdavRetentionPolicy(raw: unknown): RelayWebdavRetentionPolicy {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'keepCount,kind' ||
    !('kind' in raw) ||
    (raw.kind !== 'session-owned' && raw.kind !== 'recorded-owned') ||
    !('keepCount' in raw) ||
    typeof raw.keepCount !== 'number' ||
    !Number.isInteger(raw.keepCount) ||
    raw.keepCount < 1 ||
    raw.keepCount > 100
  )
    throw new Error('本次会话保留数必须是1至100的整数。')
  return { kind: raw.kind, keepCount: raw.keepCount }
}
export interface RelayWebdavRetentionHistory {
  scopeSHA256: string
  headSHA256: string | null
  ownedCount: number
  uncertainCount: number
}
export interface RelayWebdavRetentionState extends RelayWebdavRetentionPolicy {
  ownedCount: number
  protectedCount: number
  deletedCount: number
  uncertainCount?: number
  phase: 'idle' | 'checking' | 'deleting'
  currentFilename?: string
  lastAttemptFilename?: string
  lastDeletedFilename?: string
  lastDeletedAt?: string
  lastResult?:
    'notNeeded' | 'pruned' | 'unsupported' | 'conflict' | 'uncertain' | 'cancelled' | 'failed'
}
export interface RelayWebdavBackupArmRequest extends RelayBackupAccountSelection {
  schedule: RelayWebdavBackupSchedule
  retention?: RelayWebdavRetentionPolicy
}
export interface RelayWebdavBackupScope extends RelayBackupAccountSelection {
  kind: 'webdav-backup-session'
  sessionId: string
  name: string
  directoryURL: string
  username: string
  proxyPort: number
  recipient?: string
  encrypted: boolean
  containsSecrets: true
  schedule: RelayWebdavBackupSchedule
  timeZone: string
  nextAt: string
  preparedAt: number
  authorizationExpiresAt: number
  filenamePrefix: string
  filenameSuffix: '.json'
  overwrite: false
  delete: boolean
  retention?: RelayWebdavRetentionPolicy
  history?: RelayWebdavRetentionHistory
  sessionOnly: true
}
export type RelayWebdavBackupStatus =
  | 'armed'
  | 'running'
  | 'uploaded'
  | 'busy'
  | 'credentials'
  | 'accountChanged'
  | 'scopeChanged'
  | 'failed'
  | 'uncertain'
  | 'stopped'
  | 'suspended'
  | 'restored'
  | 'noNextRun'
  | 'retentionUnsupported'
  | 'retentionConflict'
  | 'retentionUncertain'
  | 'retentionFailed'
export interface RelayWebdavBackupSchedulerState {
  pending: boolean
  suspended: boolean
  entries: {
    id: string
    revision: string
    name: string
    directoryURL: string
    proxyPort: number
    encrypted: boolean
    schedule: RelayWebdavBackupSchedule
    timeZone: string
    enabled: boolean
    nextAt?: string
    lastStatus: RelayWebdavBackupStatus
    lastResult?:
      | 'uploaded'
      | 'uncertain'
      | 'cancelled'
      | 'failed'
      | 'credentials'
      | 'accountChanged'
      | 'scopeChanged'
    lastAttemptAt?: string
    lastCompletedAt?: string
    lastFilename?: string
    lastArchiveSHA256?: string
    retention?: RelayWebdavRetentionState
  }[]
}
