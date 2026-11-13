import { stripProfileControls } from './profiles'

export const SMART_TOOLS_CAPABILITY = 'runtime-smart-tools-v1' as const
export const SMART_TOOLS_FRAME_BYTES = 262144
export const SMART_TOOLS_PAYLOAD_BYTES = 245760
export const SMART_TOOLS_MAX_GROUPS = 200
export const SMART_TOOLS_MAX_ROWS = 2000
export const SMART_TOOLS_VERSION = 'alpha-smart-4624551'
export type SmartRank = '' | 'MostUsed' | 'OccasionalUsed' | 'RarelyUsed'
export interface SmartNodeRank {
  Name: string
  Rank: SmartRank
  Weight: number
}
export interface SmartWeightsGroup {
  name: string
  status: 'ready' | 'unavailable'
  weights: readonly SmartNodeRank[]
}
export interface SmartWeightsSnapshot {
  version: 1
  kind: 'weights'
  configurationRevision: string
  groups: readonly SmartWeightsGroup[]
}
export interface SmartCacheAcceptance {
  version: 1
  kind: 'clear-cache'
  configurationRevision: string
  accepted: true
}
export type SmartToolsSnapshot = SmartWeightsSnapshot | SmartCacheAcceptance
export interface SmartToolsDefinition {
  configurationRevision: string
  groups: readonly string[]
}
export type SmartToolsTarget = 'ordinary' | 'tun'
export type SmartToolsRequest =
  | { action: 'inspect'; target: SmartToolsTarget }
  | {
      action: 'weights'
      target: SmartToolsTarget
      instanceId: string
      configurationRevision: string
      group: string
    }
  | {
      action: 'clear-cache'
      target: SmartToolsTarget
      instanceId: string
      configurationRevision: string
    }
export interface SmartToolsInspection extends SmartToolsDefinition {
  target: SmartToolsTarget
  instanceId: string
  available: boolean
}
export type SmartToolsReply =
  | { status: 'ready'; inspection: SmartToolsInspection }
  | { status: 'weights'; weights: readonly SmartNodeRank[] }
  | { status: 'accepted' | 'cancelled' | 'uncertain' | 'unavailable' | 'unsupported' | 'busy' }

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  Object.keys(value).sort().join(',') === [...fields].sort().join(',')
export const smartToolsDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
export const smartToolsName = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= 256 &&
  stripProfileControls(value) === value
const invalid = (): Error => new Error('Smart工具结果与本次固定核心或配置不匹配。')
export function smartToolsDefinition(value: unknown): SmartToolsDefinition {
  if (
    !object(value) ||
    !keys(value, ['configurationRevision', 'groups']) ||
    !smartToolsDigest(value.configurationRevision) ||
    !Array.isArray(value.groups) ||
    !value.groups.length ||
    value.groups.length > SMART_TOOLS_MAX_GROUPS ||
    value.groups.some((name) => !smartToolsName(name)) ||
    new Set(value.groups).size !== value.groups.length
  )
    throw invalid()
  return {
    configurationRevision: value.configurationRevision,
    groups: [...value.groups] as string[]
  }
}
export function smartNodeRanks(value: unknown): readonly SmartNodeRank[] {
  if (!Array.isArray(value) || value.length > SMART_TOOLS_MAX_ROWS) throw invalid()
  const names = new Set<string>()
  return value.map((raw): SmartNodeRank => {
    if (
      !object(raw) ||
      !keys(raw, ['Name', 'Rank', 'Weight']) ||
      !smartToolsName(raw.Name) ||
      names.has(raw.Name) ||
      typeof raw.Rank !== 'string' ||
      !['', 'MostUsed', 'OccasionalUsed', 'RarelyUsed'].includes(raw.Rank) ||
      typeof raw.Weight !== 'number' ||
      !Number.isFinite(raw.Weight) ||
      raw.Weight < 0 ||
      raw.Weight > 100
    )
      throw invalid()
    names.add(raw.Name)
    return { Name: raw.Name, Rank: raw.Rank as SmartRank, Weight: raw.Weight }
  })
}
export function smartWeightsSnapshot(
  raw: unknown,
  input: SmartToolsDefinition
): SmartWeightsSnapshot {
  const definition = smartToolsDefinition(input)
  if (
    !object(raw) ||
    !keys(raw, ['version', 'kind', 'configurationRevision', 'groups']) ||
    raw.version !== 1 ||
    raw.kind !== 'weights' ||
    raw.configurationRevision !== definition.configurationRevision ||
    !Array.isArray(raw.groups) ||
    raw.groups.length !== definition.groups.length
  )
    throw invalid()
  const seen = new Set<string>()
  let rows = 0
  const groups = raw.groups.map((group): SmartWeightsGroup => {
    if (
      !object(group) ||
      !keys(group, ['name', 'status', 'weights']) ||
      !smartToolsName(group.name) ||
      !definition.groups.includes(group.name) ||
      seen.has(group.name) ||
      !['ready', 'unavailable'].includes(String(group.status))
    )
      throw invalid()
    seen.add(group.name)
    const weights = smartNodeRanks(group.weights)
    rows += weights.length
    if (rows > SMART_TOOLS_MAX_ROWS || (group.status === 'unavailable' && weights.length))
      throw invalid()
    return { name: group.name, status: group.status as 'ready' | 'unavailable', weights }
  })
  const result = {
    version: 1 as const,
    kind: 'weights' as const,
    configurationRevision: definition.configurationRevision,
    groups
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > SMART_TOOLS_PAYLOAD_BYTES)
    throw invalid()
  return result
}
export function coreSmartWeights(raw: unknown, input: SmartToolsDefinition): SmartWeightsSnapshot {
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > SMART_TOOLS_PAYLOAD_BYTES)
    throw invalid()
  const definition = smartToolsDefinition(input)
  if (
    !object(raw) ||
    !object(raw.weights) ||
    Object.keys(raw).some((key) => !['weights', 'errors', 'message'].includes(key)) ||
    (raw.errors !== undefined && !object(raw.errors)) ||
    (raw.message !== undefined && (typeof raw.message !== 'string' || raw.message.length > 4096))
  )
    throw invalid()
  const weights = raw.weights
  const errors = object(raw.errors) ? raw.errors : {}
  const returned = [...Object.keys(weights), ...Object.keys(errors)]
  if (
    returned.some((name) => !definition.groups.includes(name)) ||
    new Set(returned).size !== returned.length ||
    returned.length !== definition.groups.length
  )
    throw invalid()
  const groups = definition.groups.map((name) => {
    if (Object.hasOwn(errors, name)) {
      if (typeof errors[name] !== 'string' || errors[name].length > 4096) throw invalid()
      return { name, status: 'unavailable' as const, weights: [] }
    }
    // Fixed462 aggregates nil []NodeRankItem as null before any ranking exists.
    return {
      name,
      status: 'ready' as const,
      weights: smartNodeRanks(weights[name] === null ? [] : weights[name])
    }
  })
  return smartWeightsSnapshot(
    {
      version: 1,
      kind: 'weights',
      configurationRevision: definition.configurationRevision,
      groups
    },
    definition
  )
}
export function smartCacheAcceptance(
  raw: unknown,
  definition: SmartToolsDefinition
): SmartCacheAcceptance {
  if (
    !object(raw) ||
    !keys(raw, ['version', 'kind', 'configurationRevision', 'accepted']) ||
    raw.version !== 1 ||
    raw.kind !== 'clear-cache' ||
    raw.accepted !== true ||
    raw.configurationRevision !== smartToolsDefinition(definition).configurationRevision
  )
    throw invalid()
  return {
    version: 1,
    kind: 'clear-cache',
    configurationRevision: raw.configurationRevision,
    accepted: true
  }
}
export function smartToolsRequest(raw: unknown): SmartToolsRequest {
  if (!object(raw) || !['ordinary', 'tun'].includes(String(raw.target))) throw invalid()
  const target = raw.target as SmartToolsTarget
  if (raw.action === 'inspect' && keys(raw, ['action', 'target']))
    return { action: 'inspect', target }
  if (
    !['weights', 'clear-cache'].includes(String(raw.action)) ||
    !keys(raw, [
      'action',
      'target',
      'instanceId',
      'configurationRevision',
      ...(raw.action === 'weights' ? ['group'] : [])
    ]) ||
    typeof raw.instanceId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(raw.instanceId) ||
    !smartToolsDigest(raw.configurationRevision) ||
    (raw.action === 'weights' && !smartToolsName(raw.group))
  )
    throw invalid()
  return raw.action === 'weights'
    ? {
        action: 'weights',
        target,
        instanceId: raw.instanceId,
        configurationRevision: raw.configurationRevision,
        group: String(raw.group)
      }
    : {
        action: 'clear-cache',
        target,
        instanceId: raw.instanceId,
        configurationRevision: raw.configurationRevision
      }
}
