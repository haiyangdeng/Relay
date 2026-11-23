import { errorMessage } from '../../utils/error-message'
import {
  ordinaryRecoveryNotice,
  type TunIpcApi,
  type TunSessionPreparation,
  type TunSessionState,
  type TunStatus
} from '../../../../shared/relay/tun'

export interface TunPanelSnapshot {
  status?: TunStatus
  preparation?: TunSessionPreparation
  preparedFor?: string
  pending: boolean
  action?: 'status' | 'prepare' | 'start' | 'stop' | 'recover' | 'inspect'
  unconfirmed: boolean
  notice: string
}
export const tunStoppingNotice = '正在关闭 TUN 并恢复普通代理…'
// The visible TUN panel owns its current draft, readiness and confirmation
// evidence. Its sidebar shortcut must issue exactly the same command.
export interface TunSwitchBinding {
  checked: boolean
  disabled: boolean
  setEnabled(enabled: boolean): void
}
const panelListeners = new Set<() => void>()
let panelSwitch: TunSwitchBinding | undefined
export const activeTunSwitch = {
  read: () => panelSwitch,
  subscribe(listener: () => void) {
    panelListeners.add(listener)
    return () => {
      panelListeners.delete(listener)
    }
  },
  bind(binding: TunSwitchBinding) {
    panelSwitch = binding
    panelListeners.forEach((listener) => listener())
    return () => {
      if (panelSwitch !== binding) return
      panelSwitch = undefined
      panelListeners.forEach((listener) => listener())
    }
  }
}

// Serialise mutations across both controls even when a different panel is
// opened while a shortcut is waiting for preparation or restoration.
let switching: 'start' | 'stop' | 'recover' | undefined
const switchListeners = new Set<() => void>()
export const tunSwitchProgress = {
  read: () => switching,
  subscribe(listener: () => void) {
    switchListeners.add(listener)
    return () => {
      switchListeners.delete(listener)
    }
  }
}
function switchingChanged(value: typeof switching): void {
  switching = value
  switchListeners.forEach((listener) => listener())
}
// Only opaque main-process evidence/session IDs leave this controller. Source
// changes retire preparations; an actual owned-session result is always kept,
// even if its source changed while the main-process confirmation was pending.
export function createTunPanelController(adapters: {
  api: TunIpcApi
  evidence(): string | undefined
  busy(): boolean
  activationBlocked?(): boolean
  prepareEvidence?(current: () => boolean): Promise<string>
  context?(): string | undefined
  onBusy(value: boolean): void
  now?(): number
}) {
  const now = adapters.now ?? Date.now,
    listeners = new Set<() => void>()
  let value: TunPanelSnapshot = { pending: false, unconfirmed: false, notice: '' },
    generation = 0,
    hostChangePending = false,
    latestEvidence = adapters.evidence()
  const publish = (patch: Partial<TunPanelSnapshot>): void => {
    value = { ...value, ...patch }
    listeners.forEach((listener) => listener())
  }
  const session = (
    state: TunSessionState,
    ordinaryRecovery?: TunStatus['ordinaryRecovery']
  ): void => {
    publish({
      status: {
        helper: 'unconfirmed',
        warnings: [],
        ...value.status,
        ordinaryRecovery,
        session: state
      },
      unconfirmed: false
    })
  }
  const retire = async (plan: TunSessionPreparation | undefined): Promise<void> => {
    if (!plan) return
    try {
      await adapters.api.relayTunCancel({ evidenceId: plan.evidenceId })
    } catch {
      publish({ notice: '旧TUN准备取消未确认，启用凭据已从界面撤回；请重新读取状态。' })
    }
  }
  const updateEvidence = (): void => {
    const current = adapters.evidence()
    if (current === latestEvidence) return
    latestEvidence = current
    ++generation
    const old = value.preparation
    publish({
      preparation: undefined,
      preparedFor: undefined,
      notice: '完整配置凭据已变化，请重新准备TUN。'
    })
    void retire(old)
  }
  const run = async (
    action: NonNullable<TunPanelSnapshot['action']>,
    enableAfterPreparation = false
  ): Promise<void> => {
    updateEvidence()
    if (
      value.pending ||
      adapters.busy() ||
      (switching && ['stop', 'recover', 'start', 'prepare'].includes(action))
    )
      return
    if ((action === 'prepare' || action === 'start') && adapters.activationBlocked?.()) {
      publish({ notice: '其他会话正在运行；可查看和保存设置，启用 TUN 前需先结束这些会话。' })
      return
    }
    let source = adapters.evidence()
    const initialSource = source,
      context = adapters.context?.(),
      current = value.preparation,
      epoch = generation
    if (
      action === 'prepare' &&
      ((!source && !(enableAfterPreparation && adapters.prepareEvidence)) ||
        value.status?.session.owned)
    )
      return
    if (
      action === 'start' &&
      (!current ||
        value.preparedFor !== source ||
        !current.readyForConfirmation ||
        now() > current.expiresAt ||
        value.status?.session.owned)
    ) {
      publish({
        preparation: undefined,
        preparedFor: undefined,
        notice: 'TUN准备已失效，请重新检查完整配置并准备。'
      })
      void retire(current)
      return
    }
    if (action === 'stop' && !value.status?.session.sessionId) return
    const ordinaryRecovery = value.status?.ordinaryRecovery
    if (action === 'recover' && ordinaryRecovery?.phase !== 'failed') return
    let completedStopNotice: string | undefined
    const switchingAction =
      action === 'stop' || action === 'recover' || action === 'start' || enableAfterPreparation
    if (switchingAction)
      switchingChanged(action === 'stop' || action === 'recover' ? action : 'start')
    publish({ pending: true, action, notice: action === 'stop' ? tunStoppingNotice : '处理中…' })
    adapters.onBusy(true)
    try {
      if (action === 'status') {
        hostChangePending = false
        const status = await adapters.api.relayTunStatus()
        publish({
          status,
          unconfirmed: false,
          notice: status.ordinaryRecovery
            ? ordinaryRecoveryNotice(status.ordinaryRecovery)
            : status.warnings.join(' ')
        })
      } else if (action === 'prepare') {
        publish({ preparation: undefined, preparedFor: undefined })
        await retire(current)
        const currentContext = (): boolean =>
          epoch === generation &&
          initialSource === adapters.evidence() &&
          context === adapters.context?.() &&
          !adapters.activationBlocked?.()
        if (!currentContext()) return
        if (enableAfterPreparation && adapters.prepareEvidence) {
          publish({ notice: '正在检查当前配置…' })
          source = await adapters.prepareEvidence(currentContext)
        }
        if (
          !source ||
          epoch !== generation ||
          initialSource !== adapters.evidence() ||
          context !== adapters.context?.() ||
          adapters.activationBlocked?.()
        )
          return
        const prepared = await adapters.api.relayTunPrepare({ evidenceId: source })
        if (
          epoch !== generation ||
          initialSource !== adapters.evidence() ||
          context !== adapters.context?.()
        )
          await retire(prepared)
        else
          publish({
            preparation: prepared,
            preparedFor: source,
            notice: prepared.readyForConfirmation
              ? '检查完成，执行前仍复核接口、路由、DNS及恢复条件。'
              : '辅助组件、网络基线或恢复条件尚未就绪，不能启用。'
          })
        if (
          enableAfterPreparation &&
          value.preparation === prepared &&
          prepared.readyForConfirmation
        ) {
          // Continue within the same busy operation. Reconcile notifications from
          // preparation before passing its opaque proof to Main's guarded start.
          hostChangePending = false
          const status = await adapters.api.relayTunStatus()
          publish({ status })
          if (
            epoch !== generation ||
            initialSource !== adapters.evidence() ||
            context !== adapters.context?.() ||
            adapters.activationBlocked?.() ||
            hostChangePending ||
            value.unconfirmed ||
            status.session.owned ||
            status.session.phase !== 'prepared' ||
            now() > prepared.expiresAt
          ) {
            publish({
              preparation: undefined,
              preparedFor: undefined,
              notice: '准备期间状态已变化，请重新检查后启用。'
            })
            await retire(prepared)
            return
          }
          publish({ preparation: undefined, preparedFor: undefined, action: 'start' })
          const result = await adapters.api.relayTunStart({ evidenceId: prepared.evidenceId })
          session(result.state, result.ordinaryRecovery)
          publish({
            notice:
              result.state.warnings.join(' ') ||
              {
                started: '本次 TUN 已启用。',
                restored: '本次网络恢复已确认。',
                released: 'TUN 已关闭，保留当前系统代理设置。',
                cancelled: '已取消本次操作。',
                failed: '启动检查未通过，请核对当前状态。',
                uncertain: '启用结果待核对，请保留窗口并刷新状态。'
              }[result.status]
          })
        }
      } else if (action === 'inspect') {
        session(await adapters.api.relayTunInspect())
        publish({ notice: '已重新复核本次会话，没有自动重启或重新接管网络。' })
      } else {
        publish({ preparation: undefined, preparedFor: undefined })
        const result = await (async () => {
          if (action === 'start') {
            if (!current) throw new Error('缺少本次准备。')
            return adapters.api.relayTunStart({ evidenceId: current.evidenceId })
          }
          if (action === 'recover' && ordinaryRecovery)
            return adapters.api.relayTunRecoverOrdinary({ sessionId: ordinaryRecovery.sessionId })
          const sessionId = value.status?.session.sessionId
          if (!sessionId) throw new Error('缺少本次会话。')
          return adapters.api.relayTunStop({ sessionId })
        })()
        if (
          (action === 'stop' || action === 'recover') &&
          (result.status === 'restored' || result.status === 'released' || result.ordinaryRecovery)
        )
          completedStopNotice = result.state.warnings.join(' ') || undefined
        session(result.state, result.ordinaryRecovery)
        publish({
          notice:
            result.state.warnings.join(' ') ||
            {
              started: '本次TUN已启用；不代表Claude禁止直连保护已验证。',
              restored: '本次核心、设备及网络恢复已确认。',
              released: 'TUN 已关闭，保留当前系统代理设置。',
              cancelled: '已取消本次操作；请以当前会话状态为准。',
              failed: '启动前检查未通过，请重新准备。',
              uncertain: '本次结果未确认；保留窗口及恢复能力，重新复核后明确停用。'
            }[result.status]
        })
      }
    } catch (error) {
      if (epoch !== generation) return
      publish({
        preparation: undefined,
        preparedFor: undefined,
        unconfirmed: true,
        notice: errorMessage(error, 'TUN操作未完成，请刷新状态后重试。')
      })
      if (value.status?.session.owned)
        session({
          ...value.status.session,
          phase: 'uncertain',
          traffic: 'unconfirmed',
          restorationVerified: false
        })
      publish({ unconfirmed: true })
      try {
        const status = await adapters.api.relayTunStatus()
        publish({ status, unconfirmed: false })
      } catch {
        /* Keep the last ownership evidence and unknown-state gate. */
      }
    } finally {
      if (hostChangePending) {
        // Notifications may arrive before an older operation reply. Read once
        // inside the same operation: React's parent busy prop may still be true.
        // This reconciles state only; it never repeats start/stop/inspection.
        try {
          if (action !== 'prepare' && value.preparation) {
            const old = value.preparation
            ++generation
            publish({ preparation: undefined, preparedFor: undefined })
            await retire(old)
          }
          hostChangePending = false
          const status = await adapters.api.relayTunStatus()
          // prepare itself sends an update before replying. Keep its fresh
          // proof only if the main process still reports a prepared session.
          if (value.preparation && (status.session.phase !== 'prepared' || status.session.owned)) {
            const old = value.preparation
            ++generation
            publish({ preparation: undefined, preparedFor: undefined })
            await retire(old)
          }
          publish({
            status,
            unconfirmed: hostChangePending,
            notice: status.ordinaryRecovery
              ? ordinaryRecoveryNotice(status.ordinaryRecovery)
              : hostChangePending
                ? '读取期间宿主状态再次变化，请重新读取确认。'
                : completedStopNotice &&
                    !status.session.owned &&
                    ['restored', 'released'].includes(status.session.phase)
                  ? completedStopNotice
                  : status.session.restorationVerified
                    ? '本次核心、设备及网络恢复已确认。'
                    : [...status.warnings, ...status.session.warnings].join(' ')
          })
        } catch {
          publish({
            unconfirmed: true,
            notice: '宿主状态更新未确认，请重新读取；不会自动重新执行启停。'
          })
        }
      }
      publish({ pending: false, action: undefined })
      if (switchingAction) switchingChanged(undefined)
      adapters.onBusy(false)
    }
  }
  return {
    snapshot: (): TunPanelSnapshot => value,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    updateEvidence,
    hostChanged(): void {
      if (value.pending) {
        hostChangePending = true
        return
      }
      hostChangePending = false
      ++generation
      const plan = value.preparation
      publish({ preparation: undefined, preparedFor: undefined })
      void retire(plan)
      if (!adapters.busy()) void run('status')
      else publish({ notice: 'TUN状态已变化，请在当前操作结束后重新读取。', unconfirmed: true })
    },
    run: (action: NonNullable<TunPanelSnapshot['action']>): Promise<void> => run(action),
    enable: (): Promise<void> => run('prepare', true),
    async cancel(): Promise<void> {
      if (value.pending && value.action !== 'prepare') return
      ++generation
      const plan = value.preparation
      publish({
        preparation: undefined,
        preparedFor: undefined,
        notice: '已撤回本次TUN准备；未停用在用会话。'
      })
      await retire(plan)
    }
  }
}
