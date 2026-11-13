import { describe, expect, it } from 'vitest'
import {
  providerDefinitions,
  providerDraftChange,
  providerDraftRemove
} from './relay-rule-providers'

describe('Saved rule-provider draft projection', () => {
  const original =
    '{"First":{"type":"http","behavior":"domain","url":"https://private.invalid/KEY","interval":0,"header":{"X-Private":["KEEP"]},"hidden":false},"Other":{"type":"inline","behavior":"domain","payload":[" untouched.invalid "]}}'
  it('changes only the selected definition while preserving headers, zero, false and every other body', () => {
    const definitions = providerDefinitions(original)
    const next = providerDefinitions(
      providerDraftChange(original, {
        oldName: 'First',
        name: 'Renamed',
        expected: definitions.First,
        value: { ...definitions.First, interval: 30 }
      })
    )
    expect(Object.keys(next)).toEqual(['Renamed', 'Other'])
    expect(next.Renamed).toEqual({ ...definitions.First, interval: 30 })
    expect(next.Other).toEqual(definitions.Other)
    expect(providerDefinitions(original)).toEqual(definitions)
  })
  it('adds/removes exact draft entries without implicitly changing other rule or definition references', () => {
    const next = providerDraftChange(original, {
      name: 'New',
      value: { type: 'inline', behavior: 'domain', payload: ['RULE-SET,First'] }
    })
    expect(providerDefinitions(providerDraftRemove(next, 'First')).New.payload).toEqual([
      'RULE-SET,First'
    ])
    expect(Object.keys(providerDefinitions(next))).toEqual(['First', 'Other', 'New'])
  })
  it('preserves own reserved names rather than mutating or losing them through prototype assignment', () => {
    const body = { type: 'inline', behavior: 'domain', payload: ['fixture.invalid'] }
    const next = providerDefinitions(providerDraftChange('{}', { name: '__proto__', value: body }))
    expect(Object.hasOwn(next, '__proto__')).toBe(true)
    expect(next.__proto__).toEqual(body)
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype)
    expect(Object.hasOwn({}, 'payload')).toBe(false)
    expect(providerDraftRemove(JSON.stringify(next), '__proto__')).toBe('{}')
  })
  it('refuses malformed/duplicate decoded JSON, non-object entries and budgets without producing an empty fallback', () => {
    for (const value of [
      'bad',
      '[]',
      'null',
      '{"A":[]}',
      '{"A":null}',
      '{"A":{"interval":1e400}}',
      '{"A":{"interval":9007199254740993}}',
      '{"A":{},"\\u0041":{}}',
      '{"A":{"type":"inline","type":"http"}}'
    ])
      expect(() => providerDefinitions(value)).toThrow()
    expect(() =>
      providerDefinitions(
        JSON.stringify(Object.fromEntries(Array.from({ length: 201 }, (_, i) => ['P' + i, {}])))
      )
    ).toThrow()
    expect(() =>
      providerDefinitions(JSON.stringify({ A: { url: 'x'.repeat(512 * 1024) } }))
    ).toThrow()
  })
  it('rejects duplicate names and stale or removed modal baselines instead of overwriting newer advanced edits', () => {
    const first = providerDefinitions(original).First
    expect(() =>
      providerDraftChange(original, {
        oldName: 'First',
        name: 'Other',
        value: first,
        expected: first
      })
    ).toThrow()
    expect(() =>
      providerDraftChange(original, { oldName: 'First', name: 'First', value: first, expected: {} })
    ).toThrow()
    expect(() =>
      providerDraftChange(original, {
        oldName: 'Gone',
        name: 'Gone',
        value: first,
        expected: first
      })
    ).toThrow()
    expect(() => providerDraftRemove(original, 'Gone')).toThrow()
  })
})
