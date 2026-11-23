import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow, nativeImage } from 'electron'
import {
  defaultShellSettings,
  shellShortcutActions,
  type RelayShellActionRequest,
  type RelayShellRecord,
  type RelayShellState
} from '../../../shared/relay/shell'
import {
  relayFloatingArgument,
  relayFloatingTrafficChannel,
  type RelayFloatingTrafficSample
} from '../../../shared/relay/floating-traffic'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import { createElectronShellHost } from './electron-host'
import { createRelayShellService } from './service'
import { createTrayWorkflows } from './tray-workflows'

const fixture = vi.hoisted(() => {
  const loadBarriers: Promise<void>[] = []
  const makeWindow = (options: Record<string, unknown>) => {
    let visible = options.show !== false,
      destroyed = false
    const events = new Map<string, (...args: unknown[]) => void>()
    const webEvents = new Map<string, (...args: unknown[]) => void>()
    const window = {
      options,
      events,
      webEvents,
      isDestroyed: vi.fn(() => destroyed),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => visible),
      restore: vi.fn(),
      focus: vi.fn(),
      show: vi.fn(() => {
        visible = true
        events.get('show')?.()
      }),
      hide: vi.fn(() => {
        visible = false
        events.get('hide')?.()
      }),
      destroy: vi.fn(() => {
        destroyed = true
        events.get('closed')?.()
      }),
      setAlwaysOnTop: vi.fn(),
      on: vi.fn((name: string, callback: (...args: unknown[]) => void) =>
        events.set(name, callback)
      ),
      loadURL: vi.fn(async (_url: string) => {}),
      loadFile: vi.fn(async (_path: string, _options?: unknown) => {
        await loadBarriers.shift()
      }),
      webContents: {
        mainFrame: {},
        isDestroyed: vi.fn(() => destroyed),
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((name: string, callback: (...args: unknown[]) => void) =>
          webEvents.set(name, callback)
        )
      }
    }
    return window
  }
  const windows: ReturnType<typeof makeWindow>[] = []
  const makeTray = () => {
    let destroyed = false
    const events = new Map<string, () => void>()
    return {
      events,
      popUpContextMenu: vi.fn(),
      isDestroyed: vi.fn(() => destroyed),
      destroy: vi.fn(() => {
        destroyed = true
      }),
      setImage: vi.fn(),
      setTitle: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn((name: string, callback: () => void) => {
        events.set(name, callback)
      })
    }
  }
  const trays: ReturnType<typeof makeTray>[] = []
  const icon = {
    isEmpty: vi.fn(() => false),
    resize: vi.fn(),
    isTemplateImage: vi.fn(() => true),
    setTemplateImage: vi.fn(),
    addRepresentation: vi.fn(),
    toPNG: vi.fn(() => Buffer.from('png')),
    toDataURL: vi.fn(() => 'data:image/png;base64,cA==')
  }
  const paintedIcon = { isEmpty: vi.fn(() => false), setTemplateImage: vi.fn() }
  icon.resize.mockReturnValue(icon)
  return {
    makeWindow,
    windows,
    loadBarriers,
    makeTray,
    trays,
    icon,
    paintedIcon,
    dock: {
      isVisible: vi.fn(() => true),
      show: vi.fn(async (): Promise<void> => undefined),
      hide: vi.fn()
    },
    theme: {
      themeSource: 'system',
      on: vi.fn((_name: string, _callback: () => void) => {}),
      removeListener: vi.fn((_name: string, _callback: () => void) => {})
    },
    register: vi.fn((_accelerator: string, _run: () => void) => true),
    unregister: vi.fn(),
    menu: vi.fn(
      (
        template: {
          label: string
          click: () => void
          checked?: boolean
          enabled?: boolean
          submenu?: {
            label: string
            click: () => void
            checked?: boolean
            submenu?: { label: string; click: () => void; checked?: boolean }[]
          }[]
        }[]
      ) => Object.assign(template, { popup: vi.fn() })
    )
  }
})

vi.mock('electron', () => ({
  app: { dock: fixture.dock },
  BrowserWindow: vi.fn(function (options: Record<string, unknown>) {
    const window = fixture.makeWindow(options)
    fixture.windows.push(window)
    return window
  }),
  Tray: vi.fn(function () {
    const tray = fixture.makeTray()
    fixture.trays.push(tray)
    return tray
  }),
  Menu: { buildFromTemplate: fixture.menu },
  globalShortcut: { register: fixture.register, unregister: fixture.unregister },
  nativeImage: {
    createEmpty: vi.fn(() => fixture.icon),
    createFromPath: vi.fn(() => fixture.icon),
    createFromBuffer: vi.fn(() => fixture.paintedIcon)
  },
  systemPreferences: { getUserDefault: vi.fn(() => 'Dark') },
  nativeTheme: fixture.theme
}))

beforeEach(() => {
  vi.clearAllMocks()
  fixture.windows.length = 0
  fixture.loadBarriers.length = 0
  fixture.trays.length = 0
  fixture.icon.isEmpty.mockReturnValue(false)
  fixture.register.mockReturnValue(true)
  fixture.theme.themeSource = 'system'
  fixture.dock.isVisible.mockReset().mockReturnValue(true)
  fixture.dock.show.mockReset().mockImplementation(async () => {
    fixture.dock.isVisible.mockReturnValue(true)
  })
  fixture.dock.hide.mockReset().mockImplementation(() => {
    fixture.dock.isVisible.mockReturnValue(false)
  })
})

const createdHosts: ReturnType<typeof createElectronShellHost>[] = []
afterEach(() => {
  for (const host of createdHosts.splice(0)) host.dispose()
  vi.useRealTimers()
})
function setup(extra: Partial<Parameters<typeof createElectronShellHost>[0]> = {}) {
  const window = new BrowserWindow({ show: true }),
    perform = vi.fn(async (_action: RelayShellActionRequest) => {}),
    allowed = vi.fn(() => true),
    readTraffic = vi.fn<(_signal: AbortSignal) => Promise<RelayFloatingTrafficSample | undefined>>(
      async () => undefined
    )
  const host = createElectronShellHost({
    window: () => window,
    iconPath: '/fixture/tray.png',
    canPerform: allowed,
    floating: {
      preloadPath: '/fixture/preload.cjs',
      rendererPath: '/fixture/floating.html',
      readTraffic
    },
    perform,
    ...extra
  })
  createdHosts.push(host)
  return { host, main: fixture.windows[0], perform, allowed, readTraffic }
}

describe('Electron desktop adapter with no real windows or registrations', () => {
  it('initializes the tray with the same Relay artwork used by later status updates', async () => {
    const f = setup()
    await f.host.apply(defaultShellSettings(), false)
    expect(fixture.trays).toHaveLength(1)
    expect(nativeImage.createFromPath).toHaveBeenCalled()
    for (const [path] of vi.mocked(nativeImage.createFromPath).mock.calls)
      expect(path).toContain('relay-tray-')
  })
  it('refreshes the existing tray on appearance changes and detaches on disposal', async () => {
    const f = setup()
    const appearanceChanged = fixture.theme.on.mock.calls.find(([name]) => name === 'updated')?.[1]
    expect(appearanceChanged).toBeTypeOf('function')
    appearanceChanged?.()
    expect(fixture.trays).toHaveLength(0)
    await f.host.apply(defaultShellSettings(), false)
    const tray = fixture.trays[0]
    const previousImages = tray.setImage.mock.calls.length
    appearanceChanged?.()
    expect(tray.setImage).toHaveBeenCalledTimes(previousImages + 1)
    expect(f.perform).not.toHaveBeenCalled()
    expect(fixture.trays).toHaveLength(1)
    f.host.dispose()
    expect(fixture.theme.removeListener).toHaveBeenCalledWith('updated', appearanceChanged)
    appearanceChanged?.()
    expect(tray.setImage).toHaveBeenCalledTimes(previousImages + 1)
  })
  it('requires a usable tray before hiding Dock and keeps the tray show action usable', async () => {
    const f = setup(),
      settings = { ...defaultShellSettings(), showDockIcon: false }
    fixture.icon.isEmpty.mockReturnValueOnce(true)
    await expect(f.host.apply(settings, false)).rejects.toThrow('托盘')
    expect(fixture.dock.hide).not.toHaveBeenCalled()
    expect(fixture.trays).toHaveLength(0)
    f.host.ensureTray(shellShortcutActions, vi.fn())
    await f.host.apply(settings, false)
    expect(fixture.dock.hide).toHaveBeenCalledOnce()
    f.main.hide()
    fixture.trays[0].on.mock.calls.find(([name]) => name === 'click')?.[1]()
    expect(f.main.isVisible()).toBe(true)
    await f.host.apply(defaultShellSettings(), false)
    expect(fixture.dock.show).toHaveBeenCalledOnce()
  })
  it('rechecks tray liveness before a Dock hide without hiding after tray loss', async () => {
    const f = setup(),
      settings = { ...defaultShellSettings(), showDockIcon: false }
    f.host.ensureTray(shellShortcutActions, vi.fn())
    fixture.trays[0].destroy()
    fixture.icon.isEmpty.mockReturnValueOnce(true)
    await expect(f.host.apply(settings, true)).rejects.toThrow('托盘')
    expect(fixture.dock.hide).not.toHaveBeenCalled()
    expect(fixture.trays).toHaveLength(1)
    await f.host.apply(settings, true)
    expect(fixture.trays).toHaveLength(2)
    expect(fixture.trays[1].isDestroyed()).toBe(false)
    expect(fixture.dock.hide).toHaveBeenCalledOnce()
  })
  it('waits for Dock show before completing apply and reports OS errors', async () => {
    const f = setup()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    fixture.dock.isVisible.mockReturnValue(false)
    let finish!: () => void
    fixture.dock.show.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    let applied = false
    const applying = f.host.apply(defaultShellSettings(), false).then(() => {
      applied = true
    })
    expect(applied).toBe(false)
    finish()
    await applying
    fixture.dock.show.mockRejectedValueOnce(new Error('OS refused'))
    await expect(f.host.apply(defaultShellSettings(), false)).rejects.toThrow('OS refused')
  })
  it('restores previous Dock visibility if saving settings fails', async () => {
    const f = setup(),
      record: RelayShellRecord = { settings: defaultShellSettings(), revision: 'one', exists: true }
    const store = {
      read: vi.fn(async () => structuredClone(record)),
      save: vi.fn(async () => {
        throw new Error('disk')
      })
    }
    const service = createRelayShellService({ store, host: f.host })
    await service.initialize()
    await expect(service.save({ ...record.settings, showDockIcon: false }, 'one')).rejects.toThrow(
      'disk'
    )
    expect(fixture.dock.hide).toHaveBeenCalledOnce()
    expect(fixture.dock.show).toHaveBeenCalledOnce()
    expect(service.state().settings.showDockIcon).toBe(true)
    expect(service.state().uncertain).toBe(false)
  })
  it('preserves window and quit commands while dynamic configuration menus are replaced', () => {
    const f = setup(),
      choose = vi.fn(),
      run = vi.fn()
    f.host.setWorkflowMenu([{ label: '私有配置', click: choose }])
    expect(fixture.menu).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ label: '私有配置' })])
    )
    expect(fixture.trays).toHaveLength(0)
    f.host.ensureTray(shellShortcutActions, run)
    let template = fixture.menu.mock.calls.at(-1)?.[0]
    expect(template?.some((item) => item.label === '私有配置')).toBe(true)
    template?.find((item) => item.label === '私有配置')?.click()
    expect(choose).toHaveBeenCalledOnce()
    f.host.setWorkflowMenu([{ label: '请重新读取', enabled: false }])
    template = fixture.menu.mock.calls.at(-1)?.[0]
    expect(template?.some((item) => item.label === '私有配置')).toBe(false)
    template?.find((item) => item.label?.includes('退出'))?.click()
    expect(run).toHaveBeenCalledExactlyOnceWith('quitApp')
  })
  it('hides at startup only after a usable tray exists and restores the main entry on click', async () => {
    const f = setup(),
      settings = { ...defaultShellSettings(), silentStart: true, closeToTray: true }
    fixture.icon.isEmpty.mockReturnValueOnce(true)
    await expect(f.host.apply(settings, true)).rejects.toThrow('随包托盘图标不可用。')
    expect(fixture.trays).toHaveLength(0)
    expect(f.main.isVisible()).toBe(true)
    expect(f.host.shouldHideOnClose()).toBe(false)
    f.host.ensureTray(shellShortcutActions, vi.fn())
    await f.host.apply(settings, true)
    expect(f.main.isVisible()).toBe(false)
    expect(f.host.shouldHideOnClose()).toBe(true)
    const onClick = fixture.trays[0].on.mock.calls.find(([name]) => name === 'click')?.[1]
    onClick?.()
    expect(f.main.isVisible()).toBe(true)
    expect(f.main.focus).toHaveBeenCalled()
    fixture.trays[0].destroy()
    expect(f.host.shouldHideOnClose()).toBe(false)
  })
  it('does not apply startup hiding on a normal save and respects theme and pinning', async () => {
    const f = setup()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    f.main.hide()
    await f.host.apply(
      { ...defaultShellSettings(), silentStart: true, appTheme: 'dark', alwaysOnTop: true },
      false
    )
    expect(f.main.isVisible()).toBe(true)
    expect(fixture.theme.themeSource).toBe('dark')
    expect(f.main.setAlwaysOnTop).toHaveBeenLastCalledWith(true)
    expect(f.host.shouldHideOnClose()).toBe(false)
  })
  it('creates one readonly floating window for concurrent show requests and shows it only after fixed file load', async () => {
    const f = setup()
    const showing = f.host.perform('showFloatingWindow'),
      floating = fixture.windows[1]
    const repeated = f.host.perform('showFloatingWindow')
    expect(fixture.windows).toHaveLength(2)
    expect(floating.show).not.toHaveBeenCalled()
    await Promise.all([showing, repeated])
    expect(floating.show).toHaveBeenCalledOnce()
    expect(floating.options.webPreferences).toEqual({
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      javascript: true,
      preload: '/fixture/preload.cjs',
      additionalArguments: [relayFloatingArgument]
    })
    expect(floating.loadURL).not.toHaveBeenCalled()
    expect(floating.options).toMatchObject({ width: 260, height: 110, frame: false })
    expect(floating.loadFile).toHaveBeenCalledWith('/fixture/floating.html', {
      hash: 'relay-floating-readonly-v1'
    })
    expect(floating.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    floating.webEvents.get('will-navigate')?.(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    await f.host.perform('showFloatingWindow')
    expect(floating.hide).toHaveBeenCalledOnce()
    f.host.dispose()
    expect(floating.destroy).toHaveBeenCalledOnce()
  })
  it('delegates tray quit and core mode actions to the existing application gate', async () => {
    const f = setup(),
      run = vi.fn()
    f.host.ensureTray(shellShortcutActions, run)
    const quit = fixture.menu.mock.calls[0][0].find((item) => item.label?.includes('退出'))
    quit?.click()
    expect(run).toHaveBeenCalledExactlyOnceWith('quitApp')
    expect(f.perform).not.toHaveBeenCalled()
    await f.host.perform('quitApp')
    await f.host.perform('ruleMode')
    expect(f.perform.mock.calls.map(([action]) => action)).toEqual(['quitApp', 'ruleMode'])
    expect(f.main.destroy).not.toHaveBeenCalled()
  })
  it('keeps current close behavior and binding when Electron reports a shortcut conflict', async () => {
    const f = setup()
    const record: RelayShellRecord = {
      settings: defaultShellSettings(),
      revision: 'one',
      exists: true
    }
    record.settings.shortcuts.showWindow = 'Command+R'
    const store = {
      read: vi.fn(async () => structuredClone(record)),
      save: vi.fn(async () => structuredClone(record))
    }
    const service = createRelayShellService({ store, host: f.host })
    await service.initialize()
    fixture.register.mockReturnValueOnce(false)
    const next = service.state().settings
    next.closeToTray = true
    next.shortcuts.showWindow = 'Command+N'
    await expect(service.save(next, 'one')).rejects.toThrow('占用')
    expect(f.host.shouldHideOnClose()).toBe(false)
    expect(service.state().settings.shortcuts.showWindow).toBe('Command+R')
    expect(fixture.unregister).not.toHaveBeenCalledWith('Command+R')
    expect(store.save).not.toHaveBeenCalled()
    service.dispose()
    expect(fixture.unregister).toHaveBeenCalledExactlyOnceWith('Command+R')
  })
  it('does not open a new floating window or dispatch quit while the application exit gate is closed', async () => {
    const f = setup()
    f.allowed.mockReturnValue(false)
    await expect(f.host.perform('showFloatingWindow')).rejects.toThrow('退出恢复')
    await expect(f.host.perform('quitApp')).rejects.toThrow('退出恢复')
    expect(fixture.windows).toHaveLength(1)
    expect(f.perform).not.toHaveBeenCalled()
  })
  it('recreates a destroyed tray and refuses empty icon startup', () => {
    const f = setup()
    fixture.icon.isEmpty.mockReturnValueOnce(true)
    expect(() => f.host.ensureTray(shellShortcutActions, vi.fn())).toThrow('图标不可用')
    expect(fixture.trays).toHaveLength(0)
    f.host.ensureTray(shellShortcutActions, vi.fn())
    fixture.trays[0].destroy()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    expect(fixture.trays).toHaveLength(2)
  })
})

describe('Fixed network intents in the inert Electron host menu', () => {
  it('allows hiding the tray with a Dock entry despite the retired close preference', async () => {
    const f = setup()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    const settings = {
      ...defaultShellSettings(),
      disableTray: true,
      showDockIcon: true,
      closeToTray: true
    }
    await f.host.apply(settings, false)
    expect(fixture.trays[0].isDestroyed()).toBe(true)
    expect(fixture.dock.isVisible()).toBe(true)
    await expect(f.host.apply({ ...settings, showDockIcon: false }, false)).rejects.toThrow(
      '保留Dock'
    )
    await expect(f.host.apply({ ...settings, silentStart: true }, false)).rejects.toThrow(
      '启动时隐藏'
    )
  })

  it('orders upstream shortcuts and renders the observed states without invoking them', () => {
    const observed = { mode: 'global' as 'rule' | 'global', systemProxy: true, tun: false }
    const f = setup({ information: () => observed })
    const run = vi.fn()
    f.host.setWorkflowMenu([
      { label: 'PROXY', submenu: [{ label: 'Node A', type: 'radio', checked: true }] },
      { label: '订阅配置', submenu: [{ label: 'Local', type: 'radio', checked: true }] }
    ])
    f.host.ensureTray(shellShortcutActions, run)
    const menu = () => fixture.menu.mock.lastCall?.[0] ?? []
    expect(
      menu()
        .map((item) => item.label)
        .filter(Boolean)
    ).toEqual([
      '显示窗口',
      '显示悬浮窗',
      '规则模式',
      '全局模式',
      '直连模式',
      '系统代理',
      '虚拟网卡',
      'PROXY',
      '订阅配置',
      '复制环境变量',
      '后台运行',
      '重启应用',
      '退出应用'
    ])
    expect(menu().find((item) => item.label === '全局模式')?.checked).toBe(true)
    expect(menu().find((item) => item.label === '规则模式')?.checked).toBe(false)
    expect(menu().find((item) => item.label === '系统代理')?.checked).toBe(true)
    expect(menu().find((item) => item.label === '虚拟网卡')?.checked).toBe(false)
    observed.mode = 'rule'
    observed.systemProxy = false
    observed.tun = true
    fixture.trays[0].events.get('right-click')?.()
    expect(menu().find((item) => item.label === '规则模式')?.checked).toBe(true)
    expect(menu().find((item) => item.label === '系统代理')?.checked).toBe(false)
    expect(menu().find((item) => item.label === '虚拟网卡')?.checked).toBe(true)
    expect(menu().find((item) => item.label === '退出应用')).toMatchObject({
      accelerator: 'CommandOrControl+Q'
    })
    expect(run).not.toHaveBeenCalled()
    expect(f.perform).not.toHaveBeenCalled()
  })
  it('reads workflows once before opening and refuses a late popup after disposal', async () => {
    let release!: () => void
    const opening = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const f = setup({ workflowMenuOpening: opening })
    f.host.ensureTray(shellShortcutActions, vi.fn())
    const tray = fixture.trays[0]
    tray.events.get('right-click')?.()
    tray.events.get('right-click')?.()
    await Promise.resolve()
    expect(opening).toHaveBeenCalledOnce()
    expect(tray.popUpContextMenu).not.toHaveBeenCalled()
    f.host.setWorkflowMenu([{ label: '已读取订阅', submenu: [] }])
    release()
    await vi.waitFor(() => expect(tray.popUpContextMenu).toHaveBeenCalledOnce())
    expect(fixture.menu.mock.lastCall?.[0].some((item) => item.label === '已读取订阅')).toBe(true)
    tray.events.get('right-click')?.()
    await Promise.resolve()
    f.host.dispose()
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(tray.popUpContextMenu).toHaveBeenCalledOnce()
  })
  it('keeps window and quit available when refreshing workflows fails', async () => {
    const f = setup({
      workflowMenuOpening: async () => {
        throw new Error('read failed')
      }
    })
    const run = vi.fn()
    f.host.ensureTray(shellShortcutActions, run)
    fixture.trays[0].events.get('right-click')?.()
    await vi.waitFor(() => expect(fixture.trays[0].popUpContextMenu).toHaveBeenCalledOnce())
    const menu = fixture.menu.mock.lastCall?.[0] ?? []
    menu.find((item) => item.label === '退出应用')?.click()
    expect(run).toHaveBeenCalledExactlyOnceWith('quitApp')
  })

  it('provides both explicit labels and sends their exact intents through the existing dispatcher', () => {
    const f = setup()
    const run = vi.fn()
    f.host.ensureTray(shellShortcutActions, run)
    const items = fixture.menu.mock.lastCall?.[0] ?? []
    expect(items.filter((item) => item.label)).toHaveLength(11)
    items.find((item) => item.label === '系统代理')?.click()
    items.find((item) => item.label === '虚拟网卡')?.click()
    expect(run.mock.calls.map(([action]) => action)).toEqual([
      { action: 'triggerSysProxy', enabled: true },
      'triggerTun'
    ])
    expect(fixture.register).not.toHaveBeenCalled()
    expect(f.perform).not.toHaveBeenCalled()
  })
})

describe('Readonly floating host lifecycle and one-way data', () => {
  it('recreates only the floating window when compatibility changes and falls back on transparent load failure', async () => {
    const f = setup(),
      base = { ...defaultShellSettings(), showFloatingWindow: true }
    await f.host.apply(base, true)
    const original = fixture.windows[1]
    expect(original.options.transparent).toBeUndefined()

    const transparent = { ...base, floatingWindowCompatMode: false }
    await f.host.apply(transparent, false)
    const current = fixture.windows[2]
    expect(original.destroy).toHaveBeenCalledOnce()
    expect(current.options).toMatchObject({
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false
    })
    expect(current.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true })
    expect(current.loadFile).toHaveBeenCalledWith('/fixture/floating.html', {
      hash: 'relay-floating-readonly-transparent-v1'
    })
    current.webEvents.get('render-process-gone')?.()
    expect(f.host.floatingCompatibilityFallback?.()).toBe(true)
    await f.host.perform('showFloatingWindow')
    expect(fixture.windows[3].options.transparent).toBeUndefined()

    await f.host.apply(base, false)
    expect(f.host.floatingCompatibilityFallback?.()).toBe(false)
    fixture.loadBarriers.push(Promise.reject(new Error('fixture load failure')))
    await f.host.apply(transparent, false)
    const attempted = fixture.windows.at(-2),
      fallback = fixture.windows.at(-1)
    expect(attempted?.options.transparent).toBe(true)
    expect(attempted?.destroy).toHaveBeenCalledOnce()
    expect(fallback?.options.transparent).toBeUndefined()
    expect(fallback?.show).toHaveBeenCalledOnce()
    expect(f.host.floatingCompatibilityFallback?.()).toBe(true)
    expect(f.main.destroy).not.toHaveBeenCalled()
    expect(f.perform).not.toHaveBeenCalled()
  })
  const sample = (): RelayFloatingTrafficSample => ({
    up: 512,
    down: 2048,
    upTotal: 900000,
    downTotal: 800000,
    instanceId: '11111111-1111-4111-8111-111111111111',
    configurationRevision: 'a'.repeat(64),
    receivedAt: Date.now()
  })
  it.runIf(process.platform === 'darwin')(
    'paints only the current explicit tray-color frame and restores the native title on auto',
    async () => {
      vi.useFakeTimers()
      const f = setup()
      f.readTraffic.mockImplementation(async () => sample())
      await f.host.apply(
        { ...defaultShellSettings(), trayShowTraffic: true, trayTrafficTextColor: 'white' },
        false
      )
      await vi.advanceTimersByTimeAsync(0)
      const owner = fixture.trays[0]
      const draw = f.main.webContents.send.mock.calls.findLast(
        ([channel]) => channel === 'relayTrayTrafficDraw'
      )
      expect(draw?.[1]).toMatchObject({
        textColor: '#ffffff',
        iconTint: '#ffffff',
        up: 512,
        down: 2048
      })
      expect(owner.setTitle).toHaveBeenLastCalledWith('↑512B/s ↓2.0K/s', {
        fontType: 'monospacedDigit'
      })
      const png = Buffer.alloc(33)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
      png.writeUInt32BE(13, 8)
      png.write('IHDR', 12, 'ascii')
      png.writeUInt32BE(156, 16)
      png.writeUInt32BE(36, 20)
      const reply = { id: draw?.[1]?.id, png: `data:image/png;base64,${png.toString('base64')}` }
      f.host.receiveTrayTrafficFrame({ ...reply, id: 'wrong' })
      expect(owner.setImage).not.toHaveBeenCalledWith(fixture.paintedIcon)
      f.host.receiveTrayTrafficFrame(reply)
      expect(owner.setImage).toHaveBeenLastCalledWith(fixture.paintedIcon)
      expect(fixture.paintedIcon.setTemplateImage).toHaveBeenCalledWith(false)
      expect(owner.setTitle).toHaveBeenLastCalledWith('')
      await f.host.apply({ ...defaultShellSettings(), trayShowTraffic: true }, false)
      f.host.receiveTrayTrafficFrame(reply)
      expect(owner.setImage).toHaveBeenLastCalledWith(fixture.icon)
    }
  )
  it('does not dispatch a read for a premature native show event before the fixed file has loaded', async () => {
    let loaded!: () => void
    fixture.loadBarriers.push(new Promise<void>((resolve) => (loaded = resolve)))
    const f = setup(),
      showing = f.host.perform('showFloatingWindow'),
      floating = fixture.windows[1]
    floating.events.get('show')?.()
    await Promise.resolve()
    expect(f.readTraffic).not.toHaveBeenCalled()
    loaded()
    await showing
    await vi.waitFor(() => expect(f.readTraffic).toHaveBeenCalledOnce())
  })
  it('publishes only the fixed snapshot event into its own floating view', async () => {
    const f = setup(),
      value = sample()
    f.readTraffic.mockResolvedValue(value)
    await f.host.perform('showFloatingWindow')
    const floating = fixture.windows[1]
    await vi.waitFor(() =>
      expect(floating.webContents.send).toHaveBeenCalledWith(relayFloatingTrafficChannel, {
        version: 1,
        status: 'ready',
        sample: value,
        spinFloatingIcon: true
      })
    )
    expect(f.main.webContents.send).not.toHaveBeenCalled()
    expect(floating.loadURL).not.toHaveBeenCalled()
    expect(floating.loadFile).toHaveBeenCalledWith('/fixture/floating.html', {
      hash: 'relay-floating-readonly-v1'
    })
  })
  it('updates rotation on a live floating window and rolls it back on a failed preference save', async () => {
    vi.useFakeTimers()
    const f = setup(),
      value = sample(),
      record: RelayShellRecord = {
        settings: { ...defaultShellSettings(), showFloatingWindow: true },
        revision: 'one',
        exists: true
      }
    const store = {
      read: vi.fn(async () => structuredClone(record)),
      save: vi.fn(async () => {
        throw new Error('disk')
      })
    }
    f.readTraffic.mockResolvedValue(value)
    const service = createRelayShellService({ store, host: f.host })
    await service.initialize()
    const floating = fixture.windows[1]
    await vi.waitFor(() =>
      expect(floating.webContents.send).toHaveBeenCalledWith(relayFloatingTrafficChannel, {
        version: 1,
        status: 'ready',
        sample: value,
        spinFloatingIcon: true
      })
    )
    floating.webContents.send.mockClear()
    await expect(
      service.save({ ...record.settings, spinFloatingIcon: false }, 'one')
    ).rejects.toThrow('disk')
    expect(floating.webContents.send.mock.calls).toEqual(
      [false, true].map((spinFloatingIcon) => [
        relayFloatingTrafficChannel,
        { version: 1, status: 'ready', sample: value, spinFloatingIcon }
      ])
    )
    expect(f.readTraffic).toHaveBeenCalledOnce()
    expect(fixture.windows).toHaveLength(2)
  })
  it('hides and cancels only the view read, without publishing its late sample', async () => {
    let finish!: (value: RelayFloatingTrafficSample | undefined) => void
    const f = setup()
    f.readTraffic.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    await f.host.perform('showFloatingWindow')
    await vi.waitFor(() => expect(f.readTraffic).toHaveBeenCalledOnce())
    const signal = f.readTraffic.mock.calls[0][0],
      floating = fixture.windows[1]
    await f.host.perform('showFloatingWindow')
    expect(signal.aborted).toBe(true)
    finish(sample())
    await new Promise((resolve) => setImmediate(resolve))
    expect(floating.webContents.send).not.toHaveBeenCalledWith(
      relayFloatingTrafficChannel,
      expect.objectContaining({ status: 'ready' })
    )
    f.host.invalidateFloatingTraffic()
    expect(f.readTraffic).toHaveBeenCalledOnce()
  })
  it('drops a crashed floating view and cancels its read without destroying the main window', async () => {
    let finish!: (value: RelayFloatingTrafficSample | undefined) => void
    const f = setup()
    f.readTraffic.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    await f.host.perform('showFloatingWindow')
    await vi.waitFor(() => expect(f.readTraffic).toHaveBeenCalledOnce())
    const floating = fixture.windows[1],
      signal = f.readTraffic.mock.calls[0][0]
    floating.webEvents.get('render-process-gone')?.()
    expect(floating.isDestroyed()).toBe(true)
    expect(f.main.isDestroyed()).toBe(false)
    expect(signal.aborted).toBe(true)
    finish(undefined)
    await new Promise((resolve) => setImmediate(resolve))
  })
  it('does not resurrect a disposed host after a pending load completes', async () => {
    let loaded!: () => void
    fixture.loadBarriers.push(new Promise<void>((resolve) => (loaded = resolve)))
    const f = setup(),
      showing = f.host.perform('showFloatingWindow'),
      floating = fixture.windows[1]
    f.host.dispose()
    loaded()
    await expect(showing).rejects.toThrow('浮窗在加载完成前已结束')
    expect(floating.show).not.toHaveBeenCalled()
    expect(f.readTraffic).not.toHaveBeenCalled()
    await expect(f.host.perform('showFloatingWindow')).rejects.toThrow('只读浮窗资源')
  })
  it('keeps the view closed if the application exit gate closes during load', async () => {
    let loaded!: () => void
    fixture.loadBarriers.push(new Promise<void>((resolve) => (loaded = resolve)))
    const f = setup(),
      showing = f.host.perform('showFloatingWindow'),
      floating = fixture.windows[1]
    f.allowed.mockReturnValue(false)
    loaded()
    await expect(showing).rejects.toThrow('浮窗在加载完成前已结束')
    expect(floating.isDestroyed()).toBe(true)
    expect(floating.show).not.toHaveBeenCalled()
    expect(f.readTraffic).not.toHaveBeenCalled()
  })
})

describe('Floating display revocation boundaries', () => {
  it('ends a preload-failed display before a successful HTML load can start a read', async () => {
    let loaded!: () => void
    fixture.loadBarriers.push(new Promise<void>((resolve) => (loaded = resolve)))
    const f = setup(),
      showing = f.host.perform('showFloatingWindow'),
      floating = fixture.windows[1]
    floating.webEvents.get('preload-error')?.()
    loaded()
    await expect(showing).rejects.toThrow('浮窗在加载完成前已结束')
    expect(floating.isDestroyed()).toBe(true)
    expect(f.readTraffic).not.toHaveBeenCalled()
    expect(f.main.isDestroyed()).toBe(false)
  })
  it('does not resume reads for a late show event while the native window remains hidden', async () => {
    vi.useFakeTimers()
    const f = setup()
    await f.host.perform('showFloatingWindow')
    expect(f.readTraffic).toHaveBeenCalledOnce()
    const floating = fixture.windows[1]
    floating.hide()
    floating.events.get('show')?.()
    await vi.advanceTimersByTimeAsync(1200)
    expect(floating.isVisible()).toBe(false)
    expect(f.readTraffic).toHaveBeenCalledOnce()
  })
  it('does not start reads after native show synchronously closes the display', async () => {
    let loaded!: () => void
    fixture.loadBarriers.push(new Promise<void>((resolve) => (loaded = resolve)))
    const f = setup(),
      showing = f.host.perform('showFloatingWindow'),
      floating = fixture.windows[1]
    floating.show.mockImplementationOnce(() => floating.destroy())
    loaded()
    await showing
    await Promise.resolve()
    expect(floating.isDestroyed()).toBe(true)
    expect(f.readTraffic).not.toHaveBeenCalled()
  })
  it('pauses reads when the exit gate closes and resumes only after its explicit reopening', async () => {
    vi.useFakeTimers()
    const f = setup()
    await f.host.perform('showFloatingWindow')
    expect(f.readTraffic).toHaveBeenCalledOnce()
    f.allowed.mockReturnValue(false)
    f.host.invalidateFloatingTraffic()
    await vi.advanceTimersByTimeAsync(1200)
    expect(f.readTraffic).toHaveBeenCalledOnce()
    f.allowed.mockReturnValue(true)
    f.host.invalidateFloatingTraffic()
    await Promise.resolve()
    expect(f.readTraffic).toHaveBeenCalledTimes(2)
  })
  it('keeps minimized display reads paused despite late show and restore events', async () => {
    vi.useFakeTimers()
    const f = setup()
    await f.host.perform('showFloatingWindow')
    expect(f.readTraffic).toHaveBeenCalledOnce()
    const floating = fixture.windows[1]
    floating.isMinimized.mockReturnValue(true)
    floating.events.get('minimize')?.()
    floating.events.get('show')?.()
    floating.events.get('restore')?.()
    await vi.advanceTimersByTimeAsync(1200)
    expect(f.readTraffic).toHaveBeenCalledOnce()
  })
  it('cancels an already running display read when preload failure revokes the display', async () => {
    let finish!: (value: RelayFloatingTrafficSample | undefined) => void
    const f = setup()
    f.readTraffic.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    await f.host.perform('showFloatingWindow')
    const signal = f.readTraffic.mock.calls[0][0],
      floating = fixture.windows[1]
    floating.webEvents.get('preload-error')?.()
    expect(signal.aborted).toBe(true)
    expect(floating.isDestroyed()).toBe(true)
    finish(undefined)
    await Promise.resolve()
    expect(f.main.isDestroyed()).toBe(false)
  })
})

describe('Explicit background run keeps the current owner alive', () => {
  it('requires a live tray before hiding and keeps all windows reachable after refusal', async () => {
    const f = setup()
    await expect(f.host.perform('runInBackground')).rejects.toThrow('可用托盘')
    expect(f.main.hide).not.toHaveBeenCalled()
    expect(f.main.isVisible()).toBe(true)
    expect(f.perform).not.toHaveBeenCalled()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    fixture.trays[0].destroy()
    await expect(f.host.perform('runInBackground')).rejects.toThrow('可用托盘')
    expect(f.main.hide).not.toHaveBeenCalled()
  })
  it('hides its windows, cancels only the floating read and restores through the retained tray', async () => {
    let finish!: (value: RelayFloatingTrafficSample | undefined) => void
    const f = setup()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    f.readTraffic.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    await f.host.perform('showFloatingWindow')
    const floating = fixture.windows[1],
      signal = f.readTraffic.mock.calls[0][0]
    await f.host.perform('runInBackground')
    expect(f.main.isVisible()).toBe(false)
    expect(floating.isVisible()).toBe(false)
    expect(signal.aborted).toBe(true)
    expect(f.main.isDestroyed()).toBe(false)
    expect(floating.isDestroyed()).toBe(false)
    expect(f.perform).not.toHaveBeenCalled()
    expect(fixture.trays[0].isDestroyed()).toBe(false)
    fixture.trays[0].on.mock.calls.find(([name]) => name === 'click')?.[1]()
    expect(f.main.isVisible()).toBe(true)
    finish(undefined)
    await Promise.resolve()
  })
  it('refuses background run while the existing exit gate is closed', async () => {
    const f = setup()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    f.allowed.mockReturnValue(false)
    await expect(f.host.perform('runInBackground')).rejects.toThrow('退出恢复')
    expect(f.main.hide).not.toHaveBeenCalled()
    expect(f.perform).not.toHaveBeenCalled()
  })
  it('reports a native hide refusal instead of claiming the app exited', async () => {
    const f = setup()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    f.main.hide.mockImplementationOnce(() => {})
    await expect(f.host.perform('runInBackground')).rejects.toThrow('后台运行状态未确认')
    expect(f.main.isVisible()).toBe(true)
    expect(f.main.isDestroyed()).toBe(false)
    expect(f.perform).not.toHaveBeenCalled()
  })
})

describe('Background run checks reachability after native hide', () => {
  it('does not report success if the main window ends synchronously during hide', async () => {
    const f = setup()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    f.main.hide.mockImplementationOnce(() => f.main.destroy())
    await expect(f.host.perform('runInBackground')).rejects.toThrow('后台运行状态未确认')
    expect(f.main.isDestroyed()).toBe(true)
    expect(f.perform).not.toHaveBeenCalled()
  })
  it('restores the live main window if its tray entry disappears during hide', async () => {
    const f = setup()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    const hide = f.main.hide.getMockImplementation()
    if (!hide) throw new Error('Missing hide implementation')
    f.main.hide.mockImplementationOnce(() => {
      hide()
      fixture.trays[0].destroy()
    })
    await expect(f.host.perform('runInBackground')).rejects.toThrow('后台运行状态未确认')
    expect(f.main.isVisible()).toBe(true)
    expect(f.main.isDestroyed()).toBe(false)
    expect(f.perform).not.toHaveBeenCalled()
  })
})

describe('Transactional tray preferences', () => {
  it('copies one legacy format directly, otherwise offers explicit formats in saved order', async () => {
    const f = setup(),
      run = vi.fn()
    f.host.ensureTray(shellShortcutActions, run)
    const current = () =>
      fixture.menu.mock.lastCall?.[0].find((item) => item.label === '复制环境变量')
    await f.host.apply({ ...defaultShellSettings(), environmentFormat: 'fish' }, false)
    const legacy = current()
    expect(legacy?.submenu).toBeUndefined()
    legacy?.click()
    expect(run).toHaveBeenCalledExactlyOnceWith({ action: 'copyEnv', format: 'fish' })
    run.mockClear()
    await f.host.apply(
      { ...defaultShellSettings(), environmentFormats: ['nushell', 'bash', 'cmd'] },
      false
    )
    legacy?.click()
    const ordered = current()?.submenu
    expect(ordered?.map(({ label }) => label)).toEqual(['Nushell', 'Bash', 'CMD'])
    ordered?.[1].click()
    expect(run).toHaveBeenCalledExactlyOnceWith({ action: 'copyEnv', format: 'bash' })
    f.allowed.mockReturnValue(false)
    ordered?.[0].click()
    expect(run).toHaveBeenCalledOnce()
  })
  function preferencesFixture() {
    const main = new BrowserWindow({ show: true })
    let record: RelayShellState = {
      settings: defaultShellSettings(),
      revision: 'original',
      exists: true,
      initialized: true,
      pending: false,
      uncertain: false,
      warnings: []
    }
    const report = vi.fn()
    const save = vi.fn(
      async (settings: ReturnType<typeof defaultShellSettings>, revision: string) => {
        if (record.revision !== revision) throw new Error('stale')
        record = { ...record, settings, revision: 'saved' }
      }
    )
    const allowed = vi.fn(() => true)
    const host = createElectronShellHost({
      window: () => main,
      iconPath: '/fixture/tray.png',
      canPerform: allowed,
      perform: vi.fn(async () => {}),
      preferences: { state: () => structuredClone(record), save, report }
    })
    createdHosts.push(host)
    host.ensureTray(shellShortcutActions, vi.fn())
    const menu = () => fixture.menu.mock.lastCall?.[0].find((item) => item.label === '窗口偏好')
    return {
      host,
      menu,
      save,
      report,
      allowed,
      change: (patch: Partial<RelayShellState>) => {
        record = { ...record, ...patch }
      }
    }
  }
  it('saves only the selected preference with the captured revision and refreshes checked state', async () => {
    const f = preferencesFixture()
    expect(f.menu()?.submenu?.some((item) => item.label === '关闭主窗口时收起到托盘')).toBe(false)
    f.menu()
      ?.submenu?.find((item) => item.label === '主窗口置顶')
      ?.click()
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce())
    expect(f.save).toHaveBeenCalledWith(
      { ...defaultShellSettings(), alwaysOnTop: true },
      'original'
    )
    await vi.waitFor(() =>
      expect(f.menu()?.submenu?.find((item) => item.label === '主窗口置顶')?.checked).toBe(true)
    )
    const formats = f.menu()?.submenu?.find((item) => item.label === '复制环境变量格式')?.submenu
    formats?.find((item) => item.label === 'Fish')?.click()
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2))
    expect(f.save.mock.calls[1][0]).toMatchObject({ alwaysOnTop: true, environmentFormat: 'fish' })
  })
  it.each(['revision', 'pending', 'uncertain', 'quitting'] as const)(
    'rejects a retained callback after %s changed',
    async (field) => {
      const f = preferencesFixture()
      const click = f.menu()?.submenu?.find((item) => item.label === '主窗口置顶')?.click
      if (field === 'revision') f.change({ revision: 'external' })
      if (field === 'pending') f.change({ pending: true })
      if (field === 'uncertain') f.change({ uncertain: true })
      if (field === 'quitting') f.allowed.mockReturnValue(false)
      click?.()
      expect(f.save).not.toHaveBeenCalled()
      expect(f.report).toHaveBeenCalledOnce()
    }
  )
  it('serializes repeated retained clicks and reports a failed save without retry', async () => {
    const f = preferencesFixture()
    let reject: (error: Error) => void = () => {
      throw new Error('barrier not started')
    }
    f.save.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        })
    )
    const click = f.menu()?.submenu?.find((item) => item.label === '主窗口置顶')?.click
    click?.()
    click?.()
    expect(f.save).toHaveBeenCalledOnce()
    reject(new Error('disk'))
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledTimes(2))
    expect(f.menu()?.submenu?.find((item) => item.label === '主窗口置顶')?.checked).toBe(false)
  })
  it('ignores a failed in-flight preference save after the host is disposed', async () => {
    const f = preferencesFixture()
    let fail: (error: Error) => void = () => {
      throw new Error('barrier not started')
    }
    f.save.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject
        })
    )
    f.menu()
      ?.submenu?.find((item) => item.label === '主窗口置顶')
      ?.click()
    expect(f.save).toHaveBeenCalledOnce()
    const window = fixture.windows[0]
    window.hide()
    f.host.dispose()
    window.show.mockClear()
    fail(new Error('late save failure'))
    await Promise.resolve()
    await Promise.resolve()
    expect(window.show).not.toHaveBeenCalled()
    expect(f.report).not.toHaveBeenCalled()
  })
  it('swaps clicks immediately and restores native right-click menus when turned off', async () => {
    const f = setup()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    const tray = fixture.trays[0]
    await f.host.apply({ ...defaultShellSettings(), swapTrayClick: true }, false)
    expect(tray.setContextMenu).toHaveBeenLastCalledWith(null)
    f.main.hide()
    tray.events.get('click')?.()
    expect(tray.popUpContextMenu).toHaveBeenCalledOnce()
    expect(f.main.isVisible()).toBe(false)
    tray.events.get('right-click')?.()
    expect(f.main.isVisible()).toBe(true)
    await f.host.apply(defaultShellSettings(), false)
    expect(tray.setContextMenu).toHaveBeenLastCalledWith(null)
    tray.events.get('click')?.()
    expect(tray.popUpContextMenu).toHaveBeenCalledOnce()
    tray.events.get('right-click')?.()
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(2)
  })
  it.each([false, true])(
    'toggles only the live assigned tray activation with swap=%s',
    async (swapTrayClick) => {
      const f = setup(),
        run = vi.fn()
      f.host.ensureTray(shellShortcutActions, run)
      const tray = fixture.trays[0],
        activate = tray.events.get(swapTrayClick ? 'right-click' : 'click'),
        menu = tray.events.get(swapTrayClick ? 'click' : 'right-click')
      await f.host.apply(
        { ...defaultShellSettings(), swapTrayClick, triggerMainWindowBehavior: 'toggle' },
        false
      )
      menu?.()
      expect(tray.popUpContextMenu).toHaveBeenCalledOnce()
      expect(f.main.isVisible()).toBe(true)
      activate?.()
      expect(f.main.isVisible()).toBe(false)
      activate?.()
      expect(f.main.isVisible()).toBe(true)
      f.main.isMinimized.mockReturnValue(true)
      activate?.()
      expect(f.main.restore).toHaveBeenCalledOnce()
      f.main.isMinimized.mockReturnValue(false)
      f.allowed.mockReturnValue(false)
      activate?.()
      expect(f.main.isVisible()).toBe(true)
      f.allowed.mockReturnValue(true)
      tray.destroy()
      f.host.ensureTray(shellShortcutActions, run)
      activate?.()
      expect(f.main.isVisible()).toBe(true)
      expect(f.main.hide).toHaveBeenCalledOnce()
      expect(f.main.destroy).not.toHaveBeenCalled()
      expect(f.perform).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
    }
  )
  it('restores the main window if its tray entry is lost during a toggle', async () => {
    const f = setup()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    const tray = fixture.trays[0]
    await f.host.apply({ ...defaultShellSettings(), triggerMainWindowBehavior: 'toggle' }, false)
    f.main.events.set('hide', () => tray.destroy())
    tray.events.get('click')?.()
    expect(f.main.hide).toHaveBeenCalledOnce()
    expect(f.main.isVisible()).toBe(true)
    expect(f.main.destroy).not.toHaveBeenCalled()
    expect(f.perform).not.toHaveBeenCalled()
  })
})

describe('Read-only tray information and fixed directory callbacks', () => {
  it('marks unknown observations and never claims they are disabled', () => {
    const f = setup({ information: () => ({ systemProxy: undefined, tun: undefined }) })
    f.host.ensureTray(shellShortcutActions, vi.fn())
    const tooltip = fixture.trays[0].setToolTip.mock.lastCall?.[0]
    expect(tooltip).toContain('系统代理：未确认')
    expect(tooltip).toContain('TUN：未确认')
    expect(tooltip).toContain('非实时系统复核')
    expect(tooltip).toContain('状态点不代表 Claude/Codex 防直连保护')
    expect(
      fixture.menu.mock.lastCall?.[0].find((item) => item.label === '虚拟网卡（状态未获取）')
        ?.checked
    ).toBe(false)
  })
  it('opens only the supplied fixed callback and ignores a retained click after disposal', async () => {
    const open = vi.fn(async () => {})
    const f = setup({ directories: [{ label: 'Relay数据目录', open }] })
    f.host.ensureTray(shellShortcutActions, vi.fn())
    const click = fixture.menu.mock.lastCall?.[0].find((item) => item.label === '打开目录')
      ?.submenu?.[0].click
    click?.()
    expect(open).toHaveBeenCalledOnce()
    f.host.dispose()
    click?.()
    expect(open).toHaveBeenCalledOnce()
    expect(f.perform).not.toHaveBeenCalled()
  })
  it('blocks an owned directory after the originating tray is destroyed while awaiting proof', async () => {
    let prove!: () => void
    const proof = new Promise<void>((resolve) => (prove = resolve))
    const open = vi.fn(),
      settled = vi.fn()
    const capture = () => async (assertAvailable: () => void) => {
      try {
        await proof
        assertAvailable()
        open()
      } finally {
        settled()
      }
    }
    const f = setup({ directories: [{ label: '本次 TUN 核心工作目录', capture }] })
    f.host.ensureTray(shellShortcutActions, vi.fn())
    const click = fixture.menu.mock.lastCall?.[0].find((item) => item.label === '打开目录')
      ?.submenu?.[0].click
    expect(click).toBeTypeOf('function')
    click?.()
    fixture.trays[0].destroy()
    prove()
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    expect(open).not.toHaveBeenCalled()
  })
  it('ignores retained preference callbacks after disposal', () => {
    const report = vi.fn(),
      save = vi.fn(async () => {})
    const f = setup({
      preferences: {
        state: () => ({
          settings: defaultShellSettings(),
          revision: 'a',
          exists: true,
          initialized: true,
          pending: false,
          uncertain: false,
          warnings: []
        }),
        save,
        report
      }
    })
    f.host.ensureTray(shellShortcutActions, vi.fn())
    const click = fixture.menu.mock.lastCall?.[0].find((item) => item.label === '窗口偏好')
      ?.submenu?.[1].click
    f.host.dispose()
    click?.()
    expect(save).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })
})

describe('Owned floating geometry and native context menu', () => {
  const geometry = () => ({
    resolve: vi.fn(() => ({
      bounds: { x: 310, y: 120, width: 260, height: 110 },
      minWidth: 260,
      minHeight: 110,
      maximized: false
    })),
    attach: vi.fn(),
    capture: vi.fn(),
    reconcile: vi.fn(),
    dispose: vi.fn()
  })
  it('uses its separate resolved bounds, reconciles on reopening and keeps all commands in Main', async () => {
    const geo = geometry(),
      readTraffic = vi.fn(async () => undefined)
    const f = setup({
      floating: {
        preloadPath: '/fixture/preload.cjs',
        rendererPath: '/fixture/floating.html',
        readTraffic,
        geometry: geo
      }
    })
    f.host.ensureTray(shellShortcutActions, vi.fn())
    await f.host.perform('showFloatingWindow')
    const target = fixture.windows[1]
    expect(target.options).toMatchObject({
      x: 310,
      y: 120,
      width: 260,
      height: 110,
      minWidth: 260,
      minHeight: 110
    })
    expect(geo.attach).toHaveBeenCalledOnce()
    target.webEvents.get('context-menu')?.()
    expect(fixture.menu.mock.results.at(-1)?.value.popup).toHaveBeenCalledWith({ window: target })
    await f.host.perform('showFloatingWindow')
    expect(geo.capture).toHaveBeenCalled()
    await f.host.perform('showFloatingWindow')
    expect(geo.reconcile).toHaveBeenCalledOnce()
    expect(f.perform).not.toHaveBeenCalled()
  })
  it.each(['preload-error', 'render-process-gone'])(
    'captures current geometry before %s destroys the view',
    async (event) => {
      const geo = geometry(),
        f = setup({
          floating: {
            preloadPath: '/fixture/preload.cjs',
            rendererPath: '/fixture/floating.html',
            readTraffic: async () => undefined,
            geometry: geo
          }
        })
      await f.host.perform('showFloatingWindow')
      const target = fixture.windows[1]
      geo.capture.mockClear()
      target.webEvents.get(event)?.()
      expect(geo.capture).toHaveBeenCalledOnce()
      expect(geo.capture.mock.invocationCallOrder[0]).toBeLessThan(
        target.destroy.mock.invocationCallOrder[0]
      )
      expect(geo.dispose).toHaveBeenCalled()
      expect(target.isDestroyed()).toBe(true)
    }
  )
})

describe('Background choice revokes only through its reachable Main hook', () => {
  it('calls the fixed hook before hiding without delegating to Main actions or touching Core', async () => {
    const backgroundChosen = vi.fn(),
      f = setup({ backgroundChosen })
    await expect(f.host.perform('runInBackground')).rejects.toThrow('托盘')
    expect(backgroundChosen).not.toHaveBeenCalled()
    f.host.ensureTray(shellShortcutActions, vi.fn())
    await f.host.perform('runInBackground')
    expect(backgroundChosen).toHaveBeenCalledOnce()
    expect(backgroundChosen.mock.invocationCallOrder[0]).toBeLessThan(
      f.main.hide.mock.invocationCallOrder[0]
    )
    expect(f.perform).not.toHaveBeenCalled()
  })
})

describe('Current-proxy preference applies and rolls back cached labels', () => {
  async function linked(initial: boolean, lateWorkflow = false) {
    const main = new BrowserWindow({ show: true })
    let record: RelayShellRecord = {
      settings: { ...defaultShellSettings(), showCurrentProxyInTray: initial },
      revision: 'original',
      exists: true
    }
    let workflow: ReturnType<typeof createTrayWorkflows> | undefined = undefined
    const state: LocalProxyState = {
      phase: 'running',
      pending: false,
      owned: true,
      hasRecord: true,
      uncertain: false,
      instanceId: 'instance',
      configurationRevision: 'revision',
      pid: 42,
      traffic: 'listening',
      groups: [
        {
          name: '选择',
          members: ['节点A'],
          now: '节点A',
          type: 'select',
          selectable: true,
          confirmed: true
        }
      ],
      systemProxyChanged: false,
      liveGuardEnabled: false,
      warnings: []
    }
    const load = vi.fn(async () => ({ local: structuredClone(state), profiles: [] })),
      report = vi.fn()
    const store = {
      read: vi.fn(async () => structuredClone(record)),
      save: vi.fn(async (settings: ReturnType<typeof defaultShellSettings>, revision: string) => {
        if (record.revision !== revision) throw new Error('stale')
        record = { settings: structuredClone(settings), revision: 'saved', exists: true }
        return structuredClone(record)
      })
    }
    const changed = vi.fn((visible: boolean) => workflow?.setCurrentProxyVisible(visible))
    const host = createElectronShellHost({
      window: () => main,
      iconPath: '/fixture/tray.png',
      perform: vi.fn(async () => {}),
      currentProxyVisibilityChanged: changed,
      preferences: {
        state: () => service.state(),
        save: async (settings, revision) => {
          await service.save(settings, revision)
        },
        report
      }
    })
    createdHosts.push(host)
    const service = createRelayShellService({ store, host, notify: () => host.refreshMenu() })
    if (lateWorkflow) await service.initialize()
    workflow = createTrayWorkflows({
      showCurrentProxyInTray: service.state().settings.showCurrentProxyInTray,
      trayProxyGroupStyle: 'submenu',
      load,
      local: () => structuredClone(state),
      chooseProfile: vi.fn(async () => {}),
      chooseNode: vi.fn(async () => {}),
      publish: (items) => host.setWorkflowMenu(items),
      assertIdle: () => {},
      report
    })
    if (!lateWorkflow) await service.initialize()
    await workflow.refresh()
    const group = () =>
      fixture.menu.mock.lastCall?.[0].find((item) => item.label === '代理组')?.submenu?.[0].label
    const toggle = () =>
      fixture.menu.mock.lastCall?.[0]
        .find((item) => item.label === '窗口偏好')
        ?.submenu?.find((item) => item.label === '组名后显示当前代理（读取记录）')
    return { service, host, store, workflow, load, report, changed, group, toggle }
  }
  it('restores persisted true even when Host applies before workflow construction', async () => {
    const f = await linked(true, true)
    expect(f.group()).toBe('选择 | 节点A')
    expect(f.load).toHaveBeenCalledOnce()
    expect(f.store.save).not.toHaveBeenCalled()
  })
  it('saves through the captured revision and updates cached text without a second load', async () => {
    const f = await linked(false)
    expect(f.group()).toBe('选择')
    f.toggle()?.click()
    await vi.waitFor(() => expect(f.service.state().settings.showCurrentProxyInTray).toBe(true))
    expect(f.store.save).toHaveBeenCalledWith(
      expect.objectContaining({ showCurrentProxyInTray: true }),
      'original'
    )
    expect(f.group()).toBe('选择 | 节点A')
    expect(f.load).toHaveBeenCalledOnce()
    expect(f.toggle()?.checked).toBe(true)
  })
  it('rolls back labels and the checkbox after a failed save without reloading', async () => {
    const f = await linked(false)
    f.store.save.mockRejectedValueOnce(new Error('disk'))
    f.toggle()?.click()
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce())
    expect(f.service.state().settings.showCurrentProxyInTray).toBe(false)
    expect(f.service.state().revision).toBe('original')
    expect(f.group()).toBe('选择')
    expect(f.toggle()?.checked).toBe(false)
    expect(f.load).toHaveBeenCalledOnce()
  })
  it('does not apply a preference callback after the Host is disposed', async () => {
    const f = await linked(false)
    f.host.dispose()
    f.changed.mockClear()
    await expect(
      f.host.apply({ ...defaultShellSettings(), showCurrentProxyInTray: true }, false)
    ).rejects.toThrow('结束')
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.load).toHaveBeenCalledOnce()
  })
})

describe('Tray group layout uses the existing preference transaction', () => {
  async function linked(
    style: ReturnType<typeof defaultShellSettings>['trayProxyGroupStyle'],
    beforeWorkflow = false
  ) {
    const main = new BrowserWindow({ show: true })
    let record: RelayShellRecord = {
      settings: { ...defaultShellSettings(), trayProxyGroupStyle: style },
      revision: 'layout-original',
      exists: true
    }
    let workflow: ReturnType<typeof createTrayWorkflows> | undefined = undefined
    const state: LocalProxyState = {
      phase: 'running',
      pending: false,
      owned: true,
      hasRecord: true,
      uncertain: false,
      instanceId: 'layout-instance',
      configurationRevision: 'layout-configuration',
      pid: 42,
      traffic: 'listening',
      groups: [
        {
          name: '选择',
          members: ['节点A'],
          now: '节点A',
          type: 'select',
          selectable: true,
          confirmed: true
        }
      ],
      systemProxyChanged: false,
      liveGuardEnabled: false,
      warnings: []
    }
    const load = vi.fn(async () => ({ local: structuredClone(state), profiles: [] })),
      report = vi.fn()
    const store = {
      read: vi.fn(async () => structuredClone(record)),
      save: vi.fn(async (settings: ReturnType<typeof defaultShellSettings>, revision: string) => {
        if (record.revision !== revision) throw new Error('stale')
        record = { settings: structuredClone(settings), revision: 'layout-saved', exists: true }
        return structuredClone(record)
      })
    }
    const changed = vi.fn((next: ReturnType<typeof defaultShellSettings>['trayProxyGroupStyle']) =>
      workflow?.setGroupStyle(next)
    )
    const host = createElectronShellHost({
      window: () => main,
      iconPath: '/fixture/tray.png',
      perform: vi.fn(async () => {}),
      groupStyleChanged: changed,
      preferences: {
        state: () => service.state(),
        save: async (settings, revision) => {
          await service.save(settings, revision)
        },
        report
      }
    })
    createdHosts.push(host)
    const service = createRelayShellService({ store, host, notify: () => host.refreshMenu() })
    if (beforeWorkflow) await service.initialize()
    workflow = createTrayWorkflows({
      trayProxyGroupStyle: service.state().settings.trayProxyGroupStyle,
      showCurrentProxyInTray: service.state().settings.showCurrentProxyInTray,
      load,
      local: () => structuredClone(state),
      chooseProfile: vi.fn(async () => {}),
      chooseNode: vi.fn(async () => {}),
      publish: (items) => host.setWorkflowMenu(items),
      assertIdle: () => {},
      report
    })
    if (!beforeWorkflow) await service.initialize()
    await workflow.refresh()
    const menu = () => fixture.menu.mock.lastCall?.[0]
    const option = (label: string) =>
      menu()
        ?.find((item) => item.label === '窗口偏好')
        ?.submenu?.find((item) => item.label === '托盘代理组布局')
        ?.submenu?.find((item) => item.label === label)
    return { host, service, store, workflow, load, report, changed, menu, option }
  }
  it.each(['default', 'submenu'] as const)(
    'initializes %s from restored settings even if Host applied before workflow creation',
    async (style) => {
      const f = await linked(style, true)
      expect(f.menu()?.some((item) => item.label === '选择')).toBe(style === 'default')
      expect(f.menu()?.find((item) => item.label === '代理组')?.submenu?.[0]?.label).toBe(
        style === 'submenu' ? '选择' : undefined
      )
      expect(f.load).toHaveBeenCalledOnce()
      expect(f.store.save).not.toHaveBeenCalled()
    }
  )
  it('saves only the chosen enum through captured CAS and reprojects cached group actions without another load', async () => {
    const f = await linked('submenu')
    expect(f.option('折叠至本次实例节点子菜单')?.checked).toBe(true)
    f.option('逐组显示（上游默认）')?.click()
    await vi.waitFor(() => expect(f.service.state().settings.trayProxyGroupStyle).toBe('default'))
    expect(f.store.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ trayProxyGroupStyle: 'default' }),
      'layout-original'
    )
    expect(f.menu()?.some((item) => item.label === '选择')).toBe(true)
    expect(f.option('逐组显示（上游默认）')?.checked).toBe(true)
    expect(f.load).toHaveBeenCalledOnce()
  })
  it('restores the previous cached layout/radio after a failed disk save and ignores apply after disposal', async () => {
    const f = await linked('submenu')
    f.store.save.mockRejectedValueOnce(new Error('own synthetic disk failure'))
    f.option('逐组显示（上游默认）')?.click()
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce())
    expect(f.service.state().settings.trayProxyGroupStyle).toBe('submenu')
    expect(f.service.state().revision).toBe('layout-original')
    expect(f.option('折叠至本次实例节点子菜单')?.checked).toBe(true)
    expect(f.menu()?.some((item) => item.label === '选择')).toBe(false)
    expect(f.changed.mock.calls.map(([value]) => value)).toEqual(['submenu', 'default', 'submenu'])
    expect(f.load).toHaveBeenCalledOnce()
    f.host.dispose()
    f.changed.mockClear()
    await expect(
      f.host.apply({ ...defaultShellSettings(), trayProxyGroupStyle: 'default' }, false)
    ).rejects.toThrow('结束')
    expect(f.changed).not.toHaveBeenCalled()
  })
})

describe('Tray proxy-group visibility uses the existing preference transaction', () => {
  async function linked(visible: boolean, beforeWorkflow = false) {
    const main = new BrowserWindow({ show: true })
    let record: RelayShellRecord = {
      settings: { ...defaultShellSettings(), proxyInTray: visible },
      revision: 'visibility-original',
      exists: true
    }
    let workflow: ReturnType<typeof createTrayWorkflows> | undefined = undefined
    const state: LocalProxyState = {
      phase: 'running',
      pending: false,
      owned: true,
      hasRecord: true,
      uncertain: false,
      instanceId: 'visibility-instance',
      configurationRevision: 'visibility-config',
      pid: 42,
      traffic: 'listening',
      groups: [
        {
          name: '选择',
          members: ['节点A'],
          now: '节点A',
          type: 'select',
          selectable: true,
          confirmed: true
        }
      ],
      systemProxyChanged: false,
      liveGuardEnabled: false,
      warnings: []
    }
    const load = vi.fn(async () => ({ local: structuredClone(state), profiles: [] })),
      report = vi.fn()
    const store = {
      read: vi.fn(async () => structuredClone(record)),
      save: vi.fn(async (settings: ReturnType<typeof defaultShellSettings>, revision: string) => {
        if (record.revision !== revision) throw new Error('stale')
        record = { settings: structuredClone(settings), revision: 'visibility-saved', exists: true }
        return structuredClone(record)
      })
    }
    const changed = vi.fn((value: boolean) => workflow?.setProxyGroupsVisible(value))
    const host = createElectronShellHost({
      window: () => main,
      iconPath: '/fixture/tray.png',
      perform: vi.fn(async () => {}),
      proxyGroupsVisibilityChanged: changed,
      preferences: {
        state: () => service.state(),
        save: async (settings, revision) => {
          await service.save(settings, revision)
        },
        report
      }
    })
    createdHosts.push(host)
    const service = createRelayShellService({ store, host, notify: () => host.refreshMenu() })
    if (beforeWorkflow) await service.initialize()
    workflow = createTrayWorkflows({
      proxyInTray: service.state().settings.proxyInTray,
      trayProxyGroupStyle: service.state().settings.trayProxyGroupStyle,
      load,
      local: () => structuredClone(state),
      chooseProfile: vi.fn(async () => {}),
      chooseNode: vi.fn(async () => {}),
      publish: (items) => host.setWorkflowMenu(items),
      assertIdle: () => {},
      report
    })
    if (!beforeWorkflow) await service.initialize()
    await workflow.refresh()
    const menu = () => fixture.menu.mock.lastCall?.[0]
    const checkbox = () =>
      menu()
        ?.find((item) => item.label === '窗口偏好')
        ?.submenu?.find((item) => item.label === '在托盘显示代理组')
    return { host, service, store, workflow, load, report, changed, menu, checkbox }
  }
  it.each([true, false])(
    'initializes saved visibility %s even when Host applies before Workflow creation',
    async (visible) => {
      const f = await linked(visible, true)
      expect(f.checkbox()?.checked).toBe(visible)
      expect(f.menu()?.some((item) => item.label === '选择')).toBe(visible)
      expect(f.load).toHaveBeenCalledOnce()
      expect(f.store.save).not.toHaveBeenCalled()
    }
  )
  it('persists the clicked visibility under the captured revision and reprojects without a second Core read', async () => {
    const f = await linked(true)
    f.checkbox()?.click()
    await vi.waitFor(() => expect(f.service.state().settings.proxyInTray).toBe(false))
    expect(f.store.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ proxyInTray: false }),
      'visibility-original'
    )
    expect(f.checkbox()?.checked).toBe(false)
    expect(f.menu()?.some((item) => item.label === '选择')).toBe(false)
    expect(f.menu()?.some((item) => item.label === '订阅配置')).toBe(true)
    expect(f.load).toHaveBeenCalledOnce()
  })
  it('restores cached groups and the checked preference after a disk failure, and ignores apply after disposal', async () => {
    const f = await linked(true)
    f.store.save.mockRejectedValueOnce(new Error('own synthetic disk failure'))
    f.checkbox()?.click()
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce())
    expect(f.service.state()).toMatchObject({
      settings: { proxyInTray: true },
      revision: 'visibility-original',
      uncertain: false
    })
    expect(f.checkbox()?.checked).toBe(true)
    expect(f.menu()?.some((item) => item.label === '选择')).toBe(true)
    expect(f.changed.mock.calls.map(([value]) => value)).toEqual([true, false, true])
    expect(f.load).toHaveBeenCalledOnce()
    f.host.dispose()
    f.changed.mockClear()
    await expect(
      f.host.apply({ ...defaultShellSettings(), proxyInTray: false }, false)
    ).rejects.toThrow('结束')
    expect(f.changed).not.toHaveBeenCalled()
  })
  it('refuses a stale menu checkbox instead of replacing newer preferences', async () => {
    const f = await linked(true)
    const stale = f.checkbox()
    await f.service.save(
      { ...f.service.state().settings, alwaysOnTop: true },
      'visibility-original'
    )
    stale?.click()
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce())
    expect(f.service.state().settings).toMatchObject({ proxyInTray: true, alwaysOnTop: true })
    expect(f.store.save).toHaveBeenCalledOnce()
    expect(f.load).toHaveBeenCalledOnce()
  })
})
