import { randomUUID } from 'crypto'
import {
  overrideLibraryBindRequest,
  overrideLibraryBindingsRequest,
  overrideLibraryRefreshRequest,
  overrideLibraryOrderRequest,
  overrideLibraryFetchRequest,
  overrideLibraryFetchEvidence,
  overrideLibraryRemoveRequest,
  overrideLibraryIdFromRuntimeId,
  overrideLibraryRuntimeId,
  OVERRIDE_LIBRARY_JS_BYTES,
  OVERRIDE_LIBRARY_YAML_BYTES,
  type OverrideLibraryBindings,
  type OverrideLibraryTarget,
  type OverrideLibraryFetchPlan,
  type OverrideLibraryFetchResult,
  type OverrideLibraryItem,
  type OverrideLibrarySummary
} from '../../../shared/relay/override-library'
import {
  profileOverridesFor,
  type ConfigurationEditDocument
} from '../../../shared/relay/configuration-edit'
import { requestOnce, type PluginRequestOptions } from '../../resolve/plugin/http-client'
import { SUBSCRIPTION_TIMEOUT } from '../subscriptions/transfer'
import { profileHash } from '../profiles/source'
import type { ProfileStore } from '../profiles/store'
import type { RuntimeOverride } from './merge'
import type { createConfigurationEditService } from './edit-service'
import {
  overrideLibrarySourceFingerprint,
  type OverrideLibraryStore
} from './override-library-store'

const lifespan = 60000
class FetchRevoked extends Error {}
function libraryRefs(items: RuntimeOverride[]): RuntimeOverride[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const id = overrideLibraryIdFromRuntimeId(item.id)
    if (!id) return false
    if (seen.has(id) || (item.role !== undefined && item.role !== 'normal'))
      throw new Error('覆写库引用重复或角色无效。')
    seen.add(id)
    return true
  })
}
const scope = (
  document: ConfigurationEditDocument,
  target?: OverrideLibraryTarget
): RuntimeOverride[] =>
  libraryRefs(target ? profileOverridesFor(document, target.id) : document.globalOverrides)
const allRefs = (document: ConfigurationEditDocument): RuntimeOverride[] =>
  [
    ...document.globalOverrides,
    ...document.profileOverrides,
    ...(document.profileOverrideSets ?? []).flatMap((set) => set.overrides)
  ].filter((item) => overrideLibraryIdFromRuntimeId(item.id) !== undefined)
const summary = (item: OverrideLibraryItem): OverrideLibrarySummary => {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    type: item.type,
    metadataRevision: item.metadataRevision,
    bodyRevision: item.bodyRevision,
    bodyBytes: item.bodyBytes,
    bodyState: item.bodyState,
    createdAt: item.createdAt,
    metadataUpdatedAt: item.metadataUpdatedAt,
    ...(item.bodyUpdatedAt !== undefined ? { bodyUpdatedAt: item.bodyUpdatedAt } : {}),
    ...(item.lastFetchedAt !== undefined ? { lastFetchedAt: item.lastFetchedAt } : {})
  }
}

export function createOverrideLibraryService(adapters: {
  store: Pick<
    OverrideLibraryStore,
    | 'list'
    | 'read'
    | 'create'
    | 'saveMetadata'
    | 'saveBody'
    | 'remove'
    | 'saveFetched'
    | 'assertBindings'
  >
  editor: Pick<ReturnType<typeof createConfigurationEditService>, 'read' | 'applyLibraryBindings'>
  profiles: Pick<ProfileStore, 'read'>
  assertIdle(): void
  confirmFetch(plan: OverrideLibraryFetchPlan): Promise<boolean>
  request?: typeof requestOnce
  now?(): number
}) {
  const now = adapters.now ?? Date.now,
    request = adapters.request ?? requestOnce,
    waiters: Array<() => void> = []
  type Proof = {
    plan: OverrideLibraryFetchPlan
    item: OverrideLibraryItem
    epoch: number
    at: number
    assertLive?: () => void
  }
  let pending = false,
    epoch = 0,
    proof: Proof | undefined,
    active: { id: string; controller: AbortController } | undefined
  const begin = (): void => {
    if (pending) throw new Error('请等待本次覆写库操作结束。')
    adapters.assertIdle()
    pending = true
  }
  const end = (): void => {
    pending = false
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const operation = async <T>(run: () => Promise<T>): Promise<T> => {
    begin()
    try {
      return await run()
    } finally {
      end()
    }
  }
  const invalidate = (): void => {
    ++epoch
    proof = undefined
    active?.controller.abort()
  }
  const live = (held: Proof, signal?: AbortSignal): void => {
    const fresh = (): boolean => {
      const at = now()
      return (
        !signal?.aborted &&
        held.epoch === epoch &&
        Number.isSafeInteger(at) &&
        at >= held.at &&
        at < held.plan.expiresAt
      )
    }
    if (!fresh()) throw new FetchRevoked()
    try {
      adapters.assertIdle()
      held.assertLive?.()
    } catch {
      throw new FetchRevoked()
    }
    if (!fresh()) throw new FetchRevoked()
  }
  const assertTarget = async (target?: OverrideLibraryTarget): Promise<void> => {
    if (!target) return
    const read = await adapters.profiles.read({ id: target.id, sha256: target.sha256 })
    if (read.revision !== target.revision) throw new Error('所选配置版本已变化，请重新读取。')
  }
  const currentEdit = async (expected?: string) => {
    const record = await adapters.editor.read()
    if (expected !== undefined && record.revision !== expected)
      throw new Error('编辑版本已变化，请重新读取。')
    return record
  }
  const snapshot = async (target?: OverrideLibraryTarget): Promise<OverrideLibraryBindings> => {
    await assertTarget(target)
    const edit = await currentEdit(),
      inventory = await adapters.store.list()
    await adapters.store.assertBindings(allRefs(edit.document))
    await assertTarget(target)
    const known = new Set(inventory.items.map((item) => item.id)),
      order = (edit.document.overrideLibraryOrder ?? []).filter((id) => known.has(id))
    for (const item of inventory.items) if (!order.includes(item.id)) order.push(item.id)
    const publicRefs = (refs: RuntimeOverride[]) =>
      refs.map((item) => {
        const id = overrideLibraryIdFromRuntimeId(item.id)
        if (!id) throw new Error('覆写库引用身份无效。')
        return { id, bodyRevision: profileHash(item.content) }
      })
    return {
      editRevision: edit.revision,
      order,
      globalRefs: publicRefs(scope(edit.document)),
      profileRefs: target ? publicRefs(scope(edit.document, target)) : [],
      ...(target ? { target: structuredClone(target) } : {})
    }
  }
  const inline = async (id: string, bodyRevision: string): Promise<RuntimeOverride> => {
    const record = await adapters.store.read({ id })
    if (record.item.content === undefined || record.item.bodyRevision !== bodyRevision)
      throw new Error('覆写库正文修订已变化或尚未获取，请重新读取。')
    return {
      id: overrideLibraryRuntimeId(id),
      kind: record.item.kind,
      content: record.item.content
    }
  }
  const recheckFetch = async (held: Proof, signal?: AbortSignal): Promise<void> => {
    live(held, signal)
    const current = await adapters.store.read({
      id: held.plan.id,
      expectedLibraryRevision: held.plan.libraryRevision
    })
    live(held, signal)
    if (
      current.item.metadataRevision !== held.plan.metadataRevision ||
      current.item.bodyRevision !== held.plan.bodyRevision ||
      !current.item.remote ||
      overrideLibrarySourceFingerprint(current.item.remote) !== held.plan.sourceFingerprint
    )
      throw new Error('远端覆写定义或正文已变化，请重新准备。')
  }
  return {
    isBusy: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    invalidate,
    list: () =>
      operation(async () => {
        const inventory = await adapters.store.list(),
          edit = await currentEdit(),
          ranks = new Map(
            (edit.document.overrideLibraryOrder ?? []).map((id, index) => [id, index])
          )
        return {
          ...inventory,
          items: [...inventory.items].sort(
            (a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity)
          )
        }
      }),
    read: (raw: unknown) => operation(() => adapters.store.read(raw)),
    create: (raw: unknown) =>
      operation(async () => {
        invalidate()
        return adapters.store.create(raw)
      }),
    saveMetadata: (raw: unknown) =>
      operation(async () => {
        invalidate()
        return adapters.store.saveMetadata(raw)
      }),
    saveBody: (raw: unknown) =>
      operation(async () => {
        invalidate()
        return adapters.store.saveBody(raw)
      }),
    remove: (raw: unknown) =>
      operation(async () => {
        const input = overrideLibraryRemoveRequest(raw),
          edit = await currentEdit()
        if (allRefs(edit.document).some((item) => item.id === overrideLibraryRuntimeId(input.id)))
          throw new Error('覆写项仍被全局或已保存配置引用，请先显式解除引用。')
        invalidate()
        return adapters.store.remove(input)
      }),
    bindings: (raw: unknown) =>
      operation(async () => {
        const input = overrideLibraryBindingsRequest(raw)
        if (!input.target) return snapshot()
        const read = await adapters.profiles.read(input.target)
        return snapshot({ ...input.target, revision: read.revision })
      }),
    bind: (raw: unknown) =>
      operation(async () => {
        const input = overrideLibraryBindRequest(raw),
          edit = await currentEdit(input.expectedEditRevision),
          old = new Map(
            scope(edit.document, input.target).map((item) => [
              overrideLibraryIdFromRuntimeId(item.id),
              item
            ])
          ),
          overrides: RuntimeOverride[] = []
        await assertTarget(input.target)
        for (const ref of input.refs) {
          const existing = old.get(ref.id)
          if (existing) {
            if (profileHash(existing.content) !== ref.bodyRevision)
              throw new Error('已有引用须保留旧修订；更新正文请使用明确更新引用操作。')
            overrides.push(structuredClone(existing))
          } else overrides.push(await inline(ref.id, ref.bodyRevision))
        }
        await adapters.editor.applyLibraryBindings({
          expectedRevision: input.expectedEditRevision,
          target: input.target,
          overrides
        })
        return snapshot(input.target)
      }),
    refresh: (raw: unknown) =>
      operation(async () => {
        const input = overrideLibraryRefreshRequest(raw),
          edit = await currentEdit(input.expectedEditRevision),
          overrides = scope(edit.document, input.target)
        await assertTarget(input.target)
        for (const ref of input.refs) {
          const index = overrides.findIndex((item) => item.id === overrideLibraryRuntimeId(ref.id))
          if (index < 0 || profileHash(overrides[index].content) !== ref.expectedOldBodyRevision)
            throw new Error('原引用修订已变化；未更新其它引用。')
          overrides[index] = await inline(ref.id, ref.bodyRevision)
        }
        await adapters.editor.applyLibraryBindings({
          expectedRevision: input.expectedEditRevision,
          target: input.target,
          overrides
        })
        return snapshot(input.target)
      }),
    order: (raw: unknown) =>
      operation(async () => {
        const input = overrideLibraryOrderRequest(raw),
          edit = await currentEdit(input.expectedEditRevision),
          inventory = await adapters.store.list(),
          known = new Set(inventory.items.map((item) => item.id))
        if (input.ids.length !== known.size || input.ids.some((id) => !known.has(id)))
          throw new Error('覆写库项目已变化，请重新读取后排序。')
        await adapters.editor.applyLibraryBindings({
          expectedRevision: input.expectedEditRevision,
          overrides: scope(edit.document),
          order: input.ids
        })
        return snapshot()
      }),
    fetchCancel(raw: unknown): boolean {
      const { evidenceId } = overrideLibraryFetchEvidence(raw)
      if (proof?.plan.evidenceId !== evidenceId && active?.id !== evidenceId) return false
      invalidate()
      return true
    },
    fetchPrepare: (raw: unknown, assertLive?: () => void) =>
      operation(async (): Promise<OverrideLibraryFetchPlan> => {
        const input = overrideLibraryFetchRequest(raw)
        invalidate()
        const started = now(),
          preparing = epoch
        assertLive?.()
        if (
          !Number.isSafeInteger(started) ||
          started < 0 ||
          !Number.isSafeInteger(started + lifespan)
        )
          throw new Error('获取准备时间无效。')
        const record = await adapters.store.read({
            id: input.id,
            expectedLibraryRevision: input.expectedLibraryRevision
          }),
          item = record.item
        if (
          !item.remote ||
          item.type !== 'remote' ||
          item.metadataRevision !== input.expectedMetadataRevision ||
          item.bodyRevision !== input.expectedBodyRevision
        )
          throw new Error('远端覆写修订已变化，请重新读取。')
        const url = new URL(item.remote.url)
        const held: Proof = {
          item: structuredClone(item),
          epoch: preparing,
          at: started,
          assertLive,
          plan: {
            evidenceId: randomUUID(),
            action: 'fetchOverride',
            id: item.id,
            name: item.name,
            kind: item.kind,
            endpoint: url.origin,
            proxyPort: item.remote.proxyPort,
            sourceFingerprint: overrideLibrarySourceFingerprint(item.remote),
            libraryRevision: record.revision,
            metadataRevision: item.metadataRevision,
            bodyRevision: item.bodyRevision,
            maxBytes: item.kind === 'js' ? OVERRIDE_LIBRARY_JS_BYTES : OVERRIDE_LIBRARY_YAML_BYTES,
            expiresAt: started + lifespan
          }
        }
        live(held)
        proof = held
        return structuredClone(held.plan)
      }),
    async fetchExecute(raw: unknown): Promise<OverrideLibraryFetchResult> {
      const { evidenceId } = overrideLibraryFetchEvidence(raw),
        held = proof
      if (!held || held.plan.evidenceId !== evidenceId)
        throw new Error('获取准备已失效，请重新准备。')
      begin()
      proof = undefined
      const controller = new AbortController(),
        signal = controller.signal
      active = { id: evidenceId, controller }
      let publishing = false
      try {
        await recheckFetch(held, signal)
        live(held, signal)
        const accepted = await adapters.confirmFetch(structuredClone(held.plan))
        live(held, signal)
        if (accepted !== true) return { status: 'cancelled' }
        await recheckFetch(held, signal)
        const remote = held.item.remote
        if (!remote) throw new Error('远端定义缺失。')
        const options: PluginRequestOptions = {
          method: 'GET',
          headers: { 'User-Agent': 'clash.meta/Relay', 'Accept-Encoding': 'identity' },
          timeout: Math.max(1, Math.min(SUBSCRIPTION_TIMEOUT, held.plan.expiresAt - now())),
          maxBytes: held.plan.maxBytes,
          proxy: { host: '127.0.0.1', port: remote.proxyPort },
          signal,
          binary: true,
          captureRedirects: true
        }
        if (
          new URL(remote.url).protocol === 'https:' &&
          process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
        )
          throw new Error('TLS校验已关闭。')
        live(held, signal)
        const response = await request(remote.url, options)
        live(held, signal)
        if (
          response.status !== 200 ||
          !Buffer.isBuffer(response.bytes) ||
          response.bytes.length > held.plan.maxBytes ||
          (response.headers['content-encoding'] !== undefined &&
            response.headers['content-encoding'] !== 'identity')
        )
          throw new Error('获取响应状态、大小或编码未确认。')
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          response.bytes
        )
        if (content.includes('\0')) throw new Error('获取正文编码无效。')
        await recheckFetch(held, signal)
        live(held, signal)
        // Once admitted, the single-file CAS owns its actual commit/uncertain
        // outcome. Closing the renderer must not falsely report no local write.
        publishing = true
        const saved = await adapters.store.saveFetched({
          id: held.plan.id,
          expectedLibraryRevision: held.plan.libraryRevision,
          expectedMetadataRevision: held.plan.metadataRevision,
          expectedBodyRevision: held.plan.bodyRevision,
          expectedSourceFingerprint: held.plan.sourceFingerprint,
          content,
          fetchedAt: now()
        })
        return { status: 'updated', revision: saved.revision, item: summary(saved.item) }
      } catch (error) {
        if (
          !publishing &&
          (error instanceof FetchRevoked || signal.aborted || held.epoch !== epoch)
        )
          return { status: 'cancelled' }
        throw new Error('覆写获取或缓存保存未确认；请重新读取核对，不自动重试或回退直连。')
      } finally {
        active = undefined
        end()
      }
    }
  }
}
