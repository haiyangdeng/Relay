import { SimplePrivateDocumentFile, type SimpleFileRecord } from '../simple/store'
import type { RelayStateContext } from '../context'
import {
  defaultLocalProxyPlan,
  localProxyPlan,
  localProxyPlanSaveRequest,
  type LocalProxyPlan,
  type LocalProxyPlanRecord
} from '../../../shared/relay/local-proxy-plan'

export class LocalProxyPlanStore {
  readonly path: string
  private readonly file: SimplePrivateDocumentFile<LocalProxyPlan>
  private pending = false
  private reading: Promise<LocalProxyPlanRecord> | undefined
  private readonly waiters: (() => void)[] = []
  constructor(context: RelayStateContext) {
    this.file = new SimplePrivateDocumentFile(
      context,
      'local-proxy-plan.json',
      localProxyPlan,
      defaultLocalProxyPlan
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
  private async perform(
    operation: () => Promise<SimpleFileRecord<LocalProxyPlan>>
  ): Promise<LocalProxyPlanRecord> {
    if (this.pending) throw new Error('Relay 启动设置操作尚未结束。')
    this.pending = true
    try {
      const record = await operation()
      return { document: record.value, revision: record.revision, exists: record.exists }
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
    const operation = this.reading ?? this.perform(() => this.file.read())
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
      return this.file.change(
        request.expectedRevision,
        () => request.document,
        assertCurrent,
        recheck
      )
    })
  }
}
