import { randomUUID } from 'crypto'
import { type SubscriptionRequest } from '../../../shared/relay/subscription'
import { profileEvidence } from '../../../shared/relay/profiles'
import {
  sourceRestoreRequest,
  sourceRequestTimeoutSeconds,
  type SubscriptionSourcePlan,
  type SubscriptionSourceState,
  type SubscriptionSourceResult,
  type SubscriptionSourceInventory,
  type SourceOptions,
  type SourceRequestTuning,
  type SourceMetadata,
  type SourceTransferResult
} from '../../../shared/relay/subscription-sources'
import type { ProfileStore } from '../profiles/store'
import { inspectProfile } from '../profiles/inspect'
import { profileHash } from '../profiles/source'
import { SubscriptionSourceStore, SubscriptionJournalUncertain } from './source-store'
import { sourceRegistration, sourceOptions, sourceUpdatePreparation } from './source-options'

type Stored = Awaited<ReturnType<SubscriptionSourceStore['read']>>
type Proof = {
  report: SubscriptionSourcePlan
  at: number
  request?: SubscriptionRequest
  options?: SourceOptions
  requestTuning?: SourceRequestTuning
  metadata?: SourceMetadata
  observationOnly?: boolean
  automatic?: boolean
  stored?: Stored
  text?: string
  targetRevision?: string
  targetId?: string
  profileRevision?: string
}
export function createSubscriptionSourceService(adapters: {
  store: Pick<SubscriptionSourceStore, 'read' | 'readId' | 'list' | 'create' | 'commit' | 'observe'>
  profiles: Pick<ProfileStore, 'read' | 'save'>
  inheritProfileEdits?(previousId: string, targetId: string): Promise<void>
  download(url: string, port: number, signal: AbortSignal): Promise<string>
  transfer?(
    url: string,
    port: number,
    signal: AbortSignal,
    options: SourceOptions,
    cache?: SourceMetadata,
    tuning?: SourceRequestTuning
  ): Promise<SourceTransferResult>
  confirm(report: SubscriptionSourcePlan): Promise<boolean>
  now?(): number
}) {
  let proof: Proof | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    closing: Promise<void> | undefined,
    operation:
      | {
          id: string
          phase: SubscriptionSourceState['phase']
          abort: AbortController
          cancelled: boolean
          writing: boolean
        }
      | undefined
  const now = adapters.now ?? Date.now,
    waiters: (() => void)[] = []
  let closeEpoch = 0,
    listing = false
  const fresh = (p: Proof): boolean => now() >= p.at && now() - p.at <= 60000
  const reset = (): void => {
    clearTimeout(timer)
    proof = undefined
  }
  const hold = (p: Proof): SubscriptionSourcePlan => {
    reset()
    proof = p
    timer = setTimeout(reset, 60000)
    timer.unref?.()
    return structuredClone(p.report)
  }
  const idle = (): void => {
    if (operation || closing) throw new Error('来源操作或退出尚未结束。')
  }
  const begin = (id: string, phase: SubscriptionSourceState['phase']) => {
    idle()
    operation = { id, phase, abort: new AbortController(), cancelled: false, writing: false }
    return operation
  }
  const end = (): void => {
    operation = undefined
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const whenIdle = (): Promise<void> =>
    operation ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const head = async (stored: Stored): Promise<string | undefined> => {
    const v = stored.info.versions.at(-1)
    return v ? (await adapters.profiles.read(v.profile)).revision : undefined
  }
  const same = async (p: Proof): Promise<Stored> => {
    if (!p.report.source) throw new Error()
    const stored = await adapters.store.read(p.report.source)
    if (stored.info.locked || (await head(stored)) !== p.profileRevision) throw new Error()
    return stored
  }
  const describe = (
    stored: Stored,
    kind: SubscriptionSourcePlan['kind']
  ): SubscriptionSourcePlan => ({
    evidenceId: randomUUID(),
    kind,
    name: stored.info.name,
    origin: stored.info.origin,
    proxyPort: stored.info.proxyPort,
    source: { id: stored.info.id, revision: stored.info.revision }
  })
  const api = {
    isBusy: (): boolean => !!operation || !!closing,
    isListing: (): boolean => listing,
    whenIdle,
    state(): SubscriptionSourceState {
      return {
        phase: operation?.phase ?? 'idle',
        pending: !!operation || !!closing,
        operationId: operation?.id,
        preparedId: proof && fresh(proof) ? proof.report.evidenceId : undefined
      }
    },
    clear(): void {
      ++closeEpoch
      reset()
      if (operation && !operation.writing) {
        operation.cancelled = true
        operation.abort.abort()
      }
    },
    async list(): Promise<SubscriptionSourceInventory> {
      const op = begin(randomUUID(), 'reading')
      listing = true
      try {
        const inventory = await adapters.store.list(),
          sources: SubscriptionSourceInventory['sources'] = []
        let incomplete = inventory.incomplete,
          budget = 1000
        for (const source of inventory.sources) {
          if (op.cancelled) throw new Error()
          try {
            if (source.versions.length > budget) throw new Error()
            budget -= source.versions.length
            for (const version of source.versions) await adapters.profiles.read(version.profile)
            await adapters.store.read({ id: source.id, revision: source.revision })
            sources.push(source)
          } catch {
            ++incomplete
          }
        }
        return {
          sources,
          incomplete,
          warnings: [
            ...inventory.warnings,
            ...(incomplete ? ['部分来源／历史配置未完整复核；保留数据，不自动选择或更新。'] : []),
            'URL及其中令牌仅保存在当前用户私有文件中，未加密；未联网，不自动更新或启用。'
          ]
        }
      } catch {
        throw new Error('来源列表未确认，没有修改或联网。')
      } finally {
        listing = false
        end()
      }
    },
    prepareRegistration(raw: unknown): SubscriptionSourcePlan {
      const { request, options } = sourceRegistration(raw)
      idle()
      return hold({
        report: {
          evidenceId: randomUUID(),
          kind: 'register',
          name: request.name,
          origin: new URL(request.url).origin,
          proxyPort: request.proxyPort,
          ...(options
            ? {
                options: {
                  redirects: options.redirects,
                  schedule: options.schedule,
                  useServerInterval: options.useServerInterval,
                  privateHeaders: Object.keys(options.headers).length > 0,
                  ageIdentity: !!options.ageSecretKey
                }
              }
            : {})
        },
        request,
        options,
        at: now()
      })
    },
    async prepareUpdate(raw: unknown): Promise<SubscriptionSourcePlan> {
      const { selected, tuning } = sourceUpdatePreparation(raw)
      if (tuning && !adapters.transfer) throw new Error('本次订阅不支持请求选项。')
      const op = begin(randomUUID(), 'reading')
      reset()
      try {
        const stored = await adapters.store.read(selected),
          profileRevision = await head(stored)
        if (stored.info.locked || op.cancelled || stored.info.versions.length >= 100)
          throw new Error()
        await adapters.store.read(selected)
        const report = describe(stored, 'update')
        if (tuning) {
          report.requestTuning = {
            timeoutSeconds: tuning.timeoutSeconds ?? sourceRequestTimeoutSeconds,
            customUserAgent:
              tuning.userAgent !== undefined &&
              !Object.hasOwn(stored.options?.headers ?? {}, 'user-agent')
          }
        }
        return hold({ report, stored, profileRevision, requestTuning: tuning, at: now() })
      } catch {
        throw new Error('来源或当前版本不可用，未请求订阅。')
      } finally {
        end()
      }
    },
    async prepareRestore(raw: unknown): Promise<SubscriptionSourcePlan> {
      const input = sourceRestoreRequest(raw),
        op = begin(randomUUID(), 'reading')
      reset()
      try {
        const stored = await adapters.store.read(input.source),
          target = stored.info.versions.find((v) => v.id === input.versionId)
        if (!target || stored.info.locked || op.cancelled || stored.info.versions.length >= 100)
          throw new Error()
        const targetProfile = await adapters.profiles.read(target.profile),
          profileRevision = await head(stored)
        await adapters.store.read(input.source)
        return hold({
          report: {
            ...describe(stored, 'restore'),
            profile: target.profile,
            sha256: target.profile.sha256
          },
          stored,
          targetId: target.id,
          targetRevision: targetProfile.revision,
          profileRevision,
          at: now()
        })
      } catch {
        throw new Error('历史版本或来源未通过复核，未恢复。')
      } finally {
        end()
      }
    },
    async execute(raw: unknown): Promise<SubscriptionSourceResult> {
      const id = profileEvidence(raw),
        p = proof
      idle()
      if (!p || p.report.evidenceId !== id || !fresh(p)) {
        reset()
        throw new Error('来源操作凭据已失效。')
      }
      const op = begin(id, 'confirming')
      try {
        if ((!p.automatic && !(await adapters.confirm(structuredClone(p.report)))) || op.cancelled)
          return { status: 'cancelled', warnings: ['已取消，未更新来源或配置。'] }
        if (proof !== p || !fresh(p)) throw new Error()
        reset()
        if (p.report.kind === 'register' && p.request) {
          op.writing = true
          op.phase = 'saving'
          return {
            status: 'saved',
            source: await (p.options
              ? adapters.store.create(p.request, p.options)
              : adapters.store.create(p.request)),
            warnings: ['已私有保存来源及URL令牌，未下载、启用或自动更新。']
          }
        }
        const selectedSource = p.report.source
        if (!selectedSource) throw new Error()
        const stored = await same(p)
        if (op.cancelled) return { status: 'cancelled', warnings: ['已取消，既有版本保留。'] }
        if (p.report.kind === 'update') {
          op.phase = 'downloading'
          const response = adapters.transfer
            ? await adapters.transfer(
                stored.request.url,
                stored.request.proxyPort,
                op.abort.signal,
                stored.options ?? sourceOptions(undefined),
                stored.cache?.metadata,
                p.requestTuning
              )
            : await adapters.download(stored.request.url, stored.request.proxyPort, op.abort.signal)
          const metadata = typeof response === 'string' ? undefined : response.metadata,
            previous = stored.info.versions.at(-1),
            text =
              typeof response === 'string'
                ? response
                : response.status === 'notModified' &&
                    previous &&
                    stored.cache?.profile.id === previous.profile.id
                  ? (await adapters.profiles.read(previous.profile)).text
                  : response.text
          if (text === undefined) throw new Error()
          if (op.cancelled) return { status: 'cancelled', warnings: ['已取消下载，既有版本保留。'] }
          await same(p)
          const inspected = inspectProfile(text),
            s = inspected.summary
          if (
            inspected.structure !== 'passed' ||
            !s ||
            !(s.proxies || s.groups || s.proxyProviders)
          )
            throw new Error()
          const sha256 = profileHash(text)
          const observationOnly = stored.info.versions.at(-1)?.profile.sha256 === sha256
          if (observationOnly && !metadata)
            return {
              status: 'unchanged',
              warnings: ['订阅正文与当前记录相同，未新建版本、启用或热载。']
            }
          const plan = hold({
            report: {
              ...describe(stored, 'commit'),
              bytes: Buffer.byteLength(text),
              sha256,
              ...(observationOnly ? { observationOnly: true } : {})
            },
            stored,
            text,
            metadata,
            observationOnly,
            automatic: p.automatic,
            profileRevision: p.profileRevision,
            at: now()
          })
          return {
            status: 'staged',
            plan,
            warnings: ['下载结构检查通过，待单独确认保存新版本。既有版本未变，核心兼容性未验证。']
          }
        }
        op.phase = 'saving'
        if (p.report.kind === 'restore' && p.report.profile && p.targetId) {
          const selectedProfile = p.report.profile,
            targetId = p.targetId,
            target = await adapters.profiles.read(selectedProfile)
          if (target.revision !== p.targetRevision) throw new Error()
          if (
            JSON.stringify(stored.info.versions.at(-1)?.profile) ===
            JSON.stringify(p.report.profile)
          )
            return { status: 'unchanged', warnings: ['该配置已是当前来源记录，未重复追加。'] }
          if (op.cancelled) return { status: 'cancelled', warnings: ['已取消，既有版本保留。'] }
          op.writing = true
          const source = await adapters.store.commit(selectedSource, async () => {
            if ((await adapters.profiles.read(selectedProfile)).revision !== p.targetRevision)
              throw new Error()
            return { profile: selectedProfile, restoredFrom: targetId }
          })
          return {
            status: 'saved',
            source,
            warnings: ['已追加历史版本选择记录，旧记录保留；未改变正在使用的配置、热载或网络。']
          }
        }
        if (
          p.report.kind !== 'commit' ||
          p.text === undefined ||
          profileHash(p.text) !== p.report.sha256
        )
          throw new Error()
        if (op.cancelled) return { status: 'cancelled', warnings: ['已取消，既有版本保留。'] }
        op.writing = true
        const text = p.text
        if (p.observationOnly && p.metadata) {
          const previous = stored.info.versions.at(-1)
          if (!previous) throw new Error()
          const source = await adapters.store.commit(
            selectedSource,
            async () => {
              if ((await head(stored)) !== p.profileRevision) throw new Error()
              return { profile: previous.profile }
            },
            { metadata: p.metadata, check: true }
          )
          if ((await head(stored)) !== p.profileRevision) throw new Error()
          return {
            status: 'unchanged',
            source,
            warnings: ['已追加缓存检查／配额记录，配置正文与版本未变；未启用或热载。']
          }
        }
        const source = await adapters.store.commit(
          selectedSource,
          async () => {
            // The store holds its own source lease; check the old profile again
            // before any new immutable profile is created.
            if ((await head(stored)) !== p.profileRevision) throw new Error()
            const saved = await adapters.profiles.save(stored.info.name, text)
            const selected = { id: saved.id, sha256: saved.sha256 }
            await adapters.profiles.read(selected)
            const previous = stored.info.versions.at(-1)?.profile
            if (previous) await adapters.inheritProfileEdits?.(previous.id, saved.id)
            return { profile: selected }
          },
          p.metadata ? { metadata: p.metadata } : undefined
        )
        return {
          status: 'saved',
          source,
          warnings: ['已追加独立配置和订阅版本记录；未覆盖旧文件、启用配置或修改网络。']
        }
      } catch (error) {
        return {
          status:
            op.cancelled && !op.writing
              ? 'cancelled'
              : op.writing || error instanceof SubscriptionJournalUncertain
                ? 'uncertain'
                : 'failed',
          warnings: ['来源、下载或版本事务未确认；保留既有记录，不自动重试、直连或启用。']
        }
      } finally {
        end()
      }
    },
    async runScheduled(id: string, originRevision: string): Promise<SubscriptionSourceResult> {
      idle()
      const epoch = closeEpoch
      const stored = await adapters.store.readId(id)
      if (stored.originRevision !== originRevision || epoch !== closeEpoch)
        throw new Error('调度来源已变化，需重新授权。')
      const report = await api.prepareUpdate({ id: stored.info.id, revision: stored.info.revision })
      if (
        epoch !== closeEpoch ||
        !proof ||
        proof.report.evidenceId !== report.evidenceId ||
        proof.stored?.originRevision !== originRevision
      )
        throw new Error('调度准备未确认。')
      proof.automatic = true
      const result = await api.execute({ evidenceId: report.evidenceId })
      if (epoch !== closeEpoch)
        return { status: 'cancelled', warnings: ['调度已停止，未继续提交后续阶段。'] }
      if (result.status === 'staged' && result.plan)
        return api.execute({ evidenceId: result.plan.evidenceId })
      return result
    },
    cancel(raw: unknown): { status: 'requested' | 'discarded' | 'busy' | 'stale' } {
      const id = profileEvidence(raw)
      if (operation?.id === id) {
        if (operation.writing) return { status: 'busy' }
        operation.cancelled = true
        operation.abort.abort()
        return { status: 'requested' }
      }
      if (proof?.report.evidenceId === id) {
        reset()
        return { status: 'discarded' }
      }
      return { status: 'stale' }
    },
    requestClose(): Promise<void> {
      ++closeEpoch
      if (proof?.automatic) reset()
      if (closing) return closing
      if (!operation) return Promise.resolve()
      if (!operation.writing) {
        operation.cancelled = true
        operation.abort.abort()
      }
      closing = whenIdle().finally(() => {
        closing = undefined
      })
      return closing
    }
  }
  return api
}
