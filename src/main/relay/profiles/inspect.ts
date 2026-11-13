import {
  reservedProfileTargets,
  stripProfileControls,
  type RelayProfileInspection,
  type RelayProfileSummary
} from '../../../shared/relay/profiles'
import {
  readConfigurationMap,
  CONFIGURATION_BYTE_LIMIT,
  plainConfigurationMap as plain
} from './document'

export const PROFILE_BYTE_LIMIT = CONFIGURATION_BYTE_LIMIT
export { reservedProfileTargets } from '../../../shared/relay/profiles'
const name = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 256 &&
  stripProfileControls(value) === value

// Structure only: no core execution, schema scripts, provider/file/URL reads,
// downloads or raw YAML diagnostics (which may contain credentials).
export function analyzeProfile(text: string): {
  inspection: RelayProfileInspection
  data?: Record<string, unknown>
} {
  const rejected = (issue: string): { inspection: RelayProfileInspection } => ({
    inspection: {
      structure: 'rejected',
      coreCompatibility: 'notVerified',
      active: false,
      issues: [issue]
    }
  })
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    Buffer.byteLength(text) > PROFILE_BYTE_LIMIT ||
    text.includes('\0')
  )
    return rejected('配置为空、过大或含无效字符；上限为2MiB。')
  try {
    const document = readConfigurationMap(text)
    if (!document.data) return rejected(document.issue ?? '配置结构未通过检查。')
    const data = document.data
    const list = (key: string): unknown[] => {
      const value = data[key] ?? []
      if (!Array.isArray(value)) throw new Error()
      return value
    }
    const providers = (key: string): Record<string, unknown> => {
      const value = data[key] ?? {}
      if (!plain(value) || Object.values(value).some((item) => !plain(item))) throw new Error()
      return value
    }
    const proxies = list('proxies'),
      groups = list('proxy-groups'),
      rules = list('rules')
    const proxyProviders = providers('proxy-providers'),
      ruleProviders = providers('rule-providers')
    if (rules.some((rule) => typeof rule !== 'string')) return rejected('rules必须是文本规则列表。')
    const names = new Set<string>()
    for (const entry of [...proxies, ...groups]) {
      if (!plain(entry) || !name(entry.name) || !name(entry.type))
        return rejected('节点和代理组必须是含有效name／type的对象。')
      if (names.has(entry.name) || reservedProfileTargets.has(entry.name))
        return rejected('节点／代理组名称重复或占用了核心内置名称。')
      names.add(entry.name)
    }
    for (const group of groups) {
      if (!plain(group)) throw new Error()
      if (
        group.proxies !== undefined &&
        (!Array.isArray(group.proxies) ||
          group.proxies.some(
            (entry) => !name(entry) || (!names.has(entry) && !reservedProfileTargets.has(entry))
          ))
      )
        return rejected('代理组引用了未知节点／代理组，或proxies格式无效。')
      if (
        group.use !== undefined &&
        (!Array.isArray(group.use) ||
          group.use.some((entry) => !name(entry) || !Object.hasOwn(proxyProviders, entry)))
      )
        return rejected('代理组use引用的提供者不存在或格式无效。')
    }
    const dependencies = new Map<string, string[]>()
    for (const group of groups) {
      if (!plain(group) || !name(group.name)) throw new Error()
      dependencies.set(group.name, Array.isArray(group.proxies) ? group.proxies.filter(name) : [])
    }
    const visiting = new Set<string>(),
      done = new Set<string>()
    for (const start of dependencies.keys()) {
      const stack: [string, boolean][] = [[start, false]]
      while (stack.length) {
        const [current, exiting] = stack.pop() ?? []
        if (current === undefined) throw new Error()
        if (exiting) {
          visiting.delete(current)
          done.add(current)
          continue
        }
        if (done.has(current) || !dependencies.has(current)) continue
        if (visiting.has(current)) return rejected('代理组之间存在循环引用。')
        visiting.add(current)
        stack.push([current, true])
        for (const next of dependencies.get(current) ?? []) stack.push([next, false])
      }
    }
    const summary: RelayProfileSummary = {
      proxies: proxies.length,
      groups: groups.length,
      rules: rules.length,
      proxyProviders: Object.keys(proxyProviders).length,
      ruleProviders: Object.keys(ruleProviders).length
    }
    return {
      data,
      inspection: {
        structure: 'passed',
        coreCompatibility: 'notVerified',
        active: false,
        summary,
        issues: []
      }
    }
  } catch {
    return rejected('配置结构、集合格式或展开规模未通过检查。')
  }
}
export function inspectProfile(text: string): RelayProfileInspection {
  return analyzeProfile(text).inspection
}
