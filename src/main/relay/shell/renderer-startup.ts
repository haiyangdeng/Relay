import type { EventEmitter } from 'events'

type EventSource = Pick<EventEmitter, 'on' | 'removeListener'>
type StartupWindow = EventSource & {
  webContents: EventSource & { mainFrame: unknown }
  isDestroyed(): boolean
}
export type RendererFailure = 'load-failed' | 'preload-failed' | 'renderer-gone' | 'content-timeout'

// Adapt the upstream window.ts first-content handshake. A timeout is a failure,
// never a successful startup. Do not recreate a window holding Relay sessions.
export function watchRendererStartup(
  window: StartupWindow,
  callbacks: {
    ready(): void
    failed(reason: RendererFailure): void
    timeoutMs?: number
  }
): { firstContent: Promise<boolean>; loadFailed(): void; hasFailed(): boolean } {
  const contents = window.webContents
  let resolveContent!: (ready: boolean) => void
  const firstContent = new Promise<boolean>((resolve) => {
    resolveContent = resolve
  })
  let settled = false
  let closed = false
  let failed = false
  let documentReady = false
  let documentFailed = false
  let documentUnavailable = false
  let navigationCount = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  const settle = (ready: boolean): void => {
    if (settled) return
    settled = true
    resolveContent(ready)
  }
  const failure = (reason: RendererFailure): void => {
    if (closed || window.isDestroyed()) return
    if (reason !== 'content-timeout') documentUnavailable = true
    if (documentFailed) return
    failed = true
    documentFailed = true
    clearTimeout(timeout)
    settle(false)
    callbacks.failed(reason)
  }
  const ready = (event: { sender?: unknown; senderFrame?: unknown }, channel: string): void => {
    if (
      closed ||
      window.isDestroyed() ||
      documentReady ||
      documentUnavailable ||
      channel !== 'rendererFirstContentReady'
    )
      return
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame) return
    documentReady = true
    documentFailed = false
    clearTimeout(timeout)
    settle(true)
    callbacks.ready()
  }
  const armDeadline = (): void => {
    clearTimeout(timeout)
    timeout = setTimeout(() => failure('content-timeout'), callbacks.timeoutMs ?? 15_000)
  }
  const navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (closed || window.isDestroyed() || !details.isMainFrame || details.isSameDocument) return
    navigationCount++
    documentReady = false
    documentFailed = false
    documentUnavailable = false
    armDeadline()
  }
  // This callback belongs only to the initial loadFile request. Its delayed
  // rejection must not invalidate a replacement document after manual refresh.
  const loadFailed = (): void => {
    if (navigationCount <= 1) failure('load-failed')
  }
  const preloadFailed = (): void => failure('preload-failed')
  const rendererGone = (): void => failure('renderer-gone')
  const close = (): void => {
    closed = true
    clearTimeout(timeout)
    settle(false)
    contents.removeListener('ipc-message', ready)
    contents.removeListener('preload-error', preloadFailed)
    contents.removeListener('render-process-gone', rendererGone)
    contents.removeListener('did-start-navigation', navigation)
    window.removeListener('closed', close)
  }
  armDeadline()
  contents.on('ipc-message', ready)
  contents.on('preload-error', preloadFailed)
  contents.on('render-process-gone', rendererGone)
  contents.on('did-start-navigation', navigation)
  window.on('closed', close)
  return { firstContent, loadFailed, hasFailed: () => failed }
}
