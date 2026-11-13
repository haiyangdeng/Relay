import { useEffect, useRef, useState } from 'react'
import { readCoreOwnerState, type CoreOwnerState } from '../../../../shared/relay/core-owner'

export function RelayCoreOwnerPanel(): React.JSX.Element {
  const [state, setState] = useState<CoreOwnerState>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const epoch = useRef(0),
    pending = useRef(false)
  useEffect(() => {
    let active = true
    const sequence = ++epoch.current
    // This reads only Main memory and fixed directory presence. It never
    // starts a helper, contacts a Core or automatically reattaches.
    void window.electron.ipcRenderer
      .invoke('relayCoreOwnerState')
      .then((raw) => {
        if (active && sequence === epoch.current) setState(readCoreOwnerState(raw))
      })
      .catch(() => {
        if (active) setNotice('持久owner状态未确认。')
      })
    return () => {
      active = false
      epoch.current = sequence + 1
    }
  }, [])
  const run = async (
    action: 'inspect' | 'reattach' | 'stop' | 'archive' | 'finalize' | 'quit'
  ): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    const sequence = ++epoch.current
    try {
      const raw =
        action === 'quit'
          ? await window.electron.ipcRenderer.invoke('quitWithoutCore')
          : await window.electron.ipcRenderer.invoke('relayCoreOwnerAction', { action })
      if (sequence === epoch.current) {
        const next = readCoreOwnerState(raw)
        setState(next)
        setNotice(
          next.phase === 'uncertain'
            ? '当前事实未确认，保留实例和记录；已接回仅表示可请求恢复停止。'
            : '已读取实际回执；检查和接回均不启动或重启Core。'
        )
      }
    } catch {
      if (sequence === epoch.current) {
        setNotice('未确认操作结果，保留Main和记录；没有自动重试、接管、重启或改为普通退出。')
        try {
          const next = readCoreOwnerState(
            await window.electron.ipcRenderer.invoke('relayCoreOwnerState')
          )
          if (sequence === epoch.current) setState(next)
        } catch {
          setState(undefined)
        }
      }
    } finally {
      pending.current = false
      if (sequence === epoch.current) setBusy(false)
    }
  }
  return (
    <section className="relay-panel">
      <h2>退出Relay并保留本次代理</h2>
      <p>
        仅适用于启动前明确选择的持久普通HTTP实例。现有Main子Core不会迁移；隐藏窗口仍是原来的后台方式。配对发布身份与资源未就绪时此能力禁用。
      </p>
      <p role="status">
        持久owner：{state?.phase ?? '未确认'}
        {state?.httpPort ? ` · 127.0.0.1:${state.httpPort}` : ''}
        {state?.attached ? ' · 控制已接回' : ''}
      </p>
      <div className="relay-action">
        <button disabled={busy || state?.pending} onClick={() => void run('inspect')}>
          明确检查原owner
        </button>
        <button disabled={busy || !state?.canReattach} onClick={() => void run('reattach')}>
          接回控制
        </button>
        <button
          disabled={busy || !(state?.canStop || state?.canFinalize)}
          onClick={() => void run(state?.canFinalize ? 'finalize' : 'stop')}
        >
          {state?.canFinalize ? '完成已退出实例收尾' : '停止此实例'}
        </button>
        <button disabled={busy || !state?.canArchive} onClick={() => void run('archive')}>
          归档已退出记录
        </button>
        <button disabled={busy || !state?.canDetach} onClick={() => void run('quit')}>
          退出并保留Core
        </button>
      </div>
      <p>
        侧面会话、系统代理/PAC、TUN、过滤器、CLI、独立出口、自动任务或恢复事实未知时保留Main。接回不会证明代理可用；停止会中断接入此端口的连接，需另一次确认。
      </p>
      <p>
        新打开的Relay可检查、接回控制、停止及归档，原端口持续由原owner承载；本页不重建原组控工作区。closed只表示Core已退出，记录归档未完成时仍保留门禁。
      </p>
      {state?.warnings.map((warning, index) => (
        <p key={index}>{warning}</p>
      ))}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
