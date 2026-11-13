import { randomUUID } from 'crypto'
import { lstat, mkdir, opendir, rmdir, unlink } from 'fs/promises'
import { join } from 'path'
import { subscriptionRequest, type SubscriptionRequest } from '../../../shared/relay/subscription'
import {
  sourceSelection,
  type SubscriptionSourceInfo,
  type SubscriptionSourceSelection,
  type SubscriptionSourceInventory,
  type SubscriptionVersion,
  SourceOptions,
  SourceMetadata
} from '../../../shared/relay/subscription-sources'
import { profileSelection } from '../../../shared/relay/runtime'
import type { RelayStateContext } from '../context'
import { profileHash, readProfileFile } from '../profiles/source'
import { SubscriptionFiles } from './private-files'
import { sourceOptions, sourceMetadata } from './source-options'

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const keys = (value: unknown, fields: string): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === fields
export class SubscriptionJournalUncertain extends Error {
  constructor() {
    super('订阅事务或同步结果未确认；已保留全部记录，不自动重试。')
  }
}
export class SubscriptionSourceStore {
  readonly directory: string
  private readonly files: SubscriptionFiles
  constructor(context: RelayStateContext) {
    this.files = new SubscriptionFiles(context)
    this.directory = join(context.stateRoot, 'SubscriptionSources')
  }
  private async strictDirectory(path: string): Promise<void> {
    if (!(await this.files.directory(path)) || ((await lstat(path)).mode & 0o7777) !== 0o700)
      throw new Error('订阅私有目录未确认。')
  }
  private async json(path: string): Promise<{ raw: string; value: unknown }> {
    const raw = await readProfileFile(path, true)
    if (Buffer.byteLength(raw) > 65536) throw new Error('订阅记录超过预算。')
    return { raw, value: JSON.parse(raw) }
  }
  private async load(id: string) {
    if (!uuid.test(id)) throw new Error('订阅ID无效。')
    const root = join(this.directory, id)
    await this.strictDirectory(root)
    const before = await lstat(root)
    let locked = false,
      count = 0
    for await (const entry of await opendir(root)) {
      if (++count > 3 || !['source.json', 'versions', '.write-lock'].includes(entry.name))
        throw new Error('订阅存在未知条目。')
      if (entry.name === '.write-lock') {
        await this.strictDirectory(join(root, entry.name))
        locked = true
      }
    }
    const { raw, value } = await this.json(join(root, 'source.json'))
    if (
      !(
        (keys(value, 'createdAt,id,name,proxyPort,url,version') && value.version === 1) ||
        (keys(value, 'createdAt,id,name,options,proxyPort,url,version') && value.version === 2)
      ) ||
      value.id !== id ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt))
    )
      throw new Error('订阅来源记录无效。')
    const options = sourceOptions(value.options)
    const request = subscriptionRequest({
        name: value.name,
        url: value.url,
        proxyPort: value.proxyPort
      }),
      versionsPath = join(root, 'versions')
    await this.strictDirectory(versionsPath)
    const names: string[] = []
    for await (const entry of await opendir(versionsPath)) {
      if (names.length >= 900 || !/^\d{3}-[a-f0-9-]{36}\.json$/u.test(entry.name))
        throw new Error('订阅历史超限或存在未知条目。')
      names.push(entry.name)
    }
    names.sort()
    const versions: SubscriptionVersion[] = [],
      hashes: string[] = []
    let cache: { metadata: SourceMetadata; profile: SubscriptionVersion['profile'] } | undefined
    for (const [index, name] of names.entries()) {
      const entry = await this.json(join(versionsPath, name)),
        v = entry.value
      if (
        !(
          (keys(v, 'action,createdAt,id,parent,profile,restoredFrom,sequence,version') &&
            v.version === 1) ||
          (keys(v, 'action,createdAt,id,metadata,parent,profile,restoredFrom,sequence,version') &&
            v.version === 2)
        ) ||
        v.sequence !== index + 1 ||
        typeof v.id !== 'string' ||
        !uuid.test(v.id) ||
        name !== String(index + 1).padStart(3, '0') + '-' + v.id + '.json' ||
        v.parent !== (hashes.at(-1) ?? null) ||
        typeof v.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(v.createdAt)) ||
        !['update', 'restore', ...(v.version === 2 ? ['check'] : [])].includes(String(v.action))
      )
        throw new Error('订阅版本链无效。')
      const profile = profileSelection(v.profile)
      if (v.action !== 'restore' && v.restoredFrom !== null) throw new Error('订阅更新记录无效。')
      if (v.action === 'restore') {
        const prior = versions.find((p) => p.id === v.restoredFrom)
        if (!prior || JSON.stringify(prior.profile) !== JSON.stringify(profile))
          throw new Error('订阅恢复记录无效。')
      }
      if (
        v.action === 'check' &&
        JSON.stringify(versions.at(-1)?.profile) !== JSON.stringify(profile)
      )
        throw new Error('缓存记录与当前版本不一致。')
      if (v.version === 2) cache = { metadata: sourceMetadata(v.metadata), profile }
      else cache = undefined
      if (v.action !== 'check')
        versions.push({
          id: v.id,
          createdAt: v.createdAt,
          action: v.action as 'update' | 'restore',
          profile,
          ...(typeof v.restoredFrom === 'string' ? { restoredFrom: v.restoredFrom } : {})
        })
      hashes.push(profileHash(entry.raw))
      if (versions.length > 100) throw new Error('配置版本超限。')
    }
    const after = await lstat(root)
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('订阅目录已变化。')
    const info: SubscriptionSourceInfo = {
      id,
      revision: profileHash(`${before.dev}:${before.ino}\0` + raw + '\0' + hashes.join('\0')),
      name: request.name,
      origin: new URL(request.url).origin,
      proxyPort: request.proxyPort,
      createdAt: value.createdAt,
      versions,
      locked,
      schedule: options.schedule,
      redirectPolicy: options.redirects,
      hasPrivateHeaders: Object.keys(options.headers).length > 0,
      hasAgeIdentity: !!options.ageSecretKey,
      ...(cache
        ? {
            observation: {
              checkedAt: cache.metadata.checkedAt,
              status: cache.metadata.status,
              ...(cache.metadata.quota ? { quota: cache.metadata.quota } : {}),
              ...(cache.metadata.intervalMinutes
                ? { intervalMinutes: cache.metadata.intervalMinutes }
                : {}),
              ...(cache.metadata.filename ? { filename: cache.metadata.filename } : {}),
              ...(cache.metadata.homeOrigin ? { homeOrigin: cache.metadata.homeOrigin } : {})
            }
          }
        : {})
    }
    return {
      info,
      request,
      options,
      cache,
      originRevision: profileHash(`${before.dev}:${before.ino}\0` + raw),
      recordCount: hashes.length,
      parent: hashes.at(-1) ?? null
    }
  }
  async read(raw: unknown) {
    const selected = sourceSelection(raw),
      stored = await this.load(selected.id)
    if (stored.info.revision !== selected.revision) throw new Error('订阅修订已变化。')
    return stored
  }
  async readId(id: string) {
    return this.load(id)
  }
  async list(): Promise<SubscriptionSourceInventory> {
    const report: SubscriptionSourceInventory = { sources: [], incomplete: 0, warnings: [] }
    if (!(await this.files.directory(this.directory))) return report
    let count = 0
    for await (const entry of await opendir(this.directory)) {
      if (++count > 200) {
        report.warnings.push('来源列表超过200条，已截断；未删除。')
        break
      }
      try {
        report.sources.push((await this.load(entry.name)).info)
      } catch {
        ++report.incomplete
      }
    }
    report.sources.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
    )
    if (report.incomplete)
      report.warnings.push('有不完整／未知来源或历史链；保留原文件，未自动修复。')
    return report
  }
  async create(
    raw: SubscriptionRequest,
    rawOptions?: SourceOptions
  ): Promise<SubscriptionSourceInfo> {
    const request = subscriptionRequest(raw),
      id = randomUUID(),
      root = join(this.directory, id),
      options = rawOptions === undefined ? undefined : sourceOptions(rawOptions),
      source = JSON.stringify({
        version: options ? 2 : 1,
        id,
        createdAt: new Date().toISOString(),
        ...request,
        ...(options ? { options } : {})
      })
    if (Buffer.byteLength(source) > 65536) throw new Error('来源选项超过64KiB预算。')
    await this.files.directory(this.directory, true)
    await mkdir(root, { mode: 0o700 })
    try {
      await this.strictDirectory(root)
      await this.files.sync(this.directory)
      await mkdir(join(root, 'versions'), { mode: 0o700 })
      await this.files.write(join(root, 'source.json'), source)
      await this.files.sync(root)
      await this.files.sync(this.directory)
      return (await this.load(id)).info
    } catch {
      throw new SubscriptionJournalUncertain()
    }
  }
  // A profile is written before the append-only commit. A crash can leave an
  // orphan immutable profile or lock, never replace the previous version head.
  async commit(
    selection: SubscriptionSourceSelection,
    build: () => Promise<{ profile: SubscriptionVersion['profile']; restoredFrom?: string }>,
    observation?: { metadata: SourceMetadata; check?: boolean }
  ): Promise<SubscriptionSourceInfo> {
    const selected = sourceSelection(selection),
      root = join(this.directory, selected.id),
      lock = join(root, '.write-lock'),
      token = randomUUID()
    await this.read(selected)
    try {
      await mkdir(lock, { mode: 0o700 })
    } catch {
      throw new Error('订阅写锁存在；保留现场，不接管旧锁。')
    }
    const identity = await lstat(lock)
    let owned = false,
      wrote = false
    let result: SubscriptionSourceInfo | undefined, failure: Error | undefined
    try {
      await this.files.write(join(lock, 'owner.json'), JSON.stringify({ token }))
      owned = true
      await this.files.sync(lock)
      await this.files.sync(root)
      const current = await this.read(selected)
      if (
        current.recordCount >= 900 ||
        (!observation?.check && current.info.versions.length >= 100)
      )
        throw new Error('版本或缓存记录数量已满，未更新。')
      wrote = true
      const built = await build()
      const fresh = await this.read(selected)
      const sameLock = await lstat(lock)
      if (
        sameLock.dev !== identity.dev ||
        sameLock.ino !== identity.ino ||
        (await this.json(join(lock, 'owner.json'))).raw !== JSON.stringify({ token })
      )
        throw new Error()
      const sequence = fresh.recordCount + 1,
        id = randomUUID(),
        record = {
          version: observation ? 2 : 1,
          sequence,
          id,
          parent: fresh.parent,
          createdAt: new Date().toISOString(),
          action: observation?.check ? 'check' : built.restoredFrom ? 'restore' : 'update',
          profile: profileSelection(built.profile),
          restoredFrom: built.restoredFrom ?? null,
          ...(observation ? { metadata: sourceMetadata(observation.metadata) } : {})
        }
      if (
        built.restoredFrom &&
        !fresh.info.versions.some(
          (v) =>
            v.id === built.restoredFrom &&
            JSON.stringify(v.profile) === JSON.stringify(record.profile)
        )
      )
        throw new Error()
      const versions = join(root, 'versions')
      await this.files.write(
        join(versions, String(sequence).padStart(3, '0') + '-' + id + '.json'),
        JSON.stringify(record)
      )
      await this.files.sync(versions)
      await this.files.sync(root)
      const committed = await this.load(selected.id)
      if (
        committed.recordCount !== sequence ||
        (!observation?.check && committed.info.versions.at(-1)?.id !== id)
      )
        throw new Error()
      result = { ...committed.info, locked: false }
    } catch (error) {
      failure =
        wrote || !owned || error instanceof SubscriptionJournalUncertain
          ? new SubscriptionJournalUncertain()
          : new Error('订阅事务未完成，既有版本保留。')
    }
    try {
      // Refuse to clear a replaced lock or unknown owner. Never remove a lock
      // by PID or age, even if a previous process appears to have exited.
      if (owned) {
        const after = await lstat(lock)
        if (
          after.dev !== identity.dev ||
          after.ino !== identity.ino ||
          (await this.json(join(lock, 'owner.json'))).raw !== JSON.stringify({ token })
        )
          throw new SubscriptionJournalUncertain()
        await unlink(join(lock, 'owner.json'))
        await rmdir(lock)
        await this.files.sync(root)
      }
    } catch {
      failure = new SubscriptionJournalUncertain()
    }
    if (failure) throw failure
    if (!result) throw new SubscriptionJournalUncertain()
    return result
  }
  async observe(
    selection: SubscriptionSourceSelection,
    metadata: SourceMetadata
  ): Promise<SubscriptionSourceInfo> {
    const current = await this.read(selection),
      last = current.info.versions.at(-1)
    if (!last) throw new Error('没有可验证的缓存配置。')
    return this.commit(selection, async () => ({ profile: last.profile }), {
      metadata: sourceMetadata(metadata),
      check: true
    })
  }
}
