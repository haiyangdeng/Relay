// Preparation only. Neither a well-formed report nor readyForConfirmation is an
// authorization to install a helper, start a core, or change a host route/DNS.
export interface TunPlanRequest {
  configurationSHA256: string
  bundleSHA256: string
}
export interface TunHelperObservation {
  version: 1
  source: 'native'
  observedAt: number
  revision: string
  state: 'missing' | 'requiresApproval' | 'ready' | 'conflict' | 'unconfirmed'
  identity: 'authenticated' | 'mismatch' | 'unconfirmed'
  authorization: 'approved' | 'notApproved' | 'unconfirmed'
  rootOwned: boolean
  runningAsRoot: boolean
  clientUID: number
  helperSHA256?: string
  coreSHA256?: string
  execution?: 'core-managed'
  privilegedCoreVerified?: boolean
}
export interface TunNetworkObservation {
  version: 1
  source: 'native'
  observedAt: number
  state: 'observed' | 'unavailable' | 'conflict'
  revision: string
  routesSHA256: string
  dnsSHA256: string
  interfacesSHA256: string
  proxySHA256: string
  protectionSHA256: string
  existingTunnel: 'none' | 'present' | 'unconfirmed'
  recovery: 'available' | 'conflict' | 'unconfirmed'
}
export type TunPlanIssue =
  | 'parserNotPassed'
  | 'parserDigestMismatch'
  | 'helperNotReady'
  | 'helperIdentityUnconfirmed'
  | 'helperAuthorizationUnconfirmed'
  | 'helperResourceMismatch'
  | 'helperPrivilegeUnconfirmed'
  | 'helperClientMismatch'
  | 'networkUnconfirmed'
  | 'existingTunnelUnresolved'
  | 'recoveryUnavailable'
  | 'observationExpired'
export interface TunPreparation {
  version: 1
  configurationSHA256: string
  bundleSHA256: string
  tunSHA256: string
  assetsSHA256: string
  helperRevision: string
  networkRevision: string
  evidenceSHA256: string
  createdAt: number
  expiresAt: number
  readyForConfirmation: boolean
  canApply: false
  active: false
  runtimeVerified: false
  protectionVerified: false
  effects: { device: string; autoRoute: boolean; dnsHijack: boolean }
  issues: TunPlanIssue[]
}
export interface TunSessionPreparation extends TunPreparation {
  evidenceId: string
}
export interface TunSessionState {
  phase: 'idle' | 'prepared' | 'starting' | 'active' | 'stopping' | 'restored' | 'uncertain'
  pending: boolean
  owned: boolean
  sessionId?: string
  traffic: 'forwarding' | 'inactive' | 'unconfirmed'
  restorationVerified: boolean
  protectionVerified: false
  warnings: string[]
}
export interface TunSessionResult {
  status: 'started' | 'restored' | 'cancelled' | 'failed' | 'uncertain'
  state: TunSessionState
}
export interface TunStatus {
  session: TunSessionState
  helper: 'ready' | 'missing' | 'requiresApproval' | 'unavailable' | 'unconfirmed'
  warnings: string[]
}
export interface TunEvidenceRequest {
  evidenceId: string
}
export interface TunSessionRequest {
  sessionId: string
}
export interface TunIpcApi {
  relayTunStatus(): Promise<TunStatus>
  relayTunPrepare(request: TunEvidenceRequest): Promise<TunSessionPreparation>
  relayTunStart(request: TunEvidenceRequest): Promise<TunSessionResult>
  relayTunCancel(request: TunEvidenceRequest): Promise<void>
  relayTunStop(request: TunSessionRequest): Promise<TunSessionResult>
  relayTunInspect(): Promise<TunSessionState>
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const tunDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const choice = (value: unknown, values: readonly string[]): value is string =>
  typeof value === 'string' && values.includes(value)
const keys = (raw: Record<string, unknown>, required: string[], optional: string[] = []): boolean =>
  required.every((key) => Object.hasOwn(raw, key)) &&
  Object.keys(raw).every((key) => required.includes(key) || optional.includes(key))
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
const warnings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 32 &&
  value.every((line) => typeof line === 'string' && line.length <= 4096)
export function tunEvidenceRequest(raw: unknown): TunEvidenceRequest {
  if (!object(raw) || !keys(raw, ['evidenceId']) || !uuid(raw.evidenceId))
    throw new Error('TUN操作仅接受本次完整检查或准备凭据，不接受配置正文、路径、PID或FD。')
  return { evidenceId: raw.evidenceId }
}
export function tunSessionRequest(raw: unknown): TunSessionRequest {
  if (!object(raw) || !keys(raw, ['sessionId']) || !uuid(raw.sessionId))
    throw new Error('TUN停用仅接受本次会话标识，不接受路径、PID或FD。')
  return { sessionId: raw.sessionId }
}
export function tunSessionState(raw: unknown): TunSessionState {
  if (
    !object(raw) ||
    !keys(
      raw,
      [
        'phase',
        'pending',
        'owned',
        'traffic',
        'restorationVerified',
        'protectionVerified',
        'warnings'
      ],
      ['sessionId']
    ) ||
    !choice(raw.phase, [
      'idle',
      'prepared',
      'starting',
      'active',
      'stopping',
      'restored',
      'uncertain'
    ]) ||
    typeof raw.pending !== 'boolean' ||
    typeof raw.owned !== 'boolean' ||
    !choice(raw.traffic, ['forwarding', 'inactive', 'unconfirmed']) ||
    typeof raw.restorationVerified !== 'boolean' ||
    raw.protectionVerified !== false ||
    !warnings(raw.warnings) ||
    (Object.hasOwn(raw, 'sessionId') && !uuid(raw.sessionId)) ||
    (raw.owned && !uuid(raw.sessionId)) ||
    (raw.traffic === 'forwarding' && (raw.phase !== 'active' || !raw.owned)) ||
    (raw.restorationVerified && (raw.phase !== 'restored' || raw.owned)) ||
    (raw.phase === 'active' && (!raw.owned || raw.traffic !== 'forwarding')) ||
    (raw.phase === 'restored' &&
      (!raw.restorationVerified || raw.owned || raw.traffic !== 'inactive')) ||
    (raw.owned && ['idle', 'prepared'].includes(raw.phase))
  )
    throw new Error('TUN会话状态缺少有效的所有权、流量或恢复证据。')
  return {
    phase: raw.phase as TunSessionState['phase'],
    pending: raw.pending,
    owned: raw.owned,
    ...(uuid(raw.sessionId) ? { sessionId: raw.sessionId } : {}),
    traffic: raw.traffic as TunSessionState['traffic'],
    restorationVerified: raw.restorationVerified,
    protectionVerified: false,
    warnings: [...raw.warnings]
  }
}
export function tunStatus(raw: unknown): TunStatus {
  if (
    !object(raw) ||
    !keys(raw, ['session', 'helper', 'warnings']) ||
    !choice(raw.helper, ['ready', 'missing', 'requiresApproval', 'unavailable', 'unconfirmed']) ||
    !warnings(raw.warnings)
  )
    throw new Error('TUN辅助组件状态无效。')
  return {
    session: tunSessionState(raw.session),
    helper: raw.helper as TunStatus['helper'],
    warnings: [...raw.warnings]
  }
}
export function tunSessionResult(raw: unknown): TunSessionResult {
  if (
    !object(raw) ||
    !keys(raw, ['status', 'state']) ||
    !choice(raw.status, ['started', 'restored', 'cancelled', 'failed', 'uncertain'])
  )
    throw new Error('TUN操作结果无效。')
  const state = tunSessionState(raw.state)
  if (
    (raw.status === 'started' && (state.phase !== 'active' || state.traffic !== 'forwarding')) ||
    (raw.status === 'restored' && (!state.restorationVerified || state.owned))
  )
    throw new Error('TUN操作结果与会话证据不一致。')
  return { status: raw.status as TunSessionResult['status'], state }
}
export function tunSessionPreparation(raw: unknown): TunSessionPreparation {
  const digestKeys = [
    'configurationSHA256',
    'bundleSHA256',
    'tunSHA256',
    'assetsSHA256',
    'helperRevision',
    'networkRevision',
    'evidenceSHA256'
  ]
  if (
    !object(raw) ||
    !keys(raw, [
      'version',
      ...digestKeys,
      'createdAt',
      'expiresAt',
      'readyForConfirmation',
      'canApply',
      'active',
      'runtimeVerified',
      'protectionVerified',
      'effects',
      'issues',
      'evidenceId'
    ]) ||
    raw.version !== 1 ||
    digestKeys.some((key) => !tunDigest(raw[key])) ||
    !uuid(raw.evidenceId) ||
    !timestamp(raw.createdAt) ||
    !timestamp(raw.expiresAt) ||
    raw.expiresAt < raw.createdAt ||
    typeof raw.readyForConfirmation !== 'boolean' ||
    raw.canApply !== false ||
    raw.active !== false ||
    raw.runtimeVerified !== false ||
    raw.protectionVerified !== false ||
    !object(raw.effects) ||
    !keys(raw.effects, ['device', 'autoRoute', 'dnsHijack']) ||
    typeof raw.effects.device !== 'string' ||
    raw.effects.device.length > 16 ||
    typeof raw.effects.autoRoute !== 'boolean' ||
    typeof raw.effects.dnsHijack !== 'boolean' ||
    !Array.isArray(raw.issues) ||
    raw.issues.length > 32 ||
    raw.issues.some(
      (issue) =>
        !choice(issue, [
          'parserNotPassed',
          'parserDigestMismatch',
          'helperNotReady',
          'helperIdentityUnconfirmed',
          'helperAuthorizationUnconfirmed',
          'helperResourceMismatch',
          'helperPrivilegeUnconfirmed',
          'helperClientMismatch',
          'networkUnconfirmed',
          'existingTunnelUnresolved',
          'recoveryUnavailable',
          'observationExpired'
        ])
    ) ||
    raw.readyForConfirmation !== (raw.issues.length === 0)
  )
    throw new Error('TUN准备结果无效。')
  return {
    version: 1,
    configurationSHA256: raw.configurationSHA256 as string,
    bundleSHA256: raw.bundleSHA256 as string,
    tunSHA256: raw.tunSHA256 as string,
    assetsSHA256: raw.assetsSHA256 as string,
    helperRevision: raw.helperRevision as string,
    networkRevision: raw.networkRevision as string,
    evidenceSHA256: raw.evidenceSHA256 as string,
    evidenceId: raw.evidenceId,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    readyForConfirmation: raw.readyForConfirmation,
    canApply: false,
    active: false,
    runtimeVerified: false,
    protectionVerified: false,
    effects: {
      device: raw.effects.device,
      autoRoute: raw.effects.autoRoute,
      dnsHijack: raw.effects.dnsHijack
    },
    issues: raw.issues.map((issue) => issue as TunPlanIssue)
  }
}
export function tunPlanRequest(raw: unknown): TunPlanRequest {
  if (
    !object(raw) ||
    !keys(raw, ['configurationSHA256', 'bundleSHA256']) ||
    !tunDigest(raw.configurationSHA256) ||
    !tunDigest(raw.bundleSHA256)
  )
    throw new Error('TUN准备仅接受完整候选与资源包摘要，不接受路径、PID或授权状态。')
  return { configurationSHA256: raw.configurationSHA256, bundleSHA256: raw.bundleSHA256 }
}
// These are validation of trusted native-adapter output, not of renderer claims.
export function tunHelperObservation(raw: unknown): TunHelperObservation {
  if (
    !object(raw) ||
    !keys(
      raw,
      [
        'version',
        'source',
        'observedAt',
        'revision',
        'state',
        'identity',
        'authorization',
        'rootOwned',
        'runningAsRoot',
        'clientUID'
      ],
      ['helperSHA256', 'coreSHA256', 'execution', 'privilegedCoreVerified']
    ) ||
    raw.version !== 1 ||
    raw.source !== 'native' ||
    !timestamp(raw.observedAt) ||
    !tunDigest(raw.revision) ||
    !choice(raw.state, ['missing', 'requiresApproval', 'ready', 'conflict', 'unconfirmed']) ||
    !choice(raw.identity, ['authenticated', 'mismatch', 'unconfirmed']) ||
    !choice(raw.authorization, ['approved', 'notApproved', 'unconfirmed']) ||
    typeof raw.rootOwned !== 'boolean' ||
    typeof raw.runningAsRoot !== 'boolean' ||
    (raw.execution !== undefined && raw.execution !== 'core-managed') ||
    (raw.privilegedCoreVerified !== undefined && typeof raw.privilegedCoreVerified !== 'boolean') ||
    (raw.execution === 'core-managed') !== (raw.privilegedCoreVerified !== undefined) ||
    !Number.isSafeInteger(raw.clientUID) ||
    Number(raw.clientUID) < 1 ||
    Number(raw.clientUID) > 0xffffffff ||
    ['helperSHA256', 'coreSHA256'].some((key) => Object.hasOwn(raw, key) && !tunDigest(raw[key]))
  )
    throw new Error('TUN辅助组件观察信息无效。')
  return {
    version: 1,
    source: 'native',
    observedAt: raw.observedAt,
    revision: raw.revision,
    state: raw.state as TunHelperObservation['state'],
    identity: raw.identity as TunHelperObservation['identity'],
    authorization: raw.authorization as TunHelperObservation['authorization'],
    rootOwned: raw.rootOwned,
    runningAsRoot: raw.runningAsRoot,
    ...(raw.execution === 'core-managed'
      ? {
          execution: 'core-managed' as const,
          privilegedCoreVerified: raw.privilegedCoreVerified === true
        }
      : {}),
    clientUID: Number(raw.clientUID),
    ...(tunDigest(raw.helperSHA256) ? { helperSHA256: raw.helperSHA256 } : {}),
    ...(tunDigest(raw.coreSHA256) ? { coreSHA256: raw.coreSHA256 } : {})
  }
}
export function tunNetworkObservation(raw: unknown): TunNetworkObservation {
  if (
    !object(raw) ||
    !keys(raw, [
      'version',
      'source',
      'observedAt',
      'state',
      'revision',
      'routesSHA256',
      'dnsSHA256',
      'interfacesSHA256',
      'proxySHA256',
      'protectionSHA256',
      'existingTunnel',
      'recovery'
    ]) ||
    raw.version !== 1 ||
    raw.source !== 'native' ||
    !timestamp(raw.observedAt) ||
    !choice(raw.state, ['observed', 'unavailable', 'conflict']) ||
    !choice(raw.existingTunnel, ['none', 'present', 'unconfirmed']) ||
    !choice(raw.recovery, ['available', 'conflict', 'unconfirmed']) ||
    [
      'revision',
      'routesSHA256',
      'dnsSHA256',
      'interfacesSHA256',
      'proxySHA256',
      'protectionSHA256'
    ].some((key) => !tunDigest(raw[key]))
  )
    throw new Error('TUN网络与恢复观察信息无效。')
  return {
    version: 1,
    source: 'native',
    observedAt: raw.observedAt,
    state: raw.state as TunNetworkObservation['state'],
    revision: String(raw.revision),
    routesSHA256: String(raw.routesSHA256),
    dnsSHA256: String(raw.dnsSHA256),
    interfacesSHA256: String(raw.interfacesSHA256),
    proxySHA256: String(raw.proxySHA256),
    protectionSHA256: String(raw.protectionSHA256),
    existingTunnel: raw.existingTunnel as TunNetworkObservation['existingTunnel'],
    recovery: raw.recovery as TunNetworkObservation['recovery']
  }
}
