import type { RelayStateContext } from '../../context'
import { SimplePrivateDocumentFile } from '../../simple/store'
import {
  appUpdateCandidateId,
  appUpdateObject,
  type RelayAppInstallationRecord
} from '../../../../shared/relay/app-updates'
import { appVersion } from './release'

export function appInstallationRecord(raw: unknown): RelayAppInstallationRecord {
  const value = appUpdateObject(raw, [
    'version',
    'operationId',
    'candidateId',
    'previousVersion',
    'targetVersion',
    'targetSHA256',
    'trustRevision',
    'phase',
    'updatedAt'
  ])
  if (
    value.version !== 1 ||
    typeof value.phase !== 'string' ||
    ![
      'handoff-intent',
      'installer-opened',
      'installed',
      'not-confirmed',
      'uncertain',
      'dismissed'
    ].includes(value.phase) ||
    !Number.isSafeInteger(value.updatedAt) ||
    Number(value.updatedAt) < 1 ||
    typeof value.targetSHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.targetSHA256) ||
    typeof value.trustRevision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.trustRevision)
  )
    throw new Error('应用安装事务记录无效。')
  return {
    version: 1,
    operationId: appUpdateCandidateId({ id: value.operationId }),
    candidateId: appUpdateCandidateId({ id: value.candidateId }),
    previousVersion: appVersion(value.previousVersion),
    targetVersion: appVersion(value.targetVersion),
    targetSHA256: value.targetSHA256,
    trustRevision: value.trustRevision,
    phase: value.phase as RelayAppInstallationRecord['phase'],
    updatedAt: Number(value.updatedAt)
  }
}
export function appInstallationPending(record: RelayAppInstallationRecord | null): boolean {
  return !!record && record.phase !== 'installed' && record.phase !== 'dismissed'
}
export class AppInstallationJournal {
  private readonly file: SimplePrivateDocumentFile<RelayAppInstallationRecord | null>
  constructor(context: RelayStateContext) {
    this.file = new SimplePrivateDocumentFile(
      context,
      'app-update-installation.json',
      appInstallationRecord,
      () => null,
      'app-update'
    )
  }
  read() {
    return this.file.read()
  }
  write(expectedRevision: string, raw: RelayAppInstallationRecord, assertCurrent: () => void) {
    const next = appInstallationRecord(raw)
    return this.file.change(
      expectedRevision,
      (previous) => {
        const old = previous.value
        if (!appInstallationPending(old)) {
          if (next.phase !== 'handoff-intent' || next.operationId === old?.operationId)
            throw new Error('应用安装事务起点无效。')
        } else {
          if (!old) throw new Error('应用安装事务丢失。')
          const identity = (record: RelayAppInstallationRecord) =>
            JSON.stringify({
              ...record,
              phase: '',
              updatedAt: 0
            })
          if (identity(old) !== identity(next) || next.phase === 'handoff-intent')
            throw new Error('应用安装事务身份已变化。')
        }
        return next
      },
      assertCurrent
    )
  }
}
