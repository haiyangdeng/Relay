export interface ShellTrayObservation {
  mode?: 'rule' | 'global' | 'direct'
  systemProxy: boolean | undefined
  tun: boolean | undefined
}

export type ShellTrayIconStatus = 'white' | 'blue' | 'green' | 'red'

// Clash Party v2.0.4, ac294fed972c0c25c641abe603c3a6fe709dfdb3:
// tray.ts tooltip and calculateTrayIconStatus semantics, with explicit unknowns.
// Inputs are observations, never saved preferences or permission to act.
export function shellTrayStatus(observation: ShellTrayObservation): {
  icon?: ShellTrayIconStatus
  tooltip: string
} {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation))
    throw new Error('托盘状态未确认。')
  const { mode, systemProxy, tun } = observation
  if (
    (mode !== undefined && !['rule', 'global', 'direct'].includes(mode)) ||
    (systemProxy !== undefined && typeof systemProxy !== 'boolean') ||
    (tun !== undefined && typeof tun !== 'boolean')
  )
    throw new Error('托盘状态未确认。')
  let icon: ShellTrayIconStatus | undefined
  if (systemProxy !== undefined && tun !== undefined) {
    if (systemProxy && tun) icon = 'red'
    else if (systemProxy) icon = 'blue'
    else if (tun) icon = 'green'
    else icon = 'white'
  }
  const state = (enabled: boolean | undefined): string =>
    enabled === undefined ? '未确认' : enabled ? '已开启' : '未开启'
  return {
    ...(icon ? { icon } : {}),
    tooltip: [
      'Relay',
      `模式：${mode === undefined ? '未确认' : mode === 'rule' ? 'Rule' : mode === 'global' ? 'Global' : 'Direct'}`,
      `系统代理：${state(systemProxy)}`,
      `TUN：${state(tun)}`
    ].join('\n')
  }
}
