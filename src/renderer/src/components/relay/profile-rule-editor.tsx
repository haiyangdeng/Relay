import { useState } from 'react'
import type {
  RelayProfileRules,
  RelayProfileRuleProviders,
  RelayProfilePreparation,
  RelayProfileSaveResult,
  RelayStoredProfile
} from '../../../../shared/relay/profiles'
import type { ResourceInfo, ResourceInventory } from '../../../../shared/relay/resources'
import { RuleProviderDefinitionList } from '../resources/rule-provider-definition-list'
import { RuleProviderEditorView } from '../resources/rule-provider-editor-modal'
import type { SimpleRuleEditor } from '../../../../shared/simple-config'
import { SIMPLE_BUILTIN_OUTBOUNDS } from '../../../../shared/simple-config'
import {
  providerDefinitions,
  providerDraftChange,
  providerDraftRemove
} from '../../utils/relay-rule-providers'
import { useRuleActivity } from '../../hooks/use-relay-rule-editor'
import { RelayProfileRulesManager } from './rules-panel'

export function RelayProfileRuleEditor(props: {
  profile: RelayStoredProfile
  busy: boolean
  onBusy(value: boolean): void
  providers?: boolean
}): React.JSX.Element {
  return props.providers ? (
    <RelayRuleProviderEditor key={props.profile.id + props.profile.sha256} {...props} />
  ) : (
    <RelayProfileRulesManager key={props.profile.id + props.profile.sha256} {...props} />
  )
}

function RelayRuleProviderEditor({
  profile,
  busy,
  onBusy,
  providers = false
}: {
  profile: RelayStoredProfile
  busy: boolean
  onBusy(value: boolean): void
  providers?: boolean
}): React.JSX.Element {
  const label = providers ? '规则提供者' : '规则'
  const [text, setText] = useState(''),
    [loaded, setLoaded] = useState(false)
  const [hints, setHints] = useState(''),
    [proof, setProof] = useState<RelayProfilePreparation>()
  const [notice, setNotice] = useState(''),
    [requiresRead, setRequiresRead] = useState(false),
    [filter, setFilter] = useState(''),
    [editor, setEditor] = useState<{ name?: string; data: SimpleRuleEditor }>(),
    [targets, setTargets] = useState<string[]>([...SIMPLE_BUILTIN_OUTBOUNDS])
  const [baseText, setBaseText] = useState(''),
    [sourceProviders, setSourceProviders] = useState<Record<string, Record<string, unknown>>>({})
  const [resources, setResources] = useState<ResourceInfo[]>([]),
    [providerName, setProviderName] = useState(''),
    [resourceId, setResourceId] = useState('')
  const eligibleResources = resources.filter(
    (info) =>
      ['rule-yaml', 'rule-text', 'rule-mrs'].includes(info.kind) &&
      info.size <= 2 * 1024 * 1024 &&
      info.behavior === sourceProviders[providerName]?.behavior
  )
  const activity = useRuleActivity({ busy, onBusy }, () => {
      setProof(undefined)
      setText('')
      setBaseText('')
      setSourceProviders({})
      setResources([])
      setEditor(undefined)
      setLoaded(false)
      setRequiresRead(true)
      setNotice('提供者范围已失效，请重新读取；在途另存等待真实收尾。')
    }),
    locked = activity.locked
  let definitions: Record<string, Record<string, unknown>> | undefined
  if (loaded) {
    try {
      definitions = providerDefinitions(text)
    } catch {
      /* Keep invalid advanced text; never replace with an empty map. */
    }
  }
  const openEditor = (name?: string): void => {
    if (activity.blocked() || requiresRead || !definitions) return
    const value = name === undefined ? undefined : definitions[name]
    if (
      value &&
      (['type', 'behavior', 'format', 'url', 'path', 'proxy'].some(
        (key) => value[key] !== undefined && typeof value[key] !== 'string'
      ) ||
        (value.payload !== undefined &&
          (!Array.isArray(value.payload) ||
            value.payload.some((item) => typeof item !== 'string'))) ||
        (value.type === 'inline' && !Array.isArray(value.payload)) ||
        ['interval', 'size-limit'].some(
          (key) =>
            value[key] !== undefined &&
            (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0)
        ) ||
        (value.type !== undefined &&
          !new Set<unknown>(['http', 'file', 'inline']).has(value.type)) ||
        (value.behavior !== undefined &&
          !new Set<unknown>(['domain', 'ipcidr', 'classical']).has(value.behavior)) ||
        (value.format !== undefined &&
          !new Set<unknown>(['yaml', 'text', 'mrs']).has(value.format)))
    ) {
      setNotice('当前定义无法无损投影，请保留并使用高级JSON编辑，不会清空字段。')
      return
    }
    setProof(undefined)
    setEditor({
      name,
      data: {
        ruleProviders: structuredClone(definitions),
        rules: [],
        outbounds: targets,
        subRules: []
      }
    })
  }
  const action = async (
    kind: 'read' | 'prepare' | 'save' | 'resources' | 'snapshot' | 'targets'
  ): Promise<void> =>
    activity.run(
      async (check) => {
        if (requiresRead && kind !== 'read') return
        setNotice(`正在检查并保存${label}…`)
        const current = proof
        setProof(undefined)
        const selection = { id: profile.id, sha256: profile.sha256 }
        if (kind === 'read') {
          const result = (await window.electron.ipcRenderer.invoke(
            providers ? 'relayProfileRuleProvidersRead' : 'relayProfileRulesRead',
            selection
          )) as RelayProfileRules | RelayProfileRuleProviders
          check()
          const draft =
            'rules' in result ? result.rules.join('\n') : JSON.stringify(result.providers, null, 2)
          if (providers) providerDefinitions(draft)
          setText(draft)
          setBaseText(draft)
          setResourceId('')
          if (!('rules' in result)) {
            setSourceProviders(result.providers)
            setProviderName(Object.keys(result.providers)[0] ?? '')
          }
          setLoaded(true)
          setRequiresRead(false)
          setEditor(undefined)
          setHints(
            'rules' in result
              ? `目标：${result.targets.slice(0, 200).join('、')}；规则集：${result.providers.join('、') || '无'}；子规则：${result.subRules.join('、') || '无'}。`
              : '编辑JSON对象，键为提供者名称。移除或改名时如其他字段可能引用旧名称，将拒绝准备。'
          )
          setNotice(
            providers
              ? '已读取规则提供者定义，可能含地址和凭据；没有访问地址或文件，点击保存可另存配置副本。'
              : '已读取独立规则草稿。顺序即匹配优先级，删除行或调整顺序后点击保存，检查通过后另存。'
          )
        } else if (kind === 'targets') {
          const rules = (await window.electron.ipcRenderer.invoke(
            'relayProfileRulesRead',
            selection
          )) as RelayProfileRules
          check()
          if (
            !Array.isArray(rules.targets) ||
            rules.targets.some((target) => typeof target !== 'string')
          )
            throw new Error()
          setTargets(rules.targets)
          setNotice('已读取本配置代理目标供结构化表单选择；没有读取或获取提供者正文。')
        } else if (kind === 'resources') {
          const inventory = (await window.electron.ipcRenderer.invoke(
            'relayResourceList'
          )) as ResourceInventory
          check()
          setResources(inventory.resources)
          setResourceId('')
          setNotice(
            `已读取${inventory.resources.length}个缓存候选元数据，未复核正文；选择行为一致的YAML／文本／MRS缓存后单独准备固化。未确认条目${inventory.incomplete}个。`
          )
        } else if (kind === 'snapshot') {
          const resource = eligibleResources.find((info) => info.id === resourceId)
          if (!providers || text !== baseText || !resource || !providerName) throw new Error()
          const prepared = (await window.electron.ipcRenderer.invoke(
            'relayProfileRuleSnapshotPrepare',
            {
              profile: selection,
              provider: providerName,
              resource: { id: resource.id, sha256: resource.sha256 }
            }
          )) as RelayProfilePreparation
          check()
          setProof(prepared)
          if (prepared.inspection.structure !== 'passed') throw new Error('结构检查未通过。')
          const result = (await window.electron.ipcRenderer.invoke('relayProfileSave', {
            evidenceId: prepared.evidenceId
          })) as RelayProfileSaveResult
          check()
          setProof(undefined)
          setNotice(
            result.status === 'saved'
              ? '规则快照已保存为配置副本。'
              : '保存未完成，请读取配置列表核对。'
          )
        } else if (kind === 'prepare') {
          const rules = text
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean)
          const prepared = (await window.electron.ipcRenderer.invoke(
            providers ? 'relayProfileRuleProvidersPrepare' : 'relayProfileRulesPrepare',
            {
              profile: selection,
              ...(providers ? { providers: providerDefinitions(text) } : { rules })
            }
          )) as RelayProfilePreparation
          check()
          setProof(prepared)
          if (prepared.inspection.structure !== 'passed') throw new Error('结构检查未通过。')
          const result = (await window.electron.ipcRenderer.invoke('relayProfileSave', {
            evidenceId: prepared.evidenceId
          })) as RelayProfileSaveResult
          check()
          setProof(undefined)
          setNotice(
            result.status === 'saved'
              ? '修改已保存为配置副本，未启用。'
              : '保存未完成，请读取配置列表核对。'
          )
        } else if (current) {
          const result = (await window.electron.ipcRenderer.invoke('relayProfileSave', {
            evidenceId: current.evidenceId
          })) as RelayProfileSaveResult
          check()
          if (!['saved', 'cancelled'].includes(result.status)) setRequiresRead(true)
          setNotice(
            result.status === 'saved'
              ? `已另存${result.profile?.name ?? '规则配置'}；原配置和运行实例未更改，请刷新配置列表。`
              : result.status === 'cancelled'
                ? `已取消另存，原${label}未更改。`
                : '保存未确认，请刷新列表核对，不会自动重试。'
          )
        }
      },
      () => {
        setProof(undefined)
        if (kind === 'read' || kind === 'save') setRequiresRead(true)
        setNotice(
          providers
            ? '规则提供者操作未通过。请核对定义、缓存行为、大小及来源修订；MRS还需通过固定核心转换，不会访问来源地址或原路径，也不自动重试。'
            : '规则操作未通过。检查单行规则、引用、选项、数量和来源修订；复杂语法仍需另行核心检查。'
        )
      }
    )
  return (
    <div className="relay-panel">
      <h3>
        配置{label}编辑：{profile.name}
      </h3>
      <p>
        {providers
          ? '规则提供者可结构化增改删，也可使用高级JSON；最多200项、512KiB。表单应用仅改本地草稿；点击保存后检查并另存新UUID，不访问所填URL或路径。'
          : '每行一条，空行忽略；可新增、修改、删除或调整顺序。最多10000条，每条不超过8192字符。仅检查结构与引用，核心兼容性未验证；不下载规则集、启动核心或应用网络。'}
        另存JSON副本保留其他字段值，原YAML及注释保持原样。
      </p>
      <button disabled={locked} onClick={() => void action('read')}>
        {loaded && text !== baseText ? `重新读取并放弃未另存${label}草稿` : `读取${label}草稿`}
      </button>
      {requiresRead && <p>范围或保存结果未确认；草稿保留，须显式重新读取后才可继续准备或另存。</p>}
      {loaded && (
        <fieldset disabled={locked}>
          <p>{hints}</p>
          {providers && (
            <>
              <p>
                私有保存定义／缓存不代表活动核心数量、更新时间或已热更新。改名／删除不改写RULE-SET等引用，准备时由后端检查。
              </p>
              <button
                disabled={locked || requiresRead || !definitions}
                onClick={() => openEditor()}
              >
                新增规则提供者草稿
              </button>
              <button disabled={locked || requiresRead} onClick={() => void action('targets')}>
                读取本配置代理目标
              </button>
              {definitions ? (
                <RuleProviderDefinitionList
                  definitions={definitions}
                  filter={filter}
                  onFilter={setFilter}
                  locked={locked || requiresRead}
                  onEdit={openEditor}
                  onRemove={async (name) => {
                    if (activity.blocked() || requiresRead) throw new Error('请等待当前操作')
                    setText(providerDraftRemove(text, name))
                    setProof(undefined)
                    setNotice('仅从本地草稿移除，引用未修改；请点击保存配置副本。')
                  }}
                />
              ) : (
                <p role="alert">高级JSON无效或无法投影；草稿已保留，结构化操作暂不可用。</p>
              )}
            </>
          )}
          <label>
            {providers ? '规则提供者JSON（可能含凭据）' : '规则列表（按优先级，每行一条）'}{' '}
            <textarea
              rows={15}
              maxLength={providers ? 512 * 1024 : 2 * 1024 * 1024}
              aria-label={providers ? '规则提供者高级JSON草稿' : '规则列表草稿'}
              spellCheck={false}
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                setProof(undefined)
              }}
            />
          </label>
          <button disabled={requiresRead} onClick={() => void action('prepare')}>
            保存{label}到配置副本
          </button>
          {providers && (
            <div>
              <p>
                固化只使用已保存配置，当前定义草稿不会合并。规则资源须先在资源面板获取；支持不超过2MiB、行为一致的YAML／文本缓存和domain／ipcidr的MRS缓存。MRS在隔离进程中转换为有界内联规则；需额外资源的规则暂不支持。
              </p>
              <button onClick={() => void action('resources')}>读取已缓存规则资源</button>
              <label>
                待固化提供者{' '}
                <select
                  value={providerName}
                  onChange={(event) => {
                    setProviderName(event.target.value)
                    setResourceId('')
                    setProof(undefined)
                  }}
                >
                  <option value="">选择已保存提供者</option>
                  {Object.keys(sourceProviders).map((name) => (
                    <option key={name} value={name}>
                      {name} · {String(sourceProviders[name].behavior)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                对应规则缓存{' '}
                <select
                  value={resourceId}
                  onChange={(event) => {
                    setResourceId(event.target.value)
                    setProof(undefined)
                  }}
                >
                  <option value="">选择缓存（尚待摘要复核）</option>
                  {eligibleResources.map((info) => (
                    <option key={info.id} value={info.id}>
                      {info.name} · {info.kind} · {info.sha256.slice(0, 12)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={text !== baseText || !providerName || !resourceId}
                onClick={() => void action('snapshot')}
              >
                固化并保存内联规则快照
              </button>
              {text !== baseText && (
                <p>定义草稿已修改，请先另存并选择新配置，或重新读取原配置后固化。</p>
              )}
            </div>
          )}
        </fieldset>
      )}
      {editor && (
        <RuleProviderEditorView
          key={editor.name ?? 'new'}
          name={editor.name}
          data={editor.data}
          busy={locked || requiresRead}
          saveLabel="应用到草稿"
          preservePayload
          description="只修改本地完整定义草稿。不会下载、保存文件或更新活动提供者；之后点击保存，检查通过后另存新UUID。"
          onClose={() => setEditor(undefined)}
          onSave={(change) => {
            if (activity.blocked() || requiresRead) throw new Error('提供者范围未确认')
            setText(providerDraftChange(text, change))
            setProof(undefined)
            setNotice('已应用到本地草稿，尚未保存；请点击保存配置副本。')
          }}
        />
      )}
      {proof && (
        <p>
          待另存 {proof.name} · {proof.bytes}字节 · SHA256 {proof.sha256}
        </p>
      )}
      {proof?.ruleSnapshot && (
        <p>
          固化 {proof.ruleSnapshot.provider} · {proof.ruleSnapshot.behavior} ·{' '}
          {proof.ruleSnapshot.rules}条 · 资源SHA256 {proof.ruleSnapshot.resourceSHA256}
          。原来源地址、文件路径、请求头及自动更新设置只从此新提供者定义移除。
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
