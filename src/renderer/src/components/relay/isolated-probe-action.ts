import {
  isolatedProbeRequest,
  type IsolatedProbePlan,
  type IsolatedProbeRequest,
  type IsolatedProbeResult
} from '../../../../shared/relay/isolated-probes'

type ProbeChannel =
  'relayIsolatedProbePrepare' | 'relayIsolatedProbeRun' | 'relayIsolatedProbeCancel'
export async function executeIsolatedProbe(
  input: IsolatedProbeRequest,
  invoke: (channel: ProbeChannel, input: unknown) => Promise<unknown>,
  options: { cancelled(): boolean; prepared(plan: IsolatedProbePlan): void }
): Promise<IsolatedProbeResult> {
  const request = isolatedProbeRequest(input)
  const cancelled = (): IsolatedProbeResult => ({
    status: 'cancelled',
    kind: request.kind,
    measurements: [],
    isolated: true
  })
  if (options.cancelled()) return cancelled()
  const plan = (await invoke('relayIsolatedProbePrepare', request)) as IsolatedProbePlan
  if (plan.kind !== request.kind || plan.sourceSHA256 !== request.profile.sha256)
    throw new Error('探测配置已变化，请重新选择。')
  options.prepared(plan)
  if (options.cancelled()) {
    await invoke('relayIsolatedProbeCancel', { evidenceId: plan.evidenceId })
    return cancelled()
  }
  // Main owns environment checks, one-shot execution and temporary-core cleanup.
  return (await invoke('relayIsolatedProbeRun', {
    evidenceId: plan.evidenceId
  })) as IsolatedProbeResult
}
