import {
  variantAcquireRequest,
  variantSelection,
  type VariantAcquireRequest,
  type VariantPreparation,
  type VariantRecord,
  type VariantState
} from '../../../shared/relay/variant'
import type { VariantStore } from './variant-store'
import manifest from './manifest.json'
import { trustedCoreVariants } from './trusted-variants'
import { trustedSmartModels } from './smart-models'

export function createVariantService(adapters: {
  store: VariantStore
  ensureIdle?(): void
  selectionChanged?(): void
  confirmAcquire?(request: VariantAcquireRequest): Promise<boolean>
  confirmSelect?(record: VariantRecord): Promise<boolean>
  confirmRemove?(record: VariantRecord): Promise<boolean>
  now?(): number
}) {
  const now = adapters.now ?? Date.now
  let pending: { request: VariantAcquireRequest; preparedAt: number } | undefined
  let busy = false
  const waiters: (() => void)[] = []
  async function mutation<T>(operation: () => Promise<T>): Promise<T> {
    if (busy) throw new Error('请等待当前变体操作结束。')
    adapters.ensureIdle?.()
    busy = true
    try {
      return await operation()
    } finally {
      busy = false
      waiters.splice(0).forEach((resolve) => resolve())
    }
  }
  return {
    isBusy: (): boolean => busy,
    cancelPreparation(): void {
      if (busy) throw new Error('请等待当前变体操作结束。')
      pending = undefined
    },
    whenIdle: (): Promise<void> =>
      busy ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    async state(): Promise<VariantState> {
      return {
        ...(await adapters.store.list()),
        pending: busy,
        trustedCoreVersion: manifest.version,
        smartRuntimeSupported: true,
        networkDownloadSupported: false,
        hostArchitecture: process.arch === 'arm64' || process.arch === 'x64' ? process.arch : null,
        trustedSmartImports: trustedSmartModels().map((pin) => ({ kind: 'smart', ...pin })),
        trustedCoreImports: trustedCoreVariants().map((pin) => ({
          kind: 'core',
          version: pin.version,
          architecture: pin.architecture,
          sha256: pin.sha256,
          size: pin.size
        }))
      }
    },
    prepareAcquire(raw: unknown): Promise<VariantPreparation> {
      return mutation(async () => {
        pending = undefined
        const request = variantAcquireRequest(raw)
        pending = { request, preparedAt: now() }
        const { sourcePath: _sourcePath, ...metadata } = request
        return { ...metadata, expiresAt: pending.preparedAt + 60000 }
      })
    },
    executeAcquire(): Promise<VariantRecord | { status: 'cancelled' }> {
      return mutation(async () => {
        const prepared = pending
        pending = undefined
        const valid = (): boolean =>
          !!prepared && now() >= prepared.preparedAt && now() - prepared.preparedAt <= 60000
        if (!prepared || !valid()) throw new Error('请重新准备变体获取。')
        const request = prepared.request
        if (adapters.confirmAcquire && !(await adapters.confirmAcquire(structuredClone(request))))
          return { status: 'cancelled' as const }
        adapters.ensureIdle?.()
        if (!valid()) throw new Error('确认期间准备凭据已过期，请重新选择文件。')
        return adapters.store.acquire(structuredClone(request))
      })
    },
    select(raw: unknown): Promise<VariantRecord | { status: 'cancelled' }> {
      return mutation(async () => {
        pending = undefined
        const selection = variantSelection(raw)
        const record = await adapters.store.verify(selection.id)
        if (adapters.confirmSelect && !(await adapters.confirmSelect(structuredClone(record))))
          return { status: 'cancelled' as const }
        adapters.ensureIdle?.()
        const result = await adapters.store.select(selection)
        adapters.selectionChanged?.()
        return result
      })
    },
    restore(kind: 'core' | 'smart'): Promise<void> {
      return mutation(async () => {
        pending = undefined
        const before = await adapters.store.list()
        await adapters.store.restore(kind)
        if (kind === 'core' ? before.activeCoreId : before.activeSmartId)
          adapters.selectionChanged?.()
      })
    },
    remove(raw: unknown): Promise<{ status: 'removed' | 'cancelled' }> {
      return mutation(async () => {
        pending = undefined
        const selection = variantSelection(raw)
        const snapshot = await adapters.store.list()
        const record = snapshot.records.find((r) => r.id === selection.id)
        if (!record) throw new Error('选择的变体不存在。')
        if (adapters.confirmRemove && !(await adapters.confirmRemove(structuredClone(record))))
          return { status: 'cancelled' as const }
        adapters.ensureIdle?.()
        await adapters.store.remove(selection)
        if (snapshot.activeCoreId === selection.id || snapshot.activeSmartId === selection.id)
          adapters.selectionChanged?.()
        return { status: 'removed' as const }
      })
    }
  }
}
