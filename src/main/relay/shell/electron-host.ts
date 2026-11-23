import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  nativeTheme,
  type MenuItemConstructorOptions
} from 'electron'
import {
  defaultShellSettings,
  shellEnvironmentFormats,
  shellEnvironmentLabels,
  shellTrayProxyGroupStyles,
  shellTrayProxyGroupLabels,
  type RelayShellAction,
  type RelayShellActionRequest,
  type RelayShellEnvironmentFormat,
  type RelayShellRestartResult,
  type RelayShellSettings,
  type RelayShellState
} from '../../../shared/relay/shell'
import {
  relayFloatingArgument,
  relayFloatingReadonlyHash,
  relayFloatingTransparentHash,
  relayFloatingTrafficChannel,
  type RelayFloatingTrafficSample,
  type RelayFloatingTrafficSnapshot
} from '../../../shared/relay/floating-traffic'
import { shellTrayStatus, type ShellTrayObservation } from '../../../shared/relay/shell-tray'
import type { TrayTrafficFrameRequest } from '../../../shared/relay/tray-traffic-frame'
import type { RelayShellHost } from './service'
import { createFloatingTrafficController } from './floating-traffic'
import { trayImage, trayMenuForeground, trayTrafficStyle } from './tray-image'
import { createTrayTrafficFrameGate } from './tray-traffic-frame'
import type { createWindowGeometryHost } from './window-geometry-host'
import type { createWindowGeometryService } from './window-state'

const labels: Record<RelayShellAction, string> = {
  showWindow: '显示窗口',
  showFloatingWindow: '显示悬浮窗',
  triggerSysProxy: '系统代理',
  triggerTun: '虚拟网卡',
  ruleMode: '规则模式',
  globalMode: '全局模式',
  directMode: '直连模式',
  copyEnv: '复制环境变量',
  runInBackground: '后台运行',
  restartApp: '重启应用',
  quitApp: '退出应用'
}

class FloatingLoadFailure extends Error {}

export function createElectronShellHost(adapters: {
  window(): BrowserWindow | null
  iconPath: string
  canPerform?(): boolean
  backgroundChosen?(): void
  trafficFailure?(): void
  currentProxyVisibilityChanged?(visible: boolean): void
  proxyGroupsVisibilityChanged?(visible: boolean): void
  groupStyleChanged?(style: RelayShellSettings['trayProxyGroupStyle']): void
  information?(): ShellTrayObservation
  workflowMenuOpening?(): Promise<void>
  directories?: readonly (
    | { label: string; open(): Promise<void> }
    | { label: string; capture(): ((assertAvailable: () => void) => Promise<void>) | undefined }
  )[]
  preferences?: {
    state(): RelayShellState
    save(settings: RelayShellSettings, revision: string): Promise<void>
    report(): void
  }
  floating?: {
    preloadPath: string
    rendererPath: string
    readTraffic(signal: AbortSignal): Promise<RelayFloatingTrafficSample | undefined>
    geometry?: Pick<
      ReturnType<typeof createWindowGeometryHost>,
      'attach' | 'capture' | 'reconcile' | 'dispose'
    > & {
      resolve: ReturnType<typeof createWindowGeometryService>['resolve']
    }
  }
  perform(request: RelayShellActionRequest): Promise<void | RelayShellRestartResult>
}): RelayShellHost & {
  shouldHideOnClose(): boolean
  invalidateFloatingTraffic(): void
  refreshMenu(): void
  receiveTrayTrafficFrame(raw: unknown): void
  trayTrafficStyle(): { icon: string; colored: boolean; textColor: string }
  setWorkflowMenu(items: MenuItemConstructorOptions[]): void
} {
  const floatingResources = adapters.floating
  let iconSettings = defaultShellSettings(),
    showFloatingTraffic = false,
    showTrayTraffic = false
  let disposed = false
  let opaqueFallback = false
  let reportingDisplayFailure = false
  let menuPending = false
  let swapTrayClick = false
  let contextMenu: ReturnType<typeof Menu.buildFromTemplate> | undefined
  let tray: Tray | undefined,
    floating: BrowserWindow | undefined,
    floatingLoad: Promise<void> | undefined,
    floatingLoadWindow: BrowserWindow | undefined,
    closeToTray = false,
    workflowItems: MenuItemConstructorOptions[] = [],
    commandItems = (): MenuItemConstructorOptions[] => []
  const trayFrames = createTrayTrafficFrameGate()
  let plainTrayImage: Electron.NativeImage | undefined, paintedAt: number | undefined
  const resetTrayFrame = (): void => {
    trayFrames.cancel()
    const painted = paintedAt !== undefined
    paintedAt = undefined
    if (painted && tray && !tray.isDestroyed() && plainTrayImage) tray.setImage(plainTrayImage)
  }
  const publishTraySnapshot = (snapshot: RelayFloatingTrafficSnapshot): void => {
    const owner = tray,
      view = adapters.window(),
      settings = iconSettings,
      base = plainTrayImage,
      color = settings.trayTrafficTextColor
    if (!showTrayTraffic || !owner || owner.isDestroyed()) return
    const rate = (n: number): string =>
      n >= 1048576
        ? `${(n / 1048576).toFixed(1)}M`
        : n >= 1024
          ? `${(n / 1024).toFixed(1)}K`
          : `${n}B`
    const title =
      snapshot.status === 'ready'
        ? `↑${rate(snapshot.sample.up)}/s ↓${rate(snapshot.sample.down)}/s`
        : ''
    if (
      snapshot.status !== 'ready' ||
      (color !== 'white' && color !== 'black') ||
      process.platform !== 'darwin' ||
      !base ||
      !view ||
      view.isDestroyed() ||
      view.webContents.isDestroyed()
    ) {
      resetTrayFrame()
      owner.setTitle(title, { fontType: 'monospacedDigit' })
      return
    }
    if (paintedAt !== undefined && performance.now() - paintedAt >= 2000) resetTrayFrame()
    if (paintedAt === undefined) owner.setTitle(title, { fontType: 'monospacedDigit' })
    const sourceFrame = view.webContents.mainFrame
    const id = trayFrames.request((bytes) => {
      if (
        disposed ||
        !showTrayTraffic ||
        tray !== owner ||
        owner.isDestroyed() ||
        iconSettings !== settings ||
        plainTrayImage !== base ||
        adapters.window() !== view ||
        view.isDestroyed() ||
        view.webContents.isDestroyed() ||
        view.webContents.mainFrame !== sourceFrame ||
        floatingTraffic?.state() !== snapshot
      )
        return
      let image: Electron.NativeImage
      try {
        image = nativeImage.createFromBuffer(bytes, { scaleFactor: 2 })
      } catch {
        return
      }
      if (image.isEmpty()) return
      image.setTemplateImage(false)
      owner.setImage(image)
      paintedAt = performance.now()
      owner.setTitle('')
    })
    try {
      view.webContents.send('relayTrayTrafficDraw', {
        id,
        icon: base.toDataURL(),
        iconTint: base.isTemplateImage() ? trayMenuForeground() : undefined,
        textColor: color === 'white' ? '#ffffff' : '#000000',
        up: snapshot.sample.up,
        down: snapshot.sample.down
      } satisfies TrayTrafficFrameRequest)
    } catch {
      resetTrayFrame()
      owner.setTitle(title, { fontType: 'monospacedDigit' })
    }
  }
  const publishFloatingSnapshot = (snapshot: RelayFloatingTrafficSnapshot): void => {
    const target = floating
    if (!showFloatingTraffic || !target || !canReadFloating(target)) return
    try {
      target.webContents.send(relayFloatingTrafficChannel, {
        ...snapshot,
        spinFloatingIcon: iconSettings.spinFloatingIcon
      } satisfies RelayFloatingTrafficSnapshot)
    } catch {
      // A closing display has no authority over the Core or its read lane.
    }
  }
  const floatingTraffic = floatingResources
    ? createFloatingTrafficController({
        readTraffic: (signal) => floatingResources.readTraffic(signal),
        publish: (snapshot) => {
          if (disposed) return
          try {
            publishTraySnapshot(snapshot)
          } catch {
            reportDisplayFailure()
          }
          publishFloatingSnapshot(snapshot)
        }
      })
    : undefined
  const showWindow = (): void => {
    if (disposed) return
    const window = adapters.window()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  interface FloatingCSSState {
    key?: string
    css: string
    keys: Set<string>
    uncertain: boolean
    queue: Promise<void>
  }
  const floatingStyles = new WeakMap<BrowserWindow, FloatingCSSState>()
  let floatingCSS = '',
    floatingStyleEpoch = 0
  const syncTraffic = (): void => {
    if (showFloatingTraffic || showTrayTraffic) floatingTraffic?.show()
    else floatingTraffic?.hide()
  }
  const setFloatingTraffic = (value: boolean): void => {
    showFloatingTraffic = value
    syncTraffic()
  }
  const floatingStyleOwner = (target: BrowserWindow): boolean =>
    !disposed && floating === target && !target.isDestroyed() && !target.webContents.isDestroyed()
  const markFloatingStyleUnknown = (target: BrowserWindow, state: FloatingCSSState): void => {
    state.uncertain = true
    if (floating === target) setFloatingTraffic(false)
    try {
      if (!target.isDestroyed()) target.hide()
    } finally {
      if (floating === target) showWindow()
    }
  }
  const syncFloatingCSS = (target: BrowserWindow): Promise<number> => {
    let state = floatingStyles.get(target)
    if (!state) {
      state = { css: '', keys: new Set(), uncertain: false, queue: Promise.resolve() }
      floatingStyles.set(target, state)
    }
    const record = state,
      epoch = floatingStyleEpoch,
      css = floatingCSS
    const current = (): boolean =>
      floatingStyleOwner(target) &&
      floatingStyleEpoch === epoch &&
      (!adapters.canPerform || adapters.canPerform())
    const assertCurrent = (): void => {
      if (!current()) throw new Error('浮窗样式请求已过期，未确认应用。')
    }
    const run = async (): Promise<number> => {
      assertCurrent()
      if (record.uncertain) throw new Error('浮窗样式未确认，请重新载入并应用窗口设置。')
      if (record.css === css) return epoch
      if (!css) {
        if (record.key) {
          const key = record.key
          try {
            await target.webContents.removeInsertedCSS(key)
          } catch {
            markFloatingStyleUnknown(target, record)
            throw new Error('浮窗样式清除未确认，已保留恢复记录。')
          }
          record.keys.delete(key)
          record.key = undefined
        }
        record.css = ''
        assertCurrent()
        return epoch
      }
      let key: string
      try {
        key = await target.webContents.insertCSS(css)
        if (!key) throw new Error('样式回执为空。')
      } catch {
        markFloatingStyleUnknown(target, record)
        throw new Error('浮窗样式插入未确认，已保留原样式记录。')
      }
      record.keys.add(key)
      if (!current()) {
        try {
          if (!target.isDestroyed() && !target.webContents.isDestroyed())
            await target.webContents.removeInsertedCSS(key)
          record.keys.delete(key)
        } catch {
          markFloatingStyleUnknown(target, record)
        }
        throw new Error('浮窗样式请求已过期，未确认应用。')
      }
      const previous = record.key
      if (previous) {
        try {
          await target.webContents.removeInsertedCSS(previous)
        } catch {
          markFloatingStyleUnknown(target, record)
          throw new Error('浮窗旧样式移除未确认，已保留两个样式标识。')
        }
        record.keys.delete(previous)
      }
      record.key = key
      record.css = css
      assertCurrent()
      return epoch
    }
    const task = record.queue.then(run, run)
    record.queue = task.then(
      () => {},
      () => {}
    )
    return task
  }
  let loadedFloating: BrowserWindow | undefined
  const canReadFloating = (target: BrowserWindow): boolean =>
    !disposed &&
    floating === target &&
    loadedFloating === target &&
    !floatingStyles.get(target)?.uncertain &&
    !target.isDestroyed() &&
    !target.webContents.isDestroyed() &&
    target.isVisible() &&
    !target.isMinimized() &&
    (!adapters.canPerform || adapters.canPerform())
  const syncFloatingVisibility = (target: BrowserWindow): void => {
    if (floating !== target) return
    if (!canReadFloating(target)) {
      setFloatingTraffic(false)
      return
    }
    const alreadyPollingForTray = !showFloatingTraffic && showTrayTraffic
    setFloatingTraffic(true)
    if (alreadyPollingForTray && floatingTraffic) publishFloatingSnapshot(floatingTraffic.state())
  }
  const showFloatingMode = (opaque: boolean): Promise<void> => {
    if (disposed || !floatingResources || !floatingTraffic)
      return Promise.reject(new Error('只读浮窗资源尚未准备。'))
    if (floatingLoad) return floatingLoad
    if (floating && !floating.isDestroyed()) {
      const current = floating
      return (async () => {
        const epoch = await syncFloatingCSS(current)
        if (!floatingStyleOwner(current) || floatingStyleEpoch !== epoch)
          throw new Error('浮窗在样式确认后已变化。')
        floatingResources.geometry?.reconcile()
        current.show()
        syncFloatingVisibility(current)
      })()
    }
    const geometry = floatingResources.geometry?.resolve()
    let next: BrowserWindow
    try {
      next = new BrowserWindow({
        title: 'Relay',
        width: 260,
        height: 110,
        ...geometry?.bounds,
        ...(geometry ? { minWidth: geometry.minWidth, minHeight: geometry.minHeight } : {}),
        frame: false,
        show: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        ...(!opaque ? { transparent: true, backgroundColor: '#00000000' } : {}),
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          javascript: true,
          preload: floatingResources.preloadPath,
          additionalArguments: [relayFloatingArgument]
        }
      })
    } catch (cause) {
      if (opaque) throw cause
      throw new FloatingLoadFailure('浮窗未能创建。', { cause })
    }
    floating = next
    const styleEpoch = floatingStyleEpoch
    floatingResources.geometry?.attach(next)
    const destroyNext = (): void => {
      if (floating === next) floatingResources.geometry?.capture()
      if (!next.isDestroyed()) next.destroy()
    }
    next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    next.webContents.on('will-navigate', (event) => event.preventDefault())
    next.webContents.on('context-menu', () => {
      if (!canReadFloating(next)) return
      updateMenuSafely(() => contextMenu?.popup({ window: next }))
    })
    next.on('hide', () => {
      if (floating === next) {
        floatingResources.geometry?.capture()
        floatingTraffic.hide()
      }
    })
    next.on('minimize', () => {
      if (floating === next) floatingTraffic.hide()
    })
    next.on('show', () => syncFloatingVisibility(next))
    next.on('restore', () => syncFloatingVisibility(next))
    let rendererFailed = false
    const rendererFailure = (): void => {
      if (floating !== next) return
      rendererFailed = true
      if (!opaque && loadedFloating === next) {
        opaqueFallback = true
        showWindow()
      }
      floatingTraffic.hide()
      destroyNext()
    }
    next.webContents.on('preload-error', rendererFailure)
    next.webContents.on('render-process-gone', rendererFailure)
    next.on('closed', () => {
      if (floatingLoadWindow === next) {
        floatingLoad = undefined
        floatingLoadWindow = undefined
      }
      if (floating === next) {
        floatingTraffic.hide()
        floatingResources.geometry?.dispose()
        floating = undefined
        if (loadedFloating === next) loadedFloating = undefined
      }
    })
    const loading = (async () => {
      try {
        try {
          await next.loadFile(floatingResources.rendererPath, {
            hash: opaque ? relayFloatingReadonlyHash : relayFloatingTransparentHash
          })
        } catch (cause) {
          if (opaque) throw cause
          throw new FloatingLoadFailure('浮窗未能加载。', { cause })
        }
        if (rendererFailed && !opaque) throw new FloatingLoadFailure('浮窗在加载完成前已结束。')
        if (
          disposed ||
          floating !== next ||
          next.isDestroyed() ||
          (adapters.canPerform && !adapters.canPerform())
        )
          throw new Error('浮窗在加载完成前已结束。')
        if (floatingStyleEpoch !== styleEpoch) throw new Error('浮窗加载期间窗口设置已变化。')
        const epoch = await syncFloatingCSS(next)
        if (!floatingStyleOwner(next) || floatingStyleEpoch !== epoch)
          throw new Error('浮窗在样式确认后已变化。')
        loadedFloating = next
        next.show()
        syncFloatingVisibility(next)
      } catch (error) {
        destroyNext()
        if (floating === next) {
          floatingTraffic.hide()
          floating = undefined
        }
        throw error
      }
    })()
    if (floating === next && !next.isDestroyed()) {
      floatingLoad = loading
      floatingLoadWindow = next
    }
    return loading.finally(() => {
      if (floatingLoad === loading) {
        floatingLoad = undefined
        floatingLoadWindow = undefined
      }
    })
  }
  const showFloating = async (): Promise<void> => {
    const opaque = iconSettings.floatingWindowCompatMode !== false || opaqueFallback
    const epoch = floatingStyleEpoch
    try {
      await showFloatingMode(opaque)
    } catch (error) {
      if (
        opaque ||
        !(error instanceof FloatingLoadFailure) ||
        disposed ||
        floatingStyleEpoch !== epoch ||
        (adapters.canPerform && !adapters.canPerform())
      )
        throw error
      await showFloatingMode(true)
      if (!disposed && floatingStyleEpoch === epoch) opaqueFallback = true
    }
  }
  const preferenceMenu = (): MenuItemConstructorOptions[] => {
    const preferences = adapters.preferences
    if (!preferences) return []
    const record = preferences.state()
    const ready =
      record.initialized &&
      !record.pending &&
      !record.uncertain &&
      !menuPending &&
      !disposed &&
      (!adapters.canPerform || adapters.canPerform())
    const save = (patch: Partial<RelayShellSettings>): void => {
      if (disposed) return
      const current = preferences.state()
      if (
        !ready ||
        disposed ||
        menuPending ||
        !current.initialized ||
        current.pending ||
        current.uncertain ||
        current.revision !== record.revision ||
        (adapters.canPerform && !adapters.canPerform())
      ) {
        showWindow()
        preferences.report()
        return
      }
      menuPending = true
      updateMenuSafely()
      void (async () => {
        try {
          await preferences.save({ ...structuredClone(record.settings), ...patch }, record.revision)
        } catch {
          if (disposed) return
          showWindow()
          preferences.report()
        } finally {
          menuPending = false
          updateMenuSafely()
        }
      })()
    }
    return [
      {
        label: '窗口偏好',
        enabled: ready,
        submenu: [
          { label: '在工作区查看窗口设置', click: showWindow },
          ...(
            [
              ['alwaysOnTop', '主窗口置顶'],
              ['showDockIcon', '在Dock中显示Relay'],
              ['swapTrayClick', '互换托盘左右键'],
              ['showCurrentProxyInTray', '组名后显示当前代理（读取记录）'],
              ['proxyInTray', '在托盘显示代理组']
            ] as const
          ).map(([key, label]) => ({
            label,
            type: 'checkbox' as const,
            checked: record.settings[key],
            click: () => save({ [key]: !record.settings[key] })
          })),
          {
            label: '托盘代理组布局',
            submenu: shellTrayProxyGroupStyles.map((style) => ({
              label: shellTrayProxyGroupLabels[style],
              type: 'radio' as const,
              checked: record.settings.trayProxyGroupStyle === style,
              click: () => save({ trayProxyGroupStyle: style })
            }))
          },
          {
            label: '复制环境变量格式',
            submenu: shellEnvironmentFormats.map((format) => ({
              label: shellEnvironmentLabels[format],
              type: 'radio' as const,
              checked: record.settings.environmentFormat === format,
              click: () => save({ environmentFormat: format })
            }))
          }
        ]
      },
      { label: '关于 Relay', role: 'about' }
    ]
  }
  // Keep the fixed upstream ordering while retaining Relay's owned-instance actions.
  const menuTemplate = (): MenuItemConstructorOptions[] => {
    const commands = commandItems()
    const section = (...actions: RelayShellAction[]): MenuItemConstructorOptions[] =>
      actions.flatMap((action) => commands.filter((item) => item.id === action))
    return [
      ...section('showWindow', 'showFloatingWindow', 'ruleMode', 'globalMode', 'directMode'),
      { type: 'separator' },
      ...section('triggerSysProxy', 'triggerTun'),
      { type: 'separator' },
      ...workflowItems,
      ...(workflowItems.length ? [{ type: 'separator' as const }] : []),
      ...(adapters.directories?.length
        ? [
            {
              label: '打开目录',
              submenu: adapters.directories.map((directory) => {
                const owner = tray
                const captured = 'capture' in directory
                const open = captured ? directory.capture() : () => directory.open()
                const available = (): boolean =>
                  !disposed &&
                  (adapters.canPerform?.() ?? true) &&
                  (!captured || (!!owner && tray === owner && !owner.isDestroyed()))
                return {
                  label: directory.label,
                  enabled: !!open,
                  click: () => {
                    if (!open || !available()) return
                    void open(() => {
                      if (!available()) throw new Error('托盘操作入口已失效。')
                    }).catch(() => {
                      if (!available()) return
                      showWindow()
                      adapters.preferences?.report()
                    })
                  }
                }
              })
            }
          ]
        : []),
      ...section('copyEnv'),
      ...preferenceMenu(),
      { type: 'separator' },
      ...section('runInBackground', 'restartApp', 'quitApp')
    ]
  }
  const updateMenu = (): void => {
    if (disposed) return
    contextMenu = Menu.buildFromTemplate(menuTemplate())
    if (tray && !tray.isDestroyed()) {
      trayFrames.cancel()
      paintedAt = undefined
      plainTrayImage = trayImage(
        iconSettings,
        adapters.information?.() ?? { systemProxy: undefined, tun: undefined }
      )
      tray.setImage(plainTrayImage)
      if (adapters.information)
        tray.setToolTip(
          `${shellTrayStatus(adapters.information()).tooltip}\n本次会话记录，非实时系统复核\n状态点不代表 Claude/Codex 防直连保护`
        )
      // Electron v43.8.0 Cocoa opens an attached menu from mouseDown (left),
      // while rightMouseUp only emits right-click. Route both explicitly.
      tray.setContextMenu(null)
      if (floatingTraffic) publishTraySnapshot(floatingTraffic.state())
    }
  }
  const reportDisplayFailure = (): void => {
    if (disposed) return
    showTrayTraffic = false
    syncTraffic()
    if (reportingDisplayFailure) return
    reportingDisplayFailure = true
    try {
      try {
        resetTrayFrame()
      } catch {
        /* Retain the main window if the native icon cannot be restored. */
      }
      showWindow()
      adapters.trafficFailure?.()
    } catch {
      /* A broken display must not affect Core or the floating consumer. */
    } finally {
      reportingDisplayFailure = false
    }
  }
  const updateMenuSafely = (after?: () => void): void => {
    if (disposed) return
    try {
      updateMenu()
      after?.()
    } catch {
      reportDisplayFailure()
    }
  }
  const ensureTrayIcon = (): void => {
    if (!tray || tray.isDestroyed()) {
      const icon = trayImage(
        iconSettings,
        adapters.information?.() ?? { systemProxy: undefined, tun: undefined }
      )
      const owner = new Tray(icon)
      tray = owner
      owner.setToolTip('Relay')
      const current = (): boolean => !disposed && tray === owner && !owner.isDestroyed()
      let opening = false
      const popup = (): void => {
        if (!current() || opening) return
        const show = (): void => {
          if (!current()) return
          updateMenuSafely(() => {
            if (current() && contextMenu) owner.popUpContextMenu(contextMenu)
          })
        }
        if (!adapters.workflowMenuOpening) return show()
        opening = true
        void Promise.resolve()
          .then(() => (current() ? adapters.workflowMenuOpening?.() : undefined))
          .catch(() => {
            // Keep window/quit controls available if a read-only refresh failed.
          })
          .finally(() => {
            opening = false
            show()
          })
      }
      const activateWindow = (): void => {
        if (!current()) return
        const window = adapters.window()
        if (
          iconSettings.triggerMainWindowBehavior === 'toggle' &&
          !menuPending &&
          (!adapters.canPerform || adapters.canPerform()) &&
          window &&
          !window.isDestroyed() &&
          !window.isMinimized() &&
          window.isVisible()
        ) {
          const preferences = adapters.preferences?.state()
          if (
            !preferences ||
            (preferences.initialized && !preferences.pending && !preferences.uncertain)
          ) {
            // The close event can initiate quit; this click only changes visibility.
            try {
              window.hide()
              if (
                current() &&
                adapters.window() === window &&
                !window.isDestroyed() &&
                !window.isVisible() &&
                (!adapters.canPerform || adapters.canPerform())
              )
                return
            } catch {
              // Restore the window if hiding could not be confirmed.
            }
          }
        }
        showWindow()
      }
      owner.on('click', () => {
        if (swapTrayClick) popup()
        else activateWindow()
      })
      owner.on('right-click', () => {
        if (swapTrayClick) activateWindow()
        else popup()
      })
    }
  }
  const refreshTrayAppearance = (): void => {
    if (!disposed && tray && !tray.isDestroyed()) updateMenuSafely()
  }
  nativeTheme.on('updated', refreshTrayAppearance)
  return {
    refreshMenu: updateMenuSafely,
    receiveTrayTrafficFrame(raw) {
      try {
        trayFrames.receive(raw)
      } catch {
        reportDisplayFailure()
      }
    },
    trayTrafficStyle: () =>
      trayTrafficStyle(
        iconSettings,
        adapters.information?.() ?? { systemProxy: undefined, tun: undefined }
      ),
    invalidateFloatingTraffic: () => {
      floatingTraffic?.invalidate()
      const current = floating
      setFloatingTraffic(!!current && canReadFloating(current))
    },
    setWorkflowMenu(items: MenuItemConstructorOptions[]): void {
      workflowItems = items
      updateMenuSafely()
    },
    ensureTray(actions, run) {
      ensureTrayIcon()
      commandItems = () => {
        const settings = iconSettings,
          owner = tray
        const formats = settings.environmentFormats ?? [settings.environmentFormat]
        const copy = (format: RelayShellEnvironmentFormat): void => {
          if (
            disposed ||
            iconSettings !== settings ||
            tray !== owner ||
            owner?.isDestroyed() ||
            (adapters.canPerform && !adapters.canPerform())
          )
            return
          run({ action: 'copyEnv', format })
        }
        const observed = adapters.information?.()
        return actions.map((action): MenuItemConstructorOptions => {
          const base: MenuItemConstructorOptions = {
            id: action,
            label: labels[action],
            accelerator:
              action === 'quitApp' ? 'CommandOrControl+Q' : settings.shortcuts[action] || undefined,
            click: () => run(action)
          }
          if (action === 'showFloatingWindow')
            return {
              ...base,
              label:
                floating && !floating.isDestroyed() && floating.isVisible()
                  ? '隐藏悬浮窗'
                  : labels.showFloatingWindow
            }
          if (action === 'ruleMode' || action === 'globalMode' || action === 'directMode') {
            const modes = { ruleMode: 'rule', globalMode: 'global', directMode: 'direct' } as const
            return { ...base, type: 'radio', checked: observed?.mode === modes[action] }
          }
          if (action === 'triggerSysProxy' || action === 'triggerTun') {
            const checked = action === 'triggerSysProxy' ? observed?.systemProxy : observed?.tun
            return {
              ...base,
              label:
                observed && checked === undefined
                  ? `${labels[action]}（状态未获取）`
                  : labels[action],
              type: 'checkbox',
              ...(action === 'triggerSysProxy'
                ? { click: () => run({ action, enabled: checked !== true }) }
                : {}),
              checked: checked === true
            }
          }
          if (action !== 'copyEnv') return base
          return formats.length === 1
            ? { ...base, click: () => copy(formats[0]) }
            : {
                ...base,
                click: undefined,
                submenu: formats.map((format) => ({
                  label: shellEnvironmentLabels[format],
                  click: () => copy(format)
                }))
              }
        })
      }
      updateMenu()
    },
    registerShortcut: (accelerator, run) => globalShortcut.register(accelerator, run),
    unregisterShortcut: (accelerator) => globalShortcut.unregister(accelerator),
    async apply(settings: RelayShellSettings, startup) {
      if (disposed) throw new Error('窗口工作流已结束。')
      if (settings.trayShowTraffic && !floatingResources)
        throw new Error('本次只读速度通道尚未接通。')
      const window = adapters.window()
      if (!window || window.isDestroyed()) throw new Error('主窗口不可用。')
      if (settings.disableTray && (!settings.showDockIcon || settings.silentStart))
        throw new Error('隐藏托盘图标前，请保留Dock图标，并关闭启动时隐藏主窗口。')
      ++floatingStyleEpoch
      floatingCSS = settings.customCSS
      const unknown = floating
      const compatibilityChanged =
        (settings.floatingWindowCompatMode !== false) !==
        (iconSettings.floatingWindowCompatMode !== false)
      if (compatibilityChanged) opaqueFallback = false
      if (unknown && (compatibilityChanged || floatingStyles.get(unknown)?.uncertain)) {
        setFloatingTraffic(false)
        showWindow()
        unknown.hide()
        if (floating !== unknown || disposed) throw new Error('待恢复浮窗已变化。')
        floatingResources?.geometry?.capture()
        unknown.destroy()
        if (!unknown.isDestroyed()) throw new Error('未确认关闭待恢复浮窗，保留主窗口。')
        if (floating === unknown) floating = undefined
        if (loadedFloating === unknown) loadedFloating = undefined
      }
      const spinPreferenceChanged = iconSettings.spinFloatingIcon !== settings.spinFloatingIcon
      resetTrayFrame()
      iconSettings = settings
      if (!settings.disableTray) ensureTrayIcon()
      nativeTheme.themeSource = settings.appTheme
      window.setAlwaysOnTop(settings.alwaysOnTop)
      closeToTray = settings.closeToTray
      swapTrayClick = settings.swapTrayClick
      adapters.currentProxyVisibilityChanged?.(settings.showCurrentProxyInTray)
      adapters.proxyGroupsVisibilityChanged?.(settings.proxyInTray)
      adapters.groupStyleChanged?.(settings.trayProxyGroupStyle)
      updateMenu()
      if (settings.showFloatingWindow) {
        await showFloating()
        if (spinPreferenceChanged && floatingTraffic)
          publishFloatingSnapshot(floatingTraffic.state())
      } else {
        const current = floating
        if (current && loadedFloating === current) {
          const epoch = await syncFloatingCSS(current)
          if (!floatingStyleOwner(current) || floatingStyleEpoch !== epoch)
            throw new Error('浮窗在样式确认后已变化。')
        }
        setFloatingTraffic(false)
        current?.hide()
      }
      if (!settings.showDockIcon && (!tray || tray.isDestroyed()))
        throw new Error('隐藏Dock前必须保留可用托盘入口。')
      if (app.dock) {
        if (settings.showDockIcon && !app.dock.isVisible()) await app.dock.show()
        else if (!settings.showDockIcon && app.dock.isVisible()) app.dock.hide()
      } else if (!settings.showDockIcon) throw new Error('当前平台不支持Dock设置。')
      if (window.isDestroyed()) throw new Error('应用Dock设置期间主窗口已结束。')
      if (settings.disableTray) {
        if (disposed || !app.dock?.isVisible()) throw new Error('Dock入口尚未确认，保留托盘图标。')
        showWindow()
        if (window.isDestroyed() || !window.isVisible())
          throw new Error('主窗口尚未显示，保留托盘图标。')
        if (tray && !tray.isDestroyed()) tray.destroy()
        tray = undefined
      }
      if (settings.trayShowTraffic && tray && !tray.isDestroyed()) tray.setTitle('')
      showTrayTraffic =
        settings.trayShowTraffic && !settings.disableTray && !!tray && !tray.isDestroyed()
      if (!showTrayTraffic) {
        resetTrayFrame()
        if (tray && !tray.isDestroyed()) tray.setTitle('')
      }
      syncTraffic()
      if (startup && settings.silentStart) {
        if (!tray || tray.isDestroyed()) throw new Error('托盘尚未就绪，保留主窗口。')
        window.hide()
      } else showWindow()
    },
    async perform(request) {
      const action = typeof request === 'string' ? request : request.action
      if (adapters.canPerform && !adapters.canPerform()) throw new Error('退出恢复正在进行。')
      if (action === 'runInBackground') {
        const window = adapters.window()
        if (disposed || !window || window.isDestroyed() || !tray || tray.isDestroyed())
          throw new Error('后台运行前必须保留主窗口和可用托盘入口。')
        adapters.backgroundChosen?.()
        setFloatingTraffic(false)
        floating?.hide()
        window.hide()
        if (
          window.isDestroyed() ||
          !tray ||
          tray.isDestroyed() ||
          window.isVisible() ||
          (adapters.canPerform && !adapters.canPerform())
        ) {
          showWindow()
          throw new Error('后台运行状态未确认，请保留工作区并重新核对。')
        }
        return
      }
      if (action === 'showWindow') return showWindow()
      if (action === 'showFloatingWindow') {
        if (floating && !floating.isDestroyed() && floating.isVisible()) {
          setFloatingTraffic(false)
          floating.hide()
        } else await showFloating()
        return
      }
      return await adapters.perform(request)
    },
    showWindow,
    floatingCompatibilityFallback: () => opaqueFallback,
    shouldHideOnClose: () => closeToTray && !!tray && !tray.isDestroyed(),
    dispose() {
      disposed = true
      nativeTheme.removeListener('updated', refreshTrayAppearance)
      trayFrames.cancel()
      ++floatingStyleEpoch
      floatingTraffic?.dispose()
      floatingResources?.geometry?.capture()
      if (floating && !floating.isDestroyed()) floating.destroy()
      floating = undefined
      floatingResources?.geometry?.dispose()
      if (tray && !tray.isDestroyed()) tray.destroy()
      tray = undefined
      contextMenu = undefined
      closeToTray = false
    }
  }
}
