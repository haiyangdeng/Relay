export interface RelayProfileSummary {
  proxies: number
  groups: number
  rules: number
  proxyProviders: number
  ruleProviders: number
}
export interface RelayProfileInspection {
  structure: 'passed' | 'rejected'
  coreCompatibility: 'notVerified'
  active: false
  summary?: RelayProfileSummary
  issues: string[]
}
export interface RelayProfilePreparation {
  evidenceId: string
  name: string
  sha256: string
  bytes: number
  inspection: RelayProfileInspection
  ruleSnapshot?: {
    provider: string
    resourceSHA256: string
    rules: number
    behavior: 'domain' | 'ipcidr' | 'classical'
  }
}
export interface RelayStoredProfile {
  id: string
  name: string
  createdAt: string
  sha256: string
  summary: RelayProfileSummary
}
export interface RelayProfileInventory {
  profiles: RelayStoredProfile[]
  incomplete: number
  activeId: null
  warnings: string[]
}
export interface RelayProfileSaveResult {
  status: 'cancelled' | 'saved' | 'failed' | 'uncertain'
  profile?: RelayStoredProfile
  warnings: string[]
}
export interface RelayProfileNodes {
  profile: RelayStoredProfile
  nodes: Record<string, unknown>[]
}
export interface RelayProfileGroups {
  profile: RelayStoredProfile
  groups: Record<string, unknown>[]
  targets: string[]
  providers: string[]
  savedSelectors?: [string, string][]
}
// A saved declaration can prove explicit members. Provider expansion and
// filtering need the running core's actual membership.
type GroupDeclarations = Pick<RelayProfileGroups, 'groups' | 'targets'>
const cachedGroupMembership = new WeakMap<GroupDeclarations, Map<string, Set<string>>>()
export function canSelectCachedGroupMember(
  snapshot: GroupDeclarations,
  name: string,
  member: string
): boolean {
  let membership = cachedGroupMembership.get(snapshot)
  if (!membership) {
    membership = new Map()
    const targets = new Set(snapshot.targets)
    for (const group of snapshot.groups) {
      if (typeof group.name !== 'string') continue
      const members = new Set<string>()
      if (
        !membership.has(group.name) &&
        typeof group.type === 'string' &&
        ['select', 'url-test', 'fallback', 'smart'].includes(group.type) &&
        !group.filter &&
        !group['exclude-filter'] &&
        !group['exclude-type'] &&
        Array.isArray(group.proxies)
      ) {
        for (const item of group.proxies)
          if (typeof item === 'string' && item !== group.name && targets.has(item))
            members.add(item)
      }
      membership.set(group.name, members)
    }
    cachedGroupMembership.set(snapshot, membership)
  }
  return membership.get(name)?.has(member) ?? false
}
export interface RelayProfileRules {
  profile: RelayStoredProfile
  rules: string[]
  targets: string[]
  providers: string[]
  subRules: string[]
}
export interface RelayProfileRuleProviders {
  profile: RelayStoredProfile
  providers: Record<string, Record<string, unknown>>
}
export interface RelayProfileExportResult {
  status: 'exported' | 'cancelled'
}
export function stripProfileControls(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
}
export function profileEvidence(raw: unknown): string {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).join(',') !== 'evidenceId'
  )
    throw new Error('只接受本次配置检查凭据，不接受路径或配置正文。')
  const id = (raw as Record<string, unknown>).evidenceId
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))
    throw new Error('配置检查凭据无效。')
  return id
}
export const reservedProfileTargets: ReadonlySet<string> = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'PASS-RULE',
  'COMPATIBLE',
  'GLOBAL'
])
