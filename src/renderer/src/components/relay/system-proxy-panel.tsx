import { useEffect, useRef, useState } from 'react'
import { Button, Chip, Switch, Tab, Tabs } from '@heroui/react'
import { IoRefresh, IoTrashOutline } from 'react-icons/io5'
import SettingCard from '@renderer/components/base/base-setting-card'
import {
  defaultPacScript,
  defaultSystemBypass,
  type SystemProxyReport,
  type SystemProxyState,
  type SystemProxySettings
} from '../../../../shared/relay/system-proxy'
import {
  systemProxyDraft,
  systemProxyDraftRecord,
  type SystemProxyDraftRecord
} from '../../../../shared/relay/system-proxy-draft'
import { errorMessage } from '../../utils/error-message'
import {
  submitSystemProxy,
  canPrepareSystemProxy,
  canSwitchSystemProxy,
  systemProxyListenerPort,
  systemProxyPortFromCore,
  selectedSystemProxyServices,
  rememberSystemProxyServices,
  readSystemProxyServices
} from './system-proxy-actions'
import './network-settings.css'

const labels: Record<SystemProxyReport['status'], string> = {
  inactive: 'Relay 未接管',
  active: 'Relay 已接管',
  applied: 'Relay 已接管',
  pending: '操作进行中',
  conflict: '配置冲突待处理',
  restored: '已恢复原代理',
  rolledBack: '已回退',
  uncertain: '状态待核对'
}
export function RelaySystemProxyPanel({
  busy,
  onBusy,
  active = true,
  defaultSettings
}: {
  busy: boolean
  onBusy(value: boolean): void
  active?: boolean
  defaultSettings?: Partial<SystemProxySettings>
}): React.JSX.Element {
  const [settings, setSettings] = useState<SystemProxySettings>(() => ({
    mode: 'manual',
    host: '127.0.0.1',
    port: 18191,
    socks: false,
    bypass: [...defaultSystemBypass],
    excludeSimple: true,
    serviceIDs: readSystemProxyServices() ?? [],
    pacScript: defaultPacScript,
    ...defaultSettings
  }))
  const [report, setReport] = useState<SystemProxyReport>()
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [remotePending, setRemotePending] = useState(false)
  const [reading, setReading] = useState(false)
  const [queuedEnable, setQueuedEnable] = useState<number>()
  const [readFailed, setReadFailed] = useState(false)
  const [draftRecord, setDraftRecord] = useState<SystemProxyDraftRecord>()
  const [draftDirty, setDraftDirty] = useState(false)
  const [draftNotice, setDraftNotice] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const draftEpoch = useRef(0)
  const reportEpoch = useRef(0)
  const operation = useRef(false),
    attempted = useRef(false),
    mounted = useRef(true),
    portEdited = useRef(false)
  const update = (next: Partial<SystemProxySettings>): void => {
    if (next.serviceIDs !== undefined) rememberSystemProxyServices(next.serviceIDs)
    if (next.port !== undefined) portEdited.current = true
    if (Object.keys(next).some((key) => key !== 'port' && key !== 'serviceIDs')) setDraftDirty(true)
    setSettings((previous) => ({ ...previous, ...next }))
  }
  const corePort = defaultSettings?.port
  useEffect(() => {
    setSettings((previous) => {
      const port = systemProxyPortFromCore(previous.port, portEdited.current, corePort)
      return port === previous.port ? previous : { ...previous, port }
    })
  }, [corePort])
  useEffect(() => {
    mounted.current = true
    const generation = draftEpoch
    let awaitingVisibility = false
    const invalidate = (): void => {
      ++generation.current
      awaitingVisibility = true
      setDraftRecord(undefined)
      // This event also revokes a closing/hidden frame's authority; do not
      // start another read until visible, restored or explicitly refreshed.
      attempted.current = true
      setDraftNotice('默认设置需重新读取，请点击右上角刷新；未保存草稿保留。')
    }
    const invalidated = window.electron.ipcRenderer.on(
      'relayBackupPreparationsInvalidated',
      invalidate
    )
    const restored = window.electron.ipcRenderer.on('relayDataRestored', () => {
      invalidate()
      attempted.current = false
      setRefreshVersion((value) => value + 1)
    })
    const visible = window.electron.ipcRenderer.on('relayWorkspaceVisible', () => {
      if (!awaitingVisibility) return
      awaitingVisibility = false
      // The existing effect waits for active/idle and reads only. Dirty drafts
      // still require explicit discard before accepting another saved revision.
      attempted.current = false
      setRefreshVersion((value) => value + 1)
    })
    return () => {
      mounted.current = false
      ++generation.current
      invalidated()
      restored()
      visible()
    }
  }, [])
  const run = async (
    action: 'inspect' | 'enable' | 'apply' | 'restore',
    discardDraft = false
  ): Promise<void> => {
    if (operation.current || busy) return
    operation.current = true
    ++reportEpoch.current
    setPending(true)
    setReading(action === 'inspect')
    onBusy(true)
    setNotice(action === 'inspect' ? '' : '正在应用本次系统代理操作…')
    const epoch = draftEpoch.current
    const current = (): boolean => mounted.current && epoch === draftEpoch.current
    const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
      if (!current()) throw new Error('本次页面操作已失效。')
      const result = await window.electron.ipcRenderer.invoke(channel, ...args)
      if (!current()) throw new Error('本次页面操作已失效。')
      return result
    }
    let prepared = false
    try {
      if (action === 'inspect' && (!draftDirty || discardDraft)) {
        const epoch = draftEpoch.current
        try {
          const saved = systemProxyDraftRecord(
            await window.electron.ipcRenderer.invoke('relaySystemProxyDraftRead')
          )
          if (!mounted.current || epoch !== draftEpoch.current) return
          setDraftRecord(saved)
          // Ports and network-service choices belong to this Relay session.
          setSettings((previous) => ({ ...previous, ...saved.document }))
          setDraftDirty(false)
          setDraftNotice('')
        } catch {
          if (!mounted.current || epoch !== draftEpoch.current) return
          setDraftRecord(undefined)
          setDraftNotice('默认设置读取未完成，请刷新重试。')
        }
      }
      if (action !== 'inspect') {
        const corePort =
          action !== 'restore'
            ? await systemProxyListenerPort(
                invoke,
                current,
                settings,
                portEdited.current ? settings.port : undefined
              )
            : undefined
        const result = await submitSystemProxy(
          action,
          {
            ...settings,
            port: systemProxyPortFromCore(settings.port, portEdited.current, corePort),
            serviceIDs:
              action !== 'restore' && report
                ? selectedSystemProxyServices(
                    report,
                    readSystemProxyServices() ?? defaultSettings?.serviceIDs
                  )
                : settings.serviceIDs,
            bypass: settings.bypass.map((value) => value.trim()).filter(Boolean)
          },
          invoke,
          (plan) => {
            prepared = true
            if (mounted.current) setReport(plan.report)
          }
        )
        if (mounted.current)
          setNotice(
            {
              cancelled: '已取消，系统代理未更改。',
              applied: '已应用系统代理。',
              restored: '已恢复原代理。',
              rolledBack: '本次更改已回退。',
              failed: '应用未完成，请核对状态。',
              uncertain: '结果待核对，请保留窗口。'
            }[result.status] + (result.warnings.length ? ` ${result.warnings.join(' ')}` : '')
          )
        // The native transaction already performs locked write/readback. Use
        // that completed receipt rather than spawning another full inspection.
        if (result.report && ['applied', 'restored'].includes(result.status)) {
          if (current()) {
            setReport(result.report)
            setReadFailed(false)
          }
          return
        }
      }
      if (mounted.current) setReading(true)
      const value = (await invoke('relaySystemProxyInspect')) as SystemProxyReport
      if (mounted.current) {
        setReport(value)
        setRemotePending(false)
        setReadFailed(false)
      }
    } catch (error) {
      if (current()) {
        // Listener startup can fail before any system-proxy mutation. Keep
        // the controls usable, e.g. after the first profile is imported.
        setReadFailed(action === 'inspect' || prepared)
        setNotice(errorMessage(error, '系统代理操作未完成。'))
      }
    } finally {
      operation.current = false
      if (mounted.current) {
        setPending(false)
        setReading(false)
      }
      onBusy(false)
    }
  }
  useEffect(() => {
    const changed = (): void => {
      attempted.current = false
      setRefreshVersion((value) => value + 1)
    }
    window.addEventListener('relay-sidebar-network-changed', changed)
    return () => window.removeEventListener('relay-sidebar-network-changed', changed)
  }, [])
  useEffect(() => {
    if (!active) return
    const generation = reportEpoch
    const unsubscribe = window.electron.ipcRenderer.on('controledMihomoConfigUpdated', () => {
      if (operation.current) return
      const version = ++generation.current
      const epoch = draftEpoch.current
      void window.electron.ipcRenderer
        .invoke('relaySystemProxyState')
        .then((value) => {
          const state = value as SystemProxyState | undefined
          if (
            !state ||
            version !== generation.current ||
            epoch !== draftEpoch.current ||
            operation.current
          )
            return
          setRemotePending(state.pending)
          if (state.observed && !state.pending && state.report) {
            setReport(state.report)
            setReadFailed(false)
          }
        })
        .catch(() => {})
    })
    return () => {
      ++generation.current
      unsubscribe()
    }
  }, [active])
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    if (!active) {
      attempted.current = false
      return
    }
    if (!busy && !pending && !operation.current && !attempted.current) {
      attempted.current = true
      void runRef.current('inspect')
    }
  }, [active, busy, pending, refreshVersion])
  // A first click is valid while the initial read is discovering available
  // services. Consume the intent once the report and saved settings arrive.
  useEffect(() => {
    if (queuedEnable === undefined) return
    if (!active || queuedEnable !== draftEpoch.current) {
      setQueuedEnable(undefined)
      return
    }
    if (pending || busy || operation.current) return
    setQueuedEnable(undefined)
    if (readFailed || !report || !draftRecord) return
    if (report.recordID && (report.status === 'active' || report.status === 'applied')) return
    if (!canSwitchSystemProxy(report, readSystemProxyServices() ?? defaultSettings?.serviceIDs)) {
      setNotice('系统代理状态需要核对，请检查网络服务和恢复记录。')
      return
    }
    void runRef.current('enable')
  }, [
    queuedEnable,
    active,
    busy,
    pending,
    draftRecord,
    readFailed,
    report,
    defaultSettings?.serviceIDs
  ])
  const saveDraft = async (): Promise<void> => {
    if (operation.current || busy || !draftRecord || !draftDirty) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const epoch = draftEpoch.current
    let sent = false
    try {
      const document = systemProxyDraft({
        mode: settings.mode,
        host: settings.host,
        socks: settings.socks,
        bypass: settings.bypass.map((value) => value.trim()).filter(Boolean),
        excludeSimple: settings.excludeSimple,
        pacScript: settings.pacScript
      })
      sent = true
      const saved = systemProxyDraftRecord(
        await window.electron.ipcRenderer.invoke('relaySystemProxyDraftSave', {
          document,
          expectedRevision: draftRecord.revision
        })
      )
      if (!mounted.current || epoch !== draftEpoch.current) return
      setDraftRecord(saved)
      setSettings((previous) => ({ ...previous, ...saved.document }))
      setDraftDirty(false)
      setDraftNotice('默认设置已保存；系统代理未更改。')
    } catch (error) {
      if (!mounted.current || epoch !== draftEpoch.current) return
      if (sent) setDraftRecord(undefined)
      setDraftNotice(
        sent
          ? '保存结果未确认，草稿保留；请重新读取后核对。'
          : error instanceof Error
            ? error.message
            : '默认设置格式无效。'
      )
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  const locked = busy || pending || remotePending
  const initialRead = active && !report && !readFailed && !remotePending && reading
  const managed = report?.status === 'active' || report?.status === 'applied'
  const canApply =
    !locked &&
    !readFailed &&
    !!draftRecord &&
    canPrepareSystemProxy(report) &&
    !!report &&
    selectedSystemProxyServices(report, readSystemProxyServices() ?? defaultSettings?.serviceIDs)
      .length > 0
  return (
    <section className="relay-network-settings" data-relay-settings="system-proxy">
      <div className="relay-network-toolbar">
        <div>
          <h2>系统代理</h2>
          <p>使用系统代理的应用将通过下方地址连接。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="flat"
            isDisabled={locked || !draftRecord || !draftDirty}
            onPress={() => void saveDraft()}
          >
            保存设置
          </Button>
          <Button
            size="sm"
            color="primary"
            isDisabled={!canApply}
            onPress={() => void run('apply')}
          >
            应用设置
          </Button>
          <Chip size="sm" variant="flat">
            {queuedEnable !== undefined
              ? '正在开启'
              : reading
                ? '正在读取'
                : pending
                  ? '处理中'
                  : readFailed
                    ? '状态待核对'
                    : report
                      ? canApply && (report.status === 'pending' || report.status === 'conflict')
                        ? '可重新启用'
                        : labels[report.status]
                      : '状态未获取'}
          </Chip>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label="刷新系统代理"
            isDisabled={locked}
            onPress={() => void run('inspect')}
          >
            <IoRefresh />
          </Button>
        </div>
      </div>
      {draftNotice && (
        <p className="relay-network-notice" role="status">
          {draftNotice}
        </p>
      )}
      {draftDirty && !draftRecord && (
        <Button
          size="sm"
          variant="flat"
          isDisabled={locked}
          onPress={() => void run('inspect', true)}
        >
          放弃修改并重读设置
        </Button>
      )}
      <SettingCard>
        <div className="relay-setting-row">
          <span>系统代理</span>
          <Switch
            size="sm"
            aria-label="Relay 系统代理"
            isSelected={managed}
            isDisabled={
              queuedEnable !== undefined ||
              (!initialRead &&
                (locked ||
                  readFailed ||
                  !report ||
                  (!managed && !draftRecord) ||
                  !canSwitchSystemProxy(
                    report,
                    readSystemProxyServices() ?? defaultSettings?.serviceIDs
                  )))
            }
            onValueChange={(enabled) => {
              if (initialRead && enabled) setQueuedEnable(draftEpoch.current)
              else void run(enabled ? 'enable' : 'restore')
            }}
          />
        </div>
        <fieldset disabled={locked}>
          <div className="relay-setting-row">
            <span>代理主机</span>
            <input
              aria-label="代理主机"
              value={settings.host}
              onChange={(event) => update({ host: event.target.value })}
            />
          </div>
          <div className="relay-setting-row">
            <span>代理端口</span>
            <input
              aria-label="代理端口"
              type="number"
              min={1024}
              max={65535}
              value={settings.port}
              onChange={(event) => update({ port: Number(event.target.value) })}
            />
          </div>
          {systemProxyPortFromCore(settings.port, false, corePort) !== settings.port && (
            <Button
              size="sm"
              variant="light"
              isDisabled={locked}
              onPress={() => {
                portEdited.current = false
                setSettings((previous) => ({
                  ...previous,
                  port: systemProxyPortFromCore(previous.port, false, corePort)
                }))
              }}
            >
              使用当前核心端口（{corePort}）
            </Button>
          )}
          <div className="relay-setting-row">
            <span>代理模式</span>
            <Tabs
              size="sm"
              color="primary"
              aria-label="代理模式"
              selectedKey={settings.mode}
              isDisabled={locked}
              onSelectionChange={(key) => update({ mode: key === 'pac' ? 'pac' : 'manual' })}
            >
              <Tab key="manual" title="手动" />
              <Tab key="pac" title="PAC" />
            </Tabs>
          </div>
          {settings.mode === 'pac' && (
            <label className="relay-network-field">
              PAC 脚本
              <textarea
                aria-label="PAC 脚本"
                rows={5}
                value={settings.pacScript}
                onChange={(event) => update({ pacScript: event.target.value })}
              />
              <span className="relay-network-state">
                %proxy-host% 与 %mixed-port% 使用上方地址；默认不含直连回退。
              </span>
            </label>
          )}
          <div className="relay-setting-row">
            <span>网络服务</span>
            <span className="relay-network-state">选择本次要设置的服务</span>
          </div>
          <div className="relay-network-services">
            {report?.services.map((service) => (
              <label key={service.id}>
                <input
                  type="checkbox"
                  disabled={!service.enabled}
                  checked={selectedSystemProxyServices(
                    report,
                    readSystemProxyServices() ?? defaultSettings?.serviceIDs
                  ).includes(service.id)}
                  onChange={(event) =>
                    update({
                      serviceIDs: event.target.checked
                        ? [
                            ...selectedSystemProxyServices(
                              report,
                              readSystemProxyServices() ?? defaultSettings?.serviceIDs
                            ),
                            service.id
                          ]
                        : selectedSystemProxyServices(
                            report,
                            readSystemProxyServices() ?? defaultSettings?.serviceIDs
                          ).filter((id) => id !== service.id)
                    })
                  }
                />
                {service.name}
                {!service.enabled && '（已停用）'}
              </label>
            ))}
          </div>
          {!report && <p>读取完成后可选择网络服务。</p>}
        </fieldset>
      </SettingCard>
      <SettingCard>
        <div className="relay-network-toolbar">
          <h2>代理绕过</h2>
          <Button
            size="sm"
            variant="flat"
            isDisabled={locked}
            onPress={() =>
              update({
                bypass: [...new Set([...settings.bypass.filter(Boolean), ...defaultSystemBypass])]
              })
            }
          >
            添加默认绕过
          </Button>
        </div>
        <fieldset disabled={locked}>
          {settings.bypass.map((entry, index) => (
            <div className="relay-list-row" key={index}>
              <input
                aria-label={`绕过地址 ${index + 1}`}
                value={entry}
                onChange={(event) =>
                  update({
                    bypass: settings.bypass.map((value, at) =>
                      at === index ? event.target.value : value
                    )
                  })
                }
              />
              <Button
                isIconOnly
                size="sm"
                variant="flat"
                aria-label={`删除绕过地址 ${index + 1}`}
                isDisabled={locked}
                onPress={() => update({ bypass: settings.bypass.filter((_, at) => at !== index) })}
              >
                <IoTrashOutline />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="light"
            isDisabled={locked}
            onPress={() => update({ bypass: [...settings.bypass, ''] })}
          >
            添加绕过地址
          </Button>
        </fieldset>
      </SettingCard>
      <details>
        <summary>高级设置与恢复详情</summary>
        <SettingCard>
          <fieldset disabled={locked}>
            <div className="relay-setting-row">
              <span>同时启用 SOCKS</span>
              <input
                aria-label="同时启用 SOCKS"
                type="checkbox"
                checked={settings.socks}
                onChange={(event) => update({ socks: event.target.checked })}
              />
            </div>
            <p>仅在所填端口同时支持 SOCKS 时启用。</p>
            <div className="relay-setting-row">
              <span>简单主机名直连</span>
              <input
                aria-label="简单主机名直连"
                type="checkbox"
                checked={settings.excludeSimple}
                onChange={(event) => update({ excludeSimple: event.target.checked })}
              />
            </div>
            {report && (
              <>
                <p>网络位置：{report.location}</p>
                {report.recordID && <p>恢复记录：{report.recordID}</p>}
                {report.services.map((service) => (
                  <p key={service.id}>
                    {service.name} · HTTP {service.http ? '开' : '关'} / HTTPS{' '}
                    {service.https ? '开' : '关'} / SOCKS {service.socks ? '开' : '关'} / PAC{' '}
                    {service.pac ? '开' : '关'}
                  </p>
                ))}
              </>
            )}
            <p>恢复仅使用 Relay 持有的记录；系统代理不提供强制禁止直连。</p>
          </fieldset>
        </SettingCard>
      </details>
      <div className="relay-network-actions">
        <Button
          size="sm"
          variant="flat"
          isDisabled={locked || readFailed || !report?.canRestore}
          onPress={() => void run('restore')}
        >
          恢复原代理
        </Button>
      </div>
      {notice && (
        <p className="relay-network-notice" role="status">
          {notice}
        </p>
      )}
      {report?.warnings.map((line, index) => (
        <p key={index} className="relay-network-notice" role="status">
          {line}
        </p>
      ))}
    </section>
  )
}
