import { useEffect, useRef, useState } from 'react'
import {
  resourceKinds,
  type ResourceKind,
  type ResourceDescriptor,
  type ResourceInventory,
  type ResourcePreparation,
  type ResourceState,
  type ResourceOperationResult
} from '../../../../shared/relay/resources'
import { RuleResourcePreviewModal } from './rule-resource-preview-modal'
import { RelayActiveRuleProvidersPanel } from './active-rule-providers-panel'

export function RelayResourcesPanel({
  busy,
  onBusy,
  tunSessionId,
  activeBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
  tunSessionId?: string
  activeBusy?: boolean
}): React.JSX.Element {
  const [name, setName] = useState('Resource'),
    [kind, setKind] = useState<ResourceKind>('rule-yaml'),
    [behavior, setBehavior] = useState<'domain' | 'ipcidr' | 'classical'>('domain'),
    [selector, setSelector] = useState('CN'),
    [sourceKind, setSourceKind] = useState<'file' | 'http' | 'inline'>('file'),
    [url, setURL] = useState(''),
    [port, setPort] = useState(7890),
    [headers, setHeaders] = useState('{}'),
    [payload, setPayload] = useState(''),
    [expected, setExpected] = useState(''),
    [inventory, setInventory] = useState<ResourceInventory>(),
    [selected, setSelected] = useState(''),
    [plan, setPlan] = useState<ResourcePreparation>(),
    [state, setState] = useState<ResourceState>(),
    [result, setResult] = useState<ResourceOperationResult>(),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    [preview, setPreview] = useState<{ id: string; sha256: string; name: string }>(),
    [previewPending, setPreviewPending] = useState(false),
    previewOperation = useRef(false),
    operation = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true),
    ownedEvidence = useRef<string | undefined>(undefined)
  const discard = async (evidenceId: string): Promise<void> => {
    if (ownedEvidence.current === evidenceId) ownedEvidence.current = undefined
    try {
      await window.electron.ipcRenderer.invoke('relayResourceCancel', { evidenceId })
    } catch {
      /* Never retry or resubmit an unconfirmed action. */
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
  const watching = !!(pending || plan || state?.pending)
  useEffect(() => {
    let active = true
    const read = async (): Promise<void> => {
      const at = epoch.current
      try {
        const next = (await window.electron.ipcRenderer.invoke(
          'relayResourceState'
        )) as ResourceState
        if (!active || at !== epoch.current) return
        setState(next)
        if (!operation.current)
          setPlan((previous) => (previous?.evidenceId === next.preparedId ? previous : undefined))
      } catch {
        /* Never replay a write after a status read failure. */
      }
    }
    void read()
    const timer = watching ? setInterval(() => void read(), 1000) : undefined
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [watching])
  const action = async (type: 'prepare' | 'list' | 'check'): Promise<void> => {
    if (!mounted.current || operation.current || previewOperation.current || busy) return
    const resource = inventory?.resources.find((r) => r.id === selected)
    if (type === 'check' && !resource) return
    const ticket = ++epoch.current,
      live = (): boolean => mounted.current && ticket === epoch.current
    const check = (): void => {
      if (!live()) throw new Error('操作已取消。')
    }
    const list = async (): Promise<void> => {
      const next = (await window.electron.ipcRenderer.invoke(
        'relayResourceList'
      )) as ResourceInventory
      check()
      setInventory(next)
    }
    operation.current = true
    setPending(true)
    onBusy(true)
    setNotice('正在处理资源…')
    setResult(undefined)
    if (type === 'check') setState({ phase: 'checking', pending: true })
    try {
      if (type === 'prepare') {
        const descriptor: ResourceDescriptor = {
            name,
            kind,
            behavior: kind.startsWith('rule-') ? behavior : null,
            selector: kind.startsWith('rule-') || kind === 'runtime-file' ? '' : selector
          },
          source =
            sourceKind === 'file'
              ? { kind: 'file' }
              : sourceKind === 'http'
                ? { kind: 'http', url, proxyPort: port, headers: JSON.parse(headers) }
                : { kind: 'inline', payload: payload.split(/\r?\n/u).filter((line) => line.trim()) }
        const prepared = (await window.electron.ipcRenderer.invoke('relayResourcePrepare', {
          descriptor,
          source,
          expectedSHA256: expected.trim().toLowerCase()
        })) as ResourcePreparation
        ownedEvidence.current = prepared.evidenceId
        check()
        setPlan(prepared)
        setURL('')
        setHeaders('{}')
        const output = (await window.electron.ipcRenderer.invoke('relayResourceAcquire', {
          evidenceId: prepared.evidenceId
        })) as ResourceOperationResult
        check()
        setPlan(undefined)
        setResult(output)
        setNotice(output.warnings.join(' ') || '资源获取已完成。')
        if (output.status === 'cached' || output.status === 'uncertain') await list()
      } else if (type === 'list') {
        await list()
        setNotice('已读取资源元数据列表；正文摘要和核心格式需单独检查。')
      } else {
        setPlan(undefined)
        const output = (await window.electron.ipcRenderer.invoke('relayResourceCheck', {
          id: resource?.id,
          sha256: resource?.sha256
        })) as ResourceOperationResult
        check()
        setResult(output)
        setNotice(output.warnings.join(' '))
      }
    } catch {
      if (live())
        setNotice('资源操作未确认；请核对来源、类型、摘要或过期凭据，没有自动重试或启用。')
    } finally {
      if (!live() && ownedEvidence.current) await discard(ownedEvidence.current)
      if (mounted.current) {
        try {
          const next = (await window.electron.ipcRenderer.invoke(
            'relayResourceState'
          )) as ResourceState
          if (mounted.current) setState(next)
        } catch {
          /* Preserve pending state until confirmed. */
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
    setNotice('已取消后续步骤，正在等待本次资源操作收尾。')
    if (id) await discard(id)
  }
  const selectedResource = inventory?.resources.find((resource) => resource.id === selected),
    locked = !!(busy || pending || state?.pending || previewPending || preview),
    changed = (): void => {
      ++epoch.current
      setPlan(undefined)
      setResult(undefined)
    }
  return (
    <section className="relay-panel">
      <h2>规则与地理资源 · 私有快照</h2>
      <p>
        本地文件、指定代理HTTP或YAML内联列表只保存到独立缓存；不读取原path，不自动更新或启用。元数据可读取、正文摘要匹配、核心格式接受分别显示。
      </p>
      <label>
        资源名称
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
        格式
        <select
          value={kind}
          disabled={locked}
          onChange={(e) => {
            const next = e.target.value as ResourceKind
            setKind(next)
            if (next === 'rule-mrs' && behavior === 'classical') setBehavior('domain')
            if (next !== 'rule-yaml' && sourceKind === 'inline') setSourceKind('file')
            setSelector(next === 'asn-mmdb' ? '64512' : 'CN')
            changed()
          }}
        >
          {resourceKinds.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      {kind.startsWith('rule-') ? (
        <label>
          规则行为
          <select
            value={behavior}
            disabled={locked}
            onChange={(e) => {
              setBehavior(e.target.value as typeof behavior)
              changed()
            }}
          >
            <option value="domain">domain</option>
            <option value="ipcidr">ipcidr</option>
            {kind !== 'rule-mrs' && <option value="classical">classical</option>}
          </select>
        </label>
      ) : kind !== 'runtime-file' ? (
        <label>
          核心校验分类／ASN
          <input
            value={selector}
            disabled={locked}
            onChange={(e) => {
              setSelector(e.target.value)
              changed()
            }}
          />
        </label>
      ) : (
        <p>通用文件仅缓存摘要；绑定配置时再核对证书、密钥或其他文件用途。</p>
      )}
      <label>
        来源
        <select
          value={sourceKind}
          disabled={locked}
          onChange={(e) => {
            setSourceKind(e.target.value as typeof sourceKind)
            changed()
          }}
        >
          <option value="file">本地选择</option>
          <option value="http">指定HTTP代理下载</option>
          {kind === 'rule-yaml' && <option value="inline">内联规则</option>}
        </select>
      </label>
      {sourceKind === 'http' && (
        <div>
          <label>
            资源URL
            <input
              type="password"
              autoComplete="off"
              value={url}
              disabled={locked}
              onChange={(e) => {
                setURL(e.target.value)
                changed()
              }}
            />
          </label>
          <label>
            HTTP代理端口
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
            私有请求头JSON
            <textarea
              spellCheck={false}
              value={headers}
              disabled={locked}
              onChange={(e) => {
                setHeaders(e.target.value)
                changed()
              }}
            />
          </label>
        </div>
      )}
      {sourceKind === 'inline' && (
        <label>
          内联规则，每行一项
          <textarea
            value={payload}
            disabled={locked}
            spellCheck={false}
            onChange={(e) => {
              setPayload(e.target.value)
              changed()
            }}
          />
        </label>
      )}
      <label>
        预期SHA256（可选）
        <input
          value={expected}
          disabled={locked}
          spellCheck={false}
          onChange={(e) => {
            setExpected(e.target.value)
            changed()
          }}
        />
      </label>
      <div className="relay-action">
        <button disabled={locked || !name.trim()} onClick={() => void action('prepare')}>
          获取并缓存资源
        </button>
        <button disabled={locked} onClick={() => void action('list')}>
          读取私有资源列表
        </button>
        <button
          disabled={
            previewPending ||
            !!preview ||
            state?.phase === 'saving' ||
            !(pending || state?.operationId || state?.preparedId || plan)
          }
          onClick={() => void cancel()}
        >
          取消本次资源操作
        </button>
      </div>
      {plan && (
        <p>
          待获取：{plan.descriptor.kind} · {plan.source.kind} ·{' '}
          {plan.source.origin ?? '本地／内联，不回显路径或内容'}；预期摘要
          {plan.expectedSHA256 || '未指定'}。
        </p>
      )}
      <label>
        选择缓存
        <select
          value={selected}
          disabled={locked}
          onChange={(e) => {
            setSelected(e.target.value)
            setResult(undefined)
            setPreview(undefined)
          }}
        >
          <option value="">请选择</option>
          {inventory?.resources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {r.kind} · {r.size}字节 · {r.sha256.slice(0, 12)} · 正文未检查
            </option>
          ))}
        </select>
      </label>
      <button disabled={locked || !selected} onClick={() => void action('check')}>
        用固定核心检查所选资源
      </button>
      <button
        disabled={
          locked ||
          !selectedResource ||
          !['rule-yaml', 'rule-text', 'rule-mrs'].includes(selectedResource.kind)
        }
        onClick={() => {
          if (operation.current || previewOperation.current || !selectedResource) return
          setPreview({
            id: selectedResource.id,
            sha256: selectedResource.sha256,
            name: selectedResource.name
          })
        }}
      >
        只读预览所选规则缓存
      </button>
      <p>预览仅支持规则文本／受限MRS转换；地理数据库和通用文件不返回正文。</p>
      {preview && (
        <RuleResourcePreviewModal
          selection={{ id: preview.id, sha256: preview.sha256 }}
          title={preview.name}
          onClose={() => setPreview(undefined)}
          onBusy={(value) => {
            previewOperation.current = value
            setPreviewPending(value)
            onBusy(value)
          }}
        />
      )}
      {result?.check && (
        <p>
          本次核心检查：{result.check.status} · SHA256 {result.check.resourceSHA256} ·{' '}
          {result.check.ruleCount ?? '非规则列表'}；运行配置尚未关联该资源，运行前仍需重验。
        </p>
      )}
      <p>
        二进制资源最大128MiB，文本规则检查8MiB，MRS解压检查64MiB。校验使用无代理端口／DNS／TUN的临时实例，禁用依赖自动下载；部分classical规则需要完整配置的地理依赖后再验证。不代表数据库覆盖或真实出口已验证。
      </p>
      {notice && <p role="status">{notice}</p>}
      {inventory?.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      <RelayActiveRuleProvidersPanel
        busy={activeBusy ?? busy}
        onBusy={onBusy}
        tunSessionId={tunSessionId}
      />
    </section>
  )
}
