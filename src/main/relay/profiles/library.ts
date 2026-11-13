import { constants, type Stats } from 'fs'
import { lstat, open } from 'fs/promises'
import { join } from 'path'
import { KeyedWriteQueue, atomicWriteFile } from '../../utils/safeFile'
import { SubscriptionFiles } from '../subscriptions/private-files'
import type { RelayStateContext } from '../context'
import {
  libraryChange,
  libraryId,
  libraryName,
  type RelayLibraryInventory,
  type RelayLibraryItem,
  type RelayLibraryKind
} from '../../../shared/relay/library'
import { readProfileFile, profileHash } from './source'
const writes = new KeyedWriteQueue(),
  limit = 256 * 1024
interface Entry {
  kind: RelayLibraryKind
  id: string
  name?: string
  hidden: boolean
}
interface Document {
  version: 1
  entries: Entry[]
  order: { profile: string[]; source: string[] }
}
const empty = (): Document => ({ version: 1, entries: [], order: { profile: [], source: [] } })
const same = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.uid === b.uid &&
  a.mode === b.mode &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs
function document(input: unknown): Document {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('库显示资料无效。')
  const raw = input as Record<string, unknown>
  if (
    Object.keys(raw).sort().join(',') !== 'entries,order,version' ||
    raw.version !== 1 ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > 400 ||
    !raw.order ||
    typeof raw.order !== 'object' ||
    Array.isArray(raw.order)
  )
    throw new Error('库显示资料无效。')
  const entries = raw.entries.map((item): Entry => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('库显示条目无效。')
    const row = item as Record<string, unknown>
    if (
      Object.keys(row).some((k) => !['kind', 'id', 'name', 'hidden'].includes(k)) ||
      (row.kind !== 'profile' && row.kind !== 'source') ||
      typeof row.hidden !== 'boolean'
    )
      throw new Error('库显示条目无效。')
    return {
      kind: row.kind,
      id: libraryId(row.id),
      hidden: row.hidden,
      ...(row.name !== undefined ? { name: libraryName(row.name) } : {})
    }
  })
  const order = raw.order as Record<string, unknown>,
    checked: Document['order'] = { profile: [], source: [] }
  if (Object.keys(order).sort().join(',') !== 'profile,source') throw new Error('库顺序无效。')
  for (const kind of ['profile', 'source'] as const) {
    const ids = order[kind]
    if (!Array.isArray(ids) || ids.length > 200) throw new Error('库顺序超限。')
    checked[kind] = ids.map(libraryId)
    if (new Set(checked[kind]).size !== ids.length) throw new Error('库顺序重复。')
  }
  if (new Set(entries.map((row) => row.kind + ':' + row.id)).size !== entries.length)
    throw new Error('库显示条目重复。')
  return { version: 1, entries, order: checked }
}
// Display metadata only. Authoritative immutable sources and all history remain
// accessible to configuration/restore/scheduler readers through their old stores.
export class RelayLibraryStore {
  private pending = 0
  private readonly waiters: (() => void)[] = []
  isBusy(): boolean {
    return this.pending > 0
  }
  whenIdle(): Promise<void> {
    return this.pending ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve()
  }
  private readonly files: SubscriptionFiles
  private readonly directory: string
  private readonly path: string
  constructor(
    context: RelayStateContext,
    private readonly inventory: () => Promise<Omit<RelayLibraryItem, 'hidden'>[]>
  ) {
    this.files = new SubscriptionFiles(context)
    this.directory = join(context.stateRoot, 'Configuration')
    this.path = join(this.directory, 'profile-library.json')
  }
  private async directoryInfo(create: boolean): Promise<Stats | null> {
    if (!(await this.files.directory(this.directory, create))) return null
    const before = await lstat(this.directory),
      handle = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
    try {
      const pinned = await handle.stat()
      if (
        before.dev !== pinned.dev ||
        before.ino !== pinned.ino ||
        !pinned.isDirectory() ||
        pinned.uid !== process.getuid?.() ||
        ![0o700, 0o755].includes(pinned.mode & 0o7777)
      )
        throw new Error('库目录身份无效。')
      if (create && (pinned.mode & 0o7777) === 0o755) {
        await handle.chmod(0o700)
        await handle.sync()
      }
      const after = await handle.stat(),
        current = await lstat(this.directory)
      if (
        after.dev !== pinned.dev ||
        after.ino !== pinned.ino ||
        (after.mode & 0o7777) !== (create ? 0o700 : pinned.mode & 0o7777) ||
        after.dev !== current.dev ||
        after.ino !== current.ino ||
        after.mode !== current.mode
      )
        throw new Error('库目录已变化。')
      return after
    } finally {
      await handle.close()
    }
  }
  private async load() {
    const directory = await this.directoryInfo(false)
    if (!directory) return { value: empty(), raw: '', directory, file: null as Stats | null }
    let file: Stats
    try {
      file = await lstat(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { value: empty(), raw: '', directory, file: null as Stats | null }
    }
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.uid !== process.getuid?.() ||
      file.nlink !== 1 ||
      (file.mode & 0o7777) !== 0o600 ||
      file.size < 1 ||
      file.size > limit
    )
      throw new Error('库显示资料身份、权限或大小无效；保留原件。')
    const raw = await readProfileFile(this.path, true),
      value = document(JSON.parse(raw)),
      after = await lstat(this.directory)
    if (
      !same(file, await lstat(this.path)) ||
      directory.dev !== after.dev ||
      directory.ino !== after.ino ||
      directory.mode !== after.mode
    )
      throw new Error('库显示资料读取期间变化。')
    return { value, raw, directory, file }
  }
  private project(value: Document, items: Omit<RelayLibraryItem, 'hidden'>[]): RelayLibraryItem[] {
    if (
      items.length > 400 ||
      new Set(items.map((row) => row.kind + ':' + row.id)).size !== items.length
    )
      throw new Error('实际库列表超限或身份重复。')
    return items
      .map((item) => {
        const saved = value.entries.find((row) => row.kind === item.kind && row.id === item.id)
        return {
          ...item,
          ...(saved?.name ? { name: saved.name } : {}),
          hidden: saved?.hidden ?? false
        }
      })
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
        const ids = value.order[a.kind],
          left = ids.indexOf(a.id),
          right = ids.indexOf(b.id)
        return (left < 0 ? 200 : left) - (right < 0 ? 200 : right)
      })
  }
  private result(
    loaded: Awaited<ReturnType<RelayLibraryStore['load']>>,
    items: Omit<RelayLibraryItem, 'hidden'>[]
  ): RelayLibraryInventory {
    return {
      revision: profileHash(loaded.raw + '\0' + JSON.stringify(items)),
      items: this.project(loaded.value, items)
    }
  }
  async list(): Promise<RelayLibraryInventory> {
    const loaded = await this.load()
    return this.result(loaded, await this.inventory())
  }
  async view<T extends { id: string; name: string }>(
    kind: RelayLibraryKind,
    items: T[],
    preserveAll = false
  ): Promise<T[]> {
    const catalog = await this.list(),
      views = catalog.items.filter((row) => row.kind === kind),
      order = new Map(views.map((row, index) => [row.id, index]))
    return items
      .flatMap((item) => {
        const row = views.find((row) => row.id === item.id)
        if (!row) throw new Error('库列表已变化，请重新读取。')
        return row.hidden && !row.active && !preserveAll
          ? []
          : [{ ...item, name: row.name + (row.hidden ? '（已移出库，当前使用）' : '') }]
      })
      .sort((a, b) => (order.get(a.id) ?? 200) - (order.get(b.id) ?? 200))
  }
  change(input: unknown, assertCurrent: () => void): Promise<RelayLibraryInventory> {
    const request = libraryChange(input)
    ++this.pending
    return writes
      .run(this.path, async () => {
        assertCurrent()
        const current = await this.load(),
          items = await this.inventory(),
          report = this.result(current, items)
        assertCurrent()
        if (report.revision !== request.expectedRevision)
          throw new Error('库列表或修订已变化，请重新读取；未覆盖。')
        const target = report.items.find(
          (row) => row.kind === request.kind && row.id === request.id
        )
        if (!target) throw new Error('库条目不存在。')
        if (
          request.action === 'hide' &&
          (target.active || target.scheduled || target.protectionReason)
        )
          throw new Error(
            target.scheduled
              ? '请先明确停用这个来源的定时更新，再移出库。'
              : target.protectionReason || '当前使用的配置不能移出库。'
          )
        const next = structuredClone(current.value),
          entry = next.entries.find(
            (row) => row.kind === request.kind && row.id === request.id
          ) ?? {
            kind: request.kind,
            id: request.id,
            hidden: false
          }
        if (!next.entries.includes(entry)) next.entries.push(entry)
        if (request.action === 'rename') entry.name = request.name
        else if (request.action === 'hide' || request.action === 'restore')
          entry.hidden = request.action === 'hide'
        else if (request.action === 'move') {
          const ids = report.items.filter((row) => row.kind === request.kind).map((row) => row.id),
            index = ids.indexOf(request.id),
            to = index + (request.direction === 'up' ? -1 : 1)
          if (to >= 0 && to < ids.length) [ids[index], ids[to]] = [ids[to], ids[index]]
          next.order[request.kind] = ids
        }
        const raw = JSON.stringify(document(next), null, 2)
        if (Buffer.byteLength(raw) > limit) throw new Error('库显示资料超过预算。')
        const directory = await this.directoryInfo(true),
          latest = await this.load(),
          latestItems = await this.inventory()
        assertCurrent()
        if (
          !directory ||
          !latest.directory ||
          directory.dev !== latest.directory.dev ||
          directory.ino !== latest.directory.ino ||
          current.raw !== latest.raw ||
          (current.file && (!latest.file || !same(current.file, latest.file))) ||
          report.revision !== this.result(latest, latestItems).revision
        )
          throw new Error('库资料已变化，未写入。')
        try {
          await atomicWriteFile(this.path, raw, { mode: 0o600 })
          await this.files.sync(this.directory)
          const saved = await this.load()
          assertCurrent()
          if (
            saved.raw !== raw ||
            !saved.directory ||
            saved.directory.dev !== directory.dev ||
            saved.directory.ino !== directory.ino
          )
            throw new Error()
          return this.result(saved, await this.inventory())
        } catch {
          throw new Error('库显示设置写入未确认；原文与版本保留，请重新读取，不自动重试。')
        }
      })
      .finally(() => {
        if (--this.pending === 0) this.waiters.splice(0).forEach((resolve) => resolve())
      })
  }
}
