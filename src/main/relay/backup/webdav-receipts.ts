import { createHash } from 'crypto'
import { lstat, readdir, realpath } from 'fs/promises'
import { join } from 'path'
import { backupAccountSelection } from '../../../shared/relay/backup-accounts'
import { isStrongBackupETag, remoteBackupRequest } from '../../../shared/relay/backup-remote'
import type { RelayStateContext } from '../context'
import { readBinaryResource } from '../resources/source'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { BACKUP_ARCHIVE_MAX_BYTES } from './archive'
import type { RecoveryIdentity } from './recovery-journal'
import type { VerifiedWebdavUpload } from './remote'

export const WEBDAV_RECEIPT_MAX_FRAMES = 10000
const frameLimit = 16384
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const digest = (raw: unknown): raw is string =>
  typeof raw === 'string' && /^[a-f0-9]{64}$/u.test(raw)
const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('备份事实回执无效。')
  return raw as Record<string, unknown>
}
function keys(raw: Record<string, unknown>, allowed: string): void {
  if (Object.keys(raw).sort().join(',') !== allowed) throw new Error('备份事实回执含未知字段。')
}
const frameName = (sequence: number): string => `receipt-${String(sequence).padStart(6, '0')}.json`
const identity = (info: Awaited<ReturnType<typeof lstat>>): RecoveryIdentity => ({
  dev: Number(info.dev),
  ino: Number(info.ino),
  uid: Number(info.uid),
  mode: Number(info.mode)
})
const sameIdentity = (a: RecoveryIdentity, b: RecoveryIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode

export interface WebdavReceiptBinding {
  accountId: string
  directoryURL: string
  username: string
}
export interface WebdavOwnedReceipt extends VerifiedWebdavUpload {
  etag: string
  filename: string
}
export interface WebdavReceiptInventory {
  binding: WebdavReceiptBinding
  scopeSHA256: string
  headSHA256: string | null
  sequence: number
  owned: WebdavOwnedReceipt[]
  // A durable intent without a confirmed terminal is never automatically retried,
  // including after a restart or a fresh authorization. It stays outside owned.
  uncertain: WebdavOwnedReceipt[]
}
export interface WebdavReceiptPublication {
  id: string
  directoryIdentity: RecoveryIdentity
  name: string
  bytes: Buffer
}
type Event =
  | { kind: 'created'; binding: WebdavReceiptBinding; directoryIdentity: RecoveryIdentity }
  | { kind: 'uploaded'; receipt: WebdavOwnedReceipt }
  | { kind: 'deletion-started' | 'deleted' | 'not-submitted'; url: string }
interface Frame {
  version: 1
  id: string
  sequence: number
  parentSHA256: string | null
  event: Event
}
interface Loaded {
  inventory: WebdavReceiptInventory
  directoryIdentity?: RecoveryIdentity
  seenURLs: Set<string>
}
// This opaque, process-local ticket is never serialized. A restarted process
// cannot turn a stranded deletion intent back into automatic deletion authority.
export interface WebdavDeletionTicket {
  readonly headSHA256: string
}

function binding(raw: unknown): WebdavReceiptBinding {
  const value = object(raw)
  keys(value, 'accountId,directoryURL,username')
  const account = backupAccountSelection({ id: value.accountId, revision: '0'.repeat(64) })
  const checked = remoteBackupRequest({
    provider: 'webdav',
    action: 'list',
    proxyPort: 1024,
    url: value.directoryURL,
    username: value.username,
    password: ''
  })
  if (
    typeof checked.url !== 'string' ||
    typeof checked.username !== 'string' ||
    checked.url !== value.directoryURL ||
    checked.username !== value.username
  )
    throw new Error('备份回执目录身份不规范。')
  return { accountId: account.id, directoryURL: checked.url, username: checked.username }
}
function checkedIdentity(raw: unknown): RecoveryIdentity {
  const value = object(raw)
  keys(value, 'dev,ino,mode,uid')
  if (
    ![value.dev, value.ino, value.uid, value.mode].every(
      (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
    ) ||
    Number(value.ino) === 0 ||
    value.uid !== process.getuid?.() ||
    value.mode !== (0o040000 | 0o700)
  )
    throw new Error('备份回执目录身份无效。')
  return {
    dev: Number(value.dev),
    ino: Number(value.ino),
    uid: Number(value.uid),
    mode: Number(value.mode)
  }
}
function receipt(raw: unknown, target: WebdavReceiptBinding): WebdavOwnedReceipt {
  const value = object(raw)
  keys(value, 'envelopeBytes,envelopeSHA256,etag,filename,url')
  if (
    typeof value.url !== 'string' ||
    typeof value.filename !== 'string' ||
    !/^relay-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/u.test(
      value.filename
    ) ||
    new URL(value.filename, target.directoryURL).href !== value.url ||
    !isStrongBackupETag(value.etag) ||
    !digest(value.envelopeSHA256) ||
    !Number.isSafeInteger(value.envelopeBytes) ||
    Number(value.envelopeBytes) < 1 ||
    Number(value.envelopeBytes) > Math.ceil(BACKUP_ARCHIVE_MAX_BYTES * 2.5)
  )
    throw new Error('备份上传事实回执无效。')
  return {
    url: value.url,
    filename: value.filename,
    etag: value.etag,
    envelopeSHA256: value.envelopeSHA256,
    envelopeBytes: Number(value.envelopeBytes)
  }
}

// Independent from every archive/restore root. This stores verified facts, not
// grants or credentials. A caller must obtain fresh Native deletion consent.
// The publisher must pin directory FDs and exclusively append; there is no JS
// path-write fallback. After restart, same-UID replay of any valid historical prefix (including removal
// of every later intent/terminal suffix) is not prevented by this local hash chain.
export class RelayWebdavReceiptStore {
  private readonly files: SubscriptionFiles
  private writing = false
  private readonly observedHeads = new Map<string, Set<string>>()
  private readonly tickets = new Map<WebdavDeletionTicket, { accountId: string; url: string }>()
  constructor(
    private readonly context: RelayStateContext,
    private readonly adapters: {
      createDirectory?(request: {
        id: string
        stateIdentity: RecoveryIdentity
      }): Promise<RecoveryIdentity>
      publish?(request: WebdavReceiptPublication): Promise<void>
    }
  ) {
    this.files = new SubscriptionFiles(context)
  }
  private directory(id: string): string {
    return join(this.context.stateRoot, 'RemoteBackupReceipts', id)
  }
  private async directoryIdentity(id: string): Promise<RecoveryIdentity | undefined> {
    const path = this.directory(id)
    if (!(await this.files.directory(path))) return undefined
    const info = await lstat(path)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode !== (0o040000 | 0o700) ||
      info.uid !== process.getuid?.() ||
      (await realpath(path)) !== path
    )
      throw new Error('备份事实回执目录不安全。')
    return identity(info)
  }
  private async load(target: WebdavReceiptBinding): Promise<Loaded> {
    const before = await this.directoryIdentity(target.accountId),
      scopeSHA256 = sha(JSON.stringify(target)),
      empty: WebdavReceiptInventory = {
        binding: target,
        scopeSHA256,
        headSHA256: null,
        sequence: -1,
        owned: [],
        uncertain: []
      },
      known = this.observedHeads.get(target.accountId)
    if (!before) {
      if (known?.size) throw new Error('备份事实回执历史已消失。')
      return { inventory: empty, seenURLs: new Set() }
    }
    const names = (await readdir(this.directory(target.accountId))).sort()
    if (
      !names.length ||
      names.length > WEBDAV_RECEIPT_MAX_FRAMES ||
      names.some((name, i) => name !== frameName(i))
    )
      throw new Error('备份事实回执缺失、未知或超限。')
    let parent: string | null = null,
      total = 0
    const seenHeads = new Set<string>(),
      seenURLs = new Set<string>(),
      order = new Map<string, number>(),
      owned = new Map<string, WebdavOwnedReceipt>(),
      uncertain = new Map<string, WebdavOwnedReceipt>()
    for (let sequence = 0; sequence < names.length; ++sequence) {
      const bytes = await readBinaryResource(
        join(this.directory(target.accountId), names[sequence]),
        true,
        frameLimit
      )
      total += bytes.length
      if (total > 32 * 1024 * 1024) throw new Error('备份事实回执总量超限。')
      const raw = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      keys(raw, 'event,id,parentSHA256,sequence,version')
      if (
        raw.version !== 1 ||
        raw.id !== target.accountId ||
        raw.sequence !== sequence ||
        raw.parentSHA256 !== parent
      )
        throw new Error('备份事实回执摘要链冲突。')
      const event = object(raw.event)
      if (sequence === 0) {
        keys(event, 'binding,directoryIdentity,kind')
        if (
          event.kind !== 'created' ||
          JSON.stringify(binding(event.binding)) !== JSON.stringify(target) ||
          !sameIdentity(checkedIdentity(event.directoryIdentity), before)
        )
          throw new Error('备份事实回执来源或目录已变化。')
      } else if (event.kind === 'uploaded') {
        keys(event, 'kind,receipt')
        const item = receipt(event.receipt, target)
        if (seenURLs.has(item.url)) throw new Error('备份事实回执重复认领。')
        seenURLs.add(item.url)
        order.set(item.url, sequence)
        owned.set(item.url, item)
      } else {
        keys(event, 'kind,url')
        if (typeof event.url !== 'string') throw new Error('备份删除事实回执无效。')
        if (event.kind === 'deletion-started') {
          const item = owned.get(event.url)
          if (!item) throw new Error('备份删除意图无对应上传回执。')
          owned.delete(event.url)
          uncertain.set(event.url, item)
        } else if (event.kind === 'deleted' || event.kind === 'not-submitted') {
          const item = uncertain.get(event.url)
          if (!item) throw new Error('备份删除终态无对应意图。')
          uncertain.delete(event.url)
          if (event.kind === 'not-submitted') owned.set(event.url, item)
        } else throw new Error('未知备份事实回执事件。')
      }
      parent = sha(bytes)
      seenHeads.add(parent)
    }
    if (known && [...known].some((head) => !seenHeads.has(head)))
      throw new Error('备份事实回执历史出现回退。')
    const after = await this.directoryIdentity(target.accountId)
    if (
      !after ||
      !sameIdentity(before, after) ||
      JSON.stringify(names) !==
        JSON.stringify((await readdir(this.directory(target.accountId))).sort())
    )
      throw new Error('备份事实回执读取期间已变化。')
    this.observedHeads.set(target.accountId, seenHeads)
    return {
      inventory: {
        ...empty,
        headSHA256: parent,
        sequence: names.length - 1,
        owned: [...owned.values()].sort(
          (a, b) => (order.get(a.url) ?? -1) - (order.get(b.url) ?? -1)
        ),
        uncertain: [...uncertain.values()].sort(
          (a, b) => (order.get(a.url) ?? -1) - (order.get(b.url) ?? -1)
        )
      },
      directoryIdentity: before,
      seenURLs
    }
  }
  async inspect(raw: WebdavReceiptBinding): Promise<WebdavReceiptInventory> {
    return structuredClone((await this.load(binding(raw))).inventory)
  }
  private async append(
    target: WebdavReceiptBinding,
    current: Loaded,
    event: Event
  ): Promise<Loaded> {
    if (!this.adapters.publish || !current.directoryIdentity)
      throw new Error('备份回执原生发布器不可用。')
    const frame: Frame = {
        version: 1,
        id: target.accountId,
        sequence: current.inventory.sequence + 1,
        parentSHA256: current.inventory.headSHA256,
        event
      },
      bytes = Buffer.from(JSON.stringify(frame) + '\n')
    if (frame.sequence >= WEBDAV_RECEIPT_MAX_FRAMES || bytes.length > frameLimit)
      throw new Error('备份事实回执容量已满。')
    const name = frameName(frame.sequence)
    await this.adapters.publish({
      id: target.accountId,
      directoryIdentity: current.directoryIdentity,
      name,
      bytes
    })
    const next = await this.load(target)
    if (next.inventory.headSHA256 !== sha(bytes)) throw new Error('备份事实回执发布结果未确认。')
    return next
  }
  private async write<T>(operation: () => Promise<T>): Promise<T> {
    if (this.writing) throw new Error('备份事实回执仍在写入。')
    this.writing = true
    try {
      return await operation()
    } finally {
      this.writing = false
    }
  }
  async open(
    raw: WebdavReceiptBinding,
    expectedHead: string | null
  ): Promise<WebdavReceiptInventory> {
    return this.write(async () => {
      const target = binding(raw)
      let current = await this.load(target)
      if (current.inventory.headSHA256 !== expectedHead)
        throw new Error('备份事实回执已变化，请重新授权。')
      if (current.directoryIdentity) return structuredClone(current.inventory)
      if (
        !this.adapters.createDirectory ||
        !this.adapters.publish ||
        !(await this.files.directory(this.context.stateRoot))
      )
        throw new Error('备份回执原生目录发布器不可用。')
      const stateIdentity = identity(await lstat(this.context.stateRoot)),
        created = checkedIdentity(
          await this.adapters.createDirectory({ id: target.accountId, stateIdentity })
        ),
        actual = await this.directoryIdentity(target.accountId)
      if (!actual || !sameIdentity(created, actual)) throw new Error('新备份回执目录身份未确认。')
      current = { ...current, directoryIdentity: created }
      return structuredClone(
        (
          await this.append(target, current, {
            kind: 'created',
            binding: target,
            directoryIdentity: created
          })
        ).inventory
      )
    })
  }
  async recordUploaded(
    raw: WebdavReceiptBinding,
    expectedHead: string,
    value: WebdavOwnedReceipt
  ): Promise<WebdavReceiptInventory> {
    return this.write(async () => {
      const target = binding(raw),
        current = await this.load(target),
        item = receipt(value, target)
      if (current.inventory.headSHA256 !== expectedHead || current.seenURLs.has(item.url))
        throw new Error('备份事实回执已变化或重复。')
      return structuredClone(
        (await this.append(target, current, { kind: 'uploaded', receipt: item })).inventory
      )
    })
  }
  async beginDeletion(
    raw: WebdavReceiptBinding,
    expectedHead: string,
    url: string
  ): Promise<{ inventory: WebdavReceiptInventory; ticket: WebdavDeletionTicket }> {
    return this.write(async () => {
      const target = binding(raw),
        current = await this.load(target)
      if (
        current.inventory.headSHA256 !== expectedHead ||
        !current.inventory.owned.some((item) => item.url === url)
      )
        throw new Error('备份删除回执已变化或不属于已确认集合。')
      // A known capacity limit must fail before recording intent or dispatching
      // a deletion that could never acquire its confirmed terminal receipt.
      if (current.inventory.sequence + 2 >= WEBDAV_RECEIPT_MAX_FRAMES)
        throw new Error('备份事实回执需预留删除终态容量，未开始删除。')
      const next = await this.append(target, current, { kind: 'deletion-started', url }),
        ticket = Object.freeze({ headSHA256: next.inventory.headSHA256 ?? '' })
      if (!digest(ticket.headSHA256)) throw new Error('删除意图摘要未确认。')
      this.tickets.set(ticket, { accountId: target.accountId, url })
      return { inventory: structuredClone(next.inventory), ticket }
    })
  }
  async finishDeletion(
    raw: WebdavReceiptBinding,
    ticket: WebdavDeletionTicket,
    outcome: 'deleted' | 'not-submitted'
  ): Promise<WebdavReceiptInventory> {
    return this.write(async () => {
      const target = binding(raw),
        held = this.tickets.get(ticket),
        current = await this.load(target)
      if (
        !held ||
        held.accountId !== target.accountId ||
        current.inventory.headSHA256 !== ticket.headSHA256 ||
        !current.inventory.uncertain.some((item) => item.url === held.url) ||
        !['deleted', 'not-submitted'].includes(outcome)
      )
        throw new Error('本次删除事实回执已变化或没有在途能力。')
      this.tickets.delete(ticket)
      return structuredClone(
        (await this.append(target, current, { kind: outcome, url: held.url })).inventory
      )
    })
  }
}
