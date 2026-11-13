import { useEffect, useRef, useState } from 'react'
import {
  defaultShellSettings,
  shellShortcutActions,
  shellThemeLibrary,
  shellTrayIconKinds,
  shellTrayIconData,
  type RelayShellTrayIconKind,
  shellEnvironmentFormats,
  shellTrayProxyGroupStyles,
  shellTrayProxyGroupLabels,
  shellEnvironmentLabels,
  type RelayLoginItemResult,
  type RelayShellAction,
  type RelayShellActionRequest,
  type RelayShellRestartResult,
  type RelayShellSettings,
  type RelayShellState
} from '../../../../shared/relay/shell'
import { officialThemeURL, type OnlineThemeResult } from '../../../../shared/relay/shell-themes'

const shortcutLabels: Record<RelayShellAction, string> = {
  showWindow: '显示主窗口',
  showFloatingWindow: '显示／隐藏浮窗',
  triggerSysProxy: '系统代理恢复／准备（需具体确认）',
  triggerTun: '本次TUN停用／准备（需具体确认）',
  ruleMode: '切换Rule模式',
  globalMode: '切换Global模式',
  directMode: '切换Direct模式',
  copyEnv: '复制自有代理环境变量',
  runInBackground: '后台运行（保留本次核心）',
  restartApp: '重启Relay（需具体确认）',
  quitApp: '退出Relay'
}

export function RelayShellPanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<RelayShellSettings>(defaultShellSettings()),
    [report, setReport] = useState<RelayShellState>(),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    [loginEnabled, setLoginEnabled] = useState<boolean>(),
    [loginNotice, setLoginNotice] = useState(''),
    [trayIconKind, setTrayIconKind] = useState<RelayShellTrayIconKind>('default'),
    [themeId, setThemeId] = useState(''),
    [themeName, setThemeName] = useState(''),
    [online, setOnline] = useState<Extract<OnlineThemeResult, { status: 'ready' }>>(),
    [onlinePath, setOnlinePath] = useState(''),
    [acquiring, setAcquiring] = useState(false),
    themeEpoch = useRef(0),
    draftRevision = useRef(0),
    operation = useRef(false)
  useEffect(() => {
    const clear = (): void => {
      ++themeEpoch.current
      setOnline(undefined)
      setOnlinePath('')
    }
    const unsubscribe = window.electron.ipcRenderer.on('relayShellThemesInvalidated', clear)
    return () => {
      clear()
      unsubscribe()
    }
  }, [])
  const run = async (
    action: 'read' | 'initialize' | 'save' | RelayShellActionRequest
  ): Promise<void> => {
    if (busy || operation.current) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const revision = report?.revision
    setReport(undefined)
    try {
      let next: RelayShellState
      let outcome: unknown
      let restartResult: RelayShellRestartResult | undefined
      if (action === 'save') {
        if (revision === undefined) throw new Error('请先读取设置。')
        next = (await window.electron.ipcRenderer.invoke('relayShellSave', {
          settings: draft,
          revision
        })) as RelayShellState
      } else if (action === 'read' || action === 'initialize') {
        next = (await window.electron.ipcRenderer.invoke(
          action === 'read' ? 'relayShellState' : 'relayShellInitialize'
        )) as RelayShellState
      } else {
        outcome = await window.electron.ipcRenderer.invoke('relayShellAction', action)
        if (action === 'restartApp') {
          if (
            outcome &&
            typeof outcome === 'object' &&
            'status' in outcome &&
            (outcome.status === 'requested' || outcome.status === 'cancelled')
          )
            restartResult = { status: outcome.status }
          else throw new Error('重启回执未确认。')
        }
        next = (await window.electron.ipcRenderer.invoke('relayShellState')) as RelayShellState
      }
      setReport(next)
      if (action === 'read' || action === 'initialize' || action === 'save') {
        ++draftRevision.current
        setDraft(next.settings)
      }
      if (action === 'read' || action === 'initialize') {
        setThemeId('')
        setThemeName('')
      }
      setNotice(
        action === 'restartApp'
          ? restartResult?.status === 'cancelled'
            ? '已取消重启，未安排重新打开。'
            : '重启请求已接受；仍需完成现有恢复与退出确认。'
          : next.uncertain
            ? '窗口设置尚未确认，请重新载入并应用。'
            : typeof action === 'object' || action === 'copyEnv'
              ? '已复制本次自有代理环境变量。'
              : '已读取本次窗口工作流状态。'
      )
    } catch {
      setNotice('操作未确认，当前编辑草稿已保留；请重新读取状态，必要时载入并应用已保存设置。')
      try {
        setReport((await window.electron.ipcRenderer.invoke('relayShellState')) as RelayShellState)
      } catch {
        /* Keep an unknown state rather than an earlier success. */
      }
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const runLogin = async (action: 'read' | 'enable' | 'disable'): Promise<void> => {
    if (busy || operation.current) return
    operation.current = true
    setPending(true)
    onBusy(true)
    setLoginNotice('')
    try {
      if (action === 'read') {
        const observed: unknown = await window.electron.ipcRenderer.invoke('checkAutoRun')
        if (typeof observed !== 'boolean') throw new Error('登录项读取未确认。')
        setLoginEnabled(observed)
        setLoginNotice('已读取系统登录项；没有更改。')
      } else {
        const result = (await window.electron.ipcRenderer.invoke(
          action === 'enable' ? 'enableAutoRun' : 'disableAutoRun'
        )) as RelayLoginItemResult
        setLoginEnabled(result.openAtLogin)
        setLoginNotice(
          result.status === 'cancelled'
            ? '已取消，登录项未更改。'
            : result.status === 'uncertain'
              ? '更改未确认，请核对系统设置后重新读取。'
              : '已重新读取确认系统登录项。'
        )
        if (result.warnings.length) setLoginNotice(result.warnings.join(' '))
      }
    } catch {
      setLoginEnabled(undefined)
      setLoginNotice('登录项状态未确认；仅已打包的macOS Relay支持此操作，请重新读取。')
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const importCSS = async (): Promise<void> => {
    if (busy || operation.current) return
    operation.current = true
    setPending(true)
    onBusy(true)
    try {
      const value: unknown = await window.electron.ipcRenderer.invoke('relayShellCSSImport')
      if (value === undefined) setNotice('已取消文件选择，草稿保持原样。')
      else if (typeof value === 'string') {
        ++draftRevision.current
        setDraft((current) => ({ ...current, customCSS: value }))
        setNotice('CSS已导入草稿；保存并应用前不改变界面。')
      } else throw new Error('CSS读取未确认。')
    } catch {
      setNotice('CSS文件未通过类型、UTF-8或8KiB检查，草稿保持原样。')
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const locked = busy || pending,
    ready = !!(report?.initialized && !report.pending && !report.uncertain),
    update = (next: Partial<RelayShellSettings>): void => {
      ++draftRevision.current
      setDraft({ ...draft, ...next })
    }
  const importTrayIcon = async (): Promise<void> => {
    if (busy || operation.current) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const epoch = themeEpoch.current,
      revision = draftRevision.current,
      kind = trayIconKind
    try {
      const value = await window.electron.ipcRenderer.invoke('relayShellTrayIconImport')
      if (themeEpoch.current !== epoch) return
      if (draftRevision.current !== revision) {
        setNotice('图标草稿已变化，导入结果未合并。')
        return
      }
      if (value === undefined) {
        setNotice('已取消图标选择。')
        return
      }
      const image = shellTrayIconData(value)
      update({ customTrayIcons: { ...draft.customTrayIcons, [kind]: image } })
      setNotice('PNG图标已加入草稿，保存后应用。')
    } catch {
      if (themeEpoch.current === epoch)
        setNotice('PNG图标未导入，原草稿保留。请选择1024像素及256KiB以内的PNG。')
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const importThemeFiles = async (): Promise<void> => {
    if (busy || operation.current) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const epoch = themeEpoch.current,
      revision = draftRevision.current
    try {
      const result = await window.electron.ipcRenderer.invoke('relayShellThemeFilesImport')
      if (themeEpoch.current !== epoch) return
      if (draftRevision.current !== revision) {
        setNotice('主题库草稿已变化，导入结果未合并。')
        return
      }
      if (result === undefined) {
        setNotice('已取消主题文件选择，草稿保持原样。')
        return
      }
      const imported = shellThemeLibrary(result),
        identity = (name: string): string => name.normalize('NFC').toLocaleLowerCase('en-US'),
        names = new Set(draft.themes.map((theme) => identity(theme.name)))
      if (imported.some((theme) => names.has(identity(theme.name))))
        throw new Error('同名主题已存在。')
      const themes = shellThemeLibrary([...draft.themes, ...imported])
      update({ themes })
      setNotice('主题方案已加入库草稿，当前CSS保持原样；选择方案并保存后才应用。')
    } catch {
      if (themeEpoch.current === epoch)
        setNotice('主题文件未导入；原草稿保留，请检查CSS格式、名称唯一和主题库容量。')
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const runOnlineTheme = async (action: 'acquire' | 'draft'): Promise<void> => {
    if (busy || operation.current || !ready) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const epoch = themeEpoch.current,
      revision = draftRevision.current
    try {
      if (action === 'acquire') {
        setAcquiring(true)
        setOnline(undefined)
        setOnlinePath('')
        const result = (await window.electron.ipcRenderer.invoke(
          'relayShellThemesAcquire'
        )) as OnlineThemeResult
        if (themeEpoch.current !== epoch) return
        if (result.status === 'cancelled') setNotice('主题获取已取消，草稿保持原样。')
        else {
          setOnline(result)
          setNotice('候选只在内存中；明确选择后加入主题库草稿，保存并应用前不改变界面。')
        }
      } else {
        if (!online || !onlinePath) throw new Error('请选择在线候选。')
        const themes = await window.electron.ipcRenderer.invoke('relayShellThemesDraft', {
          acquisitionId: online.acquisitionId,
          path: onlinePath,
          themes: draft.themes
        })
        if (themeEpoch.current !== epoch || draftRevision.current !== revision) {
          setNotice('主题候选或编辑草稿已变化，迟到结果未合并。')
          return
        }
        update({ themes: shellThemeLibrary(themes) })
        setNotice('所选主题已加入库草稿，当前CSS保持原样；选择方案并保存后才应用。')
      }
    } catch {
      setNotice(
        '主题获取或合并未确认；原草稿保留，请核对自有HTTP实例、候选有效期、同名和容量限制。'
      )
    } finally {
      setAcquiring(false)
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const editTheme = (action: 'add' | 'update' | 'remove'): void => {
    if (locked) return
    try {
      const selected = draft.themes.find((theme) => theme.id === themeId)
      if (action !== 'add' && !selected) throw new Error('请选择主题。')
      const id = action === 'add' ? crypto.randomUUID() : themeId
      const theme = { id, name: themeName.trim(), css: draft.customCSS }
      const next =
        action === 'remove'
          ? draft.themes.filter((theme) => theme.id !== id)
          : action === 'add'
            ? [...draft.themes, theme]
            : draft.themes.map((current) => (current.id === id ? theme : current))
      update({ themes: shellThemeLibrary(next) })
      setThemeId(action === 'remove' ? '' : id)
      if (action === 'remove') setThemeName('')
      setNotice('主题库草稿已更新。保存并应用窗口设置后才持久化；移除方案保留当前CSS。')
    } catch {
      setNotice('主题库未更改：请检查名称唯一、80字以内、每项CSS 8KiB、合计32KiB及最多16项。')
    }
  }
  const environmentFormats = draft.environmentFormats ?? [draft.environmentFormat]
  const moveEnvironmentFormat = (index: number, offset: number): void => {
    const next = [...environmentFormats],
      target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    update({ environmentFormats: next })
  }
  return (
    <section className="relay-panel relay-profiles">
      <h2>托盘、快捷键与窗口</h2>
      <p>
        设置仅保存到Relay自己的目录。后台运行会隐藏窗口，保留主进程、托盘及本次核心；退出仍会等待当前事务和自有核心收尾。
      </p>
      <div className="relay-action">
        <button disabled={locked} onClick={() => void run('read')}>
          读取窗口设置
        </button>
        <button disabled={locked} onClick={() => void run('initialize')}>
          载入并应用已保存设置
        </button>
        <button disabled={locked || !ready} onClick={() => void run('showWindow')}>
          显示主窗口
        </button>
        <button disabled={locked || !ready} onClick={() => void run('showFloatingWindow')}>
          显示／隐藏浮窗
        </button>
        <button disabled={locked || !ready} onClick={() => void run('restartApp')}>
          重启Relay…
        </button>
        <button disabled={locked || !ready} onClick={() => void run('runInBackground')}>
          后台运行（保留本次核心）
        </button>
      </div>
      <p>
        状态：
        {report
          ? report.uncertain
            ? '待恢复核对'
            : report.initialized
              ? '本次工作流已初始化'
              : '尚未初始化'
          : '尚未读取'}
      </p>
      <h3>登录后启动</h3>
      <p>
        仅操作当前打包Relay。系统登录项与“启动时隐藏窗口”分别设置；备份恢复不会自动添加登录项，也不会清理其他应用的登录项。
      </p>
      <p>
        系统读回：
        {loginEnabled === undefined ? '尚未读取／待核对' : loginEnabled ? '已开启' : '已关闭'}
      </p>
      <div className="relay-action">
        <button disabled={locked} onClick={() => void runLogin('read')}>
          读取登录项
        </button>
        <button disabled={locked || loginEnabled !== false} onClick={() => void runLogin('enable')}>
          开启登录后启动…
        </button>
        <button disabled={locked || loginEnabled !== true} onClick={() => void runLogin('disable')}>
          关闭登录后启动…
        </button>
      </div>
      {loginNotice && <p role="status">{loginNotice}</p>}
      {acquiring && (
        <button
          onClick={() => {
            ++themeEpoch.current
            setOnline(undefined)
            setOnlinePath('')
            void window.electron.ipcRenderer.invoke('relayShellThemesCancel').catch(() => {})
            setNotice('已请求取消主题获取；迟到候选不会合并。')
          }}
        >
          取消主题获取
        </button>
      )}
      <fieldset disabled={locked || !report}>
        <label>
          界面模式
          <select
            aria-label="界面模式"
            value={draft.operationMode}
            onChange={(event) =>
              update({ operationMode: event.target.value as RelayShellSettings['operationMode'] })
            }
          >
            <option value="standard">标准模式</option>
            <option value="simple">简洁模式</option>
          </select>
        </label>
        <label>
          主题
          <select
            aria-label="主题"
            value={draft.appTheme}
            onChange={(event) =>
              update({ appTheme: event.target.value as RelayShellSettings['appTheme'] })
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        {(
          [
            ['silentStart', '下次启动时隐藏主窗口（托盘就绪后生效）'],
            ['alwaysOnTop', '主窗口置顶'],
            ['showFloatingWindow', '应用设置时显示浮窗'],
            ['spinFloatingIcon', '浮窗图标随流量旋转'],
            ['showDockIcon', '在Dock中显示Relay（隐藏前保留托盘入口）'],
            ['disableTray', '隐藏托盘图标（保留Dock入口）'],
            ['swapTrayClick', '互换托盘左右键（左键菜单／右键主窗口）'],
            ['showCurrentProxyInTray', '组名后显示当前代理（读取记录）'],
            ['proxyInTray', '在托盘显示代理组'],
            ['disableTrayIconColor', '使用单色托盘状态图标'],
            ['trayShowTraffic', '在托盘显示本次自有核心速度（默认关闭）']
          ] as const
        ).map(([field, label]) => (
          <label key={field}>
            <span>
              <input
                type="checkbox"
                checked={draft[field]}
                onChange={(event) => update({ [field]: event.target.checked })}
              />{' '}
              {label}
            </span>
          </label>
        ))}
        <label>
          <span>
            <input
              type="checkbox"
              checked={draft.useWindowFrame !== false}
              onChange={(event) => update({ useWindowFrame: event.target.checked })}
            />{' '}
            使用原生主窗口边框（下次启动）
          </span>
        </label>
        <label>
          <span>
            <input
              type="checkbox"
              checked={draft.disableHardwareAcceleration === true}
              onChange={(event) => update({ disableHardwareAcceleration: event.target.checked })}
            />{' '}
            禁用 Relay 硬件加速（下次启动）
          </span>
        </label>
        <label>
          <span>
            <input
              type="checkbox"
              checked={draft.floatingWindowCompatMode !== false}
              onChange={(event) => update({ floatingWindowCompatMode: event.target.checked })}
            />{' '}
            浮窗兼容模式（不透明）
          </span>
        </label>
        <label>
          托盘速度文字颜色
          <select
            value={draft.trayTrafficTextColor ?? 'auto'}
            onChange={(event) => {
              const color = event.target.value
              update({
                trayTrafficTextColor: color === 'black' || color === 'white' ? color : 'auto'
              })
            }}
          >
            <option value="auto">跟随系统</option>
            <option value="black">黑色</option>
            <option value="white">白色</option>
          </select>
        </label>
        <label>
          托盘主窗口触发行为
          <select
            value={draft.triggerMainWindowBehavior}
            onChange={(event) =>
              update({
                triggerMainWindowBehavior: event.target.value === 'toggle' ? 'toggle' : 'show'
              })
            }
          >
            <option value="show">总是显示主窗口</option>
            <option value="toggle">切换显示／隐藏主窗口</option>
          </select>
        </label>
        <p>隐藏托盘图标前，请保留Dock图标，并关闭启动时隐藏主窗口。</p>
        <p>
          状态颜色只按本次会话已确认的记录显示；未知状态使用单色。速度与浮窗共用现有只读统计，不改变节点或网络；未确认时清空数字。
        </p>
        <label>
          自定义托盘图标状态
          <select
            value={trayIconKind}
            onChange={(event) => setTrayIconKind(event.target.value as RelayShellTrayIconKind)}
          >
            {shellTrayIconKinds.map((kind) => (
              <option key={kind} value={kind}>
                {
                  {
                    default: '通用',
                    white: '未开启',
                    blue: '系统代理',
                    green: 'TUN',
                    red: '系统代理与TUN'
                  }[kind]
                }
              </option>
            ))}
          </select>
        </label>
        <div className="relay-action">
          <button disabled={locked} onClick={() => void importTrayIcon()}>
            选择本地PNG图标…
          </button>
          <button
            disabled={locked || !draft.customTrayIcons[trayIconKind]}
            onClick={() =>
              update({ customTrayIcons: { ...draft.customTrayIcons, [trayIconKind]: '' } })
            }
          >
            恢复随包图标
          </button>
        </div>
        <p>图标仅导入草稿；使用随包缩放方案，并跟随系统菜单栏明暗显示。</p>

        <label>
          托盘代理组布局
          <select
            aria-label="托盘代理组布局"
            value={draft.trayProxyGroupStyle}
            onChange={(event) =>
              update({
                trayProxyGroupStyle: event.target.value as RelayShellSettings['trayProxyGroupStyle']
              })
            }
          >
            {shellTrayProxyGroupStyles.map((style) => (
              <option key={style} value={style}>
                {shellTrayProxyGroupLabels[style]}
              </option>
            ))}
          </select>
        </label>
        <p>选择逐组显示或折叠显示。显示开关和布局只调整已读取的菜单，不会自动读取节点或测速。</p>
        <label>
          复制快捷键默认格式
          <select
            aria-label="复制快捷键默认格式"
            value={draft.environmentFormat}
            onChange={(event) =>
              update({
                environmentFormat: event.target.value as RelayShellSettings['environmentFormat']
              })
            }
          >
            {shellEnvironmentFormats.map((format) => (
              <option key={format} value={format}>
                {shellEnvironmentLabels[format]}
              </option>
            ))}
          </select>
        </label>
        <div>
          <p>托盘复制格式（按保存顺序）</p>
          <ol>
            {environmentFormats.map((format, index) => (
              <li key={format}>
                <button disabled={!ready} onClick={() => void run({ action: 'copyEnv', format })}>
                  复制 {shellEnvironmentLabels[format]}
                </button>
                <button
                  aria-label={`上移 ${shellEnvironmentLabels[format]}`}
                  disabled={index === 0}
                  onClick={() => moveEnvironmentFormat(index, -1)}
                >
                  上移
                </button>
                <button
                  aria-label={`下移 ${shellEnvironmentLabels[format]}`}
                  disabled={index + 1 === environmentFormats.length}
                  onClick={() => moveEnvironmentFormat(index, 1)}
                >
                  下移
                </button>
                <button
                  aria-label={`移除 ${shellEnvironmentLabels[format]}`}
                  disabled={environmentFormats.length === 1}
                  onClick={() =>
                    update({
                      environmentFormats: environmentFormats.filter((item) => item !== format)
                    })
                  }
                >
                  移除
                </button>
              </li>
            ))}
          </ol>
          <label>
            添加托盘复制格式
            <select
              value=""
              disabled={environmentFormats.length === shellEnvironmentFormats.length}
              onChange={(event) => {
                const format = shellEnvironmentFormats.find((item) => item === event.target.value)
                if (format && !environmentFormats.includes(format))
                  update({ environmentFormats: [...environmentFormats, format] })
              }}
            >
              <option value="">请选择</option>
              {shellEnvironmentFormats
                .filter((format) => !environmentFormats.includes(format))
                .map((format) => (
                  <option key={format} value={format}>
                    {shellEnvironmentLabels[format]}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <p>仅复制本次自有HTTP代理地址。托盘只配置一种格式时直接复制；原有格式保留NO_PROXY行。</p>
        <label>
          自定义界面CSS（最多8KiB）
          <textarea
            aria-label="自定义界面CSS"
            rows={5}
            value={draft.customCSS}
            maxLength={8192}
            onChange={(event) => update({ customCSS: event.target.value })}
            spellCheck={false}
          />
        </label>
        <p>
          保存并应用后生效。样式不能开放外部网络访问；若遮挡界面，可从顶部Relay原生菜单清除自定义样式。
        </p>
        <button disabled={locked} onClick={() => void importCSS()}>
          从CSS文件导入草稿…
        </button>
        <h3>官方在线主题</h3>
        <p>
          固定来源：{officialThemeURL}
          。经本次已确认的自有HTTP实例获取；latest可变化，单项8KiB之外的主题会列为不支持。
        </p>
        <button disabled={locked || !ready} onClick={() => void runOnlineTheme('acquire')}>
          获取官方主题候选…
        </button>
        {online && (
          <>
            <p>
              压缩包：{online.archiveSize}字节；SHA-256 {online.archiveSHA256}。仅表示本次正文摘要。
            </p>
            <label>
              在线主题候选
              <select
                aria-label="在线主题候选"
                value={onlinePath}
                onChange={(event) => setOnlinePath(event.target.value)}
              >
                <option value="">选择候选</option>
                {online.candidates.map((candidate) => (
                  <option key={candidate.path} value={candidate.path}>
                    {candidate.name}（{candidate.size}字节）
                  </option>
                ))}
              </select>
            </label>
            <button disabled={locked || !onlinePath} onClick={() => void runOnlineTheme('draft')}>
              将所选主题加入库草稿
            </button>
            {online.unsupported.length > 0 && (
              <p>
                未接纳：
                {online.unsupported
                  .map(
                    (item) =>
                      `${item.path}（${item.reason === 'css-too-large' ? '超过8KiB，正文未展开校验' : item.reason === 'name-conflict' ? '主题名冲突' : '主题文本未通过校验'}）`
                  )
                  .join('；')}
              </p>
            )}
          </>
        )}
        <h3>主题方案库</h3>
        <button disabled={locked} onClick={() => void importThemeFiles()}>
          从CSS文件导入主题方案…
        </button>
        <p>
          可一次选择多个CSS文件。导入只加入库草稿，不替换当前CSS；同名或超出容量时整批保留原样。
        </p>
        <label>
          已保存主题方案
          <select
            aria-label="已保存主题方案"
            value={themeId}
            onChange={(event) => {
              const theme = draft.themes.find((theme) => theme.id === event.target.value)
              setThemeId(theme?.id ?? '')
              setThemeName(theme?.name ?? '')
              if (theme) {
                update({ customCSS: theme.css })
                setNotice('主题已填入CSS草稿，保存并应用后生效。')
              }
            }}
          >
            <option value="">选择方案</option>
            {draft.themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          主题方案名称
          <input
            aria-label="主题方案名称"
            value={themeName}
            maxLength={80}
            onChange={(event) => setThemeName(event.target.value)}
          />
        </label>
        <div className="relay-action">
          <button
            disabled={locked || !themeName.trim() || draft.themes.length >= 16}
            onClick={() => editTheme('add')}
          >
            另存为新主题方案
          </button>
          <button
            disabled={locked || !themeId || !themeName.trim()}
            onClick={() => editTheme('update')}
          >
            更新所选方案
          </button>
          <button disabled={locked || !themeId} onClick={() => editTheme('remove')}>
            移除所选方案
          </button>
        </div>
        <p>
          方案库仅保存在本地窗口设置中；编辑、选取和移除先改变草稿，保存后生效。每项最多8KiB，最多16项、合计32KiB。
        </p>
        <h3>全局快捷键</h3>
        <p>
          留空表示不注册。示例：CommandOrControl+Shift+R。快捷键冲突时保留原绑定；切换核心模式继续使用原有确认流程。
        </p>
        {shellShortcutActions.map((action) => (
          <label key={action}>
            {shortcutLabels[action]}
            <input
              value={draft.shortcuts[action]}
              maxLength={100}
              onChange={(event) =>
                update({ shortcuts: { ...draft.shortcuts, [action]: event.target.value } })
              }
            />
          </label>
        ))}
      </fieldset>
      <div className="relay-action">
        <button disabled={locked || !ready} onClick={() => void run('save')}>
          保存并应用窗口设置
        </button>
      </div>
      {report?.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
