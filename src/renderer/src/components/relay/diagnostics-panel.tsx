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
  const owned = observation.source === 'relay-owned' ? observation.owned : undefined
  const recorded = (id: string): { label: string; value: string } | undefined => {
    if (!owned?.external.bindingMatches || !['egress', 'dns-exit', 'webrtc'].includes(id))
      return undefined
    const tests =
      owned.external.record?.tests.filter(
        (test, index) => test.id === id && owned.external.browserMatches[index]
      ) ?? []
    if (!tests.length) return undefined
    const failed = tests.some((test) => test.result === 'failed')
    const inconclusive = tests.some((test) => test.result === 'inconclusive')
    return {
      label: failed ? '实测发现异常' : inconclusive ? '实测未得结论' : '已有实测记录',
      value:
        tests
          .map(
            (test) =>
              `${test.browser?.bundleId === 'com.google.Chrome' ? '专用 Chrome' : 'Edge'}：${test.result === 'failed' ? '发现异常' : test.result === 'inconclusive' ? '未得出结论' : test.result === 'observed' ? '已记录出口信息' : '本次探针未发现泄漏'}（${test.testedAt}）`
          )
          .join('；') + '。仅限记录中的方法与范围，见下方外部实测记录。'
    }
  }
  return (
    <section className="relay-panel">
      <span className="relay-eyebrow">READ-ONLY OBSERVATION</span>
      <h2>关键检测</h2>
      <p>{report.snapshot.summary}</p>
      <p>
        检测时间：{report.snapshot.checkedAt}；来源：
        {owned ? 'Relay 当前实例（只读）' : '现有 Clash（只读）'}。
        {owned ? (
          <>
            普通 HTTP/混合 {owned.ports.systemHTTPPort ?? '未运行'} / 专用 HTTP{' '}
            {owned.ports.codeHTTPPort ?? '未启用'} / 专用 SOCKS{' '}
            {owned.ports.dedicatedSOCKSPort ?? '未启用'}。
          </>
        ) : (
          <>HTTP {parameters.httpPort} / SOCKS 17890。</>
        )}
      </p>
      <div className="relay-checks">
        {report.checks.map((check) => (
          <article key={check.id}>
            <div className="relay-heading">
              <strong>{check.title}</strong>
              <span className={`relay-check-state ${check.state}`}>
                {recorded(check.id)?.label ??
                  (owned && check.id === 'guard'
                    ? check.value.includes('未提供')
                      ? '未提供'
                      : '未确认'
                    : stateLabels[check.state])}
              </span>
            </div>
            <p>{recorded(check.id)?.value ?? check.value}</p>
            <details>
              <summary>依据与后续核对</summary>
              <p>{check.evidence}</p>
              <p>{check.nextStep}</p>
            </details>
          </article>
        ))}
      </div>
      {owned && (
        <section aria-label="外部实测记录">
          <h3>外部实测记录</h3>
          <p>
            以下为有时间和范围限制的历史记录，本按钮没有重新执行探针。浏览器探针未发现泄漏不等于全协议无泄漏；隔离测试不等于系统级防直连。登录回调和账号请求本轮未测试。
          </p>
          {owned.external.status === 'missing' && <p>尚未保存本机外部实测记录。</p>}
          {owned.external.status === 'invalid' && (
            <p>实测记录格式、权限或归属未通过核对，未采用其中结论。</p>
          )}
          {owned.external.record && (
            <>
              <p>
                记录时间：{owned.external.record.recordedAt}；架构：
                {owned.external.record.binding.architecture}；Relay{' '}
                {owned.external.record.binding.appVersion} / build{' '}
                {owned.external.record.binding.appBuild}。
              </p>
              <p>
                {owned.external.bindingMatches
                  ? '记录与本次版本、核心和配置绑定匹配，仍仅代表当时测试。'
                  : '历史记录：当前版本、核心或配置绑定不匹配或未确认，不能作为当前验收结果。'}
              </p>
              {owned.external.record.tests.map((test, index) => (
                <article key={`${test.id}-${index}`}>
                  <strong>
                    {
                      {
                        egress: '出口观察',
                        'dns-exit': 'DNS 解析探针',
                        webrtc: 'WebRTC 探针',
                        'dedicated-failure': '专用监听失效隔离测试'
                      }[test.id]
                    }
                  </strong>
                  <p>
                    {!owned.external.bindingMatches || !owned.external.browserMatches[index]
                      ? '历史 / 绑定未确认：'
                      : '本次记录：'}
                    {
                      {
                        observed: '已记录出口信息',
                        noLeakObserved: '本次探针未发现泄漏',
                        isolatedPassed: '隔离测试通过',
                        failed: '发现异常',
                        inconclusive: '未得出结论'
                      }[test.result]
                    }
                  </p>
                  <p>
                    测试时间：{test.testedAt}；
                    {test.browser
                      ? `浏览器：${test.browser.bundleId} ${test.browser.version}；资料范围：${test.browser.profile}`
                      : '范围：隔离核心，不代表浏览器或桌面账号请求'}
                  </p>
                  <p>方法：{test.method}</p>
                  <p>覆盖：{test.scope.join('；')}</p>
                  <p>限制：{test.limitations.join('；')}</p>
                  <details>
                    <summary>证据摘要</summary>
                    <code>{test.evidenceSHA256}</code>
                  </details>
                </article>
              ))}
            </>
          )}
          {owned.binding && (
            <details>
              <summary>当前验收绑定</summary>
              <pre>{JSON.stringify(owned.binding, null, 2)}</pre>
            </details>
          )}
        </section>
      )}
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
