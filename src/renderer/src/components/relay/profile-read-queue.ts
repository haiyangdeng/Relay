import type {
  RelayProfileGroups,
  RelayProfileInventory,
  RelayProfileRules
} from '../../../../shared/relay/profiles'
import type { SubscriptionSourceInventory } from '../../../../shared/relay/subscription-sources'
import { profileSelection, type RelayProfileSelection } from '../../../../shared/relay/runtime'
import {
  configurationEditDocument,
  type ConfigurationEditDocument,
  type ConfigurationEditPreview
} from '../../../../shared/relay/configuration-edit'

export type ConfigurationPreviewReadRequest = ConfigurationEditDocument & {
  profile: RelayProfileSelection
}

interface ReadResults {
  relayProfileList: RelayProfileInventory
  relaySourceList: SubscriptionSourceInventory
  relayProfileGroupsRead: RelayProfileGroups
  relayProfileRulesRead: RelayProfileRules
  relayConfigEditPreview: ConfigurationEditPreview
}
type ReadChannel = keyof ReadResults
type ReadArguments<Channel extends ReadChannel> = Channel extends
  'relayProfileGroupsRead' | 'relayProfileRulesRead'
  ? [selection: RelayProfileSelection]
  : Channel extends 'relayConfigEditPreview'
    ? [request: ConfigurationPreviewReadRequest]
    : []
type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

// These readers share Main's profile/source locks. Keep a single queue across
// pages and SWR remounts; failed reads release the next reader without retries.
export function createProfileReadQueue(invoke: Invoke) {
  let tail: Promise<void> = Promise.resolve()
  return function read<Channel extends ReadChannel>(
    channel: Channel,
    ...args: ReadArguments<Channel>
  ): Promise<ReadResults[Channel]> {
    let request: (RelayProfileSelection | ConfigurationPreviewReadRequest)[]
    try {
      if (
        (channel === 'relayProfileGroupsRead' || channel === 'relayProfileRulesRead') &&
        args.length === 1
      ) {
        // Pin the requested version before an earlier read completes.
        request = [profileSelection(args[0])]
      } else if (channel === 'relayConfigEditPreview' && args.length === 1) {
        // Freeze nested drafts while waiting; Main still validates and owns
        // the preview lock. This queue never retries or submits writes.
        const input: unknown = structuredClone(args[0])
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('配置预览读取参数无效。')
        const { profile, ...document } = input as Record<string, unknown>
        request = [{ profile: profileSelection(profile), ...configurationEditDocument(document) }]
      } else if (
        (channel === 'relayProfileList' || channel === 'relaySourceList') &&
        args.length === 0
      ) {
        request = []
      } else {
        throw new Error('读取队列仅接受配置列表、订阅来源、指定版本的代理组与规则和配置预览。')
      }
    } catch (error) {
      return Promise.reject(error)
    }
    const result = tail.then(() => invoke(channel, ...request))
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result as Promise<ReadResults[Channel]>
  }
}

export const relayProfileRead = createProfileReadQueue((channel, ...args) =>
  window.electron.ipcRenderer.invoke(channel, ...args)
)
