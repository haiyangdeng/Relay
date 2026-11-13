import { describe, expect, it } from 'vitest'
import { smartStateCSVHeader, smartStateDigest, smartStateSchema } from '../core/smart-state-schema'
import { smartStateCollectsCSV, validateSmartStateSeedMetadata } from './checked-execution'

const cache = { path: 'cache.db', size: 0, sha256: smartStateDigest(Buffer.alloc(0)) }
const csv = {
  path: 'smart_weight_data.csv',
  size: 555,
  sha256: smartStateDigest(smartStateCSVHeader())
}
const seed = (collect = false) => ({
  version: 1,
  key: '1'.repeat(64),
  previousRevision: null,
  files: collect ? [cache, csv] : [cache]
})

describe('Main state metadata follows the single Native state contract', () => {
  it.each([false, true])('accepts the exact fixed file set with collectCSV=%s', (collect) => {
    expect(() => validateSmartStateSeedMetadata(seed(collect), collect)).not.toThrow()
    expect(() => validateSmartStateSeedMetadata(seed(!collect), collect)).toThrow()
  })
  it.each([
    { version: true },
    { key: 'bad' },
    { previousRevision: 'bad' },
    { extra: true },
    { files: [] },
    { files: [cache, cache] },
    { files: [{ ...cache, path: '../cache.db' }] },
    { files: [{ ...cache, size: true }] },
    { files: [{ ...cache, size: -1 }] },
    { files: [{ ...cache, size: smartStateSchema.fileByteLimit + 1 }] },
    { files: [{ ...cache, sha256: '2'.repeat(64) }] },
    { files: [{ ...cache, extra: true }] }
  ])('rejects malformed metadata before staging %j', (patch) => {
    expect(() => validateSmartStateSeedMetadata({ ...seed(), ...patch }, false)).toThrow()
  })
  it('requires the fixed nonempty CSV prefix budget and keeps mutable budget separate', () => {
    expect(() =>
      validateSmartStateSeedMetadata({ ...seed(true), files: [cache, { ...csv, size: 554 }] }, true)
    ).toThrow()
    expect(() =>
      validateSmartStateSeedMetadata(
        {
          ...seed(true),
          files: [
            { ...cache, size: smartStateSchema.fileByteLimit, sha256: '3'.repeat(64) },
            { ...csv, size: smartStateSchema.fileByteLimit }
          ]
        },
        true
      )
    ).not.toThrow()
  })
  it('uses explicit Smart collection flags and preserves the upstream false default', () => {
    const source = (value?: boolean) =>
      JSON.stringify({
        proxies: [],
        'proxy-groups': [
          {
            name: 'Smart',
            type: 'smart',
            proxies: ['REJECT'],
            url: 'http://127.0.0.1:1/health',
            ...(value !== undefined ? { collectdata: value } : {})
          }
        ],
        rules: ['MATCH,REJECT']
      })
    expect(smartStateCollectsCSV(source())).toBe(false)
    expect(smartStateCollectsCSV(source(false))).toBe(false)
    expect(smartStateCollectsCSV(source(true))).toBe(true)
  })
})
