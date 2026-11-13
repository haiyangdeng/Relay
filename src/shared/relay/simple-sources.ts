import type { RelaySimpleMetadata, RelaySimpleReply } from './simple'
import type { RelayProfileSelection } from './runtime'
import type { SubscriptionSourceSelection } from './subscription-sources'

export type RelaySimpleProviderOptions = {
  filter?: string
  'exclude-filter'?: string
  'exclude-type'?: string
  'size-limit'?: number
  override?: { tfo?: boolean; mptcp?: boolean; udp?: boolean; 'udp-over-tcp'?: boolean }
}
export interface RelaySimpleSourceValue {
  profile: RelayProfileSelection
  source: SubscriptionSourceSelection | null
  name: string
  mode: 'extract' | 'inline' | 'http'
  prefix: string
  // Provider seconds for HTTP; explicitly preserved dormant value for other modes.
  interval: number
  proxy?: string
  providerOptions?: RelaySimpleProviderOptions
}
export type RelaySimpleSourceMutation =
  | { action: 'add'; expectedRevision: string; value: RelaySimpleSourceValue }
  | {
      action: 'replace'
      expectedRevision: string
      bindingId: string
      value: RelaySimpleSourceValue
    }
  | { action: 'remove'; expectedRevision: string; bindingId: string }
export interface RelaySimpleSourceRow {
  bindingId: string
  profile: RelayProfileSelection
  source: SubscriptionSourceSelection | null
  name: string
  mode: 'extract' | 'inline' | 'http'
  prefix: string
  interval: number
  editable: boolean
  hasUnsupportedOptions: boolean
  proxy?: string
  providerOptions?: RelaySimpleProviderOptions
}
export interface RelaySimpleSourcesSnapshot extends Omit<RelaySimpleMetadata, 'sources'> {
  sources: RelaySimpleSourceRow[]
}
export const RELAY_SIMPLE_SOURCE_CHANNELS = [
  'relaySimpleReadSourceBindings',
  'relaySimpleSaveSourceBinding'
] as const

// Proposed only: no Main/preload registration in this backend slice.
export interface RelaySimpleSourcesIpcApi {
  relaySimpleReadSourceBindings(): Promise<RelaySimpleReply<RelaySimpleSourcesSnapshot>>
  relaySimpleSaveSourceBinding(
    request: RelaySimpleSourceMutation
  ): Promise<RelaySimpleReply<RelaySimpleSourcesSnapshot>>
}
