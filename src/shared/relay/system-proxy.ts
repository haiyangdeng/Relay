import validator from 'validator'

export const defaultSystemBypass = [
  '127.0.0.1',
  '::1',
  'localhost',
  '*.local',
  '192.168.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12'
]
export const defaultPacScript =
  'function FindProxyForURL(url, host) { return "PROXY %proxy-host%:%mixed-port%;"; }'
export interface SystemProxySettings {
  mode: 'manual' | 'pac'
  host: string
  port: number
  socks: boolean
  bypass: string[]
  excludeSimple: boolean
  serviceIDs: string[]
  pacScript: string
}
export interface NativeSystemProxySettings extends Omit<SystemProxySettings, 'pacScript'> {
  pacURL?: string
}
export interface SystemProxyReport {
  status:
    | 'inactive'
    | 'active'
    | 'pending'
    | 'conflict'
    | 'applied'
    | 'restored'
    | 'rolledBack'
    | 'uncertain'
  revision: string
  location: string
  services: {
    id: string
    name: string
    enabled: boolean
    http: boolean
    https: boolean
    socks: boolean
    pac: boolean
  }[]
  canApply: boolean
  canRestore: boolean
  canRetireDetached?: boolean
  recordID?: string
  quitProxyPorts?: number[]
  currentProxyPorts?: number[]
  currentPacURLHashes?: string[]
  warnings: string[]
}
export interface SystemProxyPreparation {
  evidenceId: string
  action: 'apply' | 'restore'
  report: SystemProxyReport
  settings?: SystemProxySettings
}
export interface SystemProxyResult {
  status: 'cancelled' | 'applied' | 'restored' | 'rolledBack' | 'failed' | 'uncertain'
  report?: SystemProxyReport
  warnings: string[]
}
const object = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw)
const clean = (raw: unknown, max: number): raw is string =>
  typeof raw === 'string' &&
  raw.length > 0 &&
  raw.length <= max &&
  Array.from(raw).every(
    (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
  )
export function systemProxySettings(raw: unknown): SystemProxySettings {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(',') !==
      'bypass,excludeSimple,host,mode,pacScript,port,serviceIDs,socks' ||
    !['manual', 'pac'].includes(String(raw.mode)) ||
    !clean(raw.host, 253) ||
    !(validator.isIP(raw.host) || validator.isFQDN(raw.host, { require_tld: false })) ||
    !Number.isInteger(raw.port) ||
    Number(raw.port) < 1024 ||
    Number(raw.port) > 65535 ||
    typeof raw.socks !== 'boolean' ||
    typeof raw.excludeSimple !== 'boolean' ||
    !Array.isArray(raw.bypass) ||
    raw.bypass.length > 256 ||
    raw.bypass.some(
      (v) =>
        !clean(v, 253) ||
        !(
          v === '<local>' ||
          validator.isIP(v) ||
          validator.isIPRange(v) ||
          /^[a-zA-Z0-9*?._-]+$/u.test(v)
        )
    ) ||
    !Array.isArray(raw.serviceIDs) ||
    raw.serviceIDs.length === 0 ||
    raw.serviceIDs.length > 128 ||
    raw.serviceIDs.some((v) => !clean(v, 256)) ||
    new Set(raw.serviceIDs).size !== raw.serviceIDs.length ||
    typeof raw.pacScript !== 'string' ||
    raw.pacScript.length > 65536 ||
    raw.pacScript.includes('\0') ||
    (raw.mode === 'pac' && !raw.pacScript.trim())
  )
    throw new Error('系统代理模式、主机、端口、内网例外或网络服务参数无效。')
  return {
    mode: raw.mode as SystemProxySettings['mode'],
    host: raw.host,
    port: Number(raw.port),
    socks: raw.socks,
    bypass: [...raw.bypass] as string[],
    excludeSimple: raw.excludeSimple,
    serviceIDs: [...raw.serviceIDs] as string[],
    pacScript: raw.pacScript
  }
}
export function systemProxyReport(raw: unknown): SystemProxyReport {
  if (
    !object(raw) ||
    Object.keys(raw).some(
      (key) =>
        ![
          'status',
          'revision',
          'location',
          'services',
          'canApply',
          'canRestore',
          'canRetireDetached',
          'recordID',
          'quitProxyPorts',
          'currentProxyPorts',
          'currentPacURLHashes',
          'warnings'
        ].includes(key)
    ) ||
    ![
      'inactive',
      'active',
      'pending',
      'conflict',
      'applied',
      'restored',
      'rolledBack',
      'uncertain'
    ].includes(String(raw.status)) ||
    !clean(raw.revision, 64) ||
    !/^[a-f0-9]{64}$/u.test(raw.revision) ||
    !clean(raw.location, 256) ||
    typeof raw.canApply !== 'boolean' ||
    typeof raw.canRestore !== 'boolean' ||
    (raw.canRetireDetached !== undefined && typeof raw.canRetireDetached !== 'boolean') ||
    (raw.recordID !== undefined &&
      (typeof raw.recordID !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(raw.recordID))) ||
    !Array.isArray(raw.warnings) ||
    raw.warnings.length > 16 ||
    raw.warnings.some((v) => !clean(v, 4096)) ||
    !Array.isArray(raw.services) ||
    raw.services.length > 128 ||
    raw.services.some(
      (v) =>
        !object(v) ||
        Object.keys(v).sort().join(',') !== 'enabled,http,https,id,name,pac,socks' ||
        !clean(v.id, 256) ||
        !clean(v.name, 1024) ||
        ['enabled', 'http', 'https', 'socks', 'pac'].some((key) => typeof v[key] !== 'boolean')
    )
  )
    throw new Error('系统代理返回信息未确认。')
  if (
    new Set(raw.services.map((v) => v.id)).size !== raw.services.length ||
    (raw.canRestore && !raw.recordID) ||
    (raw.canRetireDetached === true &&
      (!raw.recordID ||
        raw.canApply ||
        !['active', 'pending', 'conflict'].includes(String(raw.status)))) ||
    (raw.currentPacURLHashes !== undefined &&
      (!Array.isArray(raw.currentPacURLHashes) ||
        raw.currentPacURLHashes.length > 4096 ||
        raw.currentPacURLHashes.some(
          (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)
        ) ||
        new Set(raw.currentPacURLHashes).size !== raw.currentPacURLHashes.length)) ||
    (raw.currentProxyPorts !== undefined &&
      (!Array.isArray(raw.currentProxyPorts) ||
        raw.currentProxyPorts.length > 4096 ||
        raw.currentProxyPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
        new Set(raw.currentProxyPorts).size !== raw.currentProxyPorts.length)) ||
    (raw.quitProxyPorts !== undefined &&
      (!Array.isArray(raw.quitProxyPorts) ||
        raw.quitProxyPorts.length > 4096 ||
        raw.quitProxyPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
        new Set(raw.quitProxyPorts).size !== raw.quitProxyPorts.length ||
        raw.status !== 'conflict' ||
        !raw.recordID ||
        raw.canApply ||
        raw.canRestore)) ||
    (['inactive', 'restored'].includes(String(raw.status)) && raw.recordID !== undefined)
  )
    throw new Error('系统代理恢复状态矛盾。')
  return {
    status: raw.status as SystemProxyReport['status'],
    revision: raw.revision,
    location: raw.location,
    services: structuredClone(raw.services) as SystemProxyReport['services'],
    canApply: raw.canApply,
    canRestore: raw.canRestore,
    ...(typeof raw.canRetireDetached === 'boolean'
      ? { canRetireDetached: raw.canRetireDetached }
      : {}),
    ...(typeof raw.recordID === 'string' ? { recordID: raw.recordID } : {}),
    ...(Array.isArray(raw.quitProxyPorts) ? { quitProxyPorts: [...raw.quitProxyPorts] } : {}),
    ...(Array.isArray(raw.currentProxyPorts)
      ? { currentProxyPorts: [...raw.currentProxyPorts] }
      : {}),
    ...(Array.isArray(raw.currentPacURLHashes)
      ? { currentPacURLHashes: [...raw.currentPacURLHashes] }
      : {}),
    warnings: [...raw.warnings] as string[]
  }
}
