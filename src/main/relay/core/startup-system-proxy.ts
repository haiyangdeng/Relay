import { systemProxyInboundPort } from '../../../shared/relay/system-proxy'
import type {
  SystemProxyReport,
  SystemProxySettings,
  SystemProxyPreparation,
  SystemProxyResult
} from '../../../shared/relay/system-proxy'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'

export async function applyStartupSystemProxy(
  adapters: {
    enabled(): Promise<boolean>
    local(): LocalProxyState
    inspect(): Promise<SystemProxyReport>
    draft(): Promise<Omit<SystemProxySettings, 'serviceIDs' | 'port'>>
    prepare(input: SystemProxySettings): Promise<SystemProxyPreparation>
    execute(input: { evidenceId: string }): Promise<SystemProxyResult>
    cancel(input: { evidenceId: string }): void
  },
  current: () => void
): Promise<void> {
  if (!(await adapters.enabled())) return
  const local = adapters.local()
  const ready = (): boolean => {
    current()
    const live = adapters.local()
    return (
      !!local.instanceId &&
      !!local.httpPort &&
      live.instanceId === local.instanceId &&
      live.httpPort === local.httpPort &&
      live.owned &&
      !live.pending &&
      !live.uncertain &&
      live.phase === 'running' &&
      live.traffic === 'listening'
    )
  }
  const available = (report: SystemProxyReport): boolean =>
    ['inactive', 'restored'].includes(report.status) &&
    !report.recordID &&
    !report.services.some(
      (s) => s.enabled && (s.http || s.https || s.socks || s.pac || s.discovery !== false)
    )
  if (!ready()) return
  const observed = await adapters.inspect()
  if (
    !ready() ||
    !available(observed) ||
    observed.currentProxyPorts?.length !== 0 ||
    observed.currentPacURLHashes?.length !== 0
  )
    return
  const serviceIDs = observed.services.filter((s) => s.enabled).map((s) => s.id)
  if (!serviceIDs.length) return
  const draft = await adapters.draft()
  if (!ready() || !['127.0.0.1', 'localhost', '::1'].includes(draft.host)) return
  const port = systemProxyInboundPort(local.httpPort, local.ports?.mixed, draft)
  const plan = await adapters.prepare({ ...draft, port, serviceIDs })
  const request = { evidenceId: plan.evidenceId }
  try {
    if (
      !ready() ||
      plan.action !== 'apply' ||
      !available(plan.report) ||
      !plan.report.canApply ||
      plan.report.revision !== observed.revision
    )
      return
    if ((await adapters.execute(request)).status !== 'applied')
      throw new Error('启动时系统代理未能启用。')
  } finally {
    adapters.cancel(request)
  }
}
