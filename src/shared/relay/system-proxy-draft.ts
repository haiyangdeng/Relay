import {
  defaultPacScript,
  defaultSystemBypass,
  systemProxySettings,
  type SystemProxySettings
} from './system-proxy'

export type SystemProxyDraft = Pick<
  SystemProxySettings,
  'mode' | 'host' | 'socks' | 'bypass' | 'excludeSimple' | 'pacScript'
>
export interface SystemProxyDraftRecord {
  document: SystemProxyDraft
  revision: string
  exists: boolean
}
export interface SystemProxyDraftSaveRequest {
  document: SystemProxyDraft
  expectedRevision: string
}
export const RELAY_SYSTEM_PROXY_DRAFT_CHANNELS = [
  'relaySystemProxyDraftRead',
  'relaySystemProxyDraftSave'
] as const

export function defaultSystemProxyDraft(): SystemProxyDraft {
  return {
    mode: 'manual',
    host: '127.0.0.1',
    socks: false,
    bypass: [...defaultSystemBypass],
    excludeSimple: true,
    pacScript: defaultPacScript
  }
}
const object = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw)
const revision = (raw: unknown): raw is string =>
  typeof raw === 'string' && (raw === '' || /^[a-f0-9]{64}$/u.test(raw))

export function systemProxyDraft(raw: unknown): SystemProxyDraft {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(',') !== 'bypass,excludeSimple,host,mode,pacScript,socks'
  )
    throw new Error('系统代理默认设置字段无效。')
  // Reuse the apply-time field validator without persisting a network-service
  // selection or the other client's port. This does not execute the PAC script.
  const checked = systemProxySettings({ ...raw, port: 18191, serviceIDs: ['draft-validation'] })
  return {
    mode: checked.mode,
    host: checked.host,
    socks: checked.socks,
    bypass: checked.bypass,
    excludeSimple: checked.excludeSimple,
    pacScript: checked.pacScript
  }
}
export function systemProxyDraftRecord(raw: unknown): SystemProxyDraftRecord {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(',') !== 'document,exists,revision' ||
    typeof raw.exists !== 'boolean' ||
    !revision(raw.revision) ||
    raw.exists !== (raw.revision !== '')
  )
    throw new Error('系统代理默认设置读取结果无效。')
  return { document: systemProxyDraft(raw.document), revision: raw.revision, exists: raw.exists }
}
export function systemProxyDraftSaveRequest(raw: unknown): SystemProxyDraftSaveRequest {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(',') !== 'document,expectedRevision' ||
    !revision(raw.expectedRevision)
  )
    throw new Error('系统代理默认设置保存参数无效。')
  return { document: systemProxyDraft(raw.document), expectedRevision: raw.expectedRevision }
}
