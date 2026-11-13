import { describe, expect, it } from 'vitest'
import { localProxyAction } from './local-proxy'

const instanceId = '11111111-1111-4111-8111-111111111111'
const request = {
  action: 'rule',
  instanceId,
  configurationRevision: 'a'.repeat(64),
  rulesSHA256: 'b'.repeat(64),
  index: 0,
  disabled: false
}
describe('Exact owned rule actions', () => {
  it('keeps explicit false and accepts only the two fixed read/write shapes', () => {
    expect(localProxyAction({ action: 'rules', instanceId })).toEqual({
      action: 'rules',
      instanceId
    })
    expect(localProxyAction(request)).toEqual(request)
    expect(localProxyAction({ action: 'refresh', instanceId })).toEqual({
      action: 'refresh',
      instanceId
    })
  })
  it.each([
    { ...request, action: new String('rule') },
    { ...request, disabled: new Boolean(false) },
    { ...request, disabled: 'false' },
    { ...request, index: -1 },
    { ...request, index: 0.5 },
    { ...request, index: 10000 },
    { ...request, index: new Number(0) },
    { ...request, rulesSHA256: 'b'.repeat(63) },
    { ...request, configurationRevision: undefined },
    { ...request, socket: '/PRIVATE' },
    { ...request, path: '/rules/disable' },
    { action: 'rules', instanceId, index: 0 }
  ])('rejects coercion, stale/unbounded identities and extra capabilities: %j', (raw) => {
    expect(() => localProxyAction(raw)).toThrow()
  })
})
