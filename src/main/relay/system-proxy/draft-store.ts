import { SimplePrivateDocumentFile, type SimpleFileRecord } from '../simple/store'
import type { RelayStateContext } from '../context'
import {
  defaultSystemProxyDraft,
  systemProxyDraft,
  systemProxyDraftSaveRequest,
  type SystemProxyDraft,
  type SystemProxyDraftRecord
} from '../../../shared/relay/system-proxy-draft'

export class SystemProxyDraftStore {
  readonly path: string
  private readonly file: SimplePrivateDocumentFile<SystemProxyDraft>
  private pending = false
  private reading?: Promise<SystemProxyDraftRecord>
  private readonly waiters: (() => void)[] = []
  constructor(context: RelayStateContext) {
    this.file = new SimplePrivateDocumentFile(
      context,
      'system-proxy-defaults.json',
      systemProxyDraft,
      defaultSystemProxyDraft
    )
    this.path = this.file.path
  }
  isBusy(): boolean {
    return this.pending
  }
  isReading(): boolean {
    return !!this.reading
  }
  whenIdle(): Promise<void> {
    return this.pending ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve()
  }
  private async perform(
    operation: () => Promise<SimpleFileRecord<SystemProxyDraft>>
  ): Promise<SystemProxyDraftRecord> {
    if (this.pending) throw new Error('系统代理默认设置操作尚未结束。')
    this.pending = true
    try {
      const record = await operation()
      return { document: record.value, revision: record.revision, exists: record.exists }
    } finally {
      this.pending = false
      this.waiters.splice(0).forEach((resolve) => resolve())
    }
  }
  async read(assertCurrent: () => void = () => {}): Promise<SystemProxyDraftRecord> {
    assertCurrent()
    if (this.pending && !this.reading) throw new Error('系统代理默认设置操作尚未结束。')
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
  ): Promise<SystemProxyDraftRecord> {
    const request = systemProxyDraftSaveRequest(raw)
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
