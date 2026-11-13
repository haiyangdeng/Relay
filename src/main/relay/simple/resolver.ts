import { isDeepStrictEqual } from 'node:util'
import { parseDocument } from 'yaml'
import { compileSimpleConfig, type SimpleSharedConfig } from '../../simple/compiler'
import { normalizeShortIds, parse } from '../../utils/yaml'
import {
  SIMPLE_SHARED_CONFIG_KEYS,
  type SimpleDraft,
  type SimpleObject,
  type SimplePreview
} from '../../../shared/simple-config'
import { boundedJSON, clone, hash, object, SimpleFailure, type SimpleBinding } from './model'

export interface ProfileSnapshot {
  selection: { id: string; sha256: string }
  revision: string
  text: string
}
export interface SourceSnapshot {
  id: string
  revision: string
  // Captured from the same verified source version; Main must prove membership.
  profile: ProfileSnapshot['selection']
  url: string
  userAgent?: string
  authorization?: string
  ageSecretKey?: string
}
export interface CapturedInputs {
  configuration: { revision: string; shared: SimpleSharedConfig }
  profiles: { bindingId: string; profile: ProfileSnapshot; source?: SourceSnapshot }[]
  recheck(): Promise<void>
}
export interface ImmutableInputs {
  readonly configuration: CapturedInputs['configuration']
  readonly profiles: CapturedInputs['profiles']
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
export function snapshotInputs(value: CapturedInputs): ImmutableInputs {
  const data = { configuration: value.configuration, profiles: value.profiles }
  // Snapshots are a Main-only capability. Bounds apply before cloning so a late
  // adapter mutation cannot rewrite an already captured compilation input.
  boundedJSON(data, 4 * 1024 * 1024, 2 * 1024 * 1024)
  return freeze(clone(data))
}

// Match the existing CRUD parser admission before legacy yaml.parse can send
// source lines to process.emitWarning. Syntax errors still use the compiler's
// existing invalid-preview path; warning-bearing input is never compiled.
function yamlWarnings(text: string): boolean {
  return (
    parseDocument(normalizeShortIds(text), {
      merge: true,
      uniqueKeys: true,
      logLevel: 'silent'
    }).warnings.length > 0
  )
}

export function resolveSnapshot(
  draft: SimpleDraft,
  bindings: readonly SimpleBinding[],
  configurationRevision: string,
  input: ImmutableInputs
): { draft: SimpleDraft; shared: SimpleSharedConfig } {
  if (
    input.configuration.revision !== configurationRevision ||
    draft.sources.length !== bindings.length ||
    new Set(bindings.map((entry) => entry.id)).size !== bindings.length ||
    new Set(draft.sources.map((entry) => entry.id)).size !== bindings.length ||
    input.profiles.length !== bindings.length ||
    new Set(input.profiles.map((entry) => entry.bindingId)).size !== bindings.length
  )
    throw new SimpleFailure('stale')
  if (
    !object(input.configuration.shared) ||
    Object.keys(input.configuration.shared).some(
      (key) => !SIMPLE_SHARED_CONFIG_KEYS.some((allowed) => allowed === key)
    ) ||
    (configurationRevision === '' && Object.keys(input.configuration.shared).length > 0)
  )
    throw new SimpleFailure('invalid')
  const shared = input.configuration.shared
  for (const key of ['dns', 'hosts', 'tun', 'sniffer', 'geox-url'] as const)
    if (shared[key] !== undefined && !object(shared[key])) throw new SimpleFailure('invalid')
  for (const key of ['geodata-mode', 'geo-auto-update', 'lgbm-auto-update'] as const)
    if (shared[key] !== undefined && typeof shared[key] !== 'boolean')
      throw new SimpleFailure('invalid')
  for (const key of ['geo-update-interval', 'lgbm-update-interval'] as const)
    if (
      shared[key] !== undefined &&
      (!Number.isSafeInteger(shared[key]) || Number(shared[key]) < 0)
    )
      throw new SimpleFailure('invalid')
  if (shared['lgbm-url'] !== undefined && typeof shared['lgbm-url'] !== 'string')
    throw new SimpleFailure('invalid')
  const next = clone(draft)
  for (const source of next.sources) {
    const bound = bindings.find((entry) => entry.id === source.id)
    const captured = input.profiles.find((entry) => entry.bindingId === source.id)
    if (
      !bound ||
      !captured ||
      source.profileId !== bound.profile.id ||
      !isDeepStrictEqual(bound.profile, captured.profile.selection) ||
      bound.profileRevision !== captured.profile.revision ||
      hash(captured.profile.text) !== bound.profile.sha256 ||
      !!bound.source !== !!captured.source ||
      (bound.source &&
        (!captured.source ||
          bound.source.id !== captured.source.id ||
          bound.source.revision !== captured.source.revision ||
          !isDeepStrictEqual(captured.source.profile, bound.profile)))
    )
      throw new SimpleFailure('stale')
    let data: unknown
    try {
      if (yamlWarnings(captured.profile.text)) throw new SimpleFailure('invalid')
      data = parse(captured.profile.text)
    } catch {
      throw new SimpleFailure('invalid')
    }
    boundedJSON(data, 2 * 1024 * 1024)
    if (!object(data)) throw new SimpleFailure('invalid')
    if (source.mode === 'http') source.proxies = []
    else {
      if (
        !Array.isArray(data.proxies) ||
        !data.proxies.length ||
        data.proxies.length > 1000 ||
        !data.proxies.every(object)
      )
        throw new SimpleFailure('invalid')
      const proxies: SimpleObject[] = clone(data.proxies)
      source.proxies = proxies
    }
    if (captured.source) {
      let url: URL
      try {
        url = new URL(captured.source.url)
      } catch {
        throw new SimpleFailure('invalid')
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new SimpleFailure('invalid')
      source.url = captured.source.url
      source.userAgent = captured.source.userAgent
      source.authorization = captured.source.authorization
      source.ageSecretKey = captured.source.ageSecretKey
    }
  }
  return { draft: next, shared: clone(input.configuration.shared) }
}

// Provider payload nodes are not global outbounds in the fixed Core. Until
// source-local chains have an explicit adaptation, reject their ambiguous
// spelling even when an unrelated global node happens to share that name.
function assertInlineDialers(
  nodes: readonly SimpleObject[],
  outbounds?: ReadonlySet<string>
): void {
  const names = new Set(nodes.map((node) => node.name).filter((name) => typeof name === 'string'))
  for (const node of nodes) {
    const fields = Object.keys(node).filter(
      (key) => key.replaceAll('_', '-').toLowerCase() === 'dialer-proxy'
    )
    if (fields.length > 1) throw new SimpleFailure('invalid')
    const target = fields.length ? node[fields[0]] : undefined
    // Core weakly decodes scalar values; do not guess their target spelling.
    if (target !== undefined && target !== null && typeof target !== 'string')
      throw new SimpleFailure('invalid')
    if (typeof target === 'string' && names.has(target)) throw new SimpleFailure('invalid')
    // The fixed compiler checks only the canonical spelling for external
    // targets. Check accepted aliases against its actual global declarations.
    if (
      outbounds &&
      fields[0] !== 'dialer-proxy' &&
      typeof target === 'string' &&
      target !== '' &&
      !outbounds.has(target)
    )
      throw new SimpleFailure('invalid')
  }
}

// This result stays in Main/private fixtures, never a public IPC response.
export function compileSnapshot(
  draft: SimpleDraft,
  bindings: readonly SimpleBinding[],
  configurationRevision: string,
  inputs: ImmutableInputs
): SimplePreview {
  const resolved = resolveSnapshot(draft, bindings, configurationRevision, inputs)
  if (Object.values(resolved.draft.modules).some(yamlWarnings))
    return {
      yaml: '',
      errors: ['Simple draft contains unsupported YAML diagnostics.'],
      references: { outbounds: [], proxyProviders: [], ruleProviders: [] }
    }
  for (const source of resolved.draft.sources)
    if (source.mode === 'inline') assertInlineDialers(source.proxies)
  const result = compileSimpleConfig(resolved.draft, resolved.shared)
  // The same compiler exemption also affects manually authored inline
  // providers. Inspect the generated plain mapping, without changing its YAML.
  const generated: unknown = parse(result.yaml)
  if (object(generated) && object(generated['proxy-providers']))
    for (const provider of Object.values(generated['proxy-providers']))
      if (
        object(provider) &&
        provider.type === 'inline' &&
        Array.isArray(provider.payload) &&
        provider.payload.every(object)
      )
        assertInlineDialers(provider.payload, new Set(result.references.outbounds))
  return result
}
export interface PublicPreview {
  yamlSHA256: string
  bytes: number
  errors: string[]
  valid: boolean
}
export function publicPreview(value: SimplePreview): PublicPreview {
  return {
    yamlSHA256: hash(value.yaml),
    bytes: Buffer.byteLength(value.yaml),
    // YAML parser diagnostics can include a credential-bearing source line.
    // Detailed diagnostics and raw output remain Main-only in this first slice.
    errors: value.errors.length
      ? ['Simple configuration is invalid; inspect the private draft.']
      : [],
    valid: value.errors.length === 0
  }
}
