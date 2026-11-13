import { describe, expect, it } from 'vitest'
import {
  variantAcquireRequest,
  variantImportRequest,
  variantRecord,
  variantSelection
} from './variant'

describe('variant acquire request validation', () => {
  it('accepts a core variant request with architecture', () => {
    const req = variantAcquireRequest({
      kind: 'core',
      sourcePath: '/tmp/mihomo',
      version: 'v1.19.34',
      sha256: 'a'.repeat(64),
      size: 56810034,
      architecture: 'arm64'
    })
    expect(req.kind).toBe('core')
    expect(req.architecture).toBe('arm64')
  })
  it('accepts a smart model request without architecture', () => {
    const req = variantAcquireRequest({
      kind: 'smart',
      sourcePath: '/tmp/model.bin',
      version: 'smart-1.0',
      sha256: 'b'.repeat(64),
      size: 1048576
    })
    expect(req.kind).toBe('smart')
    expect(req.architecture).toBeUndefined()
  })
  it('rejects an invalid kind', () => {
    expect(() =>
      variantAcquireRequest({
        kind: 'other',
        sourcePath: '/tmp/x',
        version: 'v1',
        sha256: 'a'.repeat(64),
        size: 100
      })
    ).toThrow()
  })
  it('rejects a relative source path', () => {
    expect(() =>
      variantAcquireRequest({
        kind: 'core',
        sourcePath: 'relative/path',
        version: 'v1',
        sha256: 'a'.repeat(64),
        size: 100
      })
    ).toThrow()
  })
  it('rejects a non-hex sha256', () => {
    expect(() =>
      variantAcquireRequest({
        kind: 'smart',
        sourcePath: '/tmp/x',
        version: 'v1',
        sha256: 'not-a-hash',
        size: 100
      })
    ).toThrow()
  })
  it('rejects an out-of-range size', () => {
    expect(() =>
      variantAcquireRequest({
        kind: 'smart',
        sourcePath: '/tmp/x',
        version: 'v1',
        sha256: 'a'.repeat(64),
        size: 0
      })
    ).toThrow()
  })
  it('rejects unknown fields', () => {
    expect(() =>
      variantAcquireRequest({
        kind: 'core',
        sourcePath: '/tmp/x',
        version: 'v1',
        sha256: 'a'.repeat(64),
        size: 100,
        extra: true
      })
    ).toThrow()
  })
})

describe('variant selection validation', () => {
  it('accepts a valid uuid id', () => {
    const sel = variantSelection({
      id: '12345678-1234-1234-1234-123456789012'
    })
    expect(sel.id).toBe('12345678-1234-1234-1234-123456789012')
  })
  it('rejects a non-uuid id', () => {
    expect(() => variantSelection({ id: 'not-a-uuid' })).toThrow()
  })
  it('rejects extra fields', () => {
    expect(() =>
      variantSelection({ id: '12345678-1234-1234-1234-123456789012', extra: true })
    ).toThrow()
  })
})

describe('Renderer metadata and persisted record validation', () => {
  const metadata = { kind: 'smart', version: 'fixture', sha256: 'a'.repeat(64), size: 200 }
  it('allows only import metadata and rejects an arbitrary renderer source path', () => {
    expect(variantImportRequest(metadata)).toEqual(metadata)
    expect(() => variantImportRequest({ ...metadata, sourcePath: '/private/secret' })).toThrow(
      '文件选择'
    )
    expect(() => variantImportRequest({ ...metadata, ignored: true })).toThrow('字段')
  })
  it('requires complete valid record identities and kind/architecture associations', () => {
    const record = { ...metadata, id: '12345678-1234-1234-1234-123456789012', acquiredAt: 1000 }
    expect(variantRecord(record)).toEqual(record)
    expect(() => variantRecord({ ...record, id: '../escape' })).toThrow('UUID')
    expect(() => variantRecord({ ...record, kind: 'core' })).toThrow('缺少架构')
    expect(() => variantRecord({ ...record, architecture: 'arm64' })).toThrow('不接受')
  })
})
