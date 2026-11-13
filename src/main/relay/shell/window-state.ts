import { lstat } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import type { RelayStateContext } from '../context'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { readBinaryResource } from '../resources/source'
import { atomicWriteFile, KeyedWriteQueue } from '../../utils/safeFile'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}
export interface RelayWindowState {
  version: 1
  normalBounds: WindowBounds
  maximized: boolean
}
export interface WindowDisplay {
  id: string | number
  workArea: WindowBounds
}
export interface ResolvedWindowGeometry {
  bounds: WindowBounds
  minWidth: number
  minHeight: number
  maximized: boolean
}
export interface WindowStateRead {
  saved?: RelayWindowState
  revision: string
  writable: boolean
  warnings: string[]
}
export type WindowStateKind = 'main' | 'floating'
const writes = new KeyedWriteQueue(),
  hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
function windowStateKind(kind: WindowStateKind): WindowStateKind {
  if (kind !== 'main' && kind !== 'floating') throw new Error('窗口类型无效。')
  return kind
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('窗口几何记录无效。')
  return value as Record<string, unknown>
}
function bounds(value: unknown): WindowBounds {
  const input = object(value)
  if (
    Object.keys(input).sort().join(',') !== 'height,width,x,y' ||
    !Object.values(input).every(Number.isSafeInteger) ||
    Number(input.width) < 1 ||
    Number(input.height) < 1 ||
    !Number.isSafeInteger(Number(input.x) + Number(input.width)) ||
    !Number.isSafeInteger(Number(input.y) + Number(input.height))
  )
    throw new Error('窗口坐标或尺寸无效。')
  return {
    x: Number(input.x),
    y: Number(input.y),
    width: Number(input.width),
    height: Number(input.height)
  }
}
export function parseWindowState(value: unknown): RelayWindowState {
  const input = object(value)
  if (
    Object.keys(input).sort().join(',') !== 'maximized,normalBounds,version' ||
    input.version !== 1 ||
    typeof input.maximized !== 'boolean'
  )
    throw new Error('窗口几何记录版本或字段无效。')
  return { version: 1, normalBounds: bounds(input.normalBounds), maximized: input.maximized }
}
export function clampWindowState(
  saved: RelayWindowState | undefined,
  displays: WindowDisplay[],
  primaryId?: string | number,
  kind: WindowStateKind = 'main'
): ResolvedWindowGeometry {
  const floating = windowStateKind(kind) === 'floating'
  const areas = displays.map((display) => ({ ...display, workArea: bounds(display.workArea) }))
  if (!areas.length)
    areas.push({ id: 'fallback', workArea: { x: 0, y: 0, width: 1180, height: 800 } })
  const primary = areas.find((display) => display.id === primaryId) ?? areas[0]
  let target = primary
  if (saved) {
    const normal = parseWindowState(saved).normalBounds,
      rect = floating ? { ...normal, width: 260, height: 110 } : normal,
      intersection = (area: WindowBounds): number =>
        Math.max(0, Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)) *
        Math.max(
          0,
          Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y)
        ),
      distance = (area: WindowBounds): number =>
        (rect.x + rect.width / 2 - area.x - area.width / 2) ** 2 +
        (rect.y + rect.height / 2 - area.y - area.height / 2) ** 2
    let overlap = intersection(target.workArea)
    for (const display of areas) {
      const next = intersection(display.workArea)
      if (next > overlap) {
        target = display
        overlap = next
      }
    }
    if (!overlap)
      for (const display of areas)
        if (distance(display.workArea) < distance(target.workArea)) target = display
  }
  const area = target.workArea,
    minWidth = Math.min(floating ? 260 : 960, area.width),
    minHeight = Math.min(floating ? 110 : 640, area.height),
    width = Math.max(
      minWidth,
      Math.min(floating ? 260 : (saved?.normalBounds.width ?? 1180), area.width)
    ),
    height = Math.max(
      minHeight,
      Math.min(floating ? 110 : (saved?.normalBounds.height ?? 800), area.height)
    ),
    x = saved?.normalBounds.x ?? Math.round(area.x + (area.width - width) / 2),
    y = saved?.normalBounds.y ?? Math.round(area.y + (area.height - height) / 2)
  return {
    bounds: {
      x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
      width,
      height
    },
    minWidth,
    minHeight,
    maximized: floating ? false : (saved?.maximized ?? false)
  }
}

export class RelayWindowStateStore {
  private readonly files: SubscriptionFiles
  private readonly directory: string
  private readonly path: string
  constructor(context: RelayStateContext, kind: WindowStateKind = 'main') {
    this.files = new SubscriptionFiles(context)
    this.directory = join(context.stateRoot, 'UI')
    this.path = join(
      this.directory,
      windowStateKind(kind) === 'floating' ? 'floating-window.json' : 'window.json'
    )
  }
  async read(): Promise<WindowStateRead> {
    const missing = (): WindowStateRead => ({ revision: '', writable: true, warnings: [] })
    try {
      if (!(await this.files.directory(this.directory))) return missing()
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await lstat(this.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing()
        throw error
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16384)
        throw new Error('窗口记录类型或大小无效。')
      const bytes = await readBinaryResource(this.path, true)
      return {
        saved: parseWindowState(JSON.parse(bytes.toString('utf8'))),
        revision: hash(bytes),
        writable: true,
        warnings: []
      }
    } catch {
      return {
        revision: '',
        writable: false,
        warnings: ['窗口位置记录未通过读取或权限检查；保留原件，本次使用安全默认且不覆盖。']
      }
    }
  }
  async save(value: RelayWindowState, revision: string): Promise<string> {
    const saved = parseWindowState(value)
    return writes.run(this.path, async () => {
      const current = await this.read()
      if (!current.writable || current.revision !== revision)
        throw new Error('窗口位置记录已改变或不可写，保留原件。')
      await this.files.directory(this.directory, true)
      const text = JSON.stringify(saved, null, 2)
      await atomicWriteFile(this.path, text, { mode: 0o600 })
      await this.files.sync(this.directory)
      const after = await this.read()
      if (!after.writable || after.revision !== hash(text)) throw new Error('窗口位置保存未确认。')
      return after.revision
    })
  }
}

export function createWindowGeometryService(adapters: {
  store: Pick<RelayWindowStateStore, 'read' | 'save'>
  displays(): WindowDisplay[]
  primaryId(): string | number | undefined
  kind?: WindowStateKind
}) {
  const kind = windowStateKind(adapters.kind ?? 'main')
  let current: RelayWindowState | undefined,
    revision = '',
    writable = false,
    invalidated = false,
    warnings: string[] = [],
    generation = 0,
    savedGeneration = 0,
    loading:
      Promise<ResolvedWindowGeometry & { writable: boolean; warnings: string[] }> | undefined,
    writing: Promise<void> | undefined
  const resolve = (): ResolvedWindowGeometry => {
    let geometry: ResolvedWindowGeometry
    try {
      geometry = clampWindowState(current, adapters.displays(), adapters.primaryId(), kind)
    } catch {
      warnings = [...new Set([...warnings, '显示器信息不可用，使用安全默认窗口区域。'])]
      geometry = clampWindowState(undefined, [], undefined, kind)
    }
    const next: RelayWindowState = {
      version: 1,
      normalBounds: geometry.bounds,
      maximized: geometry.maximized
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      current = next
      ++generation
    }
    return geometry
  }
  const state = () => ({
    pending: !!writing,
    writable,
    warnings: [...warnings],
    dirty: generation !== savedGeneration
  })
  return {
    state,
    resolve,
    // A restored backup owns the new baseline. This session never overwrites it from old memory.
    invalidate(): void {
      invalidated = true
      writable = false
      warnings = [...new Set([...warnings, '窗口位置持久化已暂停；下次启动读取恢复后的记录。'])]
    },
    restore() {
      if (invalidated)
        return Promise.resolve({ ...resolve(), writable: false, warnings: [...warnings] })
      if (!loading)
        loading = (async () => {
          try {
            const read = await adapters.store.read()
            current = read.saved
            revision = read.revision
            writable = read.writable && !invalidated
            warnings = [...new Set([...warnings, ...read.warnings])]
            const geometry = resolve()
            if (read.saved && JSON.stringify(current) === JSON.stringify(read.saved))
              savedGeneration = generation
            return { ...geometry, writable, warnings: [...warnings] }
          } catch {
            writable = false
            warnings = ['窗口位置读取失败；使用安全默认，本次不自动覆盖。']
            return { ...resolve(), writable, warnings: [...warnings] }
          }
        })()
      return loading
    },
    capture(input: {
      normalBounds: WindowBounds
      maximized: boolean
      minimized: boolean
      fullscreen: boolean
    }): void {
      if (input.minimized || input.fullscreen) return
      try {
        const next = parseWindowState({
          version: 1,
          normalBounds: input.normalBounds,
          maximized: input.maximized
        })
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          current = next
          ++generation
        }
        resolve()
      } catch {
        warnings = [...new Set([...warnings, '当前窗口几何无效，保留上次有效位置。'])]
      }
    },
    save(): Promise<void> {
      if (writing) return writing
      if (!writable || !current || generation === savedGeneration) return Promise.resolve()
      writing = (async () => {
        try {
          while (writable && current && generation !== savedGeneration) {
            const next = parseWindowState(current),
              at = generation
            revision = await adapters.store.save(next, revision)
            savedGeneration = at
          }
        } catch {
          writable = false
          warnings = [
            ...new Set([...warnings, '窗口位置保存未确认；保留现有记录，不阻止安全退出。'])
          ]
        }
      })().finally(() => {
        writing = undefined
      })
      return writing
    },
    whenIdle: (): Promise<void> => writing ?? Promise.resolve()
  }
}
