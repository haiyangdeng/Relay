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
    default:
      return false
  }
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
  action: 'apply' | 'restore',
  settings: SystemProxySettings,
  invoke: Invoke,
  onPreparation: (plan: SystemProxyPreparation) => void
): Promise<SystemProxyResult> {
  const plan = (await invoke(
    action === 'apply' ? 'relaySystemProxyPrepare' : 'relaySystemProxyRestorePrepare',
    action === 'apply' ? settings : undefined
  )) as SystemProxyPreparation
  onPreparation(plan)
  if (
    plan.action !== action ||
    !(action === 'apply' ? plan.report.canApply : plan.report.canRestore)
  ) {
    await invoke('relaySystemProxyCancel', { evidenceId: plan.evidenceId })
    throw new Error('系统代理状态需要核对，请刷新后处理冲突。')
  }
  // Main owns the native confirmation, expiry check and restoration record.
  return invoke('relaySystemProxyExecute', {
    evidenceId: plan.evidenceId
  }) as Promise<SystemProxyResult>
}
