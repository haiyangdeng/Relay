import { describe, expect, it, vi } from 'vitest'
import { defaultEditDocument } from '../../../shared/relay/configuration-edit'
import type { GeoOriginRecord } from '../../../shared/relay/geo-origins'
import {
  geoDraft,
  readGeoSettings,
  geoFields,
  geoMode,
  geoModeDocument,
  geoModeRecord,
  geoSaveRequest
} from './relay-geo-config'
const record = (): GeoOriginRecord => ({
  info: {
    id: '11111111-1111-4111-8111-111111111111',
    revision: 'a'.repeat(64),
    originRevision: 'b'.repeat(64),
    descriptor: {
      name: 'Custom DB',
      kind: 'country-mmdb',
      behavior: null,
      selector: 'custom-country'
    },
    origin: 'https://geo.invalid',
    proxyPort: 18191,
    hasPrivateHeaders: true,
    expectedSHA256: '',
    autoIntent: { requested: false, schedule: { kind: 'cron', expression: '0 2 * * *' } },
    createdAt: '2026-11-02T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z'
  },
  definition: {
    descriptor: {
      name: 'Custom DB',
      kind: 'country-mmdb',
      behavior: null,
      selector: 'custom-country'
    },
    source: {
      kind: 'http',
      url: 'https://geo.invalid/PRIVATE?token=PRIVATE',
      proxyPort: 18191,
      headers: { authorization: 'PRIVATE', 'x-custom': 'keep' }
    },
    expectedSHA256: '',
    autoIntent: { requested: false, schedule: { kind: 'cron', expression: '0 2 * * *' } }
  }
})
describe('GeoData controlled projection and original defaults', () => {
  it('preserves inherit and explicit false, with all unrelated scopes unchanged', () => {
    const base = defaultEditDocument()
    base.controlled = {
      ipv6: false,
      dns: { enable: false },
      sniffer: { enable: false },
      'tcp-concurrent': false
    }
    base.controlSniff = false
    base.confirmedDnsFingerprint = 'f'.repeat(64)
    expect(geoMode(base)).toBe('inherit')
    const db = geoModeDocument(base, 'db')
    expect(db.controlled['geodata-mode']).toBe(false)
    expect(geoMode(db)).toBe('db')
    expect(base.controlled).not.toHaveProperty('geodata-mode')
    const dat = geoModeDocument(db, 'dat')
    expect(dat.controlled['geodata-mode']).toBe(true)
    expect(geoModeDocument(dat, 'inherit')).toEqual(base)
    expect(
      geoModeRecord({ document: db, revision: 'a'.repeat(64), exists: true }).document
    ).toEqual(db)
  })
  it('refuses an unsupported persisted controlled mode instead of silently resetting to DB', () => {
    const base = defaultEditDocument()
    expect(() =>
      geoModeRecord({
        document: { ...base, controlled: { 'geodata-mode': 'future' } },
        revision: 'a'.repeat(64),
        exists: true
      } as never)
    ).toThrow()
  })
  it('reuses exactly the four original known default URLs only for an explicit new draft', () => {
    expect(geoFields).toHaveLength(4)
    for (const field of geoFields) {
      const draft = geoDraft(field.kind)
      expect(draft.url).toBe(field.url)
      expect(draft.requested).toBe(false)
      expect(draft.hours).toBe('24')
      const request = geoSaveRequest(field.kind, draft)
      expect(request.origin).toBeNull()
      expect(request.definition.autoIntent.requested).toBe(false)
      expect(Object.keys(request).sort()).toEqual(['definition', 'origin'])
    }
  })
  it('keeps custom selector/name/private headers and cron when hours are untouched', () => {
    const source = record(),
      draft = geoDraft('country-mmdb', source)
    expect(draft.name).toBe('Custom DB')
    expect(draft.selector).toBe('custom-country')
    expect(draft.hours).toBe('')
    const request = geoSaveRequest('country-mmdb', { ...draft, requested: true }, source.info)
    expect(request.origin).toEqual({ id: source.info.id, revision: source.info.revision })
    expect(request.definition).toEqual({
      ...source.definition,
      autoIntent: { requested: true, schedule: source.definition.autoIntent.schedule }
    })
  })
  it('converts only explicitly edited hours to integer minutes and preserves requested false', () => {
    const source = record(),
      draft = { ...geoDraft('country-mmdb', source), hours: '0.5', hoursChanged: true }
    expect(geoSaveRequest('country-mmdb', draft, source.info).definition.autoIntent).toEqual({
      requested: false,
      schedule: { kind: 'interval', minutes: 30 }
    })
  })
  it.each(['', '0', '-1', '0.001', '10000'])(
    'rejects invalid edited hours %s before IPC construction',
    (hours) => {
      expect(() =>
        geoSaveRequest('geoip-dat', { ...geoDraft('geoip-dat'), hours, hoursChanged: true })
      ).toThrow('小时周期')
    }
  )
  it('rejects malformed private detail without adopting its revision or resetting existing data', () => {
    const source = record()
    expect(() =>
      geoDraft('country-mmdb', {
        ...source,
        definition: {
          ...source.definition,
          source: { ...source.definition.source, headers: { authorization: 5 } }
        }
      } as never)
    ).toThrow()
    expect(() => geoDraft('geoip-dat', source)).toThrow()
    expect(source.definition.source.headers.authorization).toBe('PRIVATE')
  })
  it.each([
    { port: '0' },
    { port: '7890x' },
    { url: 'file:///private/data' },
    { url: 'https://name:secret@geo.invalid/x' },
    { headers: '[]' },
    { expectedSHA256: 'A'.repeat(64) }
  ])('validates explicit source fields before a save request %#', (patch) => {
    expect(() => geoSaveRequest('geoip-dat', { ...geoDraft('geoip-dat'), ...patch })).toThrow()
  })
})

it('preserves a prototype-named own header for authoritative Main rejection instead of silently discarding it', () => {
  const draft = geoDraft('country-mmdb')
  draft.headers = '{"__proto__":"SYNTHETIC_PRIVATE"}'
  const headers = geoSaveRequest('country-mmdb', draft).definition.source.headers
  expect(Object.keys(headers)).toEqual(['__proto__'])
  expect(Object.getOwnPropertyDescriptor(headers, '__proto__')?.value).toBe('SYNTHETIC_PRIVATE')
  expect(Object.getPrototypeOf(headers)).toBe(Object.prototype)
})

describe('saved database settings read', () => {
  it('reads stored URLs through only readonly IPC without changing header or schedule values', async () => {
    const saved = record(),
      before = structuredClone(saved)
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'relayGeoOriginList')
        return { origins: [saved.info], incomplete: 0, warnings: [] }
      if (channel === 'relayGeoOriginRead') return saved
      throw new Error('Unexpected mutation')
    })
    const result = await readGeoSettings(invoke)
    expect(result.urls).toEqual({ 'country-mmdb': saved.definition.source.url })
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'relayGeoOriginList',
      'relayGeoOriginRead'
    ])
    expect(saved).toEqual(before)
    expect(JSON.stringify(result)).not.toContain('authorization')
  })
  it('does not accept a changed revision or partial inventory as current settings', async () => {
    const saved = record()
    const invoke = vi.fn(async (channel: string) =>
      channel === 'relayGeoOriginList'
        ? { origins: [saved.info], incomplete: 0, warnings: [] }
        : { ...saved, info: { ...saved.info, revision: 'c'.repeat(64) } }
    )
    await expect(readGeoSettings(invoke)).rejects.toThrow('版本已变化')
    expect(invoke).toHaveBeenCalledTimes(2)
    const incomplete = vi.fn(async () => ({ origins: [], incomplete: 1, warnings: [] }))
    await expect(readGeoSettings(incomplete)).rejects.toThrow('未完整读取')
    expect(incomplete).toHaveBeenCalledTimes(1)
  })
})
