import { useRef, useState } from 'react'
import type { RelayProfileInventory } from '../../../../shared/relay/profiles'
import type { ResourceInventory } from '../../../../shared/relay/resources'
import type {
  CompleteConfigurationPlan,
  CompleteConfigurationResult
} from '../../../../shared/relay/configuration'
import type { ConfigurationEditRecord } from '../../../../shared/relay/configuration-edit'
import { isGeoResourceKind } from '../../../../shared/relay/geo-origins'

export function RelayCompleteConfigurationPanel({
  busy,
  onBusy,
  savedEdits = false,
  onChecked
}: {
  busy: boolean
  onBusy(value: boolean): void
  savedEdits?: boolean
  onChecked?(evidenceId: string | undefined): void
}): React.JSX.Element {
  const [profiles, setProfiles] = useState<RelayProfileInventory>(),
    [providers, setProviders] = useState<RelayProfileInventory>(),
    [resources, setResources] = useState<ResourceInventory>()
  const [selected, setSelected] = useState(''),
    [controlled, setControlled] = useState('{}'),
    [global, setGlobal] = useState('[]'),
    [local, setLocal] = useState('[]'),
    [rules, setRules] = useState('{}')
  const [controlDns, setControlDns] = useState(false),
    [controlSniff, setControlSniff] = useState(true),
    [policy, setPolicy] = useState(false),
    [fingerprint, setFingerprint] = useState('')
  const [bindings, setBindings] = useState<Record<string, string>>({}),
    [plan, setPlan] = useState<CompleteConfigurationPlan>(),
    [checked, setChecked] = useState<CompleteConfigurationResult>(),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    operation = useRef(false),
    sequence = useRef(0)
  const locked = busy || pending
  const changed = (): void => {
    ++sequence.current
    onChecked?.(undefined)
    setChecked(undefined)
    setNotice('草稿已变更，请重新生成后检查。')
    setPlan((previous) => (previous ? { ...previous, readyForParserCheck: false } : undefined))
    void window.electron.ipcRenderer.invoke('relayCompleteConfigurationCancel').catch(() => {})
  }
  const action = async (kind: 'list' | 'prepare' | 'check'): Promise<void> => {
    if (operation.current) return
    operation.current = true
    const epoch = ++sequence.current
    onChecked?.(undefined)
    setPending(true)
    onBusy(true)
    setNotice('处理中…')
    setChecked(undefined)
    try {
      if (kind === 'list') {
        // These stores participate in the App's mutual exclusion gates.
        const p = (await window.electron.ipcRenderer.invoke(
          'relayProfileList'
        )) as RelayProfileInventory
        const c = (await window.electron.ipcRenderer.invoke(
          'relayProviderResourceList'
        )) as RelayProfileInventory
        const r = (await window.electron.ipcRenderer.invoke(
          'relayResourceList'
        )) as ResourceInventory
        setProfiles(p)
        setProviders(c)
        setResources(r)
        setNotice('已读取私有配置与资源清单，未读取原路径或启动核心。')
      } else if (kind === 'prepare') {
        const profile = profiles?.profiles.find((item) => item.id === selected)
        if (!profile) throw new Error()
        const selectedBindings = Object.entries(bindings)
          .filter(([, value]) => !!value)
          .map(([dependencyId, value]) => {
            const namespace = value.slice(0, 1),
              id = value.slice(2),
              resource =
                namespace === 'p'
                  ? providers?.profiles.find((item) => item.id === id)
                  : resources?.resources.find((item) => item.id === id)
            if (!resource) throw new Error()
            return { dependencyId, selection: { id: resource.id, sha256: resource.sha256 } }
          })
        const saved = savedEdits
          ? ((await window.electron.ipcRenderer.invoke(
              'relayConfigEditRead'
            )) as ConfigurationEditRecord)
          : undefined
        if (savedEdits && !saved?.exists) throw new Error('请先保存编辑。')
        const next = (await window.electron.ipcRenderer.invoke(
          savedEdits ? 'relayConfigEditPrepare' : 'relayCompleteConfigurationPrepare',
          saved
            ? {
                profile: { id: profile.id, sha256: profile.sha256 },
                revision: saved.revision,
                bindings: selectedBindings
              }
            : {
                profile: { id: profile.id, sha256: profile.sha256 },
                options: {
                  globalOverrides: JSON.parse(global),
                  profileOverrides: JSON.parse(local),
                  controlled: JSON.parse(controlled),
                  rulePatch: JSON.parse(rules),
                  controlDns,
                  controlSniff,
                  useNameserverPolicy: policy,
                  ...(fingerprint ? { confirmedDnsFingerprint: fingerprint } : {})
                },
                bindings: selectedBindings
              }
        )) as CompleteConfigurationPlan
        if (epoch !== sequence.current) return
        setPlan(next)
        setNotice(
          next.readyForParserCheck
            ? '完整候选已准备；60秒内可检查，尚未启用。'
            : '候选仍缺资源，请逐项选择后重新生成。'
        )
      } else {
        if (!plan?.readyForParserCheck) throw new Error()
        const result = (await window.electron.ipcRenderer.invoke(
          'relayCompleteConfigurationCheck',
          { evidenceId: plan.evidenceId }
        )) as CompleteConfigurationResult
        if (epoch !== sequence.current) return
        setChecked(result)
        onChecked?.(result.status === 'passed' ? plan.evidenceId : undefined)
        setPlan((previous) => (previous ? { ...previous, readyForParserCheck: false } : undefined))
        setNotice(result.warnings.join(' '))
      }
    } catch {
      setPlan(undefined)
      setNotice(
        '操作未确认、草稿格式无效或来源／资源已变化；请重新读取并生成，没有自动重试或启用。'
      )
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  return (
    <section className="relay-panel relay-profiles">
      <h2>{savedEdits ? '检查已保存的编辑' : '完整运行配置'}</h2>
      <p>
        按原来源、全局／当前覆写、规则补丁、Smart、受控设置生成完整候选。这里不会切换在用配置或修改网络。核心检查仅验证解析，启用与热加载由独立流程处理。
      </p>
      <p>
        地理依赖默认采用对应已保存来源的最新已检查缓存；也可指定其他私有缓存。每次生成都会固定所选内容，历史候选不会跟随来源更新。
      </p>
      <button disabled={locked} onClick={() => void action('list')}>
        读取配置与资源清单
      </button>
      <label>
        已保存的来源
        <select
          value={selected}
          disabled={locked}
          onChange={(event) => {
            setSelected(event.target.value)
            setBindings({})
            setFingerprint('')
            changed()
          }}
        >
          <option value="">选择配置</option>
          {profiles?.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      {!savedEdits && (
        <details>
          <summary>覆写与受控设置</summary>
          <p>
            覆写数组格式：{`[{"id":"名称","kind":"yaml","content":"mode: rule"}]`}。JavaScript 使用
            kind=js 和 main(config)，在独立工作进程执行；Smart 使用
            id=smart-core-override。这里只编辑本次候选；持久编辑可在配置编辑面板保存。
          </p>
          <label>
            全局覆写 JSON
            <textarea
              value={global}
              disabled={locked}
              onChange={(event) => {
                setGlobal(event.target.value)
                changed()
              }}
            />
          </label>
          <label>
            当前来源覆写 JSON
            <textarea
              value={local}
              disabled={locked}
              onChange={(event) => {
                setLocal(event.target.value)
                changed()
              }}
            />
          </label>
          <label>
            规则补丁 JSON（prepend／append／delete）
            <textarea
              value={rules}
              disabled={locked}
              onChange={(event) => {
                setRules(event.target.value)
                changed()
              }}
            />
          </label>
          <label>
            受控设置 JSON
            <textarea
              value={controlled}
              disabled={locked}
              onChange={(event) => {
                setControlled(event.target.value)
                changed()
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={controlDns}
              disabled={locked}
              onChange={(event) => {
                setControlDns(event.target.checked)
                setFingerprint('')
                changed()
              }}
            />
            候选启用 DNS 覆写
          </label>
          <label>
            <input
              type="checkbox"
              checked={policy}
              disabled={locked}
              onChange={(event) => {
                setPolicy(event.target.checked)
                changed()
              }}
            />
            候选合并受控 nameserver-policy
          </label>
          <label>
            <input
              type="checkbox"
              checked={controlSniff}
              disabled={locked}
              onChange={(event) => {
                setControlSniff(event.target.checked)
                changed()
              }}
            />
            候选启用受控 sniffer
          </label>
        </details>
      )}
      {!savedEdits && plan?.dns.autoDisabled && plan.dns.fingerprint && (
        <div>
          <p>
            原来源存在自定义 DNS，当前候选保留原配置并关闭 DNS 覆写。确认仅适用于这份来源及其当前
            DNS 内容。
          </p>
          <button
            disabled={locked}
            onClick={() => {
              setFingerprint(plan.dns.fingerprint ?? '')
              changed()
            }}
          >
            确认下一次候选覆盖这些 DNS 字段
          </button>
        </div>
      )}
      {plan && (
        <div>
          <p>配置摘要：{plan.configurationSHA256}</p>
          <p>
            执行顺序：{plan.stageOrder.join(' → ')}；绑定资源 {plan.resources} 项；脚本日志{' '}
            {plan.scriptLogLines} 行（正文不回传）。
          </p>
          {plan.dependencies.map((dependency) => (
            <label key={dependency.id}>
              {dependency.kind} · {dependency.resolved ? '已绑定' : '待绑定'} ·{' '}
              {dependency.id.slice(0, 12)}
              {(!dependency.resolved || isGeoResourceKind(dependency.kind)) && (
                <select
                  disabled={locked}
                  value={bindings[dependency.id] ?? ''}
                  onChange={(event) => {
                    setBindings((previous) => ({
                      ...previous,
                      [dependency.id]: event.target.value
                    }))
                    changed()
                  }}
                >
                  <option value="">
                    {isGeoResourceKind(dependency.kind)
                      ? '使用已保存来源的最新已检查缓存'
                      : '选择对应私有缓存'}
                  </option>
                  {dependency.kind === 'proxy-provider'
                    ? providers?.profiles.map((item) => (
                        <option key={item.id} value={'p:' + item.id}>
                          {item.name}
                        </option>
                      ))
                    : resources?.resources
                        .filter((item) => item.kind === dependency.kind)
                        .map((item) => (
                          <option key={item.id} value={'r:' + item.id}>
                            {item.name} · {item.sha256.slice(0, 12)}
                          </option>
                        ))}
                </select>
              )}
            </label>
          ))}
          <ul>
            {plan.warnings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="relay-action">
        <button disabled={locked || !selected} onClick={() => void action('prepare')}>
          生成完整候选
        </button>
        <button
          disabled={locked}
          onClick={() => {
            setBindings({})
            changed()
          }}
        >
          清除资源绑定
        </button>
        <button
          disabled={locked || !plan?.readyForParserCheck}
          onClick={() => void action('check')}
        >
          检查这份完整候选
        </button>
        <button
          disabled={!pending}
          onClick={() => {
            ++sequence.current
            onChecked?.(undefined)
            setChecked(undefined)
            setPlan((previous) =>
              previous ? { ...previous, readyForParserCheck: false } : undefined
            )
            void window.electron.ipcRenderer
              .invoke('relayCompleteConfigurationCancel')
              .catch(() => {})
          }}
        >
          取消本次检查
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {checked && <p>完整解析状态：{checked.status} · 尚未启用 · 运行与流量验收未完成</p>}
    </section>
  )
}
