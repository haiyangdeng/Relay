export const trayTrafficFrameWidth = 156
export const trayTrafficFrameHeight = 36
export const trayTrafficPNGPrefix = 'data:image/png;base64,'
export const trayTrafficFrameLimit = 32768

export type TrayFrameColor = '#000000' | '#ffffff'

export interface TrayTrafficFrameRequest {
  id: string
  icon: string
  iconTint?: TrayFrameColor
  textColor: TrayFrameColor
  up: number
  down: number
}

export function readTrayTrafficFrame(raw: unknown): TrayTrafficFrameRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { id, icon, iconTint, textColor, up, down } = raw as Record<string, unknown>
  const isColor = (value: unknown): value is TrayFrameColor =>
    value === '#000000' || value === '#ffffff'
  if (
    typeof id !== 'string' ||
    id.length !== 36 ||
    typeof icon !== 'string' ||
    !icon.startsWith(trayTrafficPNGPrefix) ||
    icon.length > trayTrafficFrameLimit ||
    (iconTint !== undefined && !isColor(iconTint)) ||
    !isColor(textColor) ||
    typeof up !== 'number' ||
    !Number.isSafeInteger(up) ||
    up < 0 ||
    typeof down !== 'number' ||
    !Number.isSafeInteger(down) ||
    down < 0
  )
    return undefined
  return { id, icon, iconTint, textColor, up, down }
}
