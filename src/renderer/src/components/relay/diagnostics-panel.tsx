import type { RelayObservation, RelayCheckState } from '../../../../shared/relay/protocol'

const stateLabels: Record<RelayCheckState, string> = {
  verifiedConfiguration: '配置已核对',
  attention: '需检查',
  pending: '待验证'
}

export function RelayDiagnosticsPanel({
  observation,
  busy,
  onGuardPlan
}: {
  observation: RelayObservation
  busy: boolean
  onGuardPlan(node: string, evidenceId: string): void
}): React.JSX.Element {
  const { report, parameters } = observation
  return (
    <section className="relay-panel">
      <span className="relay-eyebrow">READ-ONLY OBSERVATION</span>
      <h2>关键检测</h2>
      <p>{report.snapshot.summary}</p>
      <p>
        检测时间：{report.snapshot.checkedAt}；来源：现有 Clash（只读）。HTTP {parameters.httpPort}{' '}
        / SOCKS 17890。
      </p>
      <div className="relay-checks">
        {report.checks.map((check) => (
          <article key={check.id}>
            <div className="relay-heading">
              <strong>{check.title}</strong>
              <span className={`relay-check-state ${check.state}`}>{stateLabels[check.state]}</span>
            </div>
            <p>{check.value}</p>
            <details>
              <summary>依据与后续核对</summary>
              <p>{check.evidence}</p>
              <p>{check.nextStep}</p>
            </details>
          </article>
        ))}
      </div>
      <details className="relay-policy-details">
        <summary>Edge 四项强制策略与环境参考</summary>
        <ul>
          {report.edgePolicies.map((policy) => (
            <li key={policy.key}>
              {policy.key}：
              {policy.valid ? '强制值匹配' : policy.forced ? '强制值不匹配' : '未强制管理'}
            </li>
          ))}
          {report.edgePolicyReviewKeys.map((key) => (
            <li key={key}>{key}：附加策略待人工核对</li>
          ))}
        </ul>
        <p>
          时区：{report.timezone}；语言：{report.preferredLanguages.join(', ')}
          。仅作参考，不调整系统设置。
        </p>
        <ul>
          {report.snapshot.details.map((detail, index) => (
            <li key={index}>{detail}</li>
          ))}
        </ul>
      </details>
      <h3>禁止直连部署方案</h3>
      <p>
        仅为核心已确认的具体节点生成待验收方案；证据有效期60秒。没有节点或已过期时需重新检测。生成与导出不会安装扩展或改变当前连接。
      </p>
      <div className="relay-action">
        {report.snapshot.controllerConnected && report.snapshot.nodeNames.length > 0 ? (
          <label>
            已确认节点
            <select
              aria-label="选择节点以生成待验收方案"
              defaultValue=""
              disabled={busy}
              onChange={(event) => {
                const node = event.target.value
                event.target.value = ''
                if (node) onGuardPlan(node, observation.evidenceId)
              }}
            >
              <option value="" disabled>
                选择节点并生成方案…
              </option>
              {report.snapshot.nodeNames.map((node) => (
                <option key={node} value={node}>
                  {node}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p>尚无可用的具体节点证据，不能生成部署方案。</p>
        )}
      </div>
      <ul>
        {report.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </section>
  )
}
