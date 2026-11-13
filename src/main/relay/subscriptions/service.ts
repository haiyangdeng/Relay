import { randomUUID } from 'crypto'
import {
  subscriptionRequest,
  type SubscriptionRequest,
  type SubscriptionPreparation,
  type SubscriptionDownloadResult,
  type SubscriptionState
} from '../../../shared/relay/subscription'
import {
  profileEvidence,
  type RelayProfilePreparation,
  type RelayProfileSaveResult,
  type RelayStoredProfile
} from '../../../shared/relay/profiles'
import { inspectProfile } from '../profiles/inspect'
import { profileHash } from '../profiles/source'
import { ProfileWriteUncertain } from '../profiles/store'
import { SUBSCRIPTION_TIMEOUT, SubscriptionTransferError } from './transfer'

export function createSubscriptionService(adapters: {
  download(url: string, proxyPort: number, signal: AbortSignal): Promise<string>
  confirmDownload(preparation: SubscriptionPreparation): Promise<boolean>
  confirmSave(preparation: RelayProfilePreparation): Promise<boolean>
  save(name: string, text: string): Promise<RelayStoredProfile>
  now?(): number
}) {
  let draft:
    { request: SubscriptionRequest; report: SubscriptionPreparation; at: number } | undefined
  let staged: { report: RelayProfilePreparation; text: string; at: number } | undefined
  let operation:
    | {
        id: string
        phase: SubscriptionState['phase']
        abort: AbortController
        cancelled: boolean
        writing: boolean
      }
    | undefined
  let closing: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const waiters: (() => void)[] = [],
    now = adapters.now ?? Date.now
  const timely = (at: number): boolean => now() >= at && now() - at <= 60000
  const reset = (): void => {
    clearTimeout(timer)
    draft = undefined
    staged = undefined
  }
  const expire = (): void => {
    clearTimeout(timer)
    timer = setTimeout(reset, 60000)
    timer.unref?.()
  }
  const whenIdle = (): Promise<void> =>
    operation ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const end = (): void => {
    operation = undefined
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const idle = (): void => {
    if (operation || closing) throw new Error('订阅操作或退出处理尚未结束。')
  }
  const state = (): SubscriptionState => ({
    phase: operation?.phase ?? (staged && timely(staged.at) ? 'downloaded' : 'idle'),
    pending: !!operation || !!closing,
    operationId: operation?.id,
    preparedId: draft && timely(draft.at) ? draft.report.evidenceId : undefined,
    stagedId: staged && timely(staged.at) ? staged.report.evidenceId : undefined
  })
  return {
    state,
    whenIdle,
    isBusy: (): boolean => !!operation || !!closing,
    clear(): void {
      reset()
      if (operation && !operation.writing) {
        operation.cancelled = true
        operation.abort.abort()
      }
    },
    prepare(raw: unknown): SubscriptionPreparation {
      const request = subscriptionRequest(raw)
      idle()
      reset()
      const report = {
        evidenceId: randomUUID(),
        name: request.name,
        origin: new URL(request.url).origin,
        proxyPort: request.proxyPort
      }
      draft = { request, report, at: now() }
      expire()
      return structuredClone(report)
    },
    async download(raw: unknown): Promise<SubscriptionDownloadResult> {
      const id = profileEvidence(raw),
        current = draft
      idle()
      if (!current || current.report.evidenceId !== id || !timely(current.at)) {
        reset()
        throw new Error('订阅准备已失效，请重新准备。')
      }
      const op = {
        id,
        phase: 'confirmingDownload' as SubscriptionState['phase'],
        abort: new AbortController(),
        cancelled: false,
        writing: false
      }
      operation = op
      try {
        if (!(await adapters.confirmDownload(structuredClone(current.report))) || op.cancelled)
          return { status: 'cancelled', warnings: ['已取消订阅请求；没有下载或保存。'] }
        if (draft !== current || !timely(current.at)) throw new Error()
        reset()
        op.phase = 'downloading'
        const at = now(),
          text = await adapters.download(
            current.request.url,
            current.request.proxyPort,
            op.abort.signal
          )
        if (op.cancelled)
          return { status: 'cancelled', warnings: ['订阅请求已取消；没有保存或启用。'] }
        if (now() < at || now() - at > SUBSCRIPTION_TIMEOUT) throw new Error()
        const inspection = inspectProfile(text),
          summary = inspection.summary
        if (
          inspection.structure !== 'passed' ||
          !summary ||
          !(summary.proxies || summary.groups || summary.proxyProviders)
        )
          return {
            status: 'rejected',
            warnings: ['订阅未通过Clash YAML／JSON结构检查，或没有节点／组／节点提供者；未保存。']
          }
        const report = {
          evidenceId: randomUUID(),
          name: current.report.name,
          sha256: profileHash(text),
          bytes: Buffer.byteLength(text),
          inspection
        }
        staged = { report, text, at: now() }
        expire()
        return {
          status: 'downloaded',
          profile: structuredClone(report),
          warnings: [
            '已下载并检查；尚未保存或启用。URL不持久保存，本阶段不定时更新、不加载提供者。'
          ]
        }
      } catch (error) {
        reset()
        return {
          status: op.cancelled ? 'cancelled' : 'failed',
          warnings: [
            op.cancelled
              ? '订阅请求已取消；没有保存或回退直连。'
              : error instanceof SubscriptionTransferError
                ? error.message
                : '订阅下载未确认；未保存、重试或回退直连。'
          ]
        }
      } finally {
        draft = undefined
        if (!staged) clearTimeout(timer)
        end()
      }
    },
    async save(raw: unknown): Promise<RelayProfileSaveResult> {
      const id = profileEvidence(raw),
        current = staged
      idle()
      const fresh = (): boolean =>
        !!current && staged === current && current.report.evidenceId === id && timely(current.at)
      if (!fresh() || !current) throw new Error('下载检查已失效，请重新下载。')
      const op = {
        id,
        phase: 'confirmingSave' as SubscriptionState['phase'],
        abort: new AbortController(),
        cancelled: false,
        writing: false
      }
      operation = op
      try {
        if (!(await adapters.confirmSave(structuredClone(current.report))) || op.cancelled)
          return { status: 'cancelled', warnings: ['已取消保存；没有启用配置。'] }
        if (!fresh()) throw new Error()
        reset()
        op.phase = 'saving'
        op.writing = true
        const profile = await adapters.save(current.report.name, current.text)
        return {
          status: 'saved',
          profile,
          warnings: [
            '已保存订阅快照独立副本，未启用或热载；URL未持久保存，不自动更新或加载提供者。'
          ]
        }
      } catch (error) {
        reset()
        return {
          status: error instanceof ProfileWriteUncertain ? 'uncertain' : 'failed',
          warnings: [
            error instanceof ProfileWriteUncertain
              ? '副本写入或同步未确认，请刷新配置列表核对；没有自动重试。'
              : '订阅副本保存未完成，请重新下载检查；没有自动重试或启用。'
          ]
        }
      } finally {
        end()
      }
    },
    cancel(raw: unknown): { status: 'requested' | 'discarded' | 'busy' | 'stale' } {
      const id = profileEvidence(raw)
      if (operation?.id === id) {
        if (operation.writing) return { status: 'busy' }
        operation.cancelled = true
        operation.abort.abort()
        return { status: 'requested' }
      }
      if (draft?.report.evidenceId === id || staged?.report.evidenceId === id) {
        reset()
        return { status: 'discarded' }
      }
      return { status: 'stale' }
    },
    requestClose(): Promise<void> {
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
}
