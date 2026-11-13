import { describe, expect, it } from 'vitest'
import { localProxyRulesSHA256, readLocalProxyRules } from './local-proxy-rules'

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing synthetic fixture value')
  return value
}

const table = () => ({
  rules: [
    {
      index: 0,
      type: 'DomainSuffix',
      payload: 'fixture.invalid',
      proxy: 'REJECT',
      size: -1,
      extra: { disabled: false, hitCount: 0, hitAt: '0001-01-01T00:00:00Z' }
    },
    { index: 1, type: 'Match', payload: '', proxy: 'REJECT', size: -1 }
  ]
})
describe('Complete ordered owned rule snapshot', () => {
  it('exposes complete observed counters without granting write authority to them', () => {
    const raw = {
      rules: [
        {
          ...table().rules[0],
          extra: {
            disabled: false,
            hitCount: 2,
            missCount: 8,
            hitAt: '2026-11-09T08:00:00Z',
            missAt: '0001-01-01T00:00:00Z'
          }
        }
      ]
    }
    const before = readLocalProxyRules(raw)
    expect(before.rules[0].statistics).toEqual({
      hitCount: 2,
      missCount: 8,
      hitAt: '2026-11-09T08:00:00Z'
    })
    raw.rules[0].extra.hitCount = 3
    raw.rules[0].extra.hitAt = 'malformed'
    const after = readLocalProxyRules(raw)
    expect(after.rulesSHA256).toBe(before.rulesSHA256)
    expect(after.rules[0].statistics).toEqual({ hitCount: 3, missCount: 8 })
    raw.rules[0].extra.hitCount = -1
    expect(readLocalProxyRules(raw).rules[0].statistics).toBeUndefined()
    raw.rules[0].extra.hitCount = Number.MAX_SAFE_INTEGER
    expect(readLocalProxyRules(raw).rules[0].statistics).toBeUndefined()
  })
  it('binds static fields and exact false while ignoring volatile counters/time', () => {
    const raw = table(),
      before = readLocalProxyRules(raw)
    present(raw.rules[0].extra).hitCount = 999
    present(raw.rules[0].extra).hitAt = 'not parsed as a date'
    expect(readLocalProxyRules(raw)).toEqual(before)
    expect(before.rules[0].disabled).toBe(false)
    expect(before.rules[1]).not.toHaveProperty('disabled')
    expect(JSON.stringify(before)).not.toContain('hitAt')
    expect(localProxyRulesSHA256([{ ...before.rules[1], disabled: false }])).not.toBe(
      localProxyRulesSHA256([before.rules[1]])
    )
  })
  it('treats empty MATCH payload as data and preserves duplicate rule positions', () => {
    const raw = table()
    raw.rules.push({ ...raw.rules[0], index: 2 })
    expect(readLocalProxyRules(raw).rules.map((r) => r.index)).toEqual([0, 1, 2])
    const before = readLocalProxyRules(raw)
    present(raw.rules[0].extra).disabled = true
    expect(readLocalProxyRules(raw).rulesSHA256).not.toBe(before.rulesSHA256)
  })
  it.each([
    { rules: null },
    { rules: [{ ...table().rules[0], index: 1 }] },
    { rules: [{ ...table().rules[0], size: -2 }] },
    { rules: [{ ...table().rules[0], size: 1.5 }] },
    { rules: [{ ...table().rules[0], payload: [] }] },
    { rules: [{ ...table().rules[0], extra: { disabled: 'false' } }] },
    { rules: [{ ...table().rules[0], extra: { disabled: null } }] },
    { rules: [{ ...table().rules[0], extra: { disabled: new Boolean(false) } }] },
    { rules: Array(10001).fill(null) }
  ])('refuses malformed or truncated authority: %j', (raw) => {
    expect(() => readLocalProxyRules(raw)).toThrow()
  })
  it('bounds the complete canonical table without silently truncating rows', () => {
    expect(() =>
      readLocalProxyRules({
        rules: Array.from({ length: 40 }, (_, index) => ({
          index,
          type: 'Domain',
          payload: 'a'.repeat(65536),
          proxy: 'REJECT',
          extra: { disabled: false }
        }))
      })
    ).toThrow('预算')
  })
})
