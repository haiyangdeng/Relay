import { describe, expect, it } from 'vitest'
import {
  configurationEditDocument,
  defaultEditDocument,
  profileOverridesFor,
  profileRulePatchFor,
  updateProfileOverrides
} from './configuration-edit'

describe('configuration edit document validation', () => {
  it('isolates source rule patches, clones selections and rejects unknown, repeated or oversized scopes', () => {
    const id = '00000000-0000-0000-0000-000000000001',
      set = { profileId: id, rulePatch: { prepend: ['DOMAIN,legacy.test,REJECT'] } },
      doc = configurationEditDocument({ ...defaultEditDocument(), profileRulePatchSets: [set] })
    expect(profileRulePatchFor(doc, id)).toEqual(set.rulePatch)
    expect(profileRulePatchFor(doc, '00000000-0000-0000-0000-000000000002')).toBeUndefined()
    const selected = profileRulePatchFor(doc, id)
    selected?.prepend?.push('MATCH,REJECT')
    expect(doc.profileRulePatchSets?.[0].rulePatch.prepend).toHaveLength(1)
    for (const sets of [
      [set, set],
      [{ ...set, extra: true }],
      [{ ...set, profileId: 'legacy' }],
      [{ ...set, rulePatch: { prepend: [1] } }],
      Array(101).fill(set)
    ])
      expect(() =>
        configurationEditDocument({ ...defaultEditDocument(), profileRulePatchSets: sets })
      ).toThrow()
    expect(updateProfileOverrides(doc, id, []).profileRulePatchSets).toEqual(
      doc.profileRulePatchSets
    )
  })
  it('accepts a document with a global YAML override and a rule patch', () => {
    const doc = configurationEditDocument({
      globalOverrides: [{ id: 'sniff-on', kind: 'yaml', content: 'sniffer:\n  enable: true\n' }],
      profileOverrides: [],
      rulePatch: { prepend: ['DOMAIN,example.com,NodeA'] },
      controlled: { sniffer: { enable: true, 'override-destination': false } },
      controlSniff: true
    })
    expect(doc.globalOverrides).toHaveLength(1)
    expect(doc.globalOverrides[0].kind).toBe('yaml')
    expect(doc.rulePatch?.prepend).toEqual(['DOMAIN,example.com,NodeA'])
    expect(doc.controlSniff).toBe(true)
    expect(doc.controlled.sniffer).toEqual({ enable: true, 'override-destination': false })
  })
  it('accepts a JS override with a smart role', () => {
    const doc = configurationEditDocument({
      globalOverrides: [{ id: 'smart', kind: 'js', content: 'module.exports={}', role: 'smart' }],
      profileOverrides: [],
      controlled: {}
    })
    expect(doc.globalOverrides[0].role).toBe('smart')
  })
  it('rejects an override with an unknown field', () => {
    expect(() =>
      configurationEditDocument({
        globalOverrides: [{ id: 'x', kind: 'yaml', content: '', evil: true }],
        profileOverrides: [],
        controlled: {}
      })
    ).toThrow()
  })
  it('rejects a rule patch with non-string entries', () => {
    expect(() =>
      configurationEditDocument({
        globalOverrides: [],
        profileOverrides: [],
        rulePatch: { prepend: [1] },
        controlled: {}
      })
    ).toThrow()
  })
  it('rejects a controlled edit with an unknown top-level key', () => {
    expect(() =>
      configurationEditDocument({
        globalOverrides: [],
        profileOverrides: [],
        controlled: { 'evil-field': true }
      })
    ).toThrow()
  })
  it('rejects a sniffer edit with an unknown field', () => {
    expect(() =>
      configurationEditDocument({
        globalOverrides: [],
        profileOverrides: [],
        controlled: { sniffer: { 'evil-sniff': true } }
      })
    ).toThrow()
  })
  it('rejects an invalid DNS fingerprint', () => {
    expect(() =>
      configurationEditDocument({
        globalOverrides: [],
        profileOverrides: [],
        controlled: {},
        confirmedDnsFingerprint: 'not-a-hash'
      })
    ).toThrow()
  })
  it('rejects more than 200 overrides', () => {
    const items = Array.from({ length: 201 }, (_, i) => ({
      id: 'o' + i,
      kind: 'yaml' as const,
      content: 'a: 1'
    }))
    expect(() =>
      configurationEditDocument({ globalOverrides: items, profileOverrides: [], controlled: {} })
    ).toThrow()
  })
  it('default document is empty', () => {
    const d = defaultEditDocument()
    expect(d.globalOverrides).toHaveLength(0)
    expect(d.controlled).toEqual({})
  })
})

describe('Multiple source override library', () => {
  const first = '00000000-0000-0000-0000-000000000001'
  const second = '00000000-0000-0000-0000-000000000002'
  const override = { id: 'source-only', kind: 'yaml' as const, content: 'sniffer:\n  enable: true' }
  it('keeps legacy documents identical and allows independent lists using the same local override ID', () => {
    const legacy = { ...defaultEditDocument(), profileId: first, profileOverrides: [override] }
    expect(configurationEditDocument(legacy)).toEqual(legacy)
    const doc = configurationEditDocument({
      ...legacy,
      profileOverrideSets: [
        { profileId: second, overrides: [{ ...override, content: 'ipv6: false' }] }
      ]
    })
    expect(profileOverridesFor(doc, first)).toEqual([override])
    expect(profileOverridesFor(doc, second)[0].content).toBe('ipv6: false')
    expect(profileOverridesFor(doc, '00000000-0000-0000-0000-000000000003')).toEqual([])
    const copy = profileOverridesFor(doc, first)
    copy[0].content = 'changed outside'
    expect(doc.profileOverrides[0].content).toBe(override.content)
  })
  it('rejects duplicate scopes, legacy conflicts, invalid IDs and unknown fields', () => {
    for (const sets of [
      [
        { profileId: first, overrides: [] },
        { profileId: first, overrides: [] }
      ],
      [{ profileId: first, overrides: [override] }],
      [{ profileId: 'not-a-source', overrides: [] }],
      [{ profileId: second, overrides: [], unrecognized: true }],
      [{ profileId: second, overrides: [{ ...override, kind: 'unknown' }] }]
    ])
      expect(() =>
        configurationEditDocument({
          ...defaultEditDocument(),
          profileId: first,
          profileOverrides: [override],
          profileOverrideSets: sets
        })
      ).toThrow()
  })
  it('bounds source count and total overrides across global, legacy and all library entries', () => {
    expect(() =>
      configurationEditDocument({
        ...defaultEditDocument(),
        profileOverrideSets: Array.from({ length: 101 }, () => ({
          profileId: first,
          overrides: []
        }))
      })
    ).toThrow('100')
    expect(() =>
      configurationEditDocument({
        ...defaultEditDocument(),
        globalOverrides: [override],
        profileOverrideSets: [
          { profileId: first, overrides: Array.from({ length: 200 }, () => override) }
        ]
      })
    ).toThrow('过多')
  })
  it('edits and removes only the selected source while explicitly migrating that legacy binding', () => {
    const legacy = {
      ...defaultEditDocument(),
      profileId: first,
      profileOverrides: [override],
      rulePatch: { prepend: ['MATCH,DIRECT'] },
      controlled: { sniffer: { enable: false } }
    }
    const withSecond = updateProfileOverrides(legacy, second, [
      { ...override, content: 'ipv6: false' }
    ])
    expect(withSecond.profileOverrides).toEqual([override])
    expect(withSecond.profileId).toBe(first)
    const withBoth = updateProfileOverrides(withSecond, first, [
      { ...override, content: 'sniffer:\n  enable: false' }
    ])
    expect(withBoth.profileId).toBeUndefined()
    expect(withBoth.profileOverrides).toEqual([])
    expect(withBoth.profileOverrideSets).toHaveLength(2)
    expect(profileOverridesFor(withBoth, second)).toEqual(profileOverridesFor(withSecond, second))
    const removed = updateProfileOverrides(withBoth, first, [])
    expect(profileOverridesFor(removed, first)).toEqual([])
    expect(profileOverridesFor(removed, second)).toEqual(profileOverridesFor(withBoth, second))
    expect(removed.rulePatch).toEqual(legacy.rulePatch)
    expect(removed.controlled).toEqual(legacy.controlled)
    expect(legacy.profileId).toBe(first)
    expect(() => updateProfileOverrides(removed, '../other', [])).toThrow('来源ID')
    expect(() => updateProfileOverrides(removed, first, {})).toThrow('数组')
  })
})

describe('Fixed sniffer schema and profile scope', () => {
  it('accepts the fixed core destination field and protocol port lists', () => {
    expect(
      configurationEditDocument({
        ...defaultEditDocument(),
        controlled: {
          sniffer: {
            enable: true,
            'override-destination': false,
            sniff: { TLS: { ports: ['443', '8000-9000'] } }
          }
        }
      }).controlled.sniffer
    ).toMatchObject({ 'override-destination': false })
  })
  it('refuses invalid sniffer boolean, list and protocol fields', () => {
    for (const sniffer of [
      { enable: 'true' },
      { 'skip-domain': 'example.com' },
      { sniff: { TCP: {} } },
      { sniff: { TLS: { ports: [443] } } },
      { 'override-dest': true }
    ])
      expect(() =>
        configurationEditDocument({ ...defaultEditDocument(), controlled: { sniffer } })
      ).toThrow()
  })
  it('requires a bound source for profile overrides instead of applying them to every profile', () => {
    const profileOverrides = [{ id: 'local', kind: 'yaml', content: 'ipv6: false' }]
    expect(() => configurationEditDocument({ ...defaultEditDocument(), profileOverrides })).toThrow(
      '来源ID'
    )
    expect(
      configurationEditDocument({
        ...defaultEditDocument(),
        profileId: '00000000-0000-0000-0000-000000000001',
        profileOverrides
      }).profileOverrides
    ).toHaveLength(1)
  })
})
