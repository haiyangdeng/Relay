import { lstat, opendir, readdir, realpath } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { join } from 'path'
import {
  backupAccountMetadata,
  backupAccountSaveRequest,
  backupAccountSelection,
  type BackupAccountMetadata,
  type RelayBackupAccount,
  type RelayBackupAccountInventory
} from '../../../shared/relay/backup-accounts'
import type { RelayStateContext } from '../context'
import type { RelayPluginCrypto } from '../plugins/store'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { readBinaryResource } from '../resources/source'
import type { RecoveryIdentity } from './recovery-journal'

export interface BackupAccountPublication {
  id: string
  directoryIdentity: RecoveryIdentity
  name: string
  bytes: Buffer
}
interface Frame {
  version: 1
  sequence: number
  parentSHA256: string | null
  account: BackupAccountMetadata
  encryptedCredential: string
}
interface Loaded {
  frame: Frame
  account: RelayBackupAccount
  directoryIdentity: RecoveryIdentity
}
export class BackupAccountStorageUncertain extends Error {
  constructor() {
    super('备份账号保存结果未确认；请重新读取，不能自动重试。')
  }
}
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const identity = (value: Awaited<ReturnType<typeof lstat>>): RecoveryIdentity => ({
  dev: Number(value.dev),
  ino: Number(value.ino),
  uid: Number(value.uid),
  mode: Number(value.mode)
})
const sameIdentity = (left: RecoveryIdentity, right: RecoveryIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.uid === right.uid &&
  left.mode === right.mode
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('备份账号记录无效。')
  return value as Record<string, unknown>
}
const binding = (account: BackupAccountMetadata): Record<string, string> =>
  account.provider === 'webdav'
    ? { directoryURL: account.directoryURL ?? '', username: account.username ?? '' }
    : { api: 'https://api.github.com' }
const canonicalB64 = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 90000 &&
  /^[A-Za-z0-9+/]*={0,2}$/u.test(value) &&
  Buffer.from(value, 'base64').toString('base64') === value
const revisionName = (sequence: number): string =>
  sequence === 0 ? 'account.json' : 'revision-' + String(sequence).padStart(6, '0') + '.json'

// Account secrets remain main-only. The injected publisher must pin the owned
// directory and create exclusively; a missing adapter never falls back to paths.
export class RelayBackupAccountsStore {
  private readonly files: SubscriptionFiles
  private readonly root: string
  private readonly heads = new Map<string, Set<string>>()
  private writing = false
  constructor(
    private readonly context: RelayStateContext,
    private readonly adapters: {
      crypto: RelayPluginCrypto
      publish?(request: BackupAccountPublication): Promise<void>
      createDirectory?(request: {
        id: string
        stateIdentity: RecoveryIdentity
      }): Promise<RecoveryIdentity>
      now?(): number
    }
  ) {
    this.files = new SubscriptionFiles(context)
    this.root = join(context.stateRoot, 'Configuration/BackupAccounts')
  }
  private directory(id: string): string {
    backupAccountSelection({ id, revision: '0'.repeat(64) })
    return join(this.root, id)
  }
  private async directoryIdentity(id: string): Promise<RecoveryIdentity> {
    const path = this.directory(id)
    if (!(await this.files.directory(path))) throw new Error('备份账号不存在。')
    const value = await lstat(path)
    if (
      !value.isDirectory() ||
      value.isSymbolicLink() ||
      (value.mode & 0o7777) !== 0o700 ||
      value.uid !== process.getuid?.() ||
      (await realpath(path)) !== path
    )
      throw new Error('备份账号目录身份不符。')
    return identity(value)
  }
  private parseFrame(raw: unknown): Frame {
    const value = object(raw)
    if (
      Object.keys(value).sort().join(',') !==
        'account,encryptedCredential,parentSHA256,sequence,version' ||
      value.version !== 1 ||
      !Number.isInteger(value.sequence) ||
      Number(value.sequence) < 0 ||
      Number(value.sequence) > 100 ||
      (value.sequence === 0
        ? value.parentSHA256 !== null
        : typeof value.parentSHA256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.parentSHA256)) ||
      !canonicalB64(value.encryptedCredential)
    )
      throw new Error('备份账号修订或密文格式无效。')
    return {
      version: 1,
      sequence: Number(value.sequence),
      parentSHA256: value.parentSHA256 as string | null,
      account: backupAccountMetadata(value.account),
      encryptedCredential: value.encryptedCredential
    }
  }
  private async load(id: string): Promise<Loaded> {
    const directory = this.directory(id),
      before = await this.directoryIdentity(id),
      names = (await readdir(directory)).sort()
    if (
      !names.includes('account.json') ||
      names.length > 101 ||
      names.some((name) => name !== 'account.json' && !/^revision-[0-9]{6}\.json$/u.test(name))
    )
      throw new Error('备份账号目录包含未知或过量条目。')
    const ordered = ['account.json', ...names.filter((name) => name !== 'account.json')]
    let parent: string | null = null,
      first: BackupAccountMetadata | undefined,
      latest: Frame | undefined
    for (let sequence = 0; sequence < ordered.length; ++sequence) {
      if (ordered[sequence] !== revisionName(sequence)) throw new Error('备份账号修订不连续。')
      const bytes = await readBinaryResource(join(directory, ordered[sequence]), true, 131072),
        frame = this.parseFrame(JSON.parse(bytes.toString('utf8')))
      if (
        frame.sequence !== sequence ||
        frame.parentSHA256 !== parent ||
        frame.account.id !== id ||
        (first &&
          (frame.account.provider !== first.provider ||
            frame.account.createdAt !== first.createdAt)) ||
        (latest && frame.account.updatedAt < latest.account.updatedAt)
      )
        throw new Error('备份账号父修订或身份不符。')
      first ??= frame.account
      latest = frame
      parent = sha(bytes)
    }
    if (
      !latest ||
      !parent ||
      !sameIdentity(await this.directoryIdentity(id), before) ||
      JSON.stringify(await readdir(directory).then((names) => names.sort())) !==
        JSON.stringify(names)
    )
      throw new Error('备份账号读取期间已变化。')
    // Re-read all immutable members: observing a stable leaf alone would miss
    // a replaced historical frame during asynchronous metadata inspection.
    let rechecked: string | null = null
    for (let sequence = 0; sequence < ordered.length; ++sequence) {
      const bytes = await readBinaryResource(join(directory, ordered[sequence]), true, 131072),
        frame = this.parseFrame(JSON.parse(bytes.toString('utf8')))
      if (frame.sequence !== sequence || frame.parentSHA256 !== rechecked)
        throw new Error('备份账号历史在读取期间已变化。')
      rechecked = sha(bytes)
    }
    if (
      rechecked !== parent ||
      !sameIdentity(await this.directoryIdentity(id), before) ||
      (this.heads.has(id) && !this.heads.get(id)?.has(parent))
    )
      throw new Error('备份账号出现未知修改。')
    return {
      frame: latest,
      account: { ...latest.account, revision: parent },
      directoryIdentity: before
    }
  }
  // Only the confirmed full restore callback may reset historical trust.
  // Ordinary cancel/refresh must never use this to accept a rolled-back head.
  clearTrust(): void {
    if (this.writing) throw new Error('备份账号保存尚未结束。')
    this.heads.clear()
  }
  async list(): Promise<RelayBackupAccountInventory> {
    const result: RelayBackupAccountInventory = { accounts: [], incomplete: 0 }
    if (!(await this.files.directory(this.root))) return result
    let count = 0
    for await (const member of await opendir(this.root)) {
      if (++count > 200) throw new Error('备份账号超过200项预算。')
      try {
        result.accounts.push((await this.load(member.name)).account)
      } catch {
        ++result.incomplete
      }
    }
    result.accounts.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    return result
  }
  async read(raw: unknown): Promise<RelayBackupAccount> {
    const selected = backupAccountSelection(raw),
      loaded = await this.load(selected.id)
    if (loaded.account.revision !== selected.revision)
      throw new Error('备份账号修订已变化，请重新选择。')
    return structuredClone(loaded.account)
  }
  private async encrypted(account: BackupAccountMetadata, secret: string): Promise<string> {
    try {
      if (!(await this.adapters.crypto.available())) throw new Error()
      const bytes = await this.adapters.crypto.encrypt(
        JSON.stringify({
          version: 1,
          accountId: account.id,
          provider: account.provider,
          identity: binding(account),
          secret
        })
      )
      if (!bytes.length || bytes.length > 65536) throw new Error()
      return bytes.toString('base64')
    } catch {
      throw new Error('系统凭据加密不可用；未保存备份账号秘密。')
    }
  }
  async credential(raw: unknown): Promise<{ account: RelayBackupAccount; secret: string }> {
    const selected = backupAccountSelection(raw),
      loaded = await this.load(selected.id)
    if (loaded.account.revision !== selected.revision || loaded.account.state !== 'active')
      throw new Error('备份账号已变化或停用。')
    try {
      if (!(await this.adapters.crypto.available())) throw new Error()
      const payload = object(
        JSON.parse(
          await this.adapters.crypto.decrypt(
            Buffer.from(loaded.frame.encryptedCredential, 'base64')
          )
        )
      )
      if (
        Object.keys(payload).sort().join(',') !== 'accountId,identity,provider,secret,version' ||
        payload.version !== 1 ||
        payload.accountId !== selected.id ||
        payload.provider !== loaded.account.provider ||
        JSON.stringify(payload.identity) !== JSON.stringify(binding(loaded.account)) ||
        typeof payload.secret !== 'string'
      )
        throw new Error()
      backupAccountSaveRequest({
        id: loaded.account.id,
        revision: selected.revision,
        name: loaded.account.name,
        provider: loaded.account.provider,
        proxyPort: loaded.account.proxyPort,
        ...(loaded.account.directoryURL ? { directoryURL: loaded.account.directoryURL } : {}),
        ...(loaded.account.username !== undefined ? { username: loaded.account.username } : {}),
        ...(loaded.account.recipient ? { recipient: loaded.account.recipient } : {}),
        ...(loaded.account.provider === 'webdav'
          ? { password: payload.secret }
          : { token: payload.secret })
      })
      await this.read(selected)
      return { account: loaded.account, secret: payload.secret }
    } catch {
      throw new Error('备份账号凭据不可用或绑定不符；请重新输入，不会发送网络请求。')
    }
  }
  private async publish(
    frame: Frame,
    directoryIdentity: RecoveryIdentity
  ): Promise<RelayBackupAccount> {
    const publish = this.adapters.publish
    if (!publish) throw new Error('安全备份账号发布尚未接通；未保存。')
    if (frame.sequence > 100) throw new Error('备份账号修订超过100项预算。')
    const bytes = Buffer.from(JSON.stringify(frame)),
      next = sha(bytes)
    if (bytes.length > 131072) throw new Error('备份账号记录超过128KiB。')
    this.heads.set(
      frame.account.id,
      new Set([...(frame.parentSHA256 ? [frame.parentSHA256] : []), next])
    )
    try {
      if (!sameIdentity(await this.directoryIdentity(frame.account.id), directoryIdentity))
        throw new Error()
      await publish({
        id: frame.account.id,
        directoryIdentity,
        name: revisionName(frame.sequence),
        bytes
      })
      await this.files.sync(this.directory(frame.account.id))
      const loaded = await this.load(frame.account.id)
      if (
        loaded.account.revision !== next ||
        !sameIdentity(loaded.directoryIdentity, directoryIdentity)
      )
        throw new Error()
      this.heads.set(frame.account.id, new Set([next]))
      return loaded.account
    } catch {
      throw new BackupAccountStorageUncertain()
    }
  }
  async save(raw: unknown): Promise<RelayBackupAccount> {
    if (this.writing) throw new Error('请等待备份账号保存结束。')
    const request = backupAccountSaveRequest(raw)
    if (!this.adapters.publish || (!request.id && !this.adapters.createDirectory))
      throw new Error('安全备份账号发布尚未接通；未保存。')
    this.writing = true
    try {
      const selected =
          request.id && request.revision
            ? { id: request.id, revision: request.revision }
            : undefined,
        current = selected ? await this.load(selected.id) : undefined
      if (
        current &&
        (current.account.revision !== request.revision ||
          current.account.provider !== request.provider ||
          current.account.state !== 'active')
      )
        throw new Error('备份账号已变化、停用或类型不符。')
      // Keep the final bounded revision available for stopping an account.
      if (current && current.frame.sequence >= 99)
        throw new Error('备份账号修订已满，请停用后新建账号。')
      const id = current?.account.id ?? randomUUID(),
        at = Math.max(this.adapters.now?.() ?? Date.now(), current?.account.updatedAt ?? 0),
        account = backupAccountMetadata({
          id,
          name: request.name,
          provider: request.provider,
          proxyPort: request.proxyPort,
          ...(request.directoryURL ? { directoryURL: request.directoryURL } : {}),
          ...(request.username !== undefined ? { username: request.username } : {}),
          ...(request.recipient ? { recipient: request.recipient } : {}),
          state: 'active',
          hasCredential: true,
          createdAt: current?.account.createdAt ?? at,
          updatedAt: at
        }),
        secret = request.provider === 'webdav' ? request.password : request.token
      if (
        current &&
        secret === undefined &&
        JSON.stringify(binding(current.account)) !== JSON.stringify(binding(account))
      )
        throw new Error('账号目录或用户名已改变，需要显式重新输入秘密。')
      const encryptedCredential =
        secret === undefined
          ? current?.frame.encryptedCredential
          : await this.encrypted(account, secret)
      if (!encryptedCredential) throw new Error('首次保存需要备份账号秘密。')
      let directoryIdentity: RecoveryIdentity
      if (current) {
        const after = await this.load(id)
        if (after.account.revision !== request.revision) throw new Error('保存期间备份账号已变化。')
        directoryIdentity = after.directoryIdentity
      } else {
        const inventory = await this.list()
        if (inventory.accounts.length + inventory.incomplete >= 200)
          throw new Error('备份账号超过200项预算。')
        const create = this.adapters.createDirectory
        if (!create) throw new Error('安全备份账号目录创建尚未接通。')
        await this.files.directory(this.context.stateRoot, true)
        directoryIdentity = await create({
          id,
          stateIdentity: identity(await lstat(this.context.stateRoot))
        })
        if (!sameIdentity(await this.directoryIdentity(id), directoryIdentity))
          throw new BackupAccountStorageUncertain()
      }
      return await this.publish(
        {
          version: 1,
          sequence: current ? current.frame.sequence + 1 : 0,
          parentSHA256: current?.account.revision ?? null,
          account,
          encryptedCredential
        },
        directoryIdentity
      )
    } finally {
      this.writing = false
    }
  }
  async disable(raw: unknown): Promise<RelayBackupAccount> {
    const selected = backupAccountSelection(raw)
    if (this.writing) throw new Error('请等待备份账号保存结束。')
    this.writing = true
    try {
      const current = await this.load(selected.id)
      if (current.account.revision !== selected.revision) throw new Error('备份账号修订已变化。')
      if (current.account.state === 'disabled') return current.account
      return await this.publish(
        {
          ...current.frame,
          sequence: current.frame.sequence + 1,
          parentSHA256: current.account.revision,
          account: {
            ...current.frame.account,
            state: 'disabled',
            updatedAt: Math.max(this.adapters.now?.() ?? Date.now(), current.account.updatedAt)
          }
        },
        current.directoryIdentity
      )
    } finally {
      this.writing = false
    }
  }
}
