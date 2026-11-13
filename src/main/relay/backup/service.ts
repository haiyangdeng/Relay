import type {
  RelayBackupRestorePlan,
  RelayBackupResult,
  RelayBackupKeyExportResult,
  RelayBackupRecoveryPlan,
  RelayBackupRecoveryRecord,
  RelayBackupRecoveryResult
} from '../../../shared/relay/backup'
import {
  legacyClashMigrationRequest,
  type LegacyClashMigrationResult
} from '../../../shared/relay/legacy-clash'
import {
  legacyRelayInspectRequest,
  legacyRelayPrepareRequest,
  type LegacyMigrationReport,
  type LegacyRelayOrigin,
  type LegacyRelayInspectRequest,
  type LegacyRelayPrepareRequest,
  type LegacyRelayInspection,
  type LegacyRelayInspectResult,
  type LegacyRelayMigrationResult
} from '../../../shared/relay/legacy-relay'
import { generateAgeKeyPair } from '../../utils/age'
import type { RelayBackupStore } from './store'
import { BACKUP_ARCHIVE_MAX_BYTES, backupSnapshotSHA256, type BackupSnapshot } from './archive'
import type { PreparedLegacyMigration, PreparedLegacyRelayMigrationRecord } from './legacy-record'

// Main-only authority carried from an explicitly confirmed remote read into
// its local migration proof. It is never included in a renderer DTO.
export interface LegacyMigrationSourceGuard {
  recheck?(): Promise<void>
  assertLive?(): void
}

export function createBackupService(adapters: {
  store: RelayBackupStore
  pickImport(kind?: 'relay' | 'legacy'): Promise<Buffer | undefined>
  writeExport(bytes: Buffer, isCurrent: () => boolean): Promise<boolean>
  confirmExport(summary: { files: number; sha256: string; containsSecrets: true }): Promise<boolean>
  confirmRestore(plan: RelayBackupRestorePlan, migration?: LegacyMigrationReport): Promise<boolean>
  confirmRecovery?(plan: RelayBackupRecoveryPlan): Promise<boolean>
  prepareLegacyArchive?(
    bytes: Buffer,
    baseline: BackupSnapshot,
    proxyPort: number | undefined,
    signal: AbortSignal
  ): Promise<PreparedLegacyMigration>
  confirmLegacyRelayInspect?(origin: LegacyRelayOrigin): Promise<boolean>
  inspectLegacyRelay?(
    request: LegacyRelayInspectRequest,
    signal: AbortSignal
  ): Promise<LegacyRelayInspection>
  prepareLegacyRelayArchive?(
    request: LegacyRelayPrepareRequest,
    baseline: BackupSnapshot,
    signal: AbortSignal
  ): Promise<PreparedLegacyRelayMigrationRecord>
  cancelLegacyRelayInspection?(): void
  assertIdle(): void
  assertLegacyRelayInspectionIdle?(): void
  assertKeyExportIdle?(): void
  confirmKeyExport?(): Promise<boolean>
  writeKeyExport?(bytes: Buffer, isCurrent: () => boolean): Promise<boolean>
  afterRestore?(): void | Promise<void>
  now?(): number
}) {
  let busy = false
  let epoch = 0
  let proof: RelayBackupRestorePlan | undefined
  let recoveryProof: RelayBackupRecoveryPlan | undefined
  let migrationReport: LegacyMigrationReport | undefined
  let migrationRestoreRecheck: (() => void) | undefined
  let migrationSourceGuard: LegacyMigrationSourceGuard | undefined
  let legacyInspection: LegacyRelayInspection | undefined
  let legacyInspectionRecheck: (() => void) | undefined
  let preparationAbort: AbortController | undefined
  let removeAbortListener: (() => void) | undefined
  const waiters: (() => void)[] = []
  const now = adapters.now ?? Date.now
  const begin = (assertIdle = adapters.assertIdle): void => {
    if (busy) throw new Error('请等待当前备份操作结束。')
    assertIdle()
    busy = true
  }
  const end = (): void => {
    busy = false
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const revokeLegacyInspection = (): void => {
    legacyInspection = undefined
    legacyInspectionRecheck = undefined
    adapters.cancelLegacyRelayInspection?.()
  }
  const contextLive = (recheck?: () => void): boolean => {
    try {
      recheck?.()
      return true
    } catch {
      return false
    }
  }
  const discard = (keepLegacyInspection = false): void => {
    removeAbortListener?.()
    removeAbortListener = undefined
    if (proof) adapters.store.discard(proof.id)
    proof = undefined
    migrationReport = undefined
    migrationRestoreRecheck = undefined
    migrationSourceGuard = undefined
    if (recoveryProof) adapters.store.discardRecovery(recoveryProof.evidenceId)
    recoveryProof = undefined
    if (!keepLegacyInspection) revokeLegacyInspection()
  }
  const prepareLegacy = async (
    read: () => Promise<Buffer | undefined>,
    proxyPort?: number,
    parentSignal?: AbortSignal,
    sourceGuard?: LegacyMigrationSourceGuard
  ): Promise<LegacyClashMigrationResult> => {
    if (!adapters.prepareLegacyArchive) throw new Error('旧备份迁移尚未接通。')
    begin()
    discard()
    const operationEpoch = epoch,
      abort = new AbortController(),
      guard = sourceGuard
        ? { recheck: sourceGuard.recheck, assertLive: sourceGuard.assertLive }
        : undefined
    let stagedId: string | undefined,
      published = false,
      guardFailed = false
    const assertLive = (): void => {
      if (abort.signal.aborted || epoch !== operationEpoch) throw new Error('旧备份迁移已取消。')
      try {
        guard?.assertLive?.()
      } catch {
        guardFailed = true
        throw new Error('旧备份来源授权已失效。')
      }
    }
    const recheck = async (): Promise<void> => {
      assertLive()
      try {
        await guard?.recheck?.()
      } catch {
        guardFailed = true
        throw new Error('旧备份来源授权已失效。')
      }
      assertLive()
    }
    const parentAborted = (): void => {
      abort.abort()
      if (published && stagedId && proof?.id === stagedId) discard()
    }
    preparationAbort = abort
    parentSignal?.addEventListener('abort', parentAborted, { once: true })
    if (parentSignal?.aborted) parentAborted()
    try {
      await recheck()
      const bytes = await read()
      if (!bytes) return { status: 'cancelled' }
      await recheck()
      adapters.assertIdle()
      assertLive()
      const baseline = await adapters.store.snapshot()
      await recheck()
      const prepared = await adapters.prepareLegacyArchive(bytes, baseline, proxyPort, abort.signal)
      await recheck()
      adapters.assertIdle()
      assertLive()
      if (!prepared.archiveBytes)
        return {
          status: 'inspected',
          report: structuredClone(prepared.report),
          migrationId: prepared.migrationId
        }
      const staged = await adapters.store.stageRestore(
        prepared.archiveBytes,
        prepared.expectedBaselineSHA256
      )
      stagedId = staged.id
      await recheck()
      await prepared.recordPlan(staged)
      await recheck()
      assertLive()
      proof = staged
      migrationReport = structuredClone(prepared.report)
      migrationSourceGuard = guard
      published = true
      if (parentSignal)
        removeAbortListener = () => parentSignal.removeEventListener('abort', parentAborted)
      assertLive()
      return {
        status: 'prepared',
        plan: structuredClone(staged),
        report: structuredClone(prepared.report),
        migrationId: prepared.migrationId
      }
    } catch {
      if (stagedId) adapters.store.discard(stagedId)
      if (published) discard()
      if (abort.signal.aborted || epoch !== operationEpoch || guardFailed)
        return { status: 'cancelled' }
      throw new Error('旧备份迁移未完成；原备份与现有资料保留，请核对私有迁移记录。')
    } finally {
      if (!published) parentSignal?.removeEventListener('abort', parentAborted)
      preparationAbort = undefined
      end()
    }
  }
  return {
    isBusy: (): boolean => busy,
    whenIdle: (): Promise<void> =>
      busy ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    cancel(): void {
      if (preparationAbort) {
        preparationAbort.abort()
        revokeLegacyInspection()
        return
      }
      if (busy) throw new Error('请先结束文件选择或确认。')
      discard()
    },
    cancelPreparation(): void {
      preparationAbort?.abort()
      revokeLegacyInspection()
    },
    invalidatePending(): void {
      epoch++
      preparationAbort?.abort()
      discard()
    },
    async inspectLegacyRelay(
      raw: unknown,
      recheck?: () => void
    ): Promise<LegacyRelayInspectResult> {
      const request = legacyRelayInspectRequest(raw)
      if (
        !adapters.confirmLegacyRelayInspect ||
        !adapters.inspectLegacyRelay ||
        !adapters.cancelLegacyRelayInspection
      )
        throw new Error('旧Relay只读检查尚未接通。')
      const assertInspectionIdle = adapters.assertLegacyRelayInspectionIdle ?? adapters.assertIdle
      begin(assertInspectionIdle)
      discard()
      const operationEpoch = epoch,
        abort = new AbortController(),
        live = (): boolean =>
          !abort.signal.aborted && epoch === operationEpoch && contextLive(recheck)
      preparationAbort = abort
      try {
        if (!live()) return { status: 'cancelled' }
        if (!(await adapters.confirmLegacyRelayInspect(request.origin)))
          return { status: 'cancelled' }
        if (!live()) return { status: 'cancelled' }
        assertInspectionIdle()
        if (!live()) return { status: 'cancelled' }
        const inspected = await adapters.inspectLegacyRelay(request, abort.signal)
        if (!live()) {
          revokeLegacyInspection()
          return { status: 'cancelled' }
        }
        assertInspectionIdle()
        if (!live()) {
          revokeLegacyInspection()
          return { status: 'cancelled' }
        }
        if (
          inspected.origin !== request.origin ||
          now() < inspected.preparedAt ||
          now() >= inspected.expiresAt
        )
          throw new Error('旧Relay检查来源或时效不符。')
        legacyInspection = structuredClone(inspected)
        legacyInspectionRecheck = recheck
        return { status: 'inspected', inspection: structuredClone(inspected) }
      } catch {
        revokeLegacyInspection()
        if (!live()) return { status: 'cancelled' }
        throw new Error('旧Relay只读检查未完成；原件保留，请重新检查。')
      } finally {
        preparationAbort = undefined
        end()
      }
    },
    async prepareLegacyRelayImport(raw: unknown): Promise<LegacyRelayMigrationResult> {
      const request = legacyRelayPrepareRequest(raw),
        inspected = legacyInspection,
        recheck = legacyInspectionRecheck
      if (!adapters.prepareLegacyRelayArchive || !adapters.cancelLegacyRelayInspection)
        throw new Error('旧Relay副本迁移尚未接通。')
      if (!inspected || inspected.inspectionId !== request.inspectionId)
        throw new Error('旧Relay检查凭据已失效。')
      if (now() < inspected.preparedAt || now() >= inspected.expiresAt) {
        revokeLegacyInspection()
        throw new Error('旧Relay检查已过期，请重新检查。')
      }
      if (!contextLive(recheck)) {
        revokeLegacyInspection()
        return { status: 'cancelled' }
      }
      begin()
      discard(true)
      legacyInspection = undefined
      legacyInspectionRecheck = undefined
      const operationEpoch = epoch,
        abort = new AbortController(),
        live = (): boolean =>
          !abort.signal.aborted &&
          epoch === operationEpoch &&
          contextLive(recheck) &&
          now() >= inspected.preparedAt &&
          now() < inspected.expiresAt
      preparationAbort = abort
      let stagedId: string | undefined
      try {
        if (!live()) return { status: 'cancelled' }
        const baseline = await adapters.store.snapshot()
        if (!live()) return { status: 'cancelled' }
        adapters.assertIdle()
        if (!live()) return { status: 'cancelled' }
        const prepared = await adapters.prepareLegacyRelayArchive(request, baseline, abort.signal)
        if (!live()) return { status: 'cancelled' }
        adapters.assertIdle()
        if (!live()) return { status: 'cancelled' }
        if (
          prepared.report.format !== 'relay-legacy-profiles-v1' ||
          prepared.report.origin !== inspected.origin ||
          prepared.report.sourceSHA256 !== inspected.sourceSHA256 ||
          prepared.expectedBaselineSHA256 !== backupSnapshotSHA256(baseline)
        )
          throw new Error('旧Relay候选与本次已检查来源不符。')
        const staged = await adapters.store.stageRestore(
          prepared.archiveBytes,
          prepared.expectedBaselineSHA256
        )
        stagedId = staged.id
        if (!live()) {
          adapters.store.discard(staged.id)
          return { status: 'cancelled' }
        }
        await prepared.recordPlan(staged)
        if (!live()) {
          adapters.store.discard(staged.id)
          return { status: 'cancelled' }
        }
        proof = staged
        migrationReport = structuredClone(prepared.report)
        migrationRestoreRecheck = recheck
        return {
          status: 'prepared',
          plan: structuredClone(staged),
          report: structuredClone(prepared.report),
          migrationId: prepared.migrationId
        }
      } catch {
        if (stagedId) adapters.store.discard(stagedId)
        if (!live()) return { status: 'cancelled' }
        throw new Error('旧Relay副本准备未完成；原件及私有记录保留，当前资料未替换。')
      } finally {
        revokeLegacyInspection()
        preparationAbort = undefined
        end()
      }
    },
    async prepareLegacyImport(raw: unknown): Promise<LegacyClashMigrationResult> {
      const request = legacyClashMigrationRequest(raw)
      return prepareLegacy(() => adapters.pickImport('legacy'), request.proxyPort)
    },
    // Only Main can hand off confirmed downloaded bytes; renderer IPC never
    // accepts a ZIP body, source path or guard function.
    async prepareLegacyArchive(
      bytes: Buffer,
      proxyPort: number,
      parentSignal: AbortSignal,
      sourceGuard?: LegacyMigrationSourceGuard
    ): Promise<LegacyClashMigrationResult> {
      const request = legacyClashMigrationRequest({ proxyPort })
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > BACKUP_ARCHIVE_MAX_BYTES)
        throw new Error('旧Clash ZIP下载大小无效。')
      const original = Buffer.from(bytes)
      return prepareLegacy(async () => original, request.proxyPort, parentSignal, sourceGuard)
    },
    async listRecoveryRecords(): Promise<RelayBackupRecoveryRecord[]> {
      // Metadata inspection does not require stopping an owned core. File
      // transactions still share this service's single in-flight operation.
      begin(() => {})
      try {
        return await adapters.store.listRecoveryRecords()
      } finally {
        end()
      }
    },
    async prepareRecovery(raw: unknown): Promise<RelayBackupRecoveryResult> {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(',') !== 'action,id'
      )
        throw new Error('恢复记录核对只接受记录ID和方向。')
      const input = raw as Record<string, unknown>
      if (
        typeof input.id !== 'string' ||
        (input.action !== 'resume' && input.action !== 'rollback')
      )
        throw new Error('恢复记录ID或方向无效。')
      begin()
      discard()
      const operationEpoch = epoch
      try {
        if (!adapters.confirmRecovery) throw new Error('恢复记录执行尚未接通。')
        const prepared = await adapters.store.prepareRecovery({
          id: input.id,
          action: input.action
        })
        if (epoch !== operationEpoch) {
          adapters.store.discardRecovery(prepared.evidenceId)
          return { status: 'cancelled' }
        }
        recoveryProof = prepared
        return { status: 'prepared', plan: structuredClone(recoveryProof) }
      } finally {
        end()
      }
    },
    async commitRecovery(raw: unknown): Promise<RelayBackupRecoveryResult> {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).join(',') !== 'evidenceId'
      )
        throw new Error('恢复记录执行只接受本次核对凭据。')
      const current = recoveryProof
      if (
        !current ||
        (raw as { evidenceId?: unknown }).evidenceId !== current.evidenceId ||
        now() < current.preparedAt ||
        now() >= current.expiresAt
      ) {
        discard()
        throw new Error('恢复记录核对已失效，请重新读取和核对。')
      }
      begin()
      const operationEpoch = epoch
      recoveryProof = undefined
      try {
        if (!adapters.confirmRecovery) throw new Error('恢复记录执行尚未接通。')
        if (!(await adapters.confirmRecovery(structuredClone(current))))
          return { status: 'cancelled' }
        if (epoch !== operationEpoch) return { status: 'cancelled' }
        if (now() < current.preparedAt || now() >= current.expiresAt)
          throw new Error('恢复记录确认已过期，请重新核对。')
        adapters.assertIdle()
        const status = await adapters.store.commitRecovery(current.evidenceId, adapters.assertIdle)
        if (status === 'restored' || status === 'rolled-back') {
          try {
            await adapters.afterRestore?.()
          } catch {
            return { status: 'uncertain' }
          }
        }
        return { status }
      } finally {
        adapters.store.discardRecovery(current.evidenceId)
        end()
      }
    },
    async exportKey(): Promise<RelayBackupKeyExportResult> {
      const { assertKeyExportIdle, confirmKeyExport, writeKeyExport } = adapters
      if (!assertKeyExportIdle || !confirmKeyExport || !writeKeyExport)
        throw new Error('AGE密钥导出尚未接通。')
      begin(assertKeyExportIdle)
      const operationEpoch = epoch
      const isCurrent = (): boolean => epoch === operationEpoch
      let bytes: Buffer | undefined
      try {
        const preparedAt = now()
        if (!(await confirmKeyExport()) || !isCurrent()) return { status: 'cancelled' }
        if (now() < preparedAt || now() - preparedAt > 60000)
          throw new Error('AGE密钥导出确认已过期。')
        assertKeyExportIdle()
        const pair = await generateAgeKeyPair()
        bytes = Buffer.from(
          `# Relay AGE backup identity\n# public key: ${pair.recipient}\n${pair.secretKey}\n`
        )
        if (!isCurrent() || !(await writeKeyExport(bytes, isCurrent)))
          return { status: 'cancelled' }
        return { status: 'exported', recipient: pair.recipient }
      } catch {
        throw new Error('AGE密钥未确认保存，请选择不存在的新文件名并重试。')
      } finally {
        bytes?.fill(0)
        end()
      }
    },
    async export(): Promise<RelayBackupResult> {
      begin()
      const operationEpoch = epoch
      const isCurrent = (): boolean => epoch === operationEpoch
      try {
        const archive = await adapters.store.archive()
        if (!isCurrent()) return { status: 'cancelled' }
        if (
          !(await adapters.confirmExport({
            files: archive.files,
            sha256: archive.sha256,
            containsSecrets: true
          }))
        )
          return { status: 'cancelled' }
        if (!isCurrent() || !(await adapters.writeExport(archive.bytes, isCurrent)))
          return { status: 'cancelled' }
        return { status: 'exported' }
      } finally {
        end()
      }
    },
    async prepareImport(): Promise<RelayBackupResult> {
      begin()
      discard()
      const operationEpoch = epoch
      try {
        const bytes = await adapters.pickImport()
        if (!bytes || epoch !== operationEpoch) return { status: 'cancelled' }
        adapters.assertIdle()
        const staged = await adapters.store.stageRestore(bytes)
        if (epoch !== operationEpoch) {
          adapters.store.discard(staged.id)
          return { status: 'cancelled' }
        }
        proof = staged
        return { status: 'prepared', plan: structuredClone(proof) }
      } finally {
        end()
      }
    },
    // Main-process remote adapters use the same staged proof and restore gate.
    // This method is deliberately absent from renderer IPC.
    async prepareArchive(bytes: Buffer, signal?: AbortSignal): Promise<RelayBackupResult> {
      begin()
      discard()
      const operationEpoch = epoch
      try {
        if (signal?.aborted) return { status: 'cancelled' }
        const staged = await adapters.store.stageRestore(bytes)
        if (signal?.aborted || epoch !== operationEpoch) {
          adapters.store.discard(staged.id)
          return { status: 'cancelled' }
        }
        proof = staged
        if (signal) {
          const abort = (): void => {
            if (proof?.id === staged.id) discard()
          }
          signal.addEventListener('abort', abort, { once: true })
          removeAbortListener = () => signal.removeEventListener('abort', abort)
          if (signal.aborted) {
            abort()
            return { status: 'cancelled' }
          }
        }
        return { status: 'prepared', plan: structuredClone(proof) }
      } finally {
        end()
      }
    },
    async restore(raw: unknown): Promise<RelayBackupResult> {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).join(',') !== 'id'
      )
        throw new Error('恢复只接受本次准备凭据。')
      const current = proof
      const currentMigration = migrationReport
      const currentRecheck = migrationRestoreRecheck
      const currentSourceGuard = migrationSourceGuard
      const currentContextLive = (): boolean =>
        (currentMigration?.format !== 'relay-legacy-profiles-v1' || contextLive(currentRecheck)) &&
        contextLive(currentSourceGuard?.assertLive)
      const sourceCurrent = async (): Promise<boolean> => {
        if (!currentContextLive()) return false
        try {
          await currentSourceGuard?.recheck?.()
        } catch {
          return false
        }
        return currentContextLive()
      }
      if (
        !current ||
        (raw as { id?: unknown }).id !== current.id ||
        now() < current.preparedAt ||
        now() - current.preparedAt > 60000
      ) {
        discard()
        throw new Error('恢复凭据已失效，请重新选择并检查备份。')
      }
      begin()
      revokeLegacyInspection()
      const operationEpoch = epoch
      removeAbortListener?.()
      removeAbortListener = undefined
      proof = undefined
      migrationReport = undefined
      migrationRestoreRecheck = undefined
      migrationSourceGuard = undefined
      try {
        if (!currentContextLive()) return { status: 'cancelled' }
        if (currentSourceGuard && !(await sourceCurrent())) return { status: 'cancelled' }
        const confirmed = currentMigration
          ? await adapters.confirmRestore(
              structuredClone(current),
              structuredClone(currentMigration)
            )
          : await adapters.confirmRestore(structuredClone(current))
        if (!confirmed || !currentContextLive()) {
          adapters.store.discard(current.id)
          return { status: 'cancelled' }
        }
        if (currentSourceGuard && !(await sourceCurrent())) return { status: 'cancelled' }
        if (epoch !== operationEpoch) return { status: 'cancelled' }
        if (now() < current.preparedAt || now() - current.preparedAt > 60000) {
          adapters.store.discard(current.id)
          throw new Error('确认期间凭据已过期，请重新准备。')
        }
        // This is the admission boundary. Once the real file transaction has
        // started, its existing guards and recovery protocol own the outcome.
        if (!currentContextLive()) return { status: 'cancelled' }
        const status = await adapters.store.commitRestore(
          current.id,
          current.baselineSHA256,
          adapters.assertIdle
        )
        if (status === 'restored') {
          try {
            await adapters.afterRestore?.()
          } catch {
            return { status: 'uncertain' }
          }
        }
        return { status }
      } finally {
        adapters.store.discard(current.id)
        end()
      }
    }
  }
}
