import { validateEdgeReviewKeys } from './edge'
import type { OwnedDiagnosticObservation, OwnedNativeDiagnostic } from './diagnostic-evidence'

export interface RelayPreviewInput {
  httpPort: number
  node: string
  internalExceptions: string
  existingJSON: string
}

export interface RelayPreviewOutput {
  settingsJSON: string
  noProxy: string
  plan: string
  rules: string
  dns: string
  listeners: string
  warnings: string[]
}

export interface RelaySimulationOutput {
  rows: { name: string; expected: 'allow' | 'drop'; actual: 'allow' | 'drop'; passed: boolean }[]
  protected: false
  warnings: string[]
}

export interface RelayEdgeProfileOutput {
  profileXML: string
  installed: false
  warnings: string[]
}

export type RelayPreferences = Omit<RelayPreviewInput, 'existingJSON'>
export interface RelayPreferenceSnapshot {
  preferences: RelayPreferences
  source: 'relay' | 'legacy' | 'defaults'
  revision: string
  warnings: string[]
}
export interface RelaySavePreferencesRequest {
  preferences: RelayPreferences
  revision: string
}
export type RelayCodeTarget =
  'claudeSettings' | 'assistantPreferences' | 'browserLocalState' | 'browserPreferences'
export interface RelayCodePrepared {
  revision: string
  httpPort: number
  changedTargets: RelayCodeTarget[]
  browserState: 'closed' | 'running' | 'unconfirmed'
  helperReady: boolean
  canApply: boolean
  warnings: string[]
}
export interface RelayCodePreparation extends RelayCodePrepared {
  evidenceId: string
  parameters: RelayPreferences
}
export interface RelayCodeApplied {
  status: 'applied'
  backupId: string
  preferenceSnapshot: RelayPreferenceSnapshot
  warnings: string[]
}
export type RelayCodeApplyResult =
  RelayCodeApplied | { status: 'cancelled' | 'uncertain'; warnings: string[] }
export interface RelayBrowserLaunchResult {
  status: 'requested'
  warnings: string[]
}

export type RelayBackupSource = 'relay' | 'legacy'
export interface RelayBackupDirectoryResult {
  status: 'requested'
  source: RelayBackupSource
}
export function validateBackupSource(raw: unknown): { source: RelayBackupSource } {
  const value = record(raw)
  if (Object.keys(value).length !== 1) throw new Error('只接受固定的备份来源，不接受目录或地址。')
  return { source: choice(value.source, ['relay', 'legacy'] as const) }
}

export type RelayDesktopDecision =
  'notApplicable' | 'alreadyOriginal' | 'restoreEligible' | 'blocked' | 'unconfirmed'
export interface RelayDesktopReadiness {
  edgeInstalled: boolean
  edgePoliciesReady: boolean
  edgeClosed: boolean
  claudeInstalled: boolean
  browserReady: boolean
  defaults: Partial<Record<'http' | 'https', string>>
  sharedDefaults: boolean
  records: {
    source: RelayBackupSource
    state: 'missing' | 'pending' | 'invalid' | 'unreadable'
    phase: 'none' | 'starting' | 'active' | 'restoring' | 'invalid' | 'unreadable'
    decisions: Record<'http' | 'https', RelayDesktopDecision>
  }[]
  configurationReady: boolean
  readOnly: true
  startEnabled: false
  proxy: 'notTested'
  locks: 'notAcquired'
  warnings: string[]
}
export function validateDesktopReadiness(raw: unknown): RelayDesktopReadiness {
  const value = record(raw)
  if (
    value.readOnly !== true ||
    value.startEnabled !== false ||
    value.proxy !== 'notTested' ||
    value.locks !== 'notAcquired'
  )
    throw new Error('只读桌面检查不能声明已取得登录或恢复权限。')
  const edgeInstalled = booleanValue(value.edgeInstalled),
    edgePoliciesReady = booleanValue(value.edgePoliciesReady),
    edgeClosed = booleanValue(value.edgeClosed),
    claudeInstalled = booleanValue(value.claudeInstalled),
    browserReady = booleanValue(value.browserReady)
  if (browserReady !== (edgeInstalled && edgePoliciesReady && edgeClosed))
    throw new Error('Edge 登录条件与检查证据不一致。')
  const defaults: RelayDesktopReadiness['defaults'] = {}
  for (const [scheme, id] of Object.entries(record(value.defaults))) {
    if (
      !['http', 'https'].includes(scheme) ||
      typeof id !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,255}$/u.test(id)
    )
      throw new Error('默认浏览器身份格式异常。')
    defaults[scheme as 'http' | 'https'] = id
  }
  const sharedDefaults = booleanValue(value.sharedDefaults)
  if (sharedDefaults && (!defaults.http || defaults.http !== defaults.https))
    throw new Error('默认浏览器配对结论不一致。')
  if (!Array.isArray(value.records) || value.records.length !== 2)
    throw new Error('桌面恢复来源不完整。')
  const records = value.records.map((rawRecord): RelayDesktopReadiness['records'][number] => {
    const item = record(rawRecord)
    const source = choice(item.source, ['relay', 'legacy'] as const)
    const state = choice(item.state, ['missing', 'pending', 'invalid', 'unreadable'] as const)
    const phase = choice(item.phase, [
      'none',
      'starting',
      'active',
      'restoring',
      'invalid',
      'unreadable'
    ] as const)
    const rawDecisions = record(item.decisions)
    if (
      Object.keys(rawDecisions).sort().join(',') !== 'http,https' ||
      (state === 'missing'
        ? phase !== 'none'
        : state === 'pending'
          ? !['starting', 'active', 'restoring'].includes(phase)
          : phase !== state)
    )
      throw new Error('桌面恢复阶段无效。')
    const decisions = Object.fromEntries(
      ['http', 'https'].map((scheme) => [
        scheme,
        choice(rawDecisions[scheme], [
          'notApplicable',
          'alreadyOriginal',
          'restoreEligible',
          'blocked',
          'unconfirmed'
        ] as const)
      ])
    ) as Record<'http' | 'https', RelayDesktopDecision>
    if (
      Object.values(decisions).some((decision) =>
        state === 'missing'
          ? decision !== 'notApplicable'
          : state === 'pending'
            ? decision === 'notApplicable'
            : decision !== 'unconfirmed'
      )
    )
      throw new Error('桌面恢复判断与记录状态不一致。')
    return { source, state, phase, decisions }
  })
  if (new Set(records.map((item) => item.source)).size !== 2) throw new Error('桌面恢复来源重复。')
  const configurationReady =
    edgeInstalled &&
    edgePoliciesReady &&
    edgeClosed &&
    claudeInstalled &&
    browserReady &&
    sharedDefaults &&
    records.every((item) => item.state === 'missing')
  if (value.configurationReady !== configurationReady) throw new Error('桌面检查结论与证据不一致。')
  return {
    edgeInstalled,
    edgePoliciesReady,
    edgeClosed,
    claudeInstalled,
    browserReady,
    defaults,
    sharedDefaults,
    records,
    configurationReady,
    readOnly: true,
    startEnabled: false,
    proxy: 'notTested',
    locks: 'notAcquired',
    warnings: warningsValue(value.warnings)
  }
}

export function validateCodePrepared(raw: unknown): RelayCodePrepared {
  const value = record(raw)
  const httpPort = validatePreviewInput({
    httpPort: value.httpPort,
    node: 'validation-node',
    internalExceptions: '',
    existingJSON: '{}'
  }).httpPort
  if (
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.revision) ||
    !Array.isArray(value.changedTargets) ||
    value.changedTargets.length > 4
  )
    throw new Error('Code 准备结果格式异常。')
  const changedTargets = value.changedTargets.map((target) =>
    choice(target, [
      'claudeSettings',
      'assistantPreferences',
      'browserLocalState',
      'browserPreferences'
    ] as const)
  )
  const browserState = choice(value.browserState, ['closed', 'running', 'unconfirmed'] as const)
  const helperReady = booleanValue(value.helperReady),
    canApply = booleanValue(value.canApply)
  if (
    new Set(changedTargets).size !== changedTargets.length ||
    canApply !== (helperReady && browserState === 'closed' && changedTargets.length > 0)
  )
    throw new Error('Code 准备结论与证据不一致。')
  return {
    revision: value.revision,
    httpPort,
    changedTargets,
    browserState,
    helperReady,
    canApply,
    warnings: warningsValue(value.warnings)
  }
}
export function validateCodeApplied(raw: unknown): RelayCodeApplied {
  const value = record(raw)
  if (
    value.status !== 'applied' ||
    typeof value.backupId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,200}$/u.test(value.backupId)
  )
    throw new Error('Code 写入结果未确认。')
  const preferenceSnapshot = validatePreferenceSnapshot(value.preferenceSnapshot)
  if (preferenceSnapshot.source !== 'relay') throw new Error('Code 写入参数结果异常。')
  return {
    status: 'applied',
    backupId: value.backupId,
    preferenceSnapshot,
    warnings: warningsValue(value.warnings)
  }
}
export type RelayBackupPhase =
  | 'legacy'
  | 'prepared'
  | 'committed'
  | 'recoveryNeeded'
  | 'restoring'
  | 'rolledBack'
  | 'restored'
  | 'unreadable'
export interface RelayRecoveryStatus {
  metadataOnly: true
  restoreEnabled: true
  inventories: {
    source: 'relay' | 'legacy'
    availability: 'missing' | 'readable' | 'unreadable'
    complete: boolean
    entries: {
      id: string
      createdAt: string
      version: number
      phase: RelayBackupPhase
      targetCount: number
    }[]
  }[]
  warnings: string[]
}
export type RelayCheckState = 'verifiedConfiguration' | 'attention' | 'pending'
export interface RelayRecoverySelection {
  source: 'relay' | 'legacy'
  id: string
}
export type RelayRecoveryIssue =
  | 'manifestInvalid'
  | 'targetOutsideScope'
  | 'originalInvalid'
  | 'targetChanged'
  | 'targetUnreadable'
  | 'targetModeUnknown'
  | 'legacyConfirmationRequired'
  | 'transactionFinished'
  | 'browserRunning'
  | 'browserProcessUnconfirmed'
export interface RelayRecoveryPreflight {
  selection: RelayRecoverySelection
  version: number
  phase: RelayBackupPhase
  revision: string
  targets: {
    index: number
    target:
      | 'claudeSettings'
      | 'assistantPreferences'
      | 'browserLocalState'
      | 'browserPreferences'
      | 'unknown'
    original: 'verified' | 'absent' | 'unverifiedLegacy' | 'invalid' | 'unreadable' | 'unassessed'
    current: 'original' | 'installed' | 'unverifiedMode' | 'changed' | 'unreadable' | 'unassessed'
  }[]
  issues: RelayRecoveryIssue[]
  requiresLegacyConfirmation: boolean
  browser: 'notApplicable' | 'running' | 'unconfirmed' | 'closed'
  fileChecksPassed: boolean
  snapshotOnly: true
  restoreEnabled: false
  warnings: string[]
}
export interface RelayRecoveryInspection extends RelayRecoveryPreflight {
  evidenceId: string
}
export interface RelayRecoveryRestoreResult {
  status: 'cancelled' | 'restored' | 'uncertain'
  warnings: string[]
}
export function recoveryCanRequestRestore(report: RelayRecoveryPreflight): boolean {
  return (
    report.targets.length > 0 &&
    report.issues.every(
      (issue) => issue === 'legacyConfirmationRequired' || issue === 'targetModeUnknown'
    ) &&
    report.targets.every(
      (target) =>
        target.target !== 'unknown' &&
        ['verified', 'absent', 'unverifiedLegacy'].includes(target.original) &&
        ['original', 'installed', 'unverifiedMode'].includes(target.current)
    ) &&
    ['prepared', 'committed', 'recoveryNeeded', 'restoring', 'legacy'].includes(report.phase) &&
    (report.browser === 'closed' || report.browser === 'notApplicable')
  )
}
export function validateRecoveryRestoreRequest(raw: unknown): {
  evidenceId: string
  allowLegacy: boolean
} {
  const value = record(raw)
  if (
    !['evidenceId', 'allowLegacy,evidenceId'].includes(Object.keys(value).sort().join(',')) ||
    (Object.hasOwn(value, 'allowLegacy') && typeof value.allowLegacy !== 'boolean') ||
    typeof value.evidenceId !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(value.evidenceId)
  )
    throw new Error('请先完成所选记录的预检。')
  return { evidenceId: value.evidenceId, allowLegacy: value.allowLegacy === true }
}
export function validateRecoveryRestoreResult(raw: unknown): RelayRecoveryRestoreResult {
  const value = record(raw)
  return {
    status: choice(value.status, ['cancelled', 'restored', 'uncertain'] as const),
    warnings: warningsValue(value.warnings)
  }
}
export interface RelayCriticalCheck {
  id: string
  title: string
  state: RelayCheckState
  value: string
  evidence: string
  nextStep: string
}
export interface RelayReadOnlyReport {
  owned?: OwnedNativeDiagnostic
  snapshot: {
    checkedAt: string
    summary: string
    httpReady: boolean
    socksReady: boolean
    systemProxy: boolean
    cliConfigured: boolean
    browserIntegrated: boolean
    controllerConnected: boolean
    edgePolicyCount: number
    nodeNames: string[]
    proxyTypes: Record<string, string>
    details: string[]
  }
  checks: RelayCriticalCheck[]
  edgePolicies: { key: string; forced: boolean; matches: boolean; valid: boolean }[]
  edgePolicyReviewKeys: string[]
  timezone: string
  preferredLanguages: string[]
  readOnly: true
  guardEnabled: false
  warnings: string[]
}
export interface RelayObservation {
  evidenceId: string
  source: 'legacy-readonly' | 'relay-owned'
  parameters: RelayPreferences
  report: RelayReadOnlyReport
  owned?: OwnedDiagnosticObservation
}
export interface RelayGuardPlanOutput {
  plan: string
  warnings: string[]
}

export type RelayGenerateRequest =
  | { kind: 'configuration'; input: RelayPreviewInput }
  | { kind: 'simulation' | 'handoff' | 'edgeProfile' }
  | { kind: 'guardPlan'; node: string; evidenceId: string }

export interface RelayArtifact {
  id: string
  title: string
  filename: string
  content: string
}

export interface RelayGeneratedArtifacts {
  artifacts: RelayArtifact[]
  warnings: string[]
}

export interface RelayArtifactAction {
  id: string
  action: 'copy' | 'save'
}

export interface RelayArtifactResult {
  status: 'copied' | 'saved' | 'cancelled'
  warning?: string
  preferenceSnapshot?: RelayPreferenceSnapshot
}

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('输入格式无效。')
  return raw as Record<string, unknown>
}

export function validateGenerateRequest(raw: unknown): RelayGenerateRequest {
  const value = record(raw)
  const keys = Object.keys(value).sort().join(',')
  if (value.kind === 'configuration' && keys === 'input,kind')
    return { kind: value.kind, input: validatePreviewInput(value.input) }
  if (
    (value.kind === 'simulation' || value.kind === 'handoff' || value.kind === 'edgeProfile') &&
    keys === 'kind'
  )
    return { kind: value.kind }
  if (value.kind === 'guardPlan' && keys === 'evidenceId,kind,node') {
    const node = validatePreviewInput({
      httpPort: 7890,
      internalExceptions: '',
      existingJSON: '{}',
      node: value.node
    }).node
    if (typeof value.evidenceId !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.evidenceId))
      throw new Error('请先读取当前节点证据。')
    return { kind: value.kind, node, evidenceId: value.evidenceId }
  }
  throw new Error('不支持的生成操作。')
}

export function validatePreferences(raw: unknown): RelayPreferences {
  const value = record(raw)
  if (Object.keys(value).sort().join(',') !== 'httpPort,internalExceptions,node')
    throw new Error('检测参数无效。')
  const input = validatePreviewInput({ ...value, existingJSON: '{}' })
  return {
    httpPort: input.httpPort,
    node: input.node,
    internalExceptions: input.internalExceptions
  }
}

export function validateSavePreferencesRequest(raw: unknown): RelaySavePreferencesRequest {
  const value = record(raw)
  if (
    Object.keys(value).sort().join(',') !== 'preferences,revision' ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.revision)
  )
    throw new Error('请先读取当前偏好版本，再保存。')
  return { preferences: validatePreferences(value.preferences), revision: value.revision }
}

export function validatePreferenceSnapshot(raw: unknown): RelayPreferenceSnapshot {
  const value = record(raw)
  if (value.source !== 'relay' && value.source !== 'legacy' && value.source !== 'defaults')
    throw new Error('偏好来源格式异常。')
  const parsed = validateSavePreferencesRequest({
    preferences: value.preferences,
    revision: value.revision
  })
  return { ...parsed, source: value.source, warnings: warningsValue(value.warnings) }
}

export function validateArtifactAction(raw: unknown): RelayArtifactAction {
  const value = record(raw)
  if (
    Object.keys(value).sort().join(',') !== 'action,id' ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(value.id) ||
    (value.action !== 'copy' && value.action !== 'save')
  )
    throw new Error('导出请求无效。')
  return { id: value.id, action: value.action }
}

function stringValue(raw: unknown): string {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 1048576)
    throw new Error('原生结果格式或长度异常。')
  return raw
}

function warningsValue(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 16) throw new Error('原生警告格式异常。')
  return raw.map(stringValue)
}

function backupPhase(raw: unknown): RelayBackupPhase {
  if (
    raw === 'legacy' ||
    raw === 'prepared' ||
    raw === 'committed' ||
    raw === 'recoveryNeeded' ||
    raw === 'restoring' ||
    raw === 'rolledBack' ||
    raw === 'restored' ||
    raw === 'unreadable'
  )
    return raw
  throw new Error('恢复记录阶段无效。')
}

export function validateRecoveryStatus(raw: unknown): RelayRecoveryStatus {
  const value = record(raw)
  if (
    value.metadataOnly !== true ||
    value.restoreEnabled !== true ||
    !Array.isArray(value.inventories) ||
    value.inventories.length !== 2
  )
    throw new Error('恢复信息格式异常，不能启用恢复。')
  const inventories = value.inventories.map(
    (rawInventory): RelayRecoveryStatus['inventories'][number] => {
      const inventory = record(rawInventory)
      if (
        (inventory.source !== 'relay' && inventory.source !== 'legacy') ||
        (inventory.availability !== 'missing' &&
          inventory.availability !== 'readable' &&
          inventory.availability !== 'unreadable') ||
        !Array.isArray(inventory.entries) ||
        inventory.entries.length > 64
      )
        throw new Error('恢复信息来源或列表无效。')
      const complete = booleanValue(inventory.complete)
      const entries = inventory.entries.map(
        (rawEntry): RelayRecoveryStatus['inventories'][number]['entries'][number] => {
          const entry = record(rawEntry)
          const phase = backupPhase(entry.phase)
          if (
            ![0, 1, 2].includes(Number(entry.version)) ||
            !Number.isInteger(entry.version) ||
            !Number.isInteger(entry.targetCount) ||
            Number(entry.targetCount) < 0 ||
            Number(entry.targetCount) > 10000 ||
            (entry.version === 0) !== (phase === 'unreadable') ||
            (entry.version === 1) !== (phase === 'legacy')
          )
            throw new Error('恢复记录版本或数量无效。')
          return {
            id: stringValue(entry.id),
            createdAt: stringValue(entry.createdAt),
            version: Number(entry.version),
            phase,
            targetCount: Number(entry.targetCount)
          }
        }
      )
      if (
        new Set(entries.map((entry) => entry.id)).size !== entries.length ||
        (inventory.availability !== 'readable' && entries.length > 0) ||
        (complete &&
          (inventory.availability === 'unreadable' ||
            entries.some((entry) => entry.phase === 'unreadable')))
      )
        throw new Error('恢复信息完整性不一致。')
      return { source: inventory.source, availability: inventory.availability, complete, entries }
    }
  )
  if (new Set(inventories.map((inventory) => inventory.source)).size !== 2)
    throw new Error('恢复信息来源重复。')
  return {
    metadataOnly: true,
    restoreEnabled: true,
    inventories,
    warnings: warningsValue(value.warnings)
  }
}

export function validateRecoverySelection(raw: unknown): RelayRecoverySelection {
  const value = record(raw)
  if (
    Object.keys(value).sort().join(',') !== 'id,source' ||
    (value.source !== 'relay' && value.source !== 'legacy') ||
    typeof value.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,200}$/u.test(value.id)
  )
    throw new Error('恢复记录来源或编号无效。')
  return { source: value.source, id: value.id }
}

const recoveryIssues: readonly RelayRecoveryIssue[] = [
  'manifestInvalid',
  'targetOutsideScope',
  'originalInvalid',
  'targetChanged',
  'targetUnreadable',
  'targetModeUnknown',
  'legacyConfirmationRequired',
  'transactionFinished',
  'browserRunning',
  'browserProcessUnconfirmed'
]
function choice<T extends string>(raw: unknown, values: readonly T[]): T {
  if (typeof raw !== 'string' || !values.includes(raw as T)) throw new Error('恢复状态值无效。')
  return raw as T
}
export function validateRecoveryPreflight(raw: unknown): RelayRecoveryPreflight {
  const value = record(raw)
  const selection = validateRecoverySelection(value.selection)
  const phase = backupPhase(value.phase)
  const browser = choice(value.browser, [
    'notApplicable',
    'running',
    'unconfirmed',
    'closed'
  ] as const)
  if (
    value.snapshotOnly !== true ||
    value.restoreEnabled !== false ||
    !Number.isInteger(value.version) ||
    ![0, 1, 2].includes(Number(value.version)) ||
    (value.version === 0) !== (phase === 'unreadable') ||
    (value.version === 1) !== (phase === 'legacy') ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.revision) ||
    !Array.isArray(value.targets) ||
    value.targets.length > 4 ||
    !Array.isArray(value.issues) ||
    value.issues.length > recoveryIssues.length ||
    !value.issues.every((issue) => recoveryIssues.includes(issue)) ||
    new Set(value.issues).size !== value.issues.length
  )
    throw new Error('恢复预检格式异常，不能执行恢复。')
  const targets = value.targets.map(
    (rawTarget, index): RelayRecoveryPreflight['targets'][number] => {
      const target = record(rawTarget)
      const label = choice(target.target, [
        'claudeSettings',
        'assistantPreferences',
        'browserLocalState',
        'browserPreferences',
        'unknown'
      ] as const)
      const original = choice(target.original, [
        'verified',
        'absent',
        'unverifiedLegacy',
        'invalid',
        'unreadable',
        'unassessed'
      ] as const)
      const current = choice(target.current, [
        'original',
        'installed',
        'unverifiedMode',
        'changed',
        'unreadable',
        'unassessed'
      ] as const)
      if (
        target.index !== index ||
        (label === 'unknown' && (original !== 'unassessed' || current !== 'unassessed')) ||
        (value.version !== 1 && original === 'unverifiedLegacy')
      )
        throw new Error('恢复目标状态异常。')
      return { index, target: label, original, current }
    }
  )
  const issues = value.issues as RelayRecoveryIssue[]
  const fileChecksPassed = booleanValue(value.fileChecksPassed)
  const requiresLegacyConfirmation = booleanValue(value.requiresLegacyConfirmation)
  const known = targets
    .filter((target) => target.target !== 'unknown')
    .map((target) => target.target)
  const hasBrowser = targets.some((target) => target.target.startsWith('browser'))
  if (
    new Set(known).size !== known.length ||
    requiresLegacyConfirmation !== (value.version === 1) ||
    requiresLegacyConfirmation !== issues.includes('legacyConfirmationRequired') ||
    hasBrowser !== (browser !== 'notApplicable') ||
    (browser === 'running') !== issues.includes('browserRunning') ||
    (browser === 'unconfirmed') !== issues.includes('browserProcessUnconfirmed') ||
    ['rolledBack', 'restored'].includes(phase) !== issues.includes('transactionFinished') ||
    (value.version === 0 && (!issues.includes('manifestInvalid') || targets.length > 0)) ||
    (value.version !== 0 && targets.length === 0) ||
    fileChecksPassed !==
      !issues.some((issue) =>
        [
          'manifestInvalid',
          'targetOutsideScope',
          'originalInvalid',
          'targetChanged',
          'targetUnreadable',
          'targetModeUnknown'
        ].includes(issue)
      ) ||
    (fileChecksPassed &&
      targets.some(
        (target) =>
          !['verified', 'absent', 'unverifiedLegacy'].includes(target.original) ||
          !['original', 'installed'].includes(target.current)
      ))
  )
    throw new Error('恢复预检结论与证据不一致。')
  return {
    selection,
    version: Number(value.version),
    phase,
    revision: value.revision,
    targets,
    issues,
    requiresLegacyConfirmation,
    browser,
    fileChecksPassed,
    snapshotOnly: true,
    restoreEnabled: false,
    warnings: warningsValue(value.warnings)
  }
}

export function validateEdgeProfileOutput(raw: unknown): RelayEdgeProfileOutput {
  const value = record(raw)
  const profileXML = stringValue(value.profileXML)
  if (value.installed !== false || !profileXML.startsWith('<?xml'))
    throw new Error('描述文件生成结果异常。')
  return { profileXML, installed: false, warnings: warningsValue(value.warnings) }
}

export function validateGuardPlanOutput(raw: unknown): RelayGuardPlanOutput {
  const value = record(raw)
  return { plan: stringValue(value.plan), warnings: warningsValue(value.warnings) }
}

function booleanValue(raw: unknown): boolean {
  if (typeof raw !== 'boolean') throw new Error('只读检测返回格式异常。')
  return raw
}

function stringsValue(raw: unknown, limit = 4096): string[] {
  if (!Array.isArray(raw) || raw.length > limit) throw new Error('只读检测列表格式异常。')
  return raw.map(stringValue)
}

export function validateReadOnlyReport(raw: unknown): RelayReadOnlyReport {
  const value = record(raw)
  if (value.readOnly !== true || value.guardEnabled !== false)
    throw new Error('只读检测结果不能声明保护已启用。')
  const snapshot = record(value.snapshot)
  const types = record(snapshot.proxyTypes)
  if (Object.keys(types).length > 10000) throw new Error('节点信息过长。')
  const proxyTypes = Object.fromEntries(
    Object.entries(types).map(([key, type]) => [stringValue(key), stringValue(type)])
  )
  const ids = [
    'ports',
    'clients',
    'routing',
    'dns-policy',
    'browser-config',
    'egress',
    'dns-exit',
    'webrtc',
    'callback',
    'request',
    'guard'
  ]
  const runtime = new Set(ids.slice(5))
  if (!Array.isArray(value.checks) || value.checks.length !== ids.length)
    throw new Error('关键检测项不完整。')
  const checks = value.checks.map((rawCheck): RelayCriticalCheck => {
    const check = record(rawCheck)
    const id = stringValue(check.id)
    if (
      !ids.includes(id) ||
      (check.state !== 'verifiedConfiguration' &&
        check.state !== 'attention' &&
        check.state !== 'pending') ||
      (runtime.has(id) && check.state !== 'pending')
    )
      throw new Error('关键检测状态无效，配置证据不能代替运行时证据。')
    return {
      id,
      title: stringValue(check.title),
      state: check.state,
      value: stringValue(check.value),
      evidence: stringValue(check.evidence),
      nextStep: stringValue(check.nextStep)
    }
  })
  if (new Set(checks.map((check) => check.id)).size !== ids.length)
    throw new Error('关键检测项重复。')
  const policyKeys = [
    'DnsOverHttpsMode',
    'NetworkPredictionOptions',
    'ProxySettings',
    'WebRtcLocalhostIpHandling'
  ]
  if (!Array.isArray(value.edgePolicies) || value.edgePolicies.length !== 4)
    throw new Error('Edge策略检测不完整。')
  const edgePolicies = value.edgePolicies.map((rawPolicy) => {
    const policy = record(rawPolicy)
    const key = stringValue(policy.key)
    const forced = booleanValue(policy.forced),
      matches = booleanValue(policy.matches)
    if (!policyKeys.includes(key) || policy.valid !== (forced && matches))
      throw new Error('Edge策略状态不一致。')
    return { key, forced, matches, valid: forced && matches }
  })
  const edgePolicyReviewKeys = validateEdgeReviewKeys(value.edgePolicyReviewKeys)
  if (
    edgePolicyReviewKeys.length &&
    checks.some((check) => check.id === 'browser-config' && check.state === 'verifiedConfiguration')
  )
    throw new Error('存在附加策略时不能将浏览器配置标为通过。')
  if (
    new Set(edgePolicies.map((policy) => policy.key)).size !== 4 ||
    snapshot.edgePolicyCount !== edgePolicies.filter((policy) => policy.valid).length
  )
    throw new Error('Edge策略统计不一致。')
  return {
    snapshot: {
      checkedAt: stringValue(snapshot.checkedAt),
      summary: stringValue(snapshot.summary),
      httpReady: booleanValue(snapshot.httpReady),
      socksReady: booleanValue(snapshot.socksReady),
      systemProxy: booleanValue(snapshot.systemProxy),
      cliConfigured: booleanValue(snapshot.cliConfigured),
      browserIntegrated: booleanValue(snapshot.browserIntegrated),
      controllerConnected: booleanValue(snapshot.controllerConnected),
      edgePolicyCount: edgePolicies.filter((policy) => policy.valid).length,
      nodeNames: stringsValue(snapshot.nodeNames),
      proxyTypes,
      details: stringsValue(snapshot.details, 64)
    },
    checks,
    edgePolicies,
    edgePolicyReviewKeys,
    timezone: stringValue(value.timezone),
    preferredLanguages: stringsValue(value.preferredLanguages, 64),
    readOnly: true,
    guardEnabled: false,
    warnings: warningsValue(value.warnings)
  }
}

export function validatePreviewOutput(raw: unknown): RelayPreviewOutput {
  const value = record(raw)
  return {
    settingsJSON: stringValue(value.settingsJSON),
    noProxy: stringValue(value.noProxy),
    plan: stringValue(value.plan),
    rules: stringValue(value.rules),
    dns: stringValue(value.dns),
    listeners: stringValue(value.listeners),
    warnings: warningsValue(value.warnings)
  }
}

export function validateSimulationOutput(raw: unknown): RelaySimulationOutput {
  const value = record(raw)
  if (value.protected !== false || !Array.isArray(value.rows) || value.rows.length !== 10)
    throw new Error('离线模拟返回格式异常。')
  const rows = value.rows.map((rawRow): RelaySimulationOutput['rows'][number] => {
    const row = record(rawRow)
    if (
      (row.expected !== 'allow' && row.expected !== 'drop') ||
      (row.actual !== 'allow' && row.actual !== 'drop') ||
      row.passed !== (row.expected === row.actual)
    )
      throw new Error('离线模拟结果不一致。')
    return {
      name: stringValue(row.name),
      expected: row.expected,
      actual: row.actual,
      passed: row.expected === row.actual
    }
  })
  return { rows, protected: false, warnings: warningsValue(value.warnings) }
}

export interface RelayStatus {
  name: 'Relay'
  version: string
  upstream: string
  mode: 'preview'
  coreRunning: boolean | null
  normalBackendReady: false
  networkChangesAllowed: false
  nativeReady: boolean
  guardEnabled: false
  systemProxyStatus?: import('./system-proxy').SystemProxyReport['status'] | 'unobserved'
}

export function validatePreviewInput(raw: unknown): RelayPreviewInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('输入格式无效。')
  const input = raw as Record<string, unknown>
  if (
    !Number.isInteger(input.httpPort) ||
    Number(input.httpPort) < 1 ||
    Number(input.httpPort) > 65535 ||
    input.httpPort === 17890
  ) {
    throw new Error('HTTP 端口需为1–65535，且不能是17890。')
  }
  for (const key of ['node', 'internalExceptions', 'existingJSON']) {
    if (typeof input[key] !== 'string' || input[key].length > 131072)
      throw new Error('输入类型或长度无效。')
  }
  const node = String(input.node).trim()
  if (
    !node ||
    /[\r\n,]/u.test(node) ||
    ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL', 'COMPATIBLE'].includes(node.toUpperCase())
  ) {
    throw new Error('请填写具体代理节点名称。')
  }
  return {
    httpPort: Number(input.httpPort),
    node,
    internalExceptions: String(input.internalExceptions),
    existingJSON: String(input.existingJSON)
  }
}
