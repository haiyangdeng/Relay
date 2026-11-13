import type {
  TunRuleProviderEntry,
  TunRuleProviderKind,
  TunRuleProvidersResult
} from '../../../shared/relay/tun-rule-providers'
import type { TunRuleProviderBlobTicket } from './rule-provider-ticket'

export interface TunRuleProvidersNativeSnapshot {
  configurationRevision: string
  generationSHA256: string
  providers: TunRuleProviderEntry[]
  groups: string[][]
}
export interface TunRuleProvidersMutation {
  configurationRevision: string
  expectedGenerationSHA256: string
  provider: string
  oldSHA256: string
  newSHA256: string
  blobId: string
  kind: TunRuleProviderKind
  bytes: number
  filename: string
  // Existing bounded text/YAML/MRS preflight declaration. Native must compare
  // it with actual same-Core counts; this alone proves no Core acceptance.
  declaredRuleCount: number
}
export type TunRuleProvidersChannelResult =
  | {
      status: 'snapshot' | 'updated' | 'unchanged'
      snapshot: TunRuleProvidersNativeSnapshot
    }
  | {
      status: Exclude<TunRuleProvidersResult['status'], 'snapshot' | 'updated' | 'unchanged'>
    }
export interface TunRuleProvidersChannel {
  read(signal: AbortSignal, assertCurrent: () => void): Promise<TunRuleProvidersChannelResult>
  replace(
    input: TunRuleProvidersMutation,
    signal: AbortSignal,
    assertCurrent: () => void
  ): Promise<TunRuleProvidersChannelResult>
  discardBlob(
    ticket: TunRuleProviderBlobTicket
  ): Promise<'discarded' | 'absent' | 'busy' | 'unavailable'>
  cancel(): Promise<void>
  invalidate(): void
  isAvailable(): boolean
  isBusy(): boolean
  whenIdle(): Promise<void>
}
