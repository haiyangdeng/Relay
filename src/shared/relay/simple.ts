import type { SimpleModule } from '../simple-config'
import type { RelayProfilePreparation } from './profiles'

export type RelaySimpleCode = 'invalid' | 'stale' | 'cancelled' | 'busy' | 'closed' | 'uncertain'
export type RelaySimpleReply<T> = { status: 'ok'; value: T } | { status: RelaySimpleCode }
export interface RelaySimpleMetadata {
  exists: boolean
  revision: string
  publishedRevision: number
  dirty: boolean
  sharedConfigurationPinned: boolean
  sources: { id: string; name: string; mode: 'extract' | 'inline' | 'http' }[]
}
export interface RelaySimpleEditableDraft extends RelaySimpleMetadata {
  modules: Record<SimpleModule, string>
}
export interface RelaySimpleModuleSave {
  expectedRevision: string
  module: SimpleModule
  text: string
}
export interface RelaySimpleProfileRequest {
  expectedRevision: string
  previewSHA256: string
  name: string
}
export interface RelaySimplePreview {
  yamlSHA256: string
  bytes: number
  errors: string[]
  valid: boolean
}

export const RELAY_SIMPLE_CHANNELS = [
  'relaySimpleReadEditableDraft',
  'relaySimpleSaveModule',
  'relaySimplePreview',
  'relaySimplePrepareProfile',
  'relaySimpleRecover'
] as const

export interface RelaySimpleIpcApi {
  relaySimpleReadEditableDraft(): Promise<RelaySimpleReply<RelaySimpleEditableDraft>>
  relaySimpleSaveModule(
    request: RelaySimpleModuleSave
  ): Promise<RelaySimpleReply<RelaySimpleMetadata>>
  relaySimplePreview(expectedRevision: string): Promise<RelaySimpleReply<RelaySimplePreview>>
  relaySimplePrepareProfile(
    request: RelaySimpleProfileRequest
  ): Promise<RelaySimpleReply<RelayProfilePreparation>>
  relaySimpleRecover(): Promise<RelaySimpleReply<RelaySimpleMetadata>>
}
