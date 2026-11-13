import { randomUUID } from 'crypto'
import {
  type RelayRecoveryStatus,
  type RelayRecoverySelection,
  type RelayRecoveryPreflight,
  type RelayRecoveryInspection,
  type RelayRecoveryRestoreResult,
  validateRecoveryStatus,
  validateRecoverySelection,
  validateRecoveryPreflight,
  validateRecoveryRestoreRequest,
  validateRecoveryRestoreResult,
  recoveryCanRequestRestore
} from '../../shared/relay/protocol'

// A basename is usable only after it appeared in a main-process-owned inventory.
// This cache grants permission to read one record, never permission to restore it.
export function createRecoveryService(adapters: {
  inventory(): Promise<RelayRecoveryStatus>
  inspect(selection: RelayRecoverySelection): Promise<RelayRecoveryPreflight>
  confirm?(inspection: RelayRecoveryInspection): Promise<boolean>
  restore?(
    inspection: RelayRecoveryInspection,
    allowLegacy: boolean
  ): Promise<RelayRecoveryRestoreResult>
  now?(): number
}): {
  inventory(): Promise<RelayRecoveryStatus>
  inspect(raw: unknown): Promise<RelayRecoveryInspection>
  restore(raw: unknown): Promise<RelayRecoveryRestoreResult>
  isRestoring(): boolean
  whenIdle(): Promise<void>
  clear(): void
} {
  let sequence = 0
  let inspectionSequence = 0
  let latest: { inspection: RelayRecoveryInspection; at: number } | undefined
  let restoring = false
  const waiters: (() => void)[] = []
  let allowed = new Set<string>()
  const now = adapters.now ?? Date.now
  const key = (selection: RelayRecoverySelection): string => `${selection.source}:${selection.id}`
  return {
    async inventory() {
      const request = ++sequence
      latest = undefined
      allowed.clear()
      const result = validateRecoveryStatus(await adapters.inventory())
      if (request !== sequence) throw new Error('恢复列表已过期，请重新读取。')
      allowed = new Set(
        result.inventories.flatMap((inventory) =>
          inventory.entries.flatMap((entry) => {
            try {
              return [key(validateRecoverySelection({ source: inventory.source, id: entry.id }))]
            } catch {
              return []
            }
          })
        )
      )
      return result
    },
    async inspect(raw) {
      const selection = validateRecoverySelection(raw)
      const request = sequence
      const inspectionRequest = ++inspectionSequence
      const startedAt = now()
      latest = undefined
      if (!allowed.has(key(selection))) throw new Error('请先读取恢复列表，再预检其中的记录。')
      const result = validateRecoveryPreflight(await adapters.inspect(selection))
      if (request !== sequence || !allowed.has(key(selection)))
        throw new Error('预检对应的列表已失效，请重读。')
      if (key(result.selection) !== key(selection)) throw new Error('预检返回了其他记录，已丢弃。')
      if (inspectionRequest !== inspectionSequence)
        throw new Error('预检已被更新，请使用新的结果。')
      const inspection = { ...result, evidenceId: randomUUID() }
      latest = { inspection: structuredClone(inspection), at: startedAt }
      return inspection
    },
    async restore(raw) {
      const { evidenceId, allowLegacy } = validateRecoveryRestoreRequest(raw)
      const proof = latest
      const age = proof ? now() - proof.at : Infinity
      if (
        !proof ||
        proof.inspection.evidenceId !== evidenceId ||
        age < 0 ||
        age > 60000 ||
        !recoveryCanRequestRestore(proof.inspection) ||
        !adapters.confirm ||
        !adapters.restore
      )
        throw new Error('请重新预检并处理阻止项，再申请恢复。')
      if (restoring) throw new Error('已有恢复执行正在进行。')
      const needsLegacy =
        proof.inspection.requiresLegacyConfirmation ||
        proof.inspection.issues.includes('targetModeUnknown')
      if (needsLegacy && !allowLegacy)
        throw new Error('此备份缺少可信摘要或权限记录，请使用允许旧版备份的恢复入口。')
      restoring = true
      try {
        const current = await adapters.confirm(structuredClone(proof.inspection))
        if (!current) return { status: 'cancelled', warnings: ['已取消，没有执行恢复。'] }
        if (latest !== proof) throw new Error('确认期间预检已更新，请重新核对。')
        // A proof can submit one native operation, even if its response is lost.
        latest = undefined
        allowed.clear()
        ++sequence
        try {
          const result = validateRecoveryRestoreResult(
            await adapters.restore(proof.inspection, needsLegacy && allowLegacy)
          )
          if (result.status !== 'restored') throw new Error('恢复结果未确认。')
          return result
        } catch {
          return {
            status: 'uncertain',
            warnings: [
              '恢复结果未确认，可能已有部分或全部文件恢复；请重新读取记录并预检，勿重复使用旧结果。'
            ]
          }
        }
      } finally {
        restoring = false
        waiters.splice(0).forEach((resolve) => resolve())
      }
    },
    isRestoring() {
      return restoring
    },
    whenIdle() {
      return restoring ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
    },
    clear() {
      ++sequence
      ++inspectionSequence
      latest = undefined
      allowed.clear()
    }
  }
}
