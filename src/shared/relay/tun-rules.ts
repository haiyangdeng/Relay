import { localProxyAction, type LocalProxyRule } from './local-proxy'

export interface TunRulesReadRequest {
  sessionId: string
}
export interface TunRuleChangeRequest extends TunRulesReadRequest {
  configurationRevision: string
  rulesSHA256: string
  index: number
  disabled: boolean
}
export interface TunRuntimeRulesSnapshot {
  sessionId: string
  configurationRevision: string
  rulesSHA256: string
  rules: LocalProxyRule[]
}
export interface TunRuntimeRuleConfirmation extends TunRulesReadRequest {
  configurationRevision: string
  rulesSHA256: string
  rule: LocalProxyRule & { disabled: boolean }
  disabled: boolean
}
export type TunRuntimeRulesResult =
  | {
      status: 'snapshot' | 'changed' | 'unchanged'
      sessionId: string
      snapshot: TunRuntimeRulesSnapshot
    }
  | {
      status:
        'busy' | 'cancelled' | 'uncertain' | 'stale' | 'expired' | 'unsupported' | 'unavailable'
      sessionId: string
    }

function input(value: unknown, expected: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== expected
  )
    throw new Error('TUN规则操作只接受会话和已读取规则的精确选择。')
  return value as Record<string, unknown>
}

// The two owned-core surfaces share scalar limits, not authority or transport.
// Reuse the existing strict selection decoder; no PID, path, nonce or arbitrary
// request can enter either public TUN operation.
export function tunRulesReadRequest(value: unknown): TunRulesReadRequest {
  const raw = input(value, 'sessionId'),
    selected = localProxyAction({ action: 'rules', instanceId: raw.sessionId })
  if (selected.action !== 'rules') throw new Error('TUN规则会话选择无效。')
  return { sessionId: selected.instanceId }
}

export function tunRuleChangeRequest(value: unknown): TunRuleChangeRequest {
  const raw = input(value, 'configurationRevision,disabled,index,rulesSHA256,sessionId'),
    selected = localProxyAction({
      action: 'rule',
      instanceId: raw.sessionId,
      configurationRevision: raw.configurationRevision,
      rulesSHA256: raw.rulesSHA256,
      index: raw.index,
      disabled: raw.disabled
    })
  if (selected.action !== 'rule') throw new Error('TUN规则精确选择无效。')
  return {
    sessionId: selected.instanceId,
    configurationRevision: selected.configurationRevision,
    rulesSHA256: selected.rulesSHA256,
    index: selected.index,
    disabled: selected.disabled
  }
}
