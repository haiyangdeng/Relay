import { parseXML } from 'webdav'
import type { RelayWebdavBackupListing } from '../../../shared/relay/backup-remote'
import { isStrongBackupETag } from '../../../shared/relay/backup-remote'
import { BACKUP_ARCHIVE_MAX_BYTES } from './archive'

export const WEBDAV_LIST_MAX_BYTES = 1024 * 1024
export const WEBDAV_LIST_BODY = Buffer.from(
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>'
)
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const control = (text: string): boolean =>
  [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)

export async function parseWebdavListing(
  bytes: Buffer,
  directoryURL: string
): Promise<RelayWebdavBackupListing> {
  if (!bytes.length || bytes.length > WEBDAV_LIST_MAX_BYTES) throw new Error('WebDAV目录响应超限。')
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  // No document type, external/internal entities, comments or CDATA are needed for metadata.
  if (xml.includes('<!') || xml.split('<').length > 20000)
    throw new Error('WebDAV目录XML声明或元素数量无效。')
  const result = await parseXML(xml, {
    attributeNamePrefix: '@',
    attributeParsers: [],
    tagParsers: [],
    clarkNotationProps: true,
    entityDecoder: { limit: { maxTotalExpansions: 0, maxExpandedLength: 0 } }
  })
  const rows: unknown = result.multistatus?.response
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error('WebDAV目录条目超限或无效。')
  const directory = new URL(directoryURL)
  const entries: RelayWebdavBackupListing['entries'] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!object(row) || !object(row.propstat) || !object(row.propstat.prop)) continue
    if (
      typeof row.propstat.status !== 'string' ||
      !/^HTTP\/1\.[01] 200(?: .*)?$/u.test(row.propstat.status)
    )
      continue
    if (
      typeof row.href !== 'string' ||
      row.href.length > 2048 ||
      control(row.href) ||
      row.href.includes('\\')
    )
      throw new Error('WebDAV目录条目地址无效。')
    const url = new URL(row.href, directory)
    if (url.origin !== directory.origin || url.username || url.password || url.hash || url.search)
      throw new Error('WebDAV目录包含其他来源或带凭据的地址。')
    if (url.href === directory.href) continue
    if (!url.pathname.startsWith(directory.pathname)) throw new Error('WebDAV目录包含越界地址。')
    const relative = url.pathname.slice(directory.pathname.length)
    if (!relative || relative.includes('/')) continue
    const name = decodeURIComponent(relative)
    if (control(name) || /[\\/%]/u.test(name) || name === '.' || name === '..' || name.length > 255)
      throw new Error('WebDAV目录文件名无效。')
    const props = row.propstat.prop
    const type = props['{DAV:}resourcetype']
    if (type !== '' && !(object(type) && Object.keys(type).length === 0)) continue
    const format = /\.json$/iu.test(name)
      ? 'relay-envelope'
      : /\.zip$/iu.test(name)
        ? 'legacy-zip'
        : undefined
    if (!format) continue
    const rawSize = props['{DAV:}getcontentlength']
    if (
      (typeof rawSize !== 'number' && typeof rawSize !== 'string') ||
      !/^\d+$/u.test(String(rawSize))
    )
      continue
    const size = Number(rawSize)
    if (!Number.isSafeInteger(size) || size < 1 || size > Math.ceil(BACKUP_ARCHIVE_MAX_BYTES * 2.5))
      continue
    if (seen.has(url.href)) throw new Error('WebDAV目录包含重复候选。')
    seen.add(url.href)
    const modified = props['{DAV:}getlastmodified']
    entries.push({
      url: url.href,
      name,
      envelopeBytes: size,
      ...(isStrongBackupETag(props['{DAV:}getetag']) ? { etag: props['{DAV:}getetag'] } : {}),
      ...(typeof modified === 'string' &&
      modified.length <= 80 &&
      !control(modified) &&
      Number.isFinite(Date.parse(modified))
        ? { modifiedAt: new Date(modified).toISOString() }
        : {}),
      format,
      verified: false
    })
  }
  return { directoryURL: directory.href, scanned: rows.length, entries }
}
