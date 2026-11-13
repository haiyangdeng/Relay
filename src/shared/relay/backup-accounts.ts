import { runtimeGistSource, type RelayRuntimeGistSource } from './runtime-gist'
import {
  remoteBackupRequest,
  type RelayRemoteBackupRequest,
  type RelayRemoteArchiveFormat
} from './backup-remote'

export interface RelayBackupAccount {
  id: string
  revision: string
  name: string
  provider: 'webdav' | 'gist'
  proxyPort: number
  directoryURL?: string
  username?: string
  recipient?: string
  state: 'active' | 'disabled'
  hasCredential: true
  createdAt: number
  updatedAt: number
}
export interface RelayBackupAccountInventory {
  accounts: RelayBackupAccount[]
  incomplete: number
}
export interface RelayBackupAccountSelection {
  id: string
  revision: string
}
export interface RelayBackupAccountSaveRequest {
  id?: string
  revision?: string
  name: string
  provider: 'webdav' | 'gist'
  proxyPort: number
  directoryURL?: string
  username?: string
  recipient?: string
  password?: string
  token?: string
}
export interface RelayBackupAccountRemoteRequest extends RelayBackupAccountSelection {
  action: RelayRemoteBackupRequest['action']
  archiveFormat?: RelayRemoteArchiveFormat
  filename?: string
  gistId?: string
  page?: number
  secretKey?: string
  etag?: string
}
export interface RelayBackupAccountRuntimeRequest extends RelayBackupAccountSelection {
  source?: RelayRuntimeGistSource
  gistId?: string
}
export type BackupAccountMetadata = Omit<RelayBackupAccount, 'revision'>
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('备份账号参数无效。')
  return raw as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('备份账号含未知字段。')
}
function text(value: unknown, max: number, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || !!value.trim()) &&
    value.length <= max &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
}
export function backupAccountSelection(raw: unknown): RelayBackupAccountSelection {
  const value = object(raw)
  fields(value, ['id', 'revision'])
  if (!id(value.id) || !sha(value.revision)) throw new Error('备份账号或修订无效。')
  return { id: value.id, revision: value.revision }
}
export function backupAccountSaveRequest(raw: unknown): RelayBackupAccountSaveRequest {
  const value = object(raw)
  fields(value, [
    'id',
    'revision',
    'name',
    'provider',
    'proxyPort',
    'directoryURL',
    'username',
    'recipient',
    'password',
    'token'
  ])
  if (
    !text(value.name, 120) ||
    (value.provider !== 'webdav' && value.provider !== 'gist') ||
    !Number.isInteger(value.proxyPort) ||
    Number(value.proxyPort) < 1024 ||
    Number(value.proxyPort) > 65535 ||
    ((value.id !== undefined || value.revision !== undefined) &&
      (!id(value.id) || !sha(value.revision))) ||
    (value.recipient !== undefined && !text(value.recipient, 4096, true))
  )
    throw new Error('备份账号名称、类型或代理无效。')
  const common = {
    name: value.name.trim(),
    provider: value.provider,
    proxyPort: Number(value.proxyPort),
    ...(value.id !== undefined ? { id: String(value.id), revision: String(value.revision) } : {}),
    ...(value.recipient ? { recipient: String(value.recipient) } : {})
  }
  if (value.provider === 'webdav') {
    if (
      value.token !== undefined ||
      !text(value.directoryURL, 2048) ||
      !text(value.username, 4096) ||
      (value.password !== undefined && !text(value.password, 4096, true)) ||
      (value.id === undefined && value.password === undefined)
    )
      throw new Error('WebDAV账号需要目录、用户名和首次密码。')
    const request = remoteBackupRequest({
      provider: 'webdav',
      action: 'list',
      proxyPort: common.proxyPort,
      url: value.directoryURL,
      username: value.username,
      password: value.password ?? ''
    })
    return {
      ...common,
      provider: 'webdav',
      directoryURL: request.url,
      username: request.username,
      ...(value.password !== undefined ? { password: String(value.password) } : {})
    }
  }
  if (
    value.directoryURL !== undefined ||
    value.username !== undefined ||
    value.password !== undefined ||
    (value.token !== undefined &&
      (!text(value.token, 500) ||
        value.token.length < 8 ||
        !/^[\x21-\x7e]+$/u.test(value.token))) ||
    (value.id === undefined && value.token === undefined)
  )
    throw new Error('Gist账号需要首次Token，不能混用WebDAV字段。')
  return {
    ...common,
    provider: 'gist',
    ...(value.token !== undefined ? { token: String(value.token) } : {})
  }
}
export function backupAccountMetadata(raw: unknown): BackupAccountMetadata {
  const value = object(raw)
  fields(value, [
    'id',
    'name',
    'provider',
    'proxyPort',
    'directoryURL',
    'username',
    'recipient',
    'state',
    'hasCredential',
    'createdAt',
    'updatedAt'
  ])
  if (
    !id(value.id) ||
    (value.state !== 'active' && value.state !== 'disabled') ||
    value.hasCredential !== true ||
    !Number.isSafeInteger(value.createdAt) ||
    Number(value.createdAt) < 0 ||
    !Number.isSafeInteger(value.updatedAt) ||
    Number(value.updatedAt) < Number(value.createdAt)
  )
    throw new Error('备份账号元数据无效。')
  const checked = backupAccountSaveRequest({
    id: value.id,
    revision: '0'.repeat(64),
    name: value.name,
    provider: value.provider,
    proxyPort: value.proxyPort,
    ...(value.directoryURL !== undefined ? { directoryURL: value.directoryURL } : {}),
    ...(value.username !== undefined ? { username: value.username } : {}),
    ...(value.recipient !== undefined ? { recipient: value.recipient } : {})
  })
  const { id: _id, revision: _revision, ...metadata } = checked
  return {
    ...metadata,
    id: value.id,
    state: value.state as BackupAccountMetadata['state'],
    hasCredential: true,
    createdAt: Number(value.createdAt),
    updatedAt: Number(value.updatedAt)
  }
}
export function backupAccountRemoteRequest(raw: unknown): RelayBackupAccountRemoteRequest {
  const value = object(raw)
  fields(value, [
    'id',
    'revision',
    'action',
    'filename',
    'gistId',
    'page',
    'secretKey',
    'etag',
    'archiveFormat'
  ])
  const selected = backupAccountSelection({ id: value.id, revision: value.revision })
  if (
    Object.hasOwn(value, 'archiveFormat') &&
    (value.action !== 'download' ||
      (value.archiveFormat !== 'relay-envelope' && value.archiveFormat !== 'legacy-zip'))
  )
    throw new Error('备份格式只用于下载，并须显式选择已知格式。')
  if (value.archiveFormat === 'legacy-zip' && Object.hasOwn(value, 'secretKey'))
    throw new Error('旧Clash ZIP整包不接受AGE私钥。')
  if (
    (value.action !== 'upload' &&
      value.action !== 'download' &&
      value.action !== 'list' &&
      value.action !== 'delete') ||
    (value.filename !== undefined &&
      (!text(value.filename, 255) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:json|zip)$/iu.test(value.filename))) ||
    (value.action === 'upload' &&
      value.filename !== undefined &&
      (typeof value.filename !== 'string' || !/\.json$/iu.test(value.filename))) ||
    (value.gistId !== undefined &&
      (typeof value.gistId !== 'string' || !/^[a-f0-9]{5,64}$/u.test(value.gistId))) ||
    (value.page !== undefined &&
      (!Number.isInteger(value.page) || Number(value.page) < 1 || Number(value.page) > 1000)) ||
    (value.secretKey !== undefined && !text(value.secretKey, 4096)) ||
    (value.etag !== undefined && !text(value.etag, 256))
  )
    throw new Error('保存账号的远程操作参数无效。')
  return {
    ...selected,
    action: value.action as RelayRemoteBackupRequest['action'],
    ...(value.archiveFormat !== undefined
      ? { archiveFormat: value.archiveFormat as RelayRemoteArchiveFormat }
      : {}),
    ...(value.filename !== undefined ? { filename: String(value.filename) } : {}),
    ...(value.gistId !== undefined ? { gistId: String(value.gistId) } : {}),
    ...(value.page !== undefined ? { page: Number(value.page) } : {}),
    ...(value.secretKey !== undefined ? { secretKey: String(value.secretKey) } : {}),
    ...(value.etag !== undefined ? { etag: String(value.etag) } : {})
  }
}
export function backupAccountRuntimeRequest(raw: unknown): RelayBackupAccountRuntimeRequest {
  const value = object(raw)
  fields(value, ['id', 'revision', 'gistId', 'source'])
  const selected = backupAccountSelection({ id: value.id, revision: value.revision })
  if (
    value.gistId !== undefined &&
    (typeof value.gistId !== 'string' || !/^[a-f0-9]{5,64}$/u.test(value.gistId))
  )
    throw new Error('运行配置Gist目标无效。')
  const source = runtimeGistSource(value.source)
  return {
    ...selected,
    ...(source ? { source } : {}),
    ...(value.gistId !== undefined ? { gistId: value.gistId } : {})
  }
}
