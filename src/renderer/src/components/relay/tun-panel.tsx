import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { Button, Chip, Switch } from '@heroui/react'
import SettingCard from '@renderer/components/base/base-setting-card'
import './network-settings.css'
import {
  ordinaryRecoveryNotice,
  type TunPlanIssue,
  type TunSessionState
} from '../../../../shared/relay/tun'
import { RelayTunSettingsEditor } from './tun-settings-editor'
import { createTunRendererApi } from './tun-api'
import { relayProfileRead } from './profile-read-queue'
import { prepareCurrentTunConfiguration, readTunProfileId } from './tun-configuration-action'
import {
  createTunPanelController,
  activeTunSwitch,
  tunSwitchProgress,
  tunStoppingNotice,
  type TunPanelSnapshot
} from './tun-controller'

const issues: Record<TunPlanIssue, string> = {
  parserNotPassed: '完整配置尚未通过固定核心检查',
  parserDigestMismatch: '完整检查摘要已变化',
  helperNotReady: '辅助组件尚未就绪',
  helperIdentityUnconfirmed: '辅助组件身份未确认',
  helperAuthorizationUnconfirmed: '辅助组件尚未获准',
  helperResourceMismatch: '辅助组件或核心资源版本不匹配',
  helperPrivilegeUnconfirmed: '辅助组件权限未确认',
  helperClientMismatch: '辅助组件授权用户不匹配',
  networkUnconfirmed: '网络基线未确认',
  existingTunnelUnresolved: '已有TUN状态需要复核',
  recoveryUnavailable: '恢复条件未就绪',
  observationExpired: '原生观察已过期'
}
export function RelayTunControls({
  snapshot,
  completeEvidenceId,
  busy,
  activationBlocked = false,
  now,
  onAction,
  onCancel,
  onEnable,
  settings,
  canPrepareConfiguration = false,
  settingsDirty = false,
  bindShortcut = false
}: {
  snapshot: TunPanelSnapshot
  completeEvidenceId?: string
  busy: boolean
  activationBlocked?: boolean
  now: number
  onAction(action: NonNullable<TunPanelSnapshot['action']>): void
  onCancel(): void
  onEnable?(): void
  settings?: ReactNode
  canPrepareConfiguration?: boolean
  settingsDirty?: boolean
  bindShortcut?: boolean
}): React.JSX.Element {
  const transition = useSyncExternalStore(
    tunSwitchProgress.subscribe,
    tunSwitchProgress.read,
    tunSwitchProgress.read
  )
  const state = snapshot.status?.session,
    ordinaryRecovery = snapshot.status?.ordinaryRecovery,
    closingTun =
      transition === 'stop' ||
      (snapshot.pending && snapshot.action === 'stop') ||
      state?.phase === 'stopping',
    locked =
      ordinaryRecovery?.phase === 'resuming' ||
      !!transition ||
      closingTun ||
      busy ||
      snapshot.pending ||
      !!state?.pending,
    plan = snapshot.preparedFor === completeEvidenceId ? snapshot.preparation : undefined,
    ready = !!plan?.readyForConfirmation && now <= plan.expiresAt,
    phase =
      transition === 'recover' || ordinaryRecovery?.phase === 'resuming'
        ? '正在恢复普通代理'
        : !closingTun && ordinaryRecovery?.phase === 'failed'
          ? '普通代理待恢复'
          : closingTun
            ? '正在关闭'
            : snapshot.unconfirmed
              ? '结果待复核'
              : snapshot.pending && snapshot.action === 'prepare'
                ? '正在检查配置'
                : state
                  ? {
                      idle: '已关闭',
                      prepared: '已关闭',
                      starting: '正在启动',
                      active: state.traffic === 'forwarding' ? '已开启' : '结果待复核',
                      stopping: '正在停用并恢复',
                      restored: '已关闭',
                      released: '已关闭',
                      uncertain: '结果待复核'
                    }[state.phase]
                  : '正在读取',
    helper = snapshot.status?.helper,
    enabled = !snapshot.unconfirmed && state?.phase === 'active' && state.traffic === 'forwarding',
    canStop = !!state?.owned && !!state.sessionId,
    enableBlocked =
      activationBlocked ||
      (!completeEvidenceId && !canPrepareConfiguration) ||
      settingsDirty ||
      helper !== 'ready' ||
      !!state?.owned ||
      snapshot.unconfirmed,
    blockedReason =
      helper === 'missing' || helper === 'requiresApproval'
        ? '首次使用需安装 Relay 的 TUN 权限组件；Clash Party 的授权不能直接用于 Relay。'
        : activationBlocked
          ? '请先结束 Relay 当前的其他代理或桌面会话，再启用虚拟网卡。'
          : settingsDirty
            ? 'TUN 设置尚未保存，请先保存后再开启。'
            : helper !== 'ready'
              ? '内核授权状态未读取成功，请刷新后重试。'
              : !completeEvidenceId && !canPrepareConfiguration
                ? '请先在订阅管理中选择配置。'
                : ''
  const switchDisabled = locked || (enabled ? !canStop : enableBlocked || !onEnable)
  const handlers = useRef({ onAction, onEnable })
  handlers.current = { onAction, onEnable }
  const networkSwitch = useMemo(
    () => ({
      checked: enabled,
      disabled: switchDisabled,
      setEnabled(next: boolean) {
        if (switchDisabled || next === enabled) return
        if (!next) handlers.current.onAction('stop')
        else if (ready && !canPrepareConfiguration) handlers.current.onAction('start')
        else handlers.current.onEnable?.()
      }
    }),
    [enabled, switchDisabled, ready, canPrepareConfiguration]
  )
  useLayoutEffect(() => {
    return bindShortcut ? activeTunSwitch.bind(networkSwitch) : undefined
  }, [bindShortcut, networkSwitch])
  return (
    <section className="relay-network-settings" data-relay-settings="tun">
      <div className="relay-network-toolbar">
        <div>
          <h2>虚拟网卡</h2>
          <p>通过虚拟网卡转发流量。开启后应用路由与 DNS 设置，关闭后恢复。</p>
        </div>
        <Chip size="sm" variant="flat">
          {phase}
        </Chip>
      </div>
      <SettingCard>
        <div className="relay-setting-row">
          <span>启用虚拟网卡</span>
          <div className="flex items-center gap-3">
            <span>{phase}</span>
            <Switch
              size="sm"
              aria-label="启用虚拟网卡"
              isSelected={networkSwitch.checked}
              isDisabled={networkSwitch.disabled}
              onValueChange={networkSwitch.setEnabled}
            />
          </div>
        </div>
        <div className="relay-setting-row">
          <span>内核授权</span>
          <div className="flex items-center gap-3">
            <span className="relay-network-state">
              {helper === 'ready'
                ? '已就绪'
                : helper === 'missing'
                  ? '未授权'
                  : helper === 'requiresApproval'
                    ? '需要授权'
                    : '待核对'}
            </span>
            <Button
              size="sm"
              variant="flat"
              isDisabled={busy || snapshot.pending}
              onPress={() => onAction('status')}
            >
              刷新授权状态
            </Button>
          </div>
        </div>
        {plan && (
          <>
            <div className="relay-setting-row">
              <span>网卡名称</span>
              <span>{plan.effects.device}</span>
            </div>
            <div className="relay-setting-row">
              <span>自动路由</span>
              <span>{plan.effects.autoRoute ? '开启' : '关闭'}</span>
            </div>
            <div className="relay-setting-row">
              <span>DNS 劫持</span>
              <span>{plan.effects.dnsHijack ? '开启' : '关闭'}</span>
            </div>
          </>
        )}
      </SettingCard>
      {settings}
      <div className="relay-network-actions">
        {ordinaryRecovery?.phase === 'failed' && (
          <Button size="sm" variant="flat" isDisabled={locked} onPress={() => onAction('recover')}>
            恢复普通代理
          </Button>
        )}
        <Button
          size="sm"
          variant="flat"
          isDisabled={locked || !state?.owned || !state.sessionId}
          onPress={() => onAction('stop')}
        >
          停用并恢复网络
        </Button>
        <Button
          size="sm"
          variant="light"
          isDisabled={busy || snapshot.pending}
          onPress={() => onAction('status')}
        >
          刷新状态
        </Button>
        <a className="text-primary text-sm self-center" href="#/relay?panel=configuration">
          高级配置与资源
        </a>
      </div>
      {!closingTun && !enabled && !snapshot.unconfirmed && blockedReason && (
        <p className="relay-network-notice" role="status">
          {blockedReason}
        </p>
      )}
      {(helper === 'missing' || helper === 'requiresApproval') && (
        <details open>
          <summary>安装与授权说明</summary>
          <p>
            使用本版交付目录中的 RelayTun-CoreManaged-v2-local-geodata-v1.pkg，双击后按 macOS
            安装器提示输入管理员密码。
          </p>
          <p>
            安装完成后点击“刷新授权状态”。该组件属于 Relay，安装不会替你停止 Clash Party 或自动启用
            TUN。
          </p>
        </details>
      )}
      {snapshot.unconfirmed && (
        <p className="relay-network-notice" role="alert">
          会话状态未确认，请保留窗口并重新读取；其他配置操作暂缓。
        </p>
      )}
      {activationBlocked && (
        <p className="relay-network-notice">
          其他会话正在运行。可查看和保存下次使用的设置；启用 TUN 前需先结束这些会话。
        </p>
      )}
      {(ordinaryRecovery || closingTun || snapshot.notice) && (
        <p className="relay-network-notice" role="status">
          {ordinaryRecovery
            ? ordinaryRecoveryNotice(ordinaryRecovery)
            : closingTun
              ? tunStoppingNotice
              : snapshot.notice}
        </p>
      )}
      {!closingTun &&
        [...(snapshot.status?.warnings ?? []), ...(state?.warnings ?? [])].map((line, index) => (
          <p className="relay-network-notice" role="status" key={index}>
            {line}
          </p>
        ))}
      <details>
        <summary>会话详情与手动控制</summary>
        <p>
          使用最新通过完整检查的候选。点击启用后核对接口、路由、DNS及连接影响；停用只恢复本次会话。TUN不代表Claude禁止直连保护已验证。
        </p>
        <p>
          会话：{phase} · 流量：
          {snapshot.unconfirmed
            ? '未确认'
            : state?.traffic === 'forwarding'
              ? '本次转发已确认'
              : state?.traffic === 'inactive'
                ? '未转发'
                : '未确认'}
        </p>
        {state?.owned && <p>保留本次会话所有权及恢复能力；退出Relay前需要停用并验证恢复。</p>}
        {!ordinaryRecovery &&
          !closingTun &&
          !snapshot.unconfirmed &&
          state?.restorationVerified && <p>本次核心、设备及网络恢复已确认。</p>}
        {(state?.sessionId || plan) && (
          <details>
            <summary>会话核对信息</summary>
            {state?.sessionId && <p>会话编号：{state.sessionId}</p>}
            {plan && (
              <>
                <p>完整配置摘要：{plan.configurationSHA256}</p>
                <p>本次准备摘要：{plan.evidenceSHA256}</p>
              </>
            )}
          </details>
        )}
        {helper === 'missing' && (
          <p role="alert">
            辅助组件尚未安装。请先核对本批安装候选与授权说明，再按说明手动安装；此处不会自动安装或修改核心权限。
          </p>
        )}
        {helper === 'requiresApproval' && (
          <p role="alert">辅助组件需要本次安装或身份更新授权，请先按候选说明完成手工操作。</p>
        )}
        {(helper === 'unavailable' || helper === 'unconfirmed') && (
          <p>辅助组件运行或身份尚未确认；重新读取状态后再准备。</p>
        )}
        <p>
          配置检查：
          {completeEvidenceId
            ? '已通过完整检查'
            : canPrepareConfiguration
              ? '开启时自动检查当前配置'
              : '尚未选择配置'}
        </p>
        <p>
          {completeEvidenceId
            ? '已关联最新完整配置检查凭据。'
            : canPrepareConfiguration
              ? '点击开关后检查当前配置；缺少外部资源时可在高级配置中绑定。'
              : '请先在完整运行配置面板生成候选并通过检查。'}
        </p>
        {plan && (
          <div>
            <p>
              本次设备：{plan.effects.device} · 自动路由：
              {plan.effects.autoRoute ? '申请启用' : '不申请'} · DNS劫持：
              {plan.effects.dnsHijack ? '申请启用' : '不申请'}
            </p>
            <p>
              配置摘要：{plan.configurationSHA256.slice(0, 16)} ·{' '}
              {now > plan.expiresAt
                ? '准备已过期，请重新生成并检查完整候选后再准备TUN。'
                : '尚未启用；准备沿用完整配置检查的有效期，执行前仍核对有效期。'}
            </p>
            {plan.issues.length > 0 && (
              <ul>
                {plan.issues.map((issue) => (
                  <li key={issue}>{issues[issue]}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="relay-action">
          <button disabled={busy || snapshot.pending} onClick={() => onAction('status')}>
            读取TUN与辅助组件状态
          </button>
          <button disabled={!plan && snapshot.action !== 'prepare'} onClick={onCancel}>
            取消本次TUN准备
          </button>
          <button
            disabled={locked || !state?.owned || !state.sessionId}
            onClick={() => onAction('stop')}
          >
            停用并恢复本次TUN
          </button>
          <button disabled={locked || !state?.owned} onClick={() => onAction('inspect')}>
            重新复核本次TUN
          </button>
        </div>
        {snapshot.unconfirmed && (
          <p role="alert">会话状态未确认，请保留窗口并重新读取；其他配置操作暂缓。</p>
        )}
        {!ordinaryRecovery && snapshot.notice && <p role="status">{snapshot.notice}</p>}
        {[...(snapshot.status?.warnings ?? []), ...(state?.warnings ?? [])].map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </details>
    </section>
  )
}

export function RelayTunPanel({
  completeEvidenceId,
  busy,
  activationBlocked = false,
  onBusy,
  onState,
  onUnconfirmed,
  active = true,
  profileConfig,
  onConfigurationChange
}: {
  completeEvidenceId?: string
  active?: boolean
  profileConfig?: IProfileConfig
  onConfigurationChange?(): void
  busy: boolean
  activationBlocked?: boolean
  onBusy(value: boolean): void
  onState(state: TunSessionState | undefined): void
  onUnconfirmed(value: boolean): void
}): React.JSX.Element {
  // The workspace inventory may predate import. Resolve the same fresh
  // selection as the shortcut and give both the editor and switch that ID.
  const [source, setSource] = useState<{ config?: IProfileConfig; id: string }>()
  const [refreshSource, setRefreshSource] = useState(0)
  useEffect(() => {
    if (!active) {
      setSource(undefined)
      return
    }
    let current = true
    void readTunProfileId((channel, ...args) =>
      channel === 'relayProfileList'
        ? relayProfileRead('relayProfileList')
        : window.electron.ipcRenderer.invoke(channel, ...args)
    ).then(
      (id) => {
        if (current) setSource({ config: profileConfig, id })
      },
      () => {
        if (current) setSource(undefined)
      }
    )
    return () => {
      current = false
    }
  }, [active, profileConfig, refreshSource])
  // Persisting the selected fallback during the first enable publishes its
  // own notification. Only the same identity may remain usable during reread.
  const preferredProfileId =
    active && source && (source.config === profileConfig || source.id === profileConfig?.current)
      ? source.id
      : undefined
  const mounted = useRef(true),
    latest = useRef({
      completeEvidenceId,
      busy,
      activationBlocked,
      onBusy,
      preferredProfileId,
      active
    }),
    controller = useRef<ReturnType<typeof createTunPanelController> | null>(null)
  latest.current = {
    completeEvidenceId,
    busy,
    activationBlocked,
    onBusy,
    preferredProfileId,
    active
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  if (!controller.current)
    controller.current = createTunPanelController({
      api: createTunRendererApi(),
      evidence: () => latest.current.completeEvidenceId,
      busy: () => latest.current.busy,
      activationBlocked: () =>
        latest.current.activationBlocked || !latest.current.active || !mounted.current,
      context: () => latest.current.preferredProfileId,
      prepareEvidence: async (isCurrent) => {
        const profileId = latest.current.preferredProfileId
        if (!profileId) throw new Error('请选择当前配置。')
        return prepareCurrentTunConfiguration(profileId, {
          invoke: (channel, ...args) => window.electron.ipcRenderer.invoke(channel, ...args),
          current: () =>
            isCurrent() && mounted.current && latest.current.preferredProfileId === profileId
        })
      },
      onBusy: (value) => latest.current.onBusy(value)
    })
  const control = controller.current,
    snapshot = useSyncExternalStore(control.subscribe, control.snapshot, control.snapshot),
    [now, setNow] = useState(Date.now),
    [settingsDirty, setSettingsDirty] = useState(false)
  const inspected = useRef(false)
  useEffect(() => {
    if (!active) {
      inspected.current = false
      return
    }
    if (!busy && !inspected.current) {
      inspected.current = true
      void control.run('status')
    }
  }, [active, busy, control])
  useEffect(() => control.updateEvidence(), [control, completeEvidenceId])
  useEffect(
    () => window.electron.ipcRenderer.on('relayTunUpdated', () => control.hostChanged()),
    [control]
  )
  useEffect(() => onState(snapshot.status?.session), [onState, snapshot.status?.session])
  useEffect(() => onUnconfirmed(snapshot.unconfirmed), [onUnconfirmed, snapshot.unconfirmed])
  useEffect(() => {
    setNow(Date.now())
    if (!snapshot.preparation) return
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, snapshot.preparation.expiresAt - Date.now()) + 1
    )
    return () => clearTimeout(timer)
  }, [snapshot.preparation])
  return (
    <RelayTunControls
      snapshot={snapshot}
      bindShortcut={active}
      canPrepareConfiguration={!!preferredProfileId}
      settingsDirty={settingsDirty}
      settings={
        <RelayTunSettingsEditor
          active={active && !snapshot.pending && !!snapshot.status}
          busy={busy}
          owned={!!snapshot.status?.session.owned}
          onBusy={onBusy}
          preferredProfileId={preferredProfileId}
          onDirty={setSettingsDirty}
          onChanged={() => {
            void control.cancel()
            onConfigurationChange?.()
          }}
        />
      }
      completeEvidenceId={completeEvidenceId}
      busy={busy}
      activationBlocked={activationBlocked}
      now={now}
      onAction={(action) => {
        if (action === 'status') setRefreshSource((revision) => revision + 1)
        void control.run(action)
      }}
      onCancel={() => void control.cancel()}
      onEnable={() => void control.enable()}
    />
  )
}
