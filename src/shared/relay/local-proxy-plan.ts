import { dedicatedListeners, type DedicatedListenerPlan } from './dedicated-listeners'
import { localProxyPort, localResolverMode, type LocalResolverMode } from './local-proxy'
import {
  localProxyPortsFor,
  validateDedicatedPortConflicts,
  type LocalProxyPorts
} from './local-proxy-ports'

// Startup preferences only. Ownership, selected profile, system proxy and TUN
// authority remain in their existing services and are never restored from here.
export interface LocalProxyPlan {
  httpPort: number
  resolverMode: LocalResolverMode
  dedicated?: DedicatedListenerPlan
  ports?: LocalProxyPorts
}
export interface LocalProxyPlanRecord {
  document: LocalProxyPlan
  revision: string
  exists: boolean
}
export interface LocalProxyPlanSaveRequest {
  document: LocalProxyPlan
  expectedRevision: string
}
export const RELAY_LOCAL_PROXY_PLAN_CHANNELS = [
  'relayLocalProxyPlanRead',
  'relayLocalProxyPlanSave'
] as const

export function defaultLocalProxyPlan(): LocalProxyPlan {
  return { httpPort: 18191, resolverMode: 'profile' }
}
const object = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw)
const revision = (raw: unknown): raw is string =>
  typeof raw === 'string' && (raw === '' || /^[a-f0-9]{64}$/u.test(raw))

export function localProxyPlan(raw: unknown): LocalProxyPlan {
  if (
    !object(raw) ||
    !['httpPort,resolverMode', 'dedicated,httpPort,resolverMode'].includes(
      Object.keys(raw)
        .filter((key) => key !== 'ports')
        .sort()
        .join(',')
    ) ||
    (raw.resolverMode !== 'off' && raw.resolverMode !== 'profile')
  )
    throw new Error('Relay 启动设置字段无效。')
  const httpPort = localProxyPort(raw.httpPort),
    resolverMode = localResolverMode(raw.resolverMode),
    dedicated = raw.dedicated === undefined ? undefined : dedicatedListeners(raw.dedicated)
  const ports = localProxyPortsFor(httpPort, raw.ports)
  validateDedicatedPortConflicts(ports, dedicated)
  return {
    httpPort,
    resolverMode,
    ...(dedicated ? { dedicated } : {}),
    ...(raw.ports === undefined ? {} : { ports })
  }
}
export function localProxyPlanRecord(raw: unknown): LocalProxyPlanRecord {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(',') !== 'document,exists,revision' ||
    typeof raw.exists !== 'boolean' ||
    !revision(raw.revision) ||
    raw.exists !== (raw.revision !== '')
  )
    throw new Error('Relay 启动设置读取结果无效。')
  return { document: localProxyPlan(raw.document), revision: raw.revision, exists: raw.exists }
}
export function localProxyPlanSaveRequest(raw: unknown): LocalProxyPlanSaveRequest {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(',') !== 'document,expectedRevision' ||
    !revision(raw.expectedRevision)
  )
    throw new Error('Relay 启动设置保存参数无效。')
  return { document: localProxyPlan(raw.document), expectedRevision: raw.expectedRevision }
}
