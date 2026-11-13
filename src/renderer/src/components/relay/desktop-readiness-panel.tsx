import type { RelayDesktopReadiness, RelayDesktopDecision } from '../../../../shared/relay/protocol'

const decisions: Record<RelayDesktopDecision, string> = {
  notApplicable: '没有恢复记录',
  alreadyOriginal: '当前已是原应用，记录仍待处理',
  restoreEligible: '当前匹配记录中的临时浏览器，后续恢复仍需持锁复核',
  blocked: '存在外部更改或配对条件不符，禁止覆盖',
  unconfirmed: '当前身份无法核对'
}
const recordStates = {
  missing: '无记录',
  pending: '存在待处理记录',
  invalid: '格式或权限异常，记录已保留',
  unreadable: '不可读取，不能排除待恢复会话'
}
export function RelayDesktopReadinessPanel({
  report,
  notice,
  busy,
  ready,
  onRead
}: {
  report?: RelayDesktopReadiness
  notice: string
  busy: boolean
  ready: boolean
  onRead(): void
}): React.JSX.Element {
  return (
    <section className="relay-panel">
      <h2>Claude 桌面登录前置检查</h2>
      <p>
        核对本机安装的 Microsoft Edge、强制代理策略、Edge 完全退出状态、Claude、HTTP/HTTPS
        默认应用及新旧登录恢复记录。不会打开应用或切换默认浏览器。
      </p>
      <div className="relay-action">
        <button disabled={busy || !ready} onClick={onRead}>
          读取桌面登录条件
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {report && (
        <div className="relay-output">
          <h3>
            {report.configurationReady
              ? '本次配置条件匹配；开始时仍需重新核对和系统确认'
              : '登录条件需要处理或补充'}
          </h3>
          <p>这是只读快照，未取得会话锁，代理端口未探测；不能据此开始登录或恢复。</p>
          <ul>
            <li>
              Microsoft Edge：{report.edgeInstalled ? '应用身份匹配' : '未找到身份匹配的应用'}
            </li>
            <li>Edge 强制策略：{report.edgePoliciesReady ? '符合登录要求' : '尚未符合登录要求'}</li>
            <li>Edge 进程：{report.edgeClosed ? '已完全退出' : '仍在运行或无法确认已退出'}</li>
            <li>浏览器条件：{report.browserReady ? '匹配' : '需要处理'}</li>
            <li>
              Claude：{report.claudeInstalled ? '桌面应用身份匹配' : '未找到身份匹配的桌面应用'}
            </li>
            <li>HTTP 默认应用：{report.defaults.http ?? '无法确认'}</li>
            <li>
              HTTPS 默认应用：{report.defaults.https ?? '无法确认'}；
              {report.sharedDefaults ? '两项应用身份和位置一致' : '配对条件不符或无法确认'}
            </li>
          </ul>
          {report.records.map((record) => (
            <div key={record.source}>
              <h4>
                {record.source === 'relay' ? 'Relay 登录记录' : '旧桌面登录记录'}：
                {recordStates[record.state]}
              </h4>
              {record.state !== 'missing' && (
                <ul>
                  {(['http', 'https'] as const).map((scheme) => (
                    <li key={scheme}>
                      {scheme.toUpperCase()}：{decisions[record.decisions[scheme]]}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
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
