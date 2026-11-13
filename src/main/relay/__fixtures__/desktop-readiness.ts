import type { RelayDesktopReadiness } from '../../../shared/relay/protocol'

export function desktopReadinessFixture(): RelayDesktopReadiness {
  return {
    edgeInstalled: true,
    edgePoliciesReady: true,
    edgeClosed: true,
    claudeInstalled: true,
    browserReady: true,
    defaults: { http: 'com.apple.Safari', https: 'com.apple.Safari' },
    sharedDefaults: true,
    records: (['relay', 'legacy'] as const).map((source) => ({
      source,
      state: 'missing',
      phase: 'none',
      decisions: { http: 'notApplicable', https: 'notApplicable' }
    })),
    configurationReady: true,
    readOnly: true,
    startEnabled: false,
    proxy: 'notTested',
    locks: 'notAcquired',
    warnings: ['只读快照，不授权实际登录。']
  }
}
