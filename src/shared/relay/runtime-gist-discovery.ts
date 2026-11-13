import { backupAccountSelection, type RelayBackupAccountSelection } from './backup-accounts'
import { RUNTIME_GIST_FILENAME } from './runtime-gist'

export const RUNTIME_GIST_DESCRIPTION = 'Auto Synced Clash Party Runtime Config'
export interface RelayRuntimeGistDiscoveryRequest extends RelayBackupAccountSelection {
  page?: number
}
export interface RelayRuntimeGistDiscoveryPlan extends RelayBackupAccountSelection {
  evidenceId: string
  action: 'listRuntimeCandidates'
  name: string
  endpoint: string
  proxyPort: number
  description: typeof RUNTIME_GIST_DESCRIPTION
  filename: typeof RUNTIME_GIST_FILENAME
  page: number
  perPage: 100
  expiresAt: number
}
export interface RelayRuntimeGistDiscoveryCandidate {
  id: string
  updatedAt: string
  payloadBytes: number
  verified: false
}
export type RelayRuntimeGistDiscoveryResult =
  | { status: 'cancelled' }
  | {
      status: 'listed'
      page: number
      scanned: number
      moreAvailable: boolean
      nextPage?: number
      budgetReached: boolean
      checkedAt: number
      account: RelayBackupAccountSelection
      entries: RelayRuntimeGistDiscoveryCandidate[]
    }

export function runtimeGistDiscoveryRequest(raw: unknown): RelayRuntimeGistDiscoveryRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('运行Gist候选发现参数无效。')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).some((key) => !['id', 'revision', 'page'].includes(key)) ||
    (value.page !== undefined &&
      (!Number.isInteger(value.page) || Number(value.page) < 1 || Number(value.page) > 1000))
  )
    throw new Error('运行Gist候选只接受保存账号与1至1000的本页页码。')
  return {
    ...backupAccountSelection({ id: value.id, revision: value.revision }),
    page: Number(value.page ?? 1)
  }
}
export function runtimeGistDiscoveryEvidence(raw: unknown): { evidenceId: string } {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).join(',') !== 'evidenceId' ||
    !('evidenceId' in raw) ||
    typeof raw.evidenceId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(raw.evidenceId)
  )
    throw new Error('运行Gist候选发现凭据无效。')
  return { evidenceId: raw.evidenceId }
}
