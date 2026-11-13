import type {
  RelaySimpleConfigurationMetadata,
  RelaySimpleConfigurationSnapshot,
  RelaySimpleSharedConfigurationKey
} from '../../../../shared/relay/simple-configuration'
import type { RelaySimpleMetadata } from '../../../../shared/relay/simple'

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
const fail = (): never => {
  throw new Error('Malformed configuration binding response')
}
const fields = (raw: unknown, names: string[]): Record<string, unknown> => {
  if (
    !object(raw) ||
    Object.keys(raw).length !== names.length ||
    !names.every((name) => Object.hasOwn(raw, name))
  )
    return fail()
  return raw
}
const metadataKeys = [
  'exists',
  'revision',
  'publishedRevision',
  'dirty',
  'sharedConfigurationPinned',
  'configurationRevision'
]
const sharedKeys: readonly RelaySimpleSharedConfigurationKey[] = [
  'dns',
  'hosts',
  'sniffer',
  'geodata-mode'
]
export function readConfigurationMetadata(raw: unknown): RelaySimpleConfigurationMetadata {
  const value = fields(raw, metadataKeys)
  if (
    typeof value.exists !== 'boolean' ||
    !(value.exists ? digest(value.revision) : value.revision === '') ||
    !Number.isSafeInteger(value.publishedRevision) ||
    Number(value.publishedRevision) < 0 ||
    typeof value.dirty !== 'boolean' ||
    typeof value.sharedConfigurationPinned !== 'boolean' ||
    !(value.configurationRevision === '' || digest(value.configurationRevision)) ||
    value.sharedConfigurationPinned !== (value.configurationRevision !== '')
  )
    return fail()
  return {
    exists: value.exists,
    revision: value.revision as string,
    publishedRevision: Number(value.publishedRevision),
    dirty: value.dirty,
    sharedConfigurationPinned: value.sharedConfigurationPinned,
    configurationRevision: value.configurationRevision as string
  }
}
export function readConfigurationSnapshot(raw: unknown): RelaySimpleConfigurationSnapshot {
  const value = fields(raw, [...metadataKeys, 'candidate']),
    info = readConfigurationMetadata(
      Object.fromEntries(metadataKeys.map((key) => [key, value[key]]))
    )
  if (!object(value.candidate)) return fail()
  const candidate = value.candidate
  if (candidate.status === 'missing' || candidate.status === 'unavailable') {
    fields(candidate, ['status'])
    return { ...info, candidate: { status: candidate.status } }
  }
  fields(candidate, ['status', 'configurationRevision', 'keys'])
  if (
    candidate.status !== 'available' ||
    !digest(candidate.configurationRevision) ||
    !Array.isArray(candidate.keys) ||
    candidate.keys.length > 4 ||
    new Set(candidate.keys).size !== candidate.keys.length ||
    !candidate.keys.every((key) => sharedKeys.includes(key))
  )
    return fail()
  return {
    ...info,
    candidate: {
      status: 'available',
      configurationRevision: candidate.configurationRevision,
      keys: [...candidate.keys] as RelaySimpleSharedConfigurationKey[]
    }
  }
}
export function mergeConfigurationMetadata(
  info: RelaySimpleConfigurationMetadata,
  sources: RelaySimpleMetadata['sources']
): RelaySimpleMetadata {
  return {
    exists: info.exists,
    revision: info.revision,
    publishedRevision: info.publishedRevision,
    dirty: info.dirty,
    sharedConfigurationPinned: info.sharedConfigurationPinned,
    sources
  }
}
export function verifyConfigurationReceipt(
  before: RelaySimpleConfigurationSnapshot,
  after: RelaySimpleConfigurationMetadata,
  selected: string
): void {
  if (
    after.configurationRevision !== selected ||
    after.publishedRevision !== before.publishedRevision ||
    (before.configurationRevision !== selected &&
      (!after.exists || after.revision === before.revision)) ||
    (before.configurationRevision === selected &&
      (after.revision !== before.revision ||
        after.exists !== before.exists ||
        after.dirty !== before.dirty))
  )
    fail()
}
