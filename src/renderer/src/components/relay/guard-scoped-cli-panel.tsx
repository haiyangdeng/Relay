import { useEffect, useRef, useState } from 'react'
import { scopedCLIState, type ScopedCLIState } from '../../../../shared/relay/guard-scoped-cli'
import { RelayGuardScopedStoragePanel } from './guard-scoped-storage-panel'

export function RelayGuardScopedCLIPanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [state, setState] = useState<ScopedCLIState>(),
    [prompt, setPrompt] = useState(''),
    [apiKey, setKey] = useState(''),
    [notice, setNotice] = useState('')
  const epoch = useRef(0),
    mounted = useRef(true),
    pending = useRef(false)
  useEffect(() => {
    mounted.current = true
    const ticket = ++epoch.current
    void window.electron.ipcRenderer
      .invoke('relayGuardScopedCLIState')
      .then((raw) => {
        if (mounted.current && ticket === epoch.current) setState(scopedCLIState(raw))
      })
      .catch(() => {
        if (mounted.current && ticket === epoch.current) setNotice('受限会话状态未确认。')
      })
    return () => {
      mounted.current = false
    }
  }, [])
  const action = async (kind: 'State' | 'Launch' | 'Stop'): Promise<void> => {
    if (pending.current) return
    pending.current = true
    const ticket = ++epoch.current,
      input = kind === 'Launch' ? { prompt, apiKey } : undefined
    if (kind === 'Launch') setKey('')
    onBusy(true)
    setNotice('正在处理本次受限会话…')
    try {
      const raw: unknown = await window.electron.ipcRenderer.invoke(
        'relayGuardScopedCLI' + kind,
        input
      )
      if (mounted.current && ticket === epoch.current) {
        setState(scopedCLIState(raw))
        setNotice('本次会话状态已返回；完整保护尚未验收。')
      }
    } catch {
      if (mounted.current && ticket === epoch.current) {
        setState(undefined)
        setNotice('本次请求未完成，没有普通启动或直连回退。发布资源或状态未确认时保留关闭。')
      }
    } finally {
      pending.current = false
      if (mounted.current && ticket === epoch.current) onBusy(false)
    }
  }
  return (
    <section className="relay-panel">
      <h2>显式受限 CLI 会话</h2>
      <p>
        单次非交互提示，仅运行固定 CLI
        与本次普通工具后代；现有项目只读，生成文件仅写本次私有目录，不能直接编辑原项目。HOME
        和可写工作目录独立，不写用户的 Claude 配置。网络只经本次 HTTPS 代理；不包含外部
        CLI、主动禁用 TLS 验证或与本机恶意程序串通的命令。当前固定 CLI
        与发布身份未就绪，启动保持关闭。
      </p>
      <p>
        新会话会创建并挂载独立的 512 MiB 私有磁盘。文件保留在独立的受限 CLI 数据区，不随 Relay
        整套数据重置而移动或清理。入口进程退出不代表全部工具后代已退出；目录不会自动删除，也不会据此显示整树已收尾。
      </p>
      <label>
        本次提示
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={busy}
          maxLength={16384}
        />
      </label>
      <label>
        本次 API key（Relay 不保存到用户配置）
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setKey(event.target.value)}
          disabled={busy}
          maxLength={4096}
        />
      </label>
      <div className="relay-action">
        <button
          disabled={busy || !prompt.trim() || !apiKey || state?.phase === 'running'}
          onClick={() => void action('Launch')}
        >
          启动本次受限会话
        </button>
        <button disabled={busy} onClick={() => void action('State')}>
          读取会话状态
        </button>
        <button disabled={busy} onClick={() => void action('Stop')}>
          停止本次会话
        </button>
      </div>
      <RelayGuardScopedStoragePanel busy={busy} onBusy={onBusy} />
      {notice && <p role="status">{notice}</p>}
      {state && (
        <div className="relay-output">
          <p>
            会话：{state.phase}；实际保护尚未验收。{state.truncated ? '输出已按上限截断。' : ''}
          </p>
          {state.output && <pre>{state.output}</pre>}
        </div>
      )}
    </section>
  )
}
