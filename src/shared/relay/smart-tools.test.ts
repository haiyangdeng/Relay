import { describe, expect, it } from 'vitest'
import {
  coreSmartWeights,
  smartCacheAcceptance,
  smartNodeRanks,
  smartToolsRequest,
  smartWeightsSnapshot
} from './smart-tools'
const revision = 'a'.repeat(64)
const definition = { configurationRevision: revision, groups: ['组 / % 1', 'B'] }
const core = () => ({
  weights: { '组 / % 1': [{ Name: 'n % / 中文', Rank: '', Weight: 0 }], B: null },
  errors: {}
})
describe('fixed462 Smart tools contract', () => {
  it('normalizes the fixed aggregate null and preserves exact Unicode/percent names and unranked rows', () => {
    expect(coreSmartWeights(core(), definition).groups).toEqual([
      { name: '组 / % 1', status: 'ready', weights: [{ Name: 'n % / 中文', Rank: '', Weight: 0 }] },
      { name: 'B', status: 'ready', weights: [] }
    ])
  })
  it('accepts only the three fixed ranked labels plus exact empty unranked', () => {
    for (const Rank of ['', 'MostUsed', 'OccasionalUsed', 'RarelyUsed'])
      expect(smartNodeRanks([{ Name: 'n', Rank, Weight: 100 }])[0].Rank).toBe(Rank)
    for (const Rank of ['Occasional', 'mostused', 'unknown', null, 1])
      expect(() => smartNodeRanks([{ Name: 'n', Rank, Weight: 50 }])).toThrow()
  })
  it('does not treat health, lowercase JSON or legacy weight maps as ranking rows', () => {
    for (const value of [
      [{ name: 'n', rank: 'MostUsed', weight: 50 }],
      [{ Name: 'n', Rank: 'MostUsed', delay: 4 }],
      { n: 50 }
    ])
      expect(() => smartNodeRanks(value)).toThrow()
  })
  it('bounds every finite source-derived percentage including both endpoints', () => {
    for (const Weight of [0, 0.01, 99.99, 100])
      expect(smartNodeRanks([{ Name: 'n', Rank: 'MostUsed', Weight }])[0].Weight).toBe(Weight)
    for (const Weight of [-1, 100.01, NaN, Infinity, -Infinity, true, '50'])
      expect(() => smartNodeRanks([{ Name: 'n', Rank: 'MostUsed', Weight }])).toThrow()
  })
  it('binds aggregate groups to the held declared Smart set, not historical DB group keys', () => {
    for (const raw of [
      { weights: { 'old-group': [], B: [] }, errors: {} },
      { weights: { B: [] }, errors: {} },
      { weights: { ...core().weights, extra: [] }, errors: {} }
    ])
      expect(() => coreSmartWeights(raw, definition)).toThrow()
    const raw = { weights: { '组 / % 1': null }, errors: { B: 'private/Core/path' } }
    expect(coreSmartWeights(raw, definition).groups[1]).toEqual({
      name: 'B',
      status: 'unavailable',
      weights: []
    })
    expect(JSON.stringify(coreSmartWeights(raw, definition))).not.toContain('private/Core/path')
  })
  it('keeps legitimate same-group historic node labels and rejects duplicate node identities', () => {
    expect(
      coreSmartWeights(
        { weights: { B: [{ Name: 'previous node', Rank: 'RarelyUsed', Weight: 0 }] } },
        { configurationRevision: revision, groups: ['B'] }
      ).groups[0].weights[0].Name
    ).toBe('previous node')
    expect(() =>
      smartNodeRanks([
        { Name: 'n', Rank: '', Weight: 0 },
        { Name: 'n', Rank: '', Weight: 0 }
      ])
    ).toThrow()
  })
  it('rejects overlap between an error and result and oversized raw bodies before picking fields', () => {
    expect(() =>
      coreSmartWeights({ weights: core().weights, errors: { B: 'error' } }, definition)
    ).toThrow()
    expect(() =>
      coreSmartWeights(
        { weights: core().weights, errors: {}, message: 'x'.repeat(245761) },
        definition
      )
    ).toThrow()
  })
  it('takes independent DTO copies and rejects a different configuration revision', () => {
    const raw = core(),
      snapshot = coreSmartWeights(raw, definition)
    raw.weights['组 / % 1'][0].Name = 'changed'
    expect(snapshot.groups[0].weights[0].Name).toBe('n % / 中文')
    expect(() =>
      smartWeightsSnapshot({ ...snapshot, configurationRevision: 'b'.repeat(64) }, definition)
    ).toThrow()
  })
  it('distinguishes accepted cache clearing from weights or a durable flush claim', () => {
    expect(
      smartCacheAcceptance(
        { version: 1, kind: 'clear-cache', configurationRevision: revision, accepted: true },
        definition
      ).accepted
    ).toBe(true)
    for (const extra of [{ persisted: true }, { csvRemoved: true }, { accepted: false }])
      expect(() =>
        smartCacheAcceptance(
          {
            version: 1,
            kind: 'clear-cache',
            configurationRevision: revision,
            accepted: true,
            ...extra
          },
          definition
        )
      ).toThrow()
  })
  it('rejects arbitrary paths, peers and extra authority on requests', () => {
    const request = {
      action: 'weights',
      target: 'ordinary',
      instanceId: '11111111-2222-3333-4444-555555555555',
      configurationRevision: revision,
      group: '组 / % 1'
    }
    expect(smartToolsRequest(request)).toEqual(request)
    for (const extra of [
      { path: '/cache/smart/flush' },
      { pid: 5 },
      { target: 'unknown' },
      { group: '\n' }
    ])
      expect(() => smartToolsRequest({ ...request, ...extra })).toThrow()
  })
})
