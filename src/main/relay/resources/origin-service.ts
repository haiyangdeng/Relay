import { randomUUID } from 'crypto'
import {
  geoOriginSelection,
  type GeoOriginFetchPlan,
  type GeoOriginInfo,
  type GeoOriginOperationResult,
  type GeoOriginSavePlan,
  type GeoOriginServiceState
} from '../../../shared/relay/geo-origins'
import type { ResourceCheckResult, ResourceInfo } from '../../../shared/relay/resources'
import { geoOriginSaveRequest } from './origin-definition'
import type { ResourceOriginStore } from './origin-store'
import type { ResourceStore } from './store'
import { matchesGeoOriginHeadReceipt } from './origin-candidate'
import { createResourceService } from './service'
import type { ResourceValidationJob } from './check-definition'
import { resourceHash } from './source'
import { assertGeoAutomaticPermit, type GeoAutomaticPermit } from './automatic-permit'

type Inner = ReturnType<typeof createResourceService>
interface Operation {
  id: string
  epoch: number
  originId?: string
  originRevision?: string
  automaticPermit?: GeoAutomaticPermit
  phase: GeoOriginServiceState['phase']
  abort: AbortController
  invalid: boolean
  writeAttempted: boolean
  definitionWriteAttempted: boolean
  definitionChanged: boolean
  inner?: Inner
}
function publicInfo(info: GeoOriginInfo): GeoOriginInfo {
  return {
    id: info.id,
    revision: info.revision,
    originRevision: info.originRevision,
    descriptor: structuredClone(info.descriptor),
    origin: info.origin,
    proxyPort: info.proxyPort,
    hasPrivateHeaders: info.hasPrivateHeaders,
    expectedSHA256: info.expectedSHA256,
    autoIntent: structuredClone(info.autoIntent),
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
    ...(info.head ? { head: structuredClone(info.head) } : {})
  }
}
function publicResource(info: ResourceInfo): ResourceInfo {
  return {
    id: info.id,
    sha256: info.sha256,
    size: info.size,
    createdAt: info.createdAt,
    name: info.name,
    kind: info.kind,
    behavior: info.behavior,
    selector: info.selector,
    integrity: 'notChecked'
  }
}
function publicCheck(check: ResourceCheckResult): ResourceCheckResult {
  return {
    status: check.status,
    resourceSHA256: check.resourceSHA256,
    ...(check.coreVersion ? { coreVersion: check.coreVersion } : {}),
    ...(check.ruleCount !== undefined ? { ruleCount: check.ruleCount } : {}),
    warnings: [
      check.status === 'passed'
        ? '固定核心格式检查已通过；这不是活动实例的数据库版本回执。'
        : '固定核心检查或其清理未完整通过；未推进来源缓存head。'
    ]
  }
}

export function createResourceOriginService(adapters: {
  origins: Pick<ResourceOriginStore, 'list' | 'read' | 'readId' | 'save' | 'commitHead'>
  cache: Pick<ResourceStore, 'save' | 'read' | 'list'>
  download(
    url: string,
    port: number,
    signal: AbortSignal,
    headers: Record<string, string>
  ): Promise<Buffer>
  check(
    job: ResourceValidationJob,
    signal: AbortSignal | undefined,
    live: () => void
  ): Promise<ResourceCheckResult>
  confirmSave(plan: GeoOriginSavePlan): Promise<boolean>
  confirmFetch(plan: GeoOriginFetchPlan): Promise<boolean>
  onChanged?(id?: string): void | Promise<void>
  notify?(): void
  now?(): number
}) {
  const now = adapters.now ?? Date.now,
    waiters: Array<() => void> = []
  let operation: Operation | undefined,
    cancelAnchor: Operation | undefined,
    epoch = 0,
    closing: Promise<void> | undefined
  const state = (): GeoOriginServiceState => ({
    pending: !!operation || !!closing,
    phase: operation?.phase ?? 'idle',
    ...(operation?.automaticPermit
      ? { automatic: true as const }
      : operation
        ? { operationId: operation.id }
        : {}),
    ...(operation?.originId ? { originId: operation.originId } : {})
  })
  const notify = (): void => {
    try {
      adapters.notify?.()
    } catch {
      /* State observers cannot change an admitted transaction outcome. */
    }
  }
  const whenIdle = (): Promise<void> =>
    operation ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const guard = (op: Operation, assertUI: () => void): void => {
    try {
      if (cancelAnchor !== op || epoch !== op.epoch || op.abort.signal.aborted) throw new Error()
      assertUI()
      if (op.automaticPermit && op.originId && op.originRevision)
        assertGeoAutomaticPermit(op.automaticPermit, {
          id: op.originId,
          originRevision: op.originRevision
        })
      // The context callback can synchronously cancel this operation.
      if (cancelAnchor !== op || epoch !== op.epoch || op.abort.signal.aborted) throw new Error()
    } catch {
      op.invalid = true
      op.abort.abort()
      op.inner?.clear()
      throw new Error('地理来源操作范围已失效。')
    }
  }
  const phase = (op: Operation, value: Operation['phase']): void => {
    op.phase = value
    notify()
  }
  const failure = (op: Operation): GeoOriginOperationResult => ({
    status: op.writeAttempted
      ? 'uncertain'
      : op.invalid || op.abort.signal.aborted
        ? 'cancelled'
        : 'failed',
    warnings: [
      op.writeAttempted
        ? '私有来源、缓存或head写入结果未完整确认；保留已存在资料，不自动重试或回滚，请重新读取。'
        : '地理来源操作未完成；未推进缓存head、启用权限或修改活动实例。'
    ]
  })
  const run = async <T>(
    assertUI: () => void,
    work: (op: Operation, live: () => void) => Promise<T>,
    rejected: (op: Operation) => T,
    originId?: string,
    automaticPermit?: GeoAutomaticPermit
  ): Promise<T> => {
    if (typeof assertUI !== 'function') throw new Error('地理来源操作需要私有窗口范围。')
    try {
      assertUI()
    } catch {
      throw new Error('地理来源私有窗口范围未确认。')
    }
    if (operation || cancelAnchor || closing) throw new Error('请等待本次地理来源操作真实结束。')
    const op: Operation = {
      id: randomUUID(),
      epoch: ++epoch,
      phase: 'reading',
      originId,
      automaticPermit,
      abort: new AbortController(),
      invalid: false,
      writeAttempted: false,
      definitionWriteAttempted: false,
      definitionChanged: false
    }
    operation = cancelAnchor = op
    const live = (): void => guard(op, assertUI)
    let result: T | undefined,
      succeeded = false
    notify()
    try {
      live()
      result = await work(op, live)
      succeeded = true
    } catch {
      /* Only safe, typed failure results leave this service. */
    }
    try {
      if (op.definitionChanged || op.definitionWriteAttempted) {
        // Revocation is real work even when publication returned unknown. A
        // failed create may have published an ID that this caller never saw.
        await adapters.onChanged?.(op.originId)
      }
    } catch {
      succeeded = false
    }
    try {
      // Every operation owns a new inner service. Clear its private60s proof,
      // and await actual underlying settlement rather than racing cancellation.
      op.inner?.clear()
      await op.inner?.requestClose()
      await op.inner?.whenIdle()
    } catch {
      succeeded = false
    }
    if (operation === op) operation = undefined
    waiters.splice(0).forEach((resolve) => resolve())
    notify()
    try {
      // Drain and end observers can invalidate even a completed operation.
      // No observer or awaited work belongs after this publication guard.
      live()
      return succeeded ? (result as T) : rejected(op)
    } catch {
      return rejected(op)
    } finally {
      if (cancelAnchor === op) cancelAnchor = undefined
    }
  }
  const cancel = (id?: string): boolean => {
    const op = operation ?? cancelAnchor
    if (id !== undefined && (!op || op.id !== id)) return false
    ++epoch
    if (!op) return false
    op.invalid = true
    op.abort.abort()
    op.inner?.clear()
    return true
  }
  const readFailure = (): never => {
    throw new Error('地理来源读取未完整确认；未返回旧窗口资料，请显式重新读取。')
  }
  return {
    state,
    isBusy: (): boolean => !!operation || !!cancelAnchor || !!closing,
    whenIdle,
    cancel,
    cancelInteractive: (): boolean => {
      const current = operation ?? cancelAnchor
      return current && !current.automaticPermit ? cancel(current.id) : false
    },
    list: (assertUI: () => void) =>
      run(
        assertUI,
        async (_op, live) => {
          live()
          const result = await adapters.origins.list()
          live()
          return {
            origins: result.origins.map(publicInfo),
            incomplete: result.incomplete,
            warnings: result.warnings.slice()
          }
        },
        readFailure
      ),
    read(raw: unknown, assertUI: () => void) {
      const selected = geoOriginSelection(raw)
      return run(
        assertUI,
        async (_op, live) => {
          live()
          const result = await adapters.origins.read(selected)
          live()
          return { info: publicInfo(result.info), definition: structuredClone(result.definition) }
        },
        readFailure,
        selected.id
      )
    },
    save(raw: unknown, assertUI: () => void): Promise<GeoOriginOperationResult> {
      const request = geoOriginSaveRequest(raw)
      return run<GeoOriginOperationResult>(
        assertUI,
        async (op, live) => {
          live()
          const previous = request.origin ? await adapters.origins.read(request.origin) : undefined
          live()
          if (!previous) {
            const inventory = await adapters.origins.list()
            live()
            if (
              inventory.incomplete ||
              inventory.origins.some(
                (v) => v.descriptor.kind === request.definition.descriptor.kind
              )
            )
              throw new Error('来源记录需重新核对。')
          }
          const plan: GeoOriginSavePlan = {
            evidenceId: randomUUID(),
            ...(request.origin ? { previous: request.origin } : {}),
            descriptor: structuredClone(request.definition.descriptor),
            origin: new URL(request.definition.source.url).origin,
            proxyPort: request.definition.source.proxyPort,
            privateHeaders: Object.keys(request.definition.source.headers).length > 0,
            expectedSHA256: request.definition.expectedSHA256,
            autoIntent: structuredClone(request.definition.autoIntent)
          }
          phase(op, 'confirmingDefinition')
          live()
          const at = now(),
            accepted = await adapters.confirmSave(structuredClone(plan))
          live()
          if (!accepted)
            return {
              status: 'cancelled',
              warnings: ['已取消保存来源定义；未获取资源、保存权限或修改运行设置。']
            }
          const confirmedAt = now()
          if (!(confirmedAt >= at && confirmedAt - at <= 60000))
            throw new Error('本次保存确认已过期。')
          if (request.origin) {
            await adapters.origins.read(request.origin)
            live()
          }
          phase(op, 'savingDefinition')
          live()
          op.writeAttempted = op.definitionWriteAttempted = true
          const saved = await adapters.origins.save(request)
          op.originId = saved.info.id
          op.definitionChanged =
            !previous || previous.info.originRevision !== saved.info.originRevision
          op.definitionWriteAttempted = false
          live()
          return {
            status: 'saved',
            origin: publicInfo(saved.info),
            warnings: ['仅保存私有来源及自动更新意图；未获取资源、授予本会话权限或改变活动数据库。']
          }
        },
        failure,
        request.origin?.id
      )
    },
    fetch(
      raw: unknown,
      assertUI: () => void,
      automaticPermit?: GeoAutomaticPermit
    ): Promise<GeoOriginOperationResult> {
      const selected = geoOriginSelection(raw)
      return run<GeoOriginOperationResult>(
        assertUI,
        async (op, live) => {
          live()
          const bound = await adapters.origins.read(selected)
          op.originRevision = bound.info.originRevision
          live()
          if (automaticPermit && !bound.definition.autoIntent.requested)
            throw new Error('此来源尚未保存自动更新意图。')
          const recheck = async (): Promise<void> => {
            live()
            const current = await adapters.origins.read(selected)
            live()
            if (current.info.originRevision !== bound.info.originRevision)
              throw new Error('来源定义已变化。')
          }
          let resourceRevision: { id: string; sha256: string; revision: string } | undefined,
            reusedSnapshot = false
          const inner = createResourceService({
            cache: {
              list: async () => {
                await recheck()
                const result = await adapters.cache.list()
                live()
                return result
              },
              save: async (descriptor, bytes) => {
                const responseSHA256 = resourceHash(bytes)
                await recheck()
                const head = bound.info.head
                if (head?.resource.sha256 === responseSHA256) {
                  const previous = await adapters.cache.read(head.resource)
                  live()
                  await recheck()
                  if (
                    !matchesGeoOriginHeadReceipt(head, previous) ||
                    previous.info.id !== head.resource.id ||
                    previous.info.sha256 !== responseSHA256 ||
                    previous.info.kind !== descriptor.kind
                  )
                    throw new Error('旧缓存回执或类型未确认，未自动修复。')
                  const previousDescriptor = {
                    name: previous.info.name,
                    kind: previous.info.kind,
                    behavior: previous.info.behavior,
                    selector: previous.info.selector
                  }
                  if (JSON.stringify(previousDescriptor) === JSON.stringify(descriptor)) {
                    if (resourceHash(bytes) !== responseSHA256) throw new Error('资源正文已变化。')
                    reusedSnapshot = true
                    // The reused factory compares its exact save/read Info
                    // representation. Sanitize only the outward result.
                    return structuredClone(previous.info)
                  }
                  // A legitimate source edit may change name/selector. It
                  // needs its own metadata snapshot, never the old descriptor.
                  if (head.originRevision === bound.info.originRevision)
                    throw new Error('同一来源的旧缓存描述不一致。')
                }
                live()
                if (resourceHash(bytes) !== responseSHA256) throw new Error('资源正文已变化。')
                op.writeAttempted = true
                const result = await adapters.cache.save(descriptor, bytes)
                live()
                return result
              },
              read: async (resource, maxBytes) => {
                await recheck()
                const result = await adapters.cache.read(resource, maxBytes)
                live()
                resourceRevision = {
                  id: result.info.id,
                  sha256: result.info.sha256,
                  revision: result.revision
                }
                return result
              }
            },
            pick: async () => {
              throw new Error('已保存地理来源不能选择任意文件。')
            },
            download: async (url, port, signal, headers) => {
              await recheck()
              phase(op, 'acquiring')
              live()
              const result = await adapters.download(
                url,
                port,
                AbortSignal.any([signal, op.abort.signal]),
                headers
              )
              live()
              await recheck()
              return result
            },
            confirm: async (preparation) => {
              await recheck()
              phase(op, 'confirmingDownload')
              live()
              const accepted = automaticPermit
                ? true
                : await adapters.confirmFetch({
                    origin: publicInfo(bound.info),
                    preparation: structuredClone(preparation)
                  })
              live()
              await recheck()
              return accepted
            },
            check: async (job) => {
              await recheck()
              phase(op, 'checking')
              live()
              const result = await adapters.check(job, op.abort.signal, live)
              live()
              await recheck()
              return result
            },
            now
          })
          op.inner = inner
          const prepared = inner.prepare({
            descriptor: bound.definition.descriptor,
            source: bound.definition.source,
            expectedSHA256: bound.definition.expectedSHA256
          })
          live()
          const acquired = await inner.acquire({ evidenceId: prepared.evidenceId })
          live()
          if (acquired.status !== 'cached' || !acquired.resource)
            return {
              status:
                acquired.status === 'cancelled'
                  ? 'cancelled'
                  : acquired.status === 'uncertain'
                    ? 'uncertain'
                    : 'failed',
              warnings: ['获取或缓存未确认；既有head保留，未转用直连或自动重试。']
            }
          const resource = publicResource(acquired.resource),
            selection = { id: resource.id, sha256: resource.sha256 }
          const checked = await inner.check(selection)
          live()
          if (checked.status !== 'checked' || checked.check?.status !== 'passed')
            return {
              status: checked.status === 'uncertain' ? 'uncertain' : 'failed',
              resource,
              ...(checked.check ? { check: publicCheck(checked.check) } : {}),
              warnings: [
                '新私有缓存可能已保留，但固定核心检查未通过；既有head不变，未修改活动数据库。'
              ]
            }
          await recheck()
          live()
          if (
            !resourceRevision ||
            resourceRevision.id !== selection.id ||
            resourceRevision.sha256 !== selection.sha256
          )
            throw new Error('缓存检查修订未确认。')
          phase(op, 'publishing')
          live()
          op.writeAttempted = true
          const saved = await adapters.origins.commitHead({
            origin: selected,
            originRevision: bound.info.originRevision,
            resource: selection,
            resourceRevision: resourceRevision.revision
          })
          live()
          return {
            status: 'updated',
            origin: publicInfo(saved.info),
            resource,
            check: publicCheck(checked.check),
            warnings: [
              reusedSnapshot
                ? '相同完整正文已复用实际复核有效的旧快照，并执行本次固定核心检查及head更新；未新建资源正文，未执行活动实例更新。'
                : '已获取、私有缓存并通过固定核心检查，来源head已更新；旧快照仍保留；未执行活动实例更新，当前使用版本需独立核对。'
            ]
          }
        },
        failure,
        selected.id,
        automaticPermit
      )
    },
    requestClose(): Promise<void> {
      if (closing) return closing
      cancel()
      closing = whenIdle().finally(() => {
        closing = undefined
        notify()
      })
      notify()
      return closing
    }
  }
}
export type ResourceOriginService = ReturnType<typeof createResourceOriginService>
