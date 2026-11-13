import type {
  RelayRuntimePreparation,
  RelayRuntimeCheckResult
} from '../../../../shared/relay/runtime'

export function RelayRuntimePanel({
  preparation,
  checked,
  busy,
  notice,
  onCheck
}: {
  preparation?: RelayRuntimePreparation
  checked?: RelayRuntimeCheckResult
  busy: boolean
  notice: string
  onCheck(): void
}): React.JSX.Element {
  return (
    <section className="relay-panel relay-profiles">
      <h2>节点／代理组与隔离配置检查</h2>
      <p>
        先从已保存配置中选择“查看节点与组”。这里显示原文声明，不代表实际节点状态或组内当前选择；提供者内容未加载。
      </p>
      <p>
        按固定核心的28类协议与传输字段检查结构，再用核心验证具体参数。外部证书／私钥／planet文件或原状态目录需要先显式导入；不会从原路径读取。有状态协议的检查副本只用本次临时状态，不迁移既有身份。配置通过不代表远端握手或流量验证通过。
      </p>
      {notice && <p role="status">{notice}</p>}
      {preparation && (
        <>
          <h3>{preparation.profile.name}</h3>
          <p>原配置未启用 · 完整原配置兼容性未验证</p>
          <details open>
            <summary>节点声明（{preparation.profile.summary.proxies}）</summary>
            <ul>
              {preparation.catalogue.nodes.map((node) => (
                <li key={node.name}>
                  {node.name} · {node.type}
                </li>
              ))}
            </ul>
          </details>
          <details open>
            <summary>代理组声明（{preparation.profile.summary.groups}）</summary>
            <ul>
              {preparation.catalogue.groups.map((group) => (
                <li key={group.name}>
                  <strong>{group.name}</strong> · {group.type} · 成员：
                  {group.members.join('、') || '未明确列出'}
                  {group.providers.length > 0 &&
                    ` · 提供者：${group.providers.join('、')}（未加载）`}
                  {group.dynamic && ' · 含动态成员条件，未展开'}
                </li>
              ))}
            </ul>
          </details>
          <p>
            节点提供者：{preparation.catalogue.proxyProviders.join('、') || '无'}；规则提供者：
            {preparation.catalogue.ruleProviders.join('、') || '无'}。
          </p>
          {preparation.catalogue.truncated && <p>声明较多，本次显示已截断；没有删减原配置。</p>}
          <ul>
            {preparation.excluded.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
          <ul>
            {preparation.issues.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
          {preparation.runtimeSHA256 && <p>隔离投影摘要：{preparation.runtimeSHA256}</p>}
        </>
      )}
      <div className="relay-action">
        <button disabled={busy || !preparation?.canValidate || !!checked} onClick={onCheck}>
          用固定核心检查隔离投影
        </button>
      </div>
      {checked && (
        <div role="status">
          <p>
            {checked.status === 'passed'
              ? '隔离投影校验通过'
              : checked.status === 'rejected'
                ? '隔离投影未通过核心校验'
                : checked.status === 'uncertain'
                  ? '临时清理未确认'
                  : '检查未完成'}{' '}
            · 未启用原配置
          </p>
          <ul>
            {checked.warnings.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
