import type { RelayProfilePreparation } from './profiles'
import type { RelayProfileSelection } from './runtime'
import type { RelaySimpleProfileRequest, RelaySimpleReply } from './simple'

export interface RelaySimplePublicationState {
  initialized: boolean
  pending: boolean
  closing: boolean
  blocking: boolean
  classification:
    'none' | 'complete' | 'abandoned' | 'incomplete-known-copy' | 'unknown-profile' | 'uncertain'
  needsRetirement: boolean
  markerRevision: string
  operationId?: string
  profile?: RelayProfileSelection
}
export interface RelaySimplePublicationPreparation {
  operationId: string
  preparation: RelayProfilePreparation
}
export interface RelaySimplePublicationResult {
  status: 'published' | 'cancelled' | 'failed' | 'uncertain' | 'abandoned'
  operationId: string
  profile?: RelayProfileSelection
  publishedRevision?: number
  revision?: string
  needsRecovery: boolean
}
export interface RelaySimplePublicationAbandon {
  operationId: string
  expectedMarkerRevision: string
}
export const RELAY_SIMPLE_PUBLICATION_CHANNELS = [
  'relaySimplePublicationState',
  'relaySimplePublicationPrepare',
  'relaySimplePublicationConfirm',
  'relaySimplePublicationRecover',
  'relaySimplePublicationAbandon'
] as const

export interface RelaySimplePublicationIpcApi {
  relaySimplePublicationState(): Promise<RelaySimpleReply<RelaySimplePublicationState>>
  relaySimplePublicationPrepare(
    request: RelaySimpleProfileRequest
  ): Promise<RelaySimpleReply<RelaySimplePublicationPreparation>>
  relaySimplePublicationConfirm(request: {
    evidenceId: string
  }): Promise<RelaySimpleReply<RelaySimplePublicationResult>>
  relaySimplePublicationRecover(): Promise<RelaySimpleReply<RelaySimplePublicationState>>
  relaySimplePublicationAbandon(
    request: RelaySimplePublicationAbandon
  ): Promise<RelaySimpleReply<RelaySimplePublicationResult>>
}
