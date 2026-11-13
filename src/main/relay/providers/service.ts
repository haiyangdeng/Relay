import { randomUUID } from 'crypto'
import {
  profileEvidence,
  type RelayStoredProfile,
  type RelayProfileSaveResult
} from '../../../shared/relay/profiles'
import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'
import {
  providerBatchRequest,
  providerRequest,
  providerSnapshotRequest,
  type ProviderBatchFetchResult,
  type ProviderBatchPreparation,
  type ProviderInventory,
  type ProviderPreparation,
  type ProviderFetchResult,
  type ProviderSnapshotPreparation,
  type ProviderState,
  type ProviderResource
} from '../../../shared/relay/providers'
import type { ProfileStore } from '../profiles/store'
import { ProfileWriteUncertain } from '../profiles/store'
import { PROFILE_BYTE_LIMIT } from '../profiles/inspect'
import { profileHash, type ProfileSource } from '../profiles/source'
import {
  providerDescriptors,
  parseProviderResource,
  materializeProviders,
  resourceBinding,
  type ProviderDescriptor
} from './materialize'

type Stored = Awaited<ReturnType<ProfileStore['read']>>
type HttpProviderDescriptor = ProviderDescriptor & { url: string }
const BATCH_TRANSFER_BUDGET_SECONDS = 90
const entry = (p: RelayStoredProfile): ProviderResource => ({
  id: p.id,
  sha256: p.sha256,
  createdAt: p.createdAt,
  nodes: p.summary.proxies
})
export function createProviderService(adapters: {
  read(selection: RelayProfileSelection): Promise<Stored>
  cache: Pick<ProfileStore, 'save' | 'read' | 'list'>
  save(name: string, text: string): Promise<RelayStoredProfile>
  pick(): Promise<ProfileSource | undefined>
  download(
    url: string,
    port: number,
    signal: AbortSignal,
    headers: Record<string, string>,
    limit: number
  ): Promise<string>
  confirmAcquire(report: ProviderPreparation): Promise<boolean>
  confirmBatchAcquire?(report: ProviderBatchPreparation): Promise<boolean>
  confirmSnapshot(report: ProviderSnapshotPreparation): Promise<boolean>
  now?(): number
}) {
  let operation:
    | {
        id: string
        phase: ProviderState['phase']
        abort: AbortController
        cancelled: boolean
        writing: boolean
        batch: boolean
      }
    | undefined
  let acquisition:
    | {
        report: ProviderPreparation
        selection: RelayProfileSelection
        revision: string
        descriptor: ProviderDescriptor
        at: number
      }
    | undefined
  let batch:
    | {
        report: ProviderBatchPreparation
        selection: RelayProfileSelection
        revision: string
        descriptors: HttpProviderDescriptor[]
        at: number
      }
    | undefined
  let snapshot:
    | {
        report: ProviderSnapshotPreparation
        selection: RelayProfileSelection
        revision: string
        resources: Record<string, RelayProfileSelection>
        revisions: Record<string, string>
        at: number
      }
    | undefined
  let closing: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const now = adapters.now ?? Date.now,
    waiters: (() => void)[] = []
  const fresh = (at: number): boolean => now() >= at && now() - at <= 60000
  const reset = (): void => {
    clearTimeout(timer)
    acquisition = undefined
    batch = undefined
    snapshot = undefined
  }
  const expire = (): void => {
    clearTimeout(timer)
    timer = setTimeout(reset, 60000)
    timer.unref?.()
  }
  const idle = (): void => {
    if (operation || closing) throw new Error('提供者操作或退出处理尚未结束。')
  }
  const begin = (id: string, phase: ProviderState['phase'], batch = false) => {
    idle()
    operation = { id, phase, abort: new AbortController(), cancelled: false, writing: false, batch }
    return operation
  }
  const end = (): void => {
    operation = undefined
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const whenIdle = (): Promise<void> =>
    operation ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const same = async (selection: RelayProfileSelection, revision: string): Promise<Stored> => {
    const stored = await adapters.read(selection)
    if (stored.revision !== revision) throw new Error('来源已改变。')
    return stored
  }
  const resourcesFor = async (stored: Stored, selected: Record<string, RelayProfileSelection>) => {
    const { descriptors } = providerDescriptors(stored.text)
    if (descriptors.length !== Object.keys(selected).length)
      throw new Error('请选择全部提供者缓存。')
    const texts: Record<string, string> = {},
      revisions: Record<string, string> = {}
    let bytes = 0
    for (const d of descriptors) {
      const choice = selected[d.item.name]
      if (!choice) throw new Error()
      const resource = await adapters.cache.read(choice)
      if (
        resource.profile.name !== resourceBinding(stored.profile.id, stored.revision, d.item.name)
      )
        throw new Error('缓存不属于当前来源。')
      bytes += Buffer.byteLength(resource.text)
      if (bytes > 4 * 1024 * 1024) throw new Error('缓存合计超过4MiB。')
      texts[d.item.name] = resource.text
      revisions[d.item.name] = resource.revision
    }
    return { texts, revisions }
  }
  const output = (
    stored: Stored,
    selected: Record<string, RelayProfileSelection>,
    texts: Record<string, string>
  ) => {
    const result = materializeProviders(stored.text, texts)
    const refs = Object.keys(selected)
      .sort()
      .map((name) => `# provider-cache: ${selected[name].id} ${selected[name].sha256}`)
    const text = [
      '# Relay static provider snapshot',
      `# source-profile: ${stored.profile.id} ${stored.profile.sha256}`,
      ...refs,
      result.text
    ].join('\n')
    if (Buffer.byteLength(text) > PROFILE_BYTE_LIMIT) throw new Error('含来源记录的副本超过2MiB。')
    return { text, nodes: result.nodes }
  }
  return {
    whenIdle,
    isBusy: (): boolean => !!operation || !!closing,
    state(): ProviderState {
      return {
        phase: operation?.phase ?? 'idle',
        pending: !!operation || !!closing,
        operationId: operation?.id,
        preparedId:
          acquisition && fresh(acquisition.at) ? acquisition.report.evidenceId : undefined,
        batchPreparedId: batch && fresh(batch.at) ? batch.report.evidenceId : undefined,
        snapshotId: snapshot && fresh(snapshot.at) ? snapshot.report.evidenceId : undefined
      }
    },
    clear(): void {
      reset()
      if (operation && (!operation.writing || operation.batch)) {
        operation.cancelled = true
        operation.abort.abort()
      }
    },
    invalidateBatch(): void {
      if (batch) reset()
      if (operation?.batch) {
        operation.cancelled = true
        operation.abort.abort()
      }
    },
    async inspect(raw: unknown): Promise<ProviderInventory> {
      const selection = profileSelection(raw)
      const op = begin(randomUUID(), 'reading')
      try {
        const stored = await adapters.read(selection),
          { descriptors } = providerDescriptors(stored.text),
          cache = await adapters.cache.list()
        await same(selection, stored.revision)
        if (op.cancelled) throw new Error()
        return {
          profile: stored.profile,
          providers: descriptors.map((d) => ({
            ...d.item,
            resources: cache.profiles
              .filter(
                (p) => p.name === resourceBinding(stored.profile.id, stored.revision, d.item.name)
              )
              .map(entry)
          })),
          incomplete: cache.incomplete,
          warnings: [
            '缓存是私有未启用快照，不执行定时更新／健康检查；来源修订变化后的旧缓存保留但不自动复用。',
            ...cache.warnings
          ]
        }
      } catch {
        throw new Error('提供者列表或缓存未能完整复核；未获取或改动来源。')
      } finally {
        end()
      }
    },
    async prepare(raw: unknown): Promise<ProviderPreparation> {
      const input = providerRequest(raw),
        op = begin(randomUUID(), 'reading')
      reset()
      try {
        const stored = await adapters.read(input.profile),
          descriptor = providerDescriptors(stored.text).descriptors.find(
            (d) => d.item.name === input.provider
          )
        if (!descriptor?.item.canAcquire || op.cancelled) throw new Error()
        const report = {
          evidenceId: randomUUID(),
          profile: stored.profile,
          provider: descriptor.item,
          proxyPort: input.proxyPort
        }
        acquisition = {
          report,
          selection: input.profile,
          revision: stored.revision,
          descriptor,
          at: now()
        }
        expire()
        return structuredClone(report)
      } catch {
        throw new Error('提供者获取准备未通过；请核对来源、类型、地址或请求头。')
      } finally {
        end()
      }
    },
    async acquire(raw: unknown): Promise<ProviderFetchResult> {
      const id = profileEvidence(raw),
        current = acquisition
      idle()
      if (!current || current.report.evidenceId !== id || !fresh(current.at))
        throw new Error('提供者准备已过期，请重新准备。')
      const op = begin(id, 'confirming')
      try {
        if (!(await adapters.confirmAcquire(structuredClone(current.report))) || op.cancelled)
          return { status: 'cancelled', warnings: ['已取消，没有获取或缓存资源。'] }
        if (acquisition !== current || !fresh(current.at)) throw new Error()
        reset()
        await same(current.selection, current.revision)
        if (op.cancelled) return { status: 'cancelled', warnings: ['已取消，未缓存。'] }
        op.phase = 'acquiring'
        const d = current.descriptor
        let text: string, picked: ProfileSource | undefined
        if (d.item.kind === 'inline' && d.inline) text = d.inline
        else if (d.item.kind === 'http' && d.url)
          text = await adapters.download(
            d.url,
            current.report.proxyPort,
            op.abort.signal,
            d.headers ?? {},
            d.limit
          )
        else {
          picked = await adapters.pick()
          if (!picked || op.cancelled)
            return { status: 'cancelled', warnings: ['已取消本地文件选择，未缓存。'] }
          text = picked.text
        }
        if (op.cancelled) return { status: 'cancelled', warnings: ['获取已取消，未缓存。'] }
        if (Buffer.byteLength(text) > d.limit) throw new Error()
        parseProviderResource(text)
        if (picked && profileHash(await picked.readAgain()) !== profileHash(text)) throw new Error()
        await same(current.selection, current.revision)
        if (op.cancelled) return { status: 'cancelled', warnings: ['已取消，未缓存。'] }
        op.phase = 'saving'
        op.writing = true
        const stored = await adapters.cache.save(
          resourceBinding(current.report.profile.id, current.revision, d.item.name),
          text
        )
        await same(current.selection, current.revision)
        return {
          status: 'cached',
          resource: entry(stored),
          warnings: [
            '已缓存私有资源，未启用或更新原配置；原path／proxy／interval／健康检查未执行。'
          ]
        }
      } catch (error) {
        return {
          status: op.cancelled
            ? 'cancelled'
            : op.writing || error instanceof ProfileWriteUncertain
              ? 'uncertain'
              : 'failed',
          warnings: [
            '获取、来源复核或缓存写入未确认；保留既有文件，没有自动重试、使用fallback或回退直连。'
          ]
        }
      } finally {
        acquisition = undefined
        end()
      }
    },
    async prepareBatch(raw: unknown): Promise<ProviderBatchPreparation> {
      const input = providerBatchRequest(raw),
        op = begin(randomUUID(), 'reading', true)
      reset()
      try {
        const stored = await adapters.read(input.profile),
          { descriptors } = providerDescriptors(stored.text),
          eligible = descriptors.filter(
            (d): d is HttpProviderDescriptor =>
              d.item.kind === 'http' && d.item.canAcquire && d.url !== undefined
          ),
          requested = new Set(input.providers)
        if (eligible.length !== requested.size || eligible.some((d) => !requested.has(d.item.name)))
          throw new Error()
        await same(input.profile, stored.revision)
        if (op.cancelled) throw new Error()
        const report: ProviderBatchPreparation = {
          evidenceId: randomUUID(),
          profile: stored.profile,
          providers: eligible.map((d) => d.item),
          proxyPort: input.proxyPort
        }
        batch = {
          report,
          selection: input.profile,
          revision: stored.revision,
          descriptors: eligible,
          at: now()
        }
        expire()
        return structuredClone(report)
      } catch {
        throw new Error('批量准备未通过，请刷新来源并确认全部可获取的 HTTP(S) 节点提供者。')
      } finally {
        end()
      }
    },
    async acquireBatch(raw: unknown): Promise<ProviderBatchFetchResult> {
      const id = profileEvidence(raw),
        current = batch
      idle()
      if (!current || current.report.evidenceId !== id || !fresh(current.at))
        throw new Error('批量准备已过期，请重新准备。')
      const op = begin(id, 'confirming', true)
      reset()
      const items: ProviderBatchFetchResult['items'] = current.descriptors.map((d) => ({
        provider: d.item.name,
        status: 'skipped'
      }))
      const warnings = ['已确认的结果仅保存到 Relay 私有缓存，待另行生成独立配置。']
      let budget: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      let sourceChanged = false
      const verifySource = () =>
        same(current.selection, current.revision).catch(() => {
          sourceChanged = true
          throw new Error()
        })
      const assertRunning = (): void => {
        if (timedOut || op.cancelled) throw new Error()
      }
      try {
        if (!adapters.confirmBatchAcquire) throw new Error()
        if (!(await adapters.confirmBatchAcquire(structuredClone(current.report))))
          op.cancelled = true
        if (!op.cancelled) {
          if (!fresh(current.at)) throw new Error()
          budget = setTimeout(() => {
            timedOut = true
            op.abort.abort()
          }, BATCH_TRANSFER_BUDGET_SECONDS * 1000)
          budget.unref?.()
          for (const [index, d] of current.descriptors.entries()) {
            if (op.cancelled || timedOut) break
            const item = items[index]
            try {
              op.phase = 'reading'
              await verifySource()
              assertRunning()
              op.phase = 'acquiring'
              const resource = await adapters.download(
                d.url,
                current.report.proxyPort,
                op.abort.signal,
                d.headers ?? {},
                d.limit
              )
              assertRunning()
              if (Buffer.byteLength(resource) > d.limit) throw new Error()
              parseProviderResource(resource)
              await verifySource()
              assertRunning()
              op.phase = 'saving'
              op.writing = true
              const stored = await adapters.cache.save(
                resourceBinding(current.report.profile.id, current.revision, item.provider),
                resource
              )
              await verifySource()
              item.resource = entry(stored)
              item.status = 'cached'
            } catch (error) {
              if (op.writing || error instanceof ProfileWriteUncertain) {
                item.status = 'uncertain'
                break
              }
              item.status = op.cancelled ? 'cancelled' : 'failed'
              if (sourceChanged) break
            } finally {
              op.writing = false
            }
          }
        }
      } catch {
        warnings.push('未取得有效的本次确认，请重新准备。')
      } finally {
        clearTimeout(budget)
        end()
      }
      const cached = items.filter((item) => item.status === 'cached').length,
        uncertain = items.some((item) => item.status === 'uncertain')
      if (sourceChanged) warnings.push('来源复核失败，后续请求已停止。')
      if (timedOut)
        warnings.push(`本批次已达到 ${BATCH_TRANSFER_BUDGET_SECONDS} 秒预算，后续请求已停止。`)
      if (op.cancelled) warnings.push('本批次已取消，保留已确认的缓存。')
      if (uncertain) warnings.push('缓存写入或写入后的复核结果未确认，后续请求已停止。')
      if (items.some((item) => item.status === 'failed'))
        warnings.push('获取或验证失败的项目没有重试、跟随重定向或回退直连。')
      return {
        status: uncertain
          ? 'uncertain'
          : cached === items.length
            ? 'cached'
            : cached
              ? 'partial'
              : op.cancelled
                ? 'cancelled'
                : 'failed',
        items,
        warnings
      }
    },
    async prepareSnapshot(raw: unknown): Promise<ProviderSnapshotPreparation> {
      const input = providerSnapshotRequest(raw),
        op = begin(randomUUID(), 'building')
      reset()
      try {
        const stored = await adapters.read(input.profile),
          resolved = await resourcesFor(stored, input.resources),
          result = output(stored, input.resources, resolved.texts)
        await same(input.profile, stored.revision)
        if (op.cancelled) throw new Error()
        const report = {
          evidenceId: randomUUID(),
          profile: stored.profile,
          sha256: profileHash(result.text),
          bytes: Buffer.byteLength(result.text),
          nodes: result.nodes,
          canSave: true,
          issues: [
            '生成独立缓存副本：基础select可展开成员；动态筛选保留内联提供者交给固定核心。保存本身不运行核心或健康检查；以后启动会按保留的显式URL执行健康检查。原HTTP／file来源不自动更新，原文不改。'
          ]
        }
        snapshot = {
          report,
          selection: input.profile,
          revision: stored.revision,
          resources: input.resources,
          revisions: resolved.revisions,
          at: now()
        }
        expire()
        return structuredClone(report)
      } catch {
        throw new Error(
          '缓存副本准备失败：缓存归属／摘要、名称冲突、组类型、提供者变换或规模未通过检查。'
        )
      } finally {
        end()
      }
    },
    async saveSnapshot(raw: unknown): Promise<RelayProfileSaveResult> {
      const id = profileEvidence(raw),
        current = snapshot
      idle()
      if (!current || current.report.evidenceId !== id || !fresh(current.at))
        throw new Error('缓存副本准备已失效。')
      const op = begin(id, 'confirming')
      try {
        if (!(await adapters.confirmSnapshot(structuredClone(current.report))) || op.cancelled)
          return { status: 'cancelled', warnings: ['已取消保存缓存副本。'] }
        if (snapshot !== current || !fresh(current.at)) throw new Error()
        reset()
        const stored = await same(current.selection, current.revision),
          resolved = await resourcesFor(stored, current.resources)
        if (JSON.stringify(resolved.revisions) !== JSON.stringify(current.revisions))
          throw new Error()
        const result = output(stored, current.resources, resolved.texts)
        if (profileHash(result.text) !== current.report.sha256 || op.cancelled) throw new Error()
        await same(current.selection, current.revision)
        if (op.cancelled) throw new Error()
        op.phase = 'saving'
        op.writing = true
        let name = ''
        for (const char of stored.profile.name) {
          if (name.length + char.length > 95) break
          name += char
        }
        const profile = await adapters.save(name + ' · providers', result.text)
        await same(current.selection, current.revision)
        return {
          status: 'saved',
          profile,
          warnings: [
            '已保存独立缓存副本，未启用或热载；原文与资源缓存未改动。动态组／健康检查在以后明确启动时由固定核心执行，原HTTP／file来源不会自动更新。'
          ]
        }
      } catch (error) {
        return {
          status:
            op.cancelled && !op.writing
              ? 'cancelled'
              : op.writing || error instanceof ProfileWriteUncertain
                ? 'uncertain'
                : 'failed',
          warnings: ['缓存副本复核或写入未确认；保留既有文件，没有自动重试或启用。']
        }
      } finally {
        snapshot = undefined
        end()
      }
    },
    cancel(raw: unknown): { status: 'requested' | 'discarded' | 'busy' | 'stale' } {
      const id = profileEvidence(raw)
      if (operation?.id === id) {
        if (operation.writing && !operation.batch) return { status: 'busy' }
        operation.cancelled = true
        operation.abort.abort()
        return { status: 'requested' }
      }
      if (
        acquisition?.report.evidenceId === id ||
        batch?.report.evidenceId === id ||
        snapshot?.report.evidenceId === id
      ) {
        reset()
        return { status: 'discarded' }
      }
      return { status: 'stale' }
    },
    requestClose(): Promise<void> {
      if (closing) return closing
      if (!operation) return Promise.resolve()
      if (!operation.writing || operation.batch) {
        operation.cancelled = true
        operation.abort.abort()
      }
      closing = whenIdle().finally(() => {
        closing = undefined
      })
      return closing
    }
  }
}
