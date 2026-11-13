import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import {
  scopedStorageID,
  scopedStorageReport,
  scopedStorageRevision,
  type ScopedStorageReport
} from '../../../shared/relay/guard-scoped-storage'

interface StorageAddon {
  scopedStorage(json: string): Promise<string>
  invalidateScopedStorageIntents(): void
}
// Main-only loader uses the existing signed fixed resource inspector. No
// renderer path or ready Boolean can load/authorize native storage management.
export function createScopedStorageBridge(adapters: {
  inspect(): Promise<{ path: string; trusted: true; resourceSHA256: string }>
  require?(path: string): unknown
}) {
  let addon: StorageAddon | undefined,
    identity: string | undefined,
    inFlight = false,
    nativePending = false
  const load = async (): Promise<StorageAddon> => {
    const resource = await adapters.inspect()
    if (
      resource.trusted !== true ||
      !resource.path.startsWith('/') ||
      !resource.path.endsWith('/RelayGuard.node') ||
      resource.path.includes('\0') ||
      !/^[a-f0-9]{64}$/u.test(resource.resourceSHA256)
    )
      throw new Error('私有磁盘签名宿主未就绪。')
    const next = resource.path + ':' + resource.resourceSHA256
    if (identity && next !== identity) throw new Error('已加载私有磁盘宿主变化；保留现场。')
    if (!addon) {
      const raw = (adapters.require ?? createRequire(import.meta.url))(resource.path)
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof (raw as Partial<StorageAddon>).scopedStorage !== 'function' ||
        typeof (raw as Partial<StorageAddon>).invalidateScopedStorageIntents !== 'function'
      )
        throw new Error('当前宿主不支持私有磁盘收尾。')
      addon = raw as StorageAddon
      identity = next
    }
    return addon
  }
  const request = async (
    action: 'list' | 'create' | 'close',
    input: { workspaceID: string; revision?: string } | undefined,
    assertCurrent: () => void
  ): Promise<ScopedStorageReport> => {
    if (inFlight) throw new Error('私有磁盘操作尚未完成。')
    inFlight = true
    try {
      const current = await load(),
        id = randomUUID()
      assertCurrent()
      // A lost/malformed reply cannot prove that a submitted disk command has
      // drained. Only a later valid Native observation clears this latch.
      nativePending = true
      const text = await current.scopedStorage(JSON.stringify({ version: 1, id, action, ...input }))
      if (typeof text !== 'string' || Buffer.byteLength(text) > 32768)
        throw new Error('私有磁盘回执过大。')
      const raw: unknown = JSON.parse(text)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('私有磁盘回执无效。')
      const {
        version,
        id: receivedID,
        action: receivedAction,
        ...body
      } = raw as Record<string, unknown>
      if (version !== 1 || id !== receivedID || action !== receivedAction)
        throw new Error('私有磁盘回执不属于本次请求。')
      const report = scopedStorageReport(body)
      nativePending = report.pending
      assertCurrent()
      return report
    } finally {
      inFlight = false
    }
  }
  return {
    isBusy: () => inFlight || nativePending,
    invalidate: () => addon?.invalidateScopedStorageIntents(),
    list: (current: () => void) => request('list', undefined, current),
    create: (id: string, current: () => void) =>
      request('create', { workspaceID: scopedStorageID(id) }, current),
    close: (id: string, revision: string, current: () => void) =>
      request(
        'close',
        { workspaceID: scopedStorageID(id), revision: scopedStorageRevision(revision) },
        current
      )
  }
}
export type ScopedStorageBridge = ReturnType<typeof createScopedStorageBridge>
