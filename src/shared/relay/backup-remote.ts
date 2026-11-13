import type { RelayBackupRestorePlan } from './backup'
import type { LegacyClashMigrationReport } from './legacy-clash'

export type RelayRemoteArchiveFormat = 'relay-envelope' | 'legacy-zip'
export interface RelayRemoteBackupRequest {
  provider: 'webdav' | 'gist'
  action: 'upload' | 'download' | 'list' | 'delete'
  proxyPort: number
  url?: string
  username?: string
  password?: string
  gistId?: string
  token?: string
  recipient?: string
  secretKey?: string
  page?: number
  etag?: string
  archiveFormat?: RelayRemoteArchiveFormat
}
export interface RelayGistBackupListing {
  page: number
  nextPage?: number
  scanned: number
  entries: { id: string; updatedAt: string; envelopeBytes: number; verified: false }[]
}
export interface RelayWebdavBackupListing {
  directoryURL: string
  scanned: number
  entries: {
    url: string
    name: string
    envelopeBytes: number
    modifiedAt?: string
    etag?: string
    format: 'relay-envelope' | 'legacy-zip'
    verified: false
  }[]
}
export type RelayRemoteBackupListing = RelayGistBackupListing | RelayWebdavBackupListing
export interface RelayRemoteBackupPlan {
  evidenceId: string
  provider: 'webdav' | 'gist'
  action: RelayRemoteBackupRequest['action']
  endpoint: string
  proxyPort: number
  encrypted: boolean
  containsSecrets: boolean
  archiveSHA256?: string
  archiveBytes?: number
  expiresAt: number
  etag?: string
  archiveFormat?: RelayRemoteArchiveFormat
}
export interface RelayRemoteBackupResult {
  status:
    | 'uploaded'
    | 'prepared'
    | 'inspected'
    | 'cancelled'
    | 'uncertain'
    | 'listed'
    | 'deleted'
    | 'conflict'
  gistId?: string
  plan?: RelayBackupRestorePlan
  listing?: RelayRemoteBackupListing
  report?: LegacyClashMigrationReport
  migrationId?: string
}
export function isStrongBackupETag(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 2 &&
    value.length <= 256 &&
    value.startsWith('"') &&
    value.endsWith('"') &&
    [...value.slice(1, -1)].every(
      (char) => char.charCodeAt(0) >= 33 && char.charCodeAt(0) <= 126 && char !== '"'
    )
  )
}
export function remoteBackupRequest(raw: unknown): RelayRemoteBackupRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('远程备份参数无效。')
  const input = structuredClone(raw) as Record<string, unknown>
  if (
    (input.provider !== 'webdav' && input.provider !== 'gist') ||
    (input.action !== 'upload' &&
      input.action !== 'download' &&
      input.action !== 'list' &&
      input.action !== 'delete') ||
    (input.action === 'delete' && input.provider !== 'webdav') ||
    !Number.isInteger(input.proxyPort) ||
    Number(input.proxyPort) < 1024 ||
    Number(input.proxyPort) > 65535
  )
    throw new Error('远程备份类型或本地代理端口无效。')
  if (
    Object.hasOwn(input, 'archiveFormat') &&
    (input.provider !== 'webdav' ||
      input.action !== 'download' ||
      (input.archiveFormat !== 'relay-envelope' && input.archiveFormat !== 'legacy-zip'))
  )
    throw new Error('备份格式只用于WebDAV下载，并须显式选择Relay封装或旧Clash ZIP。')
  if (
    input.archiveFormat === 'legacy-zip' &&
    (Object.hasOwn(input, 'recipient') || Object.hasOwn(input, 'secretKey'))
  )
    throw new Error('旧Clash ZIP整包不接受AGE接收者或私钥；缓存密钥由旧索引处理。')
  const fields = [
    'provider',
    'action',
    'proxyPort',
    ...(input.provider === 'webdav' && input.action === 'download' ? ['archiveFormat'] : []),
    ...(input.action === 'delete'
      ? ['etag']
      : input.action === 'list'
        ? input.provider === 'gist'
          ? ['page']
          : []
        : ['recipient', 'secretKey']),
    ...(input.provider === 'webdav'
      ? ['url', 'username', 'password']
      : input.action === 'list'
        ? ['token']
        : ['gistId', 'token'])
  ]
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new Error('远程备份字段无效。')
  for (const [key, value] of Object.entries(input)) {
    if (key === 'proxyPort' || key === 'page') continue
    if (
      typeof value !== 'string' ||
      value.length > 4096 ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      throw new Error('远程备份文本或凭据无效。')
  }
  if (input.provider === 'webdav') {
    let url: URL
    try {
      url = new URL(String(input.url))
    } catch {
      throw new Error('请输入指定备份文件的HTTPS地址。')
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (input.action === 'list' ? !url.pathname.endsWith('/') : url.pathname.endsWith('/')) ||
      url.href.length > 2048 ||
      !input.username ||
      String(input.username).includes(':') ||
      typeof input.password !== 'string'
    )
      throw new Error(
        'WebDAV只接受无查询参数的HTTPS指定文件／目录地址与本次凭据；目录列表地址须以斜杠结尾。'
      )
    input.url = url.href
    if (
      input.action === 'delete' &&
      (!isStrongBackupETag(input.etag) || !/\.(?:json|zip)$/iu.test(url.pathname))
    )
      throw new Error('删除只接受指定JSON／ZIP文件和一个完整强ETag；不接受目录、弱ETag或通配符。')
  } else {
    if (
      input.action === 'list' &&
      input.page !== undefined &&
      (!Number.isInteger(input.page) || Number(input.page) < 1 || Number(input.page) > 1000)
    )
      throw new Error('Gist列表页码必须是1至1000的整数。')
    if (
      typeof input.token !== 'string' ||
      input.token.length < 8 ||
      input.token.length > 500 ||
      (input.action === 'download' && !/^[a-f0-9]{5,64}$/u.test(String(input.gistId))) ||
      (input.action === 'upload' && input.gistId)
    )
      throw new Error('Gist凭据或指定ID无效。')
    if (input.action === 'upload' && !input.recipient)
      throw new Error('Gist上传需要AGE接收者，加密后才能上传。')
    if (input.action === 'download' && !input.secretKey)
      throw new Error('Gist下载需要本次AGE私钥。')
  }
  return {
    provider: input.provider as RelayRemoteBackupRequest['provider'],
    action: input.action as RelayRemoteBackupRequest['action'],
    proxyPort: Number(input.proxyPort),
    ...(input.provider === 'webdav'
      ? {
          url: String(input.url),
          username: String(input.username),
          password: String(input.password)
        }
      : { token: String(input.token), ...(input.gistId ? { gistId: String(input.gistId) } : {}) }),
    ...(input.action === 'list' && input.provider === 'gist'
      ? { page: Number(input.page ?? 1) }
      : {}),
    ...(input.recipient ? { recipient: String(input.recipient) } : {}),
    ...(input.secretKey ? { secretKey: String(input.secretKey) } : {}),
    ...(input.action === 'delete' ? { etag: String(input.etag) } : {}),
    ...(input.archiveFormat === 'legacy-zip' || input.archiveFormat === 'relay-envelope'
      ? { archiveFormat: input.archiveFormat }
      : {})
  }
}

export function remoteBackupEndpoint(input: RelayRemoteBackupRequest): string {
  if (input.provider === 'webdav') {
    if (!input.url) throw new Error('WebDAV指定文件地址无效。')
    return input.url
  }
  if (input.action === 'list')
    return `https://api.github.com/gists?per_page=100&page=${input.page ?? 1}`
  return `https://api.github.com/gists${input.action === 'download' ? `/${input.gistId}` : ''}`
}
