import { mkdir, readdir, rm } from 'fs/promises'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  type Stats
} from 'fs'
import { join, relative } from 'path'
import { createHash, randomUUID } from 'crypto'
import { pluginId, pluginRoute, type RelayPluginRecord } from '../../../shared/relay/plugins'
import { parseDescriptor } from '../../resolve/plugin/descriptor'
import { parseGatewayOrigin, normalizeEndpointPath } from '../../resolve/plugin/gateway-url'
import { parseWellKnown } from '../../resolve/plugin/discovery'
import { isB64Bytes, isCanonicalB64 } from '../../resolve/plugin/encoding'
import type { DeviceKeys } from '../../resolve/plugin/device'
import type { RelayStateContext } from '../context'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { readBinaryResource } from '../resources/source'
import { inspectProfile } from '../profiles/inspect'
import { KeyedWriteQueue } from '../../utils/safeFile'

export interface RelayPluginCrypto {
  available(): Promise<boolean>
  encrypt(text: string): Promise<Buffer>
  decrypt(bytes: Buffer): Promise<string>
}
export interface RelayPluginEntry {
  record: RelayPluginRecord
  encryptedCredential?: string
  revision: string
}
export interface RelayPluginCredential {
  keys: DeviceKeys
  phase: 'enrollment-pending' | 'active'
}
export interface RelayPluginWriteGuard {
  verify(): Promise<void>
  signal: AbortSignal
}
export class RelayPluginStorageUncertain extends Error {
  constructor() {
    super('插件私有存储写入未确认。')
  }
}
const recordWrites = new KeyedWriteQueue()
class PluginRecordChanged extends Error {
  constructor() {
    super('插件记录已改变，请重新读取。')
  }
}
const sameDirectory = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode
const sameFile = (a: Stats, b: Stats): boolean =>
  sameDirectory(a, b) &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs
function readRecordFD(fd: number): { bytes: Buffer; stat: Stats } {
  const before = fstatSync(fd)
  if (
    !before.isFile() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o7777) !== 0o600 ||
    before.nlink !== 1 ||
    before.size > 131072
  )
    throw new PluginRecordChanged()
  const bytes = Buffer.alloc(before.size + 1)
  let offset = 0
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
    if (!count) break
    offset += count
  }
  const after = fstatSync(fd)
  if (offset !== before.size || !sameFile(before, after)) throw new PluginRecordChanged()
  return { bytes: bytes.subarray(0, offset), stat: after }
}
// Match SubscriptionFiles.directory's canonical, owned, non-writable ancestry
// synchronously inside the final publication fence; no caller callback or await.
function verifyDirectoryPath(home: string, path: string): void {
  if (path !== home && !path.startsWith(home + '/')) throw new PluginRecordChanged()
  let current = home
  for (const segment of ['', ...relative(home, path).split('/').filter(Boolean)]) {
    if (segment) current = join(current, segment)
    const info = lstatSync(current)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o022 ||
      realpathSync(current) !== current
    )
      throw new PluginRecordChanged()
  }
}
const digest = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
// Fixed ac294 target identity, hashed only for the persisted preference. The
// signed candidate remains unchanged; same origin with new paths/epoch differs.
export function pluginTargetKey(candidate: IDiscoveryCandidate, gateway: string): string {
  if (parseGatewayOrigin(gateway) !== gateway || !candidate.gateways.includes(gateway))
    throw new Error('插件偏好目标无效。')
  return digest(
    JSON.stringify([
      gateway,
      ...(['enroll', 'challenge', 'config', 'revoke'] as const).map((key) =>
        normalizeEndpointPath(candidate.endpoints[key])
      ),
      candidate.seq ?? null,
      candidate.digest ?? null
    ])
  )
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('插件记录格式无效。')
  return value as Record<string, unknown>
}
function parseRecord(value: unknown): RelayPluginRecord {
  const raw = object(value)
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          'id',
          'descriptor',
          'route',
          'approvedOrigins',
          'status',
          'createdAt',
          'updatedAt',
          'discovery',
          'lastGoodTarget',
          'subscription',
          'lastError'
        ].includes(key)
    )
  )
    throw new Error('插件记录含未知字段。')
  const descriptor = parseDescriptor(JSON.stringify(raw.descriptor)),
    id = pluginId(raw.id),
    route = pluginRoute(raw.route)
  if (!Array.isArray(raw.approvedOrigins) || raw.approvedOrigins.length > 32)
    throw new Error('插件权限来源无效。')
  const approvedOrigins = raw.approvedOrigins.map((origin) => {
    const parsed = parseGatewayOrigin(origin)
    if (!parsed || parsed !== origin) throw new Error('插件权限来源无效。')
    return parsed
  })
  if (
    typeof raw.status !== 'string' ||
    !['needs-login', 'active', 'needs-reauth', 'uncertain'].includes(raw.status) ||
    typeof raw.createdAt !== 'number' ||
    !Number.isFinite(raw.createdAt) ||
    typeof raw.updatedAt !== 'number' ||
    !Number.isFinite(raw.updatedAt)
  )
    throw new Error('插件状态无效。')
  const record: RelayPluginRecord = {
    id,
    descriptor,
    route,
    approvedOrigins,
    status: raw.status as RelayPluginRecord['status'],
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  }
  if (raw.subscription !== undefined) {
    const subscription = object(raw.subscription)
    if (
      Object.keys(subscription).sort().join(',') !== 'savedAt,sha256,size' ||
      typeof subscription.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(subscription.sha256) ||
      typeof subscription.size !== 'number' ||
      !Number.isSafeInteger(subscription.size) ||
      subscription.size < 1 ||
      subscription.size > 2 * 1024 * 1024 ||
      typeof subscription.savedAt !== 'number' ||
      !Number.isFinite(subscription.savedAt)
    )
      throw new Error('插件订阅记录无效。')
    record.subscription = {
      sha256: subscription.sha256,
      size: subscription.size,
      savedAt: subscription.savedAt
    }
  }
  if (raw.discovery !== undefined) {
    const discovery = object(raw.discovery),
      wellKnown = parseWellKnown(
        JSON.stringify({
          ...discovery,
          gateway: Array.isArray(discovery.gateways) ? discovery.gateways[0] : undefined,
          spec: 'cpx-plugin/2'
        })
      )
    record.discovery = { gateways: wellKnown.gateways, endpoints: wellKnown.endpoints }
    if (discovery.loginUrl !== undefined || discovery.discoveryUrls !== undefined) {
      const rotatedDescriptor: Record<string, unknown> = {
        ...descriptor,
        ...(discovery.loginUrl !== undefined ? { loginUrl: discovery.loginUrl } : {}),
        ...(discovery.discoveryUrls !== undefined ? { discoveryUrls: discovery.discoveryUrls } : {})
      }
      if (Array.isArray(discovery.discoveryUrls) && !discovery.discoveryUrls.length)
        delete rotatedDescriptor.discoveryUrls
      const rotated = parseDescriptor(JSON.stringify(rotatedDescriptor))
      if (discovery.loginUrl !== undefined) record.discovery.loginUrl = rotated.loginUrl
      if (discovery.discoveryUrls !== undefined)
        record.discovery.discoveryUrls = rotated.discoveryUrls ?? []
    }
    if (discovery.seq !== undefined || discovery.digest !== undefined) {
      if (
        !Number.isSafeInteger(discovery.seq) ||
        Number(discovery.seq) < 1 ||
        typeof discovery.digest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(discovery.digest)
      )
        throw new Error('插件签名序号记录无效。')
      record.discovery.seq = Number(discovery.seq)
      record.discovery.digest = discovery.digest
    }
  }
  if (raw.lastGoodTarget !== undefined) {
    const candidate = record.discovery
    if (
      typeof raw.lastGoodTarget !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(raw.lastGoodTarget) ||
      !candidate ||
      !candidate.gateways.some(
        (gateway) => pluginTargetKey(candidate, gateway) === raw.lastGoodTarget
      )
    )
      throw new Error('插件偏好不属于当前完整网关目标。')
    record.lastGoodTarget = raw.lastGoodTarget
  }
  if (raw.lastError !== undefined) {
    if (
      typeof raw.lastError !== 'string' ||
      !['network', 'credentials', 'invalid-subscription', 'storage', 'cancelled'].includes(
        raw.lastError
      )
    )
      throw new Error('插件错误状态无效。')
    record.lastError = raw.lastError as RelayPluginRecord['lastError']
  }
  return record
}

export class RelayPluginStore {
  private readonly files: SubscriptionFiles
  private readonly root: string
  constructor(
    context: RelayStateContext,
    private readonly crypto: RelayPluginCrypto
  ) {
    this.files = new SubscriptionFiles({ ...context })
    this.root = join(context.stateRoot, 'Plugins')
  }
  private directory(id: string): string {
    return join(this.root, pluginId(id))
  }
  async readyForCredentials(): Promise<void> {
    if (!(await this.crypto.available())) throw new Error('系统凭据加密当前不可用，尚未打开登录。')
  }
  async list(): Promise<RelayPluginRecord[]> {
    if (!(await this.files.directory(this.root))) return []
    const names = await readdir(this.root)
    if (names.length > 200) throw new Error('插件记录超过读取上限。')
    return Promise.all(names.map(async (id) => (await this.read(id)).record))
  }
  async read(id: string): Promise<RelayPluginEntry> {
    const directory = this.directory(id)
    if (!(await this.files.directory(directory))) throw new Error('插件记录不存在。')
    const bytes = await readBinaryResource(join(directory, 'record.json'), true)
    if (bytes.length > 131072) throw new Error('插件记录过大。')
    const raw = object(JSON.parse(bytes.toString('utf8')))
    if (
      raw.version !== 1 ||
      Object.keys(raw).some((key) => !['version', 'record', 'encryptedCredential'].includes(key))
    )
      throw new Error('插件记录版本无效。')
    const record = parseRecord(raw.record)
    if (
      record.id !== id ||
      (raw.encryptedCredential !== undefined && !isCanonicalB64(raw.encryptedCredential))
    )
      throw new Error('插件记录身份或凭据无效。')
    return {
      record,
      revision: digest(bytes),
      ...(typeof raw.encryptedCredential === 'string'
        ? { encryptedCredential: raw.encryptedCredential }
        : {})
    }
  }
  async create(record: RelayPluginRecord): Promise<RelayPluginEntry> {
    record = parseRecord(record)
    await this.files.directory(this.root, true)
    const directory = this.directory(record.id)
    await mkdir(directory, { mode: 0o700 })
    try {
      await this.files.write(join(directory, 'record.json'), JSON.stringify({ version: 1, record }))
      await this.files.sync(directory)
      return await this.read(record.id)
    } catch {
      throw new RelayPluginStorageUncertain()
    }
  }
  async save(entry: RelayPluginEntry, guard?: RelayPluginWriteGuard): Promise<RelayPluginEntry> {
    // Capture the caller's data before queue/crypto/authority awaits.
    const record = parseRecord(entry.record),
      expectedRevision = entry.revision,
      encrypted = entry.encryptedCredential
    const directory = this.directory(record.id),
      path = join(directory, 'record.json')
    const text = JSON.stringify({
      version: 1,
      record,
      ...(encrypted ? { encryptedCredential: encrypted } : {})
    })
    const bytes = Buffer.from(text)
    if (bytes.length > 131072) throw new Error('插件记录过大。')
    return recordWrites.run(
      path,
      async () => {
        if ((await this.read(record.id)).revision !== expectedRevision)
          throw new PluginRecordChanged()
        let directoryFD: number | undefined,
          recordFD: number | undefined,
          stageFD: number | undefined
        let stage: string | undefined,
          stagePin: Stats | undefined,
          published = false,
          publishAttempted = false
        let failure: unknown
        try {
          directoryFD = openSync(
            directory,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
          )
          const directoryPin = fstatSync(directoryFD)
          recordFD = openSync(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          )
          const heldDirectoryFD = directoryFD,
            heldRecordFD = recordFD
          const recordPin = readRecordFD(heldRecordFD)
          if (
            !directoryPin.isDirectory() ||
            directoryPin.uid !== process.getuid?.() ||
            (directoryPin.mode & 0o7777) !== 0o700 ||
            digest(recordPin.bytes) !== expectedRevision
          )
            throw new PluginRecordChanged()
          await guard?.verify()
          const fence = (): void => {
            if (guard?.signal.aborted) throw new PluginRecordChanged()
            verifyDirectoryPath(this.files.context.home, directory)
            const currentDirectory = fstatSync(heldDirectoryFD)
            const current = readRecordFD(heldRecordFD)
            if (
              !sameDirectory(directoryPin, currentDirectory) ||
              !sameDirectory(directoryPin, lstatSync(directory)) ||
              !sameFile(recordPin.stat, current.stat) ||
              !sameFile(current.stat, lstatSync(path)) ||
              digest(current.bytes) !== expectedRevision
            )
              throw new PluginRecordChanged()
          }
          fence()
          // Adapt the existing bounded sync atomic writer. Keep its stage FD
          // through rename and only unlink a creator-known full/partial prefix.
          stage = join(directory, '.record-' + randomUUID() + '.tmp')
          stageFD = openSync(stage, 'wx+', 0o600)
          stagePin = fstatSync(stageFD)
          writeFileSync(stageFD, bytes)
          fsyncSync(stageFD)
          const staged = readRecordFD(stageFD)
          if (
            !sameDirectory(stagePin, staged.stat) ||
            !sameFile(staged.stat, lstatSync(stage)) ||
            !staged.bytes.equals(bytes)
          )
            throw new PluginRecordChanged()
          // No await or caller callback from this full CAS check to rename.
          fence()
          publishAttempted = true
          renameSync(stage, path)
          published = true
          fsyncSync(directoryFD)
        } catch (error) {
          failure =
            publishAttempted || !(error instanceof PluginRecordChanged)
              ? new RelayPluginStorageUncertain()
              : error
        } finally {
          if (stageFD !== undefined && !published && stage) {
            try {
              verifyDirectoryPath(this.files.context.home, directory)
              const own = readRecordFD(stageFD),
                linked = lstatSync(stage)
              if (
                !stagePin ||
                !sameDirectory(stagePin, own.stat) ||
                !sameFile(own.stat, linked) ||
                own.bytes.length > bytes.length ||
                !own.bytes.equals(bytes.subarray(0, own.bytes.length))
              )
                failure = new RelayPluginStorageUncertain()
              else unlinkSync(stage)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                failure = new RelayPluginStorageUncertain()
            }
          }
          for (const fd of [stageFD, recordFD, directoryFD])
            if (fd !== undefined) {
              try {
                closeSync(fd)
              } catch {
                failure = new RelayPluginStorageUncertain()
              }
            }
        }
        if (failure) throw failure
        try {
          const saved = await this.read(record.id)
          if (saved.revision !== digest(bytes)) throw new Error()
          return saved
        } catch {
          throw new RelayPluginStorageUncertain()
        }
      },
      guard?.signal
    )
  }
  async credential(entry: RelayPluginEntry): Promise<RelayPluginCredential | undefined> {
    if (!entry.encryptedCredential) return undefined
    await this.readyForCredentials()
    const payload = object(
      JSON.parse(await this.crypto.decrypt(Buffer.from(entry.encryptedCredential, 'base64')))
    )
    if (
      Object.keys(payload).sort().join(',') !== 'keys,phase' ||
      (payload.phase !== 'active' && payload.phase !== 'enrollment-pending')
    )
      throw new Error('插件凭据阶段无效。')
    const raw = object(payload.keys)
    if (
      Object.keys(raw).sort().join(',') !== 'deviceId,privKeyB64,pubKeyB64' ||
      !isB64Bytes(raw.privKeyB64, 32) ||
      !isB64Bytes(raw.pubKeyB64, 32)
    )
      throw new Error('插件凭据内容无效。')
    return {
      phase: payload.phase,
      keys: {
        deviceId: pluginId(raw.deviceId),
        privKeyB64: raw.privKeyB64,
        pubKeyB64: raw.pubKeyB64
      }
    }
  }
  async withCredential(
    entry: RelayPluginEntry,
    credential: RelayPluginCredential
  ): Promise<RelayPluginEntry> {
    await this.readyForCredentials()
    const encrypted = await this.crypto.encrypt(JSON.stringify(credential))
    if (!encrypted.length || encrypted.length > 65536) throw new Error('插件凭据加密未确认。')
    return this.save({ ...entry, encryptedCredential: encrypted.toString('base64') })
  }
  async saveSubscription(
    entry: RelayPluginEntry,
    text: string,
    guard?: RelayPluginWriteGuard
  ): Promise<RelayPluginEntry> {
    const bytes = Buffer.byteLength(text),
      inspected = inspectProfile(text)
    if (bytes > 2 * 1024 * 1024 || inspected.structure !== 'passed')
      throw new Error('插件返回的订阅结构无效。')
    const sha256 = digest(text),
      directory = join(this.directory(entry.record.id), 'Subscriptions')
    await guard?.verify()
    await this.files.directory(directory, true)
    const path = join(directory, sha256 + '.yaml')
    try {
      await this.files.write(path, text)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        digest(await readBinaryResource(path, true)) !== sha256
      )
        throw error
    }
    await this.files.sync(directory)
    // A revoked session may leave an immutable orphan, but cannot replace the active snapshot.
    await guard?.verify()
    return this.save(
      {
        ...entry,
        record: {
          ...entry.record,
          status: 'active',
          subscription: { sha256, size: bytes, savedAt: Date.now() }
        }
      },
      guard
    )
  }
  async subscription(id: string): Promise<{ record: RelayPluginRecord; text: string }> {
    const { record } = await this.read(id)
    if (!record.subscription) throw new Error('插件尚无已保存订阅。')
    const bytes = await readBinaryResource(
      join(this.directory(id), 'Subscriptions', record.subscription.sha256 + '.yaml'),
      true
    )
    if (bytes.length !== record.subscription.size || digest(bytes) !== record.subscription.sha256)
      throw new Error('插件订阅摘要不符。')
    return { record, text: bytes.toString('utf8') }
  }
  async remove(entry: RelayPluginEntry): Promise<void> {
    if ((await this.read(entry.record.id)).revision !== entry.revision)
      throw new Error('插件记录已改变。')
    const directory = this.directory(entry.record.id)
    for (const name of await readdir(directory)) {
      if (name === 'record.json') continue
      if (name !== 'Subscriptions' || !(await this.files.directory(join(directory, name))))
        throw new Error('插件目录含未知内容，保留待核对。')
      const members = await readdir(join(directory, name))
      if (members.length > 1000 || members.some((member) => !/^[a-f0-9]{64}\.yaml$/u.test(member)))
        throw new Error('插件订阅目录含未知内容。')
      for (const member of members) await readBinaryResource(join(directory, name, member), true)
    }
    await rm(directory, { recursive: true })
    await this.files.sync(this.root)
  }
}
