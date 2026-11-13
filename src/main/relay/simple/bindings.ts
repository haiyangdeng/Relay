import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { defaultSimpleDraft, type SimpleSource } from '../../../shared/simple-config'
import { profileSelection } from '../../../shared/relay/runtime'
import { sourceSelection } from '../../../shared/relay/subscription-sources'
import { stripProfileControls } from '../../../shared/relay/profiles'
import type {
  RelaySimpleProviderOptions,
  RelaySimpleSourceMutation,
  RelaySimpleSourceValue,
  RelaySimpleSourcesSnapshot
} from '../../../shared/relay/simple-sources'
import type { RelayStateContext } from '../context'
import { normalizeSimpleProviderOptions } from '../../simple/providers'
import { createPinnedSimpleProfileSourceReader } from './capture'
import { resolveSnapshot, snapshotInputs } from './resolver'
import {
  boundedJSON,
  clone,
  keys,
  publicView,
  revision,
  SimpleFailure,
  type SimpleBinding,
  type SimpleRecord
} from './model'

const invalid = (): never => {
  throw new SimpleFailure('invalid')
}
const label = (value: unknown, empty = false, limit = 256): string => {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    value.length > limit ||
    stripProfileControls(value) !== value
  )
    return invalid()
  return value
}
const interval = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2147483647)
    return invalid()
  return value
}
function providerOptions(
  raw: unknown,
  mode: RelaySimpleSourceValue['mode']
): RelaySimpleProviderOptions {
  const allowed = [
    'filter',
    'exclude-filter',
    'exclude-type',
    'override',
    ...(mode === 'http' ? ['size-limit'] : [])
  ]
  keys(raw, [], allowed)
  const options: RelaySimpleProviderOptions = {}
  for (const key of ['filter', 'exclude-filter', 'exclude-type'] as const)
    if (Object.hasOwn(raw, key)) options[key] = label(raw[key], true, 4096)
  if (Object.hasOwn(raw, 'size-limit')) {
    const size = raw['size-limit']
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return invalid()
    options['size-limit'] = size
  }
  if (Object.hasOwn(raw, 'override')) {
    keys(raw.override, [], ['tfo', 'mptcp', 'udp', 'udp-over-tcp'])
    if (!Object.keys(raw.override).length) return invalid()
    const override: NonNullable<RelaySimpleProviderOptions['override']> = {}
    for (const key of ['tfo', 'mptcp', 'udp', 'udp-over-tcp'] as const)
      if (Object.hasOwn(raw.override, key)) {
        const value = raw.override[key]
        if (typeof value !== 'boolean') return invalid()
        override[key] = value
      }
    options.override = override
  }
  const normalized = normalizeSimpleProviderOptions(options)
  if (!isDeepStrictEqual(normalized, options)) return invalid()
  return options
}
export function sourceValue(raw: unknown): RelaySimpleSourceValue {
  boundedJSON(raw)
  keys(
    raw,
    ['profile', 'source', 'name', 'mode', 'prefix', 'interval'],
    ['proxy', 'providerOptions']
  )
  if (typeof raw.mode !== 'string' || !['extract', 'inline', 'http'].includes(raw.mode))
    return invalid()
  const mode = raw.mode as RelaySimpleSourceValue['mode'],
    profile = profileSelection(raw.profile),
    source = raw.source === null ? null : sourceSelection(raw.source)
  if (mode === 'http' && source === null) return invalid()
  if (
    (mode !== 'http' && Object.hasOwn(raw, 'proxy')) ||
    (mode === 'extract' && Object.hasOwn(raw, 'providerOptions'))
  )
    return invalid()
  return {
    profile,
    source,
    mode,
    name: label(raw.name),
    prefix: label(raw.prefix, true),
    interval: interval(raw.interval),
    ...(Object.hasOwn(raw, 'proxy') ? { proxy: label(raw.proxy) } : {}),
    ...(Object.hasOwn(raw, 'providerOptions')
      ? { providerOptions: providerOptions(raw.providerOptions, mode) }
      : {})
  }
}
export function sourceMutation(raw: unknown): RelaySimpleSourceMutation {
  try {
    boundedJSON(raw)
    keys(raw, ['action', 'expectedRevision'], ['bindingId', 'value'])
    revision(raw.expectedRevision)
    if (raw.action === 'add') {
      keys(raw, ['action', 'expectedRevision', 'value'])
      return {
        action: 'add',
        expectedRevision: raw.expectedRevision,
        value: sourceValue(raw.value)
      }
    }
    if (raw.action !== 'replace' && raw.action !== 'remove') return invalid()
    const bindingId = label(raw.bindingId, false, 80)
    if (!/^[A-Za-z0-9_-]{1,80}$/u.test(bindingId)) return invalid()
    if (raw.action === 'remove') {
      keys(raw, ['action', 'expectedRevision', 'bindingId'])
      return { action: 'remove', expectedRevision: raw.expectedRevision, bindingId }
    }
    keys(raw, ['action', 'expectedRevision', 'bindingId', 'value'])
    return {
      action: 'replace',
      expectedRevision: raw.expectedRevision,
      bindingId,
      value: sourceValue(raw.value)
    }
  } catch {
    return invalid()
  }
}
function valueFor(source: SimpleSource, bound: SimpleBinding): RelaySimpleSourceValue {
  return sourceValue({
    profile: bound.profile,
    source: bound.source ?? null,
    name: source.name,
    mode: source.mode,
    prefix: source.prefix,
    interval: source.interval,
    ...(source.proxy !== undefined ? { proxy: source.proxy } : {}),
    ...(source.providerOptions !== undefined ? { providerOptions: source.providerOptions } : {})
  })
}
export function sourceBindingsView(record: SimpleRecord): RelaySimpleSourcesSnapshot {
  const { sources: _sources, ...metadata } = publicView(record)
  return {
    ...metadata,
    sharedConfigurationPinned: record.document.configurationRevision.draft !== '',
    sources: record.document.state.draft.sources.map((source) => {
      const bound = record.document.bindings.draft.find((binding) => binding.id === source.id)
      if (!bound) return invalid()
      const row = {
        bindingId: source.id,
        profile: clone(bound.profile),
        source: bound.source ? clone(bound.source) : null,
        name: source.name,
        mode: source.mode,
        prefix: source.prefix,
        interval: source.interval
      }
      try {
        const value = valueFor(source, bound)
        return {
          ...row,
          editable: true,
          hasUnsupportedOptions: false,
          ...(value.proxy !== undefined ? { proxy: value.proxy } : {}),
          ...(value.providerOptions !== undefined ? { providerOptions: value.providerOptions } : {})
        }
      } catch {
        return { ...row, editable: false, hasUnsupportedOptions: true }
      }
    })
  }
}
export interface AdmittedSimpleBinding {
  source: SimpleSource
  binding: SimpleBinding
  recheck(): Promise<void>
}
export function createPinnedSimpleBindingReader(context: RelayStateContext) {
  const read = createPinnedSimpleProfileSourceReader(context)
  return async (
    id: string,
    value: RelaySimpleSourceValue,
    signal: AbortSignal,
    assertCurrent: () => void
  ): Promise<AdmittedSimpleBinding> => {
    const live = (): void => {
      if (signal.aborted) throw new SimpleFailure('cancelled')
      assertCurrent()
    }
    live()
    const source: SimpleSource = {
      id,
      name: value.name,
      mode: value.mode,
      prefix: value.prefix,
      interval: value.interval,
      profileId: value.profile.id,
      proxies: [],
      ...(value.proxy !== undefined ? { proxy: value.proxy } : {}),
      ...(value.providerOptions !== undefined
        ? { providerOptions: clone(value.providerOptions) }
        : {})
    }
    const selection = {
        profile: clone(value.profile),
        ...(value.source ? { source: clone(value.source) } : {})
      },
      facts = await read(selection, signal, live)
    live()
    const binding: SimpleBinding = { id, ...selection, profileRevision: facts.profile.revision },
      inputs = snapshotInputs({
        configuration: { revision: '', shared: {} },
        profiles: [{ bindingId: id, ...facts }],
        recheck: async () => {}
      }),
      draft = defaultSimpleDraft()
    draft.sources = [source]
    // Validate only the selected source, without compiling unrelated invalid modules.
    resolveSnapshot(draft, [binding], '', inputs)
    live()
    return {
      source,
      binding,
      recheck: async () => {
        live()
        await read(binding, signal, live)
        live()
      }
    }
  }
}
export function applySourceBinding(
  record: SimpleRecord,
  request: RelaySimpleSourceMutation,
  admitted?: AdmittedSimpleBinding
) {
  const draft = clone(record.document.state.draft),
    bindings = clone(record.document.bindings.draft)
  if (request.action === 'add') {
    if (draft.sources.length >= 64 || !admitted) return invalid()
    if (draft.sources.some((source) => source.name === admitted.source.name)) return invalid()
    draft.sources.push(clone(admitted.source))
    bindings.push(clone(admitted.binding))
  } else {
    const index = draft.sources.findIndex((source) => source.id === request.bindingId),
      boundIndex = bindings.findIndex((binding) => binding.id === request.bindingId)
    if (index < 0 || boundIndex < 0) return invalid()
    if (request.action === 'remove') {
      draft.sources.splice(index, 1)
      bindings.splice(boundIndex, 1)
    } else {
      if (!admitted) return invalid()
      valueFor(draft.sources[index], bindings[boundIndex])
      if (draft.sources.some((source, n) => n !== index && source.name === admitted.source.name))
        return invalid()
      draft.sources[index] = clone(admitted.source)
      bindings[boundIndex] = clone(admitted.binding)
    }
  }
  return {
    expectedRevision: record.revision,
    draft,
    bindings,
    configurationRevision: record.document.configurationRevision.draft
  }
}
export const newSimpleBindingId = (): string => 'source-' + randomUUID()
