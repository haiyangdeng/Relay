// Persistence + editing surface for the complete-configuration merge options.
//
// Batch 26 already merges global/profile overrides, rule patches, DNS and
// sniffer control flags into the runtime config at a fixed priority. Batch 33
// persists those edits in Relay's own private directory and exposes an editor
// that reads, saves, clears and previews them — proving the persisted edits
// flow through the same merge with consistent priority, rather than being
// applied ad-hoc at runtime.
import type { RuntimeOverride, RuntimeRulePatch } from '../../main/relay/configuration/merge'
import type { CompleteConfigurationPlan } from './configuration'

export interface ConfigurationEditDocument {
  globalOverrides: RuntimeOverride[]
  // Legacy single-source binding remains readable without rewriting the file.
  profileOverrides: RuntimeOverride[]
  profileId?: string
  profileOverrideSets?: ConfigurationProfileOverrideSet[]
  profileRulePatchSets?: { profileId: string; rulePatch: RuntimeRulePatch }[]
  // Library card order is local metadata, never a runtime merge option.
  overrideLibraryOrder?: string[]
  rulePatch?: RuntimeRulePatch
  controlDns?: boolean
  controlSniff?: boolean
  useNameserverPolicy?: boolean
  disableDnsOverrideGuard?: boolean
  confirmedDnsFingerprint?: string
  controlled: Record<string, unknown>
}

export interface ConfigurationProfileOverrideSet {
  profileId: string
  overrides: RuntimeOverride[]
}

export interface ConfigurationEditRecord {
  document: ConfigurationEditDocument
  revision: string
  exists: boolean
}

export interface ConfigurationEditPreview {
  order: string[]
  dns: CompleteConfigurationPlan['dns']
  configuration: Record<string, unknown>
}

const OVERRIDE_KEYS = new Set(['id', 'kind', 'content', 'role'])
const RULE_KEYS = new Set(['prepend', 'append', 'delete'])
const SNIFFER_KEYS = new Set([
  'enable',
  'sniff',
  'sniffing',
  'force-domain',
  'skip-src-address',
  'skip-dst-address',
  'skip-domain',
  'port-whitelist',
  'override-destination',
  'force-dns-mapping',
  'parse-pure-ip'
])

export function snifferSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('sniffer字段必须为映射。')
  const record = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(record)) {
    if (!SNIFFER_KEYS.has(key)) throw new Error('sniffer字段不被接受：' + key)
    if (['enable', 'override-destination', 'force-dns-mapping', 'parse-pure-ip'].includes(key)) {
      if (typeof entry !== 'boolean') throw new Error('sniffer布尔字段无效。')
    } else if (key === 'sniff') {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('sniff字段必须为映射。')
      for (const [protocol, config] of Object.entries(entry)) {
        if (
          !['HTTP', 'TLS', 'QUIC'].includes(protocol) ||
          !config ||
          typeof config !== 'object' ||
          Array.isArray(config)
        )
          throw new Error('嗅探协议或配置无效。')
        const item = config as Record<string, unknown>
        if (
          Object.keys(item).some((field) => !['ports', 'override-destination'].includes(field)) ||
          (item['override-destination'] !== undefined &&
            typeof item['override-destination'] !== 'boolean') ||
          (item.ports !== undefined &&
            (!Array.isArray(item.ports) || item.ports.some((port) => typeof port !== 'string')))
        )
          throw new Error('嗅探协议字段无效。')
      }
    } else if (!Array.isArray(entry) || entry.some((item) => typeof item !== 'string'))
      throw new Error('sniffer列表字段无效。')
  }
  return structuredClone(record)
}

function stringId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error('覆写标识无效。')
  return value
}
function overrideItem(value: unknown): RuntimeOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('覆写项格式无效。')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !OVERRIDE_KEYS.has(key)))
    throw new Error('覆写项含未知字段。')
  const id = stringId(record.id)
  if (record.kind !== 'yaml' && record.kind !== 'js') throw new Error('覆写类型必须是yaml或js。')
  if (typeof record.content !== 'string' || record.content.length > 131072)
    throw new Error('覆写内容过长或无效。')
  const role = record.role === undefined ? undefined : record.role
  if (role !== undefined && role !== 'normal' && role !== 'smart') throw new Error('覆写角色无效。')
  return { id, kind: record.kind, content: record.content, ...(role ? { role } : {}) }
}
function profileScopeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value))
    throw new Error('配置级覆写必须绑定已保存的来源ID。')
  return value
}
function profileOverrideSets(value: unknown): ConfigurationProfileOverrideSet[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('配置级覆写库必须为不超过100个来源的数组。')
  const seen = new Set<string>()
  let count = 0
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('配置级覆写库条目无效。')
    const item = entry as Record<string, unknown>
    if (
      Object.keys(item).sort().join(',') !== 'overrides,profileId' ||
      !Array.isArray(item.overrides)
    )
      throw new Error('配置级覆写库条目无效。')
    count += item.overrides.length
    if (count > 200) throw new Error('覆写项过多。')
    const profileId = profileScopeId(item.profileId)
    if (seen.has(profileId)) throw new Error('配置级覆写库含重复来源。')
    seen.add(profileId)
    return { profileId, overrides: item.overrides.map(overrideItem) }
  })
}
function rulePatch(value: unknown): RuntimeRulePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('规则覆写格式无效。')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !RULE_KEYS.has(key)))
    throw new Error('规则覆写含未知字段。')
  const result: RuntimeRulePatch = {}
  for (const key of ['prepend', 'append', 'delete'] as const) {
    if (record[key] === undefined) continue
    if (!Array.isArray(record[key]) || record[key].some((r) => typeof r !== 'string'))
      throw new Error('规则覆写条目必须是字符串。')
    if (record[key].length > 1000) throw new Error('规则覆写条目过多。')
    result[key] = record[key] as string[]
  }
  return result
}
// Validate the controlled projection edits. Only a bounded set of top-level
// keys is admitted; sniffer/DNS fields are validated structurally.
function controlledEdits(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('受控编辑字段无效。')
  const record = value as Record<string, unknown>
  const allowed = new Set(['sniffer', 'dns', 'hosts', 'ipv6', 'geodata-mode', 'tcp-concurrent'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error('受控编辑字段不被接受：' + key)
  }
  if (record.sniffer !== undefined) {
    snifferSettings(record.sniffer)
  }
  return structuredClone(record)
}

export function configurationEditDocument(value: unknown): ConfigurationEditDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('配置编辑文档格式无效。')
  const record = value as Record<string, unknown>
  const known = new Set([
    'globalOverrides',
    'profileOverrides',
    'profileId',
    'profileOverrideSets',
    'profileRulePatchSets',
    'overrideLibraryOrder',
    'rulePatch',
    'controlDns',
    'controlSniff',
    'useNameserverPolicy',
    'disableDnsOverrideGuard',
    'confirmedDnsFingerprint',
    'controlled'
  ])
  for (const key of Object.keys(record))
    if (!known.has(key)) throw new Error('配置编辑文档含未知字段：' + key)
  if (!Array.isArray(record.globalOverrides) || !Array.isArray(record.profileOverrides))
    throw new Error('覆写列表必须是数组。')
  const sets =
    record.profileOverrideSets === undefined
      ? undefined
      : profileOverrideSets(record.profileOverrideSets)
  let overrideLibraryOrder: string[] | undefined
  if (record.overrideLibraryOrder !== undefined) {
    if (
      !Array.isArray(record.overrideLibraryOrder) ||
      record.overrideLibraryOrder.length > 200 ||
      record.overrideLibraryOrder.some(
        (id) =>
          typeof id !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id)
      ) ||
      new Set(record.overrideLibraryOrder).size !== record.overrideLibraryOrder.length
    )
      throw new Error('覆写库顺序必须是最多200个不重复的库ID。')
    overrideLibraryOrder = [...record.overrideLibraryOrder]
  }
  let patches: ConfigurationEditDocument['profileRulePatchSets']
  if (record.profileRulePatchSets !== undefined) {
    if (!Array.isArray(record.profileRulePatchSets) || record.profileRulePatchSets.length > 100)
      throw new Error('配置级规则补丁库最多100个来源。')
    const seen = new Set<string>()
    patches = record.profileRulePatchSets.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('配置级规则补丁无效。')
      const item = entry as Record<string, unknown>
      if (Object.keys(item).sort().join(',') !== 'profileId,rulePatch')
        throw new Error('配置级规则补丁含未知字段。')
      const profileId = profileScopeId(item.profileId)
      if (seen.has(profileId)) throw new Error('配置级规则补丁含重复来源。')
      seen.add(profileId)
      return { profileId, rulePatch: rulePatch(item.rulePatch) }
    })
  }
  if (
    record.globalOverrides.length +
      record.profileOverrides.length +
      (sets?.reduce((total, set) => total + set.overrides.length, 0) ?? 0) >
    200
  )
    throw new Error('覆写项过多。')
  if (
    (record.profileId !== undefined &&
      (typeof record.profileId !== 'string' ||
        !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(record.profileId))) ||
    (record.profileOverrides.length > 0 && record.profileId === undefined)
  )
    throw new Error('配置级覆写必须绑定已保存的来源ID。')
  if (record.profileOverrides.length > 0 && sets?.some((set) => set.profileId === record.profileId))
    throw new Error('同一来源不能同时使用旧绑定与配置级覆写库。')
  for (const flag of ['controlDns', 'controlSniff', 'disableDnsOverrideGuard'] as const)
    if (record[flag] !== undefined && typeof record[flag] !== 'boolean')
      throw new Error(flag + '必须是布尔。')
  if (record.useNameserverPolicy !== undefined && typeof record.useNameserverPolicy !== 'boolean')
    throw new Error('useNameserverPolicy必须是布尔。')
  if (
    record.confirmedDnsFingerprint !== undefined &&
    (typeof record.confirmedDnsFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(record.confirmedDnsFingerprint))
  )
    throw new Error('DNS指纹无效。')
  return {
    globalOverrides: record.globalOverrides.map(overrideItem),
    profileOverrides: record.profileOverrides.map(overrideItem),
    ...(overrideLibraryOrder !== undefined ? { overrideLibraryOrder } : {}),
    ...(record.profileId !== undefined ? { profileId: record.profileId as string } : {}),
    ...(sets !== undefined ? { profileOverrideSets: sets } : {}),
    ...(patches !== undefined ? { profileRulePatchSets: patches } : {}),
    ...(record.rulePatch !== undefined ? { rulePatch: rulePatch(record.rulePatch) } : {}),
    ...(record.controlDns !== undefined ? { controlDns: record.controlDns as boolean } : {}),
    ...(record.controlSniff !== undefined ? { controlSniff: record.controlSniff as boolean } : {}),
    ...(record.useNameserverPolicy !== undefined
      ? { useNameserverPolicy: record.useNameserverPolicy as boolean }
      : {}),
    ...(record.disableDnsOverrideGuard !== undefined
      ? { disableDnsOverrideGuard: record.disableDnsOverrideGuard as boolean }
      : {}),
    ...(record.confirmedDnsFingerprint !== undefined
      ? { confirmedDnsFingerprint: record.confirmedDnsFingerprint as string }
      : {}),
    controlled: controlledEdits(record.controlled ?? {})
  }
}

export function defaultEditDocument(): ConfigurationEditDocument {
  return { globalOverrides: [], profileOverrides: [], controlled: {} }
}

export function configurationEditRevision(value: unknown): string {
  if (typeof value !== 'string' || (value !== '' && !/^[a-f0-9]{64}$/u.test(value)))
    throw new Error('编辑版本无效，请重新读取保存的编辑。')
  return value
}

export function configurationEditSaveRequest(raw: unknown): {
  document: ConfigurationEditDocument
  expectedRevision: string
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('保存编辑需要文档与已读取的版本。')
  const item = raw as Record<string, unknown>
  if (Object.keys(item).sort().join(',') !== 'document,expectedRevision')
    throw new Error('保存编辑需要文档与已读取的版本。')
  return {
    document: configurationEditDocument(item.document),
    expectedRevision: configurationEditRevision(item.expectedRevision)
  }
}

export function configurationEditClearRequest(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('清除编辑需要已读取的版本。')
  const item = raw as Record<string, unknown>
  if (Object.keys(item).join(',') !== 'expectedRevision')
    throw new Error('清除编辑只接受已读取的版本。')
  return configurationEditRevision(item.expectedRevision)
}

export function profileOverridesFor(
  document: ConfigurationEditDocument,
  profileId: string
): RuntimeOverride[] {
  return structuredClone(
    document.profileOverrideSets?.find((set) => set.profileId === profileId)?.overrides ??
      (document.profileId === profileId ? document.profileOverrides : [])
  )
}

export function profileRulePatchFor(
  document: ConfigurationEditDocument,
  profileId: string
): RuntimeRulePatch | undefined {
  return structuredClone(
    document.profileRulePatchSets?.find((set) => set.profileId === profileId)?.rulePatch
  )
}

// A new immutable subscription snapshot inherits only its predecessor's local
// edits. Historical snapshots and explicit target bindings are never changed.
export function inheritProfileEdits(
  document: ConfigurationEditDocument,
  previousId: string,
  targetId: string
): ConfigurationEditDocument {
  profileScopeId(previousId)
  profileScopeId(targetId)
  let current = configurationEditDocument(document)
  if (previousId === targetId) return current
  const overrides = profileOverridesFor(current, previousId)
  if (
    overrides.length &&
    current.profileId !== targetId &&
    !current.profileOverrideSets?.some((set) => set.profileId === targetId)
  )
    current = updateProfileOverrides(current, targetId, overrides)
  const patch = profileRulePatchFor(current, previousId)
  if (patch && !current.profileRulePatchSets?.some((set) => set.profileId === targetId))
    current = configurationEditDocument({
      ...current,
      profileRulePatchSets: [
        ...(current.profileRulePatchSets ?? []),
        { profileId: targetId, rulePatch: patch }
      ]
    })
  return current
}

// Explicit UI editing migrates only the selected legacy binding. Other sources
// and every global setting stay in place, including when removing this source.
export function updateProfileOverrides(
  document: ConfigurationEditDocument,
  profileId: string,
  overrides: unknown
): ConfigurationEditDocument {
  profileScopeId(profileId)
  if (!Array.isArray(overrides)) throw new Error('配置级覆写列表必须为数组。')
  if (overrides.length > 200) throw new Error('覆写项过多。')
  const current = configurationEditDocument(document)
  const sets = (current.profileOverrideSets ?? []).filter((set) => set.profileId !== profileId)
  if (overrides.length) sets.push({ profileId, overrides: overrides.map(overrideItem) })
  if (current.profileId === profileId) {
    delete current.profileId
    current.profileOverrides = []
  }
  return configurationEditDocument({ ...current, profileOverrideSets: sets })
}
