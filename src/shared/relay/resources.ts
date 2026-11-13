import { stripProfileControls } from './profiles'
import type { RelayProfileSelection } from './runtime'

export const RULE_RESOURCE_PREVIEW_TEXT_LIMIT = 512 * 1024
export const RULE_RESOURCE_PREVIEW_INPUT_LIMIT = 2 * 1024 * 1024
export interface RuleResourcePreview {
  resource: RelayProfileSelection
  kind: 'rule-yaml' | 'rule-text' | 'rule-mrs'
  text: string
  language: 'yaml' | 'text'
  sourceBytes: number
  converted: boolean
  sourceRules?: number
}
export const resourceKinds = [
  'rule-yaml',
  'rule-text',
  'rule-mrs',
  'geoip-dat',
  'geosite-dat',
  'country-mmdb',
  'asn-mmdb',
  'runtime-file'
] as const
export type ResourceKind = (typeof resourceKinds)[number]
export interface ResourceDescriptor {
  name: string
  kind: ResourceKind
  behavior: 'domain' | 'ipcidr' | 'classical' | null
  selector: string
}
export interface ResourceInfo extends ResourceDescriptor {
  id: string
  sha256: string
  size: number
  createdAt: string
  integrity: 'notChecked'
}
export interface ResourceInventory {
  resources: ResourceInfo[]
  incomplete: number
  warnings: string[]
}
export interface ResourcePreparation {
  evidenceId: string
  descriptor: ResourceDescriptor
  source: { kind: 'file' | 'http' | 'inline'; origin?: string; proxyPort?: number }
  expectedSHA256: string
}
export interface ResourceState {
  phase: 'idle' | 'reading' | 'confirming' | 'acquiring' | 'saving' | 'checking'
  pending: boolean
  operationId?: string
  preparedId?: string
}
export interface ResourceCheckResult {
  status: 'passed' | 'notVerified' | 'uncertain' | 'requiresResources'
  resourceSHA256: string
  coreVersion?: string
  ruleCount?: number
  warnings: string[]
}
export interface ResourceOperationResult {
  status: 'cached' | 'checked' | 'cancelled' | 'failed' | 'uncertain'
  resource?: ResourceInfo
  check?: ResourceCheckResult
  warnings: string[]
}
export function resourceDescriptor(raw: unknown): ResourceDescriptor {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'behavior,kind,name,selector'
  )
    throw new Error('资源参数只接受名称、类型、规则行为和校验条目。')
  const v = raw as Record<string, unknown>
  if (
    typeof v.name !== 'string' ||
    !v.name.trim() ||
    v.name.length > 120 ||
    stripProfileControls(v.name) !== v.name ||
    !resourceKinds.includes(v.kind as ResourceKind) ||
    typeof v.selector !== 'string' ||
    v.selector.length > 256 ||
    stripProfileControls(v.selector) !== v.selector
  )
    throw new Error('资源名称、类型或条目无效。')
  const kind = v.kind as ResourceKind,
    rule = kind.startsWith('rule-'),
    opaque = kind === 'runtime-file'
  if (rule ? !['domain', 'ipcidr', 'classical'].includes(String(v.behavior)) : v.behavior !== null)
    throw new Error('规则资源必须选择行为，地理资源不得指定规则行为。')
  if (kind === 'rule-mrs' && v.behavior === 'classical') throw new Error('MRS不支持classical行为。')
  if (
    ((rule || opaque) && v.selector !== '') ||
    (!rule &&
      !opaque &&
      (!v.selector.trim() || v.selector !== v.selector.trim() || v.selector.includes(',')))
  )
    throw new Error('规则资源不接受条目；地理资源需要明确校验条目。')
  return {
    name: v.name,
    kind,
    behavior: rule ? (v.behavior as 'domain' | 'ipcidr' | 'classical') : null,
    selector: v.selector
  }
}
