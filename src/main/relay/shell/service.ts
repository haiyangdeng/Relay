import { randomUUID } from 'crypto'
import {
  defaultShellSettings,
  shellThemeLibrary,
  shellCSS,
  shellTrayIconData,
  shellActionRequest,
  shellSettings,
  shellShortcutActions,
  type RelayShellAction,
  type RelayShellActionRequest,
  type RelayShellRestartResult,
  type RelayShellRecord,
  type RelayShellSettings,
  type RelayShellState,
  type RelayShellTheme
} from '../../../shared/relay/shell'
import type { RelayShellStore } from './store'

export interface RelayShellHost {
  ensureTray(
    actions: readonly RelayShellAction[],
    run: (request: RelayShellActionRequest) => void
  ): void
  registerShortcut(accelerator: string, run: () => void): boolean
  unregisterShortcut(accelerator: string): void
  apply(settings: RelayShellSettings, startup: boolean): Promise<void>
  perform(request: RelayShellActionRequest): Promise<void | RelayShellRestartResult>
  floatingCompatibilityFallback?(): boolean
  showWindow(): void
  dispose(): void
}

export function createRelayShellService(adapters: {
  store: Pick<RelayShellStore, 'read' | 'save'>
  host: RelayShellHost
  notify?(): void
  pickCSS?(): Promise<string | undefined>
  pickTrayIcon?(assertCurrent: () => void): Promise<string | undefined>
  pickThemeFiles?(
    assertCurrent: () => void
  ): Promise<Pick<RelayShellTheme, 'name' | 'css'>[] | undefined>
}) {
  let record: RelayShellRecord = { settings: defaultShellSettings(), revision: '', exists: false },
    displayFailures = 0,
    initialized = false,
    pending = false,
    uncertain = false,
    warnings: string[] = []
  const registered = new Set<string>()
  const idleWaiters: (() => void)[] = []
  const finish = (): void => {
    pending = false
    idleWaiters.splice(0).forEach((resolve) => resolve())
    notify()
  }
  const state = (): RelayShellState => ({
    ...structuredClone(record),
    initialized,
    pending,
    uncertain,
    warnings: [
      ...warnings,
      ...(adapters.host.floatingCompatibilityFallback?.()
        ? ['透明浮窗暂不可用，本次使用不透明兼容模式。']
        : [])
    ]
  })
  const notify = (): void => adapters.notify?.()
  const assertDisplay = (generation: number): void => {
    if (displayFailures !== generation) throw new Error('托盘显示未确认，请重新载入已保存设置。')
  }
  const applyHost = async (settings: RelayShellSettings, startup: boolean): Promise<void> => {
    const generation = displayFailures
    await adapters.host.apply(settings, startup)
    assertDisplay(generation)
  }
  const perform = async (raw: unknown): Promise<void | RelayShellRestartResult> => {
    const request = shellActionRequest(raw)
    if (!initialized || pending || uncertain)
      throw new Error('窗口工作流尚未就绪，请重新读取并应用。')
    pending = true
    try {
      return await adapters.host.perform(request)
    } finally {
      finish()
    }
  }
  const dispatch = (request: RelayShellActionRequest): void => {
    void perform(request).catch(() => {
      warnings = ['本次窗口或快捷键动作未确认；没有自动重试。']
      adapters.host.showWindow()
      notify()
    })
  }
  const register = (settings: RelayShellSettings): string[] => {
    const added: string[] = []
    try {
      for (const accelerator of Object.values(settings.shortcuts)) {
        if (!accelerator || registered.has(accelerator)) continue
        if (
          !adapters.host.registerShortcut(accelerator, () => {
            const action = shellShortcutActions.find(
              (key) => record.settings.shortcuts[key] === accelerator
            )
            if (action) dispatch(action)
          })
        )
          throw new Error('快捷键已被占用；原快捷键保持可用。')
        registered.add(accelerator)
        added.push(accelerator)
      }
      return added
    } catch (error) {
      for (const accelerator of added) {
        adapters.host.unregisterShortcut(accelerator)
        registered.delete(accelerator)
      }
      throw error
    }
  }
  const retire = (settings: RelayShellSettings): void => {
    const keep = new Set(Object.values(settings.shortcuts).filter(Boolean))
    for (const accelerator of registered)
      if (!keep.has(accelerator)) {
        adapters.host.unregisterShortcut(accelerator)
        registered.delete(accelerator)
      }
  }
  return {
    state,
    isBusy: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve(),
    reportDisplayFailure(): void {
      ++displayFailures
      uncertain = true
      warnings = ['托盘显示未确认，已停止托盘速度显示；保留主窗口，请重新载入已保存设置。']
      adapters.host.showWindow()
      notify()
    },
    async importTrayIcon(assertCurrent: () => void): Promise<string | undefined> {
      if (pending) throw new Error('窗口设置操作尚未结束。')
      if (!adapters.pickTrayIcon) throw new Error('图标文件选择尚未接通。')
      pending = true
      try {
        assertCurrent()
        const image = await adapters.pickTrayIcon(assertCurrent)
        assertCurrent()
        return image === undefined ? undefined : shellTrayIconData(image)
      } finally {
        finish()
      }
    },
    async importCSS(): Promise<string | undefined> {
      if (pending) throw new Error('窗口设置操作尚未结束。')
      if (!adapters.pickCSS) throw new Error('CSS文件选择尚未接通。')
      pending = true
      try {
        const text = await adapters.pickCSS()
        return text === undefined ? undefined : shellCSS(text)
      } finally {
        finish()
      }
    },
    async importThemeFiles(assertCurrent: () => void): Promise<RelayShellTheme[] | undefined> {
      if (pending) throw new Error('窗口设置操作尚未结束。')
      if (!adapters.pickThemeFiles) throw new Error('主题文件选择尚未接通。')
      pending = true
      try {
        assertCurrent()
        const themes = await adapters.pickThemeFiles(assertCurrent)
        assertCurrent()
        return themes === undefined
          ? undefined
          : shellThemeLibrary(themes.map((theme) => ({ ...theme, id: randomUUID() })))
      } finally {
        finish()
      }
    },
    async initialize(startup = false): Promise<RelayShellState> {
      if (pending) throw new Error('窗口设置操作尚未结束。')
      pending = true
      const displayAt = displayFailures
      try {
        adapters.host.ensureTray(shellShortcutActions, dispatch)
        const next = await adapters.store.read()
        assertDisplay(displayAt)
        register(next.settings)
        await applyHost(next.settings, startup)
        assertDisplay(displayAt)
        record = next
        retire(next.settings)
        initialized = true
        uncertain = false
        warnings = []
        return { ...state(), pending: false }
      } catch (error) {
        uncertain = true
        warnings = ['窗口设置未能完整应用，主窗口已保留；请重新读取并应用。']
        adapters.host.showWindow()
        throw error
      } finally {
        finish()
        assertDisplay(displayAt)
      }
    },
    async save(raw: unknown, expectedRevision: unknown): Promise<RelayShellState> {
      const next = shellSettings(raw)
      if (!initialized || pending || uncertain) throw new Error('请先重新读取并应用窗口设置。')
      if (typeof expectedRevision !== 'string' || expectedRevision !== record.revision)
        throw new Error('窗口设置版本已变化，请重新读取。')
      pending = true
      const previous = structuredClone(record),
        displayAt = displayFailures
      let applied = false,
        saveAttempted = false
      try {
        if ((await adapters.store.read()).revision !== expectedRevision)
          throw new Error('窗口偏好已被其他操作修改。')
        assertDisplay(displayAt)
        register(next)
        applied = true
        await applyHost(next, false)
        assertDisplay(displayAt)
        saveAttempted = true
        const saved = await adapters.store.save(next, expectedRevision)
        assertDisplay(displayAt)
        record = saved
        retire(next)
        warnings = []
        return { ...state(), pending: false }
      } catch (error) {
        try {
          const current = await adapters.store.read()
          if (
            displayFailures === displayAt &&
            saveAttempted &&
            current.exists &&
            JSON.stringify(current.settings) === JSON.stringify(next)
          ) {
            record = current
            retire(next)
            warnings = ['保存回执曾中断，已重新读取确认窗口偏好。']
            return { ...state(), pending: false }
          }
          if (current.revision !== previous.revision) throw new Error('窗口偏好外部变化。')
          if (applied) await applyHost(previous.settings, false)
          retire(previous.settings)
          record = previous
        } catch {
          uncertain = true
          warnings = ['窗口设置与持久文件未能确认一致；保留入口，请重新读取并应用。']
          adapters.host.showWindow()
        }
        throw error
      } finally {
        finish()
        assertDisplay(displayAt)
      }
    },
    perform,
    dispose(): void {
      if (pending) throw new Error('请等待窗口设置操作结束后退出。')
      for (const accelerator of registered) adapters.host.unregisterShortcut(accelerator)
      registered.clear()
      adapters.host.dispose()
      initialized = false
    }
  }
}
