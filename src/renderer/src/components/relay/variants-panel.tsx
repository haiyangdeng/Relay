import { useEffect, useRef, useState } from 'react'
import {
  type VariantArchitecture,
  type VariantKind,
  type VariantPreparation,
  type VariantState
} from '../../../../shared/relay/variant'

export function RelayVariantsPanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [state, setState] = useState<VariantState>(),
    [kind, setKind] = useState<VariantKind>('core'),
    [architecture, setArchitecture] = useState<VariantArchitecture>('arm64'),
    [coreVersion, setCoreVersion] = useState(''),
    [modelVersion, setModelVersion] = useState(''),
    [plan, setPlan] = useState<VariantPreparation>(),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    operation = useRef(false),
    mounted = useRef(true),
    epoch = useRef(0)
  useEffect(() => {
    mounted.current = true
    const lifecycle = epoch
    return () => {
      mounted.current = false
      ++lifecycle.current
    }
  }, [])
  const locked = busy || pending || !!state?.pending
  const changed = (): void => {
    ++epoch.current
    setPlan(undefined)
    setNotice('')
  }
  const action = async (
    type: 'read' | 'prepare' | 'acquire' | 'select' | 'remove' | 'restore',
    value?: string
  ): Promise<void> => {
    if (!mounted.current || operation.current || busy) return
    const ticket = ++epoch.current,
      live = (): boolean => mounted.current && ticket === epoch.current
    const check = (): void => {
      if (!live()) throw new Error('页面或选择已变化。')
    }
    operation.current = true
    setPending(true)
    onBusy(true)
    if (type !== 'acquire') setPlan(undefined)
    try {
      if (type === 'read') {
        const next = (await window.electron.ipcRenderer.invoke('relayVariantState')) as VariantState
        check()
        setState(next)
        setCoreVersion(next.trustedCoreVersion)
        setModelVersion(next.trustedSmartImports[0]?.version ?? '')
        if (next.hostArchitecture) setArchitecture(next.hostArchitecture)
        setNotice('已读取私有资源及可信核心清单。')
      } else if (type === 'prepare') {
        const metadata =
          kind === 'core'
            ? state?.trustedCoreImports.find(
                (item) => item.architecture === architecture && item.version === coreVersion
              )
            : state?.trustedSmartImports.find((item) => item.version === modelVersion)
        if (!metadata) throw new Error('请先读取可信清单。')
        const next = (await window.electron.ipcRenderer.invoke('relayVariantPrepare', metadata)) as
          VariantPreparation | undefined
        check()
        setPlan(next)
        if (next) {
          const result = await window.electron.ipcRenderer.invoke('relayVariantExecute')
          check()
          setPlan(undefined)
          const latest = (await window.electron.ipcRenderer.invoke(
            'relayVariantState'
          )) as VariantState
          check()
          setState(latest)
          if (
            result &&
            typeof result === 'object' &&
            'status' in result &&
            result.status === 'cancelled'
          ) {
            setNotice('已取消本次操作。')
            return
          }
          setNotice('资源已导入，未更改活动核心选择。')
        } else setNotice('已取消文件选择。')
      } else {
        setPlan(undefined)
        const result =
          type === 'acquire'
            ? await window.electron.ipcRenderer.invoke('relayVariantExecute')
            : type === 'select'
              ? await window.electron.ipcRenderer.invoke('relayVariantSelect', { id: value })
              : type === 'remove'
                ? await window.electron.ipcRenderer.invoke('relayVariantRemove', { id: value })
                : await window.electron.ipcRenderer.invoke('relayVariantRestore', { kind: value })
        check()
        const latest = (await window.electron.ipcRenderer.invoke(
          'relayVariantState'
        )) as VariantState
        check()
        setState(latest)
        setNotice(
          result &&
            typeof result === 'object' &&
            'status' in result &&
            result.status === 'cancelled'
            ? '已取消本次操作。'
            : type === 'select'
              ? '已复验并保存选择；核心将在下次明确启动时使用，仅固定可信Smart模型可随Smart核心加载。'
              : type === 'restore'
                ? '已恢复默认选择；没有重启核心。'
                : '私有资源操作完成。'
        )
      }
    } catch {
      if (!live()) return
      setPlan(undefined)
      setNotice('操作未完成。请检查文件、摘要、大小、架构及自有实例状态；未自动重试或切换核心。')
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  return (
    <section className="relay-panel">
      <h2>核心与Smart资源</h2>
      <p>
        从文件选择窗口导入到Relay私有目录，按预期摘要和大小复验。核心只接受可信清单中的版本；选择在下次明确启动时使用。
      </p>
      <div className="relay-action">
        <button disabled={locked} onClick={() => void action('read')}>
          读取资源与可信清单
        </button>
        <button
          disabled={locked || !state?.activeCoreId}
          onClick={() => void action('restore', 'core')}
        >
          恢复固定默认核心
        </button>
        <button
          disabled={locked || !state?.activeSmartId}
          onClick={() => void action('restore', 'smart')}
        >
          清除Smart资源偏好
        </button>
      </div>
      <label>
        资源类型
        <select
          value={kind}
          disabled={locked}
          onChange={(event) => {
            setKind(event.target.value as VariantKind)
            changed()
          }}
        >
          <option value="core">可信核心副本</option>
          <option value="smart">Smart模型资源</option>
        </select>
      </label>
      {kind === 'core' ? (
        <>
          <label>
            可信核心版本
            <select
              value={coreVersion}
              disabled={locked || !state}
              onChange={(event) => {
                setCoreVersion(event.target.value)
                changed()
              }}
            >
              {!state && <option value="">请先读取可信清单</option>}
              {[...new Set(state?.trustedCoreImports.map((item) => item.version))].map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            架构
            <select
              value={architecture}
              disabled={locked}
              onChange={(event) => {
                setArchitecture(event.target.value as VariantArchitecture)
                changed()
              }}
            >
              <option value="arm64">Apple Silicon</option>
              <option value="x64">Intel</option>
            </select>
          </label>
        </>
      ) : (
        <label>
          可信模型版本
          <select
            value={modelVersion}
            disabled={locked || !state}
            onChange={(event) => {
              setModelVersion(event.target.value)
              changed()
            }}
          >
            {!state && <option value="">请先读取可信清单</option>}
            {state?.trustedSmartImports.map((item) => (
              <option key={item.version} value={item.version}>
                {item.version} · {(item.size / 1048576).toFixed(1)} MiB
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="relay-action">
        <button
          disabled={locked || !state || (kind === 'smart' && !modelVersion)}
          onClick={() => void action('prepare')}
        >
          导入资源文件…
        </button>
      </div>
      {plan && (
        <p>
          待导入：{plan.kind} · {plan.version} · {plan.size}字节 · SHA256 {plan.sha256}
          。导入不会自动启用。
        </p>
      )}
      {state && (
        <p>
          固定默认核心：{state.trustedCoreVersion}
          。可导入版本：
          {[...new Set(state.trustedCoreImports.map((item) => item.version))].join('、')}。
          各版本仅接受清单中对应架构的文件。联网获取请使用“可信资源获取与更新候选”，校验后再导入并选择。
        </p>
      )}
      <p>
        使用Smart前，先导入并选择固定可信模型，再导入并选择Smart核心。核心与模型在下次明确启动时复验，运行中的实例不会自动切换。prefer-asn需通过完整配置检查，绑定已校验的ASN资源后再准备运行。
      </p>
      {state?.records.map((record) => (
        <div className="relay-artifact" key={record.id}>
          <strong>
            {record.kind} · {record.version} · {record.architecture ?? '模型'}
          </strong>
          <p>
            {record.size}字节 · SHA256 {record.sha256}
          </p>
          <p>
            {state.activeCoreId === record.id
              ? '已选择，下次启动复验后使用'
              : state.activeSmartId === record.id
                ? '已保存模型偏好；仅固定可信模型可随Smart核心在下次启动加载'
                : '未选择'}
          </p>
          <div className="relay-action">
            <button
              disabled={
                locked ||
                state.activeCoreId === record.id ||
                state.activeSmartId === record.id ||
                (record.kind === 'core' && record.architecture !== state.hostArchitecture)
              }
              onClick={() => void action('select', record.id)}
            >
              {record.kind === 'core' ? '复验并选择核心…' : '复验并保存模型偏好…'}
            </button>
            <button disabled={locked} onClick={() => void action('remove', record.id)}>
              移除私有副本…
            </button>
          </div>
        </div>
      ))}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
