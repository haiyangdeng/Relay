import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  defaultEditDocument,
  profileOverridesFor
} from '../../../../shared/relay/configuration-edit'
import { composeRuntimeConfiguration } from '../../../../main/relay/configuration/merge'
import { localProxyConfiguration } from '../../../../main/relay/core/local-proxy-runtime'
import { ownedCoreConfiguration } from '../../../../main/relay/core/owned-runtime'
import {
  coreSettingsFields,
  updateCoreSettings,
  coreSettingsOverrideId
} from './core-settings-model'

const profileId = '11111111-1111-4111-8111-111111111111'
const otherProfileId = '22222222-2222-4222-8222-222222222222'
describe('core settings edit to owned runtime', () => {
  it('preserves unrelated edits and selected profile scope, including explicit false', () => {
    const initial = {
      ...defaultEditDocument(),
      globalOverrides: [{ id: 'imported-global', kind: 'yaml' as const, content: 'mode: rule' }],
      controlled: { dns: { enable: true }, sniffer: { enable: true } },
      profileOverrideSets: [
        {
          profileId: otherProfileId,
          overrides: [{ id: 'other', kind: 'yaml' as const, content: 'ipv6: true' }]
        }
      ]
    }
    const before = structuredClone(initial)
    const fields = coreSettingsFields({
      ipv6: false,
      'tcp-concurrent': false,
      'unified-delay': true,
      'find-process-mode': 'strict'
    })
    const result = updateCoreSettings(initial, profileId, fields)
    expect(initial).toEqual(before)
    expect(result.globalOverrides).toEqual(before.globalOverrides)
    expect(result.controlled).toEqual({
      ...before.controlled,
      ipv6: false,
      'tcp-concurrent': false
    })
    expect(profileOverridesFor(result, otherProfileId)).toEqual(
      before.profileOverrideSets[0].overrides
    )
    expect(parse(profileOverridesFor(result, profileId)[0].content)).toEqual({
      'unified-delay': true,
      'find-process-mode': 'strict'
    })
    const repeated = updateCoreSettings(result, profileId, { ...fields, unifiedDelay: false })
    expect(
      profileOverridesFor(repeated, profileId).filter(
        (entry) => entry.id === coreSettingsOverrideId
      )
    ).toHaveLength(1)
  })
  it('keeps saved common options through compose, HTTP compile and owned runtime validation', async () => {
    const saved = updateCoreSettings(defaultEditDocument(), profileId, {
      ipv6: true,
      tcpConcurrent: true,
      unifiedDelay: true,
      findProcessMode: 'strict'
    })
    const composed = await composeRuntimeConfiguration({
      ...saved,
      profileId,
      profileOverrides: profileOverridesFor(saved, profileId),
      source: JSON.stringify({
        proxies: [{ name: 'A', type: 'http', server: '127.0.0.1', port: 1 }],
        'proxy-groups': [{ name: 'G', type: 'select', proxies: ['A'] }],
        rules: ['MATCH,G'],
        dns: { enable: true, nameserver: ['1.1.1.1'] },
        'unified-delay': false,
        'find-process-mode': 'off',
        tun: { enable: true },
        'mixed-port': 7890
      })
    })
    const built = localProxyConfiguration(JSON.stringify(composed.configuration), 18191, 'profile')
    const runtime = ownedCoreConfiguration(built.configuration, 'localProxy').parsed
    expect(runtime).toMatchObject({
      ipv6: true,
      'tcp-concurrent': true,
      'unified-delay': true,
      'find-process-mode': 'strict',
      port: 18191,
      tun: { enable: false }
    })
    expect(runtime['mixed-port']).toBe(0)
  })
  it('rejects unsupported booleans and process modes rather than silently coercing imported data', () => {
    expect(() => coreSettingsFields({ ipv6: 'false' })).toThrow()
    expect(() => coreSettingsFields({ 'find-process-mode': 'unknown' })).toThrow()
    expect(coreSettingsFields({})).toEqual({
      ipv6: false,
      tcpConcurrent: false,
      unifiedDelay: false,
      findProcessMode: 'off'
    })
  })
})
