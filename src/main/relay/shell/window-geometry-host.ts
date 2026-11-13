import type { RelayBackupStore } from '../backup/store'
import type { createWindowGeometryService, WindowBounds, WindowDisplay } from './window-state'

type WindowEvent =
  | 'move'
  | 'resize'
  | 'maximize'
  | 'unmaximize'
  | 'restore'
  | 'leave-full-screen'
  | 'close'
  | 'closed'
type DisplayEvent = 'display-added' | 'display-removed' | 'display-metrics-changed'
export interface GeometryWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isMaximized(): boolean
  isFullScreen(): boolean
  getNormalBounds(): WindowBounds
  setMinimumSize(width: number, height: number): void
  setBounds(bounds: WindowBounds): void
  on(event: WindowEvent, listener: () => void): unknown
  removeListener(event: WindowEvent, listener: () => void): unknown
}
export interface GeometryScreen {
  getAllDisplays(): WindowDisplay[]
  getPrimaryDisplay(): WindowDisplay
  on(event: DisplayEvent, listener: () => void): unknown
  removeListener(event: DisplayEvent, listener: () => void): unknown
}

// This adapter owns only listeners. It never creates, shows, closes or quits a window.
export function createWindowGeometryHost(adapters: {
  geometry: ReturnType<typeof createWindowGeometryService>
  screen: GeometryScreen
}) {
  let window: GeometryWindow | undefined,
    reconciling = false
  const warnings = new Set<string>(),
    listeners: { event: WindowEvent; listener: () => void }[] = [],
    displayEvents: DisplayEvent[] = ['display-added', 'display-removed', 'display-metrics-changed']
  const record = (): void => {
    if (!window || reconciling) return
    try {
      if (window.isDestroyed()) return
      adapters.geometry.capture({
        normalBounds: window.getNormalBounds(),
        maximized: window.isMaximized(),
        minimized: window.isMinimized(),
        fullscreen: window.isFullScreen()
      })
    } catch {
      warnings.add('窗口已变化，保留上次有效位置。')
    }
  }
  const reconcile = (): void => {
    if (!window || reconciling) return
    try {
      if (window.isDestroyed()) return
      record()
      reconciling = true
      const resolved = adapters.geometry.resolve()
      window.setMinimumSize(resolved.minWidth, resolved.minHeight)
      if (
        !window.isMaximized() &&
        !window.isMinimized() &&
        !window.isFullScreen() &&
        JSON.stringify(window.getNormalBounds()) !== JSON.stringify(resolved.bounds)
      )
        window.setBounds(resolved.bounds)
    } catch {
      warnings.add('显示器变化后的窗口位置调整未确认，保留有效记录。')
    } finally {
      reconciling = false
    }
  }
  const dispose = (): void => {
    for (const { event, listener } of listeners.splice(0)) {
      try {
        window?.removeListener(event, listener)
      } catch {
        /* A destroyed window may reject cleanup. */
      }
    }
    for (const event of displayEvents) {
      try {
        adapters.screen.removeListener(event, reconcile)
      } catch {
        /* Best-effort owned listener cleanup. */
      }
    }
    window = undefined
  }
  return {
    restore: adapters.geometry.restore,
    invalidate: adapters.geometry.invalidate,
    capture: record,
    state: () => ({
      ...adapters.geometry.state(),
      warnings: [...new Set([...adapters.geometry.state().warnings, ...warnings])]
    }),
    attach(target: GeometryWindow): void {
      dispose()
      window = target
      try {
        for (const event of ['move', 'resize', 'maximize', 'close'] as const) {
          target.on(event, record)
          listeners.push({ event, listener: record })
        }
        for (const event of ['unmaximize', 'restore', 'leave-full-screen'] as const) {
          target.on(event, reconcile)
          listeners.push({ event, listener: reconcile })
        }
        target.on('closed', dispose)
        listeners.push({ event: 'closed', listener: dispose })
        for (const event of displayEvents) adapters.screen.on(event, reconcile)
      } catch {
        warnings.add('窗口位置监听未接通；保留可用窗口并允许安全退出。')
        dispose()
      }
    },
    reconcile,
    async flush(): Promise<void> {
      record()
      await adapters.geometry.save()
    },
    whenIdle: adapters.geometry.whenIdle,
    dispose
  }
}

type ExitGeometryHost = Pick<ReturnType<typeof createWindowGeometryHost>, 'flush' | 'invalidate'>

export async function flushWindowGeometryForExit(
  recovery: Pick<RelayBackupStore, 'unresolved'>,
  ...windows: ExitGeometryHost[]
): Promise<void> {
  // Geometry is part of the backup snapshot. Even creating an empty UI root
  // while an interrupted transaction owns it would prevent a safe restart.
  const clear = await recovery.unresolved().then(
    (records) => records.length === 0,
    () => false
  )
  for (const window of windows) {
    if (clear) await window.flush()
    else window.invalidate()
  }
}
