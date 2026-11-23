import { createHash } from 'node:crypto'
import { SimplePrivateDocumentFile, type SimpleFileRecord } from '../simple/store'
import type { RelayStateContext } from '../context'
import {
  dedicatedListenersCompatible,
  type DedicatedListenerPlan
} from '../../../shared/relay/dedicated-listeners'
import {
  defaultLocalProxyPlan,
  localProxyPlan,
  localProxyPlanSaveRequest,
  type LocalProxyPlan,
  type LocalProxyPlanRecord
} from '../../../shared/relay/local-proxy-plan'
import { canonicalDedicatedPinnedNode, dedicatedPinnedNodeHash } from './dedicated-pinned-node'

interface PrivatePlan {
  version: 1 | 2
  document: LocalProxyPlan
  pinnedNode?: {
    sourceProfileId: string
    sha256: string
    node: Record<string, unknown>
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const publicRevision = (document: LocalProxyPlan): string =>
  createHash('sha256')
    .update(JSON.stringify(document, null, 2) + '\n')
    .digest('hex')
function privatePlan(raw: unknown): PrivatePlan {
  if (!object(raw) || raw.version !== 2) return { version: 1, document: localProxyPlan(raw) }
  if (
    !['document,version', 'document,pinnedNode,version'].includes(Object.keys(raw).sort().join(','))
  )
    throw new Error('Relay 启动设置私有记录无效。')
  const document = localProxyPlan(raw.document)
  if (raw.pinnedNode === undefined) return { version: 2, document }
  const pin = raw.pinnedNode
  if (
    !document.dedicated ||
    !object(pin) ||
    Object.keys(pin).sort().join(',') !== 'node,sha256,sourceProfileId' ||
    typeof pin.sourceProfileId !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(pin.sourceProfileId)
  )
    throw new Error('AI 固定节点记录无效。')
  const node = canonicalDedicatedPinnedNode(pin.node, document.dedicated.route)
  if (pin.sha256 !== dedicatedPinnedNodeHash(node)) throw new Error('AI 固定节点摘要不一致。')
  return {
    version: 2,
    document,
    pinnedNode: { sourceProfileId: pin.sourceProfileId, sha256: pin.sha256, node }
  }
}
function publicRecord(record: SimpleFileRecord<PrivatePlan>): LocalProxyPlanRecord {
  return {
    document: structuredClone(record.value.document),
    revision: record.exists ? publicRevision(record.value.document) : '',
    exists: record.exists
  }
}

export class LocalProxyPlanStore {
  readonly path: string
  private readonly file: SimplePrivateDocumentFile<PrivatePlan>
  private pending = false
  private reading: Promise<LocalProxyPlanRecord> | undefined
  private readonly waiters: (() => void)[] = []
  constructor(context: RelayStateContext) {
    this.file = new SimplePrivateDocumentFile(
      context,
      'local-proxy-plan.json',
      privatePlan,
      () => ({ version: 2, document: defaultLocalProxyPlan() })
    )
    this.path = this.file.path
  }
  isBusy(): boolean {
    return this.pending
  }
  isReading(): boolean {
    return this.reading !== undefined
  }
  whenIdle(): Promise<void> {
    return this.pending ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve()
  }
  private async perform<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending) throw new Error('Relay 启动设置操作尚未结束。')
    this.pending = true
    try {
      return await operation()
    } finally {
      this.pending = false
      this.waiters.splice(0).forEach((resolve) => resolve())
    }
  }
  async read(assertCurrent: () => void = () => {}): Promise<LocalProxyPlanRecord> {
    assertCurrent()
    if (this.pending && !this.reading) throw new Error('Relay 启动设置操作尚未结束。')
    // Initial renderer reads and profile startup may overlap. Share only the
    // read, preserving each caller's context checks; never wait through a save.
    const operation = this.reading ?? this.perform(async () => publicRecord(await this.file.read()))
    this.reading = operation
    try {
      const record = await operation
      assertCurrent()
      return structuredClone(record)
    } finally {
      if (this.reading === operation) this.reading = undefined
    }
  }
  save(
    raw: unknown,
    assertCurrent: () => void = () => {},
    recheck?: () => Promise<void>
  ): Promise<LocalProxyPlanRecord> {
    const request = localProxyPlanSaveRequest(raw)
    return this.perform(async () => {
      assertCurrent()
      await recheck?.()
      const previous = await this.file.read()
      if (publicRecord(previous).revision !== request.expectedRevision)
        throw new Error('Relay 启动设置已变化，请重新读取。')
      const pin = previous.value.pinnedNode
      return publicRecord(
        await this.file.change(
          previous.revision,
          () => ({
            version: 2,
            document: request.document,
            ...(pin &&
            previous.value.document.dedicated?.route === request.document.dedicated?.route
              ? { pinnedNode: pin }
              : {})
          }),
          assertCurrent,
          recheck
        )
      )
    })
  }

  async resolvePinnedNode(
    plan: DedicatedListenerPlan,
    sourceProfileId: string,
    capture: () => unknown,
    recheck?: () => Promise<void>
  ): Promise<{ node: Record<string, unknown>; revision: string }> {
    // A dashboard read cannot invalidate a pinned listener during handoff.
    // Stay exclusive with writers and re-read the private revision under that gate.
    while (this.reading) await this.reading
    return this.perform(async () => {
      const previous = await this.file.read()
      if (
        !previous.exists ||
        !dedicatedListenersCompatible(previous.value.document.dedicated, plan)
      )
        throw new Error('AI 固定节点与已保存的启动设置不一致。')
      if (previous.value.pinnedNode)
        return {
          node: structuredClone(previous.value.pinnedNode.node),
          revision: previous.revision
        }
      const node = canonicalDedicatedPinnedNode(capture(), plan.route)
      const next = privatePlan({
        version: 2,
        document: previous.value.document,
        pinnedNode: {
          sourceProfileId,
          node,
          sha256: dedicatedPinnedNodeHash(node)
        }
      })
      await recheck?.()
      const saved = await this.file.change(
        previous.revision,
        () => next,
        () => {},
        recheck
      )
      if (!saved.value.pinnedNode) throw new Error('AI 固定节点保存未确认。')
      return { node: structuredClone(saved.value.pinnedNode.node), revision: saved.revision }
    })
  }

  async preservePinnedNode(
    capture: (
      document: LocalProxyPlan
    ) => Promise<{ sourceProfileId: string; node: unknown } | undefined>,
    assertCurrent: () => void = () => {},
    recheck?: () => Promise<void>
  ): Promise<void> {
    if (this.reading) await this.reading
    assertCurrent()
    const observed = await this.file.read()
    assertCurrent()
    if (!observed.value.document.dedicated || observed.value.pinnedNode) return
    return this.perform(async () => {
      assertCurrent()
      const previous = await this.file.read()
      const plan = previous.value.document
      if (!plan.dedicated || previous.value.pinnedNode) return
      const source = await capture(structuredClone(plan))
      assertCurrent()
      if (!source) {
        // A new explicit plan may precede the first profile choice. A legacy
        // route already represents an AI exit and must not bind a fallback.
        if (previous.value.version === 1)
          throw new Error('原 AI 固定节点所属配置缺失；请先恢复原配置或重新设置专用节点。')
        return
      }
      const node = canonicalDedicatedPinnedNode(source.node, plan.dedicated.route)
      const next = privatePlan({
        version: 2,
        document: plan,
        pinnedNode: {
          sourceProfileId: source.sourceProfileId,
          node,
          sha256: dedicatedPinnedNodeHash(node)
        }
      })
      await this.file.change(previous.revision, () => next, assertCurrent, recheck)
    })
  }
}
