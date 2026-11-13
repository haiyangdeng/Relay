import { useEffect, useRef, useState } from 'react'
import type {
  RelayBackupAccount,
  RelayBackupAccountInventory
} from '../../../../shared/relay/backup-accounts'
import type {
  RelayWebdavBackupSchedule,
  RelayWebdavBackupSchedulerState,
  RelayWebdavRetentionPolicy,
  RelayWebdavRetentionState
} from '../../../../shared/relay/backup-scheduler'

const statusLabel = (status?: string): string => {
  const labels: Record<string, string> = {
    armed: '本次会话已授权',
    running: '本轮备份处理中',
    uploaded: '已上传并读回确认',
    busy: '其他操作在途，延后检查',
    credentials: '凭据不可用',
    accountChanged: '账号修订已变化',
    scopeChanged: '授权范围或时区已变化',
    failed: '操作未完成',
    uncertain: '写入结果未确认，不自动重试',
    stopped: '已停止',
    suspended: '挂起后已停止',
    restored: '恢复资料后已停止',
    noNextRun: '没有下一次时间',
    cancelled: '本次操作已取消',
    retentionUnsupported: '清理条件不满足，调度已停止',
    retentionConflict: '清理目标冲突，调度已停止',
    retentionUncertain: '删除结果未确认，调度已停止',
    retentionFailed: '清理未完成，调度已停止'
  }
  return status ? (labels[status] ?? '未知状态，需重新核对') : '尚无结果'
}
const cleanupLabel = (result?: RelayWebdavRetentionState['lastResult']): string => {
  const labels: Record<NonNullable<RelayWebdavRetentionState['lastResult']>, string> = {
    notNeeded: '最近一次清理无需删除',
    pruned: '最近一次条件清理已确认',
    unsupported: '强ETag或清理条件不足，已停止；上传确认仍按上传结果显示',
    conflict: '目标已变化或不匹配，已停止清理，可能仍超过保留数',
    uncertain: '删除结果未确认，不自动重试；上传确认仍有效',
    cancelled: '清理已取消，上传确认仍按上传结果显示',
    failed: '清理未完成，已停止；上传确认仍按上传结果显示'
  }
  return result ? labels[result] : '尚无清理结果'
}
const scheduleLabel = (schedule: RelayWebdavBackupSchedule): string =>
  schedule.kind === 'interval' ? `每${schedule.minutes}分钟` : `5段cron：${schedule.expression}`

export function RelayWebdavBackupSchedulerPanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [accounts, setAccounts] = useState<RelayBackupAccount[]>(),
    [incomplete, setIncomplete] = useState(0),
    [selected, setSelected] = useState(''),
    [kind, setKind] = useState<'interval' | 'cron'>('interval'),
    [minutes, setMinutes] = useState('60'),
    [expression, setExpression] = useState('0 * * * *'),
    [retentionEnabled, setRetentionEnabled] = useState(false),
    [retentionKind, setRetentionKind] =
      useState<RelayWebdavRetentionPolicy['kind']>('session-owned'),
    [keepCount, setKeepCount] = useState('10'),
    [snapshot, setSnapshot] = useState<RelayWebdavBackupSchedulerState>(),
    [readAt, setReadAt] = useState(''),
    [pending, setPending] = useState(false),
    [stopping, setStopping] = useState(false),
    [notice, setNotice] = useState(''),
    operation = useRef(false),
    stoppingRef = useRef(false),
    ownedOperations = useRef(0),
    viewEpoch = useRef(0)
  const account = accounts?.find((item) => item.id === selected),
    locked = busy || pending || stopping
  useEffect(
    () =>
      window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', () => {
        viewEpoch.current++
        setSnapshot(undefined)
        setReadAt('')
        setAccounts(undefined)
        setSelected('')
        setIncomplete(0)
        setRetentionEnabled(false)
        setRetentionKind('session-owned')
        setKeepCount('10')
        setNotice('定时备份准备已撤销，请重新读取账号和调度状态。')
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
  const remember = (
    state: RelayWebdavBackupSchedulerState,
    at = new Date().toISOString()
  ): void => {
    setSnapshot(state)
    setReadAt(at)
  }
  const run = async (action: 'read' | 'arm'): Promise<void> => {
    if (
      operation.current ||
      locked ||
      (action === 'arm' && (!account || snapshot?.pending || snapshot?.suspended))
    )
      return
    operation.current = true
    setPending(true)
    const owned = takeBusy(),
      ticket = ++viewEpoch.current
    setNotice(action === 'arm' ? '正在开启本次会话调度…' : '正在读取公开账号与本机调度快照…')
    try {
      if (action === 'read') {
        const [inventoryResult, stateResult] = await Promise.allSettled([
          window.electron.ipcRenderer.invoke(
            'relayBackupAccountList'
          ) as Promise<RelayBackupAccountInventory>,
          (
            window.electron.ipcRenderer.invoke(
              'relayBackupScheduleState'
            ) as Promise<RelayWebdavBackupSchedulerState>
          ).then((state) => ({ state, at: new Date().toISOString() }))
        ])
        if (ticket !== viewEpoch.current) return
        if (inventoryResult.status === 'fulfilled') {
          const inventory = inventoryResult.value,
            eligible = inventory.accounts.filter(
              (item) => item.provider === 'webdav' && item.state === 'active'
            )
          setAccounts(eligible)
          setIncomplete(inventory.incomplete)
          setSelected((current) => (eligible.some((item) => item.id === current) ? current : ''))
          if (
            !eligible.some((item) => item.id === account?.id && item.revision === account?.revision)
          ) {
            setRetentionEnabled(false)
            setRetentionKind('session-owned')
          }
        } else {
          setAccounts(undefined)
          setSelected('')
          setIncomplete(0)
          setRetentionEnabled(false)
          setRetentionKind('session-owned')
        }
        if (stateResult.status === 'fulfilled')
          remember(stateResult.value.state, stateResult.value.at)
        else {
          setSnapshot(undefined)
          setReadAt('')
        }
        setNotice(
          inventoryResult.status === 'fulfilled' && stateResult.status === 'fulfilled'
            ? '已读取公开设置与本机授权快照；没有解密凭据、联网或开启调度。'
            : stateResult.status === 'fulfilled'
              ? '已读取调度快照，可停止已有调度；账号公开设置未确认，请重新读取后再授权。'
              : '调度状态未确认，请重新读取核对；不会自动开启或重试。'
        )
      } else if (account) {
        let schedule: RelayWebdavBackupSchedule
        if (kind === 'interval') {
          const value = Number(minutes)
          if (!/^\d+$/u.test(minutes) || !Number.isInteger(value) || value < 1 || value > 35791)
            throw new Error('备份周期无效。')
          schedule = { kind: 'interval', minutes: value }
        } else {
          const value = expression.trim()
          if (
            value.length > 256 ||
            value.split(/\s+/u).length !== 5 ||
            [...value].some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
            )
          )
            throw new Error('仅支持有效5段cron。')
          schedule = { kind: 'cron', expression: value }
        }
        let retention: RelayWebdavRetentionPolicy | undefined
        if (retentionEnabled) {
          const count = Number(keepCount)
          if (!/^\d+$/u.test(keepCount) || !Number.isInteger(count) || count < 1 || count > 100)
            throw new Error('保留份数需为1至100的整数。')
          retention = { kind: retentionKind, keepCount: count }
        }
        const result = (await window.electron.ipcRenderer.invoke('relayBackupScheduleArm', {
          id: account.id,
          revision: account.revision,
          schedule,
          ...(retention ? { retention } : {})
        })) as { status: 'armed' | 'cancelled'; state: RelayWebdavBackupSchedulerState }
        if (ticket !== viewEpoch.current) return
        remember(result.state)
        setNotice(
          result.status === 'armed'
            ? '本次App会话的定时备份已授权，下一次时间见读取快照；尚未立即上传。'
            : '已取消本次新授权，未新增调度；请核对下方已有调度快照。'
        )
      }
    } catch {
      if (ticket !== viewEpoch.current) return
      setSnapshot(undefined)
      setReadAt('')
      setNotice(
        '读取或授权结果未确认，请核对周期、保留份数并重新读取状态；不会自动重试或开启备份。'
      )
    } finally {
      operation.current = false
      setPending(false)
      releaseBusy(owned)
    }
  }
  const stop = async (id: string): Promise<void> => {
    if (stoppingRef.current) return
    stoppingRef.current = true
    setStopping(true)
    const owned = takeBusy(),
      ticket = ++viewEpoch.current
    setNotice('正在撤销此账号的定时备份授权，并等待其在途操作结束…')
    try {
      const state = (await window.electron.ipcRenderer.invoke('relayBackupScheduleStop', {
        id
      })) as RelayWebdavBackupSchedulerState
      if (ticket !== viewEpoch.current) return
      remember(state)
      const entry = state.entries.find((item) => item.id === id)
      setNotice(
        entry?.retention?.lastResult === 'uncertain'
          ? '此账号定时备份授权已撤销；清理删除结果未确认，请核对远端，不自动重试。已确认上传结果仍按快照显示。'
          : entry?.lastResult === 'uncertain'
            ? '此账号定时备份授权已撤销；在途写入结果未确认，请核对远端，不会自动重试。'
            : '已撤销此账号的本次定时备份授权，并等待其在途操作结束；其他调度按快照显示。'
      )
    } catch {
      if (ticket !== viewEpoch.current) return
      setSnapshot(undefined)
      setReadAt('')
      setNotice('停止结果未确认，请重新读取状态核对；不会启动核心或改变系统网络设置。')
    } finally {
      stoppingRef.current = false
      setStopping(false)
      releaseBusy(owned)
    }
  }
  return (
    <section className="relay-panel">
      <h2>本次会话WebDAV定时备份</h2>
      <p>
        调度默认关闭。保存账号不等于授权；点击开启后应用当前设置。仅在本App会话中，按核对的账号修订、HTTPS目录、代理端口、周期、时区和AGE明密范围新建.json备份，不覆盖已有文件。
      </p>
      <p>
        挂起、关窗、退出、账号停用或恢复资料后停止，不自动恢复授权。本入口不创建远端目录，也不执行Gist自动同步。
      </p>
      <p>
        保留清理默认关闭。可选择仅本次授权后的上传回执，或本机持久保存的已确认上传记录。目标保留相应可追踪文件中的最近K份，不是整个目录总共K份；冲突或结果未确认时，文件可能仍多于K份。
      </p>
      <button disabled={locked} onClick={() => void run('read')}>
        读取WebDAV账号与定时备份状态
      </button>
      {incomplete > 0 && <p>有{incomplete}条账号记录未能确认，不会自动用于备份。</p>}
      {accounts && !accounts.length && (
        <p>没有已保存且启用的WebDAV账号；请先保存账号。本入口不使用Gist账号。</p>
      )}
      <fieldset disabled={locked}>
        <label>
          本次定时备份账号{' '}
          <select
            aria-label="本次定时备份账号"
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value)
              setRetentionEnabled(false)
              setRetentionKind('session-owned')
            }}
          >
            <option value="">请选择已保存的WebDAV账号</option>
            {accounts?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {account && (
          <p>
            所选目录：{account.directoryURL} · 用户名：{account.username} · 指定本地HTTP代理端口{' '}
            {account.proxyPort} ·{' '}
            {account.recipient
              ? `AGE加密，接收者 ${account.recipient}`
              : '敏感明文备份（未配置AGE接收者）'}
            。这些是公开保存设置，不表示凭据当前有效。
          </p>
        )}
        <label>
          定时备份周期类型{' '}
          <select
            aria-label="定时备份周期类型"
            value={kind}
            onChange={(event) => setKind(event.target.value as 'interval' | 'cron')}
          >
            <option value="interval">间隔分钟</option>
            <option value="cron">5段cron</option>
          </select>
        </label>
        {kind === 'interval' ? (
          <label>
            备份间隔（分钟，1–35791）{' '}
            <input
              type="number"
              min="1"
              max="35791"
              step="1"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
            />
          </label>
        ) : (
          <label>
            备份5段cron{' '}
            <input
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              placeholder="0 * * * *"
            />
          </label>
        )}
        <p>开启后可查看时区与下次时间；不会立即上传，等待下一次计划时间。</p>
        <label>
          <input
            type="checkbox"
            checked={retentionEnabled}
            onChange={(event) => setRetentionEnabled(event.target.checked)}
          />{' '}
          启用已确认上传文件的保留清理（默认关闭）
        </label>
        <label>
          保留清理回执范围{' '}
          <select
            aria-label="保留清理回执范围"
            disabled={!retentionEnabled}
            value={retentionKind}
            onChange={(event) =>
              setRetentionKind(event.target.value as RelayWebdavRetentionPolicy['kind'])
            }
          >
            <option value="session-owned">仅本次授权之后的上传</option>
            <option value="recorded-owned">本机持久已确认上传记录（跨会话）</option>
          </select>
        </label>
        {retentionKind === 'recorded-owned' ? (
          <p>
            跨会话只使用本机持久的已确认事实回执，不继承旧授权。每次开启仍需新的原生删除授权，并核对主进程读取的历史摘要与计数；页面不能输入历史回执。不会按目录前缀、旧ZIP或旧版内存记录认领文件，也不会从备份或迁移导入删除权。旧删除结果未确认的文件排除候选，永不自动重试；不确定或达到账本容量时会停止，可能仍多于K份。
          </p>
        ) : (
          <p>
            仅本次授权之后成功上传并确认强ETag与完整性回执的文件进入集合；每次重新授权重新建立回执集合，不继承旧授权文件。旧会话和目录中其他文件不纳入此清理。
          </p>
        )}
        <label>
          本次授权保留份数（1–100）{' '}
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            disabled={!retentionEnabled}
            value={keepCount}
            onChange={(event) => setKeepCount(event.target.value)}
          />
        </label>
        <p>
          以上是下一次授权设置。启用、关闭、更改回执范围或修改保留数均需点击授权按钮，提交新设置后生效；取消不会新增清理权限。持久回执不会自动开启调度或续期删除授权。
        </p>
      </fieldset>
      <button
        disabled={locked || !account || snapshot?.suspended || snapshot?.pending}
        onClick={() => void run('arm')}
      >
        授权本次会话定时备份…
      </button>
      <button disabled={stopping || !account} onClick={() => account && void stop(account.id)}>
        停止所选账号的本次定时备份
      </button>
      <p>
        停止只撤销本入口的备份调度与清理权限，不停止代理核心、不修改系统网络。若上传或删除已经发送，结果可能未确认；不会自动重试。
      </p>
      {snapshot && (
        <div>
          <p>状态读取于 {readAt}。以下仅为读取时的本App授权快照，不代表账号登录或凭据当前有效。</p>
          {snapshot.pending && <p>读取时有备份授权、上传或清理在途；可停止对应账号并等待收尾。</p>}
          {snapshot.suspended && <p>读取时处于挂起保护状态，恢复后也不会自动开启备份。</p>}
          {!snapshot.entries.length && <p>读取时没有本次会话调度记录。</p>}
          <ul>
            {snapshot.entries.map((entry) => (
              <li key={entry.id}>
                <h3>{entry.name}</h3>
                <p>
                  读取时授权：{entry.enabled ? '已启用' : '已停止'} ·{' '}
                  {scheduleLabel(entry.schedule)} · 时区 {entry.timeZone} ·{' '}
                  {entry.encrypted ? 'AGE加密' : '敏感明文'}。
                </p>
                <p>
                  固定目录：{entry.directoryURL} · 代理端口 {entry.proxyPort} · 最近状态：
                  {statusLabel(entry.lastStatus)}。
                </p>
                <p>
                  最近上传尝试：{entry.lastAttemptAt ?? '尚无'} · 本轮收尾：
                  {entry.lastCompletedAt ?? '尚无'} · 最近上传结果：{statusLabel(entry.lastResult)}
                  。
                </p>
                <p>下次计划时间：{entry.nextAt ?? '无'}。</p>
                {entry.lastFilename && <p>最近文件名：{entry.lastFilename}</p>}
                {entry.lastArchiveSHA256 && <p>最近备份ZIP摘要：{entry.lastArchiveSHA256}</p>}
                {entry.retention ? (
                  <div>
                    <p>
                      本次授权保留策略：
                      {entry.retention.kind === 'recorded-owned'
                        ? '本机持久已确认回执（跨会话）'
                        : '仅本授权回执集合'}
                      ，目标保留最近{entry.retention.keepCount}
                      份。 可追踪文件数：{entry.retention.ownedCount}；其中保留的最近文件数：
                      {entry.retention.protectedCount}；本次授权已确认删除数：
                      {entry.retention.deletedCount}。这些计数不代表目录总文件数。
                    </p>
                    {entry.retention.kind === 'recorded-owned' && (
                      <p>
                        账本中删除结果未确认的文件数：{entry.retention.uncertainCount ?? '未提供'}
                        ；不计入可追踪文件数或其中保留数，不作为自动删除候选，永不自动重试。这里只显示本机事实计数，不代表整个目录历史文件数。
                      </p>
                    )}
                    <p>
                      独立清理阶段：
                      {entry.retention.phase === 'checking'
                        ? '正在核对清理目标，清理在途'
                        : entry.retention.phase === 'deleting'
                          ? '条件删除及确认在途'
                          : '当前无清理在途'}
                      。 最近清理结果：{cleanupLabel(entry.retention.lastResult)}。
                    </p>
                    {entry.retention.currentFilename && (
                      <p>本轮清理目标：{entry.retention.currentFilename}</p>
                    )}
                    {entry.retention.phase === 'idle' && entry.retention.lastAttemptFilename && (
                      <p>最近清理尝试目标：{entry.retention.lastAttemptFilename}</p>
                    )}
                    {entry.retention.lastDeletedFilename && (
                      <p>
                        上次已确认删除：{entry.retention.lastDeletedFilename} ·{' '}
                        {entry.retention.lastDeletedAt ?? '确认时间未提供'}
                      </p>
                    )}
                    <p>
                      清理结果与上传结果分别记录；清理失败不会抹去已确认的上传。缺少强回执的成功上传不会登记为可删除文件。
                    </p>
                  </div>
                ) : (
                  <p>本次授权未包含保留清理，不授予删除权限。</p>
                )}
                <button
                  disabled={stopping || (!entry.enabled && !snapshot.pending)}
                  onClick={() => void stop(entry.id)}
                >
                  停止{entry.name}的本次定时备份
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!snapshot && <p>尚无已确认的调度状态，请显式读取；不会自动联网、解密凭据或开启调度。</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
