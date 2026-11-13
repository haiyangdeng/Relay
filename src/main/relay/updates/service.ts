import { randomUUID } from 'crypto'
import {
  relayUpdateId,
  relayUpdateRequest,
  type RelayUpdateCandidate,
  type RelayUpdatePlan,
  type RelayUpdateState,
  type RelayUpdateAsset
} from '../../../shared/relay/updates'
import type { VariantAcquireRequest, VariantImportRequest } from '../../../shared/relay/variant'
import { downloadSubStoreAsset } from '../substore/resources'
import { readBinaryResource, resourceHash } from '../resources/source'
import { publicUpdateAsset } from './catalog'
import type { UpdateCandidateStore } from './store'
import { candidateVariantImport } from './variant-import'

export interface SubStoreCandidatePlan {
  backend: RelayUpdateAsset
  frontend: RelayUpdateAsset
}

export function createUpdateService(adapters: {
  store: UpdateCandidateStore
  assertIdle(): void
  confirmDownload(plan: RelayUpdatePlan): Promise<boolean>
  confirmRemove(candidate: RelayUpdateCandidate): Promise<boolean>
  assertImportIdle?(): void
  confirmImport?(request: VariantImportRequest): Promise<boolean>
  importCandidate?(request: VariantAcquireRequest): Promise<void>
  assertSubStoreIdle?(): void
  confirmSubStore?(plan: SubStoreCandidatePlan): Promise<boolean>
  applySubStore?(backend: Buffer, frontend: Buffer, signal: AbortSignal): Promise<void>
  download?: typeof downloadSubStoreAsset
  now?(): number
}) {
  const now = adapters.now ?? Date.now
  let pending = false
  let proof: RelayUpdatePlan | undefined
  let controller: AbortController | undefined
  const waiters: (() => void)[] = []
  const begin = (): void => {
    if (pending) throw new Error('请等待当前更新候选操作结束。')
    adapters.assertIdle()
    pending = true
  }
  const end = (): void => {
    pending = false
    controller = undefined
    waiters.splice(0).forEach((resolve) => resolve())
  }
  return {
    isBusy: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    cancel(): void {
      proof = undefined
      controller?.abort()
    },
    async state(): Promise<RelayUpdateState> {
      return {
        ...(await adapters.store.list()),
        trustedAssets: adapters.store.catalog.map(publicUpdateAsset),
        pending,
        appReleaseChannelConfigured: false,
        smartReleaseChannelConfigured: false,
        discoversLatestVersions: false,
        installationSupported: false
      }
    },
    prepare(raw: unknown): RelayUpdatePlan {
      if (pending) throw new Error('请等待当前更新候选操作结束。')
      adapters.assertIdle()
      proof = undefined
      const request = relayUpdateRequest(raw)
      const asset = adapters.store.asset(request.target)
      proof = {
        ...publicUpdateAsset(asset),
        evidenceId: randomUUID(),
        proxyPort: request.proxyPort,
        expiresAt: now() + 60000
      }
      return structuredClone(proof)
    },
    async execute(
      raw: unknown
    ): Promise<{ status: 'staged' | 'cancelled'; candidate?: RelayUpdateCandidate }> {
      const id = relayUpdateId(raw, 'evidenceId')
      const prepared = proof
      const fresh = (): boolean =>
        !!prepared && now() <= prepared.expiresAt && now() >= prepared.expiresAt - 60000
      if (!prepared || prepared.evidenceId !== id || !fresh()) {
        proof = undefined
        throw new Error('请重新准备本次可信资源获取。')
      }
      begin()
      proof = undefined
      controller = new AbortController()
      const signal = controller.signal
      try {
        if (!(await adapters.confirmDownload(structuredClone(prepared))))
          return { status: 'cancelled' }
        adapters.assertIdle()
        if (signal.aborted) return { status: 'cancelled' }
        if (!fresh()) throw new Error('确认期间获取凭据已过期。')
        const asset = adapters.store.asset(prepared.target)
        if (
          asset.version !== prepared.version ||
          asset.payloadSHA256 !== prepared.sha256 ||
          asset.downloadBytes !== prepared.downloadBytes ||
          asset.architecture !== prepared.architecture
        )
          throw new Error('确认期间可信资源清单已变化。')
        const download = adapters.download ?? downloadSubStoreAsset
        const bytes = await download(
          {
            version: asset.version,
            url: asset.url,
            releaseURL: asset.releaseURL,
            size: asset.downloadBytes,
            sha256: asset.downloadSHA256
          },
          prepared.proxyPort,
          signal
        )
        if (signal.aborted) return { status: 'cancelled' }
        adapters.assertIdle()
        const candidate = await adapters.store.stage(asset, bytes, signal)
        return { status: 'staged', candidate }
      } catch {
        if (signal.aborted) return { status: 'cancelled' }
        throw new Error(
          '更新候选获取或校验未完成；既有候选和在用版本保留，未安装、切换或回退直连。'
        )
      } finally {
        end()
      }
    },
    async remove(raw: unknown): Promise<{ status: 'removed' | 'cancelled' }> {
      const id = relayUpdateId(raw)
      begin()
      try {
        const { record } = await adapters.store.resolve(id)
        if (!(await adapters.confirmRemove(record))) return { status: 'cancelled' }
        adapters.assertIdle()
        await adapters.store.remove(id)
        return { status: 'removed' }
      } finally {
        end()
      }
    },
    async importVariant(raw: unknown): Promise<{ status: 'imported' | 'cancelled' }> {
      const id = relayUpdateId(raw)
      if (!adapters.confirmImport || !adapters.importCandidate)
        throw new Error('候选导入尚未接通。')
      begin()
      proof = undefined
      controller = new AbortController()
      const signal = controller.signal,
        preparedAt = now()
      let committing = false
      try {
        adapters.assertImportIdle?.()
        const request = candidateVariantImport(await adapters.store.resolve(id))
        const { sourcePath: _sourcePath, ...metadata } = request
        if (!(await adapters.confirmImport(metadata))) return { status: 'cancelled' }
        if (signal.aborted) return { status: 'cancelled' }
        if (now() < preparedAt || now() - preparedAt > 60000) throw new Error('导入确认已过期。')
        adapters.assertIdle()
        adapters.assertImportIdle?.()
        committing = true
        await adapters.importCandidate(request)
        return { status: 'imported' }
      } catch {
        if (signal.aborted && !committing) return { status: 'cancelled' }
        throw new Error('候选导入未完成；原候选保留，没有切换或启用资源。')
      } finally {
        end()
      }
    },
    async applySubStore(raw: unknown): Promise<{ status: 'applied' | 'cancelled' }> {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(',') !== 'backendId,frontendId'
      )
        throw new Error('Sub-Store接入只接受两个候选ID。')
      const input = raw as Record<string, unknown>,
        backendId = relayUpdateId({ id: input.backendId }),
        frontendId = relayUpdateId({ id: input.frontendId })
      if (!adapters.confirmSubStore || !adapters.applySubStore)
        throw new Error('Sub-Store候选接入尚未配置。')
      begin()
      proof = undefined
      controller = new AbortController()
      const signal = controller.signal,
        preparedAt = now()
      let committing = false
      const resolvePair = async () => {
        const backend = await adapters.store.resolve(backendId),
          frontend = await adapters.store.resolve(frontendId)
        if (
          backend.record.target !== 'substore-backend' ||
          frontend.record.target !== 'substore-frontend'
        )
          throw new Error('请选择匹配的Sub-Store前后端候选。')
        return { backend, frontend }
      }
      try {
        adapters.assertSubStoreIdle?.()
        const prepared = await resolvePair()
        if (
          !(await adapters.confirmSubStore({
            backend: publicUpdateAsset(adapters.store.asset(prepared.backend.record.target)),
            frontend: publicUpdateAsset(adapters.store.asset(prepared.frontend.record.target))
          })) ||
          signal.aborted
        )
          return { status: 'cancelled' }
        if (now() < preparedAt || now() - preparedAt > 60000)
          throw new Error('资源接入确认已过期。')
        adapters.assertIdle()
        adapters.assertSubStoreIdle?.()
        const current = await resolvePair()
        if (JSON.stringify(current) !== JSON.stringify(prepared))
          throw new Error('候选确认后已发生变化。')
        const backend = await readBinaryResource(
          current.backend.path,
          true,
          current.backend.record.payloadBytes
        )
        const frontend = await readBinaryResource(
          current.frontend.path,
          true,
          current.frontend.record.payloadBytes
        )
        if (
          backend.length !== current.backend.record.payloadBytes ||
          resourceHash(backend) !== current.backend.record.payloadSHA256 ||
          frontend.length !== current.frontend.record.payloadBytes ||
          resourceHash(frontend) !== current.frontend.record.payloadSHA256
        )
          throw new Error('候选正文已改变。')
        if (signal.aborted) return { status: 'cancelled' }
        committing = true
        await adapters.applySubStore(backend, frontend, signal)
        return { status: 'applied' }
      } catch {
        if (signal.aborted && !committing) return { status: 'cancelled' }
        throw new Error('Sub-Store资源接入未确认；候选及原件保留，未启动服务或切换核心。')
      } finally {
        end()
      }
    },
    // Main-process handoff only. The renderer never receives a path, hash pin
    // override or installation capability. Activation stays a separate flow.
    resolveCandidate(raw: unknown) {
      return adapters.store.resolve(relayUpdateId(raw))
    }
  }
}
