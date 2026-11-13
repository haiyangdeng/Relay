import type { RelayBackupAccountSelection } from './backup-accounts'
import { RUNTIME_GIST_FILENAME, type RelayRuntimeGistSource } from './runtime-gist'

export interface RelayRuntimeGistSyncArmRequest extends RelayBackupAccountSelection {
  gistId: string
  source?: RelayRuntimeGistSource
}
export interface RuntimeGistSyncSnapshotInfo {
  revision: string
  configurationSHA256: string
  bytes: number
  capturedAt: number
}
export interface RelayRuntimeGistSyncScope extends RelayRuntimeGistSyncArmRequest {
  kind: 'runtime-gist-sync-session'
  sessionId: string
  name: string
  apiOrigin: 'https://api.github.com'
  filename: typeof RUNTIME_GIST_FILENAME
  instanceId: string
  proxyPort: number
  recipient?: string
  encrypted: boolean
  containsSecrets: true
  initial: RuntimeGistSyncSnapshotInfo
  preparedAt: number
  authorizationExpiresAt: number
  sessionOnly: true
  overwriteDedicatedFile: true
  atomicRemoteUpdate: false
}
export type RuntimeGistSyncResult =
  | 'armed'
  | 'uploaded'
  | 'unchanged'
  | 'superseded'
  | 'cancelled'
  | 'conflict'
  | 'uncertain'
  | 'failed'
export type RuntimeGistSyncStopReason =
  | 'stopped'
  | 'suspended'
  | 'hidden'
  | 'rendererChanged'
  | 'restored'
  | 'quitting'
  | 'accountChanged'
  | 'ownerChanged'
  | 'credentials'
  | 'conflict'
  | 'uncertain'
  | 'failed'
export interface RelayRuntimeGistSyncState {
  enabled: boolean
  pending: boolean
  phase: 'idle' | 'authorizing' | 'waiting' | 'capturing' | 'preparing' | 'uploading' | 'stopping'
  dirty: boolean
  account?: { id: string; revision: string; name: string }
  target?: { gistId: string; url: string; filename: typeof RUNTIME_GIST_FILENAME }
  owner?: { instanceId: string; proxyPort: number; source?: RelayRuntimeGistSource }
  encrypted?: boolean
  latestCaptured?: RuntimeGistSyncSnapshotInfo
  uploading?: RuntimeGistSyncSnapshotInfo & { payloadSHA256: string; submitted: boolean }
  lastUploaded?: { source: RuntimeGistSyncSnapshotInfo; payloadSHA256: string; at: number }
  lastAttempt?: {
    source?: RuntimeGistSyncSnapshotInfo
    payloadSHA256?: string
    submitted: boolean
    result: RuntimeGistSyncResult
    at: number
  }
  lastResult?: RuntimeGistSyncResult
  stopReason?: RuntimeGistSyncStopReason
}
