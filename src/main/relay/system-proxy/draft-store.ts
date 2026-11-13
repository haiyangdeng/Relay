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
  read(assertCurrent: () => void = () => {}): Promise<SystemProxyDraftRecord> {
    return this.perform(async () => {
      assertCurrent()
      const record = await this.file.read()
      assertCurrent()
      return record
    })
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
