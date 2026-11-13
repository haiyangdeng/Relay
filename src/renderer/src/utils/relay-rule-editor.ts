import { ruleParts } from '../../../shared/simple-rules'
import {
  configurationEditDocument,
  type ConfigurationEditDocument
} from '../../../shared/relay/configuration-edit'
import type { RuntimeRulePatch } from '../../../main/relay/configuration/merge'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'
import type {
  RelayProfilePreparation,
  RelayProfileSaveResult
} from '../../../shared/relay/profiles'

export async function saveRuleCopy(
  invoke: (channel: string, request: unknown) => Promise<unknown>,
  profile: RelayProfileSelection,
  rules: readonly string[],
  check: () => void
): Promise<RelayProfileSaveResult> {
  check()
  const candidate = (await invoke('relayProfileRulesPrepare', {
    profile: { ...profile },
    rules: [...rules]
  })) as RelayProfilePreparation
  check()
  // Native still owns confirmation, expiry and the exact prepared content.
  const result = (await invoke('relayProfileSave', {
    evidenceId: candidate.evidenceId
  })) as RelayProfileSaveResult
  check()
  return result
}

export type RuleOwner = LocalProxyState
export function adoptRuleState(
  current: LocalProxyState | undefined,
  next: LocalProxyState,
  expected: RuleOwner
): LocalProxyState | undefined {
  return current === expected &&
    current?.owned &&
    current.phase === 'running' &&
    !current.uncertain &&
    !!current.instanceId &&
    !!current.configurationRevision
    ? next
    : current
}

export interface RelayRuleRow {
  key: string
  value: string
}
let serial = 0
export function ruleRows(values: readonly string[]): RelayRuleRow[] {
  return values.map((value) => ({ key: 'relay-rule-' + ++serial, value }))
}
export function patchRule(value: string): { position: string; rule: string } {
  const parts = ruleParts(value)
  if (parts.length >= 3 && parts[0] && Number.isFinite(Number(parts[0]))) {
    const comma = value.indexOf(',')
    return { position: value.slice(0, comma), rule: value.slice(comma + 1) }
  }
  return { position: '', rule: value }
}
export function positionedRule(rule: string, position: string, original?: string): string {
  const before = original === undefined ? undefined : patchRule(original)
  if (before && before.rule === rule && before.position === position) return original ?? rule
  if (position === before?.position) return position ? position + ',' + rule : rule
  if (position !== '' && !/^(0|[1-9]\d*)$/u.test(position))
    throw new Error('新插入位置必须为非负整数或留空。')
  if (position !== '' && !Number.isSafeInteger(Number(position))) throw new Error('插入位置过大。')
  return position ? position + ',' + rule : rule
}
export function rulePatchDocument(
  base: ConfigurationEditDocument,
  profileId: string | undefined,
  patch: RuntimeRulePatch
): ConfigurationEditDocument {
  const next = structuredClone(base)
  if (profileId === undefined) next.rulePatch = structuredClone(patch)
  else {
    const sets = [...(next.profileRulePatchSets ?? [])],
      index = sets.findIndex((set) => set.profileId === profileId)
    const entry = { profileId, rulePatch: structuredClone(patch) }
    if (index < 0) sets.push(entry)
    else sets[index] = entry
    next.profileRulePatchSets = sets
  }
  return configurationEditDocument(next)
}
