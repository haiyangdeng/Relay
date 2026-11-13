import { describe, expect, it } from 'vitest'
import { providerIP } from './probe-ip'

describe('Isolated IP result normalization', () => {
  it.each([
    [
      'ip.sb',
      {
        country: 'Example',
        country_code: 'us',
        city: 'City',
        asn: 64512,
        asn_organization: 'Organization',
        latitude: 0,
        longitude: -120
      }
    ],
    [
      'ipwho.is',
      {
        country: 'Example',
        country_code: 'us',
        city: 'City',
        connection: { asn: 64512, org: 'Organization' },
        latitude: 0,
        longitude: -120
      }
    ],
    [
      'ipapi.is',
      {
        location: {
          country: 'Example',
          country_code: 'us',
          city: 'City',
          latitude: 0,
          longitude: -120
        },
        asn: { asn: 'AS64512', org: 'Organization' }
      }
    ]
  ] as const)('retains supported %s fields including zero coordinates', (provider, fields) => {
    expect(providerIP(provider, { ip: '203.0.113.12', ...fields })).toMatchObject({
      ip: '203.0.113.12',
      country: 'Example',
      countryCode: 'US',
      city: 'City',
      asn: 'AS64512',
      organization: 'Organization',
      latitude: 0,
      longitude: -120
    })
  })
  it('does not turn invalid or absent optional values into displayed facts', () => {
    const result = providerIP('ip.sb', {
      ip: '2001:db8::1',
      country_code: 'us arbitrary-class',
      asn: 4294967296,
      latitude: Infinity,
      longitude: -181,
      country: 'bad\nvalue'
    })
    expect(result).toMatchObject({
      ip: '2001:db8::1',
      countryCode: undefined,
      asn: undefined,
      latitude: undefined,
      longitude: undefined,
      country: undefined
    })
    expect(providerIP('ip.sb', { ip: '203.0.113.12', asn: null }).asn).toBeUndefined()
  })
  it('rejects responses without an actual IP address', () => {
    expect(() => providerIP('ipwho.is', { ip: '<script>' })).toThrow('出口IP')
    expect(() => providerIP('ipapi.is', {})).toThrow('出口IP')
  })
})
