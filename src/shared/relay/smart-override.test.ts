import { runInNewContext } from 'vm'
import { describe, expect, it } from 'vitest'
import { defaultEditDocument, configurationEditDocument } from './configuration-edit'
import {
  SMART_OVERRIDE_ID,
  smartOverrideContent,
  smartOverrideTemplate,
  updateSmartOverride,
  type SmartOverrideSettings
} from './smart-override'

const settings: SmartOverrideSettings = {
  useLightGBM: false,
  collectData: false,
  collectorSizeMiB: 100,
  healthURL: 'http://127.0.0.1:19002/health'
}
const profileId = 'd0a5e2f1-6fef-43d3-9433-705ce3d73061'
function document() {
  return configurationEditDocument({
    ...defaultEditDocument(),
    globalOverrides: [{ id: 'ordinary', kind: 'yaml', content: 'ipv6: false' }],
    profileOverrideSets: [
      { profileId, overrides: [{ id: 'per-profile', kind: 'yaml', content: 'ipv6: true' }] }
    ],
    rulePatch: { append: ['MATCH,DIRECT'] },
    controlDns: false,
    controlled: { ipv6: false }
  })
}

describe('Smart override draft persistence contract', () => {
  it('adds one reserved Smart role while retaining other scopes, false values and source', () => {
    const original = document(),
      before = JSON.stringify(original),
      next = updateSmartOverride(original, settings)
    expect(JSON.stringify(original)).toBe(before)
    expect(next.globalOverrides[0]).toEqual(original.globalOverrides[0])
    expect(next.globalOverrides[1]).toMatchObject({
      id: SMART_OVERRIDE_ID,
      kind: 'js',
      role: 'smart'
    })
    expect(next.profileOverrideSets).toEqual(original.profileOverrideSets)
    expect(next.rulePatch).toEqual(original.rulePatch)
    expect(next.controlled).toEqual({ ipv6: false })
    expect(next.controlDns).toBe(false)
    expect(smartOverrideContent(JSON.parse(JSON.stringify(next)))).toBe(
      next.globalOverrides[1].content
    )
    expect(new TextEncoder().encode(next.globalOverrides[1].content).length).toBeLessThan(65536)
  })

  it('replaces only the reserved global item and restores it without discarding other edits', () => {
    const original = document(),
      first = updateSmartOverride(original, settings),
      second = updateSmartOverride(first, { ...settings, collectData: true }),
      removed = updateSmartOverride(second)
    expect(second.globalOverrides.filter((item) => item.id === SMART_OVERRIDE_ID)).toHaveLength(1)
    expect(smartOverrideContent(second)).not.toBe(smartOverrideContent(first))
    expect(removed).toEqual(original)
    expect(smartOverrideContent(removed)).toBeUndefined()
    expect(smartOverrideContent(first)).toBe(first.globalOverrides[1].content)
  })

  it.each([
    { useLightGBM: 'false' },
    { collectData: 0 },
    { collectorSizeMiB: 0 },
    { collectorSizeMiB: 1.5 },
    { collectorSizeMiB: Number.MAX_SAFE_INTEGER },
    { healthURL: '' },
    { healthURL: 'file:///tmp/health' },
    { healthURL: 'https://user:secret@example.com/check' },
    { healthURL: 'https://example.com/check#fragment' }
  ])('rejects invalid generation parameters before altering the document: %j', (invalid) => {
    const original = document(),
      before = JSON.stringify(original)
    expect(() =>
      smartOverrideTemplate({ ...settings, ...invalid } as SmartOverrideSettings)
    ).toThrow()
    expect(() =>
      updateSmartOverride(original, { ...settings, ...invalid } as SmartOverrideSettings)
    ).toThrow()
    expect(JSON.stringify(original)).toBe(before)
  })

  it('accepts upstream integer settings above the default without silently clamping', () => {
    expect(() =>
      updateSmartOverride(document(), { ...settings, collectorSizeMiB: 256 })
    ).not.toThrow()
  })
})

describe('Smart template rule and name compatibility', () => {
  const node = { name: 'A', type: 'socks5', server: '127.0.0.1', port: 19003 }
  const group = { name: 'Old', type: 'url-test', proxies: ['A'], url: settings.healthURL }
  const source = { proxies: [node], 'proxy-groups': [group], rules: ['MATCH,Old'] }
  const evaluate = (configuration: Record<string, unknown>): Record<string, unknown> => {
    // Portable pure-template regression. Actual bare Native worker and fixed
    // Smart parser are exercised separately by the private integration proof.
    const result: unknown = runInNewContext(
      smartOverrideTemplate(settings) + '\nmain(configuration)',
      {
        configuration: structuredClone(configuration),
        console: { log: () => undefined, error: () => undefined }
      },
      { timeout: 1000 }
    )
    return JSON.parse(JSON.stringify(result))
  }

  it('updates only actual policy positions in lowercase, logical and comma-containing regex rules', () => {
    const result = evaluate({
      ...source,
      rules: [
        'match,Old',
        'AND,((NETWORK,TCP),(DST-PORT,443)),Old',
        'DOMAIN-REGEX,^Old,(example|invalid)$,Old',
        'IP-CIDR,10.0.0.0/8,Old,no-resolve'
      ]
    })
    expect(result.rules).toEqual([
      'match,Old(Smart Group)',
      'AND,((NETWORK,TCP),(DST-PORT,443)),Old(Smart Group)',
      'DOMAIN-REGEX,^Old,(example|invalid)$,Old(Smart Group)',
      'IP-CIDR,10.0.0.0/8,Old(Smart Group),no-resolve'
    ])
  })

  it('preserves the SUB-RULE namespace while updating proxy targets inside its rule list', () => {
    const result = evaluate({
      ...source,
      rules: ['SUB-RULE,(NETWORK,TCP),Old'],
      'sub-rules': { Old: ['mAtCh,Old'] }
    })
    expect(result.rules).toEqual(['SUB-RULE,(NETWORK,TCP),Old'])
    expect(result['sub-rules']).toEqual({ Old: ['mAtCh,Old(Smart Group)'] })
  })

  it('avoids an occupied conversion name without replacing references to the existing group', () => {
    const result = evaluate({
      ...source,
      'proxy-groups': [group, { name: 'Old(Smart Group)', type: 'select', proxies: ['A'] }],
      rules: ['MATCH,Old', 'DOMAIN,existing.invalid,Old(Smart Group)']
    })
    expect(result.rules).toEqual([
      'MATCH,Old(Smart Group) (2)',
      'DOMAIN,existing.invalid,Old(Smart Group)'
    ])
    expect((result['proxy-groups'] as { name: string }[]).map((item) => item.name)).toEqual([
      'Old(Smart Group) (2)',
      'Old(Smart Group)'
    ])
  })

  it.each(['proxy', 'group'] as const)('avoids a preexisting %s named Smart Group', (kind) => {
    const result = evaluate({
      proxies: [{ ...node, name: kind === 'proxy' ? 'Smart Group' : 'A' }],
      'proxy-groups': [
        {
          name: kind === 'group' ? 'Smart Group' : 'Outer',
          type: 'select',
          proxies: [kind === 'proxy' ? 'Smart Group' : 'A']
        }
      ],
      rules: ['MATCH,' + (kind === 'group' ? 'Smart Group' : 'Outer')]
    })
    expect((result['proxy-groups'] as { name: string }[])[0].name).toBe('Smart Group (2)')
    expect(result.rules).toEqual(['MATCH,Smart Group (2)'])
  })

  it('keeps long non-BMP names within the existing name limit without splitting surrogate pairs', () => {
    const name = '😀'.repeat(128),
      result = evaluate({
        ...source,
        'proxy-groups': [{ ...group, name }],
        rules: ['MATCH,' + name]
      }),
      selected = (result['proxy-groups'] as { name: string }[])[0].name
    expect(selected.length).toBeLessThanOrEqual(256)
    expect(/\p{Surrogate}/u.test(selected)).toBe(false)
    expect(result.rules).toEqual(['MATCH,' + selected])
  })

  it('refuses preexisting duplicate namespaces instead of silently repairing an ambiguous source', () => {
    expect(() =>
      evaluate({ ...source, 'proxy-groups': [group, { ...group, type: 'select' }] })
    ).toThrow()
  })
})
