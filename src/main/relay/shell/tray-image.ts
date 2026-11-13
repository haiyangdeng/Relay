import { nativeImage, systemPreferences } from 'electron'
import templateIcon from '../../../../resources/relay-tray-template.png?asset'
import blueIcon from '../../../../resources/relay-tray-blue.png?asset'
import greenIcon from '../../../../resources/relay-tray-green.png?asset'
import redIcon from '../../../../resources/relay-tray-red.png?asset'
import blueDarkIcon from '../../../../resources/relay-tray-blue-dark.png?asset'
import greenDarkIcon from '../../../../resources/relay-tray-green-dark.png?asset'
import redDarkIcon from '../../../../resources/relay-tray-red-dark.png?asset'
import { shellTrayIconData, type RelayShellSettings } from '../../../shared/relay/shell'
import { shellTrayStatus, type ShellTrayObservation } from '../../../shared/relay/shell-tray'
import type { TrayFrameColor } from '../../../shared/relay/tray-traffic-frame'

// Relay's reverse squirrel tile, using the upstream six-scale construction.
function scaledTrayImage(
  source: Electron.NativeImage,
  template: boolean,
  height = 18
): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  for (const scaleFactor of [1, 1.25, 1.5, 2, 2.5, 3]) {
    const resized = source.resize({ height: Math.round(height * scaleFactor), quality: 'best' })
    if (!resized.isEmpty()) image.addRepresentation({ scaleFactor, buffer: resized.toPNG() })
  }
  if (image.isEmpty()) throw new Error('托盘图标缩放失败。')
  image.setTemplateImage(template)
  return image
}
export function trayImage(
  settings: Pick<RelayShellSettings, 'disableTrayIconColor' | 'customTrayIcons'>,
  observation: ShellTrayObservation
): Electron.NativeImage {
  const observed = shellTrayStatus(observation).icon,
    status = observed ?? 'white',
    custom =
      (observed ? settings.customTrayIcons[observed] : '') || settings.customTrayIcons.default
  if (custom) {
    const source = nativeImage.createFromDataURL(shellTrayIconData(custom))
    if (source.isEmpty()) throw new Error('托盘PNG解码失败。')
    return scaledTrayImage(source, true, 16)
  }
  // A colored status dot must remain a non-template image; choose the mascot's
  // foreground from the menu bar appearance, independently of Relay's app theme.
  const coloredIcons =
      trayMenuForeground() === '#ffffff'
        ? { blue: blueIcon, green: greenIcon, red: redIcon }
        : { blue: blueDarkIcon, green: greenDarkIcon, red: redDarkIcon },
    colored = !settings.disableTrayIconColor && status !== 'white',
    path = colored ? coloredIcons[status as 'blue' | 'green' | 'red'] : templateIcon
  const source = nativeImage.createFromPath(path)
  if (source.isEmpty()) throw new Error('随包托盘图标不可用。')
  return scaledTrayImage(source, !colored)
}
export function normalizeTrayPNG(bytes: Buffer): string {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.readUInt32BE(16) < 1 ||
    bytes.readUInt32BE(20) < 1 ||
    bytes.readUInt32BE(16) > 1024 ||
    bytes.readUInt32BE(20) > 1024
  )
    throw new Error('请选择1024像素以内的PNG。')
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) throw new Error('PNG图标未解码。')
  const { width, height } = image.getSize(),
    scale = Math.min(1, 64 / width, 64 / height)
  return shellTrayIconData(
    image
      .resize({
        height: Math.max(1, Math.round(height * scale)),
        width: Math.max(1, Math.round(width * scale)),
        quality: 'best'
      })
      .toDataURL()
  )
}

export function trayTrafficStyle(
  settings: Pick<
    RelayShellSettings,
    'disableTrayIconColor' | 'customTrayIcons' | 'trayTrafficTextColor'
  >,
  observation: ShellTrayObservation
): { icon: string; colored: boolean; textColor: string } {
  const observed = shellTrayStatus(observation).icon,
    status = observed ?? 'white',
    custom = !!(
      (observed ? settings.customTrayIcons[observed] : '') || settings.customTrayIcons.default
    ),
    colored = !custom && !settings.disableTrayIconColor && status !== 'white'
  const preference = settings.trayTrafficTextColor
  return {
    icon: trayImage(settings, observation).toDataURL({ scaleFactor: 3 }),
    colored,
    textColor:
      preference === 'white'
        ? '#ffffff'
        : preference === 'black' || !colored
          ? '#000000'
          : trayMenuForeground()
  }
}

export function trayMenuForeground(): TrayFrameColor {
  return process.platform === 'darwin' &&
    systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark'
    ? '#ffffff'
    : '#000000'
}
