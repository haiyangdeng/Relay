import type { RelayStoredProfile } from '../../../../shared/relay/profiles'
import type { SubscriptionRequest } from '../../../../shared/relay/subscription'
import type {
  SubscriptionSourceInfo,
  SubscriptionSourcePlan,
  SubscriptionSourceResult
} from '../../../../shared/relay/subscription-sources'

export function subscriptionDashboardEntries(
  profiles: readonly RelayStoredProfile[],
  sources: readonly SubscriptionSourceInfo[]
): {
  subscriptions: { source: SubscriptionSourceInfo; profile?: RelayStoredProfile }[]
  localProfiles: RelayStoredProfile[]
} {
  const linked = new Set(sources.flatMap((source) => source.versions.map((v) => v.profile.id)))
  return {
    subscriptions: sources.map((source) => {
      const latest = source.versions.at(-1)?.profile
      return {
        source,
        profile: latest
          ? profiles.find((profile) => profile.id === latest.id && profile.sha256 === latest.sha256)
          : undefined
      }
    }),
    localProfiles: profiles.filter((profile) => !linked.has(profile.id))
  }
}

type SourceChannel =
  | 'relaySourceRegisterPrepare'
  | 'relaySourceUpdatePrepare'
  | 'relaySourceExecute'
  | 'relaySourceCancel'
export interface SubscriptionDashboardOperation {
  invoke(channel: SourceChannel, input: unknown): Promise<unknown>
  onPlan?(plan: SubscriptionSourcePlan): void
  onProgress?(message: string): void
  cancelled?(): boolean
}
export interface SubscriptionDashboardResult {
  result: SubscriptionSourceResult
  registered: boolean
}

const cancelled = (): SubscriptionSourceResult => ({
  status: 'cancelled',
  warnings: ['已取消后续操作，已经保存的来源或版本保留。']
})

async function executePlan(
  operation: SubscriptionDashboardOperation,
  plan: SubscriptionSourcePlan
): Promise<SubscriptionSourceResult> {
  operation.onPlan?.(plan)
  if (operation.cancelled?.()) {
    await operation.invoke('relaySourceCancel', { evidenceId: plan.evidenceId })
    return cancelled()
  }
  // Every stage still passes through the existing native confirmation and
  // short-lived evidence checks. A rejected stage is never retried.
  return operation.invoke('relaySourceExecute', {
    evidenceId: plan.evidenceId
  }) as Promise<SubscriptionSourceResult>
}

export async function updateDashboardSubscription(
  operation: SubscriptionDashboardOperation,
  source: SubscriptionSourceInfo
): Promise<SubscriptionSourceResult> {
  if (operation.cancelled?.()) return cancelled()
  operation.onProgress?.('正在准备下载订阅…')
  const plan = (await operation.invoke('relaySourceUpdatePrepare', {
    id: source.id,
    revision: source.revision
  })) as SubscriptionSourcePlan
  if (plan.kind !== 'update' || plan.source?.id !== source.id)
    throw new Error('订阅准备结果与所选来源不一致。')
  operation.onProgress?.('请确认下载，完成后将提示保存配置。')
  const result = await executePlan(operation, plan)
  if (result.status !== 'staged') return result
  if (result.plan?.kind !== 'commit' || result.plan.source?.id !== source.id)
    throw new Error('下载结果未提供当前来源的保存凭据。')
  operation.onProgress?.('下载检查完成，请确认保存配置。')
  return executePlan(operation, result.plan)
}

export async function importDashboardSubscription(
  operation: SubscriptionDashboardOperation,
  request: SubscriptionRequest
): Promise<SubscriptionDashboardResult> {
  if (operation.cancelled?.()) return { result: cancelled(), registered: false }
  operation.onProgress?.('请确认保存订阅地址。')
  const plan = (await operation.invoke(
    'relaySourceRegisterPrepare',
    request
  )) as SubscriptionSourcePlan
  if (plan.kind !== 'register') throw new Error('订阅来源准备结果无效。')
  const result = await executePlan(operation, plan)
  if (result.status !== 'saved') return { result, registered: false }
  if (!result.source) throw new Error('订阅来源保存结果未确认，请刷新列表。')
  try {
    return {
      registered: true,
      result: await updateDashboardSubscription(operation, result.source)
    }
  } catch {
    // Registration is already durable. Keep that outcome so a failed download
    // offers an update of the existing card instead of another registration.
    return {
      registered: true,
      result: {
        status: 'failed',
        source: result.source,
        warnings: ['订阅地址已保存，下载或保存配置未完成，请在来源卡片上重试更新。']
      }
    }
  }
}
