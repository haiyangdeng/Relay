import { parseDocument } from 'yaml'
import { normalizeShortIds } from '../../utils/yaml'

export const CONFIGURATION_BYTE_LIMIT = 2 * 1024 * 1024
export const plainConfigurationMap = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype

// Parse bounded plain data before schema/reference validation. Override stages
// may temporarily refer to groups created by a later stage; validate the graph
// after all stages, not by dropping such intermediate data.
export function readConfigurationMap(text: string): {
  data?: Record<string, unknown>
  issue?: string
} {
  const rejected = (issue: string) => ({ issue })
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    Buffer.byteLength(text) > CONFIGURATION_BYTE_LIMIT ||
    text.includes('\0')
  )
    return rejected('配置为空、过大或含无效字符；上限为2MiB。')
  try {
    const document = parseDocument(normalizeShortIds(text), {
      merge: true,
      uniqueKeys: true,
      logLevel: 'silent'
    })
    if (document.errors.length || document.warnings.length)
      return rejected('YAML／JSON解析未通过，或包含不支持的标签。')
    const data: unknown = document.toJS({ maxAliasCount: 100 })
    let nodes = 0,
      expandedBytes = 0
    const charge = (serialized: string): void => {
      expandedBytes += Buffer.byteLength(serialized)
      if (expandedBytes > CONFIGURATION_BYTE_LIMIT) throw new Error()
    }
    const seen = new Set<object>()
    const walk = (value: unknown, depth: number): void => {
      if (++nodes > 50000 || depth > 40) throw new Error()
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        charge(JSON.stringify(value))
        return
      }
      if ((!plainConfigurationMap(value) && !Array.isArray(value)) || seen.has(value))
        throw new Error()
      seen.add(value)
      charge('{}')
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error()
        charge(JSON.stringify(key) + ':,')
        walk(child, depth + 1)
      }
      seen.delete(value)
    }
    walk(data, 0)
    if (!plainConfigurationMap(data)) return rejected('配置根节点必须是映射对象。')
    return { data }
  } catch {
    return rejected('配置结构、集合格式或展开规模未通过检查。')
  }
}
