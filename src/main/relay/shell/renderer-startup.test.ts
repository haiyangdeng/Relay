import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchRendererStartup } from './renderer-startup'

function fixture() {
  const webContents = Object.assign(new EventEmitter(), { mainFrame: {} })
  const window = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false })
  const ready = vi.fn()
  const failed = vi.fn()
  const startup = watchRendererStartup(window, { ready, failed, timeoutMs: 100 })
  const signal = (): void => {
    webContents.emit(
      'ipc-message',
      { sender: webContents, senderFrame: webContents.mainFrame },
      'rendererFirstContentReady'
    )
  }
  return { window, webContents, ready, failed, startup, signal }
}

afterEach(() => vi.useRealTimers())

describe('renderer first-content admission', () => {
  it('does not confuse a loaded document or foreign frame with a mounted interface', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.webContents.emit('did-finish-load')
    f.webContents.emit(
      'ipc-message',
      { sender: f.webContents, senderFrame: {} },
      'rendererFirstContentReady'
    )
    f.webContents.emit(
      'ipc-message',
      { sender: {}, senderFrame: f.webContents.mainFrame },
      'rendererFirstContentReady'
    )
    expect(f.ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(await f.startup.firstContent).toBe(false)
    expect(f.failed).toHaveBeenCalledExactlyOnceWith('content-timeout')
    f.signal()
    expect(f.ready).toHaveBeenCalledOnce()
    // A recovered page does not rewrite the failed first-start outcome.
    expect(await f.startup.firstContent).toBe(false)
    expect(f.startup.hasFailed()).toBe(true)
  })

  it('accepts first-content once and cancels the startup deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.signal()
    f.signal()
    expect(await f.startup.firstContent).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.ready).toHaveBeenCalledOnce()
    expect(f.failed).not.toHaveBeenCalled()
  })

  it('dismisses a timeout notice only on a verified ready signal and ignores a stale frame', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const dismiss = vi.fn()
    f.failed.mockReturnValue(dismiss)
    await vi.advanceTimersByTimeAsync(100)
    f.webContents.emit(
      'ipc-message',
      { sender: f.webContents, senderFrame: {} },
      'rendererFirstContentReady'
    )
    expect(dismiss).not.toHaveBeenCalled()
    f.signal()
    f.signal()
    f.window.emit('closed')
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it.each(['load-failed', 'preload-failed', 'renderer-gone'] as const)(
    'settles %s without reload, retry, window destruction or session cleanup',
    async (reason) => {
      vi.useFakeTimers()
      const f = fixture()
      if (reason === 'load-failed') f.startup.loadFailed()
      else f.webContents.emit(reason === 'preload-failed' ? 'preload-error' : 'render-process-gone')
      f.startup.loadFailed()
      await vi.advanceTimersByTimeAsync(100)
      expect(await f.startup.firstContent).toBe(false)
      expect(f.failed).toHaveBeenCalledExactlyOnceWith(reason)
      expect(f.window.isDestroyed()).toBe(false)
    }
  )

  it('reports a later renderer crash while retaining the same host window', async () => {
    const f = fixture()
    f.signal()
    await f.startup.firstContent
    f.webContents.emit('render-process-gone')
    expect(f.failed).toHaveBeenCalledExactlyOnceWith('renderer-gone')
    expect(f.window.isDestroyed()).toBe(false)
  })

  it('detaches on close, resolves pending startup and never reports a late failure', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.window.emit('closed')
    f.signal()
    f.startup.loadFailed()
    await vi.advanceTimersByTimeAsync(100)
    expect(await f.startup.firstContent).toBe(false)
    expect(f.failed).not.toHaveBeenCalled()
    expect(f.webContents.eventNames()).toEqual([])
  })

  it('monitors a new main document after success but ignores hash and child-frame navigation', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.signal()
    f.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    f.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    await vi.advanceTimersByTimeAsync(100)
    expect(f.failed).not.toHaveBeenCalled()
    f.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await vi.advanceTimersByTimeAsync(100)
    expect(f.failed).toHaveBeenCalledExactlyOnceWith('content-timeout')
    f.signal()
    f.signal()
    expect(f.ready).toHaveBeenCalledTimes(2)
    expect(await f.startup.firstContent).toBe(true)
    f.window.emit('closed')
    expect(f.webContents.eventNames()).toEqual([])
  })

  it('does not accept a ready after preload failure until a new document starts', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.webContents.emit('preload-error')
    f.signal()
    expect(f.ready).not.toHaveBeenCalled()
    f.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    f.signal()
    expect(f.ready).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.failed).toHaveBeenCalledTimes(1)
  })

  it('blocks a late ready if a fatal failure follows the already reported timeout', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const dismiss = vi.fn()
    f.failed.mockReturnValue(dismiss)
    await vi.advanceTimersByTimeAsync(100)
    f.webContents.emit('preload-error')
    f.signal()
    expect(f.ready).not.toHaveBeenCalled()
    expect(dismiss).not.toHaveBeenCalled()
    expect(f.failed).toHaveBeenCalledExactlyOnceWith('content-timeout')
    f.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    f.signal()
    expect(f.ready).toHaveBeenCalledOnce()
    expect(dismiss).toHaveBeenCalledOnce()
    expect(await f.startup.firstContent).toBe(false)
  })

  it('ignores a stale initial load rejection after a replacement document starts', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const mainDocument = { isMainFrame: true, isSameDocument: false }
    f.webContents.emit('did-start-navigation', mainDocument)
    f.webContents.emit('did-start-navigation', mainDocument)
    f.startup.loadFailed()
    f.signal()
    expect(f.ready).toHaveBeenCalledOnce()
    expect(f.failed).not.toHaveBeenCalled()
    expect(await f.startup.firstContent).toBe(true)
  })
})
