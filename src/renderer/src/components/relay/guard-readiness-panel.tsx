import type { RelayGuardComponent, RelayGuardReadiness } from '../../../../shared/relay/guard'

const presence: Record<RelayGuardComponent['presence'], string> = {
  present: '包内组件可读取',
  missing: '包内缺少组件',
  unconfirmed: '不可确认',
  notBundled: '当前为独立开发程序，未处于 App 包内'
}
const signature: Record<RelayGuardComponent['signature'], string> = {
  staticValid: '静态完整性匹配（不代表系统授权）',
  adHoc: '本地临时签名，不能作为正式保护部署凭证',
  invalid: '静态签名无效',
  unconfirmed: '未确认'
}
const pairing = { matches: '匹配', mismatch: '不匹配', unconfirmed: '未确认' }
export function RelayGuardReadinessPanel({
  report,
  busy,
  ready,
  notice,
  onRead
}: {
  report?: RelayGuardReadiness
  busy: boolean
  ready: boolean
  notice: string
  onRead(): void
}): React.JSX.Element {
  return (
    <section className="relay-panel">
      <h2>Claude 和 Codex：系统过滤构建状态</h2>
      <p>
        当前离线构建未开放真实安装或启停。读取只检查 Relay
        自身包内资源、签名和权限，不操作系统过滤器、不探测代理或制造断网。
      </p>
      <div className="relay-action">
        <button disabled={busy || !ready} onClick={onRead}>
          读取保护构建状态
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {report && (
        <div className="relay-output">
          <h3>离线检查；实际禁止直连未验收</h3>
          {(
            [
              ['Relay 主应用', report.application],
              ['Relay 过滤扩展', report.extensionComponent]
            ] as const
          ).map(([label, item]) => (
            <div key={label}>
              <h4>{label}</h4>
              <ul>
                <li>组件：{presence[item.presence]}</li>
                <li>包与签名身份：{pairing[item.identity]}</li>
                <li>签名：{signature[item.signature]}</li>
                <li>
                  扩展安装权限：{item.installEntitlement ? '已读到' : '未读到'}；网络扩展权限：
                  {item.networkEntitlement ? '已读到' : '未读到'}；沙箱权限：
                  {item.sandboxEntitlement ? '已读到' : '未读到'}
                </li>
              </ul>
            </div>
          ))}
          <p>
            本机架构签名 Team：{pairing[report.sameSigningTeam]}；组件版本：
            {pairing[report.sameVersion]}。包内前置元数据：
            {report.bundleMetadataMatches ? '本次匹配，仍不能启用保护' : '尚未匹配'}。
          </p>
          <p>系统扩展状态：未查询；系统过滤配置：未查询；实际阻断：未验收。</p>
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
