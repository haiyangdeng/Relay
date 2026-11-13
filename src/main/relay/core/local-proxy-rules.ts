import { createHash } from 'crypto'
import type { LocalProxyRule } from '../../../shared/relay/local-proxy'

const MAX_BYTES = 2 * 1024 * 1024
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('本次规则表格式未确认。')
  return value as Record<string, unknown>
}
function text(value: unknown, empty = true): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > 65536)
    throw new Error('本次规则表字段未确认。')
  return value
}

function statistics(extra?: Record<string, unknown>): LocalProxyRule['statistics'] {
  if (!extra) return undefined
  const { hitCount, missCount } = extra
  if (
    typeof hitCount !== 'number' ||
    typeof missCount !== 'number' ||
    !Number.isSafeInteger(hitCount) ||
    !Number.isSafeInteger(missCount) ||
    hitCount < 0 ||
    missCount < 0 ||
    !Number.isSafeInteger(hitCount + missCount)
  )
    return undefined
  const timestamp = (value: unknown): string | undefined =>
    typeof value === 'string' &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    !value.startsWith('0001-') &&
    Number.isFinite(Date.parse(value))
      ? value
      : undefined
  const hitAt = timestamp(extra.hitAt),
    missAt = timestamp(extra.missAt)
  return { hitCount, missCount, ...(hitAt ? { hitAt } : {}), ...(missAt ? { missAt } : {}) }
}

// Fixed Mihomo GET /rules exposes volatile hit/miss counters alongside these
// static fields. Only the complete ordered table and disabled bits bind writes.
export function localProxyRulesSHA256(rules: readonly LocalProxyRule[]): string {
  const bytes = JSON.stringify(
    rules.map((row) => ({
      index: row.index,
      type: row.type,
      payload: row.payload,
      proxy: row.proxy,
      size: row.size ?? null,
      disabled: row.disabled ?? null
    }))
  )
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('本次规则表超出读取预算。')
  return createHash('sha256').update(bytes).digest('hex')
}

export function readLocalProxyRules(raw: unknown): {
  rules: LocalProxyRule[]
  rulesSHA256: string
} {
  const value = object(raw).rules
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error('本次规则表超出读取预算或格式无效。')
  const rules = value.map((entry, index): LocalProxyRule => {
    const row = object(entry)
    if (row.index !== index) throw new Error('本次规则表顺序或索引未确认。')
    if (
      row.size !== undefined &&
      (typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < -1)
    )
      throw new Error('本次规则大小未确认。')
    const extra = row.extra === undefined ? undefined : object(row.extra)
    if (extra?.disabled !== undefined && typeof extra.disabled !== 'boolean')
      throw new Error('本次规则禁用状态未确认。')
    const observed = statistics(extra)
    return {
      index,
      type: text(row.type, false),
      payload: text(row.payload),
      proxy: text(row.proxy),
      ...(row.size === undefined ? {} : { size: row.size as number }),
      ...(extra?.disabled === undefined ? {} : { disabled: extra.disabled as boolean }),
      ...(observed ? { statistics: observed } : {})
    }
  })
  return { rules, rulesSHA256: localProxyRulesSHA256(rules) }
}
