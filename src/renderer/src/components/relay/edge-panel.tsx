import type { RelayEdgeAction, RelayEdgePreparation } from '../../../../shared/relay/edge'

export function RelayEdgePanel({
  report,
  notice,
  busy,
  ready,
  onInspect,
  onOpen,
  onEntry
}: {
  report?: RelayEdgePreparation
  notice: string
  busy: boolean
  ready: boolean
  onInspect(): void
  onOpen(): void
  onEntry(action: RelayEdgeAction): void
}): React.JSX.Element {
  return (
    <section className="relay-panel">
      <h2>Edge 策略与描述文件</h2>
      <p>
        固定 SOCKS 127.0.0.1:17890、回环直连、DoH 关闭、限制非代理 WebRTC
        UDP、关闭预测。影响当前用户全部 Edge 资料。
      </p>
      <p>
        先在设备管理及 Edge
        策略页核对组织或已有策略，再检查并打开描述文件。安装仍需在系统设置确认；助手不会替你安装或关闭浏览器。
      </p>
      <div className="relay-action">
        <button disabled={busy || !ready} onClick={onInspect}>
          检查 Edge 安装条件
        </button>
        <button disabled={busy || !ready || !report?.canOpenProfile} onClick={onOpen}>
          打开描述文件…
        </button>
        <button disabled={busy || !ready} onClick={() => onEntry('deviceManagement')}>
          打开设备管理
        </button>
        <button disabled={busy || !ready} onClick={() => onEntry('edgePolicy')}>
          在 Edge 查看 policy
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {report && (
        <div className="relay-output">
          <h3>
            {report.status === 'configured'
              ? '基础强制策略匹配，无需重复安装'
              : report.status === 'blocked'
                ? '存在需人工处理的条件，暂停打开描述文件'
                : '尚未读到基础强制策略，人工核对后可打开安装入口'}
          </h3>
          <ul>
            <li>Edge：{report.edgeInstalled ? '固定位置应用身份匹配' : '未找到身份匹配的应用'}</li>
            {report.policies.map((policy) => (
              <li key={policy.key}>
                {policy.key}：
                {policy.valid
                  ? '强制值匹配'
                  : policy.forced
                    ? '已有强制值不符，请核对来源'
                    : '未强制生效'}
              </li>
            ))}
            {report.reviewKeys.map((key) => (
              <li key={key}>{key}：发现附加策略，请人工核对覆盖关系</li>
            ))}
            {report.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
