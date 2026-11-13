import type { RelayDesktopSnapshot, RelayDesktopResponse } from '../../../shared/relay/desktop'

export function desktopSnapshot(
  phase: RelayDesktopSnapshot['phase'] = 'idle'
): RelayDesktopSnapshot {
  const hasRecord = phase === 'active' || phase === 'recoveryNeeded'
  return {
    phase,
    busy: false,
    hasRecord,
    source: hasRecord ? 'relay' : undefined,
    canClose: phase === 'idle',
    requiresRecoveryConsent: false,
    warnings: ['fixture session state']
  }
}
export function desktopResponse(
  id = 1,
  phase: RelayDesktopSnapshot['phase'] = 'idle',
  closing = false
): RelayDesktopResponse {
  return { version: 1, id, snapshot: desktopSnapshot(phase), closing }
}
