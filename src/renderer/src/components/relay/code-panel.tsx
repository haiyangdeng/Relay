import type { RelayCodePreparation, RelayCodeTarget } from '../../../../shared/relay/protocol'

const targets: Record<RelayCodeTarget, string> = {
  claudeSettings: 'Claude Code 用户设置',
  assistantPreferences: 'Relay 参数',
  browserLocalState: '专用浏览器 Local State',
  browserPreferences: '专用浏览器 Preferences'
}
export function RelayCodePanel({
  preparation,
  notice,
  busy,
  ready,
  onPrepare,
  onApply,
  onOpen
}: {
  preparation?: RelayCodePreparation
  notice: string
  busy: boolean
  ready: boolean
  onPrepare(): void
  onApply(): void
  onOpen(): void
}): React.JSX.Element {
  return (
    <section className="relay-panel">
      <h2>Code 与专用浏览器配置</h2>
      <p>
        使用上方端口、节点和内网例外，读取实际用户文件并准备联合修改。上方 JSON 草稿不写入实际设置。
      </p>
      <p>建议先退出当前 Code 会话再应用，之后新开会话。移动 Relay 后需重新应用浏览器入口。</p>
      <div className="relay-action">
        <button disabled={busy || !ready} onClick={onPrepare}>
          读取实际配置并准备
        </button>
        <button disabled={busy || !ready} onClick={onApply}>
          备份并配置
        </button>
        <button disabled={busy || !ready} onClick={onOpen}>
          打开专用 Chrome
        </button>
      </div>
      <p>
        入口随 Relay 打包，使用本次 Relay 已核实的专用 HTTP
        监听。仅复用代理与资料状态匹配的窗口；修改浏览器配置前需退出该专用资料。
      </p>
      {notice && <p role="status">{notice}</p>}
      {preparation && (
        <div className="relay-output">
          <h3>本次准备</h3>
          <p>HTTP 代理：http://127.0.0.1:{preparation.httpPort}</p>
          <p>
            浏览器入口：{preparation.helperReady ? '资源已找到' : '资源缺失，不能配置'}；专用资料：
            {preparation.browserState === 'closed'
              ? '已核对退出'
              : preparation.browserState === 'running'
                ? '仍在运行，请先退出该资料'
                : '进程状态未确认'}
          </p>
          {preparation.changedTargets.length === 0 ? (
            <p>文件已匹配，无需重复创建备份。</p>
          ) : (
            <ul>
              {preparation.changedTargets.map((target) => (
                <li key={target}>{targets[target]}</li>
              ))}
            </ul>
          )}
          <p>这是配置检查结果；执行时会在持锁后重新核对。</p>
          <ul>
            {preparation.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
