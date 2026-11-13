export interface ConnectionAppInfoRequest {
  instanceId: string
  configurationRevision: string
  connectionId: string
}
export interface ConnectionAppInfo {
  status: 'found' | 'unavailable'
  name: string
  icon: string
}
export function connectionAppInfoRequest(input: unknown): ConnectionAppInfoRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('应用图标请求无效。')
  const raw = input as Record<string, unknown>
  if (
    Object.keys(raw).sort().join(',') !== 'configurationRevision,connectionId,instanceId' ||
    typeof raw.instanceId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(raw.instanceId) ||
    typeof raw.configurationRevision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(raw.configurationRevision) ||
    typeof raw.connectionId !== 'string' ||
    !raw.connectionId ||
    raw.connectionId.length > 256 ||
    [...raw.connectionId].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('请选择本次自有实例已读取的连接。')
  return {
    instanceId: raw.instanceId,
    configurationRevision: raw.configurationRevision,
    connectionId: raw.connectionId
  }
}
