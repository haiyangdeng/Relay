import { useState } from 'react'
import { Button, Chip, Switch } from '@heroui/react'
import SettingCard from '@renderer/components/base/base-setting-card'
import './network-settings.css'
import { ownedHealthTestPolicy } from '../../../../shared/relay/health'
import {
  localCoreLogLevel,
  localCoreLogLevels,
  type LocalCoreLogLevel,
  type LocalProxyPreparation,
  type LocalProxyState,
  type LocalProxyGroup,
  type LocalResolverMode,
  type LocalProxyLifetime
} from '../../../../shared/relay/local-proxy'
import type { RelayStoredProfile } from '../../../../shared/relay/profiles'
import type { DedicatedListenerPlan } from '../../../../shared/relay/dedicated-listeners'
import type { LocalProxyPorts } from '../../../../shared/relay/local-proxy-ports'
import { RelayDedicatedListenersPanel } from './dedicated-listeners-panel'
import { RelayCoreSettingsEditor } from './core-settings-editor'
import { RelayLocalProxyPortsEditor } from './local-proxy-ports-editor'

function Group({
  group,
  busy,
  onSelect,
  onTest,
  onAutomatic
}: {
  group: LocalProxyGroup
  busy: boolean
  onSelect(member: string): void
  onTest?(member: string): void
  onAutomatic?(): void
}): React.JSX.Element {
  const smartAutomatic =
    group.confirmed && group.type === 'smart' && group.fixed === '' && group.now === undefined
  return (
    <div>
      <p>{ownedHealthTestPolicy.reason}</p>
      <label>
        {group.name} · {group.type ?? 'select'} ·{' '}
        {group.confirmed
          ? group.type === 'load-balance'
            ? '按连接分配，无单一当前节点'
            : `当前：${smartAutomatic ? '自动选择' : group.now}`
          : '当前选择未确认，请刷新'}
        <select
          disabled={busy || !group.confirmed || group.selectable === false}
          value={group.now ?? ''}
          onChange={(event) => onSelect(event.target.value)}
        >
          {!group.confirmed && <option value="">未确认</option>}
          {smartAutomatic && <option value="">自动选择</option>}
          {group.members.map((member, index) => (
            <option key={`${index}:${member}`} value={member}>
              {member}
            </option>
          ))}
        </select>
      </label>
      {group.fixed && <p>已固定：{group.fixed}</p>}
      {['url-test', 'fallback', 'smart'].includes(group.type ?? '') && (
        <button
          disabled={busy || !group.confirmed || !group.fixed || !onAutomatic}
          onClick={onAutomatic}
        >
          恢复自动选择
        </button>
      )}
      {group.confirmed &&
        group.health?.map((node) => (
          <p key={node.name}>
            {node.name} ·{' '}
            {node.at
              ? node.alive && node.delay
                ? `${node.delay} ms`
                : '失败／不可用'
              : '尚无测速记录'}
            {node.at ? ` · ${node.at}` : ''}
            {group.testURL && (
              <button
                disabled={busy || !onTest || !ownedHealthTestPolicy.available}
                title={ownedHealthTestPolicy.reason}
                onClick={() => onTest?.(node.name)}
              >
                测试此节点（暂不可用）
              </button>
            )}
          </p>
        ))}
      {group.confirmed &&
        group.members.length === 1 &&
        group.members[0] === group.emptyFallback && (
          <p className="relay-error">
            当前仅有空成员回退：{group.emptyFallback}；不代表代理可用或禁止直连。
          </p>
        )}
    </div>
  )
}
export function RelayLocalProxyPanel({
  profiles,
  state,
  preparation,
  ports,
  resolverMode,
  lifetime,
  onLifetime,
  logLevel,
  onLogLevel,
  busy,
  notice,
  onPorts,
  onResolverMode,
  onPrepare,
  onReload,
  onStart,
  onStop,
  onRefresh,
  onSelect,
  onTest,
  onAutomatic,
  dedicated,
  defaultRoute = '',
  planReady = true,
  planDirty = false,
  planNotice = '',
  onSavePlan,
  onDedicated,
  preferredProfileId,
  onUse,
  active = true,
  onBusy,
  onConfigurationChange
}: {
  profiles: RelayStoredProfile[]
  preferredProfileId?: string
  onUse?(profile: RelayStoredProfile): void | Promise<void>
  active?: boolean
  onBusy?(value: boolean): void
  onConfigurationChange?(): void
  state?: LocalProxyState
  preparation?: LocalProxyPreparation
  ports: LocalProxyPorts
  resolverMode: LocalResolverMode
  lifetime: LocalProxyLifetime
  onLifetime(lifetime: LocalProxyLifetime): void
  logLevel?: LocalCoreLogLevel
  onLogLevel?(level: LocalCoreLogLevel | undefined): void
  busy: boolean
  notice: string
  onPorts(ports: LocalProxyPorts): void
  onResolverMode(mode: LocalResolverMode): void
  onPrepare(profile: RelayStoredProfile): void
  onReload?(profile: RelayStoredProfile): void
  onStart(): void
  onStop(): void
  onRefresh(): void
  onSelect(group: string, member: string): void
  onTest?(group: string, member: string): void
  onAutomatic?(group: string): void
  dedicated?: DedicatedListenerPlan
  defaultRoute?: string
  planReady?: boolean
  planDirty?: boolean
  planNotice?: string
  onSavePlan?(): void
  onDedicated?(plan: DedicatedListenerPlan | undefined): void
}): React.JSX.Element {
  const blocking = state?.owned || state?.pending
  const planBlocked = !!state?.pending || !!state?.uncertain
  const [selectedId, setSelectedId] = useState('')
  const [using, setUsing] = useState(false)
  const [useNotice, setUseNotice] = useState('')
  const selected =
    profiles.find((profile) => profile.id === selectedId) ??
    profiles.find(
      (profile) =>
        profile.id === (preferredProfileId ?? state?.profileId ?? preparation?.profile.id)
    ) ??
    profiles[0]
  const locked = busy || using
  const activateSelected = async (): Promise<void> => {
    if (!selected || locked || !onUse) return
    setUsing(true)
    setUseNotice('')
    try {
      await onUse(selected)
    } catch {
      setUseNotice('配置启用未确认，请核对下方运行状态。')
    } finally {
      setUsing(false)
    }
  }
  return (
    <section className="relay-network-settings" data-relay-settings="core">
      <div className="relay-network-toolbar">
        <div>
          <h2>代理内核</h2>
          <p className="relay-current-endpoint" role="status">
            {state?.traffic === 'listening' &&
            state.phase === 'running' &&
            state.owned &&
            !state.pending &&
            !state.uncertain
              ? `运行中 · 127.0.0.1:${state.httpPort}`
              : state?.uncertain || state?.traffic === 'unconfirmed'
                ? '运行状态待核对'
                : state?.pending
                  ? '操作进行中'
                  : '尚未运行'}
          </p>
        </div>
        <Chip size="sm" variant="flat">
          Mihomo
        </Chip>
      </div>
      <p>节点、规则、DNS 和嗅探沿用配置；监听端口、TUN 和缓存由 Relay 管理。</p>
      <SettingCard>
        <div className="relay-setting-row">
          <span>内核版本</span>
          <div className="flex items-center gap-3">
            {preparation?.version && (
              <span className="relay-network-state">已检查 {preparation.version}</span>
            )}
            <a className="text-sm text-primary" href="#/relay?panel=variants">
              选择版本 / Smart 内核
            </a>
          </div>
        </div>
        <div className="relay-setting-row">
          <span>使用配置</span>
          <select
            aria-label="内核使用配置"
            value={selected?.id ?? ''}
            disabled={locked || !!state?.pending}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {!profiles.length && <option value="">请先导入配置</option>}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </div>
        <RelayLocalProxyPortsEditor
          ports={ports}
          livePorts={
            state?.owned && state.phase === 'running' && !state.pending && !state.uncertain
              ? (state.ports ?? { http: state.httpPort ?? 0, socks: 0, mixed: 0, redir: 0 })
              : undefined
          }
          disabled={locked || planBlocked || !planReady}
          onChange={onPorts}
        />
        <div className="relay-setting-row">
          <span>使用配置内 DNS / hosts</span>
          <Switch
            size="sm"
            aria-label="使用配置内 DNS 和 hosts"
            isSelected={resolverMode === 'profile'}
            isDisabled={locked || planBlocked || !planReady}
            onValueChange={(value) => onResolverMode(value ? 'profile' : 'off')}
          />
        </div>
        {onLogLevel && lifetime === 'main' && (
          <div className="relay-setting-row">
            <span>启动日志级别</span>
            <select
              aria-label="启动日志级别"
              value={logLevel ?? 'profile'}
              disabled={locked || !!blocking}
              onChange={(event) =>
                onLogLevel(
                  event.target.value === 'profile'
                    ? undefined
                    : localCoreLogLevel(event.target.value)
                )
              }
            >
              <option value="profile">沿用配置</option>
              {localCoreLogLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>
        )}
        <p>仅影响 Relay 的本地代理；系统代理在对应页面设置。</p>
      </SettingCard>
      <div className="relay-network-actions">
        {onUse ? (
          <Button
            size="sm"
            color="primary"
            isLoading={using}
            isDisabled={
              locked ||
              (!planReady && !state?.owned) ||
              !selected ||
              !!state?.pending ||
              !!state?.uncertain ||
              (!!state?.hasRecord && !state.owned)
            }
            onPress={() => void activateSelected()}
          >
            {state?.owned ? '使用所选配置' : '启动代理'}
          </Button>
        ) : (
          <Button
            size="sm"
            color="primary"
            isDisabled={locked || !!blocking || !selected}
            onPress={() => selected && onPrepare(selected)}
          >
            检查所选配置
          </Button>
        )}
        <Button
          size="sm"
          variant="flat"
          isDisabled={!state?.instanceId || (!state.owned && !state.pending)}
          onPress={onStop}
        >
          停止代理
        </Button>
        <Button
          size="sm"
          variant="light"
          isDisabled={locked || !!state?.pending || state?.phase !== 'running'}
          onPress={onRefresh}
        >
          刷新状态
        </Button>
        <a className="text-sm text-primary self-center" href="#/proxies">
          查看代理组
        </a>
        {!profiles.length && (
          <a className="text-sm text-primary self-center" href="#/relay?panel=profiles">
            导入配置
          </a>
        )}
      </div>
      {onSavePlan && (
        <div className="relay-network-actions">
          <Button
            size="sm"
            variant="flat"
            isDisabled={locked || planBlocked || !planReady}
            onPress={onSavePlan}
          >
            保存启动设置
          </Button>
          <span className="relay-network-state">
            {planNotice}
            {planDirty && ' 有未保存的修改；启动代理时一并保存。'}
            {state?.owned && ' 当前核心保持运行；保存的端口与专用监听在下次核心启动时生效。'}
          </span>
        </div>
      )}
      {notice && (
        <p className="relay-network-notice" role="status">
          {notice}
        </p>
      )}
      {useNotice && (
        <p className="relay-network-notice" role="status">
          {useNotice}
        </p>
      )}
      {state?.hasRecord && !state.owned && (
        <p className="relay-error" role="alert">
          已有其他实例或未结束的记录，不自动接管或按 PID 停止。
        </p>
      )}
      {state?.uncertain && (
        <p className="relay-error" role="alert">
          退出或清理未确认，请保留窗口并重试本次停止。
        </p>
      )}
      {state?.warnings.map((warning) => (
        <p className="relay-network-notice" role="status" key={warning}>
          {warning}
        </p>
      ))}
      <RelayCoreSettingsEditor
        profile={selected}
        active={active}
        busy={locked}
        owned={!!blocking}
        onBusy={onBusy}
        onChanged={onConfigurationChange}
      />
      {onDedicated && (
        <SettingCard>
          <RelayDedicatedListenersPanel
            plan={dedicated}
            defaultRoute={defaultRoute}
            profile={selected}
            disabled={locked || planBlocked || !planReady}
            onBusy={onBusy}
            onChange={onDedicated}
          />
          {(preparation?.dedicated || state?.dedicated) && (
            <p className="relay-network-state">
              本次固定节点：{(state?.dedicated ?? preparation?.dedicated)?.route}；HTTP{' '}
              {(state?.dedicated ?? preparation?.dedicated)?.httpPort ?? '关闭'}；SOCKS{' '}
              {(state?.dedicated ?? preparation?.dedicated)?.socksPort ?? '关闭'}。
            </p>
          )}
        </SettingCard>
      )}
      <details>
        <summary>高级内核设置</summary>
        <SettingCard>
          <div className="relay-setting-row">
            <span>退出界面后继续运行</span>
            <input
              aria-label="持久代理实例"
              type="checkbox"
              checked={lifetime === 'persistent'}
              disabled={locked || !!blocking}
              onChange={(event) => onLifetime(event.target.checked ? 'persistent' : 'main')}
            />
          </div>
          <p>持久实例需要已配对的权限组件；已有普通实例不会自动迁移。</p>
          {state?.logLevel && <p>本次普通核心日志级别 {state.logLevel}。</p>}
          {resolverMode === 'profile' && (
            <p>
              保留受支持的 nameserver、域名策略及节点专用解析。DNS
              查询会发往配置指定的服务器或代理组；不会改系统 DNS 或开放原 listen 地址。需要显式引导
              DNS 或可直接使用的 IP 解析地址；地理库／规则集、未知选项等会阻止准备。
            </p>
          )}
        </SettingCard>
      </details>
      <details>
        <summary>配置检查与手动控制</summary>
        <SettingCard>
          <p>
            代理监听仅限本机回环地址，系统代理和 TUN 在对应页面单独设置。 局域网访问、用户验证和外部
            WebUI 不在此本地监听方式中启用；Claude禁止直连未启用。
          </p>
          {selected && (
            <div className="relay-network-actions">
              <Button
                size="sm"
                isDisabled={locked || !!blocking}
                onPress={() => onPrepare(selected)}
              >
                检查配置
              </Button>
              {state?.phase === 'running' && state.lifetime !== 'persistent' && (
                <Button
                  size="sm"
                  isDisabled={locked || !onReload || state.pending}
                  onPress={() => onReload?.(selected)}
                >
                  重新加载配置…
                </Button>
              )}
            </div>
          )}
          {preparation && (
            <p>
              {preparation.profile.name} · 端口 {preparation.httpPort} ·{' '}
              {preparation.canStart ? '配置检查通过' : '记录或端口不可用'}
              {preparation.logLevel && ` · 日志级别 ${preparation.logLevel}`}
              {preparation.resolution?.enabled &&
                ` · DNS 策略 ${preparation.resolution.policies} 项，hosts ${preparation.resolution.hosts} 项；DNS 监听关闭`}
              {preparation.resolution?.bootstrapDerived &&
                ' · 引导 DNS 由配置中已有的 IP 解析地址派生'}
            </p>
          )}
          {!onUse && preparation && (
            <Button
              size="sm"
              isDisabled={locked || !!blocking || !preparation.canStart}
              onPress={onStart}
            >
              启动本地代理
            </Button>
          )}
          {state?.owned && state.resolution?.enabled && (
            <p>本次实例已编入配置内 DNS／hosts；解析成功、出口与泄漏状态需另行验证。</p>
          )}
        </SettingCard>
      </details>
      {!!state?.groups.length && (
        <details>
          <summary>代理组运行详情</summary>
          <SettingCard>
            {state.groups.map((group) => (
              <Group
                key={group.name}
                group={group}
                busy={locked || !!state.pending || state.phase !== 'running'}
                onSelect={(member) => onSelect(group.name, member)}
                onTest={onTest ? (member) => onTest(group.name, member) : undefined}
                onAutomatic={onAutomatic ? () => onAutomatic(group.name) : undefined}
              />
            ))}
          </SettingCard>
        </details>
      )}
    </section>
  )
}
