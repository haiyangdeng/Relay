import { profileSelection, type RelayProfileSelection } from './runtime'
import type { ResourceDescriptor, ResourceKind } from './resources'

export type TunRuleProviderKind = Extract<ResourceKind, `rule-${string}`>
export interface TunRuleProvidersReadRequest {
  sessionId: string
}
export interface TunRuleProviderReplaceRequest extends TunRuleProvidersReadRequest {
  configurationRevision: string
  expectedGenerationSHA256: string
  provider: string
  resource: RelayProfileSelection
}
export interface TunRuleProviderEntry {
  name: string
  kind: TunRuleProviderKind
  behavior: Exclude<ResourceDescriptor['behavior'], null>
  // Confirmed local runtime-file bytes. The stock Core exposes no independently
  // readable digest of its in-memory provider strategy; never label this as one.
  fileSHA256: string
  bytes: number
  ruleCount: number
}
export interface TunRuleProvidersSnapshot {
  sessionId: string
  configurationRevision: string
  generationSHA256: string
  providers: TunRuleProviderEntry[]
  // Each logical name occurs once. Group metadata avoids repeating up to 200
  // aliases on every row; publishing one file can affect the entire group.
  groups: string[][]
}
export type TunRuleProvidersResult =
  | {
      status: 'snapshot' | 'updated' | 'unchanged'
      sessionId: string
      snapshot: TunRuleProvidersSnapshot
    }
  | {
      status:
        'busy' | 'cancelled' | 'uncertain' | 'stale' | 'expired' | 'unsupported' | 'unavailable'
      sessionId: string
    }

function input(raw: unknown, fields: string): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== fields
  )
    throw new Error('规则提供者操作只接受当前会话、代际、名称和私有缓存选择。')
  return raw as Record<string, unknown>
}
export function tunRuleProviderName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('规则提供者名称无效。')
  const bytes = new TextEncoder().encode(raw)
  if (
    !raw ||
    raw !== raw.trim() ||
    bytes.byteLength > 256 ||
    new TextDecoder().decode(bytes) !== raw ||
    Array.from(raw).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || character === ','
    })
  )
    throw new Error('规则提供者名称无效。')
  return raw
}
export function tunRuleProvidersReadRequest(raw: unknown): TunRuleProvidersReadRequest {
  const value = input(raw, 'sessionId')
  return { sessionId: profileSelection({ id: value.sessionId, sha256: '0'.repeat(64) }).id }
}
export function tunRuleProviderReplaceRequest(raw: unknown): TunRuleProviderReplaceRequest {
  const value = input(
      raw,
      'configurationRevision,expectedGenerationSHA256,provider,resource,sessionId'
    ),
    selected = profileSelection({ id: value.sessionId, sha256: value.configurationRevision }),
    generation = profileSelection({ id: selected.id, sha256: value.expectedGenerationSHA256 })
  return {
    sessionId: selected.id,
    configurationRevision: selected.sha256,
    expectedGenerationSHA256: generation.sha256,
    provider: tunRuleProviderName(value.provider),
    resource: profileSelection(value.resource)
  }
}
