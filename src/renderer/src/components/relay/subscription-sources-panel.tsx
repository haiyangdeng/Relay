import { useEffect, useRef, useState } from 'react'
import {
  sourceRequestTimeoutSeconds,
  type SubscriptionSourceInventory,
  type SubscriptionSourcePlan,
  type SubscriptionSourceResult,
  type SubscriptionSourceState,
  type SourceSchedulerState,
  type SourceOptions
} from '../../../../shared/relay/subscription-sources'
import { RelayLibraryControls } from './library-controls'

export function RelaySubscriptionSourcesPanel({
  busy,
  onBusy,
  onSaved
}: {
  busy: boolean
  onBusy(value: boolean): void
  onSaved(): Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState('Subscription'),
    [url, setURL] = useState(''),
    [port, setPort] = useState(7890),
    [advanced, setAdvanced] = useState(false),
    [headers, setHeaders] = useState('{}'),
    [ageKey, setAgeKey] = useState(''),
    [redirects, setRedirects] = useState<SourceOptions['redirects']>('none'),
    [scheduleKind, setScheduleKind] = useState('manual'),
    [scheduleValue, setScheduleValue] = useState('60'),
    [useServerInterval, setUseServerInterval] = useState(false),
    [requestTimeout, setRequestTimeout] = useState(String(sourceRequestTimeoutSeconds)),
    [requestUserAgent, setRequestUserAgent] = useState(''),
    [scheduler, setScheduler] = useState<SourceSchedulerState>(),
    [inventory, setInventory] = useState<SubscriptionSourceInventory>(),
    [selected, setSelected] = useState(''),
    [version, setVersion] = useState(''),
    [plan, setPlan] = useState<SubscriptionSourcePlan>(),
    [state, setState] = useState<SubscriptionSourceState>(),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    operation = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true),
    ownedEvidence = useRef<string | undefined>(undefined)
  const discard = async (evidenceId: string): Promise<void> => {
    if (ownedEvidence.current === evidenceId) ownedEvidence.current = undefined
    try {
      await window.electron.ipcRenderer.invoke('relaySourceCancel', { evidenceId })
    } catch {
      /* Never retry a cancellation or resubmit a write. */
    }
  }
  useEffect(() => {
    mounted.current = true
    const lifecycle = epoch
    return () => {
      mounted.current = false
      ++lifecycle.current
      if (ownedEvidence.current) void discard(ownedEvidence.current)
    }
  }, [])
  const watching = !!(
    pending ||
    plan ||
    state?.pending ||
    scheduler?.pending ||
    scheduler?.entries.some((entry) => entry.enabled)
  )
  useEffect(() => {
    let active = true
    const read = async (): Promise<void> => {
      const at = epoch.current
      try {
        const [next, scheduled] = await Promise.all([
          window.electron.ipcRenderer.invoke(
            'relaySourceState'
          ) as Promise<SubscriptionSourceState>,
          window.electron.ipcRenderer.invoke(
            'relaySourceScheduleState'
          ) as Promise<SourceSchedulerState>
        ])
        if (!active || at !== epoch.current) return
        setState(next)
        setScheduler(scheduled)
        if (!operation.current)
          setPlan((previous) => (previous?.evidenceId === next.preparedId ? previous : undefined))
      } catch {
        /* Read-only status failure never retries a write. */
      }
    }
    void read()
    const timer = watching ? setInterval(() => void read(), 1000) : undefined
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [watching])
  const action = async (
    kind: 'list' | 'register' | 'update' | 'restore' | 'arm' | 'disarm'
  ): Promise<void> => {
    if (!mounted.current || operation.current || (busy && kind !== 'disarm')) return
    const source = inventory?.sources.find((s) => s.id === selected)
    if (['update', 'restore', 'arm', 'disarm'].includes(kind) && !source) return
    operation.current = true
    const ticket = ++epoch.current
    const isCurrent = (): boolean => mounted.current && ticket === epoch.current
    setPending(true)
    onBusy(true)
    setPlan(undefined)
    setNotice('正在处理本次来源操作…')
    const executePrepared = async (prepared: SubscriptionSourcePlan): Promise<void> => {
      ownedEvidence.current = prepared.evidenceId
      if (!isCurrent()) return
      setPlan(prepared)
      let result = (await window.electron.ipcRenderer.invoke('relaySourceExecute', {
        evidenceId: prepared.evidenceId
      })) as SubscriptionSourceResult
      if (result.status === 'staged' && result.plan) ownedEvidence.current = result.plan.evidenceId
      if (!isCurrent()) return
      if (result.status === 'staged' && result.plan) {
        setPlan(result.plan)
        result = (await window.electron.ipcRenderer.invoke('relaySourceExecute', {
          evidenceId: result.plan.evidenceId
        })) as SubscriptionSourceResult
        if (!isCurrent()) return
      }
      setPlan(undefined)
      setNotice(
        result.warnings.join(' ') ||
          (result.status === 'saved'
            ? '来源操作已保存。'
            : result.status === 'unchanged'
              ? '来源没有变化。'
              : '来源操作未完成，请刷新核对。')
      )
      if (
        result.status === 'saved' ||
        result.status === 'uncertain' ||
        (result.status === 'unchanged' && result.source)
      ) {
        const next = (await window.electron.ipcRenderer.invoke(
          'relaySourceList'
        )) as SubscriptionSourceInventory
        if (!isCurrent()) return
        setInventory(next)
        setVersion('')
        await onSaved()
      }
    }
    try {
      if (kind === 'list') {
        const next = (await window.electron.ipcRenderer.invoke(
          'relaySourceList'
        )) as SubscriptionSourceInventory
        if (!isCurrent()) return
        setInventory(next)
        setNotice('已读取私有来源及版本记录，没有请求订阅。')
      } else if (kind === 'register') {
        await executePrepared(
          (await window.electron.ipcRenderer.invoke('relaySourceRegisterPrepare', {
            name,
            url,
            proxyPort: port,
            ...(advanced
              ? {
                  options: {
                    headers: JSON.parse(headers),
                    ageSecretKey: ageKey,
                    redirects,
                    schedule:
                      scheduleKind === 'manual'
                        ? { kind: 'manual' }
                        : scheduleKind === 'interval'
                          ? { kind: 'interval', minutes: Number(scheduleValue) }
                          : { kind: 'cron', expression: scheduleValue },
                    useServerInterval
                  }
                }
              : {})
          })) as SubscriptionSourcePlan
        )
        if (isCurrent()) {
          setURL('')
          setHeaders('{}')
          setAgeKey('')
        }
      } else if (kind === 'arm' || kind === 'disarm') {
        if (!source) throw new Error()
        const result = await window.electron.ipcRenderer.invoke(
          kind === 'arm' ? 'relaySourceScheduleArm' : 'relaySourceScheduleDisarm',
          kind === 'arm' ? { id: source.id, revision: source.revision } : { id: source.id }
        )
        if (!isCurrent()) return
        setScheduler(
          kind === 'arm'
            ? (result as { state: SourceSchedulerState }).state
            : (result as SourceSchedulerState)
        )
        setNotice(
          kind === 'arm'
            ? '已处理本次调度操作，请核对状态；不会立即请求订阅。'
            : '已停用本来源调度；在途操作完成／取消结果后才返回。'
        )
      } else if (kind === 'update' || kind === 'restore') {
        if (!source) throw new Error()
        const selection = { id: source.id, revision: source.revision }
        const timeoutSeconds =
          requestTimeout === '' ? sourceRequestTimeoutSeconds : Number(requestTimeout)
        const requestTuning =
          timeoutSeconds !== sourceRequestTimeoutSeconds || requestUserAgent !== ''
            ? {
                timeoutSeconds,
                ...(requestUserAgent !== '' ? { userAgent: requestUserAgent } : {})
              }
            : undefined
        await executePrepared(
          (await window.electron.ipcRenderer.invoke(
            kind === 'update' ? 'relaySourceUpdatePrepare' : 'relaySourceRestorePrepare',
            kind === 'update'
              ? requestTuning
                ? { ...selection, requestTuning }
                : selection
              : { source: selection, versionId: version }
          )) as SubscriptionSourcePlan
        )
      }
    } catch {
      if (isCurrent())
        setNotice('来源操作未确认或凭据已过期；请重新读取核对。没有自动重试、直连或启用配置。')
    } finally {
      if (!isCurrent() && ownedEvidence.current) await discard(ownedEvidence.current)
      if (mounted.current) {
        try {
          const next = (await window.electron.ipcRenderer.invoke(
            'relaySourceState'
          )) as SubscriptionSourceState
          if (mounted.current) setState(next)
        } catch {
          /* Keep pending status visible. */
        }
      }
      ownedEvidence.current = undefined
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  const cancel = async (): Promise<void> => {
    ++epoch.current
    const id = ownedEvidence.current ?? state?.operationId ?? state?.preparedId ?? plan?.evidenceId
    setPlan(undefined)
    setNotice('已取消后续步骤，等待本次来源操作收尾。已开始的写入会保留实际结果。')
    if (id) await discard(id)
  }
  const locked = !!(busy || pending || state?.pending || scheduler?.pending),
    source = inventory?.sources.find((s) => s.id === selected)
  const changed = (): void => {
    ++epoch.current
    setPlan(undefined)
  }
  return (
    <section className="relay-panel">
      <RelayLibraryControls
        kind="source"
        busy={locked}
        onBusy={onBusy}
        onChanged={async () => {
          const ticket = ++epoch.current
          setPlan(undefined)
          setSelected('')
          setVersion('')
          const next = (await window.electron.ipcRenderer.invoke(
            'relaySourceList'
          )) as SubscriptionSourceInventory
          if (mounted.current && ticket === epoch.current) setInventory(next)
        }}
      />

      <h2>订阅来源与版本</h2>
      {scheduler?.suspended && (
        <p role="status">调度已因睡眠或唤醒复核暂停；不会补发睡眠期间的请求。</p>
      )}
      <p>
        URL及其中令牌将以当前用户私有文件保存，未加密。手动更新先下载检查，检查通过后保存新版本；默认不自动更新、不覆盖旧文件、不启用或热载配置。
      </p>
      <label>
        来源名称
        <input
          value={name}
          disabled={locked}
          onChange={(e) => {
            setName(e.target.value)
            changed()
          }}
        />
      </label>
      <label>
        订阅URL（敏感地址）
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={url}
          disabled={locked}
          onChange={(e) => {
            setURL(e.target.value)
            changed()
          }}
        />
      </label>
      <label>
        固定HTTP代理端口
        <input
          type="number"
          min={1024}
          max={65535}
          value={Number.isFinite(port) ? port : ''}
          disabled={locked}
          onChange={(e) => {
            setPort(Number(e.target.value))
            changed()
          }}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={advanced}
          disabled={locked}
          onChange={(e) => {
            setAdvanced(e.target.checked)
            changed()
          }}
        />
        高级订阅选项
      </label>
      {advanced && (
        <div>
          <label>
            私有请求头JSON
            <textarea
              value={headers}
              disabled={locked}
              spellCheck={false}
              onChange={(e) => {
                setHeaders(e.target.value)
                changed()
              }}
            />
          </label>
          <label>
            AGE私钥（可选，私有保存）
            <input
              type="password"
              autoComplete="off"
              value={ageKey}
              disabled={locked}
              onChange={(e) => {
                setAgeKey(e.target.value)
                changed()
              }}
            />
          </label>
          <label>
            重定向
            <select
              value={redirects}
              disabled={locked}
              onChange={(e) => {
                setRedirects(e.target.value as SourceOptions['redirects'])
                changed()
              }}
            >
              <option value="none">拒绝</option>
              <option value="same-origin">仅同源</option>
              <option value="https">允许跨站HTTPS，丢弃私有请求头</option>
            </select>
          </label>
          <label>
            调度策略
            <select
              value={scheduleKind}
              disabled={locked}
              onChange={(e) => {
                setScheduleKind(e.target.value)
                setScheduleValue(e.target.value === 'cron' ? '0 * * * *' : '60')
                changed()
              }}
            >
              <option value="manual">手动</option>
              <option value="interval">分钟间隔（最小1）</option>
              <option value="cron">5段cron（本机时区）</option>
            </select>
          </label>
          {scheduleKind !== 'manual' && (
            <label>
              间隔／cron
              <input
                value={scheduleValue}
                disabled={locked}
                onChange={(e) => {
                  setScheduleValue(e.target.value)
                  changed()
                }}
              />
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={useServerInterval}
              disabled={locked}
              onChange={(e) => {
                setUseServerInterval(e.target.checked)
                changed()
              }}
            />
            明确允许服务端更新间隔覆盖固定策略
          </label>
          <p>
            这些设置与敏感地址一起私有保存，未加密；保存策略不会启用调度。AGE下载会解密为私有配置副本，跨站HTTPS重定向不携带自定义请求头。
          </p>
        </div>
      )}
      <div className="relay-action">
        <button
          disabled={locked || !name.trim() || !url.trim()}
          onClick={() => void action('register')}
        >
          保存订阅来源
        </button>
        <button disabled={locked} onClick={() => void action('list')}>
          读取来源与版本
        </button>
      </div>
      <label>
        已保存来源
        <select
          value={selected}
          disabled={locked}
          onChange={(e) => {
            setSelected(e.target.value)
            setVersion('')
            changed()
          }}
        >
          <option value="">请选择</option>
          {inventory?.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.origin} · {s.versions.length}版本{s.locked ? ' · 写锁待核对' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        历史版本
        <select
          value={version}
          disabled={locked || !source}
          onChange={(e) => {
            setVersion(e.target.value)
            changed()
          }}
        >
          <option value="">请选择</option>
          {source?.versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.createdAt} · {v.action} · {v.profile.sha256.slice(0, 12)}
            </option>
          ))}
        </select>
      </label>
      <details>
        <summary>后续手动更新的请求选项</summary>
        <label>
          总超时（秒）
          <input
            type="number"
            min={1}
            max={sourceRequestTimeoutSeconds}
            step={1}
            value={requestTimeout}
            disabled={locked}
            onChange={(e) => setRequestTimeout(e.target.value)}
          />
        </label>
        <label>
          默认 User-Agent
          <input
            value={requestUserAgent}
            placeholder="clash.meta/Relay"
            maxLength={256}
            autoComplete="off"
            disabled={locked}
            onChange={(e) => setRequestUserAgent(e.target.value)}
          />
        </label>
        <p>
          已保存来源的 User-Agent
          优先。只在本窗口后续手动更新时采用，已准备的请求和调度沿用各自选项。
        </p>
      </details>
      <div className="relay-action">
        <button disabled={locked || !source || source.locked} onClick={() => void action('update')}>
          手动更新
        </button>
        <button
          disabled={locked || !source || source.locked || !version}
          onClick={() => void action('restore')}
        >
          使用历史版本
        </button>
        <button
          disabled={
            state?.phase === 'saving' ||
            !(pending || state?.operationId || state?.preparedId || plan)
          }
          onClick={() => void cancel()}
        >
          取消本次来源操作
        </button>
      </div>
      <div className="relay-action">
        <button disabled={locked || !source || source.locked} onClick={() => void action('arm')}>
          启用本次运行调度…
        </button>
        <button
          disabled={
            !source || !scheduler?.entries.some((entry) => entry.id === source.id && entry.enabled)
          }
          onClick={() => void action('disarm')}
        >
          停用此来源调度
        </button>
      </div>
      {scheduler?.entries.map((entry) => (
        <p key={entry.id}>
          {entry.name} · {entry.enabled ? '调度已启用' : '调度已停用'} ·{' '}
          {entry.nextAt ?? '无下次执行'} · {entry.lastStatus ?? '尚未执行'}
        </p>
      ))}
      {source?.observation && (
        <p>
          上次检查{source.observation.checkedAt} · HTTP {source.observation.status} · 配额
          {JSON.stringify(source.observation.quota ?? {})} · 服务端间隔
          {source.observation.intervalMinutes ?? '未提供'}分钟
        </p>
      )}
      {plan && (
        <p>
          正在处理：{plan.kind} · {plan.name} · {plan.origin} · 代理127.0.0.1:{plan.proxyPort}
          {plan.requestTuning ? ` · 总超时${plan.requestTuning.timeoutSeconds}秒` : ''}
          {plan.sha256 ? ` · SHA256：${plan.sha256}` : ''}
        </p>
      )}
      <p>
        调度需点击启用且仅本次App运行有效；重启后不自动恢复，不立即请求。历史选择只影响来源的版本记录，不改变正在使用的配置；下载失败不回退直连。来源最多200条，每来源100个版本，异常写锁保留并阻止写入，不按PID自动接管。核心兼容性未验证。
      </p>
      {notice && <p role="status">{notice}</p>}
      {inventory?.warnings.map((w) => (
        <p key={w}>{w}</p>
      ))}
    </section>
  )
}
