import { createHash } from 'node:crypto'
import { stripProfileControls } from '../../../shared/relay/profiles'
import {
  defaultSimpleDraft,
  SIMPLE_MODULES,
  type SimpleDraft,
  type SimpleModule,
  type SimpleSource,
  type SimpleState
} from '../../../shared/simple-config'
import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'

export const SIMPLE_DOCUMENT_BYTES = 1024 * 1024
export const SIMPLE_MODULE_BYTES = 128 * 1024
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
export const clone = <T>(value: T): T => structuredClone(value)

export class SimpleFailure extends Error {
  constructor(readonly code: 'invalid' | 'stale' | 'cancelled' | 'busy' | 'closed' | 'uncertain') {
    super('Simple draft operation ' + code)
  }
}
export function object(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}
export function keys(
  value: unknown,
  required: string[],
  optional: string[] = []
): asserts value is Record<string, unknown> {
  if (
    !object(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => ![...required, ...optional].includes(key))
  )
    throw new SimpleFailure('invalid')
}
export function revision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || (value !== '' && !/^[a-f0-9]{64}$/u.test(value)))
    throw new SimpleFailure('invalid')
}
function name(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    stripProfileControls(value) !== value
  )
    throw new SimpleFailure('invalid')
}

// Bound plain JSON before serialization/compilation. No getters, magic keys or
// unbounded nested values are admitted from a future renderer or persisted file.
export function boundedJSON(
  value: unknown,
  maxBytes = SIMPLE_DOCUMENT_BYTES,
  maxStringBytes = SIMPLE_MODULE_BYTES
): void {
  let count = 0,
    bytes = 0
  const charge = (size: number): void => {
    bytes += size
    if (bytes > maxBytes) throw new SimpleFailure('invalid')
  }
  const visit = (item: unknown, depth: number): void => {
    if (++count > 16000 || depth > 20) throw new SimpleFailure('invalid')
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      charge(String(item).length)
      return
    }
    if (typeof item === 'string' && Buffer.byteLength(item) <= maxStringBytes) {
      charge(Buffer.byteLength(item) + 2)
      return
    }
    if (Array.isArray(item)) {
      if (
        item.length > 2000 ||
        Object.getPrototypeOf(item) !== Array.prototype ||
        Object.getOwnPropertySymbols(item).length ||
        Object.keys(item).length !== item.length
      )
        throw new SimpleFailure('invalid')
      charge(2 + Math.max(0, item.length - 1))
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index)
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
          throw new SimpleFailure('invalid')
        visit(descriptor.value, depth + 1)
      }
      return
    }
    if (!object(item) || Object.getOwnPropertySymbols(item).length)
      throw new SimpleFailure('invalid')
    charge(2)
    let first = true
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (
        ['__proto__', 'prototype', 'constructor'].includes(key) ||
        key.length > 256 ||
        !Object.hasOwn(descriptor, 'value') ||
        !descriptor.enumerable
      )
        throw new SimpleFailure('invalid')
      charge(Buffer.byteLength(key) + 3 + (first ? 0 : 1))
      first = false
      visit(descriptor.value, depth + 1)
    }
  }
  visit(value, 0)
  // Raw UTF-8 plus JSON structure bounds the following escape allocation by
  // at most 6x. Keep the exact serialized limit for escaped strings and keys.
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new SimpleFailure('invalid')
}

export interface SimpleBinding {
  id: string
  profile: RelayProfileSelection
  profileRevision: string
  source?: { id: string; revision: string }
}
export interface SimpleDocument {
  version: 1
  state: SimpleState
  bindings: { draft: SimpleBinding[]; published: SimpleBinding[] }
  configurationRevision: { draft: string; published: string }
  publication?: SimplePublicationReceipt
}
export interface SimplePublicationReceipt {
  profile: RelayProfileSelection
  inputDigest: string
  operationId: string
}
export function publicationReceipt(value: unknown): SimplePublicationReceipt {
  boundedJSON(value)
  keys(value, ['profile', 'inputDigest', 'operationId'])
  const profile = profileSelection(value.profile)
  revision(value.inputDigest)
  if (!value.inputDigest) throw new SimpleFailure('invalid')
  const operation = profileSelection({ id: value.operationId, sha256: value.inputDigest })
  return { profile, inputDigest: value.inputDigest, operationId: operation.id }
}
export interface SimpleRecord {
  document: SimpleDocument
  revision: string
  exists: boolean
}
export interface SaveDraftRequest {
  expectedRevision: string
  draft: SimpleDraft
  bindings: SimpleBinding[]
  configurationRevision: string
}

export function binding(value: unknown): SimpleBinding {
  boundedJSON(value)
  keys(value, ['id', 'profile', 'profileRevision'], ['source'])
  name(value.id)
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(value.id)) throw new SimpleFailure('invalid')
  const profile = profileSelection(value.profile)
  revision(value.profileRevision)
  if (!value.profileRevision) throw new SimpleFailure('invalid')
  let source: SimpleBinding['source']
  if (value.source !== undefined) {
    keys(value.source, ['id', 'revision'])
    const selected = profileSelection({ id: value.source.id, sha256: value.source.revision })
    source = { id: selected.id, revision: selected.sha256 }
  }
  return {
    id: value.id,
    profile,
    profileRevision: value.profileRevision,
    ...(source ? { source } : {})
  }
}

function draft(
  value: unknown,
  rawBindings: unknown
): { draft: SimpleDraft; bindings: SimpleBinding[] } {
  boundedJSON(value)
  keys(value, ['sources', 'modules'], ['preserved', 'moduleOrder'])
  keys(value.modules, Object.keys(SIMPLE_MODULES))
  for (const text of Object.values(value.modules))
    if (typeof text !== 'string' || Buffer.byteLength(text) > SIMPLE_MODULE_BYTES)
      throw new SimpleFailure('invalid')
  if (value.preserved !== undefined && !object(value.preserved)) throw new SimpleFailure('invalid')
  if (
    value.moduleOrder !== undefined &&
    (!Array.isArray(value.moduleOrder) ||
      value.moduleOrder.length !== Object.keys(SIMPLE_MODULES).length ||
      new Set(value.moduleOrder).size !== value.moduleOrder.length ||
      value.moduleOrder.some(
        (key) => typeof key !== 'string' || !Object.hasOwn(SIMPLE_MODULES, key)
      ))
  )
    throw new SimpleFailure('invalid')
  if (
    !Array.isArray(value.sources) ||
    value.sources.length > 64 ||
    !Array.isArray(rawBindings) ||
    rawBindings.length !== value.sources.length
  )
    throw new SimpleFailure('invalid')
  const bindings = rawBindings.map(binding)
  if (new Set(bindings.map((entry) => entry.id)).size !== bindings.length)
    throw new SimpleFailure('invalid')
  const ids = new Set<string>()
  const sources: SimpleSource[] = []
  for (const source of value.sources) {
    keys(
      source,
      ['id', 'name', 'mode', 'prefix', 'interval', 'proxies', 'profileId'],
      ['proxy', 'providerOptions']
    )
    name(source.id)
    name(source.name)
    const bound = bindings.find((entry) => entry.id === source.id)
    if (
      !bound ||
      ids.has(source.id) ||
      source.profileId !== bound.profile.id ||
      typeof source.mode !== 'string' ||
      !['extract', 'inline', 'http'].includes(source.mode) ||
      typeof source.prefix !== 'string' ||
      source.prefix.length > 256 ||
      stripProfileControls(source.prefix) !== source.prefix ||
      !Number.isSafeInteger(source.interval) ||
      Number(source.interval) < 0 ||
      Number(source.interval) > 2147483647 ||
      !Array.isArray(source.proxies) ||
      source.proxies.length !== 0 ||
      (source.mode === 'http' && !bound.source)
    )
      throw new SimpleFailure('invalid')
    ids.add(source.id)
    if (source.proxy !== undefined) name(source.proxy)
    if (source.providerOptions !== undefined) {
      if (
        !object(source.providerOptions) ||
        ['header', 'authorization', 'age-secret-key', 'url', 'payload'].some((key) =>
          Object.hasOwn(source.providerOptions as object, key)
        )
      )
        throw new SimpleFailure('invalid')
    }
    sources.push({
      id: source.id,
      name: source.name,
      mode: source.mode === 'http' ? 'http' : source.mode === 'inline' ? 'inline' : 'extract',
      prefix: source.prefix,
      interval: Number(source.interval),
      proxies: [],
      profileId: bound.profile.id,
      ...(typeof source.proxy === 'string' ? { proxy: source.proxy } : {}),
      ...(object(source.providerOptions) ? { providerOptions: clone(source.providerOptions) } : {})
    })
  }
  const modules = defaultSimpleDraft().modules
  for (const key of Object.keys(SIMPLE_MODULES) as SimpleModule[]) {
    const text = value.modules[key]
    if (typeof text !== 'string') throw new SimpleFailure('invalid')
    modules[key] = text
  }
  const order: SimpleModule[] = []
  if (Array.isArray(value.moduleOrder))
    for (const key of Object.keys(SIMPLE_MODULES) as SimpleModule[])
      order[value.moduleOrder.indexOf(key)] = key
  return {
    draft: {
      sources,
      modules,
      ...(object(value.preserved) ? { preserved: clone(value.preserved) } : {}),
      ...(value.moduleOrder !== undefined ? { moduleOrder: order } : {})
    },
    bindings
  }
}

export function document(value: unknown): SimpleDocument {
  boundedJSON(value)
  keys(value, ['version', 'state', 'bindings', 'configurationRevision'], ['publication'])
  if (value.version !== 1) throw new SimpleFailure('invalid')
  keys(value.state, ['version', 'revision', 'draft', 'published'])
  if (
    value.state.version !== 2 ||
    !Number.isSafeInteger(value.state.revision) ||
    Number(value.state.revision) < 0
  )
    throw new SimpleFailure('invalid')
  keys(value.bindings, ['draft', 'published'])
  keys(value.configurationRevision, ['draft', 'published'])
  revision(value.configurationRevision.draft)
  revision(value.configurationRevision.published)
  const savedDraft = draft(value.state.draft, value.bindings.draft)
  const published = draft(value.state.published, value.bindings.published)
  return {
    version: 1,
    configurationRevision: {
      draft: value.configurationRevision.draft,
      published: value.configurationRevision.published
    },
    state: {
      version: 2,
      revision: Number(value.state.revision),
      draft: savedDraft.draft,
      published: published.draft
    },
    bindings: { draft: savedDraft.bindings, published: published.bindings },
    ...(value.publication === undefined
      ? {}
      : { publication: publicationReceipt(value.publication) })
  }
}
export function missingRecord(): SimpleRecord {
  const initial = defaultSimpleDraft()
  return {
    exists: false,
    revision: '',
    document: {
      version: 1,
      configurationRevision: { draft: '', published: '' },
      state: { version: 2, revision: 0, draft: initial, published: clone(initial) },
      bindings: { draft: [], published: [] }
    }
  }
}
export function saveRequest(value: unknown): SaveDraftRequest {
  boundedJSON(value)
  keys(value, ['expectedRevision', 'draft', 'bindings', 'configurationRevision'])
  revision(value.expectedRevision)
  revision(value.configurationRevision)
  const checked = draft(value.draft, value.bindings)
  return {
    expectedRevision: value.expectedRevision,
    configurationRevision: value.configurationRevision,
    ...checked
  }
}

export interface SimplePublicView {
  exists: boolean
  revision: string
  publishedRevision: number
  dirty: boolean
  sources: { id: string; name: string; mode: string }[]
}
// This summary is intentionally separate from the Main-only record/compile
// material. It cannot accidentally serialize resolver-injected credentials/YAML.
export function publicView(record: SimpleRecord): SimplePublicView {
  return {
    exists: record.exists,
    revision: record.revision,
    publishedRevision: record.document.state.revision,
    dirty:
      JSON.stringify(record.document.state.draft) !==
        JSON.stringify(record.document.state.published) ||
      JSON.stringify(record.document.bindings.draft) !==
        JSON.stringify(record.document.bindings.published) ||
      record.document.configurationRevision.draft !==
        record.document.configurationRevision.published,
    sources: record.document.state.draft.sources.map(({ id, name, mode }) => ({ id, name, mode }))
  }
}
