import { describe, expect, it } from 'vitest'
import { subStoreEvidence, subStoreProxy, subStoreSelection } from './substore'

describe('Sub-Store main-process request scope', () => {
  it('accepts a local proxy port without accepting URLs, paths or credentials', () => {
    expect(subStoreProxy({ proxyPort: 7890 })).toEqual({ proxyPort: 7890 })
    for (const input of [
      { proxyPort: '7890' },
      { proxyPort: 80 },
      { proxyPort: 7890, url: 'https://untrusted/' },
      null
    ])
      expect(() => subStoreProxy(input)).toThrow()
  })
  it('accepts only bounded subscription/collection names and one-use evidence ids', () => {
    expect(subStoreSelection({ kind: 'subscription', name: '订阅A' }).name).toBe('订阅A')
    expect(() => subStoreSelection({ kind: 'subscription', name: 'header\rinject' })).toThrow()
    expect(() => subStoreSelection({ kind: 'other', name: 'x' })).toThrow()
    expect(() => subStoreSelection({ kind: 'collection', name: 'x', path: '/secret' })).toThrow()
    expect(subStoreEvidence({ evidenceId: '12345678-1234-1234-1234-123456789012' })).toBeTruthy()
    expect(() => subStoreEvidence({ evidenceId: '../escape' })).toThrow()
  })
})
