import type { RelayCodePrepared, RelayCodeApplied } from '../../../shared/relay/protocol'
import { preferenceFixture } from './preferences'

export function codeFixture(): RelayCodePrepared {
  return {
    revision: 'c'.repeat(64),
    httpPort: 7890,
    changedTargets: [
      'claudeSettings',
      'assistantPreferences',
      'browserLocalState',
      'browserPreferences'
    ],
    browserState: 'closed',
    helperReady: true,
    canApply: true,
    warnings: ['Prepared only, no writes.']
  }
}
export function appliedCodeFixture(): RelayCodeApplied {
  return {
    status: 'applied',
    backupId: 'fixture-code-backup',
    preferenceSnapshot: { ...preferenceFixture(), source: 'relay' },
    warnings: ['Fixture transaction committed.']
  }
}
