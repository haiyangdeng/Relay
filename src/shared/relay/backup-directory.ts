import type { RelayBackupAccountSelection } from './backup-accounts'

export interface RelayWebdavDirectoryPlan extends RelayBackupAccountSelection {
  evidenceId: string
  provider: 'webdav'
  action: 'createDirectory'
  name: string
  directoryURL: string
  parentURL: string
  username: string
  proxyPort: number
  usesCredential: true
  parentMustExist: true
  recursive: false
  overwrite: false
  expiresAt: number
}
export type WebdavDirectoryRejection =
  | 'authentication'
  | 'forbidden'
  | 'parentMissing'
  | 'parentNotCollection'
  | 'targetNotCollection'
  | 'unverified'
  | 'locked'
  | 'unsupported'
  | 'storage'
  | 'protocol'
export type RelayWebdavDirectoryResult =
  | { status: 'created' | 'alreadyExists'; directoryURL: string; verifiedAt: number }
  | { status: 'cancelled'; submitted: boolean }
  | {
      status: 'rejected' | 'conflict'
      directoryURL: string
      reason: WebdavDirectoryRejection
      httpStatus?: number
    }
  | { status: 'uncertain'; directoryURL: string; httpStatus?: number }

export function webdavDirectoryEvidence(raw: unknown): { evidenceId: string } {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).join(',') !== 'evidenceId' ||
    !('evidenceId' in raw) ||
    typeof raw.evidenceId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(raw.evidenceId)
  )
    throw new Error('WebDAV目录操作凭据无效。')
  return { evidenceId: raw.evidenceId }
}
