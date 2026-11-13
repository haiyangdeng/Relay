import type { RelayRecoveryStatus, RelayRecoveryPreflight } from '../../../shared/relay/protocol'

export function preflightFixture(): RelayRecoveryPreflight {
  return {
    selection: { source: 'relay', id: 'fixture-record' },
    version: 2,
    phase: 'recoveryNeeded',
    revision: 'b'.repeat(64),
    targets: [{ index: 0, target: 'claudeSettings', original: 'verified', current: 'installed' }],
    issues: [],
    requiresLegacyConfirmation: false,
    browser: 'notApplicable',
    fileChecksPassed: true,
    snapshotOnly: true,
    restoreEnabled: false,
    warnings: ['只读时点快照，不代表恢复授权。']
  }
}

export function recoveryFixture(): RelayRecoveryStatus {
  return {
    metadataOnly: true,
    restoreEnabled: true,
    inventories: [
      {
        source: 'relay',
        availability: 'readable',
        complete: true,
        entries: [
          {
            id: 'fixture-record',
            createdAt: '2026-10-23T00:00:00Z',
            version: 2,
            phase: 'recoveryNeeded',
            targetCount: 2
          }
        ]
      },
      { source: 'legacy', availability: 'missing', complete: true, entries: [] }
    ],
    warnings: ['Only journal metadata, no restore preflight.']
  }
}
