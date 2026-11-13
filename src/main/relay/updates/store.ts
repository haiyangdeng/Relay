import { createHash, randomUUID } from 'crypto'
import { gunzipSync } from 'zlib'
import { lstat, mkdtemp, open, opendir, realpath, rename, rm } from 'fs/promises'
import { join } from 'path'
import type { RelayUpdateCandidate } from '../../../shared/relay/updates'
import { relayUpdateId, RELAY_UPDATE_TARGETS } from '../../../shared/relay/updates'
import type { RelayStateContext } from '../context'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { readBinaryResource } from '../resources/source'
import { subStoreFrontendFiles } from '../substore/resources'
import { publicUpdateAsset, type TrustedUpdateAsset } from './catalog'

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export function verifiedUpdatePayload(asset: TrustedUpdateAsset, bytes: Buffer): Buffer {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== asset.downloadBytes ||
    sha(bytes) !== asset.downloadSHA256
  )
    throw new Error('更新下载的大小或可信摘要不符。')
  const payload =
    asset.encoding === 'gzip'
      ? gunzipSync(bytes, { maxOutputLength: asset.payloadBytes })
      : Buffer.from(bytes)
  if (payload.length !== asset.payloadBytes || sha(payload) !== asset.payloadSHA256)
    throw new Error('更新候选展开后的大小或可信摘要不符。')
  if (
    ['core', 'core-alpha', 'core-smart'].includes(asset.target) &&
    (payload.length < 8 ||
      payload.readUInt32LE(0) !== 0xfeedfacf ||
      payload.readUInt32LE(4) !== asset.cpuType)
  )
    throw new Error('核心候选Mach-O架构不符。')
  if (asset.target === 'substore-frontend') subStoreFrontendFiles(payload)
  if (
    asset.target.startsWith('smart-model') &&
    (payload.length <= 128 ||
      !payload.subarray(0, 64).toString('latin1').startsWith('tree') ||
      !payload.subarray(-64).toString('latin1').trimEnd().endsWith('[/target_enhance]'))
  )
    throw new Error('Smart模型候选格式不完整。')
  return payload
}

export class UpdateCandidateStore {
  private readonly files: SubscriptionFiles
  readonly directory: string
  constructor(
    context: RelayStateContext,
    readonly catalog: readonly TrustedUpdateAsset[]
  ) {
    this.files = new SubscriptionFiles(context)
    this.directory = join(context.stateRoot, 'Updates')
    const targets = new Set<string>()
    for (const asset of catalog) {
      if (
        targets.has(asset.target) ||
        !RELAY_UPDATE_TARGETS.includes(asset.target) ||
        !/^[a-f0-9]{64}$/u.test(asset.downloadSHA256) ||
        !/^[a-f0-9]{64}$/u.test(asset.payloadSHA256) ||
        !Number.isSafeInteger(asset.downloadBytes) ||
        asset.downloadBytes < 1 ||
        asset.downloadBytes > 128 * 1024 * 1024 ||
        !Number.isSafeInteger(asset.payloadBytes) ||
        asset.payloadBytes < 1 ||
        asset.payloadBytes > 128 * 1024 * 1024
      )
        throw new Error('构建时可信更新清单无效。')
      targets.add(asset.target)
    }
  }
  asset(target: string): TrustedUpdateAsset {
    const asset = this.catalog.find((entry) => entry.target === target)
    if (!asset) throw new Error('该资源尚无Relay可信更新清单。')
    return structuredClone(asset)
  }
  async stage(
    asset: TrustedUpdateAsset,
    downloaded: Buffer,
    signal?: AbortSignal
  ): Promise<RelayUpdateCandidate> {
    if (signal?.aborted) throw new Error('候选暂存已取消。')
    const expected = this.asset(asset.target)
    if (JSON.stringify(expected) !== JSON.stringify(asset)) throw new Error('更新清单已变化。')
    const payload = verifiedUpdatePayload(expected, downloaded)
    await this.files.directory(this.directory, true)
    const stage = await mkdtemp(join(this.directory, '.candidate-'))
    const identity = await lstat(stage)
    const record: RelayUpdateCandidate = {
      ...publicUpdateAsset(expected),
      id: randomUUID(),
      payloadBytes: payload.length,
      payloadSHA256: expected.payloadSHA256,
      stagedAt: Date.now(),
      installed: false,
      applied: false
    }
    let failure: unknown
    try {
      const output = await open(join(stage, 'candidate.bin'), 'wx', 0o600)
      try {
        await output.writeFile(payload)
        await output.sync()
      } finally {
        await output.close()
      }
      await this.files.write(join(stage, 'record.json'), JSON.stringify(record))
      if (
        sha(await readBinaryResource(join(stage, 'candidate.bin'), true)) !== record.payloadSHA256
      )
        throw new Error()
      await this.files.sync(stage)
      if (signal?.aborted) throw new Error('候选暂存已取消。')
      await rename(stage, join(this.directory, record.id))
      await this.files.sync(this.directory)
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
    return structuredClone(record)
  }
  async resolve(id: string): Promise<{ record: RelayUpdateCandidate; path: string }> {
    relayUpdateId({ id })
    const root = join(this.directory, id)
    if (!(await this.files.directory(root))) throw new Error('更新候选不存在。')
    const names: string[] = []
    for await (const entry of await opendir(root)) names.push(entry.name)
    if (names.sort().join(',') !== 'candidate.bin,record.json')
      throw new Error('更新候选目录存在未知条目。')
    const bytes = await readBinaryResource(join(root, 'record.json'), true)
    if (bytes.length > 4096) throw new Error('更新候选记录过大。')
    const raw: unknown = JSON.parse(bytes.toString('utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('更新候选记录无效。')
    const item = raw as Record<string, unknown>
    if (item.id !== id || typeof item.target !== 'string') throw new Error('更新候选标识无效。')
    const asset = this.asset(item.target)
    if (
      typeof item.stagedAt !== 'number' ||
      !Number.isSafeInteger(item.stagedAt) ||
      item.stagedAt < 1
    )
      throw new Error('更新候选时间无效。')
    const expected: RelayUpdateCandidate = {
      ...publicUpdateAsset(asset),
      id,
      payloadBytes: asset.payloadBytes,
      payloadSHA256: asset.payloadSHA256,
      stagedAt: item.stagedAt,
      installed: false,
      applied: false
    }
    if (
      Object.keys(item).sort().join(',') !== Object.keys(expected).sort().join(',') ||
      Object.keys(expected).some((key) => item[key] !== expected[key as keyof typeof expected])
    )
      throw new Error('更新候选与当前可信清单不符。')
    const path = join(root, 'candidate.bin')
    const payload = await readBinaryResource(path, true)
    if (payload.length !== asset.payloadBytes || sha(payload) !== asset.payloadSHA256)
      throw new Error('更新候选已损坏。')
    if ((await realpath(path)) !== path) throw new Error('更新候选路径已变化。')
    return { record: expected, path }
  }
  async list(): Promise<{ candidates: RelayUpdateCandidate[]; incomplete: number }> {
    const candidates: RelayUpdateCandidate[] = []
    let incomplete = 0
    if (!(await this.files.directory(this.directory))) return { candidates, incomplete }
    let count = 0
    for await (const entry of await opendir(this.directory)) {
      if (entry.name.startsWith('.candidate-')) continue
      if (++count > 200) throw new Error('更新候选过多，请清理旧候选。')
      try {
        candidates.push((await this.resolve(entry.name)).record)
      } catch {
        incomplete++
      }
    }
    return { candidates, incomplete }
  }
  async remove(id: string): Promise<void> {
    const { record } = await this.resolve(id)
    const path = join(this.directory, record.id)
    if (!(await this.files.directory(path))) throw new Error('更新候选目录已变化。')
    await rm(path, { recursive: true })
    await this.files.sync(this.directory)
  }
}
