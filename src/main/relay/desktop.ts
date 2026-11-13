import {
  validateDesktopAction,
  type RelayDesktopResult,
  type RelayDesktopSnapshot,
  type RelayDesktopState
} from '../../shared/relay/desktop'
import type { RelayDesktopTransport } from './desktop-transport'

export function createDesktopService(adapters: {
  open(onUncertain: () => void): RelayDesktopTransport
  confirm(action: 'start' | 'restore'): Promise<boolean>
}) {
  let worker: RelayDesktopTransport | undefined, snapshot: RelayDesktopSnapshot | undefined
  let uncertain = false,
    operations = 0,
    confirming = false,
    abortConfirmation = false,
    generation = 0
  let closing: Promise<boolean> | undefined
  const waiters: (() => void)[] = []
  const state = (): RelayDesktopState =>
    structuredClone({
      host: worker ? (worker.gone() ? 'lost' : 'running') : uncertain ? 'lost' : 'absent',
      pending: operations > 0 || confirming,
      uncertain,
      snapshot
    })
  const resultState = (): RelayDesktopState => ({
    ...state(),
    pending: operations > 1 || confirming
  })
  const end = (): void => {
    --operations
    if (!operations && !confirming) waiters.splice(0).forEach((resolve) => resolve())
  }
  const whenIdle = (): Promise<void> =>
    operations || confirming ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const open = async (): Promise<RelayDesktopTransport> => {
    if (worker && !worker.gone()) {
      const existing = worker
      await existing.ready
      if (worker !== existing) throw new Error('会话已关闭。')
      return existing
    }
    const current = ++generation
    worker = adapters.open(() => {
      if (generation === current) uncertain = true
    })
    const opened = worker
    const ready = await opened.ready
    if (worker !== opened) throw new Error('会话已关闭。')
    snapshot = ready.snapshot
    return opened
  }
  const closeWorker = (): Promise<boolean> => {
    if (closing) return closing
    if (!worker) return Promise.resolve(!uncertain)
    const current = worker
    ++operations
    closing = (async () => {
      await Promise.resolve()
      try {
        const response = await current.request('close')
        snapshot = response.snapshot
        if (!response.closing || !snapshot.canClose) return false
        if (worker === current) {
          worker = undefined
          uncertain = false
          ++generation
        }
        return true
      } catch {
        uncertain = true
        return false
      } finally {
        closing = undefined
        end()
      }
    })()
    return closing
  }
  return {
    state,
    isBlocking(): boolean {
      return !!worker || uncertain || operations > 0 || confirming
    },
    whenIdle,
    async action(raw: unknown): Promise<RelayDesktopResult> {
      const action = validateDesktopAction(raw)
      if (action === 'cancel' && confirming) {
        abortConfirmation = true
        return { status: 'cancelled', state: state() }
      }
      if (action !== 'cancel' && (operations || confirming || closing))
        throw new Error('已有桌面会话操作或确认正在进行。')
      if (action === 'start' && (worker || uncertain))
        throw new Error('请先完成当前会话或确认恢复记录。')
      if (
        (action === 'finish' || action === 'cancel') &&
        (!worker || snapshot?.requiresRecoveryConsent)
      )
        throw new Error('需单独确认恢复已有记录，不能通过完成或取消代替。')
      ++operations
      let activeWorker: RelayDesktopTransport | undefined
      try {
        if (action === 'start' || action === 'restore') {
          confirming = true
          abortConfirmation = false
          let confirmed = false
          try {
            confirmed = await adapters.confirm(action)
          } finally {
            confirming = false
          }
          if (!confirmed || abortConfirmation) return { status: 'cancelled', state: resultState() }
          if (worker?.gone()) worker = undefined
        }
        const current = await open()
        if (closing || worker !== current) return { status: 'cancelled', state: resultState() }
        activeWorker = current
        const response = await current.request(
          action === 'start' ? 'start' : action === 'cancel' ? 'cancel' : 'restore'
        )
        if (worker !== current && !uncertain) return { status: 'completed', state: resultState() }
        snapshot = response.snapshot
        if (snapshot.busy) {
          uncertain = true
          return { status: 'uncertain', state: state() }
        }
        // A confirmed restore or positively completed operation re-establishes
        // a known state. Never auto-retry a mutating command after timeout.
        if (action === 'restore') uncertain = false
        if (snapshot.canClose && !snapshot.hasRecord) await closeWorker()
        return { status: uncertain ? 'uncertain' : 'completed', state: resultState() }
      } catch {
        if (activeWorker && worker !== activeWorker && !uncertain)
          return { status: 'completed', state: resultState() }
        if (!worker && !uncertain) return { status: 'cancelled', state: resultState() }
        uncertain = true
        return { status: 'uncertain', state: resultState() }
      } finally {
        end()
      }
    },
    async requestClose(): Promise<boolean> {
      if (confirming) {
        abortConfirmation = true
        await whenIdle()
      }
      if (!worker) return !uncertain
      if (snapshot?.requiresRecoveryConsent) return false
      return closeWorker()
    }
  }
}
