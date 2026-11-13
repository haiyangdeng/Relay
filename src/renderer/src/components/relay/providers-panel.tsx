import { useEffect, useRef, useState } from 'react'
import type { RelayStoredProfile, RelayProfileSaveResult } from '../../../../shared/relay/profiles'
import type { RelayProfileSelection } from '../../../../shared/relay/runtime'
import type {
  ProviderBatchFetchResult,
  ProviderBatchPreparation,
  ProviderInventory,
  ProviderPreparation,
  ProviderFetchResult,
  ProviderSnapshotPreparation,
  ProviderState
} from '../../../../shared/relay/providers'

const batchStatus = {
  cached: '已缓存',
  cancelled: '已取消',
  partial: '部分完成',
  failed: '失败',
  uncertain: '结果未确认',
  skipped: '未执行'
}

export function RelayProvidersPanel({
  profiles,
  busy,
  onBusy,
  onSaved
}: {
  profiles: RelayStoredProfile[]
  busy: boolean
  onBusy(value: boolean): void
  onSaved(): Promise<void>
}): React.JSX.Element {
  const [sourceId, setSourceId] = useState(''),
    [port, setPort] = useState(18191)
  const [inventory, setInventory] = useState<ProviderInventory>(),
    [prepared, setPrepared] = useState<ProviderPreparation>()
  const [batchPrepared, setBatchPrepared] = useState<ProviderBatchPreparation>(),
    [batchResult, setBatchResult] = useState<ProviderBatchFetchResult>()
  const [snapshot, setSnapshot] = useState<ProviderSnapshotPreparation>(),
    [state, setState] = useState<ProviderState>()
  const [choices, setChoices] = useState<Record<string, RelayProfileSelection>>({}),
    [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false),
    operation = useRef(false),
    batchOperationId = useRef<string | undefined>(undefined),
    epoch = useRef(0),
    mounted = useRef(true),
    ownedEvidence = useRef<string | undefined>(undefined),
    latestSource = useRef('')
  const source = profiles.find((profile) => profile.id === sourceId)
  const sourceKey = source ? `${source.id}:${source.sha256}` : ''
  latestSource.current = sourceKey
  const discard = async (evidenceId: string): Promise<void> => {
    if (ownedEvidence.current === evidenceId) ownedEvidence.current = undefined
    try {
      await window.electron.ipcRenderer.invoke('relayProviderCancel', { evidenceId })
    } catch {
      /* Never retry cancellation or resubmit the action. */
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
  useEffect(() => {
    ++epoch.current
    setInventory(undefined)
    setChoices({})
    setPrepared(undefined)
    setBatchPrepared(undefined)
    setBatchResult(undefined)
    setSnapshot(undefined)
    setState(undefined)
    if (ownedEvidence.current) void discard(ownedEvidence.current)
  }, [sourceKey])
  const batchNames =
    inventory && inventory.profile.id === source?.id && inventory.profile.sha256 === source.sha256
      ? inventory.providers.filter((p) => p.canAcquire && p.kind === 'http').map((p) => p.name)
      : []
  const batchPlan =
    batchPrepared &&
    batchPrepared.profile.id === source?.id &&
    batchPrepared.profile.sha256 === source.sha256 &&
    batchPrepared.proxyPort === port
      ? batchPrepared
      : undefined
  const watching = !!(pending || prepared || batchPrepared || snapshot || state?.pending)
  useEffect(() => {
    let active = true
    const read = async (): Promise<void> => {
      const current = epoch.current
      try {
        const value = (await window.electron.ipcRenderer.invoke(
          'relayProviderState'
        )) as ProviderState
        if (!active || current !== epoch.current) return
        setState(value)
        if (!operation.current) {
          setPrepared((previous) =>
            previous?.evidenceId === value.preparedId ? previous : undefined
          )
          setBatchPrepared((previous) =>
            previous?.evidenceId === value.batchPreparedId ? previous : undefined
          )
          setSnapshot((previous) =>
            previous?.evidenceId === value.snapshotId ? previous : undefined
          )
        }
      } catch {
        /* Preserve unconfirmed operation state; never replay a mutation. */
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
    kind: 'inspect' | 'prepare' | 'batch-prepare' | 'snapshot',
    provider?: string
  ): Promise<void> => {
    if (!mounted.current || operation.current || busy || !source) return
    if (kind === 'batch-prepare' && !batchNames.length) return
    const profile = { id: source.id, sha256: source.sha256 },
      sourceKey = `${source.id}:${source.sha256}`,
      ticket = ++epoch.current,
      live = (): boolean =>
        mounted.current && ticket === epoch.current && sourceKey === latestSource.current
    const check = (): void => {
      if (!live()) throw new Error('来源或操作已变化。')
    }
    const inspect = async (): Promise<void> => {
      const next = (await window.electron.ipcRenderer.invoke(
        'relayProvidersInspect',
        profile
      )) as ProviderInventory
      check()
      if (next.profile.id !== profile.id || next.profile.sha256 !== profile.sha256)
        throw new Error('来源已变化。')
      setInventory(next)
    }
    operation.current = true
    setPending(true)
    onBusy(true)
    setNotice('正在处理提供者…')
    try {
      setPrepared(undefined)
      setBatchPrepared(undefined)
      setSnapshot(undefined)
      if (kind === 'inspect') {
        setInventory(undefined)
        setChoices({})
        await inspect()
        setNotice('已核对声明及私有缓存；没有获取资源或启用配置。')
      } else if (kind === 'prepare') {
        const plan = (await window.electron.ipcRenderer.invoke('relayProviderPrepare', {
          profile,
          provider,
          proxyPort: port
        })) as ProviderPreparation
        ownedEvidence.current = plan.evidenceId
        check()
        setPrepared(plan)
        const result = (await window.electron.ipcRenderer.invoke('relayProviderAcquire', {
          evidenceId: plan.evidenceId
        })) as ProviderFetchResult
        check()
        setPrepared(undefined)
        setNotice(result.warnings.join(' '))
        if (result.status === 'cached' || result.status === 'uncertain') {
          setChoices({})
          await inspect()
        }
      } else if (kind === 'batch-prepare') {
        setBatchResult(undefined)
        const plan = (await window.electron.ipcRenderer.invoke('relayProviderBatchPrepare', {
          profile,
          providers: batchNames,
          proxyPort: port
        })) as ProviderBatchPreparation
        ownedEvidence.current = plan.evidenceId
        check()
        setBatchPrepared(plan)
        batchOperationId.current = plan.evidenceId
        const result = (await window.electron.ipcRenderer.invoke('relayProviderBatchAcquire', {
          evidenceId: plan.evidenceId
        })) as ProviderBatchFetchResult
        check()
        setBatchPrepared(undefined)
        setBatchResult(result)
        setChoices({})
        setNotice('批量刷新已完成，逐项结果见下方。')
        await inspect()
      } else {
        const report = (await window.electron.ipcRenderer.invoke('relayProviderSnapshotPrepare', {
          profile,
          resources: choices
        })) as ProviderSnapshotPreparation
        ownedEvidence.current = report.evidenceId
        check()
        setSnapshot(report)
        setNotice(report.issues.join(' '))
        if (report.canSave) {
          const result = (await window.electron.ipcRenderer.invoke('relayProviderSnapshotSave', {
            evidenceId: report.evidenceId
          })) as RelayProfileSaveResult
          check()
          setSnapshot(undefined)
          setNotice(result.warnings.join(' ') || '缓存配置副本已保存。')
          if (result.status === 'saved' || result.status === 'uncertain') await onSaved()
        }
      }
    } catch {
      if (live())
        setNotice('操作未确认：请核对来源、资源格式、缓存归属或过期凭据；没有自动重试或启用。')
    } finally {
      if (!live() && ownedEvidence.current) await discard(ownedEvidence.current)
      if (mounted.current && sourceKey === latestSource.current) {
        try {
          const next = (await window.electron.ipcRenderer.invoke(
            'relayProviderState'
          )) as ProviderState
          if (mounted.current && sourceKey === latestSource.current) setState(next)
        } catch {
          /* Preserve pending state. */
        }
      }
      ownedEvidence.current = undefined
      batchOperationId.current = undefined
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  const cancel = async (): Promise<void> => {
    ++epoch.current
    const id =
      ownedEvidence.current ??
      state?.operationId ??
      state?.preparedId ??
      state?.batchPreparedId ??
      state?.snapshotId
    setPrepared(undefined)
    setBatchPrepared(undefined)
    setSnapshot(undefined)
    setNotice('已取消后续步骤，正在等待本次操作收尾。')
    if (id) await discard(id)
  }
  const locked = busy || pending || state?.pending
  return (
    <section className="relay-panel relay-profiles">
      <h2>节点提供者 · 私有资源快照</h2>
      <p>
        仅在点击操作后读取内联payload、选择本地文件或经指定HTTP代理获取资源。不会读取原Clash缓存路径，不运行定时更新／健康检查，不自动启用配置。
      </p>
      <label>
        已保存的含提供者配置
        <select
          value={sourceId}
          disabled={!!locked}
          onChange={(event) => {
            setSourceId(event.target.value)
            setInventory(undefined)
            setChoices({})
            setPrepared(undefined)
            setBatchPrepared(undefined)
            setBatchResult(undefined)
            setSnapshot(undefined)
          }}
        >
          <option value="">请选择</option>
          {profiles
            .filter((p) => p.summary.proxyProviders > 0)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        HTTP资源获取代理端口
        <input
          type="number"
          min={1024}
          max={65535}
          value={Number.isFinite(port) ? port : ''}
          disabled={!!locked}
          onChange={(event) => {
            ++epoch.current
            setPort(Number(event.target.value))
            setPrepared(undefined)
            setBatchPrepared(undefined)
          }}
        />
      </label>
      <div className="relay-action">
        <button disabled={!!locked || !sourceId} onClick={() => void action('inspect')}>
          读取提供者及缓存
        </button>
        <button
          disabled={
            !!locked ||
            !inventory ||
            inventory.profile.id !== source?.id ||
            inventory.profile.sha256 !== source?.sha256 ||
            inventory.providers.some((p) => !choices[p.name])
          }
          onClick={() => void action('snapshot')}
        >
          保存缓存配置副本
        </button>
        <button
          disabled={
            (state?.phase === 'saving' && state.operationId !== batchOperationId.current) ||
            !(
              pending ||
              state?.operationId ||
              state?.preparedId ||
              state?.batchPreparedId ||
              state?.snapshotId
            )
          }
          onClick={() => void cancel()}
        >
          取消本次操作
        </button>
      </div>
      {prepared && (
        <p>
          准备：{prepared.provider.name} · {prepared.provider.kind} ·{' '}
          {prepared.provider.origin ?? '不回显本地路径／内联内容'}。
        </p>
      )}
      <h3>批量刷新节点提供者缓存</h3>
      <p>
        通过指定的本地 HTTP 代理逐项获取此配置中可获取的 HTTP 或 HTTPS 节点资源，写入 Relay
        私有缓存。要应用新资源，先从缓存选择版本并另存配置副本，再单独检查和启用该副本。文件和内联提供者可逐项获取。
      </p>
      <div className="relay-action">
        <button
          disabled={
            !!locked || !batchNames.length || !Number.isInteger(port) || port < 1024 || port > 65535
          }
          onClick={() => void action('batch-prepare')}
        >
          刷新全部提供者{batchNames.length ? `（${batchNames.length} 项）` : ''}
        </button>
      </div>
      {batchPlan && (
        <div>
          <p>
            已核对 {batchPlan.profile.name} 的 {batchPlan.providers.length} 项提供者，本地代理端口{' '}
            {batchPlan.proxyPort}。正在执行本次刷新。取消后，已完成的缓存会保留。
          </p>
          {batchPlan.providers.some((item) => item.origin?.startsWith('http://')) && (
            <p>本批包含明文 HTTP 来源。代理外的传输链路可能读取或篡改响应。</p>
          )}
          <ul aria-label="本次批量刷新清单">
            {batchPlan.providers.map((item) => (
              <li key={item.name}>
                {item.name} · {item.origin}
              </li>
            ))}
          </ul>
        </div>
      )}
      {batchResult && (
        <div aria-live="polite">
          <p>批量刷新结果：{batchStatus[batchResult.status]}。</p>
          <ul aria-label="批量刷新逐项结果">
            {batchResult.items.map((item) => (
              <li key={item.provider}>
                {item.provider} · {batchStatus[item.status]}
                {item.resource &&
                  ` · ${item.resource.nodes} 节点 · ${item.resource.sha256.slice(0, 12)}`}
              </li>
            ))}
          </ul>
          {batchResult.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
      {inventory?.providers.map((p) => (
        <div key={p.name}>
          <h3>
            {p.name} · {p.kind}
          </h3>
          <button
            disabled={!!locked || !p.canAcquire}
            onClick={() => void action('prepare', p.name)}
          >
            获取并缓存此资源
          </button>
          <select
            aria-label={`${p.name}缓存选择`}
            disabled={!!locked}
            value={choices[p.name]?.id ?? ''}
            onChange={(event) => {
              const resource = p.resources.find((r) => r.id === event.target.value)
              setChoices((previous) => {
                const next = { ...previous }
                if (resource) next[p.name] = { id: resource.id, sha256: resource.sha256 }
                else delete next[p.name]
                return next
              })
              setSnapshot(undefined)
            }}
          >
            <option value="">明确选择一份已核对缓存</option>
            {p.resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.createdAt} · {r.nodes}节点 · {r.sha256.slice(0, 12)}
              </option>
            ))}
          </select>
          {p.issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </div>
      ))}
      {snapshot && (
        <p>
          {snapshot.nodes}节点 · {snapshot.bytes}字节 · SHA256：{snapshot.sha256}
          ；仅保存副本，完整核心兼容性未验证。
        </p>
      )}
      <p>
        资源与缓存副本上限2MiB。原path／proxy／更新interval不执行。支持四类组及核心原生筛选；健康检查URL保留，保存时不执行，以后明确启动时按配置运行。未接入的提供者覆盖字段、名称冲突等会阻止转换；不会自动重命名或删减。完整核心兼容性未验证。
      </p>
      {notice && <p role="status">{notice}</p>}
      {inventory?.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </section>
  )
}
