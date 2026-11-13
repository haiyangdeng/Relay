import type { ObservedConnectionOrder } from './runtime-info'

type PreferenceOrder = NonNullable<IAppConfig['connectionOrderBy']>
const orders: Record<PreferenceOrder, Exclude<ObservedConnectionOrder, 'snapshot'>> = {
  time: 'startedAt',
  upload: 'upload',
  download: 'download',
  uploadSpeed: 'uploadRate',
  downloadSpeed: 'downloadRate'
}

export function connectionSortFromPreferences(
  preferences?: Pick<IAppConfig, 'connectionOrderBy' | 'connectionDirection'>
): { order: ObservedConnectionOrder; descending: boolean } {
  return {
    order: orders[preferences?.connectionOrderBy ?? 'time'],
    descending: preferences?.connectionDirection === 'desc'
  }
}

export function connectionSortPreference(order: string): PreferenceOrder | undefined {
  return (Object.keys(orders) as PreferenceOrder[]).find((key) => orders[key] === order)
}
