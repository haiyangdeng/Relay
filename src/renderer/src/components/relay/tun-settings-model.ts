import { stringify } from 'yaml'
import { ipCIDRValidator } from '@renderer/utils/validate'
import { DEFAULT_MIHOMO_TUN_CONFIG, getDefaultMihomoTunDevice } from '../../../../shared/appConfig'
import {
  configurationEditDocument,
  profileOverridesFor,
  updateProfileOverrides,
  type ConfigurationEditDocument
} from '../../../../shared/relay/configuration-edit'

export const tunSettingsOverrideId = 'relay-tun-settings'
export interface TunSettingsFields {
  stack: string
  device: string
  mtu: number
  autoRoute: boolean
  autoDetect: boolean
  strictRoute: boolean
  dnsMode: string
  dnsHijack: string[]
  exclude: string[]
}
export function tunSettingsFields(raw: unknown, dnsEnabled = false): TunSettingsFields {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw)))
    throw new Error('TUN 设置格式需要核对。')
  const entry = (raw ?? {}) as Record<string, unknown>
  for (const name of ['auto-route', 'auto-detect-interface', 'strict-route'])
    if (entry[name] !== undefined && typeof entry[name] !== 'boolean')
      throw new Error('TUN 开关格式需要核对。')
  for (const name of ['stack', 'device', 'dns-mode'])
    if (entry[name] !== undefined && typeof entry[name] !== 'string')
      throw new Error('TUN 文本设置格式需要核对。')
  if (
    entry['dns-mode'] !== undefined &&
    !['disabled', 'native', 'hijack'].includes(String(entry['dns-mode']))
  )
    throw new Error('TUN 系统 DNS 模式需要核对。')
  if (entry.mtu !== undefined && typeof entry.mtu !== 'number')
    throw new Error('TUN MTU 格式需要核对。')
  for (const name of ['dns-hijack', 'route-exclude-address'])
    if (
      entry[name] !== undefined &&
      (!Array.isArray(entry[name]) || entry[name].some((value) => typeof value !== 'string'))
    )
      throw new Error('TUN 列表格式需要核对。')
  const tun: Record<string, unknown> = {
    ...DEFAULT_MIHOMO_TUN_CONFIG,
    device: getDefaultMihomoTunDevice('darwin'),
    'dns-hijack': dnsEnabled ? DEFAULT_MIHOMO_TUN_CONFIG['dns-hijack'] : [],
    ...entry
  }
  const list = (key: string): string[] =>
    Array.isArray(tun[key]) && tun[key].every((value) => typeof value === 'string')
      ? ([...tun[key]] as string[])
      : []
  return {
    stack: typeof tun.stack === 'string' ? tun.stack : 'mixed',
    device: typeof tun.device === 'string' ? tun.device : 'utun1500',
    mtu: typeof tun.mtu === 'number' ? tun.mtu : 1500,
    autoRoute: tun['auto-route'] === true,
    autoDetect: tun['auto-detect-interface'] === true,
    strictRoute: tun['strict-route'] === true,
    dnsMode: typeof tun['dns-mode'] === 'string' ? tun['dns-mode'] : 'disabled',
    dnsHijack: list('dns-hijack'),
    exclude: list('route-exclude-address')
  }
}
export function updateTunSettings(
  document: ConfigurationEditDocument,
  profileId: string,
  fields: TunSettingsFields
): ConfigurationEditDocument {
  const exclude = fields.exclude.map((value) => value.trim()).filter(Boolean)
  const dnsHijack = fields.dnsHijack.map((value) => value.trim()).filter(Boolean)
  if (
    !['mixed', 'gvisor', 'system'].includes(fields.stack) ||
    !/^[a-zA-Z0-9_.-]{1,32}$/.test(fields.device) ||
    !Number.isInteger(fields.mtu) ||
    fields.mtu < 1280 ||
    fields.mtu > 65535 ||
    !['disabled', 'native', 'hijack'].includes(fields.dnsMode) ||
    exclude.some((value) => !ipCIDRValidator(value)) ||
    dnsHijack.some(
      (value) =>
        !/^(?:(?:tcp|udp):\/\/)?(?:any|\[[0-9a-fA-F:]+\]|[0-9a-fA-F:.]+):\d{1,5}$/.test(value) ||
        Number(value.slice(value.lastIndexOf(':') + 1)) > 65535 ||
        Number(value.slice(value.lastIndexOf(':') + 1)) < 1
    )
  )
    throw new Error('请核对 TUN 网卡名称、MTU、DNS 劫持端口及排除网段。')
  const content = stringify({
    tun: {
      stack: fields.stack,
      device: fields.device,
      mtu: fields.mtu,
      'auto-route': fields.autoRoute,
      'auto-detect-interface': fields.autoDetect,
      'strict-route': fields.strictRoute,
      'dns-mode': fields.dnsMode,
      'dns-hijack': dnsHijack,
      'route-exclude-address': exclude
    }
  })
  const overrides = profileOverridesFor(document, profileId).filter(
    (item) => item.id !== tunSettingsOverrideId
  )
  return configurationEditDocument(
    updateProfileOverrides(document, profileId, [
      ...overrides,
      { id: tunSettingsOverrideId, kind: 'yaml', content }
    ])
  )
}
