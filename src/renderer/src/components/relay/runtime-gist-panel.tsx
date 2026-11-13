import { useEffect, useRef, useState } from 'react'
import type {
  RelayRuntimeGistPlan,
  RelayRuntimeGistRequest,
  RelayRuntimeGistSource,
  RelayRuntimeGistResult
} from '../../../../shared/relay/runtime-gist'
import { RelayRuntimeGistSourcePicker } from './runtime-gist-source'

export function runtimeGistResultMessage(result: RelayRuntimeGistResult): string {
  return result.status === 'uploaded'
    ? '运行配置副本已上传并核对；当前运行配置未更改。'
    : result.status === 'uncertain'
      ? '上传结果未确认，目标可能已经写入。请先核对远端，不能自动重试。'
      : '本次上传已取消。'
}

export function RelayRuntimeGistPanel({
  busy,
  onBusy,
  tunSessionId,
  externalPreparation
}: {
  busy: boolean
  tunSessionId?: string
  onBusy(value: boolean): void
  externalPreparation?: { plan?: RelayRuntimeGistPlan; result?: RelayRuntimeGistResult }
}): React.JSX.Element {
  const [runtimeSource, setRuntimeSource] = useState<RelayRuntimeGistSource>(),
    [token, setToken] = useState(''),
    [proxyPort, setProxyPort] = useState('17891'),
    [gistId, setGistId] = useState(''),
    [recipient, setRecipient] = useState('')
  const [plan, setPlan] = useState<RelayRuntimeGistPlan>(),
    [uploadedURL, setUploadedURL] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false)
  const operation = useRef(false)
  const preparationEpoch = useRef(0)
  const cancellation = useRef<Promise<unknown>>(Promise.resolve())
  const sourceUnavailable =
    runtimeSource?.kind === 'tun-managed' && runtimeSource.sessionId !== tunSessionId
  const locked = busy || pending
  useEffect(() => {
    const lifecycle = preparationEpoch
    const remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', () => {
      preparationEpoch.current++
      setPlan(undefined)
      setToken('')
      setUploadedURL('')
      setNotice('运行配置上传准备已撤销，请重新准备；在途写入仍等待真实结果。')
    })
    return () => {
      lifecycle.current++
      remove()
    }
  }, [])
  useEffect(() => {
    if (!externalPreparation) return
    preparationEpoch.current++
    setPlan(undefined)
    if (externalPreparation.plan) setRuntimeSource(externalPreparation.plan.source)
    setToken('')
    setUploadedURL(
      externalPreparation.result?.status === 'uploaded'
        ? (externalPreparation.result.url ?? '')
        : ''
    )
    setNotice(
      externalPreparation.result
        ? runtimeGistResultMessage(externalPreparation.result)
        : '账号设置或选择已变化，旧上传结果已清除。'
    )
  }, [externalPreparation])
  const invalidate = (): void => {
    preparationEpoch.current++
    setUploadedURL('')
    if (!plan) return
    setPlan(undefined)
    setNotice('输入已更改，请重新输入本次Token并准备。')
    cancellation.current = window.electron.ipcRenderer
      .invoke('relayRuntimeGistCancel')
      .catch(() => {})
  }
  const cancel = async (): Promise<void> => {
    const epoch = ++preparationEpoch.current
    setPlan(undefined)
    setToken('')
    try {
      await window.electron.ipcRenderer.invoke('relayRuntimeGistCancel')
      if (epoch === preparationEpoch.current)
        setNotice('已请求取消；已提交写入的结果需核对远端，不会自动重试。')
    } catch {
      if (epoch === preparationEpoch.current) setNotice('取消结果未确认，请先核对远端。')
    }
  }
  const action = async (): Promise<void> => {
    if (operation.current || busy || sourceUnavailable) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const epoch = preparationEpoch.current
    setUploadedURL('')
    setNotice('正在核对并上传所选运行配置…')
    try {
      setPlan(undefined)
      const request: RelayRuntimeGistRequest = {
        token,
        ...(runtimeSource ? { source: runtimeSource } : {}),
        proxyPort: Number(proxyPort),
        ...(gistId.trim() ? { gistId: gistId.trim() } : {}),
        ...(recipient.trim() ? { recipient: recipient.trim() } : {})
      }
      try {
        await cancellation.current
        if (epoch !== preparationEpoch.current) return
        const prepared = (await window.electron.ipcRenderer.invoke(
          'relayRuntimeGistPrepare',
          request
        )) as RelayRuntimeGistPlan
        if (epoch !== preparationEpoch.current) return
        setPlan(prepared)
        const result = (await window.electron.ipcRenderer.invoke('relayRuntimeGistExecute', {
          evidenceId: prepared.evidenceId
        })) as RelayRuntimeGistResult
        if (epoch === preparationEpoch.current) {
          setPlan(undefined)
          if (result.status === 'uploaded') setUploadedURL(result.url ?? '')
        }
        setNotice(runtimeGistResultMessage(result))
      } finally {
        setToken('')
      }
    } catch {
      setPlan(undefined)
      setNotice(
        '操作未确认。请核对运行实例、配置版本、Token、目标和AGE接收者；上传失败时先核对远端，不会自动重试。'
      )
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  return (
    <section className="relay-panel">
      <h2>运行配置同步到Gist</h2>
      <p>
        将明确选择的Relay运行配置保存为Gist中的clash-party.yaml。留空目标ID会创建新的非公开Gist；填写ID会更新该文件，点击上传时核对实例与目标。
      </p>
      <p>
        运行配置可能包含节点密码、订阅地址和请求头。非公开Gist仍可被持有链接者读取；填写AGE接收者可加密，留空则上传敏感明文。Token仅本次使用，准备后清空。
      </p>
      <fieldset disabled={locked} onChange={invalidate}>
        <RelayRuntimeGistSourcePicker
          label="本次运行配置来源"
          source={runtimeSource}
          tunSessionId={tunSessionId}
          onChange={setRuntimeSource}
        />
        <label>
          本次GitHub Token{' '}
          <input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <label>
          本地HTTP代理端口{' '}
          <input
            inputMode="numeric"
            value={proxyPort}
            onChange={(event) => setProxyPort(event.target.value)}
          />
        </label>
        <p>
          本次代理端口须由所选运行实例持有；TUN只支持已证明归属的HTTP/mixed端口，不会回退其他端口。
        </p>
        <label>
          目标Gist ID（留空新建）{' '}
          <input value={gistId} onChange={(event) => setGistId(event.target.value)} />
        </label>
        <label>
          AGE接收者（可选）{' '}
          <input
            autoComplete="off"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
          />
        </label>
      </fieldset>
      <button disabled={locked || sourceUnavailable || !token.trim()} onClick={() => void action()}>
        上传所选运行配置
      </button>
      {plan && (
        <div>
          <p>
            {plan.action === 'update'
              ? `将更新Gist ${plan.gistId} 中的${plan.filename}，目标文件内容会被替换。`
              : `将创建新的非公开Gist，文件名为${plan.filename}。`}
          </p>
          <p>
            {plan.encrypted ? 'AGE加密上传' : '敏感明文上传'} · 配置 {plan.configurationBytes}字节 ·
            上传 {plan.payloadBytes}字节
          </p>
          <p>
            配置来源：
            {plan.source?.kind === 'tun-managed'
              ? `托管TUN会话 ${plan.source.sessionId}（已加载正文与观察mode）`
              : 'Relay本地代理'}
          </p>
          <p>配置SHA256：{plan.configurationSHA256}</p>
          <p>上传SHA256：{plan.payloadSHA256}</p>
          <p>通过本次本地代理端口 {plan.proxyPort} 上传；运行实例或配置版本变化后需要重新准备。</p>
        </div>
      )}
      <button disabled={(!pending && busy) || (!plan && !pending)} onClick={() => void cancel()}>
        取消本次上传
      </button>
      {uploadedURL && (
        <label>
          已核对的Gist地址（可选中复制） <input readOnly value={uploadedURL} />
        </label>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
