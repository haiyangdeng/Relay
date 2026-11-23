import { systemProxyInboundPort } from '../../../../shared/relay/system-proxy'
import type {
  SystemProxyPreparation,
  SystemProxyReport,
  SystemProxyResult,
  SystemProxySettings
} from '../../../../shared/relay/system-proxy'

type Invoke = (channel: string, input?: unknown) => Promise<unknown>

// Only the current renderer session owns this choice. Undefined means the user
// has not chosen services; [] is an explicit request to select none.
let sessionServices: string[] | undefined
export function rememberSystemProxyServices(ids: readonly string[]): void {
  sessionServices = [...ids]
}
export function readSystemProxyServices(): string[] | undefined {
  return sessionServices?.slice()
}
export function selectedSystemProxyServices(
  report: SystemProxyReport,
  selected = sessionServices
): string[] {
  const available = new Set(
    report.services.filter((service) => service.enabled).map((service) => service.id)
  )
  return selected === undefined ? [...available] : selected.filter((id) => available.has(id))
}

function canReapplyDetachedSystemProxy(report: SystemProxyReport): boolean {
  return (
    !!report.recordID &&
    report.canRetireDetached === true &&
    (report.status === 'pending' || report.status === 'conflict')
  )
}

export function canPrepareSystemProxy(report?: SystemProxyReport): boolean {
  if (!report) return false
  // inspect has no target settings and deliberately returns canApply=false.
  // Only the later prepare response may authorize a native submission.
  switch (report.status) {
    case 'inactive':
    case 'restored':
      return !report.recordID
    case 'active':
    case 'applied':
      return !!report.recordID && report.canRestore
    case 'rolledBack':
      return !report.recordID || report.canRestore
    case 'pending':
    case 'conflict':
      return canReapplyDetachedSystemProxy(report)
    default:
      return false
  }
}

export function canSwitchSystemProxy(
  report?: SystemProxyReport,
  selected = sessionServices
): boolean {
  if (!report) return true // A click inspects the native state before applying anything.
  if (report.status === 'active' || report.status === 'applied') return report.canRestore
  return canPrepareSystemProxy(report) && selectedSystemProxyServices(report, selected).length > 0
}

export async function systemProxyListenerPort(
  invoke: Invoke,
  current: () => boolean,
  settings: Pick<SystemProxySettings, 'socks' | 'mode'>,
  explicitPort?: number
): Promise<number> {
  if (!current()) throw new Error('本次页面操作已失效。')
  const listener = (await invoke('relayEnsureSystemProxyListener')) as
    { httpPort: number; mixedPort?: number } | undefined
  if (!current()) throw new Error('本次页面操作已失效。')
  const port = listener?.httpPort,
    mixed = listener?.mixedPort
  if (!port || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('当前核心的代理端口尚未确认，请刷新后重试。')
  if (explicitPort !== undefined) {
    if (
      settings.mode === 'manual' &&
      settings.socks &&
      explicitPort === port &&
      explicitPort !== mixed
    )
      throw new Error('所填 HTTP 端口不支持 SOCKS，请使用混合端口。')
    return explicitPort
  }
  return systemProxyInboundPort(port, mixed, settings)
}

export function systemProxyPortFromCore(
  current: number,
  edited: boolean,
  corePort: number | undefined
): number {
  return !edited &&
    typeof corePort === 'number' &&
    Number.isInteger(corePort) &&
    corePort >= 1024 &&
    corePort <= 65535
    ? corePort
    : current
}

export async function submitSystemProxy(
  intent: 'enable' | 'apply' | 'restore',
  settings: SystemProxySettings,
  invoke: Invoke,
  onPreparation: (plan: SystemProxyPreparation) => void
): Promise<SystemProxyResult> {
  const action = intent === 'enable' ? 'apply' : intent
  const plan = (await invoke(
    action === 'apply' ? 'relaySystemProxyPrepare' : 'relaySystemProxyRestorePrepare',
    action === 'apply' ? settings : undefined
  )) as SystemProxyPreparation
  onPreparation(plan)
  // Startup can finish its own confirmed apply while this explicit click is
  // waiting for the listener. An enable switch already reached its target.
  if (
    intent === 'enable' &&
    plan.action === 'apply' &&
    plan.alreadyApplied === true &&
    plan.report.recordID &&
    (plan.report.status === 'active' || plan.report.status === 'applied')
  ) {
    await invoke('relaySystemProxyCancel', { evidenceId: plan.evidenceId })
    return { status: 'applied', report: plan.report, warnings: plan.report.warnings }
  }
  if (
    plan.action !== action ||
    !(action === 'apply'
      ? plan.report.canApply || canReapplyDetachedSystemProxy(plan.report)
      : plan.report.canRestore)
  ) {
    await invoke('relaySystemProxyCancel', { evidenceId: plan.evidenceId })
    throw new Error('系统代理状态需要核对，请刷新后处理冲突。')
  }
  // Main owns the native confirmation, expiry check and restoration record.
  return invoke('relaySystemProxyExecute', {
    evidenceId: plan.evidenceId
  }) as Promise<SystemProxyResult>
}
