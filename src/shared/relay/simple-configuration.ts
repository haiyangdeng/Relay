import type { RelaySimpleMetadata, RelaySimpleReply } from './simple'

export type RelaySimpleSharedConfigurationKey = 'dns' | 'hosts' | 'sniffer' | 'geodata-mode'
export interface RelaySimpleConfigurationMetadata extends Omit<RelaySimpleMetadata, 'sources'> {
  configurationRevision: string
}
export type RelaySimpleConfigurationCandidate =
  | {
      status: 'available'
      configurationRevision: string
      keys: RelaySimpleSharedConfigurationKey[]
    }
  | { status: 'missing' | 'unavailable' }
export interface RelaySimpleConfigurationSnapshot extends RelaySimpleConfigurationMetadata {
  candidate: RelaySimpleConfigurationCandidate
}
export interface RelaySimpleConfigurationSave {
  expectedRevision: string
  configurationRevision: string
}
export const RELAY_SIMPLE_CONFIGURATION_CHANNELS = [
  'relaySimpleReadConfigurationBinding',
  'relaySimpleSaveConfigurationBinding'
] as const

// Proposed only: no Main/preload registration or private configuration values.
export interface RelaySimpleConfigurationIpcApi {
  relaySimpleReadConfigurationBinding(): Promise<RelaySimpleReply<RelaySimpleConfigurationSnapshot>>
  relaySimpleSaveConfigurationBinding(
    request: RelaySimpleConfigurationSave
  ): Promise<RelaySimpleReply<RelaySimpleConfigurationMetadata>>
}
