import { useEffect, useRef, useState } from 'react'
import type {
  RelayBackupAccount,
  RelayBackupAccountInventory
} from '../../../../shared/relay/backup-accounts'
import type {
  RelayRuntimeGistSyncState,
  RuntimeGistSyncSnapshotInfo
} from '../../../../shared/relay/runtime-gist-sync'
import type { RelayRuntimeGistSource } from '../../../../shared/relay/runtime-gist'
import { RelayRuntimeGistSourcePicker } from './runtime-gist-source'

const statusLabel = (status?: string): string => {
  const labels: Record<string, string> = {
    idle: '尚未授权',
    authorizing: '等待原生授权',
    waiting: '等待配置变化',
    capturing: '正在捕获当前运行配置',
    preparing: '正在准备本轮上传',
    uploading: '正在上传并读回确认',
    stopping: '正在撤销授权并等待在途操作',
    armed: '本次会话已授权',
    uploaded: '已上传并读回确认',
    unchanged: '正文未变化',
    superseded: '已由较新配置替代',
    cancelled: '已取消',
    conflict: '远端内容冲突，已停止',
    uncertain: '写入结果未确认，不自动重试',
    failed: '操作未完成，已停止',
    stopped: '已停止',
    suspended: '挂起后已停止',
    hidden: '关窗后已停止',
    rendererChanged: '页面变更后已停止',
    restored: '恢复资料后已停止',
    quitting: '退出时已停止',
    accountChanged: '账号修订变化后已停止',
    ownerChanged: '运行实例或代理端口变化后已停止',
    credentials: '凭据不可用，已停止'
  }
  return status ? (labels[status] ?? '未知状态，请重新核对') : '尚无结果'
}
const timeLabel = (time: number): string => new Date(time).toLocaleString()
function Capture({
  title,
  source
}: {
  title: string
  source: RuntimeGistSyncSnapshotInfo
}): React.JSX.Element {
  return (
    <div>
      <h3>{title}</h3>
      <p>源配置修订：{source.revision}</p>
      <p>配置正文SHA256：{source.configurationSHA256}</p>
      <p>
        正文大小：{source.bytes}字节 · 捕获时间：{timeLabel(source.capturedAt)}
      </p>
    </div>
  )
}

export function RelayRuntimeGistSyncPanel({
  busy,
  tunSessionId,
  onBusy
}: {
  busy: boolean
  tunSessionId?: string
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [runtimeSource, setRuntimeSource] = useState<RelayRuntimeGistSource>(),
    [accounts, setAccounts] = useState<RelayBackupAccount[]>(),
    [incomplete, setIncomplete] = useState(0),
    [selected, setSelected] = useState(''),
    [gistId, setGistId] = useState(''),
    [snapshot, setSnapshot] = useState<RelayRuntimeGistSyncState>(),
    [readAt, setReadAt] = useState(''),
    [pending, setPending] = useState(false),
    [stopping, setStopping] = useState(false),
    [notice, setNotice] = useState(''),
    operation = useRef(false),
    stoppingRef = useRef(false),
    ownedOperations = useRef(0),
    viewEpoch = useRef(0)
  const account = accounts?.find((item) => item.id === selected),
    sourceUnavailable =
      runtimeSource?.kind === 'tun-managed' && runtimeSource.sessionId !== tunSessionId,
    locked = busy || pending || stopping,
    contextLocked = locked || !!snapshot?.enabled || !!snapshot?.pending,
    caughtUp =
      snapshot?.enabled &&
      !snapshot.pending &&
      !snapshot.dirty &&
      !snapshot.uploading &&
      snapshot.latestCaptured &&
      snapshot.latestCaptured.configurationSHA256 ===
        snapshot.lastUploaded?.source.configurationSHA256
  useEffect(
    () =>
      window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', () => {
        viewEpoch.current++
        setSnapshot(undefined)
        setReadAt('')
        setAccounts(undefined)
        setSelected('')
        setGistId('')
        setIncomplete(0)
        setNotice('会话自动同步授权已撤销，请重新读取公开账号与状态。')
      }),
    []
  )
  const takeBusy = (): boolean => {
    if (!ownedOperations.current && busy) return false
    if (!ownedOperations.current) onBusy(true)
    ownedOperations.current++
    return true
  }
  const releaseBusy = (owned: boolean): void => {
    if (owned && --ownedOperations.current === 0) onBusy(false)
  }
  const remember = (state: RelayRuntimeGistSyncState, at = new Date().toISOString()): void => {
    setSnapshot(state)
    setReadAt(at)
  }
  const run = async (action: 'read' | 'arm'): Promise<void> => {
    if (
      operation.current ||
      locked ||
      (action === 'arm' &&
        (!account || sourceUnavailable || snapshot?.enabled || snapshot?.pending))
    )
      return
    if (action === 'arm' && !/^[a-f0-9]{5,64}$/u.test(gistId)) {
      setNotice('请输入5至64位小写十六进制的现有专用Gist ID，不接受URL或新建。')
      return
    }
    operation.current = true
    setPending(true)
    const owned = takeBusy(),
      ticket = ++viewEpoch.current
    setNotice(action === 'read' ? '正在读取公开账号与本机同步快照…' : '正在开启本次会话同步…')
    try {
      if (action === 'read') {
        const [inventoryResult, stateResult] = await Promise.allSettled([
          window.electron.ipcRenderer.invoke(
            'relayBackupAccountList'
          ) as Promise<RelayBackupAccountInventory>,
          (
            window.electron.ipcRenderer.invoke(
              'relayRuntimeGistSyncState'
            ) as Promise<RelayRuntimeGistSyncState>
          ).then((state) => ({ state, at: new Date().toISOString() }))
        ])
        if (ticket !== viewEpoch.current) return
        if (inventoryResult.status === 'fulfilled') {
          const inventory = inventoryResult.value,
            eligible = inventory.accounts.filter(
              (item) => item.provider === 'gist' && item.state === 'active'
            )
          setAccounts(eligible)
          setIncomplete(inventory.incomplete)
          setSelected((current) => (eligible.some((item) => item.id === current) ? current : ''))
        } else {
          setAccounts(undefined)
          setSelected('')
          setIncomplete(0)
        }
        if (stateResult.status === 'fulfilled')
          remember(stateResult.value.state, stateResult.value.at)
        else {
          setSnapshot(undefined)
          setReadAt('')
        }
        setNotice(
          inventoryResult.status === 'fulfilled' && stateResult.status === 'fulfilled'
            ? '已读取公开账号与本机授权快照，没有解密凭据、联网或开启同步。'
            : stateResult.status === 'fulfilled'
              ? '已读取同步快照，可停止已有授权；账号公开设置未确认，请重新读取后再授权。'
              : '同步状态未确认，请重新读取；不会自动开启或重试。'
        )
      } else if (account) {
        const result = (await window.electron.ipcRenderer.invoke('relayRuntimeGistSyncArm', {
          id: account.id,
          revision: account.revision,
          gistId,
          ...(runtimeSource ? { source: runtimeSource } : {})
        })) as { status: 'armed' | 'cancelled'; state: RelayRuntimeGistSyncState }
        if (ticket !== viewEpoch.current) return
        remember(result.state)
        setNotice(
          result.status === 'armed'
            ? '本次App会话的运行配置自动同步已授权，上传进展需显式读取状态核对。'
            : '本次新授权已取消，请核对下方授权快照。'
        )
      }
    } catch {
      if (ticket !== viewEpoch.current) return
      setSnapshot(undefined)
      setReadAt('')
      setNotice('读取或授权结果未确认，请重新读取状态核对；不会自动重试或开启同步。')
    } finally {
      operation.current = false
      setPending(false)
      releaseBusy(owned)
    }
  }
  const stop = async (): Promise<void> => {
    if (stoppingRef.current) return
    stoppingRef.current = true
    setStopping(true)
    const owned = takeBusy(),
      ticket = ++viewEpoch.current
    setNotice('正在撤销本次自动同步授权，并等待其在途操作结束…')
    try {
      const state = (await window.electron.ipcRenderer.invoke(
        'relayRuntimeGistSyncStop'
      )) as RelayRuntimeGistSyncState
      if (ticket !== viewEpoch.current) return
      remember(state)
      setNotice(
        state.lastAttempt?.result === 'uncertain' || state.lastResult === 'uncertain'
          ? '自动同步授权已撤销；在途写入结果未确认，请核对远端，不会自动重试。'
          : '已撤销本次自动同步授权，并等待其在途操作结束；不停止代理核心或改变网络设置。'
      )
    } catch {
      if (ticket !== viewEpoch.current) return
      setSnapshot(undefined)
      setReadAt('')
      setNotice('停止结果未确认，请重新读取状态核对；不会自动启动或重试同步。')
    } finally {
      stoppingRef.current = false
      setStopping(false)
      releaseBusy(owned)
    }
  }
  return (
    <section className="relay-panel">
      <h2>本次会话运行配置Gist自动同步</h2>
      <p>
        默认关闭，保存账号不等于授权。点击开启后绑定账号修订、明确选择的运行实例与HTTP端口、现有专用非公开单文件Gist及AGE明密范围。支持本地代理，或显式选择支持读取的托管TUN会话；固定文件clash-party.yaml，不创建或自动发现Gist。
      </p>
      <p>
        远端更新并非原子操作，检查与写入之间存在被其他客户端并发覆盖的窗口，请使用专用Gist。挂起、关窗、退出、恢复资料、账号或运行实例变化后撤销授权，不自动恢复。普通同实例配置修订变化会合并排队，不等于已经上传。
      </p>
      <button disabled={locked} onClick={() => void run('read')}>
        读取Gist账号与自动同步状态
      </button>
      {incomplete > 0 && <p>有{incomplete}条账号记录未能确认，不会自动用于同步。</p>}
      {accounts && !accounts.length && <p>没有已保存且启用的Gist账号，请先保存账号。</p>}
      <fieldset disabled={contextLocked}>
        <RelayRuntimeGistSourcePicker
          label="自动同步配置来源"
          source={runtimeSource}
          tunSessionId={tunSessionId}
          onChange={setRuntimeSource}
        />
        <label>
          自动同步Gist账号{' '}
          <select
            aria-label="自动同步Gist账号"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">请选择已保存的Gist账号</option>
            {accounts?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {account && (
          <p>
            指定本地HTTP代理端口：{account.proxyPort} ·{' '}
            {account.recipient
              ? `AGE加密，接收者 ${account.recipient}`
              : '敏感明文运行配置（未配置AGE接收者）'}
            。公开保存设置不表示凭据当前有效；不会回填Token。
          </p>
        )}
        <label>
          现有专用Gist ID{' '}
          <input
            aria-label="现有专用Gist ID"
            value={gistId}
            placeholder="仅ID，不填URL"
            autoComplete="off"
            onChange={(event) => setGistId(event.target.value)}
          />
        </label>
        <button disabled={!account || sourceUnavailable || !gistId} onClick={() => void run('arm')}>
          授权本次会话运行配置自动同步…
        </button>
      </fieldset>
      <button disabled={stopping} onClick={() => void stop()}>
        停止本次会话自动同步
      </button>
      <p>停止只撤销此同步授权，可能已提交的写入需等待核对；不会停止代理核心或改变网络设置。</p>
      {readAt ? (
        <div>
          <p>状态读取于：{readAt}。这是读取时的本机授权快照，不证明当前登录或凭据有效。</p>
          <p>
            读取时授权：{snapshot?.enabled ? '已开启' : '已关闭'} · 阶段：
            {statusLabel(snapshot?.phase)} · 在途：{snapshot?.pending ? '是' : '否'}
          </p>
          {snapshot?.account && (
            <p>
              授权账号：{snapshot.account.name} · 修订：{snapshot.account.revision}
            </p>
          )}
          {snapshot?.target && (
            <p>
              授权目标：Gist {snapshot.target.gistId} / {snapshot.target.filename}
            </p>
          )}
          {snapshot?.owner && (
            <p>
              授权来源：
              {snapshot.owner.source?.kind === 'tun-managed'
                ? '托管TUN（已加载正文与观察mode）'
                : 'Relay本地代理'}{' '}
              · 运行实例：{snapshot.owner.instanceId} · HTTP端口：{snapshot.owner.proxyPort} ·{' '}
              {snapshot.encrypted ? 'AGE加密' : '敏感明文'}
            </p>
          )}
          {snapshot?.dirty && <p>有配置变化待捕获；尚无本轮正文SHA，不表示已上传。</p>}
          {snapshot?.latestCaptured && (
            <Capture title="最近已捕获配置" source={snapshot.latestCaptured} />
          )}
          {snapshot?.uploading && (
            <div>
              <Capture title="本轮在途配置" source={snapshot.uploading} />
              <p>
                本轮上传载荷SHA256：{snapshot.uploading.payloadSHA256} · 已提交写入：
                {snapshot.uploading.submitted ? '是' : '否'}
              </p>
            </div>
          )}
          {snapshot?.lastUploaded && (
            <div>
              <Capture title="上次已读回确认的配置" source={snapshot.lastUploaded.source} />
              <p>
                上次确认载荷SHA256：{snapshot.lastUploaded.payloadSHA256} · 确认时间：
                {timeLabel(snapshot.lastUploaded.at)}
              </p>
            </div>
          )}
          {caughtUp && <p>截至读取时，最近已捕获正文已追上上传确认；后续变化需重新读取核对。</p>}
          {snapshot?.latestCaptured && !caughtUp && <p>尚不能确认当前配置已追上上传。</p>}
          {snapshot?.lastAttempt && (
            <p>
              最近尝试：{statusLabel(snapshot.lastAttempt.result)} · 已提交写入：
              {snapshot.lastAttempt.submitted ? '是' : '否'} · {timeLabel(snapshot.lastAttempt.at)}
              {snapshot.lastAttempt.payloadSHA256 &&
                ` · 尝试载荷SHA256：${snapshot.lastAttempt.payloadSHA256}`}
            </p>
          )}
          <p>
            最近结果：{statusLabel(snapshot?.lastResult)}
            {snapshot?.stopReason && ` · 撤权原因：${statusLabel(snapshot.stopReason)}`}
          </p>
        </div>
      ) : (
        <p>尚未读取状态；初始渲染不会自动联网、解密凭据或开启同步。</p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
