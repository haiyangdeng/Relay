import type { RelayPreferenceSnapshot } from '../../../shared/relay/protocol'

export function preferenceFixture(): RelayPreferenceSnapshot {
  return {
    source: 'defaults',
    preferences: { httpPort: 7890, node: 'fixture-node', internalExceptions: '' },
    revision: 'a'.repeat(64),
    warnings: []
  }
}
