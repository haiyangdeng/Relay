import { constants } from 'node:fs'
import { lstat, mkdtemp, open, opendir, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { SubscriptionFiles } from '../../subscriptions/private-files'
import type { RelayStateContext } from '../../context'
import {
  appUpdateCandidateId,
  appUpdateObject,
  type RelayAppUpdateCandidate
} from '../../../../shared/relay/app-updates'
import { publicAppRelease, appVersion, type TrustedAppRelease } from './release'
import { appUpdateURL, type AppReleaseConfiguration } from './configuration'

export const appUpdateHash = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
interface AppUpdateFileDigest {
  bytes: number
  sha256: string
  sha512: string
}
export async function hashAppUpdateFile(
  path: string,
  maximumBytes: number,
  beforeIdentityReadback?: (observed: AppUpdateFileDigest) => Promise<void>
): Promise<AppUpdateFileDigest> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 1024 ** 3 ||
    (await realpath(path)) !== path
  )
    throw new Error('应用更新文件预算或路径无效。')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== 0o600 ||
      before.size < 1 ||
      before.size > maximumBytes
    )
      throw new Error('应用更新私有文件不安全。')
    const sha256 = createHash('sha256'),
      sha512 = createHash('sha512'),
      chunk = Buffer.alloc(65536)
    let bytes = 0
    while (bytes <= before.size) {
      const result = await file.read(
        chunk,
        0,
        Math.min(chunk.length, before.size + 1 - bytes),
        bytes
      )
      if (!result.bytesRead) break
      sha256.update(chunk.subarray(0, result.bytesRead))
      sha512.update(chunk.subarray(0, result.bytesRead))
      bytes += result.bytesRead
    }
    const observed = { bytes, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
    await beforeIdentityReadback?.(observed)
    const after = await file.stat(),
      linked = await lstat(path)
    if (
      bytes !== before.size ||
      [after, linked].some(
        (value) =>
          value.dev !== before.dev ||
          value.ino !== before.ino ||
          value.size !== before.size ||
          value.mode !== before.mode ||
          value.uid !== before.uid ||
          value.nlink !== before.nlink ||
          value.mtimeMs !== before.mtimeMs ||
          value.ctimeMs !== before.ctimeMs
      )
    )
      throw new Error('应用更新文件摘要期间发生变化。')
    return observed
  } finally {
    await file.close()
  }
}
export async function readAppUpdateFile(
  path: string,
  maximumBytes: number,
  privateCopy = true
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 ** 3)
    throw new Error('应用更新文件预算无效。')
  if ((await realpath(path)) !== path) throw new Error('应用更新文件路径已变化。')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (privateCopy && (before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o600)) ||
      before.size < 1 ||
      before.size > maximumBytes
    )
      throw new Error('应用更新文件类型、权限或大小无效。')
    const bytes = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, size)
      if (!part.bytesRead) break
      size += part.bytesRead
    }
    const after = await file.stat(),
      linked = await lstat(path)
    if (
      size !== before.size ||
      [after, linked].some(
        (value) =>
          value.dev !== before.dev ||
          value.ino !== before.ino ||
          value.size !== before.size ||
          value.mode !== before.mode ||
          value.uid !== before.uid ||
          value.nlink !== before.nlink ||
          value.mtimeMs !== before.mtimeMs ||
          value.ctimeMs !== before.ctimeMs
      )
    )
      throw new Error('应用更新文件读取期间已变化。')
    return bytes.subarray(0, size)
  } finally {
    await file.close()
  }
}

export interface StoredAppUpdate {
  release: TrustedAppRelease
  candidate: RelayAppUpdateCandidate
}
const MAX_APP_UPDATE_CANDIDATES = 64
const isCandidateEntry = (name: string): boolean =>
  !name.startsWith('.') && name !== 'installation.json'

export class AppUpdateCandidateStore {
  readonly root: string
  readonly files: SubscriptionFiles
  private staging = false
  constructor(readonly context: RelayStateContext) {
    this.files = new SubscriptionFiles(context)
    this.root = join(context.stateRoot, 'Updates', 'App')
  }
  private async directory(path: string, create = false): Promise<boolean> {
    if (!(await this.files.directory(path, create))) return false
    const info = await lstat(path)
    if ((info.mode & 0o7777) !== 0o700) throw new Error('应用更新目录必须为私有目录。')
    return true
  }
  async stage(
    release: TrustedAppRelease,
    bytes: Buffer,
    signal: AbortSignal
  ): Promise<RelayAppUpdateCandidate> {
    if (this.staging) throw new Error('请等待本次应用更新候选暂存结束。')
    this.staging = true
    try {
      return await this.stageCandidate(release, bytes, signal)
    } finally {
      this.staging = false
    }
  }
  private async stageCandidate(
    release: TrustedAppRelease,
    bytes: Buffer,
    signal: AbortSignal
  ): Promise<RelayAppUpdateCandidate> {
    if (
      signal.aborted ||
      bytes.length !== release.bytes ||
      bytes.subarray(0, 4).toString() !== 'xar!' ||
      createHash('sha512').update(bytes).digest('base64') !== release.sha512
    )
      throw new Error('应用包大小、摘要或格式校验失败。')
    await this.directory(this.root, true)
    let count = 0
    for await (const entry of await opendir(this.root)) {
      if (isCandidateEntry(entry.name) && ++count >= MAX_APP_UPDATE_CANDIDATES)
        throw new Error('应用更新候选已达上限，请先移除旧候选。')
    }
    if (signal.aborted) throw new Error('应用包暂存取消。')
    const stage = await mkdtemp(join(this.root, '.candidate-')),
      identity = await lstat(stage)
    const candidate: RelayAppUpdateCandidate = {
      ...publicAppRelease(release),
      id: randomUUID(),
      sha256: appUpdateHash(bytes),
      stagedAt: Date.now()
    }
    let failure: unknown
    try {
      const output = await open(join(stage, 'update.pkg'), 'wx', 0o600)
      try {
        await output.writeFile(bytes)
        await output.sync()
      } finally {
        await output.close()
      }
      await this.files.write(join(stage, 'record.json'), JSON.stringify({ release, candidate }))
      await this.files.sync(stage)
      if (signal.aborted) throw new Error('应用包暂存取消。')
      if (
        appUpdateHash(await readAppUpdateFile(join(stage, 'update.pkg'), release.bytes)) !==
        candidate.sha256
      )
        throw new Error('应用包写入复核失败。')
      if (signal.aborted) throw new Error('应用包暂存取消。')
      await rename(stage, join(this.root, candidate.id))
      await this.files.sync(this.root)
    } catch (error) {
      failure = error
    } finally {
      try {
        const current = await lstat(stage)
        if (
          current.dev === identity.dev &&
          current.ino === identity.ino &&
          current.isDirectory() &&
          !current.isSymbolicLink()
        )
          await rm(stage, { recursive: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure = error
      }
    }
    if (failure) throw failure
    return candidate
  }
  async resolve(
    id: string,
    config: Readonly<AppReleaseConfiguration>,
    trustRevision: string
  ): Promise<StoredAppUpdate & { path: string }> {
    appUpdateCandidateId({ id })
    const root = join(this.root, id)
    if (!(await this.directory(root))) throw new Error('应用候选不存在。')
    const names: string[] = []
    for await (const entry of await opendir(root)) names.push(entry.name)
    if (names.sort().join(',') !== 'record.json,update.pkg') throw new Error('应用候选有未知条目。')
    const raw: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readAppUpdateFile(join(root, 'record.json'), 16384)
      )
    )
    const record = appUpdateObject(raw, ['release', 'candidate'])
    const release = appUpdateObject(record.release, [
      'version',
      'architecture',
      'bytes',
      'sha512',
      'releasedAt',
      'url',
      'metadataSHA256',
      'trustRevision'
    ])
    const item = appUpdateObject(record.candidate, [
      'version',
      'architecture',
      'bytes',
      'sha512',
      'releasedAt',
      'id',
      'sha256',
      'stagedAt'
    ])
    if (
      release.trustRevision !== trustRevision ||
      !['arm64', 'x64'].includes(String(release.architecture)) ||
      !Number.isSafeInteger(release.bytes) ||
      Number(release.bytes) < 1 ||
      Number(release.bytes) > config.maximumPackageBytes ||
      typeof release.sha512 !== 'string' ||
      !/^[A-Za-z0-9+/]{86}==$/u.test(release.sha512) ||
      typeof release.releasedAt !== 'string' ||
      !Number.isFinite(Date.parse(release.releasedAt)) ||
      typeof release.metadataSHA256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(release.metadataSHA256) ||
      typeof release.url !== 'string' ||
      item.id !== id ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      !Number.isSafeInteger(item.stagedAt) ||
      Number(item.stagedAt) < 1
    )
      throw new Error('应用候选记录未通过发布身份校验。')
    const trusted: TrustedAppRelease = {
      version: appVersion(release.version),
      architecture: release.architecture as 'arm64' | 'x64',
      bytes: Number(release.bytes),
      sha512: release.sha512,
      releasedAt: release.releasedAt,
      url: appUpdateURL(release.url, config.downloadOrigins),
      metadataSHA256: release.metadataSHA256,
      trustRevision
    }
    if (Object.entries(publicAppRelease(trusted)).some(([key, value]) => item[key] !== value))
      throw new Error('应用候选与来源记录不一致。')
    const path = join(root, 'update.pkg'),
      digest = await hashAppUpdateFile(path, trusted.bytes)
    if (
      digest.bytes !== trusted.bytes ||
      digest.sha256 !== item.sha256 ||
      digest.sha512 !== trusted.sha512
    )
      throw new Error('应用候选正文已变化。')
    return {
      release: trusted,
      candidate: {
        ...publicAppRelease(trusted),
        id,
        sha256: item.sha256,
        stagedAt: Number(item.stagedAt)
      },
      path
    }
  }
  async list(
    config: Readonly<AppReleaseConfiguration>,
    trustRevision: string
  ): Promise<{
    candidates: RelayAppUpdateCandidate[]
    incomplete: number
  }> {
    const candidates: RelayAppUpdateCandidate[] = []
    let incomplete = 0,
      count = 0
    if (!(await this.directory(this.root))) return { candidates, incomplete }
    for await (const entry of await opendir(this.root)) {
      if (!isCandidateEntry(entry.name)) continue
      // Older versions can have more entries. Keep the normal removal path
      // available while limiting how many package digests this read can check.
      if (++count > MAX_APP_UPDATE_CANDIDATES) {
        incomplete++
        continue
      }
      try {
        candidates.push((await this.resolve(entry.name, config, trustRevision)).candidate)
      } catch {
        incomplete++
      }
    }
    return { candidates, incomplete }
  }
  async remove(
    id: string,
    config: Readonly<AppReleaseConfiguration>,
    trustRevision: string,
    assertCurrent: () => void
  ): Promise<void> {
    assertCurrent()
    await this.resolve(id, config, trustRevision)
    assertCurrent()
    await rm(join(this.root, id), { recursive: true })
    await this.files.sync(this.root)
  }
}
