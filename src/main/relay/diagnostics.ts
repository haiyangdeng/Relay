import { randomUUID } from 'crypto'
import {
  type RelayGuardPlanOutput,
  type RelayObservation,
  type RelayPreferences,
  type RelayReadOnlyReport,
  validatePreferences,
  validateReadOnlyReport
} from '../../shared/relay/protocol'

export function createDiagnosticService(adapters: {
  observe(settings: RelayPreferences): Promise<RelayReadOnlyReport>
  ownedObserve?(): Promise<Pick<RelayObservation, 'parameters' | 'report' | 'owned'>>
  guardPlan(node: string, proxyTypes: Record<string, string>): Promise<RelayGuardPlanOutput>
  now(): number
}): {
  observe(raw: unknown): Promise<RelayObservation>
  guardPlan(node: string, evidenceId: string): Promise<RelayGuardPlanOutput>
  clear(): void
} {
  let sequence = 0
  let latest: { observation: RelayObservation; at: number } | undefined
  const requireEvidence = (evidenceId: string): RelayObservation => {
    const age = latest ? adapters.now() - latest.at : Infinity
    if (!latest || latest.observation.evidenceId !== evidenceId || age < 0 || age > 60000)
      throw new Error('节点证据缺失或已超过60秒，请重新执行只读检测。')
    return latest.observation
  }
  return {
    async observe(raw) {
      if (adapters.ownedObserve && raw !== undefined)
        throw new Error('Relay 当前配置检测不接受参数。')
      const requested = adapters.ownedObserve ? undefined : validatePreferences(raw)
      const request = ++sequence
      const startedAt = adapters.now()
      latest = undefined
      const owned = await adapters.ownedObserve?.()
      const parameters = owned?.parameters ?? requested
      if (!parameters) throw new Error('检测参数未确认。')
      const report = validateReadOnlyReport(owned?.report ?? (await adapters.observe(parameters)))
      if (request !== sequence) throw new Error('检测结果已过期，请重新执行只读检测。')
      const observation: RelayObservation = {
        evidenceId: randomUUID(),
        source: owned ? 'relay-owned' : 'legacy-readonly',
        parameters,
        report,
        ...(owned ? { owned: owned.owned } : {})
      }
      latest = { observation: structuredClone(observation), at: startedAt }
      return observation
    },
    async guardPlan(node, evidenceId) {
      const snapshot = requireEvidence(evidenceId).report.snapshot
      if (
        !snapshot.controllerConnected ||
        !snapshot.nodeNames.includes(node) ||
        !Object.hasOwn(snapshot.proxyTypes, node)
      )
        throw new Error('核心尚未确认此具体节点，不能生成部署方案。')
      const plan = await adapters.guardPlan(node, structuredClone(snapshot.proxyTypes))
      requireEvidence(evidenceId)
      return plan
    },
    clear() {
      sequence++
      latest = undefined
    }
  }
}
