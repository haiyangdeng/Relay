import { randomUUID } from 'crypto'
import {
  type RelayEdgeInspection,
  type RelayEdgePreparation,
  type RelayEdgeApplyResult,
  type RelayEdgeOpenResult,
  type RelayEdgeAction,
  validateEdgeAction,
  validateEdgeInspection,
  validateEdgeOpenResult
} from '../../shared/relay/edge'
import { validateRecoveryRestoreRequest } from '../../shared/relay/protocol'

export function createEdgeService(adapters: {
  inspect(): Promise<RelayEdgeInspection>
  confirm(): Promise<boolean>
  openProfile(revision: string): Promise<RelayEdgeOpenResult>
  openEntry(action: RelayEdgeAction): Promise<RelayEdgeOpenResult>
  now?(): number
}) {
  let latest: { report: RelayEdgePreparation; at: number } | undefined
  let sequence = 0,
    busy = false
  const now = adapters.now ?? Date.now
  const waiters: (() => void)[] = []
  const end = (): void => {
    busy = false
    waiters.splice(0).forEach((resolve) => resolve())
  }
  return {
    async inspect(): Promise<RelayEdgePreparation> {
      if (busy) throw new Error('请先完成当前 Edge 操作。')
      const current = ++sequence,
        at = now()
      latest = undefined
      const report = {
        ...validateEdgeInspection(await adapters.inspect()),
        evidenceId: randomUUID()
      }
      if (current !== sequence) throw new Error('Edge 检查已过期，请重新读取。')
      latest = { report: structuredClone(report), at }
      return report
    },
    async openProfile(raw: unknown): Promise<RelayEdgeApplyResult> {
      const { evidenceId } = validateRecoveryRestoreRequest(raw),
        proof = latest
      const valid = (): boolean =>
        !!proof &&
        proof === latest &&
        proof.report.evidenceId === evidenceId &&
        now() >= proof.at &&
        now() - proof.at <= 60000
      if (busy) throw new Error('请先完成当前 Edge 操作。')
      if (!valid() || !proof?.report.canOpenProfile)
        throw new Error('请重新核对 Edge 策略与安装条件。')
      busy = true
      try {
        if (!(await adapters.confirm()))
          return {
            status: 'cancelled',
            installed: false,
            warnings: ['已取消，没有暂存或打开描述文件。']
          }
        if (!valid()) throw new Error('确认期间检查结果已过期，请重新读取。')
        latest = undefined
        ++sequence
        try {
          const result = validateEdgeOpenResult(await adapters.openProfile(proof.report.revision))
          if (result.action !== 'openProfile') throw new Error()
          return result
        } catch {
          return {
            status: 'uncertain',
            installed: false,
            warnings: [
              '打开结果未确认，文件或系统窗口可能已出现。请核对设备管理后重新检测，没有自动重试。'
            ]
          }
        }
      } finally {
        end()
      }
    },
    async openEntry(raw: unknown): Promise<RelayEdgeOpenResult> {
      const action = validateEdgeAction(raw)
      if (busy) throw new Error('请先完成当前 Edge 操作。')
      busy = true
      latest = undefined
      ++sequence
      try {
        const result = validateEdgeOpenResult(await adapters.openEntry(action))
        if (result.action !== action) throw new Error('系统入口返回结果不符，请核对已出现窗口。')
        return result
      } finally {
        end()
      }
    },
    isBusy: () => busy,
    whenIdle: (): Promise<void> =>
      busy ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    clear() {
      latest = undefined
      ++sequence
    }
  }
}
