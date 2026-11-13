import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IoCopyOutline, IoEyeOffOutline, IoEyeOutline, IoRefreshOutline } from 'react-icons/io5'
import { errorMessage } from '../../utils/error-message'
import type { RelayProfileInventory } from '../../../../shared/relay/profiles'
import {
  probeIPProviders,
  type ProbeIPProvider,
  type IsolatedProbeRequest,
  type IsolatedProbeTargets,
  type IsolatedProbePlan,
  type IsolatedProbeResult,
  type IsolatedProbeState
} from '../../../../shared/relay/isolated-probes'
import { preferredCachedProfile } from './proxy-library-model'
import { relayProfileRead } from './profile-read-queue'
import { executeIsolatedProbe } from './isolated-probe-action'

export function RelayIsolatedProbesPanel({
  busy,
  onBusy,
  active = true,
  between
}: {
  busy: boolean
  onBusy(value: boolean): void
  active?: boolean
  between?: ReactNode
}): React.JSX.Element {
  const [profiles, setProfiles] = useState<RelayProfileInventory>()
  const [profile, setProfile] = useState('')
  const [targets, setTargets] = useState<IsolatedProbeTargets>()
  const [target, setTarget] = useState('')
  const [kind, setKind] = useState<'nodeDelay' | 'groupDelay'>('nodeDelay')
  const [delayTarget, setDelayTarget] = useState('')
  const [ipResult, setIPResult] = useState<IsolatedProbeResult>()
  const [ipAttempted, setIPAttempted] = useState(false)
  const [latencyResult, setLatencyResult] = useState<IsolatedProbeResult>()
  const [hideIP, setHideIP] = useState(false)
  const [runningKind, setRunningKind] = useState<IsolatedProbeRequest['kind']>()
  const [provider, setProvider] = useState<ProbeIPProvider>('ip.sb')
  const [plan, setPlan] = useState<IsolatedProbePlan>()
  const [result, setResult] = useState<IsolatedProbeResult>()
  const [state, setState] = useState<IsolatedProbeState>()
  const [pending, setPending] = useState(false)
  const [probing, setProbing] = useState(false)
  const [notice, setNotice] = useState('')
  const operation = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true)
  const attempted = useRef(false),
    cancelled = useRef(false)
  const runningId = useRef<string | undefined>(undefined)
  useEffect(() => {
    mounted.current = true
    const lifecycle = epoch
    return () => {
      mounted.current = false
      cancelled.current = true
      ++lifecycle.current
      const id = runningId.current
      if (id)
        void window.electron.ipcRenderer
          .invoke('relayIsolatedProbeCancel', { evidenceId: id })
          .catch(() => {})
    }
  }, [])
  const changed = (): void => {
    ++epoch.current
    setPlan(undefined)
    setResult(undefined)
    setIPResult(undefined)
    setIPAttempted(false)
    setLatencyResult(undefined)
    setNotice('')
  }
  const load = async (requested = profile): Promise<void> => {
    if (operation.current || busy) return
    operation.current = true
    const at = ++epoch.current
    setPending(true)
    setTargets(undefined)
    try {
      const inventory = await relayProfileRead('relayProfileList')
      const sources = await relayProfileRead('relaySourceList')
      const selection = (await window.electron.ipcRenderer.invoke(
        'getProfileConfig'
      )) as IProfileConfig
      const selected = preferredCachedProfile({
        queryId: requested,
        currentSelection: selection.current,
        sources: sources.sources,
        profiles: inventory.profiles
      })
      const next = selected
        ? ((await window.electron.ipcRenderer.invoke('relayIsolatedProbeTargets', {
            id: selected.id,
            sha256: selected.sha256
          })) as IsolatedProbeTargets)
        : undefined
      const status = (await window.electron.ipcRenderer.invoke(
        'relayIsolatedProbeState'
      )) as IsolatedProbeState
      if (!mounted.current || at !== epoch.current) return
      setProfiles(inventory)
      setProfile(selected?.id ?? '')
      setTargets(next)
      setState(status)
      const names = kind === 'groupDelay' ? next?.groups : next?.nodes
      setTarget(next?.nodes.includes(target) ? target : (next?.nodes[0] ?? ''))
      setDelayTarget(names?.includes(delayTarget) ? delayTarget : (names?.[0] ?? ''))
      setNotice('')
    } catch {
      if (mounted.current && at === epoch.current) setNotice('节点读取失败，请刷新后重试。')
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
    }
  }
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!active) {
      attempted.current = false
      return
    }
    if (busy || attempted.current) return
    attempted.current = true
    void loadRef.current()
  }, [active, busy])
  const run = async (
    action: 'probe' | 'cleanup' | 'state',
    requestedKind: IsolatedProbeRequest['kind'] = kind,
    requestedTarget = target
  ): Promise<void> => {
    if (operation.current || busy) return
    if (
      action === 'probe' &&
      (state?.uncertain ||
        state?.pending ||
        !(requestedKind === 'groupDelay' ? targets?.groups : targets?.nodes)?.includes(
          requestedTarget
        ))
    )
      return
    operation.current = true
    const at = epoch.current
    cancelled.current = false
    setPending(true)
    setProbing(action === 'probe')
    setRunningKind(action === 'probe' ? requestedKind : undefined)
    onBusy(true)
    try {
      if (action === 'probe') {
        const selected = profiles?.profiles.find((row) => row.id === profile)
        if (!selected || !requestedTarget) throw new Error()
        if (requestedKind === 'ip') {
          setIPResult(undefined)
          setIPAttempted(true)
        } else if (requestedKind === 'latency') setLatencyResult(undefined)
        else setResult(undefined)
        setNotice('正在检查节点来源和网络环境…')
        const next = await executeIsolatedProbe(
          {
            profile: { id: selected.id, sha256: selected.sha256 },
            target: requestedTarget,
            kind: requestedKind,
            provider
          },
          (channel, input) => window.electron.ipcRenderer.invoke(channel, input),
          {
            cancelled: () => cancelled.current || !mounted.current,
            prepared: (value) => {
              runningId.current = value.evidenceId
              if (mounted.current) setPlan(value)
            }
          }
        )
        if (mounted.current && at === epoch.current) {
          if (requestedKind === 'ip') setIPResult(next)
          else if (requestedKind === 'latency') setLatencyResult(next)
          else setResult(next)
          setPlan(undefined)
          setNotice(next.status === 'cancelled' ? '已取消探测。' : '探测完成，临时连接已结束。')
        }
      } else {
        const next = (await window.electron.ipcRenderer.invoke(
          action === 'cleanup' ? 'relayIsolatedProbeCleanup' : 'relayIsolatedProbeState'
        )) as IsolatedProbeState
        if (mounted.current && at === epoch.current) setState(next)
      }
    } catch (error) {
      if (mounted.current && at === epoch.current)
        setNotice(errorMessage(error, '探测未完成，请核对节点和环境；收尾信息见下方。'))
    } finally {
      runningId.current = undefined
      try {
        const next = (await window.electron.ipcRenderer.invoke(
          'relayIsolatedProbeState'
        )) as IsolatedProbeState
        if (mounted.current && at === epoch.current) setState(next)
      } catch {
        if (mounted.current && at === epoch.current) setState(undefined)
      }
      operation.current = false
      if (mounted.current) {
        setPending(false)
        setProbing(false)
      }
      onBusy(false)
    }
  }
  const cancel = (): void => {
    cancelled.current = true
    const id = runningId.current
    if (id)
      void window.electron.ipcRenderer
        .invoke('relayIsolatedProbeCancel', { evidenceId: id })
        .catch(() => {})
  }
  const locked = busy || pending
  const names = kind === 'groupDelay' ? targets?.groups : targets?.nodes
  const canProbe =
    !locked && !!targets?.nodes.includes(target) && !state?.uncertain && !state?.pending
  const measured = latencyResult?.measurements.filter((row) => row.milliseconds !== null) ?? []
  const average = measured.length
    ? Math.round(measured.reduce((sum, row) => sum + (row.milliseconds ?? 0), 0) / measured.length)
    : undefined
  const maxDelay = Math.max(1, ...measured.map((row) => row.milliseconds ?? 0))
  const copyIP = async (): Promise<void> => {
    if (!ipResult?.ip) return
    try {
      await navigator.clipboard.writeText(ipResult.ip.ip)
      setNotice('已复制 IP 地址。')
    } catch {
      setNotice('复制失败，请手动选择 IP 地址复制。')
    }
  }
  return (
    <section className="relay-probes" aria-label="出口 IP 与延迟">
      <div className="relay-probe-card">
        <div className="relay-runtime-toolbar">
          <h3 className="relay-runtime-spacer">当前 IP</h3>
          <select
            aria-label="出口 IP 服务"
            disabled={locked}
            value={provider}
            onChange={(event) => {
              setIPResult(undefined)
              setProvider(event.target.value as ProbeIPProvider)
            }}
          >
            {probeIPProviders.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <button
            type="button"
            className="relay-icon-button"
            title="查询出口 IP"
            aria-label="查询出口 IP"
            disabled={!canProbe}
            onClick={() => void run('probe', 'ip')}
          >
            <IoRefreshOutline size={18} />
          </button>
        </div>
        <p className="relay-probe-scope">
          {target ? `查询节点：${target}` : '未选择查询节点'} · 点击刷新后通过此节点查询
        </p>
        {ipResult?.ip ? (
          <div className="relay-probe-result">
            <span>IP 地址</span>
            <div className="relay-probe-ip-value">
              <strong className="select-text">{hideIP ? '•••.•••.•••.•••' : ipResult.ip.ip}</strong>
              <button
                type="button"
                className="relay-icon-button"
                aria-label={hideIP ? '显示 IP 地址' : '隐藏 IP 地址'}
                title={hideIP ? '显示 IP 地址' : '隐藏 IP 地址'}
                onClick={() => setHideIP(!hideIP)}
              >
                {hideIP ? <IoEyeOffOutline /> : <IoEyeOutline />}
              </button>
              <button
                type="button"
                className="relay-icon-button"
                aria-label="复制 IP 地址"
                title="复制 IP 地址"
                onClick={() => void copyIP()}
              >
                <IoCopyOutline />
              </button>
            </div>
            <span>国家/地区</span>
            <span>
              {ipResult.ip.countryCode && (
                <span className={`fi fi-${ipResult.ip.countryCode.toLowerCase()} mr-2`} />
              )}
              {ipResult.ip.country || '未返回'}
            </span>
            <span>城市</span>
            <span>
              {[ipResult.ip.region, ipResult.ip.city].filter(Boolean).join(' · ') || '未返回'}
            </span>
            <span>坐标</span>
            <span>
              {ipResult.ip.latitude !== undefined && ipResult.ip.longitude !== undefined
                ? `${ipResult.ip.latitude}, ${ipResult.ip.longitude}`
                : '未返回'}
            </span>
            <span>ASN</span>
            <span>{ipResult.ip.asn || '未返回'}</span>
            <span>组织</span>
            <span>{ipResult.ip.organization || '未返回'}</span>
          </div>
        ) : (
          <div className="relay-runtime-empty">
            {probing && runningKind === 'ip'
              ? '正在查询出口 IP…'
              : ipAttempted
                ? '出口 IP 查询未完成，请查看提示后重试。'
                : '尚未查询出口 IP，点击此卡片右上角刷新。'}
          </div>
        )}
        <details className="relay-runtime-advanced">
          <summary>选择查询节点</summary>
          <div className="relay-runtime-toolbar">
            <select
              aria-label="探测配置"
              disabled={locked}
              value={profile}
              onChange={(event) => {
                changed()
                setProfile(event.target.value)
                void load(event.target.value)
              }}
            >
              {!profile && <option value="">选择配置</option>}
              {profiles?.profiles.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
            <select
              aria-label="探测节点"
              disabled={locked}
              value={target}
              onChange={(event) => {
                changed()
                setTarget(event.target.value)
              }}
            >
              {!target && <option value="">选择节点</option>}
              {targets?.nodes.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
            <button
              disabled={locked}
              onClick={() => {
                changed()
                void load()
              }}
            >
              刷新节点
            </button>
          </div>
          {!pending && targets && !targets.nodes.length && (
            <p>此配置没有可独立探测的静态公网节点。</p>
          )}
        </details>
      </div>
      {between}
      <div className="relay-probe-card">
        <div className="relay-runtime-toolbar">
          <h3 className="relay-runtime-spacer">网络延迟</h3>
          {average !== undefined && <span className="relay-delay-average">平均：{average} ms</span>}
          <button
            type="button"
            className="relay-icon-button"
            title="测试网络延迟"
            aria-label="测试网络延迟"
            disabled={!canProbe}
            onClick={() => void run('probe', 'latency')}
          >
            <IoRefreshOutline size={18} />
          </button>
        </div>
        <p className="relay-probe-scope">{target ? `测试节点：${target}` : '未选择测试节点'}</p>
        {(latencyResult?.measurements.length
          ? latencyResult.measurements
          : ['Google', 'Cloudflare', 'GitHub'].map((name) => ({ name, milliseconds: null }))
        ).map((row) => (
          <div className="relay-probe-measurement" key={row.name}>
            <span>{row.name}</span>
            <div className="relay-delay-track">
              <span
                style={{
                  width:
                    row.milliseconds === null
                      ? '0%'
                      : `${Math.max(2, (row.milliseconds / maxDelay) * 100)}%`,
                  background:
                    row.milliseconds !== null && row.milliseconds < 100
                      ? 'hsl(var(--heroui-success))'
                      : row.milliseconds !== null && row.milliseconds < 300
                        ? 'hsl(var(--heroui-warning))'
                        : 'hsl(var(--heroui-danger))'
                }}
              />
            </div>
            <span>
              {row.milliseconds === null
                ? latencyResult
                  ? '未确认'
                  : probing && runningKind === 'latency'
                    ? '测试中…'
                    : '—'
                : `${row.milliseconds} ms`}
            </span>
          </div>
        ))}
      </div>
      {probing && <button onClick={cancel}>取消探测</button>}
      {notice && <p role="status">{notice}</p>}
      {state?.warning && <p role="alert">{state.warning}</p>}
      <details className="relay-runtime-advanced">
        <summary>节点测速与探测说明</summary>
        <div className="relay-runtime-toolbar">
          <select
            aria-label="测速内容"
            disabled={locked}
            value={kind}
            onChange={(event) => {
              setResult(undefined)
              const next = event.target.value as 'nodeDelay' | 'groupDelay'
              setKind(next)
              setDelayTarget((next === 'groupDelay' ? targets?.groups : targets?.nodes)?.[0] ?? '')
            }}
          >
            <option value="nodeDelay">节点延迟</option>
            <option value="groupDelay">代理组延迟</option>
          </select>
          <select
            aria-label="测速节点或组"
            disabled={locked}
            value={delayTarget}
            onChange={(event) => {
              setResult(undefined)
              setDelayTarget(event.target.value)
            }}
          >
            {!delayTarget && <option value="">选择节点或组</option>}
            {names?.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <button
            disabled={
              locked || !names?.includes(delayTarget) || !!state?.uncertain || !!state?.pending
            }
            onClick={() => void run('probe', kind, delayTarget)}
          >
            测试延迟
          </button>
        </div>
        {result?.measurements.map((row) => (
          <div className="relay-probe-measurement" key={row.name}>
            <strong>{row.name}</strong>
            <span>{row.milliseconds === null ? '未确认' : `${row.milliseconds} ms`}</span>
          </div>
        ))}
        <p>
          仅支持已保存的静态公网节点。使用临时核心，不更改在用核心的选路或测速记录；结果代表所选节点，不代表在用网络出口。TUN
          截流或环境无法确认时不会继续。网络延迟使用固定的 Google、Cloudflare 和 GitHub 测试地址。
        </p>
        <div className="relay-runtime-toolbar">
          <button disabled={locked} onClick={() => void run('state')}>
            刷新收尾状态
          </button>
          <button disabled={locked || !state?.canCleanup} onClick={() => void run('cleanup')}>
            处理临时记录…
          </button>
        </div>
        {plan && (
          <p>
            待执行：{plan.name} · {plan.nodes.join('、')} · {plan.origins.join('、')}
          </p>
        )}
      </details>
    </section>
  )
}
