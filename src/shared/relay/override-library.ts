import { stripProfileControls } from './profiles'
import { subscriptionRequest } from './subscription'
import { profileSelection } from './runtime'

export const OVERRIDE_LIBRARY_RUNTIME_PREFIX = 'relay-override-library:'
export const OVERRIDE_LIBRARY_MAX_ITEMS = 200
export const OVERRIDE_LIBRARY_MAX_BYTES = 1024 * 1024
export const OVERRIDE_LIBRARY_YAML_BYTES = 128 * 1024
export const OVERRIDE_LIBRARY_JS_BYTES = 64 * 1024
export type OverrideLibraryKind = 'yaml' | 'js'
export type OverrideLibraryType = 'local' | 'remote'
export interface OverrideLibraryRemote {
  url: string
  proxyPort: number
}
export interface OverrideLibrarySummary {
  id: string
  name: string
  kind: OverrideLibraryKind
  type: OverrideLibraryType
  metadataRevision: string
  bodyRevision: string
  bodyBytes: number
  bodyState: 'missing' | 'local' | 'manual' | 'current' | 'stale'
  createdAt: number
  metadataUpdatedAt: number
  bodyUpdatedAt?: number
  lastFetchedAt?: number
}
export interface OverrideLibraryItem extends OverrideLibrarySummary {
  remote?: OverrideLibraryRemote
  sourceFingerprint?: string
  content?: string
}
export interface OverrideLibraryInventory {
  revision: string
  exists: boolean
  items: OverrideLibrarySummary[]
}
export interface OverrideLibraryRecord {
  revision: string
  item: OverrideLibraryItem
}
export interface OverrideLibraryReadRequest {
  id: string
  expectedLibraryRevision?: string
}
export interface OverrideLibraryCreateRequest {
  expectedLibraryRevision: string
  name: string
  kind: OverrideLibraryKind
  type: OverrideLibraryType
  remote?: OverrideLibraryRemote
  content?: string
}
export interface OverrideLibraryMetadataRequest {
  id: string
  expectedLibraryRevision: string
  expectedMetadataRevision: string
  name: string
  remote?: OverrideLibraryRemote
}
export interface OverrideLibraryBodyRequest {
  id: string
  expectedLibraryRevision: string
  expectedBodyRevision: string
  content: string
}
export interface OverrideLibraryRemoveRequest {
  id: string
  expectedLibraryRevision: string
  expectedMetadataRevision: string
  expectedBodyRevision: string
}
export interface OverrideLibraryFetchRequest extends OverrideLibraryRemoveRequest {}
export interface OverrideLibraryFetchPlan {
  evidenceId: string
  action: 'fetchOverride'
  id: string
  name: string
  kind: OverrideLibraryKind
  endpoint: string
  proxyPort: number
  sourceFingerprint: string
  libraryRevision: string
  metadataRevision: string
  bodyRevision: string
  maxBytes: number
  expiresAt: number
}
export type OverrideLibraryFetchResult =
  { status: 'cancelled' } | { status: 'updated'; revision: string; item: OverrideLibrarySummary }
export interface OverrideLibraryTarget {
  id: string
  sha256: string
  revision: string
}
export interface OverrideLibraryBindRequest {
  expectedEditRevision: string
  target?: OverrideLibraryTarget
  refs: { id: string; bodyRevision: string }[]
}
export interface OverrideLibraryRefreshRequest {
  expectedEditRevision: string
  target?: OverrideLibraryTarget
  refs: { id: string; expectedOldBodyRevision: string; bodyRevision: string }[]
}
export interface OverrideLibraryOrderRequest {
  expectedEditRevision: string
  ids: string[]
}
export interface OverrideLibraryBindingsRequest {
  target?: Pick<OverrideLibraryTarget, 'id' | 'sha256'>
}
export interface OverrideLibraryBindings {
  editRevision: string
  order: string[]
  globalRefs: { id: string; bodyRevision: string }[]
  profileRefs: { id: string; bodyRevision: string }[]
  target?: OverrideLibraryTarget
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const digest = /^[a-f0-9]{64}$/u
function object(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !allowed.includes(k))
  )
    throw new Error('覆写库请求含无效或未知字段。')
  return raw as Record<string, unknown>
}
export function overrideLibraryId(raw: unknown): string {
  if (typeof raw !== 'string' || !uuid.test(raw)) throw new Error('覆写库ID无效。')
  return raw
}
export function overrideLibraryRevision(raw: unknown, empty = false): string {
  if (typeof raw !== 'string' || (!(empty && raw === '') && !digest.test(raw)))
    throw new Error('覆写库修订无效。')
  return raw
}
export function overrideLibraryRuntimeId(id: string): string {
  return OVERRIDE_LIBRARY_RUNTIME_PREFIX + overrideLibraryId(id)
}
export function overrideLibraryIdFromRuntimeId(id: string): string | undefined {
  return id.startsWith(OVERRIDE_LIBRARY_RUNTIME_PREFIX)
    ? overrideLibraryId(id.slice(OVERRIDE_LIBRARY_RUNTIME_PREFIX.length))
    : undefined
}
export function overrideLibraryName(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !raw.trim() ||
    raw.length > 120 ||
    stripProfileControls(raw) !== raw ||
    !validUnicode(raw)
  )
    throw new Error('覆写库名称无效。')
  return raw
}
function validUnicode(value: string): boolean {
  return (
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(value)
    ) === value
  )
}
export function overrideLibraryContent(raw: unknown, kind?: OverrideLibraryKind): string {
  if (
    typeof raw !== 'string' ||
    raw.includes('\0') ||
    !validUnicode(raw) ||
    new TextEncoder().encode(raw).length >
      (kind === 'js' ? OVERRIDE_LIBRARY_JS_BYTES : OVERRIDE_LIBRARY_YAML_BYTES)
  )
    throw new Error('覆写正文编码或字节预算无效。')
  return raw
}
export function overrideLibraryRemote(raw: unknown): OverrideLibraryRemote {
  const input = object(raw, ['url', 'proxyPort'])
  if (typeof input.url !== 'string' || !validUnicode(input.url))
    throw new Error('覆写来源地址编码无效。')
  const request = subscriptionRequest({
    name: 'Override',
    url: input.url,
    proxyPort: input.proxyPort
  })
  return { url: request.url, proxyPort: request.proxyPort }
}
export function overrideLibraryReadRequest(raw: unknown): OverrideLibraryReadRequest {
  const input = object(raw, ['id', 'expectedLibraryRevision'])
  return {
    id: overrideLibraryId(input.id),
    ...(input.expectedLibraryRevision !== undefined
      ? { expectedLibraryRevision: overrideLibraryRevision(input.expectedLibraryRevision, true) }
      : {})
  }
}
export function overrideLibraryCreateRequest(raw: unknown): OverrideLibraryCreateRequest {
  const input = object(raw, [
    'expectedLibraryRevision',
    'name',
    'kind',
    'type',
    'remote',
    'content'
  ])
  if (
    (input.kind !== 'yaml' && input.kind !== 'js') ||
    (input.type !== 'local' && input.type !== 'remote') ||
    (input.type === 'local'
      ? Object.hasOwn(input, 'remote')
      : !Object.hasOwn(input, 'remote') || Object.hasOwn(input, 'content'))
  )
    throw new Error('覆写来源或类型无效；远端定义不能冒充已获取的正文。')
  return {
    expectedLibraryRevision: overrideLibraryRevision(input.expectedLibraryRevision, true),
    name: overrideLibraryName(input.name),
    kind: input.kind,
    type: input.type,
    ...(input.type === 'remote' ? { remote: overrideLibraryRemote(input.remote) } : {}),
    ...(input.content !== undefined
      ? { content: overrideLibraryContent(input.content, input.kind) }
      : {})
  }
}
export function overrideLibraryMetadataRequest(raw: unknown): OverrideLibraryMetadataRequest {
  const input = object(raw, [
    'id',
    'expectedLibraryRevision',
    'expectedMetadataRevision',
    'name',
    'remote'
  ])
  return {
    id: overrideLibraryId(input.id),
    expectedLibraryRevision: overrideLibraryRevision(input.expectedLibraryRevision),
    expectedMetadataRevision: overrideLibraryRevision(input.expectedMetadataRevision),
    name: overrideLibraryName(input.name),
    ...(Object.hasOwn(input, 'remote') ? { remote: overrideLibraryRemote(input.remote) } : {})
  }
}
export function overrideLibraryBodyRequest(raw: unknown): OverrideLibraryBodyRequest {
  const input = object(raw, ['id', 'expectedLibraryRevision', 'expectedBodyRevision', 'content'])
  return {
    id: overrideLibraryId(input.id),
    expectedLibraryRevision: overrideLibraryRevision(input.expectedLibraryRevision),
    expectedBodyRevision: overrideLibraryRevision(input.expectedBodyRevision, true),
    content: overrideLibraryContent(input.content)
  }
}
export function overrideLibraryRemoveRequest(raw: unknown): OverrideLibraryRemoveRequest {
  const input = object(raw, [
    'id',
    'expectedLibraryRevision',
    'expectedMetadataRevision',
    'expectedBodyRevision'
  ])
  return {
    id: overrideLibraryId(input.id),
    expectedLibraryRevision: overrideLibraryRevision(input.expectedLibraryRevision),
    expectedMetadataRevision: overrideLibraryRevision(input.expectedMetadataRevision),
    expectedBodyRevision: overrideLibraryRevision(input.expectedBodyRevision, true)
  }
}
export const overrideLibraryFetchRequest = overrideLibraryRemoveRequest
export function overrideLibraryFetchEvidence(raw: unknown): { evidenceId: string } {
  const input = object(raw, ['evidenceId'])
  return { evidenceId: overrideLibraryId(input.evidenceId) }
}
function target(raw: unknown): OverrideLibraryTarget {
  const input = object(raw, ['id', 'sha256', 'revision'])
  return {
    ...profileSelection({ id: input.id, sha256: input.sha256 }),
    revision: overrideLibraryRevision(input.revision)
  }
}
function refs(raw: unknown, refresh: boolean): OverrideLibraryRefreshRequest['refs'] {
  if (!Array.isArray(raw) || raw.length > OVERRIDE_LIBRARY_MAX_ITEMS)
    throw new Error('覆写选择数量无效。')
  const seen = new Set<string>()
  return raw.map((value) => {
    const input = object(value, [
        'id',
        'bodyRevision',
        ...(refresh ? ['expectedOldBodyRevision'] : [])
      ]),
      id = overrideLibraryId(input.id)
    if (seen.has(id)) throw new Error('覆写选择重复。')
    seen.add(id)
    return {
      id,
      bodyRevision: overrideLibraryRevision(input.bodyRevision),
      expectedOldBodyRevision: refresh ? overrideLibraryRevision(input.expectedOldBodyRevision) : ''
    }
  })
}
export function overrideLibraryBindRequest(raw: unknown): OverrideLibraryBindRequest {
  const input = object(raw, ['expectedEditRevision', 'target', 'refs'])
  return {
    expectedEditRevision: overrideLibraryRevision(input.expectedEditRevision, true),
    ...(input.target !== undefined ? { target: target(input.target) } : {}),
    refs: refs(input.refs, false).map(({ id, bodyRevision }) => ({ id, bodyRevision }))
  }
}
export function overrideLibraryBindingsRequest(raw: unknown): OverrideLibraryBindingsRequest {
  const input = object(raw, ['target'])
  if (input.target === undefined) return {}
  const selected = object(input.target, ['id', 'sha256'])
  return { target: profileSelection({ id: selected.id, sha256: selected.sha256 }) }
}
export function overrideLibraryRefreshRequest(raw: unknown): OverrideLibraryRefreshRequest {
  const input = object(raw, ['expectedEditRevision', 'target', 'refs'])
  return {
    expectedEditRevision: overrideLibraryRevision(input.expectedEditRevision, true),
    ...(input.target !== undefined ? { target: target(input.target) } : {}),
    refs: refs(input.refs, true)
  }
}
export function overrideLibraryOrderRequest(raw: unknown): OverrideLibraryOrderRequest {
  const input = object(raw, ['expectedEditRevision', 'ids'])
  if (!Array.isArray(input.ids) || input.ids.length > OVERRIDE_LIBRARY_MAX_ITEMS)
    throw new Error('覆写顺序数量无效。')
  const ids = input.ids.map(overrideLibraryId)
  if (new Set(ids).size !== ids.length) throw new Error('覆写顺序重复。')
  return { expectedEditRevision: overrideLibraryRevision(input.expectedEditRevision, true), ids }
}
