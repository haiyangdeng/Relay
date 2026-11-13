import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  defaultEditDocument,
  profileOverridesFor
} from '../../../../shared/relay/configuration-edit'
import { composeRuntimeConfiguration } from '../../../../main/relay/configuration/merge'
import { projectTunNetwork } from '../../../../main/relay/tun/projection'
import { tunSettingsFields, updateTunSettings, tunSettingsOverrideId } from './tun-settings-model'

const id = '11111111-1111-4111-8111-111111111111'
describe('TUN settings scoped override', () => {
  it('uses upstream defaults for omitted settings while preserving explicit false and empty lists', () => {
    expect(tunSettingsFields(undefined, true)).toMatchObject({
      stack: 'mixed',
      device: 'utun1500',
      mtu: 1500,
      autoRoute: true,
      autoDetect: true,
      dnsHijack: ['any:53']
    })
    expect(tunSettingsFields(undefined, false).dnsHijack).toEqual([])
    expect(
      tunSettingsFields(
        { 'auto-route': false, 'auto-detect-interface': false, 'dns-hijack': [] },
        true
      )
    ).toMatchObject({ autoRoute: false, autoDetect: false, dnsHijack: [] })
  })
  it('reads false values and changes only selected profile settings without enabling TUN', () => {
    const document = {
      ...defaultEditDocument(),
      globalOverrides: [
        {
          id: 'clash-import',
          kind: 'yaml' as const,
          content: 'tun:\n  enable: true\n  stack: mixed\n'
        }
      ],
      controlled: { dns: { enable: true } }
    }
    const before = structuredClone(document)
    const fields = tunSettingsFields({
      stack: 'system',
      device: 'utun1500',
      mtu: 9000,
      'auto-route': false,
      'strict-route': false,
      'dns-mode': 'native',
      'auto-detect-interface': true,
      'dns-hijack': ['any:53'],
      'route-exclude-address': ['192.168.0.0/16']
    })
    const saved = updateTunSettings(document, id, {
      ...fields,
      exclude: [' 192.168.0.0/16 ', ''],
      dnsHijack: ['any:53', ' udp://[::]:53 ', '']
    })
    expect(saved.globalOverrides).toEqual(before.globalOverrides)
    expect(saved.controlled).toEqual(before.controlled)
    expect(document).toEqual(before)
    const override = profileOverridesFor(saved, id)[0]
    const yaml = parse(override.content)
    expect(yaml.tun['auto-route']).toBe(false)
    expect(yaml.tun['dns-mode']).toBe('native')
    expect(yaml.tun).not.toHaveProperty('enable')
    expect(yaml.tun['route-exclude-address']).toEqual(['192.168.0.0/16'])
    expect(yaml.tun['dns-hijack']).toEqual(['any:53', 'udp://[::]:53'])
    const again = updateTunSettings(saved, id, { ...fields, mtu: 1500 })
    expect(
      profileOverridesFor(again, id).filter((row) => row.id === tunSettingsOverrideId)
    ).toHaveLength(1)
  })
  it('rejects malformed addresses or invalid ports without producing a document', () => {
    expect(() => tunSettingsFields({ 'auto-route': 'false' })).toThrow()
    expect(() => tunSettingsFields({ 'dns-hijack': [53] })).toThrow()
    expect(() => tunSettingsFields({ 'dns-mode': true })).toThrow()
    expect(() => tunSettingsFields({ 'dns-mode': 'invalid' })).toThrow()
    const fields = tunSettingsFields({})
    for (const patch of [
      { mtu: 0 },
      { mtu: 1279 },
      { dnsMode: 'unknown' },
      { stack: 'bad' },
      { device: '../bad' },
      { exclude: ['not a CIDR'] },
      { dnsHijack: ['any:70000'] }
    ])
      expect(() => updateTunSettings(defaultEditDocument(), id, { ...fields, ...patch })).toThrow()
  })
  it('retains native DNS restoration mode and allows explicitly disabling it', () => {
    expect(tunSettingsFields({}).dnsMode).toBe('disabled')
    const fields = tunSettingsFields({ 'dns-mode': 'hijack' })
    expect(fields.dnsMode).toBe('hijack')
    const saved = updateTunSettings(defaultEditDocument(), id, { ...fields, dnsMode: 'disabled' })
    expect(parse(profileOverridesFor(saved, id)[0].content).tun['dns-mode']).toBe('disabled')
  })
  it('projects saved DNS settings through the existing owned TUN resolver checks', async () => {
    const fields = {
      ...tunSettingsFields({}),
      autoRoute: true,
      autoDetect: true,
      dnsMode: 'native'
    }
    const document = updateTunSettings(defaultEditDocument(), id, fields)
    const input = {
      ...document,
      profileId: id,
      profileOverrides: profileOverridesFor(document, id),
      source: JSON.stringify({ tun: { enable: true }, dns: { enable: true }, ipv6: false })
    }
    const composed = await composeRuntimeConfiguration(input)
    expect(
      JSON.parse(projectTunNetwork(JSON.stringify(composed.configuration)).projection).resolver
        .servers
    ).toEqual([{ family: 'ipv4', value: '198.18.0.2' }])
    const invalid = await composeRuntimeConfiguration({
      ...input,
      source: JSON.stringify({ tun: { enable: true }, dns: { enable: false } })
    })
    expect(() => projectTunNetwork(JSON.stringify(invalid.configuration))).toThrow('明确启用DNS')
  })
})
