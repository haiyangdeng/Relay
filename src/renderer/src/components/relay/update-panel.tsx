import { useEffect, useRef, useState } from 'react'
import type {
  RelayUpdatePlan,
  RelayUpdateState,
  RelayUpdateTarget
} from '../../../../shared/relay/updates'

const labels: Record<RelayUpdateTarget, string> = {
  core: '固定可信核心',
  'core-alpha': '固定Alpha核心',
  'core-smart': '固定Smart核心',
  'smart-model': 'Smart轻量模型',
  'smart-model-middle': 'Smart中型模型',
  'smart-model-large': 'Smart大型模型',
  'substore-backend': 'Sub-Store后端',
  'substore-frontend': 'Sub-Store前端'
}
export function RelayUpdatePanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [state, setState] = useState<RelayUpdateState>(),
    [plan, setPlan] = useState<RelayUpdatePlan>(),
    [target, setTarget] = useState<RelayUpdateTarget>('core'),
    [proxyPort, setProxyPort] = useState(7890),
    [pending, setPending] = useState(false),
    [importing, setImporting] = useState(false),
    [backendId, setBackendId] = useState(''),
    [frontendId, setFrontendId] = useState(''),
    [notice, setNotice] = useState(''),
    operation = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const lifecycle = epoch
    return () => {
      mounted.current = false
      ++lifecycle.current
    }
  }, [])
  const locked = busy || pending
  const invalidate = (): void => {
    const current = ++epoch.current
    setPlan(undefined)
    void window.electron.ipcRenderer.invoke('relayUpdateCancel').catch(() => {
      if (mounted.current && current === epoch.current)
        setNotice('取消结果未确认，请读取本地候选核对。')
    })
  }
  const action = async (
    kind: 'state' | 'download' | 'remove' | 'import' | 'substore',
    id?: string
  ): Promise<void> => {
    if (operation.current || busy) return
    operation.current = true
    const current = ++epoch.current
    const live = (): boolean => mounted.current && current === epoch.current
    setPending(true)
    setImporting(kind === 'import' || kind === 'substore')
    onBusy(true)
    setNotice('等待本次操作…')
    try {
      if (kind === 'download') {
        const prepared = (await window.electron.ipcRenderer.invoke('relayUpdatePrepare', {
          target,
          proxyPort
        })) as RelayUpdatePlan
        if (!live()) return
        setPlan(prepared)
        const result = (await window.electron.ipcRenderer.invoke('relayUpdateExecute', {
          evidenceId: prepared.evidenceId
        })) as { status: string }
        if (!live()) return
        setPlan(undefined)
        setNotice(
          result.status === 'staged'
            ? '候选已下载、校验并私有暂存；尚未安装、切换核心或启用资源。'
            : '本次获取已取消。'
        )
      } else if (kind === 'substore') {
        setPlan(undefined)
        const result = (await window.electron.ipcRenderer.invoke('relayUpdateApplySubStore', {
          backendId,
          frontendId
        })) as { status: string }
        setNotice(
          result.status === 'applied'
            ? 'Sub-Store固定资源副本已接入并复验；候选独立保留，尚未启动服务。请到Sub-Store面板核对后明确启动。'
            : '资源接入已取消，原资源及候选保留。'
        )
      } else if (kind === 'import') {
        setPlan(undefined)
        const result = (await window.electron.ipcRenderer.invoke('relayUpdateImportVariant', {
          id
        })) as { status: string }
        setNotice(
          result.status === 'imported'
            ? '已导入变体库。请到核心与Smart资源读取清单后选择；尚未启用或切换。'
            : '导入已取消，候选保留。'
        )
      } else if (kind === 'remove') {
        const result = (await window.electron.ipcRenderer.invoke('relayUpdateRemove', { id })) as {
          status: string
        }
        setNotice(
          result.status === 'removed' ? '私有候选已移除，在用版本保持原状。' : '移除已取消。'
        )
      } else setNotice('已核对本地可信清单及暂存候选，没有请求远端。')
      if (!live()) return
      const next = (await window.electron.ipcRenderer.invoke(
        'relayUpdateState'
      )) as RelayUpdateState
      if (live()) setState(next)
    } catch {
      if (!live()) return
      setPlan(undefined)
      setNotice('候选未确认或获取、校验失败；既有版本保留，请重新核对，没有安装或自动重试。')
    } finally {
      operation.current = false
      if (mounted.current) {
        setPending(false)
        setImporting(false)
      }
      onBusy(false)
    }
  }
  return (
    <section className="relay-panel">
      <h2>可信资源获取与更新候选</h2>
      <p>
        核对构建时固定的可信版本，按需获取缺失资源或暂存同版本候选。此入口不发现远端最新版本，也不会把重新下载显示为升级完成。
      </p>
      <button disabled={locked} onClick={() => void action('state')}>
        核对可信版本与本地候选
      </button>
      <label>
        资源
        <select
          value={target}
          disabled={locked}
          onChange={(event) => {
            setTarget(event.target.value as RelayUpdateTarget)
            invalidate()
          }}
        >
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        本次HTTP代理端口
        <input
          type="number"
          min={1024}
          max={65535}
          value={proxyPort}
          disabled={locked}
          onChange={(event) => {
            setProxyPort(Number(event.target.value))
            invalidate()
          }}
        />
      </label>
      <div className="relay-action">
        <button disabled={locked} onClick={() => void action('download')}>
          下载并校验候选
        </button>
        <button
          disabled={importing || (!pending && !plan)}
          onClick={() => {
            invalidate()
            setNotice('已请求取消获取；在用版本保持原状。')
          }}
        >
          取消本次获取
        </button>
      </div>
      {plan && (
        <p>
          {labels[plan.target]} {plan.version}；下载{plan.downloadBytes}字节，经127.0.0.1:
          {plan.proxyPort}；本次凭据60秒有效。
        </p>
      )}
      {state && (
        <div>
          <p>
            Relay
            App发布与远端最新版本发现尚未配置，不能据此判断应用是否为最新版本。固定核心和模型可下载为候选，实际启用保留为独立步骤。
          </p>
          <ul>
            {state.trustedAssets.map((asset) => (
              <li key={asset.target}>
                {labels[asset.target]}：{asset.version} {asset.architecture ?? ''}
              </li>
            ))}
          </ul>
          {state.candidates.map((candidate) => (
            <div key={candidate.id}>
              <p>
                {labels[candidate.target]} {candidate.version} · 已校验的独立候选 ·{' '}
                {candidate.payloadBytes}字节 · {candidate.payloadSHA256.slice(0, 12)}
              </p>
              <button disabled={locked} onClick={() => void action('remove', candidate.id)}>
                移除此暂存候选
              </button>
              {(candidate.target.startsWith('core') ||
                candidate.target.startsWith('smart-model')) && (
                <button disabled={locked} onClick={() => void action('import', candidate.id)}>
                  导入到变体库…
                </button>
              )}
            </div>
          ))}
          <h3>接入Sub-Store固定资源</h3>
          <p>
            分别选择已校验的后端和前端候选，点击接入后复制到资源缓存。先结束本次Sub-Store；业务数据保留，不自动启动。
          </p>
          <label>
            后端候选
            <select
              aria-label="Sub-Store后端候选"
              value={backendId}
              disabled={locked}
              onChange={(event) => {
                setBackendId(event.target.value)
                invalidate()
              }}
            >
              <option value="">请选择</option>
              {state.candidates
                .filter((candidate) => candidate.target === 'substore-backend')
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.version} · {candidate.id.slice(0, 8)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            前端候选
            <select
              aria-label="Sub-Store前端候选"
              value={frontendId}
              disabled={locked}
              onChange={(event) => {
                setFrontendId(event.target.value)
                invalidate()
              }}
            >
              <option value="">请选择</option>
              {state.candidates
                .filter((candidate) => candidate.target === 'substore-frontend')
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.version} · {candidate.id.slice(0, 8)}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={
              locked ||
              !state.candidates.some(
                (candidate) => candidate.id === backendId && candidate.target === 'substore-backend'
              ) ||
              !state.candidates.some(
                (candidate) =>
                  candidate.id === frontendId && candidate.target === 'substore-frontend'
              )
            }
            onClick={() => void action('substore')}
          >
            接入Sub-Store资源
          </button>
          {state.incomplete > 0 && <p>有{state.incomplete}项候选未通过复核，未显示为可用版本。</p>}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
