export interface RelayGuardComponent {
  presence: 'present' | 'missing' | 'unconfirmed' | 'notBundled'
  identity: 'matches' | 'mismatch' | 'unconfirmed'
  signature: 'staticValid' | 'adHoc' | 'invalid' | 'unconfirmed'
  installEntitlement: boolean
  networkEntitlement: boolean
  sandboxEntitlement: boolean
}
export interface RelayGuardReadiness {
  version: 1
  readOnly: true
  buildMode: 'offline'
  liveOperationsAvailable: false
  protectionVerified: false
  systemExtension: 'notQueried'
  filterConfiguration: 'notQueried'
  runtimeEnforcement: 'notVerified'
  signingMetadataScope: 'currentArchitecture'
  signatureValidationScope: 'allArchitecturesNoNetwork'
  application: RelayGuardComponent
  extensionComponent: RelayGuardComponent
  sameSigningTeam: 'matches' | 'mismatch' | 'unconfirmed'
  sameVersion: 'matches' | 'mismatch' | 'unconfirmed'
  bundleMetadataMatches: boolean
  warnings: string[]
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('保护构建检查格式异常。')
  return raw as Record<string, unknown>
}
function choice<T extends string>(raw: unknown, values: readonly T[]): T {
  if (typeof raw !== 'string' || !values.some((value) => value === raw))
    throw new Error('保护构建状态未知。')
  return raw as T
}
function component(raw: unknown): RelayGuardComponent {
  const value = object(raw)
  const presence = choice(value.presence, [
    'present',
    'missing',
    'unconfirmed',
    'notBundled'
  ] as const)
  const identity = choice(value.identity, ['matches', 'mismatch', 'unconfirmed'] as const)
  const signature = choice(value.signature, [
    'staticValid',
    'adHoc',
    'invalid',
    'unconfirmed'
  ] as const)
  for (const key of ['installEntitlement', 'networkEntitlement', 'sandboxEntitlement'])
    if (typeof value[key] !== 'boolean') throw new Error('保护权限检查格式异常。')
  if (
    presence !== 'present' &&
    (identity !== 'unconfirmed' ||
      signature !== 'unconfirmed' ||
      value.installEntitlement ||
      value.networkEntitlement ||
      value.sandboxEntitlement)
  )
    throw new Error('缺少组件不能保留通过状态。')
  return {
    presence,
    identity,
    signature,
    installEntitlement: value.installEntitlement as boolean,
    networkEntitlement: value.networkEntitlement as boolean,
    sandboxEntitlement: value.sandboxEntitlement as boolean
  }
}
export function validateGuardReadiness(raw: unknown): RelayGuardReadiness {
  const value = object(raw)
  if (
    value.version !== 1 ||
    value.readOnly !== true ||
    value.buildMode !== 'offline' ||
    value.liveOperationsAvailable !== false ||
    value.protectionVerified !== false ||
    value.systemExtension !== 'notQueried' ||
    value.filterConfiguration !== 'notQueried' ||
    value.runtimeEnforcement !== 'notVerified' ||
    value.signingMetadataScope !== 'currentArchitecture' ||
    value.signatureValidationScope !== 'allArchitecturesNoNetwork'
  )
    throw new Error('离线构建检查不能声明已授权或实际保护生效。')
  const application = component(value.application),
    extensionComponent = component(value.extensionComponent)
  const sameSigningTeam = choice(value.sameSigningTeam, [
    'matches',
    'mismatch',
    'unconfirmed'
  ] as const)
  const sameVersion = choice(value.sameVersion, ['matches', 'mismatch', 'unconfirmed'] as const)
  const bothPresent =
    application.presence === 'present' && extensionComponent.presence === 'present'
  if (
    (!bothPresent && sameVersion !== 'unconfirmed') ||
    ((application.signature !== 'staticValid' || extensionComponent.signature !== 'staticValid') &&
      sameSigningTeam !== 'unconfirmed') ||
    (application.presence === 'notBundled' && extensionComponent.presence !== 'notBundled') ||
    (application.presence !== 'notBundled' && extensionComponent.presence === 'notBundled')
  )
    throw new Error('组件配对结论与证据不符。')
  const bundleMetadataMatches =
    [application, extensionComponent].every(
      (item) =>
        item.presence === 'present' &&
        item.identity === 'matches' &&
        item.signature === 'staticValid' &&
        item.networkEntitlement
    ) &&
    application.installEntitlement &&
    extensionComponent.sandboxEntitlement &&
    sameSigningTeam === 'matches' &&
    sameVersion === 'matches'
  if (
    value.bundleMetadataMatches !== bundleMetadataMatches ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 16 ||
    value.warnings.some((warning) => typeof warning !== 'string' || warning.length > 2048)
  )
    throw new Error('保护构建检查结论或说明无效。')
  return {
    version: 1,
    readOnly: true,
    buildMode: 'offline',
    liveOperationsAvailable: false,
    protectionVerified: false,
    systemExtension: 'notQueried',
    filterConfiguration: 'notQueried',
    runtimeEnforcement: 'notVerified',
    signingMetadataScope: 'currentArchitecture',
    signatureValidationScope: 'allArchitecturesNoNetwork',
    application,
    extensionComponent,
    sameSigningTeam,
    sameVersion,
    bundleMetadataMatches,
    warnings: value.warnings
  }
}
