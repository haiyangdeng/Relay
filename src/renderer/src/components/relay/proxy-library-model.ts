import type { RelayProfileGroups, RelayStoredProfile } from '../../../../shared/relay/profiles'
import type { SubscriptionSourceInfo } from '../../../../shared/relay/subscription-sources'

export interface CachedProxyMember {
  name: string
  kind: 'node' | 'group' | 'builtin' | 'unknown'
}

export interface CachedProxyGroup {
  name: string
  type: string
  typeLabel: string
  members: CachedProxyMember[]
  totalMembers: number
  providers: string[]
  hidden: boolean
  unresolved: boolean
  unresolvedReasons: string[]
}

const builtinTargets = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'PASS-RULE',
  'COMPATIBLE',
  'GLOBAL'
])
const groupTypeLabels: Readonly<Record<string, string>> = {
  select: '手动选择',
  'url-test': '自动测速',
  fallback: '故障转移',
  'load-balance': '负载均衡',
  smart: '智能选择'
}
const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []

// This is a view of declarations, not a simulated Mihomo runtime. In particular,
// it never chooses a current node, evaluates provider filters or creates delays.
export function cachedProxyGroups(
  snapshot: RelayProfileGroups,
  options: { search?: string; showHidden?: boolean } = {}
): CachedProxyGroup[] {
  const query = options.search?.trim().toLocaleLowerCase() ?? ''
  const targets = new Set(snapshot.targets)
  const groups = new Set(
    snapshot.groups.flatMap((group) => (typeof group.name === 'string' ? [group.name] : []))
  )
  return snapshot.groups.flatMap((group): CachedProxyGroup[] => {
    if (
      typeof group.name !== 'string' ||
      !group.name ||
      (group.hidden === true && !options.showHidden)
    )
      return []
    const type = typeof group.type === 'string' ? group.type : 'unknown'
    const providers = names(group.use)
    const members = names(group.proxies).map((name): CachedProxyMember => ({
      name,
      kind: builtinTargets.has(name)
        ? 'builtin'
        : groups.has(name)
          ? 'group'
          : targets.has(name)
            ? 'node'
            : 'unknown'
    }))
    const unresolvedReasons: string[] = []
    if (providers.length) unresolvedReasons.push('提供者成员在运行后读取')
    if (
      ['include-all', 'include-all-proxies', 'include-all-providers'].some(
        (key) => group[key] === true
      ) ||
      ['filter', 'exclude-filter', 'exclude-type'].some(
        (key) => typeof group[key] === 'string' && group[key] !== ''
      )
    )
      unresolvedReasons.push('动态筛选结果在运行后读取')
    if (members.some((member) => member.kind === 'unknown'))
      unresolvedReasons.push('部分声明成员未在当前配置中找到')
    if (
      (group.proxies !== undefined &&
        (!Array.isArray(group.proxies) || group.proxies.length !== members.length)) ||
      (group.use !== undefined &&
        (!Array.isArray(group.use) || group.use.length !== providers.length))
    )
      unresolvedReasons.push('成员声明格式需要检查')
    const visibleMembers =
      !query || group.name.toLocaleLowerCase().includes(query)
        ? members
        : members.filter((member) => member.name.toLocaleLowerCase().includes(query))
    if (query && !group.name.toLocaleLowerCase().includes(query) && !visibleMembers.length)
      return []
    return [
      {
        name: group.name,
        type,
        typeLabel: Object.hasOwn(groupTypeLabels, type) ? groupTypeLabels[type] : '其他代理组',
        members: visibleMembers,
        totalMembers: members.length,
        providers,
        hidden: group.hidden === true,
        unresolved: unresolvedReasons.length > 0,
        unresolvedReasons
      }
    ]
  })
}

export function preferredCachedProfile({
  queryId,
  currentSelection,
  sources = [],
  profiles
}: {
  queryId?: string | null
  currentSelection?: string | null
  sources?: readonly Pick<SubscriptionSourceInfo, 'createdAt' | 'versions'>[]
  profiles: readonly RelayStoredProfile[]
}): RelayStoredProfile | undefined {
  const requested = queryId ? profiles.find((profile) => profile.id === queryId) : undefined
  if (requested) return requested
  const current = currentSelection
    ? profiles.find((profile) => profile.id === currentSelection)
    : undefined
  if (current) return current
  const subscriptionProfiles = new Set(
    sources.flatMap((source) => source.versions.map((version) => version.profile.id))
  )
  const local = profiles
    .filter((profile) => !subscriptionProfiles.has(profile.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (local) return local
  for (const source of [...sources].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const latest = source.versions.at(-1)?.profile
    if (!latest) continue
    const stored = profiles.find(
      (profile) => profile.id === latest.id && profile.sha256 === latest.sha256
    )
    if (stored) return stored
  }
  return profiles[0]
}
