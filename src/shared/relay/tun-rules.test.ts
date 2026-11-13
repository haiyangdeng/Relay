import { describe, expect, it } from 'vitest'
import { tunRuleChangeRequest, tunRulesReadRequest } from './tun-rules'

const sessionId = '11111111-1111-4111-8111-111111111111'
const selection = {
  sessionId,
  configurationRevision: 'a'.repeat(64),
  rulesSHA256: 'b'.repeat(64),
  index: 0,
  disabled: false
}

describe('public TUN rule selections', () => {
  it('keeps exact session, first index and false without exposing private transaction fields', () => {
    expect(tunRulesReadRequest({ sessionId })).toEqual({ sessionId })
    expect(tunRuleChangeRequest(selection)).toEqual(selection)
    expect(tunRuleChangeRequest({ ...selection, index: 9999, disabled: true })).toEqual({
      ...selection,
      index: 9999,
      disabled: true
    })
  })
  it.each(['pid', 'socket', 'path', 'url', 'nonce', 'operationId', 'source', 'action'])(
    'rejects the extra %s transport/authority field before any service call',
    (field) => {
      expect(() => tunRulesReadRequest({ sessionId, [field]: 'PRIVATE' })).toThrow()
      expect(() => tunRuleChangeRequest({ ...selection, [field]: 'PRIVATE' })).toThrow()
    }
  )
  it.each(
    [undefined, null, [], {}, { sessionId: '../foreign' }, { sessionId: 123 }].map((value) => ({
      value
    }))
  )('rejects missing and malformed session selections %#', ({ value }) =>
    expect(() => tunRulesReadRequest(value)).toThrow()
  )
  it.each([
    { index: -1 },
    { index: 0.5 },
    { index: 10000 },
    { index: '0' },
    { index: NaN },
    { disabled: 'false' },
    { disabled: 0 },
    { configurationRevision: '' },
    { configurationRevision: 'A'.repeat(64) },
    { rulesSHA256: 'b'.repeat(63) },
    { sessionId: '../another-session' }
  ])('rejects invalid scalar contracts %#', (patch) => {
    expect(() => tunRuleChangeRequest({ ...selection, ...patch })).toThrow()
  })
})
