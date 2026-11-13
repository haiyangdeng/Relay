import type { RelayGuardComponent, RelayGuardReadiness } from '../../../shared/relay/guard'

export function guardReadinessFixture(): RelayGuardReadiness {
  const component = (): RelayGuardComponent => ({
    presence: 'notBundled',
    identity: 'unconfirmed',
    signature: 'unconfirmed',
    installEntitlement: false,
    networkEntitlement: false,
    sandboxEntitlement: false
  })
  return {
    version: 1,
    readOnly: true,
    buildMode: 'offline',
    liveOperationsAvailable: false,
    protectionVerified: false,
    systemExtension: 'notQueried',
    filterConfiguration: 'notQueried',
    runtimeEnforcement: 'notVerified',
    signingMetadataScope: 'currentArchitecture',
    signatureValidationScope: 'allArchitecturesNoNetwork',
    application: component(),
    extensionComponent: component(),
    sameSigningTeam: 'unconfirmed',
    sameVersion: 'unconfirmed',
    bundleMetadataMatches: false,
    warnings: ['Fixture only; no system filter query or activation.']
  }
}
