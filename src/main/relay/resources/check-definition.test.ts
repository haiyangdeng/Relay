import { zstdCompressSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { resourceDescriptor } from '../../../shared/relay/resources'
import { resourceHash } from './source'
import { resourceCheckDefinition, resourceRuleEntries } from './check-definition'

const d = { name: 'Fixture', kind: 'rule-yaml' as const, behavior: 'domain' as const, selector: '' }
describe('Resource check boundaries and counts', () => {
  it('uses fixed local filenames, no traffic listeners and empty dependency download URLs', () => {
    for (const [kind, file] of [
      ['rule-yaml', 'resource.bin'],
      ['geoip-dat', 'GeoIP.dat'],
      ['geosite-dat', 'GeoSite.dat'],
      ['country-mmdb', 'Country.mmdb'],
      ['asn-mmdb', 'ASN.mmdb']
    ] as const) {
      const result = resourceCheckDefinition({
        ...d,
        kind,
        behavior: kind.startsWith('rule-') ? 'domain' : null,
        selector: kind.startsWith('rule-') ? '' : 'CN'
      })
      expect(result.filename).toBe(file)
      expect(result.configuration.port).toBe(0)
      expect(result.configuration.dns).toEqual({ enable: false })
      expect(result.configuration.tun).toEqual({ enable: false })
      expect(result.configuration['geox-url']).toEqual({
        geoip: '',
        geosite: '',
        mmdb: '',
        asn: ''
      })
    }
    expect(() => resourceDescriptor({ ...d, path: '/PRIVATE' })).toThrow()
    expect(() => resourceDescriptor({ ...d, kind: 'rule-mrs', behavior: 'classical' })).toThrow()
    expect(() =>
      resourceDescriptor({ ...d, kind: 'geosite-dat', behavior: null, selector: 'CN,REJECT\n' })
    ).toThrow()
  })
  it('counts all YAML/text entries and separates unresolved geographical dependencies', () => {
    const bytes = Buffer.from('payload:\n  - +.fixture.invalid\n  - second.invalid\n')
    expect(resourceRuleEntries({ descriptor: d, bytes, sha256: resourceHash(bytes) })).toEqual({
      expected: 2,
      needsDependencies: false
    })
    const classical = Buffer.from('#comment\n//comment\nDOMAIN,fixture.invalid\nGEOSITE,CN\n')
    expect(
      resourceRuleEntries({
        descriptor: { ...d, kind: 'rule-text', behavior: 'classical' },
        bytes: classical,
        sha256: resourceHash(classical)
      })
    ).toEqual({ expected: 2, needsDependencies: true })
    for (const text of [
      'payload: [1]',
      'payload: [fixture.invalid]\nunknown: value',
      'payload: &items [fixture.invalid]\nrules: *items'
    ]) {
      const bytes = Buffer.from(text)
      expect(() =>
        resourceRuleEntries({ descriptor: d, bytes, sha256: resourceHash(bytes) })
      ).toThrow()
    }
  })
  it.each(['rule-text', 'rule-yaml'] as const)(
    'classifies mixed-case classical %s dependencies without rewriting cached rules',
    (kind) => {
      const rules = ['ip-asn,64512', 'sRc-iP-aSn,64512', 'geoip,CN', 'gEoSiTe,CN'],
        source = kind === 'rule-text' ? rules.join('\n') : JSON.stringify({ payload: rules }),
        bytes = Buffer.from(source),
        job = {
          descriptor: { ...d, kind, behavior: 'classical' as const },
          bytes,
          sha256: resourceHash(bytes)
        }
      expect(resourceRuleEntries(job, true)).toEqual({
        expected: rules.length,
        needsDependencies: true,
        entries: rules
      })
      expect(
        resourceRuleEntries({ ...job, descriptor: { ...job.descriptor, behavior: 'domain' } })
          .needsDependencies
      ).toBe(false)
      expect(bytes.toString()).toBe(source)
    }
  )
  it('prechecks MRS behavior, declared counts and extra allocation length before running native code', () => {
    const plain = Buffer.alloc(63)
    Buffer.from([77, 82, 83, 1]).copy(plain)
    plain[4] = 0
    plain.writeBigInt64BE(2n, 5)
    plain[21] = 1
    plain.writeBigInt64BE(1n, 22)
    plain.writeBigInt64BE(1n, 38)
    plain.writeBigInt64BE(1n, 54)
    plain[62] = 97
    let bytes = zstdCompressSync(plain)
    expect(
      resourceRuleEntries({
        descriptor: { ...d, kind: 'rule-mrs' },
        bytes,
        sha256: resourceHash(bytes)
      })
    ).toMatchObject({ expected: 2 })
    plain.writeBigInt64BE(1n << 50n, 13)
    bytes = zstdCompressSync(plain)
    expect(() =>
      resourceRuleEntries({
        descriptor: { ...d, kind: 'rule-mrs' },
        bytes,
        sha256: resourceHash(bytes)
      })
    ).toThrow('长度')
    expect(() =>
      resourceRuleEntries({ descriptor: d, bytes: Buffer.from('changed'), sha256: '0'.repeat(64) })
    ).toThrow('摘要')
  })
})
