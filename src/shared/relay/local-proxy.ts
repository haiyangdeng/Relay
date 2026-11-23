import { profileSelection, type RelayProfileSelection } from './runtime'
import { stripProfileControls, type RelayStoredProfile } from './profiles'
import { validateCoreMode, type RelayCoreMode } from './core'
import { healthURL } from './health'
import {
  localProxyPortsFor,
  validateDedicatedPortConflicts,
  type LocalProxyPorts
} from './local-proxy-ports'
import {
  dedicatedListeners,
  type DedicatedListenerPlan,
  type DedicatedListenerSummary
} from './dedicated-listeners'

export type LocalResolverMode = 'off' | 'profile'
export type LocalProxyLifetime = 'main' | 'persistent'
export const localCoreLogLevels = ['silent', 'error', 'warning', 'info', 'debug'] as const
export type LocalCoreLogLevel = (typeof localCoreLogLevels)[number]
export function localCoreLogLevel(value: unknown): LocalCoreLogLevel {
  const level = localCoreLogLevels.find((candidate) => candidate === value)
  if (!level) throw new Error('本次核心日志级别无效。')
  return level
}
export function localProxyLifetime(value: unknown): LocalProxyLifetime {
  if (value === undefined || value === 'main') return 'main'
  if (value === 'persistent') return 'persistent'
  throw new Error('本次核心生命周期无效。')
}
export interface LocalResolutionSummary {
  mode: LocalResolverMode
  enabled: boolean
  hosts: number
  policies: number
  bootstrapDerived: boolean
  listenerSuppressed: boolean
}
export function localResolverMode(value: unknown): LocalResolverMode {
  if (value === undefined || value === 'off') return 'off'
  if (value === 'profile') return 'profile'
  throw new Error('本次DNS模式无效。')
}

export interface RelayProxyPageOwner {
  kind: 'ordinary' | 'tun-managed'
  instanceId: string
  configurationRevision: string
  profileId: string
  mode: RelayCoreMode
}

export interface LocalProxyGroup {
  name: string
  members: string[]
  type?: 'select' | 'url-test' | 'fallback' | 'load-balance' | 'smart'
  dynamic?: boolean
  providers?: string[]
  selectable?: boolean
  testURL?: string
  expectedStatus?: string
  fixed?: string
  emptyFallback?: string
  health?: { name: string; alive?: boolean; delay?: number; at?: string }[]
  now?: string
  confirmed: boolean
}
export interface LocalProxyState {
  phase: 'unknown' | 'idle' | 'blocked' | 'starting' | 'running' | 'stopping' | 'failed'
  pending: boolean
  owned: boolean
  hasRecord: boolean
  uncertain: boolean
  instanceId?: string
  httpPort?: number
  ports?: LocalProxyPorts
  mode?: RelayCoreMode
  profileName?: string
  profileId?: string
  configurationRevision?: string
  resolution?: LocalResolutionSummary
  lifetime?: LocalProxyLifetime
  logLevel?: LocalCoreLogLevel
  traffic: 'inactive' | 'listening' | 'unconfirmed'
  groups: LocalProxyGroup[]
  systemProxyChanged: false
  liveGuardEnabled: false
  warnings: string[]
  pid?: number
  dedicated?: DedicatedListenerSummary
}
export function relayProxyCanPrepare(
  state?: Pick<
    LocalProxyState,
    'owned' | 'pending' | 'uncertain' | 'hasRecord' | 'traffic' | 'phase'
  >
): boolean {
  // A blocked observation is also produced by a temporary port conflict.
  // Explicit preparation always rechecks the current lease and every listener.
  return !!(
    state &&
    state.owned === false &&
    state.pending === false &&
    state.uncertain === false &&
    state.hasRecord === false &&
    state.traffic === 'inactive' &&
    ['unknown', 'idle', 'blocked', 'failed'].includes(state.phase)
  )
}

export interface LocalProxyPreparation {
  evidenceId: string
  profile: RelayStoredProfile
  httpPort: number
  ports?: LocalProxyPorts
  runtimeSHA256: string
  version: string
  lifetime?: LocalProxyLifetime
  resolverMode?: LocalResolverMode
  logLevel?: LocalCoreLogLevel
  resolution?: LocalResolutionSummary
  canStart: boolean
  hasRecord: boolean
  warnings: string[]
  dedicated?: DedicatedListenerSummary
}
export interface LocalReloadPreparation {
  evidenceId: string
  instanceId: string
  profile: RelayStoredProfile
  httpPort: number
  ports?: LocalProxyPorts
  previousSHA256: string
  runtimeSHA256: string
  scope: 'controlled-local-projection'
  warnings: string[]
}
export interface LocalProxyRule {
  index: number
  type: string
  payload: string
  proxy: string
  size?: number
  // Missing wrapper metadata is readable, but cannot authorize a toggle.
  disabled?: boolean
  statistics?: {
    hitCount: number
    missCount: number
    hitAt?: string
    missAt?: string
  }
}
export interface LocalProxyRulesSnapshot {
  instanceId: string
  configurationRevision: string
  rulesSHA256: string
  rules: LocalProxyRule[]
}
export interface LocalProxyRuleConfirmation {
  instanceId: string
  configurationRevision: string
  rulesSHA256: string
  rule: LocalProxyRule & { disabled: boolean }
  disabled: boolean
}
export interface LocalProxyResult {
  delay?: number
  rules?: LocalProxyRulesSnapshot
  status:
    | 'started'
    | 'stopped'
    | 'cancelled'
    | 'selected'
    | 'refreshed'
    | 'tested'
    | 'automatic'
    | 'modeChanged'
    | 'ruleChanged'
    | 'reloaded'
    | 'unconfirmed'
    | 'failed'
    | 'uncertain'
  state: LocalProxyState
}
export function localProxyPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65535)
    throw new Error('HTTP端口必须是1024到65535的整数。')
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('本地代理消息格式无效。')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value))
    throw new Error('本次实例或准备凭据无效。')
  return value
}
export function localProxyPrepare(value: unknown): {
  profile: RelayProfileSelection
  httpPort: number
  resolverMode: LocalResolverMode
  lifetime: LocalProxyLifetime
  logLevel?: LocalCoreLogLevel
  dedicated: DedicatedListenerPlan | undefined
  ports?: LocalProxyPorts
} {
  const input = object(value)
  const keys = Object.keys(input)
    .filter((key) => key !== 'lifetime' && key !== 'logLevel' && key !== 'ports')
    .sort()
    .join(',')
  if (
    ![
      'httpPort,profile',
      'httpPort,profile,resolverMode',
      'dedicated,httpPort,profile',
      'dedicated,httpPort,profile,resolverMode'
    ].includes(keys)
  )
    throw new Error('只接受已保存配置选择与本地HTTP端口。')
  const httpPort = localProxyPort(input.httpPort),
    ports = localProxyPortsFor(httpPort, input.ports),
    dedicated = input.dedicated === undefined ? undefined : dedicatedListeners(input.dedicated)
  validateDedicatedPortConflicts(ports, dedicated)
  return {
    profile: profileSelection(input.profile),
    httpPort,
    ...(input.ports === undefined ? {} : { ports }),
    resolverMode: localResolverMode(input.resolverMode),
    lifetime: localProxyLifetime(input.lifetime),
    ...(input.logLevel !== undefined ? { logLevel: localCoreLogLevel(input.logLevel) } : {}),
    dedicated
  }
}
export function localProxyAction(value: unknown):
  | { action: 'start'; evidenceId: string }
  | { action: 'stop'; instanceId: string }
  | { action: 'refresh'; instanceId: string }
  | { action: 'delay'; instanceId: string; group: string; member: string }
  | { action: 'automatic'; instanceId: string; group: string }
  | { action: 'mode'; instanceId: string; mode: RelayCoreMode }
  | { action: 'rules'; instanceId: string }
  | {
      action: 'rule'
      instanceId: string
      configurationRevision: string
      rulesSHA256: string
      index: number
      disabled: boolean
    }
  | { action: 'probe'; instanceId: string; member: string; url: string; provider?: string }
  | { action: 'select'; instanceId: string; group: string; member: string } {
  const input = object(value),
    keys = Object.keys(input).sort().join(',')
  if (input.action === 'start' && keys === 'action,evidenceId')
    return { action: 'start', evidenceId: id(input.evidenceId) }
  if (input.action === 'stop' && keys === 'action,instanceId')
    return { action: 'stop', instanceId: id(input.instanceId) }
  if (input.action === 'refresh' && keys === 'action,instanceId')
    return { action: 'refresh', instanceId: id(input.instanceId) }
  if (input.action === 'rules' && keys === 'action,instanceId')
    return { action: 'rules', instanceId: id(input.instanceId) }
  if (
    input.action === 'rule' &&
    keys === 'action,configurationRevision,disabled,index,instanceId,rulesSHA256' &&
    typeof input.configurationRevision === 'string' &&
    /^[a-f0-9]{64}$/u.test(input.configurationRevision) &&
    typeof input.rulesSHA256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(input.rulesSHA256) &&
    typeof input.index === 'number' &&
    Number.isSafeInteger(input.index) &&
    input.index >= 0 &&
    input.index < 10000 &&
    typeof input.disabled === 'boolean'
  )
    return {
      action: 'rule',
      instanceId: id(input.instanceId),
      configurationRevision: input.configurationRevision,
      rulesSHA256: input.rulesSHA256,
      index: input.index,
      disabled: input.disabled
    }
  if (input.action === 'mode' && keys === 'action,instanceId,mode')
    return { action: 'mode', instanceId: id(input.instanceId), mode: validateCoreMode(input.mode) }
  if (
    input.action === 'probe' &&
    ['action,instanceId,member,url', 'action,instanceId,member,provider,url'].includes(keys) &&
    typeof input.member === 'string' &&
    !!input.member.trim() &&
    input.member.length <= 256 &&
    stripProfileControls(input.member) === input.member &&
    (input.provider === undefined ||
      (typeof input.provider === 'string' &&
        !!input.provider.trim() &&
        input.provider.length <= 256 &&
        stripProfileControls(input.provider) === input.provider))
  )
    return {
      action: 'probe',
      instanceId: id(input.instanceId),
      member: input.member,
      url: healthURL(input.url),
      provider: input.provider
    }
  if (
    ['select', 'delay'].includes(String(input.action)) &&
    keys === 'action,group,instanceId,member' &&
    typeof input.group === 'string' &&
    typeof input.member === 'string' &&
    [input.group, input.member].every(
      (name) => !!name.trim() && name.length <= 256 && stripProfileControls(name) === name
    )
  )
    return {
      action: input.action as 'select' | 'delay',
      instanceId: id(input.instanceId),
      group: input.group,
      member: input.member
    }
  if (
    input.action === 'automatic' &&
    keys === 'action,group,instanceId' &&
    typeof input.group === 'string' &&
    !!input.group.trim() &&
    input.group.length <= 256 &&
    stripProfileControls(input.group) === input.group
  )
    return { action: 'automatic', instanceId: id(input.instanceId), group: input.group }
  throw new Error('本地代理操作不接受任意路径、配置、控制器地址或其他参数。')
}
