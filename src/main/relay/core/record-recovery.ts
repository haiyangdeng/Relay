import { randomUUID } from 'crypto'
import { profileEvidence } from '../../../shared/relay/profiles'
import {
  validateCoreRecordRecovery,
  type CoreRecordPreparation,
  type CoreRecordRecoveryReport,
  type CoreRecordRecoveryResult
} from '../../../shared/relay/lifecycle'

export function createCoreRecordRecovery(adapters: {
  inspect(): Promise<CoreRecordRecoveryReport>
  archive(revision: string): Promise<CoreRecordRecoveryReport>
  held(): boolean
  confirm(report: CoreRecordRecoveryReport): Promise<boolean>
  now?(): number
}) {
  let busy = false,
    generation = 0,
    proof: { report: CoreRecordPreparation; at: number; generation: number } | undefined
  const now = adapters.now ?? Date.now,
    waiters: (() => void)[] = []
  const end = (): void => {
    busy = false
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const whenIdle = (): Promise<void> =>
    busy ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  return {
    isBusy: (): boolean => busy,
    whenIdle,
    clear(): void {
      proof = undefined
      ++generation
    },
    async prepare(raw: unknown): Promise<CoreRecordPreparation> {
      if (raw !== undefined) throw new Error('核心记录检查不接受PID或路径参数。')
      if (busy || adapters.held()) throw new Error('先处理本次持有的核心会话，再检查旧记录。')
      busy = true
      proof = undefined
      const epoch = ++generation
      try {
        const report = {
          evidenceId: randomUUID(),
          report: validateCoreRecordRecovery(await adapters.inspect())
        }
        if (epoch !== generation || adapters.held()) throw new Error('核心记录检查已失效。')
        proof = { report, at: now(), generation: epoch }
        return structuredClone(report)
      } finally {
        end()
      }
    },
    async archive(raw: unknown): Promise<CoreRecordRecoveryResult> {
      const id = profileEvidence(raw),
        current = proof
      const fresh = (): boolean =>
        !!current &&
        proof === current &&
        id === current.report.evidenceId &&
        current.generation === generation &&
        now() >= current.at &&
        now() - current.at <= 60000 &&
        !adapters.held()
      if (busy || !fresh() || !current?.report.report.canArchive || !current.report.report.revision)
        throw new Error('请重新检查可归档的旧核心记录。')
      busy = true
      let attempted = false
      try {
        if (!(await adapters.confirm(structuredClone(current.report.report)))) {
          proof = undefined
          return { status: 'cancelled', warnings: ['已取消旧会话记录归档。'] }
        }
        const read = validateCoreRecordRecovery(await adapters.inspect())
        if (!fresh() || !read.canArchive || read.revision !== current.report.report.revision)
          throw new Error()
        proof = undefined
        attempted = true
        const report = validateCoreRecordRecovery(await adapters.archive(read.revision))
        if (report.revision !== read.revision || !['archived', 'uncertain'].includes(report.status))
          throw new Error()
        return {
          status: report.status === 'archived' ? 'archived' : 'uncertain',
          report,
          warnings: report.warnings
        }
      } catch {
        proof = undefined
        return {
          status: attempted ? 'uncertain' : 'failed',
          warnings: [
            attempted
              ? '旧记录归档结果未确认，保留现场并重新检查；不自动重试，不启动或停止核心。'
              : '归档前记录、PID或确认已变化，未继续提交。'
          ]
        }
      } finally {
        end()
      }
    }
  }
}
