import type { RelayDesktopAction, RelayDesktopState } from '../../../../shared/relay/desktop'

const phases = {
  idle: '未处于临时登录状态',
  starting: '正在准备专用登录',
  active: '登录会话进行中，结束后需恢复',
  restoring: '正在恢复，请等待系统回调',
  recoveryNeeded: '恢复未完成，记录已保留',
  blocked: '会话条件或记录需要处理'
}
export function RelayDesktopSessionPanel({
  state,
  notice,
  busy,
  ready,
  onAction
}: {
  state?: RelayDesktopState
  notice: string
  busy: boolean
  ready: boolean
  onAction(action: RelayDesktopAction): void
}): React.JSX.Element {
  const pending = state?.pending === true,
    snapshot = state?.snapshot
  const running = state?.host === 'running'
  return (
    <section className="relay-panel">
      <h2>Claude 桌面专用登录</h2>
      <p>
        直接使用本机安装的 Microsoft Edge，临时设为 HTTP/HTTPS 默认浏览器。 开始前会核对强制策略和
        Edge 完全退出状态，并确认 SOCKS 127.0.0.1:17890 由当前 Relay
        的固定节点专用监听持有。期间其他应用打开的网页也会进入 Edge。
        账号登录由你完成，然后回到这里恢复原默认浏览器。
      </p>
      <p>
        使用未登录微软账号的专用 Edge 资料；策略作用于当前用户全部 Edge 资料。 与 Clash Party
        交替使用时，共享 17890 端口只能由当前使用的软件占用。普通 SOCKS
        监听不能替代此专用监听；此入口不会自动迁移端口。
      </p>
      <div className="relay-action">
        <button
          disabled={!ready || busy || pending || running || state?.uncertain}
          onClick={() => onAction('start')}
        >
          开始专用登录…
        </button>
        <button
          disabled={
            !running ||
            busy ||
            pending ||
            snapshot?.phase !== 'active' ||
            snapshot.requiresRecoveryConsent
          }
          onClick={() => onAction('finish')}
        >
          完成登录并恢复
        </button>
        <button
          disabled={
            snapshot?.requiresRecoveryConsent || (!running && !pending) || (!pending && busy)
          }
          onClick={() => onAction('cancel')}
        >
          取消并恢复
        </button>
        <button disabled={!ready || busy || pending} onClick={() => onAction('restore')}>
          确认恢复记录…
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <p role="status">
          正在确认或等待系统操作；取消和退出会等待在途回调，不会强制停止后台会话。
        </p>
      )}
      {state?.uncertain && (
        <p role="alert">
          结果未确认，请保留 Relay 窗口。未自动重试切换；后台异常退出后需单独确认恢复记录。
        </p>
      )}
      {snapshot && (
        <div className="relay-output">
          <h3>{phases[snapshot.phase]}</h3>
          {snapshot.hasRecord && (
            <p>
              {snapshot.source === 'legacy'
                ? '旧桌面入口记录在原目录处理。'
                : 'Relay 登录恢复记录已保留。'}
            </p>
          )}
          {snapshot.requiresRecoveryConsent && (
            <p>发现以前的登录记录。取消或关闭不能代替授权，请使用“确认恢复记录”。</p>
          )}
          <ul>
            {snapshot.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <p>
        不会更改 Edge 策略或判断账号已登录。系统强杀、掉电无法保证执行清理，恢复记录用于下次核对。
      </p>
    </section>
  )
}
