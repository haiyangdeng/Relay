import { randomUUID } from 'crypto'
import { stringify } from 'yaml'
import {
  resourceDescriptor,
  type ResourcePreparation,
  type ResourceState,
  type ResourceOperationResult,
  type ResourceCheckResult,
  type RuleResourcePreview
} from '../../../shared/relay/resources'
import { profileEvidence, stripProfileControls } from '../../../shared/relay/profiles'
import { profileSelection } from '../../../shared/relay/runtime'
import { subscriptionRequest } from '../../../shared/relay/subscription'
import { providerHeaders } from '../subscriptions/transfer'
import { ResourceStore } from './store'
import { resourceHash, RESOURCE_BYTE_LIMIT } from './source'
import type { ResourceValidationJob } from './check-definition'
import { readRuleResourcePreview, type RulePreviewConverter } from './preview'

type Source =
  | { kind: 'file' }
  | { kind: 'http'; url: string; proxyPort: number; headers: Record<string, string> }
  | { kind: 'inline'; bytes: Buffer }
type Proof = { report: ResourcePreparation; source: Source; at: number }
function request(raw: unknown, at: number): Proof {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'descriptor,expectedSHA256,source'
  )
    throw new Error('资源请求字段无效。')
  const input = raw as Record<string, unknown>,
    descriptor = resourceDescriptor(input.descriptor)
  if (
    typeof input.expectedSHA256 !== 'string' ||
    (input.expectedSHA256 !== '' && !/^[a-f0-9]{64}$/u.test(input.expectedSHA256))
  )
    throw new Error('期望摘要必须为空或64位小写SHA256。')
  if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source))
    throw new Error('资源来源无效。')
  const value = input.source as Record<string, unknown>,
    fields = Object.keys(value).sort().join(',')
  let source: Source
  if (value.kind === 'file' && fields === 'kind') source = { kind: 'file' }
  else if (value.kind === 'http' && fields === 'headers,kind,proxyPort,url') {
    const r = subscriptionRequest({ name: 'Resource', url: value.url, proxyPort: value.proxyPort })
    if (
      !value.headers ||
      typeof value.headers !== 'object' ||
      Array.isArray(value.headers) ||
      Object.entries(value.headers).some(([, v]) => typeof v !== 'string')
    )
      throw new Error('资源私有请求头无效。')
    source = {
      kind: 'http',
      url: r.url,
      proxyPort: r.proxyPort,
      headers: providerHeaders(
        Object.fromEntries(Object.entries(value.headers).map(([key, v]) => [key, [v]]))
      )
    }
  } else if (
    value.kind === 'inline' &&
    fields === 'kind,payload' &&
    descriptor.kind === 'rule-yaml'
  ) {
    if (
      !Array.isArray(value.payload) ||
      !value.payload.length ||
      value.payload.length > 200000 ||
      value.payload.some(
        (v) =>
          typeof v !== 'string' || !v.trim() || v.length > 4096 || stripProfileControls(v) !== v
      )
    )
      throw new Error('内联规则列表无效。')
    const bytes = Buffer.from(stringify({ payload: value.payload }, { lineWidth: 0 }))
    if (bytes.length > 8 * 1024 * 1024) throw new Error('内联规则超过8MiB。')
    source = { kind: 'inline', bytes }
  } else throw new Error('仅接受文件选择、指定代理HTTP或YAML内联规则。')
  const report: ResourcePreparation = {
    evidenceId: randomUUID(),
    descriptor,
    source: {
      kind: source.kind,
      ...(source.kind === 'http'
        ? { origin: new URL(source.url).origin, proxyPort: source.proxyPort }
        : {})
    },
    expectedSHA256: input.expectedSHA256
  }
  return { report, source, at }
}
export function createResourceService(adapters: {
  cache: Pick<ResourceStore, 'save' | 'read' | 'list'>
  pick(): Promise<{ bytes: Buffer; readAgain(): Promise<Buffer> } | undefined>
  download(
    url: string,
    port: number,
    signal: AbortSignal,
    headers: Record<string, string>
  ): Promise<Buffer>
  confirm(report: ResourcePreparation): Promise<boolean>
  check(job: ResourceValidationJob): Promise<ResourceCheckResult>
  convertRuleMRS?: RulePreviewConverter
  now?(): number
}) {
  let proof: Proof | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    closing: Promise<void> | undefined,
    operation:
      | {
          id: string
          phase: ResourceState['phase']
          abort: AbortController
          cancelled: boolean
          writing: boolean
        }
      | undefined
  const now = adapters.now ?? Date.now,
    waiters: (() => void)[] = []
  const fresh = (at: number): boolean => now() >= at && now() - at <= 60000,
    reset = (): void => {
      clearTimeout(timer)
      proof = undefined
    },
    idle = (): void => {
      if (operation || closing) throw new Error('资源操作或退出尚未结束。')
    },
    begin = (id: string, phase: ResourceState['phase']) => {
      idle()
      operation = { id, phase, abort: new AbortController(), cancelled: false, writing: false }
      return operation
    },
    end = (): void => {
      operation = undefined
      waiters.splice(0).forEach((resolve) => resolve())
    },
    whenIdle = (): Promise<void> =>
      operation ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  return {
    isBusy: (): boolean => !!operation || !!closing,
    whenIdle,
    state(): ResourceState {
      return {
        phase: operation?.phase ?? 'idle',
        pending: !!operation || !!closing,
        operationId: operation?.id,
        preparedId: proof && fresh(proof.at) ? proof.report.evidenceId : undefined
      }
    },
    clear(): void {
      reset()
      if (operation && !operation.writing) {
        operation.cancelled = true
        operation.abort.abort()
      }
    },
    async list() {
      const op = begin(randomUUID(), 'reading')
      try {
        const result = await adapters.cache.list()
        if (op.cancelled) throw new Error()
        return result
      } catch {
        throw new Error('资源列表未确认，未获取或修改。')
      } finally {
        end()
      }
    },
    async preview(raw: unknown, assertScope: () => void = () => {}): Promise<RuleResourcePreview> {
      const selection = profileSelection(raw),
        op = begin(randomUUID(), 'reading')
      const live = (): void => {
        const current = (): void => {
          if (operation !== op || op.cancelled || op.abort.signal.aborted) throw new Error()
        }
        current()
        assertScope()
        current()
      }
      try {
        const result = await readRuleResourcePreview(
          adapters.cache,
          selection,
          live,
          adapters.convertRuleMRS
        )
        live()
        return result
      } catch {
        throw new Error(
          '规则缓存预览未确认、已取消或超出上限（文本512KiB、MRS输入2MiB）；原缓存保留。'
        )
      } finally {
        end()
      }
    },
    prepare(raw: unknown): ResourcePreparation {
      idle()
      const p = request(raw, now())
      reset()
      proof = p
      timer = setTimeout(reset, 60000)
      timer.unref?.()
      return structuredClone(p.report)
    },
    async acquire(raw: unknown): Promise<ResourceOperationResult> {
      const id = profileEvidence(raw),
        p = proof
      idle()
      if (!p || p.report.evidenceId !== id || !fresh(p.at)) {
        reset()
        throw new Error('资源准备已失效。')
      }
      const op = begin(id, 'confirming')
      try {
        if (!(await adapters.confirm(structuredClone(p.report))) || op.cancelled)
          return { status: 'cancelled', warnings: ['已取消，未获取或缓存资源。'] }
        if (proof !== p || !fresh(p.at)) throw new Error()
        reset()
        op.phase = 'acquiring'
        let bytes: Buffer
        if (p.source.kind === 'inline') bytes = p.source.bytes
        else if (p.source.kind === 'http')
          bytes = await adapters.download(
            p.source.url,
            p.source.proxyPort,
            op.abort.signal,
            p.source.headers
          )
        else {
          const selected = await adapters.pick()
          if (!selected || op.cancelled)
            return { status: 'cancelled', warnings: ['已取消文件选择。'] }
          bytes = selected.bytes
          if (resourceHash(await selected.readAgain()) !== resourceHash(bytes)) throw new Error()
        }
        if (op.cancelled) return { status: 'cancelled', warnings: ['已取消获取，未缓存。'] }
        if (
          !Buffer.isBuffer(bytes) ||
          !bytes.length ||
          bytes.length > RESOURCE_BYTE_LIMIT ||
          (p.report.expectedSHA256 && resourceHash(bytes) !== p.report.expectedSHA256)
        )
          throw new Error()
        op.phase = 'saving'
        op.writing = true
        const resource = await adapters.cache.save(p.report.descriptor, bytes)
        const verified = await adapters.cache.read({ id: resource.id, sha256: resource.sha256 })
        if (JSON.stringify(verified.info) !== JSON.stringify(resource)) throw new Error()
        return {
          status: 'cached',
          resource,
          warnings: [
            '已私有缓存并复核摘要；格式／条目还需固定核心检查。未启用、定时更新或修改网络。'
          ]
        }
      } catch {
        return {
          status: op.cancelled && !op.writing ? 'cancelled' : op.writing ? 'uncertain' : 'failed',
          warnings: ['资源获取、期望摘要或缓存写入未确认；既有资源保留，不重试或回退直连。']
        }
      } finally {
        reset()
        end()
      }
    },
    async check(raw: unknown): Promise<ResourceOperationResult> {
      const selection = profileSelection(raw),
        op = begin(randomUUID(), 'checking')
      reset()
      try {
        const stored = await adapters.cache.read(selection)
        if (op.cancelled) return { status: 'cancelled', warnings: ['已取消检查。'] }
        const d = stored.info,
          descriptor = resourceDescriptor({
            name: d.name,
            kind: d.kind,
            behavior: d.behavior,
            selector: d.selector
          }),
          result = await adapters.check({ descriptor, bytes: stored.bytes, sha256: d.sha256 })
        if (result.resourceSHA256 !== d.sha256) throw new Error()
        if (result.status === 'uncertain')
          return {
            status: 'uncertain',
            resource: stored.info,
            check: result,
            warnings: result.warnings
          }
        if ((await adapters.cache.read(selection)).revision !== stored.revision) throw new Error()
        if (op.cancelled)
          return { status: 'cancelled', warnings: ['本次隔离检查已结束并清理，结果已丢弃。'] }
        return {
          status: 'checked',
          resource: stored.info,
          check: result,
          warnings: result.warnings
        }
      } catch {
        return {
          status: 'failed',
          warnings: ['资源摘要／格式检查或清理未完整确认；缓存保留，不启用或下载依赖。']
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
      if (proof?.report.evidenceId === id) {
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
