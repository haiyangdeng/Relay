import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { createWindowGeometryHost } from './window-geometry-host'
import {
  createWindowGeometryService,
  type RelayWindowState,
  type WindowDisplay
} from './window-state'

class FixtureWindow extends EventEmitter {
  normal = { x: -1800, y: 60, width: 1180, height: 800 }
  destroyed = false
  minimized = false
  maximized = false
  fullscreen = false
  isDestroyed = () => this.destroyed
  isMinimized = () => this.minimized
  isMaximized = () => this.maximized
  isFullScreen = () => this.fullscreen
  getNormalBounds = () => ({ ...this.normal })
  setMinimumSize = vi.fn((_width: number, _height: number) => {
    /* Geometry-only fixture. */
  })
  setBounds = vi.fn((value: typeof this.normal) => {
    this.normal = { ...value }
    this.emit('resize')
  })
}
class FixtureScreen extends EventEmitter {
  displays: WindowDisplay[] = [
    { id: 1, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
    { id: 2, workArea: { x: 0, y: 0, width: 1440, height: 900 } }
  ]
  getAllDisplays = () => structuredClone(this.displays)
  getPrimaryDisplay = () => this.displays[this.displays.length - 1]
}
function fixture() {
  const window = new FixtureWindow(),
    screen = new FixtureScreen(),
    store = {
      read: vi.fn(async () => ({
        saved: { version: 1 as const, normalBounds: window.getNormalBounds(), maximized: false },
        revision: 'initial',
        writable: true,
        warnings: []
      })),
      save: vi.fn(async (_value: RelayWindowState, _revision: string) => 'saved')
    },
    geometry = createWindowGeometryService({
      store,
      displays: screen.getAllDisplays,
      primaryId: () => screen.getPrimaryDisplay().id
    }),
    host = createWindowGeometryHost({ geometry, screen })
  return { window, screen, store, geometry, host }
}
describe('Window geometry Electron adapter uses injected surfaces only', () => {
  it('does not access a window or screen, register listeners or perform IO during construction', () => {
    const f = fixture()
    expect(f.store.read).not.toHaveBeenCalled()
    expect(f.store.save).not.toHaveBeenCalled()
    expect(f.screen.eventNames()).toEqual([])
    expect(f.window.eventNames()).toEqual([])
  })
  it('records normal bounds without frame-by-frame writes and flushes only when asked', async () => {
    const f = fixture()
    expect(await f.host.restore()).toMatchObject({ bounds: f.window.normal, maximized: false })
    f.host.attach(f.window)
    for (let i = 0; i < 100; ++i) {
      f.window.normal.x = -1800 + i
      f.window.emit('move')
      f.window.emit('resize')
    }
    expect(f.store.save).not.toHaveBeenCalled()
    await f.host.flush()
    expect(f.store.save).toHaveBeenCalledOnce()
    expect(f.store.save.mock.calls[0][0].normalBounds.x).toBe(-1701)
    f.host.dispose()
  })
  it('lets the root quit handler capture synchronously before deciding whether a flush is needed', async () => {
    const f = fixture()
    await f.host.restore()
    f.host.attach(f.window)
    f.window.normal.x = -1750
    f.host.capture()
    expect(f.host.state()).toMatchObject({ writable: true, dirty: true, pending: false })
    expect(f.store.save).not.toHaveBeenCalled()
    await f.host.flush()
    expect(f.store.save.mock.calls[0][0].normalBounds.x).toBe(-1750)
    expect(f.host.state().dirty).toBe(false)
    f.host.dispose()
  })
  it('fits a disconnected display onto a small screen and lowers minimum size before setting bounds', async () => {
    const f = fixture()
    await f.host.restore()
    f.host.attach(f.window)
    f.screen.displays = [{ id: 2, workArea: { x: 20, y: 30, width: 800, height: 600 } }]
    f.screen.emit('display-removed')
    expect(f.window.setMinimumSize).toHaveBeenCalledWith(800, 600)
    expect(f.window.normal).toEqual({ x: 20, y: 30, width: 800, height: 600 })
    expect(f.window.setBounds).toHaveBeenCalledOnce()
    expect(f.window.setMinimumSize.mock.invocationCallOrder[0]).toBeLessThan(
      f.window.setBounds.mock.invocationCallOrder[0]
    )
    expect(f.store.save).not.toHaveBeenCalled()
    f.host.dispose()
  })
  it.each(['maximized', 'minimized', 'fullscreen'] as const)(
    'does not force %s windows into normal state during a screen change',
    async (field) => {
      const f = fixture()
      await f.host.restore()
      f.host.attach(f.window)
      f.window[field] = true
      f.screen.displays = [f.screen.displays[1]]
      f.screen.emit('display-metrics-changed')
      expect(f.window.setBounds).not.toHaveBeenCalled()
      expect(f.window[field]).toBe(true)
      f.window[field] = false
      f.window.emit(
        field === 'maximized'
          ? 'unmaximize'
          : field === 'fullscreen'
            ? 'leave-full-screen'
            : 'restore'
      )
      expect(f.window.normal.x).toBe(0)
      expect(f.window.setBounds).toHaveBeenCalledOnce()
      f.host.dispose()
    }
  )
  it('retains normal bounds and the maximized flag for the next launch', async () => {
    const f = fixture()
    await f.host.restore()
    f.host.attach(f.window)
    f.window.maximized = true
    f.window.emit('maximize')
    await f.host.flush()
    expect(f.store.save.mock.calls[0][0]).toEqual({
      version: 1,
      normalBounds: f.window.normal,
      maximized: true
    })
    f.host.dispose()
  })
  it('removes only its own listeners and can flush the last captured state after the window is destroyed', async () => {
    const f = fixture(),
      other = vi.fn()
    f.screen.on('display-removed', other)
    f.window.on('move', other)
    await f.host.restore()
    f.host.attach(f.window)
    f.window.normal.x = -1700
    f.window.emit('close')
    f.window.destroyed = true
    f.window.emit('closed')
    expect(f.store.save).not.toHaveBeenCalled()
    expect(f.screen.listenerCount('display-removed')).toBe(1)
    expect(f.window.listenerCount('move')).toBe(1)
    await f.host.flush()
    expect(f.store.save.mock.calls[0][0].normalBounds.x).toBe(-1700)
    f.screen.emit('display-removed')
    expect(other).toHaveBeenCalledOnce()
    f.host.dispose()
  })
  it('keeps persistence disabled after a restore invalidates the current session', async () => {
    const f = fixture()
    await f.host.restore()
    f.host.attach(f.window)
    f.window.normal.x = -1700
    f.window.emit('move')
    f.host.invalidate()
    await f.host.flush()
    expect(f.store.save).not.toHaveBeenCalled()
    expect(f.host.state().writable).toBe(false)
    f.host.dispose()
  })
  it('allows flushing to finish when a window getter or asynchronous disk write fails', async () => {
    const f = fixture()
    await f.host.restore()
    f.host.attach(f.window)
    f.window.normal.x = -1700
    f.window.emit('move')
    vi.spyOn(f.window, 'getNormalBounds').mockImplementation(() => {
      throw new Error('closed')
    })
    f.store.save.mockRejectedValueOnce(new Error('disk error'))
    await expect(f.host.flush()).resolves.toBeUndefined()
    await expect(f.host.whenIdle()).resolves.toBeUndefined()
    expect(f.host.state()).toMatchObject({ writable: false, pending: false })
    expect(f.host.state().writable && (f.host.state().dirty || f.host.state().pending)).toBe(false)
    expect(f.host.state().warnings.length).toBeGreaterThan(0)
    f.host.dispose()
  })
})
