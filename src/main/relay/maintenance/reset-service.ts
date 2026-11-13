import type { OwnedResetReport } from '../../../shared/relay/owned-reset'
import { OwnedResetUnavailable, type OwnedResetBridge } from './reset-native'
export function createOwnedResetService(adapters: {
  bridge: OwnedResetBridge
  assertIdle(): void
  inspectOwningIdle(): Promise<void>
}) {
  let operating = false,
    report: OwnedResetReport | undefined,
    unknown = false,
    blocking = false,
    generation = 0
  const waiters: (() => void)[] = []
  const unavailable = (): OwnedResetReport => ({
    phase: 'unavailable',
    mode: 'normal',
    lockHeld: false,
    canReset: false,
    canRestore: false,
    restartRequired: false,
    reason: '签名原生维护能力未就绪，未取得独占权。'
  })
  const accept = (value: OwnedResetReport): OwnedResetReport => {
    report = value
    if (value.restartRequired || value.phase === 'uncertain') blocking = true
    if (
      value.lockHeld &&
      !value.restartRequired &&
      ['idle', 'held', 'cancelled'].includes(value.phase)
    )
      blocking = false
    if (value.lockHeld && value.phase !== 'unavailable') unknown = false
    return value
  }
  const end = () => {
    operating = false
    waiters.splice(0).forEach((resolve) => resolve())
  }
  return {
    isBusy: () => operating || adapters.bridge.isBusy(),
    isBlocking: () => operating || unknown || blocking,
    whenIdle: (): Promise<void> =>
      operating ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    invalidate() {
      ++generation
      try {
        adapters.bridge.invalidate()
      } catch {
        unknown = true
      }
    },
    async initialize(): Promise<{ allowActors: boolean; report: OwnedResetReport }> {
      if (operating) throw new Error('维护初始化尚未完成。')
      operating = true
      try {
        report = accept(await adapters.bridge.acquire('normal'))
        return {
          allowActors:
            report.mode === 'normal' &&
            report.lockHeld &&
            !report.restartRequired &&
            ['idle', 'held'].includes(report.phase),
          report
        }
      } catch (error) {
        if (error instanceof OwnedResetUnavailable) {
          report = unavailable()
          return { allowActors: true, report }
        }
        unknown = true
        throw error
      } finally {
        end()
      }
    },
    async state(): Promise<OwnedResetReport> {
      if (operating) throw new Error('维护请求尚未完成。')
      operating = true
      try {
        let owningIdle = true
        try {
          await adapters.inspectOwningIdle()
        } catch {
          owningIdle = false
        }
        const observed = await adapters.bridge.inspect()
        report = accept(
          owningIdle
            ? observed
            : {
                ...observed,
                canReset: false,
                canRestore: false,
                reason: '自有备份恢复记录未确认；保留取消未移动计划的入口。'
              }
        )
        return report
      } catch (error) {
        if (error instanceof OwnedResetUnavailable) return unavailable()
        unknown = true
        throw error
      } finally {
        end()
      }
    },
    async action(raw: unknown, assertCurrent: () => void): Promise<OwnedResetReport> {
      if (typeof raw !== 'string' || !['reset', 'restore', 'cancel'].includes(raw))
        throw new Error('整套数据维护只接受固定动作，不接受目录/根/身份。')
      if (operating || unknown) throw new Error('请先重新读取维护状态。')
      if (raw !== 'cancel') adapters.assertIdle()
      const stamp = generation
      operating = true
      try {
        const current = () => {
          if (stamp !== generation) throw new Error('本次界面维护授权失效。')
          assertCurrent()
          if (raw !== 'cancel') adapters.assertIdle()
        }
        current()
        if (raw !== 'cancel') {
          await adapters.inspectOwningIdle()
          current()
        }
        const fresh = await adapters.bridge.inspect(current)
        current()
        if (!fresh.lockHeld) throw new Error('未取得自有数据根独占权。')
        if (raw === 'reset' && !fresh.canReset)
          throw new Error('原生事实不允许重置；活动/未知状态保留。')
        if (raw === 'restore' && !fresh.canRestore) throw new Error('没有可安全恢复的隔离原件。')
        if (raw !== 'cancel' && !fresh.evidenceID) throw new Error('原生维护证据缺失。')
        if (raw !== 'cancel') {
          await adapters.inspectOwningIdle()
          current()
        }
        report =
          raw === 'cancel'
            ? await adapters.bridge.cancel(fresh.evidenceID, current)
            : raw === 'reset'
              ? await adapters.bridge.reset(fresh.evidenceID ?? '', current)
              : await adapters.bridge.restore(fresh.evidenceID ?? '', current)
        return accept(report)
      } catch (error) {
        unknown = true
        throw error
      } finally {
        end()
      }
    }
  }
}
