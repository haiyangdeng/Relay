import { stringify } from 'yaml'
import {
  configurationEditDocument,
  profileOverridesFor,
  updateProfileOverrides,
  type ConfigurationEditDocument
} from '../../../../shared/relay/configuration-edit'

export const coreSettingsOverrideId = 'relay-core-settings'
export interface CoreSettingsFields {
  ipv6: boolean
  unifiedDelay: boolean
  tcpConcurrent: boolean
  findProcessMode: 'off' | 'strict' | 'always'
}

export function coreSettingsFields(raw: Record<string, unknown>): CoreSettingsFields {
  for (const key of ['ipv6', 'unified-delay', 'tcp-concurrent'])
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
      throw new Error('内核开关格式需要核对。')
  const process = raw['find-process-mode'] ?? 'off'
  if (process !== 'off' && process !== 'strict' && process !== 'always')
    throw new Error('进程识别模式需要核对。')
  return {
    ipv6: raw.ipv6 === true,
    unifiedDelay: raw['unified-delay'] === true,
    tcpConcurrent: raw['tcp-concurrent'] === true,
    findProcessMode: process
  }
}

export function updateCoreSettings(
  document: ConfigurationEditDocument,
  profileId: string,
  fields: CoreSettingsFields
): ConfigurationEditDocument {
  const values = {
    ipv6: fields.ipv6,
    'tcp-concurrent': fields.tcpConcurrent,
    'unified-delay': fields.unifiedDelay,
    'find-process-mode': fields.findProcessMode
  }
  coreSettingsFields(values)
  const overrides = profileOverridesFor(document, profileId).filter(
    (entry) => entry.id !== coreSettingsOverrideId
  )
  const scoped = updateProfileOverrides(document, profileId, [
    ...overrides,
    {
      id: coreSettingsOverrideId,
      kind: 'yaml',
      content: stringify({
        'unified-delay': fields.unifiedDelay,
        'find-process-mode': fields.findProcessMode
      })
    }
  ])
  return configurationEditDocument({
    ...scoped,
    controlled: { ...scoped.controlled, ipv6: fields.ipv6, 'tcp-concurrent': fields.tcpConcurrent }
  })
}
