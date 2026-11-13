import { describe, expect, it } from 'vitest'
import { runtimeGistDiscoveryEvidence, runtimeGistDiscoveryRequest } from './runtime-gist-discovery'

const selection = { id: '11111111-1111-4111-8111-111111111111', revision: 'a'.repeat(64) }
describe('Runtime Gist discovery public boundary', () => {
  it('defaults to one bounded page and copies only the saved public selection', () => {
    expect(runtimeGistDiscoveryRequest(selection)).toEqual({ ...selection, page: 1 })
    expect(runtimeGistDiscoveryRequest({ ...selection, page: 1000 })).toEqual({
      ...selection,
      page: 1000
    })
    expect(runtimeGistDiscoveryEvidence({ evidenceId: selection.id })).toEqual({
      evidenceId: selection.id
    })
  })
  it.each([0, 1001, -1, 1.1, NaN, Infinity, '1', null, [], new Number(1)])(
    'rejects a non-integer, coerced or unbounded page %j',
    (page) => {
      expect(() => runtimeGistDiscoveryRequest({ ...selection, page })).toThrow()
    }
  )
  it.each(['token', 'url', 'description', 'filename', 'recipient', 'source', 'action', 'history'])(
    'does not accept a renderer-controlled %s',
    (key) => {
      expect(() => runtimeGistDiscoveryRequest({ ...selection, [key]: 'PRIVATE' })).toThrow()
    }
  )
  it.each([
    undefined,
    null,
    [],
    {},
    { ...selection, id: '../foreign' },
    { ...selection, revision: 'bad' }
  ])('requires a strict saved account selection %j', (value) => {
    expect(() => runtimeGistDiscoveryRequest(value)).toThrow()
  })
  it.each([
    {},
    [],
    { id: selection.id },
    { evidenceId: 'bad' },
    { evidenceId: selection.id, page: 1 },
    { evidenceId: selection.id, token: 'PRIVATE' }
  ])('consumes only an exact evidence ID %j', (value) => {
    expect(() => runtimeGistDiscoveryEvidence(value)).toThrow()
  })
})
