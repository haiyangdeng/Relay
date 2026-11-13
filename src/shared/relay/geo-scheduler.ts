import { profileSelection } from './runtime'
import { geoOriginSelection, type GeoOriginSelection } from './geo-origins'
import type { SourceSchedulerState } from './subscription-sources'

export type GeoScheduleTarget = { kind: 'cache' } | { kind: 'tun'; sessionId: string }
export interface GeoScheduleArmRequest {
  origin: GeoOriginSelection
  target: GeoScheduleTarget
}
export interface GeoSchedulerState extends Omit<SourceSchedulerState, 'entries'> {
  entries: (SourceSchedulerState['entries'][number] & { target: GeoScheduleTarget })[]
}
export interface GeoScheduleArmResult {
  status: 'armed' | 'cancelled' | 'busy' | 'unsupported' | 'unavailable'
  state: GeoSchedulerState
}
export function geoScheduleArmRequest(raw: unknown): GeoScheduleArmRequest {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'origin,target'
  )
    throw new Error('地理调度只接受保存来源选择与本次目标。')
  const value = raw as Record<string, unknown>,
    target = value.target
  if (!target || typeof target !== 'object' || Array.isArray(target))
    throw new Error('地理调度目标无效。')
  const item = target as Record<string, unknown>,
    origin = geoOriginSelection(value.origin)
  if (item.kind === 'cache' && Object.keys(item).join(',') === 'kind')
    return { origin, target: { kind: 'cache' } }
  if (item.kind === 'tun' && Object.keys(item).sort().join(',') === 'kind,sessionId')
    return {
      origin,
      target: {
        kind: 'tun',
        sessionId: profileSelection({ id: item.sessionId, sha256: '0'.repeat(64) }).id
      }
    }
  throw new Error('地理调度不能接受地址、PID、路径或权限标志。')
}
