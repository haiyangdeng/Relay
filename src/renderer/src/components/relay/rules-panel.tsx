import { useEffect, useRef, useState } from 'react'
import { Button, Chip, Input, Spinner } from '@heroui/react'
import { parseSimpleRule } from '../../../../shared/simple-rules'
import { useRelayInitialRead } from '../../hooks/use-relay-initial-read'
import type { RelayStoredProfile } from '../../../../shared/relay/profiles'
import type {
  LocalProxyRule,
  LocalProxyState,
  LocalProxyResult,
  LocalProxyRulesSnapshot
} from '../../../../shared/relay/local-proxy'
import type { TunSessionState } from '../../../../shared/relay/tun'
import type {
  TunRuntimeRulesResult,
  TunRuntimeRulesSnapshot
} from '../../../../shared/relay/tun-rules'
import {
  useRelayProfileRules,
  useRelayRulePatch,
  useRuleActivity
} from '../../hooks/use-relay-rule-editor'
import { RelayRuleListEditor } from '../rules/relay-rule-list-editor'
import RuleItem from '../rules/rule-item'
import type { RuleOwner } from '../../utils/relay-rule-editor'

export function RelayProfileRulesManager({
  profile,
  busy,
  onBusy
}: {
  profile: RelayStoredProfile
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const config = useRelayProfileRules(profile, { busy, onBusy })
  return (
    <section className="relay-panel" aria-label={`完整规则副本 ${profile.name}`}>
      <h3>完整规则副本：{profile.name}</h3>
      <p>
        增改、插入、移除或拖动只修改草稿。点击另存后检查并保存；原配置和当前连接不变，不自动选择或启用副本。
      </p>
      <p>原来源专用补丁不会搬到新UUID；如需给副本添加补丁，请刷新来源列表后单独选择该副本。</p>
      <button disabled={config.locked} onClick={() => void config.read()}>
        {config.dirty ? '重新读取并放弃未另存规则草稿' : '读取完整规则草稿'}
      </button>
      <p role="status">{config.notice}</p>
      {config.data && (
        <>
          {config.dirty && <p>草稿有尚未另存修改；重新读取会放弃这些本地修改。</p>}
          <RelayRuleListEditor
            key={config.readEpoch}
            label="完整规则"
            rows={config.rows}
            context={config.data}
            locked={config.locked || config.requiresRead}
            onChange={config.change}
          />
          <Button
            color="primary"
            size="sm"
            isDisabled={config.locked || config.requiresRead || !config.dirty}
            onPress={() => void config.saveCopy()}
          >
            另存规则副本
          </Button>
        </>
      )}
    </section>
  )
}

interface RulesManagerProps {
  active?: boolean
  preferredProfile?: RelayStoredProfile

  busy: boolean
  onBusy(value: boolean): void
  onChanged?(): void
  localState?: LocalProxyState
  onLocalState?(state: LocalProxyState, expected: RuleOwner): void
  tunState?: TunSessionState
  tunUnconfirmed?: boolean
  runtimeBusy?: boolean
}

function RelayRulesAdvancedManager(props: RulesManagerProps): React.JSX.Element {
  const config = useRelayRulePatch(props),
    [fullProfile, setFullProfile] = useState<RelayStoredProfile>()
  useRelayInitialRead(props.active ?? true, !!config.base, config.locked, config.read)
  useEffect(() => {
    const clear = (): void => setFullProfile(undefined),
      remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', clear),
      restored = window.electron.ipcRenderer.on('relayDataRestored', clear)
    return () => {
      remove()
      restored()
    }
  }, [])
  const locked = config.locked || !config.base || config.requiresRead
  return (
    <section className="relay-panel" aria-label="结构化规则管理">
      <h2>结构化规则与补丁管理</h2>
      <p>
        完整规则另存副本、规则补丁、运行临时开关是三种独立操作。此处保存补丁不切换核心、不禁用当前运行规则。
      </p>
      <button
        disabled={config.locked}
        onClick={() => {
          setFullProfile(undefined)
          void config.read()
        }}
      >
        {config.dirty ? '重新读取并放弃未保存规则补丁' : '读取规则补丁与来源'}
      </button>
      <p role="status">{config.notice}</p>
      {config.base && (
        <>
          <label>
            补丁范围
            <select
              aria-label="规则补丁范围"
              value={config.scope}
              disabled={locked}
              onChange={(event) => {
                setFullProfile(undefined)
                config.selectScope(event.target.value)
              }}
            >
              <option value="">全局规则补丁</option>
              {config.profiles?.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <p>
            切换补丁范围会放弃该处未保存草稿；其他来源的已保存补丁仍保留。全局补丁先执行，再执行当前来源补丁。
          </p>
          {config.dirty && <p>补丁尚未保存；重新读取或切换范围会放弃未保存修改。</p>}
          {!config.scope && (
            <label>
              规则上下文与预览来源
              <select
                aria-label="规则上下文来源"
                value={config.contextId}
                disabled={locked}
                onChange={(event) => {
                  setFullProfile(undefined)
                  config.selectContext(event.target.value)
                }}
              >
                <option value="">选择已保存来源</option>
                {config.profiles?.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button disabled={locked || !config.selected} onClick={() => void config.readContext()}>
            读取所选来源规则上下文
          </button>
          <p>
            目标与规则集名称仅来自显式读取的来源；不读取提供者正文，不证明全局补丁在每个来源都可用。
          </p>
          {(['prepend', 'append', 'delete'] as const).map((group) => (
            <RelayRuleListEditor
              key={config.readEpoch + ':' + config.scope + ':' + group}
              label={
                group === 'prepend' ? '前置规则' : group === 'append' ? '后置规则' : '精确排除规则'
              }
              rows={config.rows[group]}
              context={config.context}
              locked={locked}
              patchKind={group}
              onChange={(rows) => config.change(group, rows)}
            />
          ))}
          <p>
            精确排除按完整字符串删除所有相同项，不能代表只禁用某一重复行。普通前置／后置与位置前缀不同；位置按现合并器处理，已有无法由新输入表示的前缀仍原样保留。
          </p>
          <p>
            新位置N为非负整数：前置按当前数组的第N个位置插入，0在开头；后置按距末尾N个位置插入，0在末尾。越界沿现合并器夹取，同位置多项不重新排序或去重，请预览最终结果。
          </p>
          <button disabled={locked || !config.dirty} onClick={() => void config.save()}>
            保存所选范围规则补丁
          </button>
          <button disabled={locked || !config.selected} onClick={() => void config.makePreview()}>
            预览此来源最终规则
          </button>
          {config.preview && (
            <details open>
              <summary>候选最终规则（尚未保存或启用）</summary>
              <ol>
                {config.preview.map((rule, index) => (
                  <li key={index}>
                    <code>{rule}</code>
                  </li>
                ))}
              </ol>
            </details>
          )}
          <button
            disabled={locked || !config.selected}
            onClick={() => setFullProfile(config.selected)}
          >
            打开所选来源完整规则副本编辑
          </button>
        </>
      )}
      {fullProfile && (
        <RelayProfileRulesManager
          key={fullProfile.id + fullProfile.sha256}
          profile={fullProfile}
          busy={props.busy}
          onBusy={props.onBusy}
        />
      )}
    </section>
  )
}

export function RelaySavedRulesList({
  profile,
  active = true,
  busy,
  onBusy
}: {
  profile: RelayStoredProfile
  active?: boolean
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const config = useRelayProfileRules(profile, { busy, onBusy })
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(200)
  const [editing, setEditing] = useState(false)
  useRelayInitialRead(active, !!config.data, config.locked, config.read)
  const rules = (config.requiresRead ? [] : (config.data?.rules ?? []))
    .map((value, index) => ({ value, index, ...parseSimpleRule(value) }))
    .filter((rule) => rule.value.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  return (
    <section aria-label="保存的配置规则" data-relay-saved-rules={profile.id}>
      <div className="flex items-center gap-2 mb-3">
        {!editing && (
          <Input
            size="sm"
            aria-label="筛选保存的规则"
            placeholder="筛选域名、目标或规则类型"
            value={filter}
            onValueChange={(value) => {
              setFilter(value)
              setLimit(200)
            }}
          />
        )}
        <Button
          size="sm"
          variant="flat"
          isDisabled={config.locked}
          onPress={() => void config.read()}
        >
          刷新
        </Button>
        <Button
          size="sm"
          color={editing ? 'primary' : 'default'}
          variant={editing ? 'solid' : 'flat'}
          isDisabled={config.locked || !config.data || config.requiresRead}
          onPress={() => setEditing((value) => !value)}
        >
          {editing ? '查看规则' : '编辑规则'}
        </Button>
      </div>
      <p className="text-xs mb-3">
        {profile.name} · {config.data?.rules.length ?? profile.summary.rules} 条规则 · 已保存配置
      </p>
      {config.pending && <Spinner size="sm" label="读取规则" />}
      {config.requiresRead && <p role="alert">规则读取未确认，请刷新。原配置未改动。</p>}
      {editing ? (
        <>
          <p className="text-xs mb-3">编辑后另存为配置副本；原配置与当前连接保持不变。</p>
          <RelayRuleListEditor
            key={config.readEpoch}
            label="完整规则"
            rows={config.rows}
            context={config.data}
            locked={config.locked || config.requiresRead}
            onChange={config.change}
          />
          <Button
            size="sm"
            color="primary"
            isDisabled={config.locked || config.requiresRead || !config.dirty}
            onPress={() => void config.saveCopy()}
          >
            另存规则副本
          </Button>
          {config.notice && (
            <p className="text-xs" role="status">
              {config.notice}
            </p>
          )}
        </>
      ) : (
        <div className="space-y-2" role="list">
          {rules.slice(0, limit).map((rule) => (
            <div
              role="listitem"
              key={rule.index}
              className="rounded-xl bg-content1 border border-default-200 px-3 py-3"
            >
              <div className="text-sm font-medium break-all mb-2">
                {rule.payload || '其他全部连接'}
              </div>
              <div className="flex flex-wrap gap-2">
                <Chip size="sm" variant="bordered">
                  {rule.type}
                </Chip>
                <Chip size="sm" variant="bordered">
                  {rule.target}
                </Chip>
                {rule.options.map((option) => (
                  <Chip key={option} size="sm" variant="flat">
                    {option}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {!editing && config.data && !rules.length && <p>没有匹配的规则。</p>}
      {!editing && rules.length > limit && (
        <Button className="mt-3" size="sm" onPress={() => setLimit((value) => value + 200)}>
          加载更多（{limit}/{rules.length}）
        </Button>
      )}
    </section>
  )
}

export function RelayRulesManager(props: RulesManagerProps): React.JSX.Element {
  const [advanced, setAdvanced] = useState(false)
  const live = !!(
    props.localState?.owned &&
    props.localState.phase === 'running' &&
    !props.localState.uncertain
  )
  const liveTun = !!(
    props.tunState?.owned &&
    props.tunState.phase === 'active' &&
    props.tunState.traffic === 'forwarding' &&
    !props.tunUnconfirmed
  )
  return (
    <section className="relay-panel" aria-label="分流规则">
      {live ? (
        <RelayRuntimeRulesPanel
          {...props}
          active={props.active}
          state={props.localState}
          onState={props.onLocalState}
        />
      ) : liveTun ? (
        <RelayTunRuntimeRulesPanel
          active={props.active}
          busy={props.runtimeBusy ?? props.busy}
          onBusy={props.onBusy}
          state={props.tunState}
          unconfirmed={props.tunUnconfirmed}
        />
      ) : props.preferredProfile ? (
        <RelaySavedRulesList
          key={props.preferredProfile.id + props.preferredProfile.sha256}
          profile={props.preferredProfile}
          active={props.active}
          busy={props.busy}
          onBusy={props.onBusy}
        />
      ) : (
        <p>请先在订阅管理中导入或选择配置。</p>
      )}
      <details
        className="mt-4"
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
      >
        <summary>编辑规则与高级设置</summary>
        <RelayRulesAdvancedManager {...props} active={(props.active ?? true) && advanced} />
        {props.tunState?.owned && !liveTun && (
          <RelayTunRuntimeRulesPanel
            busy={props.runtimeBusy ?? props.busy}
            onBusy={props.onBusy}
            state={props.tunState}
            unconfirmed={props.tunUnconfirmed}
          />
        )}
      </details>
    </section>
  )
}

export function RelayRuntimeRulesPanel(props: {
  active?: boolean
  busy: boolean
  onBusy(value: boolean): void
  state?: LocalProxyState
  onState?(state: LocalProxyState, expected: RuleOwner): void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<LocalProxyRulesSnapshot>(),
    [filter, setFilter] = useState(''),
    [notice, setNotice] = useState(''),
    stateRef = useRef(props.state)
  stateRef.current = props.state
  const activity = useRuleActivity(props, () => {
    setSnapshot(undefined)
    setFilter('')
    setNotice('运行规则上下文已失效，请重新读取；在途请求等待真实收尾，不停止核心。')
  })
  const instanceId = props.state?.instanceId,
    configurationRevision = props.state?.configurationRevision,
    owned = props.state?.owned,
    phase = props.state?.phase,
    uncertain = props.state?.uncertain
  useEffect(() => {
    setSnapshot(undefined)
    setNotice('当前自有实例或配置范围已变化，请显式读取运行规则。')
  }, [instanceId, configurationRevision, owned, phase, uncertain])
  const canRead = !!(
    owned &&
    phase === 'running' &&
    !uncertain &&
    !props.state?.pending &&
    instanceId &&
    configurationRevision
  )
  const current =
    canRead &&
    snapshot?.instanceId === instanceId &&
    snapshot.configurationRevision === configurationRevision
      ? snapshot
      : undefined
  const action = (index?: number, disabled?: boolean): Promise<void> =>
    activity.run(
      async (check) => {
        const expectedState = props.state
        if (!canRead || !instanceId || !configurationRevision)
          throw new Error('没有已确认自有实例。')
        if (!expectedState) throw new Error('没有已确认自有实例。')
        const previous = current,
          mutation = index !== undefined
        if (
          mutation &&
          (!previous ||
            typeof disabled !== 'boolean' ||
            typeof previous.rules.find((rule) => rule.index === index)?.disabled !== 'boolean')
        )
          throw new Error('请重新读取可操作规则。')
        setNotice(
          mutation ? '正在提交并整表读回复核；没有乐观更改开关。' : '读取当前自有实例的规则表…'
        )
        const result = (await window.electron.ipcRenderer.invoke(
          'relayLocalProxyAction',
          mutation
            ? {
                action: 'rule',
                instanceId,
                configurationRevision,
                rulesSHA256: previous?.rulesSHA256,
                index,
                disabled
              }
            : { action: 'rules', instanceId }
        )) as LocalProxyResult
        check()
        const live = stateRef.current
        if (
          !live?.owned ||
          live.phase !== 'running' ||
          live.uncertain ||
          live.instanceId !== instanceId ||
          live.configurationRevision !== configurationRevision
        )
          return
        props.onState?.(result.state, expectedState)
        const next = result.rules
        if (
          (result.status === 'refreshed' || result.status === 'ruleChanged') &&
          result.state.owned &&
          result.state.phase === 'running' &&
          !result.state.uncertain &&
          result.state.instanceId === instanceId &&
          result.state.configurationRevision === configurationRevision &&
          next &&
          next.instanceId === instanceId &&
          next.configurationRevision === configurationRevision
        ) {
          setSnapshot(next)
          setNotice(
            result.status === 'ruleChanged'
              ? '当前自有实例临时禁用位已整表读回确认；没有写入配置，完整重载会重新创建规则状态。'
              : '已读取本次自有实例规则快照；没有改变规则或持久化状态。'
          )
        } else {
          setSnapshot(undefined)
          setNotice(
            result.status === 'cancelled'
              ? '已取消本次规则操作；旧快照已失效，请显式重新读取。'
              : '规则操作结果未确认；旧快照已失效，不自动重试、回滚或停止核心。'
          )
        }
      },
      () => {
        setSnapshot(undefined)
        setNotice('运行规则读取或操作未确认；旧快照已失效，请重新读取，不自动重试或停止核心。')
      }
    )
  useRelayInitialRead(props.active ?? true, !!current, activity.locked || !canRead, () => action())
  return (
    <section aria-label="自有本地代理临时规则开关">
      <h3>运行规则</h3>
      <p className="text-xs">开关仅影响当前运行实例，重新载入配置后恢复。</p>
      <button disabled={activity.locked || !canRead} onClick={() => void action()}>
        刷新运行规则
      </button>
      <p role="status">{notice}</p>
      {current && (
        <>
          <details>
            <summary>运行详情</summary>
            <p>
              实例 {current.instanceId} · 配置修订 {current.configurationRevision} · 规则表{' '}
              {current.rulesSHA256}
            </p>
          </details>
          <RuntimeRulesTable
            rules={current.rules}
            filter={filter}
            onFilter={setFilter}
            locked={activity.locked}
            onChange={action}
          />
        </>
      )}
      {!canRead && <p>请先沿独立工作流确认自有本地代理实例；这里不会启动核心或探测旧TUN宿主。</p>}
    </section>
  )
}

function RuntimeRulesTable(props: {
  rules: readonly LocalProxyRule[]
  filter: string
  filterLabel?: string
  onFilter(value: string): void
  locked: boolean
  onChange(index: number, disabled: boolean): Promise<void>
}): React.JSX.Element {
  const visible = props.rules.filter((rule) =>
    [rule.type, rule.payload, rule.proxy].some((value) =>
      value.toLowerCase().includes(props.filter.toLowerCase())
    )
  )
  return (
    <>
      <Input
        aria-label={props.filterLabel ?? '运行规则筛选'}
        value={props.filter}
        isDisabled={props.locked}
        onValueChange={props.onFilter}
      />
      {visible.map((rule) => (
        <div key={rule.index}>
          <RuleItem
            index={rule.index}
            type={rule.type}
            payload={rule.payload}
            proxy={rule.proxy}
            size={rule.size ?? -1}
            runtimeStatistics={rule.statistics}
            runtimeToggle={
              typeof rule.disabled === 'boolean'
                ? {
                    disabled: rule.disabled,
                    locked: props.locked,
                    onChange: (value) => props.onChange(rule.index, value)
                  }
                : undefined
            }
          />
          {typeof rule.disabled !== 'boolean' && (
            <p>此行没有可验证的wrapper禁用位，仅可查看，不提供开关。</p>
          )}
        </div>
      ))}
    </>
  )
}

export function RelayTunRuntimeRulesPanel(props: {
  active?: boolean
  busy: boolean
  onBusy(value: boolean): void
  state?: TunSessionState
  unconfirmed?: boolean
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<{ scope: number; value: TunRuntimeRulesSnapshot }>(),
    [filter, setFilter] = useState<{ scope: number; value: string }>(),
    [notice, setNotice] = useState<{ scope: number; value: string }>(),
    stateRef = useRef({ state: props.state, unconfirmed: props.unconfirmed }),
    scopeRef = useRef({ key: '', generation: 0 })
  stateRef.current = { state: props.state, unconfirmed: props.unconfirmed }
  // The same owner becoming pending does not lose its in-flight operation.
  // TunSessionState has no configuration revision; only Native snapshots do.
  const scopeKey = JSON.stringify([
    props.state?.sessionId,
    props.state?.owned,
    props.state?.phase,
    props.state?.traffic,
    !!props.unconfirmed
  ])
  if (scopeRef.current.key !== scopeKey)
    scopeRef.current = { key: scopeKey, generation: scopeRef.current.generation + 1 }
  const scope = scopeRef.current.generation,
    activity = useRuleActivity(props, () => {
      setSnapshot(undefined)
      setFilter(undefined)
      setNotice({ scope, value: 'TUN规则上下文已失效，请显式重新读取；在途请求等待真实收尾。' })
    }),
    owner = props.state,
    canRead = !!(
      owner?.sessionId &&
      owner.owned &&
      owner.phase === 'active' &&
      owner.traffic === 'forwarding' &&
      !owner.pending &&
      !props.unconfirmed
    ),
    current =
      canRead && snapshot?.scope === scope && snapshot.value.sessionId === owner?.sessionId
        ? snapshot.value
        : undefined
  const action = (index?: number, disabled?: boolean): Promise<void> =>
    activity.run(
      async (check) => {
        const sessionId = owner?.sessionId,
          previous = current,
          mutation = index !== undefined
        const live = (): void => {
          check()
          const latest = stateRef.current
          if (
            scopeRef.current.generation !== scope ||
            latest.unconfirmed ||
            !latest.state?.owned ||
            latest.state.phase !== 'active' ||
            latest.state.traffic !== 'forwarding' ||
            latest.state.sessionId !== sessionId
          )
            throw new Error('本次TUN规则范围已变化。')
        }
        if (!canRead || !sessionId) throw new Error('没有已确认自有TUN。')
        if (
          mutation &&
          (!previous ||
            typeof disabled !== 'boolean' ||
            typeof previous.rules.find((rule) => rule.index === index)?.disabled !== 'boolean')
        )
          throw new Error('请重新读取可操作的TUN规则。')
        live()
        setNotice({
          scope,
          value: mutation
            ? '正在提交并复核TUN完整规则表；没有乐观更改开关。'
            : '读取本次已确认TUN的Native规则快照…'
        })
        const result = (await window.electron.ipcRenderer.invoke(
          mutation ? 'relayTunRuleChange' : 'relayTunRulesRead',
          mutation
            ? {
                sessionId,
                configurationRevision: previous?.configurationRevision,
                rulesSHA256: previous?.rulesSHA256,
                index,
                disabled
              }
            : { sessionId }
        )) as TunRuntimeRulesResult
        live()
        if (result.sessionId !== sessionId) throw new Error('TUN回执会话不匹配。')
        if (
          (mutation
            ? result.status === 'changed' || result.status === 'unchanged'
            : result.status === 'snapshot') &&
          'snapshot' in result &&
          result.snapshot.sessionId === sessionId &&
          (!mutation ||
            (result.snapshot.configurationRevision === previous?.configurationRevision &&
              result.snapshot.rules.find((rule) => rule.index === index)?.disabled === disabled))
        ) {
          setSnapshot({ scope, value: result.snapshot })
          setNotice({
            scope,
            value: mutation
              ? '本次TUN临时禁用位已整表读回确认；未写配置，完整重载会重新创建规则状态。'
              : '已读取本次TUN的Native规则快照；不是当前配置的持久副本。'
          })
        } else {
          setSnapshot(undefined)
          setNotice({
            scope,
            value:
              result.status === 'unsupported'
                ? '本次客户端未提供独立TUN规则能力；未探测旧宿主或转用本地代理。'
                : result.status === 'cancelled'
                  ? '已取消本次TUN规则操作；旧快照已失效，请显式重新读取。'
                  : 'TUN规则选择或结果未确认；旧快照已失效，不自动重试、回滚或停止核心。'
          })
        }
      },
      () => {
        if (scopeRef.current.generation !== scope) return
        setSnapshot(undefined)
        setNotice({ scope, value: 'TUN规则操作未确认；请显式重新读取，不转用其他实例或停止核心。' })
      }
    )
  useRelayInitialRead(props.active ?? true, !!current, activity.locked || !canRead, () => action())
  return (
    <section aria-label="自有TUN临时规则开关">
      <h3>TUN 运行规则</h3>
      <p className="text-xs">开关仅影响当前运行实例，重新载入配置后恢复。</p>
      <details>
        <summary>运行详情</summary>
        <p>
          只操作本次已确认TUN，不需要HTTP代理端口。每次更改均重新核对Native配置修订、完整表摘要与行禁用位，不保存索引或修改父层TUN状态。
        </p>
      </details>
      <button disabled={activity.locked || !canRead} onClick={() => void action()}>
        读取当前TUN运行规则
      </button>
      <p role="status">
        {notice?.scope === scope ? notice.value : '请选择本次已确认的活动TUN后显式读取规则。'}
      </p>
      {current && (
        <>
          <p>
            会话 {current.sessionId} · Native配置修订 {current.configurationRevision} · 规则表{' '}
            {current.rulesSHA256}
          </p>
          <RuntimeRulesTable
            rules={current.rules}
            filter={filter?.scope === scope ? filter.value : ''}
            filterLabel="TUN运行规则筛选"
            onFilter={(value) => setFilter({ scope, value })}
            locked={activity.locked}
            onChange={action}
          />
        </>
      )}
      {!canRead && <p>仅已确认、自有且转发中的TUN可读取；pending期间不开始新操作。</p>}
    </section>
  )
}
