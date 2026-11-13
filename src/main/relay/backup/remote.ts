import { createHash } from 'crypto'
import { requestOnce, type PluginRequestOptions } from '../../resolve/plugin/http-client'
import { encryptAgeContent, decryptAgeContent, isAgeArmored } from '../../utils/age'
import {
  remoteBackupEndpoint,
  remoteBackupRequest,
  isStrongBackupETag,
  type RelayRemoteBackupRequest,
  type RelayGistBackupListing,
  type RelayRemoteBackupListing
} from '../../../shared/relay/backup-remote'
import { BACKUP_ARCHIVE_MAX_BYTES } from './archive'
import { parseWebdavListing, WEBDAV_LIST_BODY, WEBDAV_LIST_MAX_BYTES } from './webdav-list'

export const GIST_ARCHIVE_MAX_BYTES = 512 * 1024
const envelopeMaxBytes = Math.ceil(BACKUP_ARCHIVE_MAX_BYTES * 2.5)
const gistFile = 'relay-backup.json'
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export async function encodeRemoteArchive(bytes: Buffer, recipient?: string): Promise<Buffer> {
  if (!bytes.length || bytes.length > BACKUP_ARCHIVE_MAX_BYTES) throw new Error('备份大小超限。')
  const base64 = bytes.toString('base64')
  const payload = recipient ? await encryptAgeContent(base64, recipient, 'backup') : base64
  return Buffer.from(
    JSON.stringify({
      format: 'relay-backup-remote',
      version: 1,
      encoding: recipient ? 'age' : 'base64',
      archiveBytes: bytes.length,
      archiveSHA256: sha(bytes),
      payloadSHA256: sha(Buffer.from(payload)),
      payload
    })
  )
}
export async function decodeRemoteArchive(
  bytes: Buffer,
  secretKey?: string,
  requireAge = false
): Promise<Buffer> {
  if (!bytes.length || bytes.length > envelopeMaxBytes) throw new Error('远程备份大小超限。')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('远程备份格式无效。')
  }
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'archiveBytes,archiveSHA256,encoding,format,payload,payloadSHA256,version' ||
    value.format !== 'relay-backup-remote' ||
    value.version !== 1 ||
    !['age', 'base64'].includes(String(value.encoding)) ||
    (requireAge && value.encoding !== 'age') ||
    !Number.isSafeInteger(value.archiveBytes) ||
    Number(value.archiveBytes) < 1 ||
    Number(value.archiveBytes) > BACKUP_ARCHIVE_MAX_BYTES ||
    typeof value.archiveSHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.archiveSHA256) ||
    typeof value.payloadSHA256 !== 'string' ||
    typeof value.payload !== 'string' ||
    sha(Buffer.from(value.payload)) !== value.payloadSHA256
  )
    throw new Error('远程备份元数据或内容摘要无效。')
  if (value.encoding === 'age' && !isAgeArmored(value.payload)) throw new Error('AGE备份格式无效。')
  let base64: string
  try {
    base64 =
      value.encoding === 'age'
        ? await decryptAgeContent(value.payload, secretKey, 'backup')
        : value.payload
  } catch {
    throw new Error('AGE备份解密失败，请检查本次私钥。')
  }
  if (
    base64.length !== Math.ceil(Number(value.archiveBytes) / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)
  )
    throw new Error('备份Base64或大小无效。')
  const archive = Buffer.from(base64, 'base64')
  if (
    archive.length !== value.archiveBytes ||
    archive.toString('base64') !== base64 ||
    sha(archive) !== value.archiveSHA256
  )
    throw new Error('远程备份完整性未通过。')
  return archive
}

// Main-only upload capability. Existing manual callers keep their four-argument
// contract; background callers also bind the final synchronous dispatch edge.
export interface RemoteBackupUploadGuards {
  assertLive?(): void
  submitted?(): void
  verified?(receipt: Readonly<VerifiedWebdavUpload>): void
}
export interface VerifiedWebdavUpload {
  url: string
  envelopeSHA256: string
  envelopeBytes: number
  etag?: string
}
export function createRemoteBackupTransport(request: typeof requestOnce = requestOnce) {
  const send = async (
    url: string,
    input: RelayRemoteBackupRequest,
    method: PluginRequestOptions['method'],
    signal: AbortSignal,
    body?: Buffer,
    beforeSend?: () => Promise<void>,
    submitted?: () => void,
    assertLive?: () => void,
    observeSubmitted?: () => void
  ): Promise<{ status: number; bytes: Buffer; more: boolean; etag?: string }> => {
    await beforeSend?.()
    if (signal.aborted) throw new Error('远程备份传输未确认，操作已取消。')
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
      throw new Error('TLS校验关闭时不能传输备份凭据。')
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.username || target.password || target.hash)
      throw new Error('备份传输只允许绑定的HTTPS来源。')
    const headers: Record<string, string> =
      input.provider === 'webdav'
        ? {
            Authorization: `Basic ${Buffer.from(`${input.username}:${input.password}`).toString('base64')}`
          }
        : {
            Authorization: `Bearer ${input.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
    const options: PluginRequestOptions = {
      method,
      body,
      headers: {
        ...headers,
        'User-Agent': 'Relay-Backup',
        ...(body
          ? {
              'Content-Type':
                method === 'PROPFIND' ? 'application/xml; charset=utf-8' : 'application/json'
            }
          : {}),
        ...(method === 'PROPFIND'
          ? { Depth: input.action === 'delete' ? '0' : '1', Accept: 'application/xml' }
          : {}),
        ...(method === 'DELETE' && input.etag ? { 'If-Match': input.etag } : {}),
        ...(method === 'GET' && input.action === 'delete' && input.etag
          ? { 'If-Match': input.etag }
          : {}),
        ...(method === 'HEAD' ? { 'Cache-Control': 'no-cache' } : {}),
        ...(method === 'PUT' ? { 'If-None-Match': '*' } : {})
      },
      timeout: 60000,
      maxBytes:
        input.archiveFormat === 'legacy-zip'
          ? BACKUP_ARCHIVE_MAX_BYTES
          : input.provider === 'gist'
            ? 2 * 1024 * 1024
            : input.action === 'delete' && method !== 'GET'
              ? 64 * 1024
              : input.action === 'list'
                ? WEBDAV_LIST_MAX_BYTES
                : envelopeMaxBytes,
      proxy: { host: '127.0.0.1', port: input.proxyPort },
      signal,
      binary: true,
      captureRedirects: true
    }
    // Only an internal local marker may run between this guard and dispatch.
    // Public observers can reenter/cancel, so notify after request() has been
    // called. Even an observer failure must drain that already-started promise.
    assertLive?.()
    submitted?.()
    let pending: ReturnType<typeof request>
    let observerFailed = false
    try {
      pending = request(target.href, options)
    } finally {
      try {
        observeSubmitted?.()
      } catch {
        observerFailed = true
      }
    }
    const response = await pending
    if (observerFailed) throw new Error('远程备份提交后的状态通知未确认。')
    assertLive?.()
    await beforeSend?.()
    if (signal.aborted) throw new Error('远程备份传输未确认，操作已取消。')
    assertLive?.()
    if (response.status >= 300 && response.status < 400)
      throw new Error('远程备份拒绝重定向；凭据未转发。')
    return {
      status: response.status,
      bytes: response.bytes ?? Buffer.from(response.body),
      ...(isStrongBackupETag(response.headers.etag) ? { etag: response.headers.etag } : {}),
      more:
        typeof response.headers.link === 'string' && /;\s*rel="next"/u.test(response.headers.link)
    }
  }
  const gistContent = (bytes: Buffer, id?: string): { id: string; envelope: Buffer } => {
    let result: unknown
    try {
      result = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new Error('Gist响应格式无效。')
    }
    if (
      !object(result) ||
      result.public !== false ||
      result.truncated === true ||
      typeof result.id !== 'string' ||
      !/^[a-f0-9]{5,64}$/u.test(result.id) ||
      (id && result.id !== id) ||
      !object(result.files) ||
      Object.keys(result.files).join(',') !== gistFile
    )
      throw new Error('Gist必须是指定的非公开完整备份。')
    const file = result.files[gistFile]
    if (
      !object(file) ||
      file.truncated !== false ||
      typeof file.content !== 'string' ||
      Buffer.byteLength(file.content) > 1024 * 1024
    )
      throw new Error('Gist备份已截断或超限；不读取raw_url。')
    return { id: result.id, envelope: Buffer.from(file.content) }
  }
  const deleteFile = async (
    input: RelayRemoteBackupRequest,
    signal: AbortSignal,
    beforeSend?: () => Promise<void>,
    guards?: Pick<RemoteBackupUploadGuards, 'assertLive' | 'submitted'>
  ): Promise<{ status: 'deleted' | 'conflict' | 'uncertain' | 'cancelled' }> => {
    if (input.provider !== 'webdav' || input.action !== 'delete' || !isStrongBackupETag(input.etag))
      throw new Error('远端删除参数无效。')
    const endpoint = remoteBackupEndpoint(input)
    let submitted = false
    try {
      const before = await send(
        endpoint,
        input,
        'PROPFIND',
        signal,
        WEBDAV_LIST_BODY,
        beforeSend,
        undefined,
        guards?.assertLive
      )
      if (signal.aborted) return { status: 'cancelled' }
      if (before.status !== 207) return { status: 'conflict' }
      const checked = await parseWebdavListing(before.bytes, new URL('.', endpoint).href)
      if (
        checked.scanned !== 1 ||
        checked.entries.length !== 1 ||
        checked.entries[0].url !== endpoint ||
        checked.entries[0].etag !== input.etag
      )
        return { status: 'conflict' }
      if (signal.aborted) return { status: 'cancelled' }
      const removed = await send(
        endpoint,
        input,
        'DELETE',
        signal,
        undefined,
        beforeSend,
        () => {
          submitted = true
        },
        guards?.assertLive,
        guards?.submitted
      )
      if (removed.status === 412) return { status: 'conflict' }
      if (![200, 204].includes(removed.status)) return { status: 'uncertain' }
      const after = await send(
        endpoint,
        input,
        'HEAD',
        signal,
        undefined,
        beforeSend,
        undefined,
        guards?.assertLive
      )
      return { status: !signal.aborted && after.status === 404 ? 'deleted' : 'uncertain' }
    } catch {
      if (submitted) return { status: 'uncertain' }
      if (signal.aborted) return { status: 'cancelled' }
      throw new Error('删除尚未发送；请核对目标、凭据及服务端ETag支持。')
    }
  }
  return {
    delete: deleteFile,
    async deleteOwned(
      input: RelayRemoteBackupRequest,
      expected: { envelopeSHA256: string; envelopeBytes: number },
      signal: AbortSignal,
      beforeSend?: () => Promise<void>,
      guards?: Pick<RemoteBackupUploadGuards, 'assertLive' | 'submitted'>
    ): Promise<{ status: 'deleted' | 'conflict' | 'uncertain' | 'cancelled' }> {
      if (
        input.provider !== 'webdav' ||
        input.action !== 'delete' ||
        !isStrongBackupETag(input.etag) ||
        !/^[a-f0-9]{64}$/u.test(expected.envelopeSHA256) ||
        !Number.isSafeInteger(expected.envelopeBytes) ||
        expected.envelopeBytes < 1 ||
        expected.envelopeBytes > envelopeMaxBytes
      )
        throw new Error('本次已确认备份版本无效。')
      const endpoint = remoteBackupEndpoint(input)
      try {
        const checked = await send(
          endpoint,
          input,
          'GET',
          signal,
          undefined,
          beforeSend,
          undefined,
          guards?.assertLive
        )
        if (
          checked.status !== 200 ||
          checked.etag !== input.etag ||
          checked.bytes.length !== expected.envelopeBytes ||
          sha(checked.bytes) !== expected.envelopeSHA256
        )
          return { status: 'conflict' }
        return await deleteFile(input, signal, beforeSend, guards)
      } catch {
        if (signal.aborted) return { status: 'cancelled' }
        throw new Error('本次备份版本复核未通过；未自动重试。')
      }
    },
    async list(
      input: RelayRemoteBackupRequest,
      signal: AbortSignal,
      beforeSend?: () => Promise<void>
    ): Promise<RelayRemoteBackupListing> {
      if (input.action !== 'list') throw new Error('仅支持本次备份候选列表。')
      if (input.provider === 'webdav') {
        const response = await send(
          remoteBackupEndpoint(input),
          input,
          'PROPFIND',
          signal,
          WEBDAV_LIST_BODY,
          beforeSend
        )
        if (signal.aborted || response.status !== 207) throw new Error('WebDAV目录读取未确认。')
        return parseWebdavListing(response.bytes, remoteBackupEndpoint(input))
      }
      const response = await send(
        remoteBackupEndpoint(input),
        input,
        'GET',
        signal,
        undefined,
        beforeSend
      )
      if (signal.aborted || response.status !== 200) throw new Error('Gist列表读取未确认。')
      const raw: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)
      )
      if (!Array.isArray(raw) || raw.length > 100) throw new Error('Gist列表超限或格式无效。')
      const entries: RelayGistBackupListing['entries'] = []
      const ids = new Set<string>()
      for (const row of raw) {
        if (
          !object(row) ||
          row.public !== false ||
          row.truncated === true ||
          typeof row.id !== 'string' ||
          !/^[a-f0-9]{5,64}$/u.test(row.id) ||
          typeof row.updated_at !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(row.updated_at) ||
          !Number.isFinite(Date.parse(row.updated_at)) ||
          !object(row.files) ||
          Object.keys(row.files).join(',') !== gistFile
        )
          continue
        const file = row.files[gistFile]
        if (
          !object(file) ||
          file.filename !== gistFile ||
          file.truncated === true ||
          !Number.isSafeInteger(file.size) ||
          Number(file.size) < 1 ||
          Number(file.size) > 1024 * 1024
        )
          continue
        if (ids.has(row.id)) throw new Error('Gist列表包含重复ID，未返回不完整候选。')
        ids.add(row.id)
        entries.push({
          id: row.id,
          updatedAt: row.updated_at,
          envelopeBytes: Number(file.size),
          verified: false
        })
      }
      const page = input.page ?? 1
      return {
        page,
        ...(response.more && page < 1000 ? { nextPage: page + 1 } : {}),
        scanned: raw.length,
        entries
      }
    },
    async download(
      input: RelayRemoteBackupRequest,
      signal: AbortSignal,
      beforeSend?: () => Promise<void>,
      guards?: Pick<RemoteBackupUploadGuards, 'assertLive'>
    ): Promise<Buffer> {
      const checked = input.archiveFormat === undefined ? input : remoteBackupRequest(input),
        endpoint = remoteBackupEndpoint(checked)
      const response = await send(
        endpoint,
        checked,
        'GET',
        signal,
        undefined,
        beforeSend,
        undefined,
        guards?.assertLive
      )
      if (response.status !== 200) throw new Error('远程备份读取失败。')
      if (checked.archiveFormat === 'legacy-zip') {
        if (!response.bytes.length || response.bytes.length > BACKUP_ARCHIVE_MAX_BYTES)
          throw new Error('旧Clash ZIP下载大小无效。')
        return Buffer.from(response.bytes)
      }
      const envelope =
        checked.provider === 'gist'
          ? gistContent(response.bytes, checked.gistId).envelope
          : response.bytes
      const archive = await decodeRemoteArchive(
        envelope,
        checked.secretKey,
        checked.provider === 'gist'
      )
      if (checked.provider === 'gist' && archive.length > GIST_ARCHIVE_MAX_BYTES)
        throw new Error('Gist备份大小超限。')
      return archive
    },
    async upload(
      input: RelayRemoteBackupRequest,
      envelope: Buffer,
      signal: AbortSignal,
      beforeSend?: () => Promise<void>,
      guards?: RemoteBackupUploadGuards
    ): Promise<{ status: 'uploaded' | 'uncertain'; gistId?: string }> {
      let wrote = false
      let gistId: string | undefined
      try {
        if (input.provider === 'webdav') {
          const created = await send(
            remoteBackupEndpoint(input),
            input,
            'PUT',
            signal,
            envelope,
            beforeSend,
            () => {
              wrote = true
            },
            guards?.assertLive,
            guards?.submitted
          )
          if (created.status === 412) return { status: 'uncertain' }
          if (created.status !== 201) return { status: 'uncertain' }
          const verified = await send(
            remoteBackupEndpoint(input),
            input,
            'GET',
            signal,
            undefined,
            beforeSend,
            undefined,
            guards?.assertLive
          )
          if (
            verified.status !== 200 ||
            !verified.bytes.equals(envelope) ||
            (guards?.verified !== undefined &&
              created.etag !== undefined &&
              verified.etag !== undefined &&
              verified.etag !== created.etag)
          )
            return { status: 'uncertain' }
          guards?.verified?.(
            Object.freeze({
              url: remoteBackupEndpoint(input),
              envelopeSHA256: sha(verified.bytes),
              envelopeBytes: verified.bytes.length,
              ...(verified.etag ? { etag: verified.etag } : {})
            })
          )
        } else {
          if (envelope.length > 1024 * 1024) throw new Error('Gist加密备份超过单文件限制。')
          const created = await send(
            'https://api.github.com/gists',
            input,
            'POST',
            signal,
            Buffer.from(
              JSON.stringify({
                description: 'Relay encrypted backup',
                public: false,
                files: { [gistFile]: { content: envelope.toString('utf8') } }
              })
            ),
            beforeSend,
            () => {
              wrote = true
            },
            guards?.assertLive,
            guards?.submitted
          )
          if (created.status !== 201) return { status: 'uncertain' }
          gistId = gistContent(created.bytes).id
          const verified = await send(
            `https://api.github.com/gists/${gistId}`,
            input,
            'GET',
            signal,
            undefined,
            beforeSend,
            undefined,
            guards?.assertLive
          )
          if (
            verified.status !== 200 ||
            !gistContent(verified.bytes, gistId).envelope.equals(envelope)
          )
            return { status: 'uncertain', gistId }
        }
        return { status: 'uploaded', gistId }
      } catch {
        if (wrote) return { status: 'uncertain', gistId }
        throw new Error('远程备份尚未发送。')
      }
    }
  }
}
