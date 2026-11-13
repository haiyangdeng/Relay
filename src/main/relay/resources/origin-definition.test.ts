import { describe, expect, it } from 'vitest'
import { geoOriginSelection, geoResourceKinds } from '../../../shared/relay/geo-origins'
import { geoOriginDefinition, geoOriginSaveRequest } from './origin-definition'

const id = '11111111-1111-4111-8111-111111111111',
  revision = 'a'.repeat(64),
  definition = () => ({
    descriptor: { name: 'GeoSite', kind: 'geosite-dat', behavior: null, selector: 'CN' },
    source: {
      kind: 'http',
      url: 'https://EXAMPLE.invalid/private/data.dat?token=PRIVATE',
      proxyPort: 18191,
      headers: { Authorization: 'Bearer PRIVATE', 'User-Agent': 'Relay fixture' }
    },
    expectedSHA256: '',
    autoIntent: { requested: false, schedule: { kind: 'interval', minutes: 1440 } }
  })

describe('private Geo origin definition contract', () => {
  it('binds selectors to the Native/Core UTF-8 byte and control-character contract', () => {
    const input = definition(),
      select = (selector: string) => ({ ...input, descriptor: { ...input.descriptor, selector } })
    expect(geoOriginDefinition(select('中'.repeat(85) + 'a')).descriptor.selector).toBe(
      '中'.repeat(85) + 'a'
    )
    for (const selector of ['中'.repeat(86), 'a'.repeat(257), 'CN\u0085', '\ud800'])
      expect(() => geoOriginDefinition(select(selector))).toThrow()
  })
  it('round-trips normalized private details and explicit false without creating authority', () => {
    const input = definition(),
      value = geoOriginDefinition(input)
    expect(value.source.url).toBe('https://example.invalid/private/data.dat?token=PRIVATE')
    expect(value.source.headers).toEqual({
      authorization: 'Bearer PRIVATE',
      'user-agent': 'Relay fixture'
    })
    expect(value.autoIntent.requested).toBe(false)
    expect(geoOriginDefinition(value)).toEqual(value)
    expect(Object.keys(value).sort()).toEqual([
      'autoIntent',
      'descriptor',
      'expectedSHA256',
      'source'
    ])
    expect(input.source.headers).toHaveProperty('Authorization')
  })
  it.each(geoResourceKinds)('accepts the existing %s descriptor and keeps its selector', (kind) => {
    const input = definition()
    expect(
      geoOriginDefinition({ ...input, descriptor: { ...input.descriptor, kind } }).descriptor
    ).toEqual({ ...input.descriptor, kind })
  })
  it.each(['rule-yaml', 'rule-text', 'rule-mrs', 'runtime-file'])(
    'does not turn %s into a generic resource source',
    (kind) => {
      const input = definition()
      expect(() =>
        geoOriginDefinition({
          ...input,
          descriptor: {
            ...input.descriptor,
            kind,
            behavior: kind.startsWith('rule-') ? 'domain' : null,
            selector: ''
          }
        })
      ).toThrow()
    }
  )
  it.each(['grant', 'active', 'pid', 'path', 'receipt'])(
    'rejects extra persisted authority %s',
    (key) => {
      expect(() => geoOriginDefinition({ ...definition(), [key]: 'not-authority' })).toThrow()
    }
  )
  it.each(['host', 'proxy-authorization', 'range', 'if-none-match', 'if-modified-since'])(
    'rejects unsupported request header %s',
    (key) => {
      const input = definition()
      expect(() =>
        geoOriginDefinition({ ...input, source: { ...input.source, headers: { [key]: 'x' } } })
      ).toThrow()
    }
  )
  it('rejects decoded header collisions and non-string values', () => {
    const input = definition()
    for (const headers of [
      { Authorization: 'a', authorization: 'b' },
      { x: false },
      { x: 'a\r\nb' }
    ])
      expect(() =>
        geoOriginDefinition({ ...input, source: { ...input.source, headers } })
      ).toThrow()
  })
  it.each([
    'file:///private/data.dat',
    'https://user:secret@example.invalid/data',
    'https://example.invalid/data#fragment',
    ' https://example.invalid/data'
  ])('reuses the bounded HTTP URL restriction for %s', (url) => {
    const input = definition()
    expect(() => geoOriginDefinition({ ...input, source: { ...input.source, url } })).toThrow()
  })
  it('rejects URLs that expand beyond the saved-record read budget when canonicalized', () => {
    const input = definition()
    expect(() =>
      geoOriginDefinition({
        ...input,
        source: {
          ...input.source,
          url: 'https://example.invalid/' + '中'.repeat(1000)
        }
      })
    ).toThrow('规范化')
  })
  it('retains valid requested intent but never accepts a manual automatic schedule or string booleans', () => {
    const input = definition()
    expect(
      geoOriginDefinition({ ...input, autoIntent: { ...input.autoIntent, requested: true } })
        .autoIntent
    ).toEqual({ requested: true, schedule: { kind: 'interval', minutes: 1440 } })
    for (const autoIntent of [
      { requested: true, schedule: { kind: 'manual' } },
      { requested: 'false', schedule: { kind: 'manual' } },
      { requested: false, schedule: { kind: 'interval', minutes: 0 } },
      { requested: false, schedule: { kind: 'interval', minutes: 1440 }, grant: 'stale' }
    ])
      expect(() => geoOriginDefinition({ ...input, autoIntent })).toThrow()
  })
  it('retains a manual disabled intent and valid cron through the existing schedule decoder', () => {
    const input = definition()
    for (const schedule of [{ kind: 'manual' }, { kind: 'cron', expression: '0 1 * * *' }])
      expect(
        geoOriginDefinition({ ...input, autoIntent: { requested: false, schedule } }).autoIntent
      ).toEqual({ requested: false, schedule })
  })
  it('preserves strict hash and exact HTTP source fields', () => {
    const input = definition()
    expect(geoOriginDefinition({ ...input, expectedSHA256: revision }).expectedSHA256).toBe(
      revision
    )
    for (const expectedSHA256 of ['A'.repeat(64), 'a'.repeat(63), null, false])
      expect(() => geoOriginDefinition({ ...input, expectedSHA256 })).toThrow()
    for (const source of [
      { ...input.source, kind: 'file' },
      { ...input.source, path: '/private/foreign' }
    ])
      expect(() => geoOriginDefinition({ ...input, source })).toThrow()
  })
  it('separates exact create and selected CAS save without accepting a caller-supplied head', () => {
    expect(geoOriginSaveRequest({ origin: null, definition: definition() }).origin).toBeNull()
    expect(
      geoOriginSaveRequest({ origin: { id, revision }, definition: definition() }).origin
    ).toEqual({ id, revision })
    expect(geoOriginSelection({ id, revision })).toEqual({ id, revision })
    for (const origin of [undefined, { id, revision, head: {} }, { id, revision: '' }])
      expect(() => geoOriginSaveRequest({ origin, definition: definition() })).toThrow()
    expect(() =>
      geoOriginSaveRequest({ origin: null, definition: definition(), head: {} })
    ).toThrow()
  })
})
