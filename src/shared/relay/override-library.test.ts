import { describe, expect, it } from 'vitest'
import {
  overrideLibraryBindRequest,
  overrideLibraryBindingsRequest,
  overrideLibraryBodyRequest,
  overrideLibraryCreateRequest,
  overrideLibraryFetchEvidence,
  overrideLibraryIdFromRuntimeId,
  overrideLibraryMetadataRequest,
  overrideLibraryOrderRequest,
  overrideLibraryRefreshRequest,
  overrideLibraryRuntimeId
} from './override-library'

const id = '11111111-1111-4111-8111-111111111111',
  revision = 'a'.repeat(64)
const local = {
  expectedLibraryRevision: '',
  name: 'Fixture',
  kind: 'yaml',
  type: 'local',
  content: 'rules: []\n'
}
describe('Override library explicit public requests', () => {
  it('has a dedicated UUID namespace and cannot impersonate Smart or an old inline ID', () => {
    expect(overrideLibraryIdFromRuntimeId(overrideLibraryRuntimeId(id))).toBe(id)
    expect(overrideLibraryIdFromRuntimeId('smart-core-override')).toBeUndefined()
    expect(() =>
      overrideLibraryIdFromRuntimeId('relay-override-library:smart-core-override')
    ).toThrow()
    expect(() => overrideLibraryCreateRequest({ ...local, id })).toThrow()
    expect(() => overrideLibraryCreateRequest({ ...local, role: 'smart' })).toThrow()
  })
  it('separates metadata/body CAS, rejects changing immutable kind/type, and accepts only explicit source definitions', () => {
    expect(overrideLibraryCreateRequest(local)).toEqual(local)
    expect(
      overrideLibraryCreateRequest({
        expectedLibraryRevision: revision,
        name: 'Remote',
        kind: 'js',
        type: 'remote',
        remote: { url: 'https://example.invalid/file?token=PRIVATE', proxyPort: 17891 }
      })
    ).not.toHaveProperty('content')
    for (const extra of [
      { kind: 'js' },
      { type: 'remote' },
      { content: 'PRIVATE' },
      { global: true }
    ])
      expect(() =>
        overrideLibraryMetadataRequest({
          id,
          expectedLibraryRevision: revision,
          expectedMetadataRevision: revision,
          name: 'Updated',
          ...extra
        })
      ).toThrow()
    expect(
      overrideLibraryBodyRequest({
        id,
        expectedLibraryRevision: revision,
        expectedBodyRevision: '',
        content: '{}'
      }).expectedBodyRevision
    ).toBe('')
    expect(() =>
      overrideLibraryBodyRequest({ id, expectedLibraryRevision: revision, content: '{}' })
    ).toThrow()
  })
  it.each([
    { ...local, name: ' ' },
    { ...local, name: 'x'.repeat(121) },
    { ...local, name: '\ud800' },
    { ...local, kind: Object('yaml') },
    { ...local, type: ['local'] },
    { ...local, content: '\ud800' },
    { ...local, content: '\0' },
    { ...local, content: '中'.repeat(44000) },
    { ...local, kind: 'js', content: 'x'.repeat(65537) },
    { ...local, remote: { url: 'https://example.invalid/', proxyPort: 17891 } },
    { ...local, type: 'remote', remote: { url: 'https://example.invalid/', proxyPort: 17891 } },
    {
      expectedLibraryRevision: '',
      name: 'Remote',
      kind: 'yaml',
      type: 'remote',
      remote: { url: 'file:///tmp/private', proxyPort: 17891 }
    },
    {
      expectedLibraryRevision: '',
      name: 'Remote',
      kind: 'yaml',
      type: 'remote',
      remote: { url: 'https://user:pass@example.invalid/', proxyPort: 17891 }
    },
    {
      expectedLibraryRevision: '',
      name: 'Remote',
      kind: 'yaml',
      type: 'remote',
      remote: { url: 'https://example.invalid/', proxyPort: 0 }
    }
  ])('rejects unknown/coerced/overbudget text and unsafe sources %#', (value) => {
    expect(() => overrideLibraryCreateRequest(value)).toThrow()
  })
  it('separates ordered binding from an explicit old-to-new refresh and accepts no arbitrary inline body', () => {
    const request = {
      expectedEditRevision: revision,
      target: { id, sha256: revision, revision },
      refs: [{ id, bodyRevision: revision }]
    }
    expect(overrideLibraryBindRequest(request)).toEqual(request)
    expect(overrideLibraryBindingsRequest({ target: { id, sha256: revision } })).toEqual({
      target: { id, sha256: revision }
    })
    expect(() => overrideLibraryBindingsRequest({ target: request.target })).toThrow()
    expect(() =>
      overrideLibraryBindRequest({ ...request, target: { id, sha256: revision } })
    ).toThrow()
    expect(
      overrideLibraryRefreshRequest({
        ...request,
        refs: [{ id, bodyRevision: revision, expectedOldBodyRevision: 'b'.repeat(64) }]
      }).refs[0].expectedOldBodyRevision
    ).toBe('b'.repeat(64))
    expect(() => overrideLibraryRefreshRequest(request)).toThrow()
    expect(() =>
      overrideLibraryBindRequest({ ...request, refs: [{ ...request.refs[0], content: 'PRIVATE' }] })
    ).toThrow()
    expect(() =>
      overrideLibraryBindRequest({ ...request, refs: [request.refs[0], request.refs[0]] })
    ).toThrow()
    expect(overrideLibraryOrderRequest({ expectedEditRevision: '', ids: [id] }).ids).toEqual([id])
    expect(() =>
      overrideLibraryOrderRequest({ expectedEditRevision: revision, ids: [id, id] })
    ).toThrow()
    expect(overrideLibraryFetchEvidence({ evidenceId: id })).toEqual({ evidenceId: id })
    expect(() =>
      overrideLibraryFetchEvidence({ evidenceId: id, url: 'https://other.invalid/' })
    ).toThrow()
  })
})
