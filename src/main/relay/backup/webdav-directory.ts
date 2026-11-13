import { randomUUID } from 'crypto'
import { DOMParser, type Element, type Node } from '@xmldom/xmldom'
import {
  backupAccountMetadata,
  backupAccountSelection,
  type RelayBackupAccount
} from '../../../shared/relay/backup-accounts'
import {
  webdavDirectoryEvidence,
  type RelayWebdavDirectoryPlan,
  type RelayWebdavDirectoryResult,
  type WebdavDirectoryRejection
} from '../../../shared/relay/backup-directory'
import { remoteBackupRequest } from '../../../shared/relay/backup-remote'
import { requestOnce } from '../../resolve/plugin/http-client'
import type { RelayBackupAccountsStore } from './accounts-store'

const responseLimit = 64 * 1024
const propfind = Buffer.from(
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
)
const control = (text: string): boolean =>
  [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const elements = (node: Node): Element[] =>
  Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1)
const dav = (node: Element, name: string): boolean =>
  node.namespaceURI === 'DAV:' && node.localName === name
function one(node: Node, name: string): Element {
  const matches = elements(node).filter((child) => dav(child, name))
  if (matches.length !== 1) throw new Error('WebDAV属性不唯一。')
  return matches[0]
}

// Unlike the existing file listing, this proves the single requested resource
// itself is a DAV collection. Namespace-aware DOM parsing is intentional:
// webdav.parseXML's Clark mode only rewrites direct <prop> children and drops
// declarations needed to distinguish nested DAV:collection from foreign XML.
export function parseWebdavCollection(bytes: Buffer, endpoint: string): boolean {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > responseLimit)
    throw new Error('WebDAV目录属性大小无效。')
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (xml.includes('<!') || xml.split('<').length > 512 || xml.includes('\0'))
    throw new Error('WebDAV目录属性XML无效。')
  const document = new DOMParser({
      onError: () => {
        throw new Error('WebDAV目录属性XML解析失败。')
      }
    }).parseFromString(xml, 'application/xml'),
    root = document.documentElement
  if (!root || !dav(root, 'multistatus')) throw new Error('WebDAV目录属性根无效。')
  const rows = elements(root)
  if (rows.length !== 1 || !dav(rows[0], 'response'))
    throw new Error('Depth 0目录属性必须只返回一个目标。')
  const row = rows[0],
    href = one(row, 'href').textContent ?? ''
  if (!href || href.length > 2048 || control(href) || href.includes('\\'))
    throw new Error('WebDAV目录属性地址无效。')
  const expected = new URL(endpoint),
    actual = new URL(href, expected)
  if (
    actual.href !== expected.href ||
    actual.origin !== expected.origin ||
    actual.username ||
    actual.password ||
    actual.hash ||
    actual.search
  )
    throw new Error('WebDAV目录属性包含其他目标。')
  const stat = one(row, 'propstat'),
    status = one(stat, 'status').textContent ?? ''
  if (!/^HTTP\/1\.[01] 200(?: .*)?$/u.test(status)) throw new Error('目录类型属性未确认。')
  const type = one(one(stat, 'prop'), 'resourcetype')
  return elements(type).some((child) => dav(child, 'collection'))
}

function checkedAccount(value: RelayBackupAccount): RelayBackupAccount {
  const { revision, ...metadata } = value,
    selection = backupAccountSelection({ id: value.id, revision })
  return { ...backupAccountMetadata(metadata), revision: selection.revision }
}
function directoryURLs(account: RelayBackupAccount): {
  directoryURL: string
  parentURL: string
  username: string
} {
  if (account.provider !== 'webdav' || account.state !== 'active')
    throw new Error('请选择已启用的WebDAV账号。')
  const validated = remoteBackupRequest({
    provider: 'webdav',
    action: 'list',
    url: account.directoryURL,
    username: account.username,
    password: '',
    proxyPort: account.proxyPort
  })
  if (typeof validated.url !== 'string' || typeof validated.username !== 'string')
    throw new Error('WebDAV账号目录或用户名无效。')
  const directory = new URL(validated.url)
  if (directory.pathname === '/') throw new Error('站点根目录没有可创建的末层。')
  for (const segment of directory.pathname.slice(1, -1).split('/')) {
    const decoded = decodeURIComponent(segment)
    if (
      !decoded ||
      decoded === '.' ||
      decoded === '..' ||
      control(decoded) ||
      /[\\/%]/u.test(decoded)
    )
      throw new Error('目录路径含歧义分隔符或无效层级。')
  }
  const parent = new URL('..', directory)
  if (parent.origin !== directory.origin || parent.href === directory.href)
    throw new Error('WebDAV父目录无效。')
  return { directoryURL: directory.href, parentURL: parent.href, username: validated.username }
}
function rejection(status: number): WebdavDirectoryRejection | undefined {
  switch (status) {
    case 401:
      return 'authentication'
    case 403:
      return 'forbidden'
    case 404:
    case 409:
      return 'parentMissing'
    case 415:
    case 501:
      return 'unsupported'
    case 423:
      return 'locked'
    case 507:
      return 'storage'
    default:
      return undefined
  }
}

// The fixed upstream backup.ts creates its configured directory with one
// non-recursive MKCOL before upload, but catches every error. We keep only the
// single last-layer operation: no upload, parent creation, overwrite or cleanup.
export function createWebdavDirectoryService(adapters: {
  accounts: Pick<RelayBackupAccountsStore, 'read' | 'credential'>
  confirm(plan: RelayWebdavDirectoryPlan): Promise<boolean>
  assertIdle?(): void
  request?: typeof requestOnce
  now?(): number
}) {
  const now = adapters.now ?? Date.now,
    request = adapters.request ?? requestOnce,
    waiters: Array<() => void> = []
  type Proof = {
    plan: RelayWebdavDirectoryPlan
    account: RelayBackupAccount
    epoch: number
    preparedAt: number
    recheck?: () => void
  }
  let proof: Proof | undefined,
    epoch = 0,
    pending = false,
    closing = false,
    activeEvidenceId: string | undefined,
    controller: AbortController | undefined
  const begin = (): void => {
    if (pending || closing) throw new Error('请等待当前WebDAV目录操作结束。')
    adapters.assertIdle?.()
    pending = true
  }
  const end = (): void => {
    pending = false
    activeEvidenceId = undefined
    controller = undefined
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const whenIdle = (): Promise<void> =>
    pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const cancel = (evidenceId?: string): boolean => {
    if (
      evidenceId !== undefined &&
      evidenceId !== proof?.plan.evidenceId &&
      evidenceId !== activeEvidenceId
    )
      return false
    ++epoch
    proof = undefined
    controller?.abort()
    return true
  }
  return {
    isBusy: (): boolean => pending || closing,
    whenIdle,
    cancel,
    async requestClose(): Promise<void> {
      closing = true
      cancel()
      try {
        await whenIdle()
      } finally {
        closing = false
      }
    },
    async prepare(raw: unknown, recheck?: () => void): Promise<RelayWebdavDirectoryPlan> {
      const selected = backupAccountSelection(raw)
      recheck?.()
      begin()
      const operationEpoch = ++epoch,
        preparedAt = now()
      proof = undefined
      try {
        const account = checkedAccount(await adapters.accounts.read(selected)),
          urls = directoryURLs(account)
        recheck?.()
        if (epoch !== operationEpoch || closing) throw new Error('目录准备已取消。')
        if (account.id !== selected.id || account.revision !== selected.revision)
          throw new Error('账号修订已变化。')
        const plan: RelayWebdavDirectoryPlan = {
          ...selected,
          evidenceId: randomUUID(),
          provider: 'webdav',
          action: 'createDirectory',
          name: account.name,
          ...urls,
          proxyPort: account.proxyPort,
          usesCredential: true,
          parentMustExist: true,
          recursive: false,
          overwrite: false,
          expiresAt: preparedAt + 60000
        }
        proof = { plan, account, epoch: operationEpoch, preparedAt, recheck }
        return structuredClone(plan)
      } finally {
        end()
      }
    },
    async execute(raw: unknown): Promise<RelayWebdavDirectoryResult> {
      const { evidenceId } = webdavDirectoryEvidence(raw),
        prepared = proof
      if (!prepared || prepared.plan.evidenceId !== evidenceId)
        throw new Error('目录操作凭据已失效，请重新准备。')
      begin()
      proof = undefined
      activeEvidenceId = evidenceId
      controller = new AbortController()
      const signal = controller.signal,
        { plan } = prepared
      let submitted = false,
        httpStatus: number | undefined
      const live = (): void => {
        prepared.recheck?.()
        if (
          signal.aborted ||
          closing ||
          epoch !== prepared.epoch ||
          now() < prepared.preparedAt ||
          now() >= plan.expiresAt
        )
          throw new Error('本次目录授权已失效。')
      }
      const verify = async (): Promise<void> => {
        live()
        const account = checkedAccount(
          await adapters.accounts.read({ id: plan.id, revision: plan.revision })
        )
        live()
        if (JSON.stringify(account) !== JSON.stringify(prepared.account))
          throw new Error('保存的账号或目录范围已变化。')
      }
      const result = (
        status: 'rejected' | 'conflict',
        reason: WebdavDirectoryRejection,
        code?: number
      ): RelayWebdavDirectoryResult => ({
        status,
        directoryURL: plan.directoryURL,
        reason,
        ...(code === undefined ? {} : { httpStatus: code })
      })
      try {
        await verify()
        if (!(await adapters.confirm(structuredClone(plan))))
          return { status: 'cancelled', submitted: false }
        await verify()
        const credential = await adapters.accounts.credential({
          id: plan.id,
          revision: plan.revision
        })
        await verify()
        if (JSON.stringify(checkedAccount(credential.account)) !== JSON.stringify(prepared.account))
          throw new Error('保存的凭据范围已变化。')
        const input = remoteBackupRequest({
            provider: 'webdav',
            action: 'list',
            url: plan.directoryURL,
            username: plan.username,
            password: credential.secret,
            proxyPort: plan.proxyPort
          }),
          authorization = `Basic ${Buffer.from(`${input.username}:${input.password}`, 'utf8').toString('base64')}`
        const send = async (
          endpoint: string,
          method: 'PROPFIND' | 'MKCOL'
        ): Promise<{ status: number; bytes: Buffer }> => {
          await verify()
          const url = new URL(endpoint)
          if (
            process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
            (endpoint !== plan.directoryURL && endpoint !== plan.parentURL) ||
            (method === 'MKCOL' && endpoint !== plan.directoryURL) ||
            url.origin !== new URL(plan.directoryURL).origin ||
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.hash ||
            url.search
          )
            throw new Error('WebDAV目录传输边界未通过。')
          live()
          if (method === 'MKCOL') submitted = true
          const response = await request(endpoint, {
            method,
            headers: {
              Authorization: authorization,
              'User-Agent': 'Relay-Backup-Directory',
              'Cache-Control': 'no-cache',
              ...(method === 'PROPFIND'
                ? {
                    Depth: '0',
                    Accept: 'application/xml',
                    'Content-Type': 'application/xml; charset=utf-8'
                  }
                : {})
            },
            ...(method === 'PROPFIND' ? { body: propfind } : {}),
            proxy: { host: '127.0.0.1', port: plan.proxyPort },
            signal,
            binary: true,
            captureRedirects: true,
            timeout: Math.max(1, Math.min(60000, plan.expiresAt - now())),
            maxBytes: responseLimit
          })
          if (method === 'MKCOL') httpStatus = response.status
          await verify()
          if (response.status >= 300 && response.status < 400)
            throw new Error('目录操作拒绝重定向。')
          if (!Buffer.isBuffer(response.bytes)) throw new Error('目录响应未确认。')
          return { status: response.status, bytes: response.bytes }
        }
        const parent = await send(plan.parentURL, 'PROPFIND')
        if (parent.status !== 207)
          return result('rejected', rejection(parent.status) ?? 'protocol', parent.status)
        if (!parseWebdavCollection(parent.bytes, plan.parentURL))
          return result('rejected', 'parentNotCollection', parent.status)
        const created = await send(plan.directoryURL, 'MKCOL')
        if (created.status === 201 || created.status === 405) {
          const checked = await send(plan.directoryURL, 'PROPFIND')
          if (checked.status !== 207) {
            if (created.status === 405) return result('conflict', 'unverified', checked.status)
            return { status: 'uncertain', directoryURL: plan.directoryURL, httpStatus }
          }
          if (!parseWebdavCollection(checked.bytes, plan.directoryURL)) {
            if (created.status === 405)
              return result('conflict', 'targetNotCollection', checked.status)
            return { status: 'uncertain', directoryURL: plan.directoryURL, httpStatus }
          }
          await verify()
          return {
            status: created.status === 201 ? 'created' : 'alreadyExists',
            directoryURL: plan.directoryURL,
            verifiedAt: now()
          }
        }
        // Definite standards-defined rejection is distinct from unknown writes.
        // Unexpected success/redirect/server failures are never retried.
        const reason = created.status < 500 ? rejection(created.status) : undefined
        return reason
          ? result('rejected', reason, created.status)
          : { status: 'uncertain', directoryURL: plan.directoryURL, httpStatus }
      } catch {
        if (submitted) return { status: 'uncertain', directoryURL: plan.directoryURL, httpStatus }
        if (signal.aborted || closing || epoch !== prepared.epoch)
          return { status: 'cancelled', submitted: false }
        return result('rejected', 'unverified')
      } finally {
        end()
      }
    }
  }
}
export type RelayWebdavDirectoryService = ReturnType<typeof createWebdavDirectoryService>
