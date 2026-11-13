import type { RelaySimpleMetadata } from '../../../../shared/relay/simple'
import type { RelayProfileSelection } from '../../../../shared/relay/runtime'
import type { SubscriptionSourceSelection } from '../../../../shared/relay/subscription-sources'
import type {
  RelaySimpleProviderOptions,
  RelaySimpleSourceMutation,
  RelaySimpleSourceRow,
  RelaySimpleSourceValue,
  RelaySimpleSourcesSnapshot
} from '../../../../shared/relay/simple-sources'

const fail = (): never => {
  throw new Error('Malformed or unselected source binding')
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
const plainText = (v: unknown, max = 256, empty = false): v is string =>
  typeof v === 'string' &&
  v.length <= max &&
  (empty || !!v.trim()) &&
  Array.from(v).every(
    (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
  )
function fields(
  v: unknown,
  required: string[],
  optional: string[] = []
): asserts v is Record<string, unknown> {
  if (
    !object(v) ||
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => ![...required, ...optional].includes(k))
  )
    fail()
}
function profile(v: unknown): RelayProfileSelection {
  fields(v, ['id', 'sha256'])
  if (!uuid(v.id) || !digest(v.sha256)) return fail()
  return { id: v.id, sha256: v.sha256 }
}
function originSelection(v: unknown): SubscriptionSourceSelection | null {
  if (v === null) return null
  fields(v, ['id', 'revision'])
  if (!uuid(v.id) || !digest(v.revision)) return fail()
  return { id: v.id, revision: v.revision }
}
function options(v: unknown, mode: RelaySimpleSourceValue['mode']): RelaySimpleProviderOptions {
  if (mode === 'extract') return fail()
  fields(
    v,
    [],
    [
      'filter',
      'exclude-filter',
      'exclude-type',
      'override',
      ...(mode === 'http' ? ['size-limit'] : [])
    ]
  )
  const out: RelaySimpleProviderOptions = {}
  for (const key of ['filter', 'exclude-filter', 'exclude-type'] as const)
    if (Object.hasOwn(v, key)) {
      if (!plainText(v[key], 4096, true)) return fail()
      out[key] = v[key]
    }
  if (Object.hasOwn(v, 'size-limit')) {
    if (
      typeof v['size-limit'] !== 'number' ||
      !Number.isSafeInteger(v['size-limit']) ||
      v['size-limit'] < 0
    )
      return fail()
    out['size-limit'] = v['size-limit']
  }
  if (Object.hasOwn(v, 'override')) {
    fields(v.override, [], ['tfo', 'mptcp', 'udp', 'udp-over-tcp'])
    if (!Object.keys(v.override).length) return fail()
    const override: NonNullable<RelaySimpleProviderOptions['override']> = {}
    for (const key of ['tfo', 'mptcp', 'udp', 'udp-over-tcp'] as const)
      if (Object.hasOwn(v.override, key)) {
        const value = v.override[key]
        if (typeof value !== 'boolean') return fail()
        override[key] = value
      }
    out.override = override
  }
  return out
}
export interface SourceProfileChoice {
  id: string
  sha256: string
  name: string
}
export interface SourceOriginChoice extends SubscriptionSourceSelection {
  name: string
  origin: string
  locked: boolean
  versions: { id: string; createdAt: string; profile: RelayProfileSelection }[]
}
export function parseProfileChoices(raw: unknown): SourceProfileChoice[] {
  fields(raw, ['profiles', 'incomplete', 'activeId', 'warnings'])
  if (
    !Array.isArray(raw.profiles) ||
    raw.profiles.length > 200 ||
    !Number.isSafeInteger(raw.incomplete) ||
    Number(raw.incomplete) < 0 ||
    raw.activeId !== null ||
    !Array.isArray(raw.warnings)
  )
    return fail()
  const choices = raw.profiles.map((item) => {
    fields(item, ['id', 'sha256', 'name', 'createdAt', 'summary'])
    if (!plainText(item.name, 256) || typeof item.createdAt !== 'string') return fail()
    return { ...profile({ id: item.id, sha256: item.sha256 }), name: item.name }
  })
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) return fail()
  return choices
}
export function parseOriginChoices(raw: unknown): SourceOriginChoice[] {
  fields(raw, ['sources', 'incomplete', 'warnings'])
  if (
    !Array.isArray(raw.sources) ||
    raw.sources.length > 200 ||
    !Number.isSafeInteger(raw.incomplete) ||
    Number(raw.incomplete) < 0 ||
    !Array.isArray(raw.warnings)
  )
    return fail()
  let versions = 0
  const choices = raw.sources.map((item) => {
    fields(
      item,
      ['id', 'revision', 'name', 'origin', 'proxyPort', 'createdAt', 'versions', 'locked'],
      ['schedule', 'redirectPolicy', 'hasPrivateHeaders', 'hasAgeIdentity', 'observation']
    )
    const selected = originSelection({ id: item.id, revision: item.revision })
    if (
      !selected ||
      !plainText(item.name, 256) ||
      typeof item.origin !== 'string' ||
      typeof item.locked !== 'boolean' ||
      !Array.isArray(item.versions) ||
      item.versions.length > 100
    )
      return fail()
    const url = new URL(item.origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== item.origin) return fail()
    versions += item.versions.length
    if (versions > 1000) return fail()
    const history = item.versions.map((version) => {
      fields(version, ['id', 'createdAt', 'action', 'profile'], ['restoredFrom'])
      if (
        !uuid(version.id) ||
        typeof version.createdAt !== 'string' ||
        typeof version.action !== 'string' ||
        !['update', 'restore'].includes(version.action)
      )
        return fail()
      return { id: version.id, createdAt: version.createdAt, profile: profile(version.profile) }
    })
    if (new Set(history.map((version) => version.id)).size !== history.length) return fail()
    return {
      ...selected,
      name: item.name,
      origin: item.origin,
      locked: item.locked,
      versions: history
    }
  })
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) return fail()
  return choices
}
export function parseSourceSnapshot(
  raw: unknown,
  readMetadata: (v: unknown) => RelaySimpleMetadata
): RelaySimpleSourcesSnapshot {
  fields(raw, [
    'exists',
    'revision',
    'publishedRevision',
    'dirty',
    'sharedConfigurationPinned',
    'sources'
  ])
  if (!Array.isArray(raw.sources) || raw.sources.length > 64) return fail()
  const sources: RelaySimpleSourceRow[] = raw.sources.map((row) => {
    fields(
      row,
      [
        'bindingId',
        'profile',
        'source',
        'name',
        'mode',
        'prefix',
        'interval',
        'editable',
        'hasUnsupportedOptions'
      ],
      ['proxy', 'providerOptions']
    )
    if (
      !plainText(row.bindingId, 80) ||
      !/^[A-Za-z0-9_-]+$/u.test(row.bindingId) ||
      !plainText(row.name) ||
      !plainText(row.prefix, 256, true) ||
      typeof row.mode !== 'string' ||
      !['extract', 'inline', 'http'].includes(row.mode) ||
      typeof row.interval !== 'number' ||
      !Number.isSafeInteger(row.interval) ||
      row.interval < 0 ||
      row.interval > 2147483647 ||
      typeof row.editable !== 'boolean' ||
      typeof row.hasUnsupportedOptions !== 'boolean' ||
      row.editable === row.hasUnsupportedOptions
    )
      return fail()
    const mode = row.mode as RelaySimpleSourceValue['mode'],
      source = originSelection(row.source)
    if (mode === 'http' && !source) return fail()
    if (
      (!row.editable && (Object.hasOwn(row, 'proxy') || Object.hasOwn(row, 'providerOptions'))) ||
      (row.proxy !== undefined && (mode !== 'http' || !plainText(row.proxy)))
    )
      return fail()
    return {
      bindingId: row.bindingId,
      profile: profile(row.profile),
      source,
      name: row.name,
      mode,
      prefix: row.prefix,
      interval: row.interval,
      editable: row.editable,
      hasUnsupportedOptions: row.hasUnsupportedOptions,
      ...(typeof row.proxy === 'string' ? { proxy: row.proxy } : {}),
      ...(row.providerOptions !== undefined
        ? { providerOptions: options(row.providerOptions, mode) }
        : {})
    }
  })
  if (new Set(sources.map((row) => row.bindingId)).size !== sources.length) return fail()
  const summary = readMetadata({
    ...raw,
    sources: sources.map((row) => ({ id: row.bindingId, name: row.name, mode: row.mode }))
  })
  return { ...summary, sources }
}
export const sourceMetadata = (snapshot: RelaySimpleSourcesSnapshot): RelaySimpleMetadata => ({
  ...snapshot,
  sources: snapshot.sources.map((row) => ({ id: row.bindingId, name: row.name, mode: row.mode }))
})
export interface SimpleSourceForm {
  bindingId?: string
  selectedVersionId?: string
  profile?: RelayProfileSelection
  source: SubscriptionSourceSelection | null
  name: string
  mode: RelaySimpleSourceValue['mode']
  prefix: string
  intervalText: string
  proxy: string
  providerOptions?: RelaySimpleProviderOptions
}
export function sourceForm(row?: RelaySimpleSourceRow): SimpleSourceForm {
  if (row && !row.editable) return fail()
  return row
    ? {
        bindingId: row.bindingId,
        profile: { ...row.profile },
        source: row.source ? { ...row.source } : null,
        name: row.name,
        mode: row.mode,
        prefix: row.prefix,
        intervalText: String(row.interval),
        proxy: row.proxy ?? '',
        ...(row.providerOptions ? { providerOptions: structuredClone(row.providerOptions) } : {})
      }
    : { source: null, name: '', mode: 'extract', prefix: '', intervalText: '3600', proxy: '' }
}
const sameProfile = (a: RelayProfileSelection, b: RelayProfileSelection): boolean =>
  a.id === b.id && a.sha256 === b.sha256
export function sourceFormValue(
  form: SimpleSourceForm,
  snapshot: RelaySimpleSourcesSnapshot,
  profiles: SourceProfileChoice[],
  origins: SourceOriginChoice[]
): RelaySimpleSourceValue {
  if (
    !form.profile ||
    !plainText(form.name) ||
    !plainText(form.prefix, 256, true) ||
    !/^(0|[1-9][0-9]*)$/u.test(form.intervalText)
  )
    return fail()
  const selected = profile(form.profile),
    interval = Number(form.intervalText),
    source = originSelection(form.source)
  if (
    !Number.isSafeInteger(interval) ||
    interval > 2147483647 ||
    !['extract', 'inline', 'http'].includes(form.mode)
  )
    return fail()
  const knownProfile =
    profiles.some((p) => sameProfile(p, selected)) ||
    origins.some((o) => o.versions.some((v) => sameProfile(v.profile, selected))) ||
    snapshot.sources.some((row) => sameProfile(row.profile, selected))
  if (!knownProfile) return fail()
  if (source) {
    const chosen = origins.find((o) => o.id === source.id && o.revision === source.revision)
    if (!chosen || chosen.locked || !chosen.versions.some((v) => sameProfile(v.profile, selected)))
      return fail()
  } else if (form.mode === 'http') return fail()
  if (form.proxy && (form.mode !== 'http' || !plainText(form.proxy))) return fail()
  return {
    profile: selected,
    source,
    name: form.name,
    mode: form.mode,
    prefix: form.prefix,
    interval,
    ...(form.proxy ? { proxy: form.proxy } : {}),
    ...(form.providerOptions !== undefined
      ? { providerOptions: options(form.providerOptions, form.mode) }
      : {})
  }
}
function rowValue(row: RelaySimpleSourceRow): RelaySimpleSourceValue {
  return {
    profile: row.profile,
    source: row.source,
    name: row.name,
    mode: row.mode,
    prefix: row.prefix,
    interval: row.interval,
    ...(row.proxy !== undefined ? { proxy: row.proxy } : {}),
    ...(row.providerOptions !== undefined ? { providerOptions: row.providerOptions } : {})
  }
}
export function verifySourceReceipt(
  before: RelaySimpleSourcesSnapshot,
  after: RelaySimpleSourcesSnapshot,
  request: RelaySimpleSourceMutation
): void {
  if (
    !after.exists ||
    after.publishedRevision !== before.publishedRevision ||
    after.sharedConfigurationPinned !== before.sharedConfigurationPinned
  )
    return fail()
  const equals = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (request.action === 'add') {
    const added = after.sources.filter(
      (row) => !before.sources.some((old) => old.bindingId === row.bindingId)
    )
    if (
      added.length !== 1 ||
      after.sources.length !== before.sources.length + 1 ||
      !added[0].editable ||
      !equals(rowValue(added[0]), request.value) ||
      after.revision === before.revision
    )
      return fail()
  } else {
    const prior = before.sources.find((row) => row.bindingId === request.bindingId),
      current = after.sources.find((row) => row.bindingId === request.bindingId)
    if (!prior) return fail()
    if (request.action === 'remove') {
      if (
        current ||
        after.sources.length !== before.sources.length - 1 ||
        after.revision === before.revision
      )
        return fail()
    } else if (
      !current ||
      !current.editable ||
      after.sources.length !== before.sources.length ||
      !equals(rowValue(current), request.value) ||
      (!equals(rowValue(prior), request.value) && after.revision === before.revision)
    )
      return fail()
  }
  for (const row of before.sources)
    if (request.action === 'add' || row.bindingId !== request.bindingId)
      if (
        !equals(
          after.sources.find((next) => next.bindingId === row.bindingId),
          row
        )
      )
        return fail()
}
