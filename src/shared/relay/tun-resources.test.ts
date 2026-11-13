import { describe, expect, it } from 'vitest'
import { tunResourceReadRequest, tunResourceReplaceRequest } from './tun-resources'

const sessionId = '11111111-1111-4111-8111-111111111111',
  change = {
    sessionId,
    configurationRevision: 'a'.repeat(64),
    expectedGenerationSHA256: 'b'.repeat(64),
    origin: { id: '22222222-2222-4222-8222-222222222222', revision: 'c'.repeat(64) }
  }
describe('public TUN resource selections', () => {
  it('returns only the exact existing session and two opaque revisions', () => {
    expect(tunResourceReadRequest({ sessionId })).toEqual({ sessionId })
    expect(tunResourceReplaceRequest(change)).toEqual(change)
    expect(tunResourceReplaceRequest(change)).not.toBe(change)
    expect(tunResourceReplaceRequest(change).origin).not.toBe(change.origin)
  })
  it.each(['pid', 'path', 'url', 'kind', 'blobId', 'nonce', 'sha256', 'bytes', 'ownerUID'])(
    'rejects renderer authority %s before any host lookup',
    (key) => {
      expect(() => tunResourceReadRequest({ sessionId, [key]: 'foreign' })).toThrow()
      expect(() => tunResourceReplaceRequest({ ...change, [key]: 'foreign' })).toThrow()
    }
  )
  it.each(['configurationRevision', 'expectedGenerationSHA256'] as const)(
    'requires the complete lowercase %s',
    (key) => {
      for (const value of ['A'.repeat(64), 'a'.repeat(63), '', 0, null])
        expect(() => tunResourceReplaceRequest({ ...change, [key]: value })).toThrow()
    }
  )
  it('rejects unknown or incomplete nested source choices without accepting a caller-supplied head', () => {
    for (const origin of [
      null,
      { id: change.origin.id },
      { ...change.origin, head: {} },
      { ...change.origin, revision: '' },
      { ...change.origin, url: 'https://foreign.invalid/' }
    ])
      expect(() => tunResourceReplaceRequest({ ...change, origin })).toThrow()
  })
  it.each([undefined, null, [], {}, { sessionId: '/private/foreign' }])(
    'rejects a missing or non-session read choice',
    (value) => {
      expect(() => tunResourceReadRequest(value)).toThrow()
    }
  )
})
