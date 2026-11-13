export const guardManagementActions = [
  'status',
  'install',
  'enable',
  'disable',
  'revoke',
  'prepare',
  'launchDesktop'
] as const
export type GuardManagementAction = (typeof guardManagementActions)[number]
export const guardManagementPhases = [
  'unavailable',
  'idle',
  'checking',
  'awaitingUserApproval',
  'activationCompleted',
  'rebootRequired',
  'configurationEnabled',
  'configurationDisabled',
  'failedUnchanged',
  'blocked',
  'uncertain'
] as const
export const guardInstallationSteps = [
  'notRequested',
  'requesting',
  'awaitingUserApproval',
  'completed',
  'rebootRequired',
  'failed',
  'cancelled'
] as const
export interface GuardInstallationReceipt {
  lineage: (typeof guardInstallationSteps)[number]
  filter: (typeof guardInstallationSteps)[number]
  monitoringVerified: false
  fullDiskAccess: 'notQueried'
}
const guardExtensionStates = [
  'absent',
  'enabled',
  'disabled',
  'awaitingUserApproval',
  'uninstalling',
  'differentVersion',
  'unknown'
] as const
export type GuardExtensionState = (typeof guardExtensionStates)[number]
export interface GuardManagementSnapshot {
  phase: (typeof guardManagementPhases)[number]
  pending: boolean
  systemOperationAttempted: boolean
  protectionVerified: false
  runtimeEnforcement: 'notVerified'
  configuration?: { exists: boolean; owned: boolean; enabled: boolean; revision: string }
  installation?: GuardInstallationReceipt
  extensions?: { lineage: GuardExtensionState; filter: GuardExtensionState }
  policy?: {
    phase: 'unbound' | 'unconfirmed' | 'preparedLocally' | 'prepared' | 'ready'
    instanceID?: string
    configurationSHA256?: string
  }
  scopedPolicy?: GuardManagementSnapshot['policy']
  reason?: string
}
const reasons = new Set([
  'publisherNotConfigured',
  'releaseNotInstallable',
  'trustedPolicyBindingUnavailable',
  'packageIdentityUnconfirmed',
  'operationPending',
  'userCancelled',
  'configurationChanged',
  'configurationOwnershipUnconfirmed',
  'systemRequestFailed',
  'nativeModuleUnavailable'
])
export function guardManagementAction(raw: unknown): GuardManagementAction {
  if (typeof raw !== 'string' || !guardManagementActions.some((action) => action === raw))
    throw new Error('过滤管理仅接受固定操作，不接受路径、身份或就绪布尔。')
  return raw as GuardManagementAction
}
export function guardManagementSnapshot(raw: unknown): GuardManagementSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('过滤管理状态未确认。')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'phase',
          'pending',
          'systemOperationAttempted',
          'protectionVerified',
          'runtimeEnforcement',
          'configuration',
          'installation',
          'extensions',
          'reason',
          'policy',
          'scopedPolicy'
        ].includes(key)
    ) ||
    !guardManagementPhases.some((phase) => phase === value.phase) ||
    typeof value.pending !== 'boolean' ||
    typeof value.systemOperationAttempted !== 'boolean' ||
    value.protectionVerified !== false ||
    value.runtimeEnforcement !== 'notVerified' ||
    (value.reason !== undefined && (typeof value.reason !== 'string' || !reasons.has(value.reason)))
  )
    throw new Error('管理或配置事实不能声明实际禁止直连已经生效。')
  let configuration: GuardManagementSnapshot['configuration']
  let installation: GuardInstallationReceipt | undefined
  let extensions: GuardManagementSnapshot['extensions']
  if (value.extensions !== undefined) {
    if (
      !value.extensions ||
      typeof value.extensions !== 'object' ||
      Array.isArray(value.extensions)
    )
      throw new Error('系统扩展状态格式异常。')
    const observed = value.extensions as Record<string, unknown>
    const lineage = guardExtensionStates.find((status) => status === observed.lineage)
    const filter = guardExtensionStates.find((status) => status === observed.filter)
    if (Object.keys(observed).sort().join(',') !== 'filter,lineage' || !lineage || !filter)
      throw new Error('系统扩展状态未确认。')
    extensions = { lineage, filter }
  }
  if (value.installation !== undefined) {
    if (
      !value.installation ||
      typeof value.installation !== 'object' ||
      Array.isArray(value.installation)
    )
      throw new Error('扩展安装步骤未确认。')
    const receipt = value.installation as Record<string, unknown>
    if (
      Object.keys(receipt).sort().join(',') !==
        'filter,fullDiskAccess,lineage,monitoringVerified' ||
      !guardInstallationSteps.some((step) => step === receipt.lineage) ||
      !guardInstallationSteps.some((step) => step === receipt.filter) ||
      receipt.monitoringVerified !== false ||
      receipt.fullDiskAccess !== 'notQueried'
    )
      throw new Error('系统扩展请求回执不能证明监控运行或全磁盘访问权限。')
    installation = {
      lineage: receipt.lineage as GuardInstallationReceipt['lineage'],
      filter: receipt.filter as GuardInstallationReceipt['filter'],
      monitoringVerified: false,
      fullDiskAccess: 'notQueried'
    }
  }
  if (value.configuration !== undefined) {
    if (
      !value.configuration ||
      typeof value.configuration !== 'object' ||
      Array.isArray(value.configuration)
    )
      throw new Error('过滤配置观测格式异常。')
    const c = value.configuration as Record<string, unknown>
    if (
      Object.keys(c).sort().join(',') !== 'enabled,exists,owned,revision' ||
      typeof c.exists !== 'boolean' ||
      typeof c.owned !== 'boolean' ||
      typeof c.enabled !== 'boolean' ||
      typeof c.revision !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(c.revision) ||
      (c.owned && !c.exists)
    )
      throw new Error('过滤配置身份或版本未确认。')
    configuration = { exists: c.exists, owned: c.owned, enabled: c.enabled, revision: c.revision }
  }
  let policy: GuardManagementSnapshot['policy']
  if (value.policy !== undefined) {
    if (!value.policy || typeof value.policy !== 'object' || Array.isArray(value.policy))
      throw new Error('过滤会话未确认。')
    const p = value.policy as Record<string, unknown>
    if (
      (p.phase === 'unbound' || p.phase === 'unconfirmed') &&
      Object.keys(p).join(',') === 'phase'
    )
      policy = { phase: p.phase }
    else if (
      (p.phase === 'preparedLocally' || p.phase === 'prepared' || p.phase === 'ready') &&
      Object.keys(p).sort().join(',') === 'configurationSHA256,instanceID,phase' &&
      typeof p.instanceID === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(p.instanceID) &&
      typeof p.configurationSHA256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(p.configurationSHA256)
    )
      policy = {
        phase: p.phase,
        instanceID: p.instanceID,
        configurationSHA256: p.configurationSHA256
      }
    else throw new Error('过滤会话只接受本次固定实例的签名回执。')
  }
  let scopedPolicy: GuardManagementSnapshot['policy']
  if (value.scopedPolicy !== undefined) {
    const { scopedPolicy: scoped, ...rest } = value
    scopedPolicy = guardManagementSnapshot({ ...rest, policy: scoped }).policy
  }
  return {
    phase: value.phase as GuardManagementSnapshot['phase'],
    pending: value.pending,
    systemOperationAttempted: value.systemOperationAttempted,
    protectionVerified: false,
    runtimeEnforcement: 'notVerified',
    ...(policy ? { policy } : {}),
    ...(scopedPolicy ? { scopedPolicy } : {}),
    ...(configuration ? { configuration } : {}),
    ...(installation ? { installation } : {}),
    ...(extensions ? { extensions } : {}),
    ...(value.reason ? { reason: value.reason as string } : {})
  }
}
