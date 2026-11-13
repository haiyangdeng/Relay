import { createHash, randomUUID } from 'crypto'
import { constants, type BigIntStats } from 'fs'
import { lstat, mkdtemp, mkdir, open, readdir, realpath, type FileHandle } from 'fs/promises'
import { join } from 'path'
import { resourceDescriptor } from '../../../shared/relay/resources'
import {
  checkResourceJob,
  resourceCheckDefinition,
  resourceRuleEntries,
  type ResourceValidationJob
} from '../resources/check-definition'
import { RESOURCE_BYTE_LIMIT } from '../resources/source'
import { tunResourceBlobTicket, type TunResourceBlobTicket } from './resources-channel'
import {
  isTunRuleProviderBlobKind,
  tunRuleProviderBlobTicket,
  type TunRuleProviderBlobTicket
} from './rule-provider-ticket'

export const TUN_RESOURCE_INBOX_MAX_TICKETS = 4
export const TUN_RESOURCE_INBOX_MAX_BYTES = 256 * 1024 * 1024
export type { TunResourceBlobTicket } from './resources-channel'
export type { TunRuleProviderBlobTicket } from './rule-provider-ticket'
export type TunInboxBlobTicket = TunResourceBlobTicket | TunRuleProviderBlobTicket
type Phase =
  | 'checkingRoot'
  | 'creatingDirectory'
  | 'openingFile'
  | 'writing'
  | 'readingBack'
  | 'closing'
  | 'publishing'
interface Retained {
  ticket: TunInboxBlobTicket
  status: 'staged' | 'partial'
  phase: Phase
  writeAttempted: boolean
  diagnostic?: string
}
export interface TunResourceInboxRetainedReport {
  directory: string
  acceptingWrites: boolean
  pending: boolean
  handlesClosed: boolean
  reservedBytes: number
  retained: Retained[]
  diagnostics: string[]
}
export interface TunResourceInbox {
  readonly directory: string
  stage(
    job: ResourceValidationJob,
    signal: AbortSignal,
    assertUI: () => void
  ): Promise<TunResourceBlobTicket>
  stageRuleProvider(
    job: ResourceValidationJob,
    signal: AbortSignal,
    assertUI: () => void
  ): Promise<TunRuleProviderBlobTicket>
  // Main calls this only after an authenticated matching Native discarded or
  // absent ACK, after its replace operation has actually settled. No IO here.
  acknowledgeDiscard(ticket: TunInboxBlobTicket): void
  retained(): TunResourceInboxRetainedReport
  isBusy(): boolean
  whenIdle(): Promise<void>
  dispose(): Promise<TunResourceInboxRetainedReport>
}
interface Pin {
  path: string
  handle: FileHandle
  identity: BigIntStats
}
interface InboxOperation {
  epoch: number
  record?: Retained
}
const uidNow = (): number => {
  const uid = process.getuid?.(),
    effective = process.geteuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) <= 0 || uid !== effective)
    throw new Error('资源暂存仅允许当前非root用户。')
  return Number(uid)
}
const sameDirectory = (a: BigIntStats, b: BigIntStats): boolean =>
  a.isDirectory() &&
  b.isDirectory() &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.mode === b.mode
const sameFile = (a: BigIntStats, b: BigIntStats, atime = false): boolean =>
  a.isFile() &&
  b.isFile() &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.mode === b.mode &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.birthtimeNs === b.birthtimeNs &&
  (!atime || a.atimeNs === b.atimeNs)
const fileMode = (value: BigIntStats, uid: number, size: number): boolean =>
  value.isFile() &&
  value.uid === BigInt(uid) &&
  value.nlink === 1n &&
  (value.mode & 0o7777n) === 0o600n &&
  value.size === BigInt(size)
interface Prepared<T extends TunInboxBlobTicket> {
  bytes: Buffer
  ticket: T
  filename: string
}
function checkJob(job: ResourceValidationJob): ResourceValidationJob {
  if (
    !job ||
    typeof job !== 'object' ||
    Array.isArray(job) ||
    Object.getPrototypeOf(job) !== Object.prototype ||
    Object.keys(job).sort().join(',') !== 'bytes,descriptor,sha256' ||
    !Buffer.isBuffer(job.bytes) ||
    job.bytes.length < 1 ||
    job.bytes.length > RESOURCE_BYTE_LIMIT
  )
    throw new Error('资源暂存工作单无效。')
  const descriptor = resourceDescriptor(job.descriptor),
    bytes = Buffer.from(job.bytes),
    sha256 = job.sha256
  checkResourceJob({ descriptor, bytes, sha256 })
  return { descriptor, bytes, sha256 }
}

function prepareGeo(job: ResourceValidationJob): Prepared<TunResourceBlobTicket> {
  const { descriptor, bytes, sha256 } = checkJob(job),
    ticket = tunResourceBlobTicket({
      blobId: randomUUID(),
      kind: descriptor.kind,
      sha256,
      bytes: bytes.length,
      selector: descriptor.selector
    })
  return { bytes, ticket, filename: resourceCheckDefinition(descriptor).filename }
}
function prepareRuleProvider(job: ResourceValidationJob): Prepared<TunRuleProviderBlobTicket> {
  const checked = checkJob(job),
    { descriptor, bytes, sha256 } = checked
  if (!isTunRuleProviderBlobKind(descriptor.kind)) throw new Error('规则提供者暂存类型无效。')
  // Existing bounded UTF8/YAML/MRS preflight; this is not Core acceptance.
  // Classical dependencies remain for the later same-Core complete checker.
  resourceRuleEntries(checked)
  const blobId = randomUUID(),
    ticket = tunRuleProviderBlobTicket({
      blobId,
      kind: descriptor.kind,
      sha256,
      bytes: bytes.length,
      filename: `${blobId}.${descriptor.kind.slice(5)}`
    })
  return { bytes, ticket, filename: ticket.filename }
}

// This ordinary-UID producer only creates exclusive private entries. It never
// removes, repairs or renames paths. Native's pinned directory consumer owns
// validated discard. Path checks are not atomic CAS against malicious same UID.
export async function createTunResourceInbox(): Promise<TunResourceInbox> {
  const uid = uidNow(),
    pins: Pin[] = [],
    records = new Map<string, Retained>(),
    acknowledged = new Map<string, TunInboxBlobTicket>(),
    waiters: Array<() => void> = [],
    diagnostics: string[] = []
  let directory = '',
    epoch = 0,
    closed = false,
    disposing = false,
    handlesClosed = false,
    disposal: Promise<void> | undefined,
    operation: InboxOperation | undefined
  const sameUID = (): void => {
    if (uidNow() !== uid) throw new Error('资源暂存用户已变化。')
  }
  try {
    for (const path of ['/', '/private', '/private/tmp']) {
      sameUID()
      if ((await realpath(path)) !== path) throw new Error()
      sameUID()
      const linked = await lstat(path, { bigint: true })
      sameUID()
      if (
        !linked.isDirectory() ||
        linked.uid !== 0n ||
        (path === '/private/tmp'
          ? (linked.mode & 0o7777n) !== 0o1777n
          : (linked.mode & 0o022n) !== 0n)
      )
        throw new Error()
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
      pins.push({ path, handle, identity: linked })
      const pinned = await handle.stat({ bigint: true })
      sameUID()
      if (
        !sameDirectory(linked, pinned) ||
        !sameDirectory(pinned, await lstat(path, { bigint: true }))
      )
        throw new Error()
    }
    sameUID()
    directory = await mkdtemp(`/private/tmp/relay-geo-main-${uid}-`)
    sameUID()
    if ((await realpath(directory)) !== directory) throw new Error()
    const linked = await lstat(directory, { bigint: true })
    sameUID()
    if (!linked.isDirectory() || linked.uid !== BigInt(uid) || (linked.mode & 0o7777n) !== 0o700n)
      throw new Error()
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    pins.push({ path: directory, handle, identity: linked })
    const pinned = await handle.stat({ bigint: true })
    sameUID()
    if (
      !sameDirectory(linked, pinned) ||
      !sameDirectory(pinned, await lstat(directory, { bigint: true }))
    )
      throw new Error()
    sameUID()
  } catch {
    await Promise.allSettled(pins.map((pin) => pin.handle.close()))
    const error = new Error('资源暂存根未完整确认；可能已创建的私有目录保留，未删除或修复。')
    Object.assign(error, { retainedDirectory: directory || undefined })
    throw error
  }
  const retained = (): TunResourceInboxRetainedReport => ({
    directory,
    acceptingWrites: !closed,
    pending: !!operation || disposing,
    handlesClosed,
    reservedBytes: [...records.values()].reduce((sum, value) => sum + value.ticket.bytes, 0),
    retained: structuredClone([...records.values()]),
    diagnostics: diagnostics.slice()
  })
  const whenIdle = (): Promise<void> =>
    operation ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const stageInternal = async <T extends TunInboxBlobTicket>(
    job: ResourceValidationJob,
    signal: AbortSignal,
    assertUI: () => void,
    prepareJob: (job: ResourceValidationJob) => Prepared<T>
  ): Promise<T> => {
    if (closed || operation) throw new Error('资源暂存已关闭或当前写入尚未结束。')
    const op: InboxOperation = { epoch }
    operation = op
    let file: FileHandle | undefined,
      child: FileHandle | undefined,
      childIdentity: BigIntStats | undefined,
      finalFile: BigIntStats | undefined,
      childPath = '',
      filePath = '',
      filename = '',
      failure = false
    let publishedTicket: T | undefined
    const live = (): void => {
      sameUID()
      if (
        closed ||
        operation !== op ||
        epoch !== op.epoch ||
        !(signal instanceof AbortSignal) ||
        signal.aborted ||
        typeof assertUI !== 'function'
      )
        throw new Error()
      assertUI()
      sameUID()
      if (closed || operation !== op || epoch !== op.epoch || signal.aborted) throw new Error()
    }
    const step = async <Result>(work: () => Promise<Result>): Promise<Result> => {
      live()
      const result = await work()
      live()
      return result
    }
    const root = async (): Promise<void> => {
      for (const pin of pins) {
        const fd = await step(() => pin.handle.stat({ bigint: true })),
          linked = await step(() => lstat(pin.path, { bigint: true })),
          canonical = await step(() => realpath(pin.path))
        // Own legitimate UUID additions change root size/times/nlink.
        if (
          !sameDirectory(pin.identity, fd) ||
          !sameDirectory(fd, linked) ||
          canonical !== pin.path
        )
          throw new Error()
      }
    }
    const paths = async (): Promise<void> => {
      await root()
      const linked = await step(() => lstat(childPath, { bigint: true })),
        canonical = await step(() => realpath(childPath))
      if (!childIdentity || !sameDirectory(childIdentity, linked) || canonical !== childPath)
        throw new Error()
      const held = child
      if (held) {
        const fd = await step(() => held.stat({ bigint: true }))
        if (!sameDirectory(childIdentity, fd)) throw new Error()
      }
    }
    try {
      live()
      if (
        records.size >= TUN_RESOURCE_INBOX_MAX_TICKETS ||
        (Buffer.isBuffer(job?.bytes) &&
          retained().reservedBytes + job.bytes.length > TUN_RESOURCE_INBOX_MAX_BYTES)
      )
        throw new Error()
      const prepared = prepareJob(job)
      publishedTicket = prepared.ticket
      if (
        records.size >= TUN_RESOURCE_INBOX_MAX_TICKETS ||
        retained().reservedBytes + prepared.bytes.length > TUN_RESOURCE_INBOX_MAX_BYTES
      )
        throw new Error()
      const record: Retained = {
        ticket: prepared.ticket,
        status: 'partial',
        phase: 'checkingRoot',
        writeAttempted: false
      }
      op.record = record
      records.set(record.ticket.blobId, record)
      await root()
      filename = prepared.filename
      childPath = join(directory, record.ticket.blobId)
      filePath = join(childPath, filename)
      record.phase = 'creatingDirectory'
      await step(() => mkdir(childPath, { mode: 0o700 }))
      live()
      const childFD = await open(
        childPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
      child = childFD
      live()
      childIdentity = await step(() => childFD.stat({ bigint: true }))
      if (childIdentity.uid !== BigInt(uid) || (childIdentity.mode & 0o7777n) !== 0o700n)
        throw new Error()
      await paths()
      if ((await step(() => readdir(childPath))).length) throw new Error()
      record.phase = 'openingFile'
      live()
      const fileFD = await open(
        filePath,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600
      )
      file = fileFD
      live()
      const initial = await step(() => fileFD.stat({ bigint: true }))
      if (!fileMode(initial, uid, 0)) throw new Error()
      await paths()
      record.phase = 'writing'
      record.writeAttempted = true
      await step(() => fileFD.writeFile(prepared.bytes))
      await step(() => fileFD.sync())
      await paths()
      const before = await step(() => fileFD.stat({ bigint: true }))
      if (
        !fileMode(before, uid, prepared.bytes.length) ||
        before.dev !== initial.dev ||
        before.ino !== initial.ino
      )
        throw new Error()
      record.phase = 'readingBack'
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(Math.min(1024 * 1024, prepared.bytes.length))
      let offset = 0
      while (offset < prepared.bytes.length) {
        const part = await step(() =>
          fileFD.read(buffer, 0, Math.min(buffer.length, prepared.bytes.length - offset), offset)
        )
        if (!part.bytesRead) throw new Error()
        hash.update(buffer.subarray(0, part.bytesRead))
        offset += part.bytesRead
      }
      const extra = await step(() => fileFD.read(buffer, 0, 1, offset))
      finalFile = await step(() => fileFD.stat({ bigint: true }))
      if (
        extra.bytesRead ||
        hash.digest('hex') !== prepared.ticket.sha256 ||
        !sameFile(before, finalFile)
      )
        throw new Error()
      const linked = await step(() => lstat(filePath, { bigint: true })),
        canonical = await step(() => realpath(filePath))
      if (!sameFile(finalFile, linked, true) || canonical !== filePath) throw new Error()
      await step(() => childFD.sync())
      await step(() => pins[pins.length - 1].handle.sync())
    } catch {
      failure = true
    }
    if (op.record) {
      if (failure)
        op.record.diagnostic = `暂存未确认阶段：${op.record.phase}；保留可能存在的完整或部分文件。`
      op.record.phase = 'closing'
    }
    // Always close the exact held handles, even after signal/UI invalidation.
    for (const result of await Promise.allSettled([file?.close(), child?.close()]))
      if (result.status === 'rejected') failure = true
    child = undefined
    file = undefined
    if (!failure)
      try {
        await paths()
        const linked = await step(() => lstat(filePath, { bigint: true })),
          canonical = await step(() => realpath(filePath))
        if (
          !finalFile ||
          !sameFile(finalFile, linked, true) ||
          canonical !== filePath ||
          JSON.stringify(await step(() => readdir(childPath))) !== JSON.stringify([filename])
        )
          throw new Error()
      } catch {
        failure = true
      }
    try {
      live()
      if (failure || !op.record || !publishedTicket) throw new Error()
      op.record.status = 'staged'
      op.record.phase = 'publishing'
      return structuredClone(publishedTicket)
    } catch {
      if (op.record)
        op.record.diagnostic ??=
          '暂存未完整确认；可能存在完整或部分文件，保留现场，未删除或自动修复。'
      throw new Error('资源暂存未确认；未发布票据，可能的完整或部分文件保留。')
    } finally {
      if (operation === op) operation = undefined
      waiters.splice(0).forEach((resolve) => resolve())
    }
  }
  return Object.freeze({
    directory,
    retained,
    whenIdle,
    isBusy: () => !!operation || disposing,
    stage: (job: ResourceValidationJob, signal: AbortSignal, assertUI: () => void) =>
      stageInternal(job, signal, assertUI, prepareGeo),
    stageRuleProvider: (job: ResourceValidationJob, signal: AbortSignal, assertUI: () => void) =>
      stageInternal(job, signal, assertUI, prepareRuleProvider),
    acknowledgeDiscard(raw: TunInboxBlobTicket): void {
      const registered =
        raw && typeof raw === 'object'
          ? (records.get(raw.blobId)?.ticket ?? acknowledged.get(raw.blobId))
          : undefined
      if (!registered) throw new Error('资源丢弃ACK不匹配。')
      let checked: TunInboxBlobTicket
      try {
        checked = isTunRuleProviderBlobKind(registered.kind)
          ? tunRuleProviderBlobTicket(raw)
          : tunResourceBlobTicket(raw)
      } catch {
        throw new Error('资源丢弃ACK不匹配。')
      }
      const record = records.get(checked.blobId),
        encoded = JSON.stringify(checked)
      if (operation?.record?.ticket.blobId === checked.blobId)
        throw new Error('资源写入尚未结束，不能提前释放票据。')
      if (!record) {
        if (JSON.stringify(acknowledged.get(checked.blobId)) === encoded) return
        throw new Error('资源丢弃ACK不匹配。')
      }
      if (JSON.stringify(record.ticket) !== encoded) throw new Error('资源丢弃ACK不匹配。')
      records.delete(checked.blobId)
      acknowledged.set(checked.blobId, structuredClone(checked))
      if (acknowledged.size > 4) {
        const first = acknowledged.keys().next().value
        if (first !== undefined) acknowledged.delete(first)
      }
    },
    async dispose(): Promise<TunResourceInboxRetainedReport> {
      if (!disposal) {
        closed = true
        disposing = true
        ++epoch
        disposal = (async () => {
          await whenIdle()
          const results = await Promise.allSettled(pins.map((pin) => pin.handle.close()))
          handlesClosed = results.every((result) => result.status === 'fulfilled')
          if (!handlesClosed) diagnostics.push('私有暂存目录FD关闭未完整确认；所有路径保留。')
        })().finally(() => {
          disposing = false
        })
      }
      await disposal
      return retained()
    }
  })
}
