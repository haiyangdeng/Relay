import { useRef, useState } from 'react'
import type { AiClientAssociation } from '../../../../shared/relay/ai-clients'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'

export function RelayAiClientsPanel({
  state,
  claudeCodePort,
  busy,
  onBusy,
  onAssociate
}: {
  state?: LocalProxyState
  claudeCodePort: number
  busy: boolean
  onBusy(value: boolean): void
  onAssociate(port: number, route: string): void
}): React.JSX.Element {
  const [report, setReport] = useState<AiClientAssociation>(),
    [notice, setNotice] = useState(''),
    operation = useRef(false)
  const current =
    report?.owned.running === true &&
    state?.phase === 'running' &&
    state.owned &&
    !state.pending &&
    !state.uncertain &&
    !!state.instanceId &&
    !!state.pid &&
    !!state.configurationRevision &&
    report.owned.instanceId === state.instanceId &&
    report.owned.pid === state.pid &&
    report.owned.configurationRevision === state.configurationRevision
  const dedicated = current ? report.owned.dedicated : undefined
  const httpPort = report?.owned.httpLive ? dedicated?.httpPort : undefined
  const socksPort = report?.owned.socksLive ? dedicated?.socksPort : undefined
  const inspect = async (): Promise<void> => {
    if (operation.current) return
    operation.current = true
    onBusy(true)
    setReport(undefined)
    setNotice('核对本次实例的监听端口…')
    try {
      const request =
        Number.isInteger(claudeCodePort) && claudeCodePort >= 1024 && claudeCodePort <= 65535
          ? { claudeCodePort }
          : undefined
      setReport(
        (await window.electron.ipcRenderer.invoke(
          'relayDedicatedInspect',
          request
        )) as AiClientAssociation
      )
      setNotice('监听检查已完成。')
    } catch {
      setNotice('监听归属未确认，请刷新实例状态后重新检查。')
    } finally {
      operation.current = false
      onBusy(false)
    }
  }
  const copyAddress = async (address: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(address)
      setNotice('已复制代理地址。')
    } catch {
      setNotice('复制失败，请手动选择并复制显示的地址。')
    }
  }
  return (
    <section className="relay-panel">
      <h2>AI 客户端与指定节点代理</h2>
      <p>
        在「本地代理」开启 AI
        专用监听，选择一个具体节点并启动，再在此检查地址。经此地址发出的请求只走所选节点，节点不可用时请求失败。客户端需要使用显示的代理地址，未交给此入口的流量不受它限制。
      </p>
      <button disabled={busy || !!state?.pending} onClick={() => void inspect()}>
        检查本次监听与客户端关联
      </button>
      {notice && <p role="status">{notice}</p>}
      {report && (
        <div>
          <p>
            Code当前草稿端口 {claudeCodePort}：
            {current &&
            report.claudeCode.requestedPort === claudeCodePort &&
            report.claudeCode.listenerLive
              ? '已确认属于本次实例'
              : '请重新核对关联'}
          </p>
          {dedicated && (httpPort || socksPort) && <p>指定节点：{dedicated.route}</p>}
          {(
            [
              ['HTTP', 'http', httpPort],
              ['SOCKS5', 'socks5', socksPort]
            ] as const
          ).map(([label, protocol, port]) => {
            const address = port ? `${protocol}://127.0.0.1:${port}` : undefined
            return (
              <p key={label}>
                专用 {label}：{address ? <code>{address}</code> : '未确认监听'}{' '}
                {address && (
                  <button disabled={busy} onClick={() => void copyAddress(address)}>
                    复制 {label} 地址
                  </button>
                )}
              </p>
            )
          })}
          <button
            disabled={busy || !httpPort}
            onClick={() => {
              if (httpPort && dedicated) onAssociate(httpPort, dedicated.route)
            }}
          >
            配置 Claude Code 使用此入口
          </button>
          <p>
            Codex配置：{report.codex.exists ? '文件存在' : '未发现文件'}
            。这里仅检查文件是否存在；不会自动修改设置或拦截桌面版、终端的直连请求。
          </p>
          <p>
            Relay 专用登录浏览器 HTTP {report.browserProxy.httpPort ?? '—'}：
            {current && report.browserProxy.ownedLive ? '已确认本次监听' : '未确认本次监听'}。
          </p>
          <p>
            登录回调与开发内网例外继续使用Code配置中的NO_PROXY。点击配置会备份并更新Claude
            Code的代理与登录浏览器；已打开的CLI会话需重新启动才能读取新设置。
          </p>
          <ul>
            {report.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
