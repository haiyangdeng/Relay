import { describe, expect, it } from 'vitest'
import {
  tunRuleProvidersReadRequest,
  tunRuleProviderReplaceRequest,
  tunRuleProviderName
} from './tun-rule-providers'

const sessionId = '00000000-0000-4000-8000-000000000001',
  request = () => ({
    sessionId,
    configurationRevision: 'a'.repeat(64),
    expectedGenerationSHA256: 'b'.repeat(64),
    provider: '私有规则',
    resource: { id: '00000000-0000-4000-8000-000000000002', sha256: 'c'.repeat(64) }
  })

describe('Current-owner rule-provider cache replacement boundary', () => {
  it('takes only a read session or a cloned exact current generation/cache selection', () => {
    expect(tunRuleProvidersReadRequest({ sessionId })).toEqual({ sessionId })
    const raw = request(),
      result = tunRuleProviderReplaceRequest(raw)
    raw.resource.sha256 = 'd'.repeat(64)
    expect(result.resource.sha256).toBe('c'.repeat(64))
    expect(result).toEqual({ ...request(), resource: { ...request().resource } })
  })
  it('rejects path, URL, process, grant, retry or adopt fields and unknown nested cache keys', () => {
    for (const key of [
      'path',
      'url',
      'pid',
      'grant',
      'force',
      'retry',
      'adopt',
      'declaredRuleCount'
    ]) {
      expect(() => tunRuleProvidersReadRequest({ sessionId, [key]: true })).toThrow()
      expect(() => tunRuleProviderReplaceRequest({ ...request(), [key]: true })).toThrow()
    }
    expect(() =>
      tunRuleProviderReplaceRequest({
        ...request(),
        resource: { ...request().resource, path: '/private' }
      })
    ).toThrow()
    expect(() =>
      tunRuleProviderReplaceRequest({ ...request(), expectedGenerationSHA256: 'B'.repeat(64) })
    ).toThrow()
  })
  it('preserves UTF-8 provider names but refuses byte overflow, delimiters and malformed text', () => {
    expect(tunRuleProviderName('规则 provider')).toBe('规则 provider')
    expect(tunRuleProviderName('x'.repeat(256))).toHaveLength(256)
    for (const name of ['', ' x', 'x ', 'x,y', 'x\n', 'x\u0085', '\ud800', '规'.repeat(86)])
      expect(() => tunRuleProviderName(name)).toThrow()
  })
})
