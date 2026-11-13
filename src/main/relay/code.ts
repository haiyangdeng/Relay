import { randomUUID } from 'crypto'
import {
  type RelayCodePrepared,
  type RelayCodePreparation,
  type RelayCodeApplied,
  type RelayCodeApplyResult,
  type RelayPreferences,
  validatePreferences,
  validateCodePrepared,
  validateCodeApplied,
  validateRecoveryRestoreRequest
} from '../../shared/relay/protocol'

export function createCodeService<Context>(adapters: {
  prepare(settings: RelayPreferences): Promise<{ report: RelayCodePrepared; context: Context }>
  confirm(preparation: RelayCodePreparation): Promise<boolean>
  verify?(settings: RelayPreferences, context: Context): Promise<void>
  apply(settings: RelayPreferences, revision: string): Promise<RelayCodeApplied>
  now?(): number
}): {
  prepare(raw: unknown): Promise<RelayCodePreparation>
  apply(raw: unknown): Promise<RelayCodeApplyResult>
  isApplying(): boolean
  whenIdle(): Promise<void>
  clear(): void
} {
  let sequence = 0,
    applying = false
  let latest: { preparation: RelayCodePreparation; at: number; context: Context } | undefined
  const waiters: (() => void)[] = []
  const now = adapters.now ?? Date.now
  const hasExpired = (at: number): boolean => {
    const age = now() - at
    return age < 0 || age > 60000
  }
  return {
    async prepare(raw) {
      if (applying) throw new Error('配置确认或事务尚未结束。')
      const parameters = validatePreferences(raw)
      const request = ++sequence,
        at = now()
      latest = undefined
      const prepared = await adapters.prepare(parameters)
      const report = validateCodePrepared(prepared.report)
      if (request !== sequence) throw new Error('准备结果已过期，请重新核对。')
      if (report.httpPort !== parameters.httpPort) throw new Error('准备结果与输入端口不符。')
      const preparation = { ...report, evidenceId: randomUUID(), parameters }
      latest = { preparation: structuredClone(preparation), at, context: prepared.context }
      return preparation
    },
    async apply(raw) {
      const { evidenceId } = validateRecoveryRestoreRequest(raw)
      const proof = latest
      if (
        !proof ||
        proof.preparation.evidenceId !== evidenceId ||
        hasExpired(proof.at) ||
        !proof.preparation.canApply
      )
        throw new Error('请重新读取实际配置并处理未就绪项。')
      if (applying) throw new Error('已有 Code 配置确认或事务进行中。')
      applying = true
      try {
        if (!(await adapters.confirm(structuredClone(proof.preparation))))
          return { status: 'cancelled', warnings: ['已取消，没有应用 Code 或浏览器配置。'] }
        if (latest !== proof) throw new Error('准备结果已改变，请重新核对。')
        latest = undefined
        const intent = ++sequence
        const { parameters, revision } = proof.preparation
        const assertIntent = (): void => {
          if (sequence !== intent) throw new Error('准备结果已改变，请重新核对。')
          if (hasExpired(proof.at)) throw new Error('配置确认已过期，请重新读取实际配置。')
        }
        assertIntent()
        if (adapters.verify) {
          await adapters.verify(parameters, proof.context)
          assertIntent()
        }
        try {
          const result = validateCodeApplied(await adapters.apply(parameters, revision))
          const saved = result.preferenceSnapshot.preferences
          if (
            saved.httpPort !== parameters.httpPort ||
            saved.node !== parameters.node ||
            saved.internalExceptions !== parameters.internalExceptions
          )
            throw new Error('参数不符。')
          return result
        } catch {
          return {
            status: 'uncertain',
            warnings: [
              '配置事务结果未确认，可能已经写入、撤销或需要恢复。请重读备份记录并预检，不要重复使用旧准备结果。'
            ]
          }
        }
      } finally {
        applying = false
        waiters.splice(0).forEach((resolve) => resolve())
      }
    },
    isApplying() {
      return applying
    },
    whenIdle() {
      return applying ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
    },
    clear() {
      ++sequence
      latest = undefined
    }
  }
}
