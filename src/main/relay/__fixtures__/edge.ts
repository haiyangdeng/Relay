import { edgePolicyKeys, type RelayEdgeInspection } from '../../../shared/relay/edge'

export function edgeFixture(): RelayEdgeInspection {
  return {
    version: 1,
    readOnly: true,
    runtimeVerified: false,
    policySource: 'unconfirmed',
    manualReviewRequired: true,
    edgeInstalled: true,
    policies: edgePolicyKeys.map((key) => ({ key, forced: false, matches: false, valid: false })),
    reviewKeys: [],
    status: 'needsInstall',
    canOpenProfile: true,
    revision: 'a'.repeat(64),
    warnings: ['fixture manual review required']
  }
}
