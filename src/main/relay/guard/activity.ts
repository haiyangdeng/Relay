import type { GuardNativeBridge } from './native-addon'

// Read-only signed Main host path, reusable before runtime service creation.
// This is Relay's own loaded filter fact, never absence of every system filter.
// It neither activates nor saves configuration and has no client launch path.
export async function inspectGuardActivity(
  bridge: GuardNativeBridge
): Promise<'inactive' | 'active' | 'unknown'> {
  if (bridge.pending()) return 'unknown'
  try {
    const report = await bridge.request('status')
    if (
      report.pending ||
      ['blocked', 'unavailable', 'uncertain', 'checking'].includes(report.phase)
    )
      return 'unknown'
    if (report.configuration?.enabled || (report.policy && report.policy.phase !== 'unbound'))
      return 'active'
    const config = report.configuration
    return config && !config.enabled && (config.owned || !config.exists) ? 'inactive' : 'unknown'
  } catch {
    return 'unknown'
  }
}
