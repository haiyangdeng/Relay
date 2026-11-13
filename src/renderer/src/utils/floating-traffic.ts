import {
  copyFloatingTrafficSample,
  type RelayFloatingTrafficSnapshot
} from '../../../shared/relay/floating-traffic'
import { calcTraffic } from './calc'

// /traffic up/down are the Core's current byte rates, not connection totals.
export function formatFloatingTraffic(
  snapshot: RelayFloatingTrafficSnapshot
): { upload: string; download: string } | undefined {
  if (snapshot.status !== 'ready') return undefined
  const sample = copyFloatingTrafficSample(snapshot.sample)
  if (!sample) return undefined
  return { upload: `${calcTraffic(sample.up)}/s`, download: `${calcTraffic(sample.down)}/s` }
}
