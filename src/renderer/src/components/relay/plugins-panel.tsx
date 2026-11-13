import { useEffect, useRef, useState } from 'react'
import type {
  RelayPluginPreview,
  RelayPluginRemotePreview,
  RelayPluginRecord,
  RelayPluginResult,
  RelayPluginRoute,
  RelayPluginState,
  RelayPluginSchedulerState
} from '../../../../shared/relay/plugins'

export function RelayPluginsPanel({
  busy,
  onBusy,
  onSaved
}: {
  busy: boolean
  onBusy(value: boolean): void
  onSaved?(): void | Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState(''),
    [sourceURL, setSourceURL] = useState(''),
    [route, setRoute] = useState<RelayPluginRoute>('proxy'),
    [plan, setPlan] = useState<RelayPluginPreview>(),
    [report, setReport] = useState<RelayPluginState>(),
    [schedules, setSchedules] = useState<RelayPluginSchedulerState>(),
    [minutes, setMinutes] = useState('60'),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    [openedPending, setOpenedPending] = useState(false),
    operation = useRef(false),
    openedEpoch = useRef(0)
  useEffect(() => {
    let active = true
    const unsubscribe = window.electron.ipcRenderer.on('openPluginFile', (_event, value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        !('pending' in value) ||
        typeof value.pending !== 'boolean'
      )
        return
      openedEpoch.current++
      setOpenedPending(value.pending)
      if (value.pending)
        setNotice('已收到系统打开的CPX。点击读取待处理CPX填入草稿，当前输入已保留。')
    })
    const epoch = ++openedEpoch.current
    void window.electron.ipcRenderer
      .invoke('relayPluginOpenedPending')
      .then((value) => {
        if (active && openedEpoch.current === epoch) setOpenedPending(value === true)
      })
      .catch(() => {
        /* A failed memory-status read does not grant file access. */
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  const read = async (): Promise<void> => {
    const [records, schedule] = await Promise.all([
      window.electron.ipcRenderer.invoke('relayPluginState'),
      window.electron.ipcRenderer.invoke('relayPluginScheduleState')
    ])
    setReport(records as RelayPluginState)
    setSchedules(schedule as RelayPluginSchedulerState)
  }
  const run = async (
    action:
      | 'read'
      | 'preview'
      | 'preview-remote'
      | 'preview-file'
      | 'preview-opened'
      | 'install'
      | 'login'
      | 'update'
      | 'rediscover'
      | 'remove'
      | 'save-profile',
    record?: RelayPluginRecord,
    localOnly = false
  ): Promise<void> => {
    if (busy || operation.current) return
    operation.current = true
    setPending(true)
    onBusy(true)
    setNotice('等待本次插件操作；可取消登录或网络等待。')
    try {
      if (action === 'preview-remote' || action === 'preview-file' || action === 'preview-opened') {
        const result = (await (action === 'preview-opened'
          ? window.electron.ipcRenderer.invoke('relayPluginPreviewOpened')
          : action === 'preview-file'
            ? window.electron.ipcRenderer.invoke('relayPluginPreviewFile')
            : window.electron.ipcRenderer.invoke('relayPluginPreview', {
                url: sourceURL,
                route
              }))) as RelayPluginRemotePreview
        if (result.status === 'preview') {
          setText(result.text)
          setPlan(result.preview)
          setNotice('公开描述已读取并校验，仅填入草稿；点击安装后保存插件，后续网关需单独开启。')
        } else setNotice('描述读取已取消，当前草稿保留。')
      } else if (action === 'preview') {
        setPlan(
          (await window.electron.ipcRenderer.invoke(
            'relayPluginPreview',
            text
          )) as RelayPluginPreview
        )
        setNotice('描述文件已校验，尚未安装、联网或保存凭据。')
      } else if (action === 'read') {
        await read()
        setNotice('已读取插件公开记录；未解密或发送凭据。')
      } else {
        const result = (await (action === 'install'
          ? window.electron.ipcRenderer.invoke('relayPluginInstall', { text, route })
          : action === 'remove'
            ? window.electron.ipcRenderer.invoke('relayPluginRemove', { id: record?.id, localOnly })
            : window.electron.ipcRenderer.invoke(
                action === 'rediscover'
                  ? 'relayPluginRediscover'
                  : action === 'login'
                    ? 'relayPluginLogin'
                    : action === 'update'
                      ? 'relayPluginUpdate'
                      : 'relayPluginSaveProfile',
                record?.id
              ))) as RelayPluginResult
        await read()
        if (result.status === 'saved-profile') await onSaved?.()
        setNotice(
          result.status === 'cancelled'
            ? '本次操作已取消。'
            : result.status === 'saved-profile'
              ? '已保存独立Clash配置副本；尚未启用，也未重载核心。'
              : result.status === 'removed'
                ? '已移除插件私有记录、凭据与订阅；此前另存的配置副本独立保留。'
                : result.status === 'installed'
                  ? '插件已安装，尚未登录或联网。'
                  : result.status === 'rediscovered'
                    ? '网关已重新发现，已核对新增来源权限；未解密凭据、登录、更新订阅或启用配置。'
                    : '插件订阅已保存到私有目录，尚未启用。'
        )
      }
    } catch {
      if (
        action === 'preview' ||
        action === 'preview-remote' ||
        action === 'preview-file' ||
        action === 'preview-opened'
      )
        setPlan(undefined)
      setReport(undefined)
      setSchedules(undefined)
      setNotice('插件操作未确认；请重新读取记录。旧订阅和已有凭据不会因网络失败自动删除。')
      try {
        await read()
      } catch {
        /* Unknown storage state remains unknown. */
      }
    } finally {
      if (action === 'preview-opened') {
        const epoch = ++openedEpoch.current
        try {
          const value = await window.electron.ipcRenderer.invoke('relayPluginOpenedPending')
          if (openedEpoch.current === epoch) setOpenedPending(value === true)
        } catch {
          /* A newer OS notification remains authoritative. */
        }
      }
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const schedule = async (record: RelayPluginRecord, enable: boolean): Promise<void> => {
    if (busy || operation.current) return
    operation.current = true
    setPending(true)
    onBusy(true)
    setNotice('等待本次运行的调度授权核对。')
    try {
      if (enable) {
        const value = Number(minutes)
        if (!/^\d+$/u.test(minutes) || !Number.isInteger(value) || value < 1 || value > 34560)
          throw new Error('更新周期无效。')
        const result = (await window.electron.ipcRenderer.invoke('relayPluginScheduleArm', {
          id: record.id,
          minutes: value
        })) as { status: 'armed' | 'cancelled'; state: RelayPluginSchedulerState }
        setSchedules(result.state)
        setNotice(
          result.status === 'armed'
            ? '本次运行已授权调度，至少等待一个完整周期后更新；不会自动登录或启用配置。'
            : '本次调度授权已取消。'
        )
      } else {
        setSchedules(
          (await window.electron.ipcRenderer.invoke('relayPluginScheduleDisarm', {
            id: record.id
          })) as RelayPluginSchedulerState
        )
        setNotice('已撤销本次调度授权，并等待在途操作结束。')
      }
    } catch {
      setSchedules(undefined)
      setNotice('调度操作未确认；请重新读取记录核对。')
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const cancel = async (): Promise<void> => {
    try {
      await window.electron.ipcRenderer.invoke('relayPluginCancel')
      setNotice('已请求取消；等待临时登录回调关闭和在途保存结束。')
    } catch {
      setNotice('取消未确认，请保留窗口并等待本次操作结果。')
    }
  }
  // State is a manual snapshot; it must not permanently lock refresh or revocation.
  const locked = busy || pending
  return (
    <section className="relay-panel relay-profiles">
      <h2>插件与订阅授权</h2>
      <p>
        导入服务商提供的CPX
        v2描述文件。安装只保存公开信息；登录、发现网关、注册设备及取回订阅分别核对权限。设备私钥只使用系统加密保存。
        可手动重新发现网关，保留旧订阅；新增来源需要再次授权。
      </p>
      <fieldset disabled={locked}>
        <button disabled={locked || !openedPending} onClick={() => void run('preview-opened')}>
          读取待处理CPX
        </button>
        <button disabled={locked} onClick={() => void run('preview-file')}>
          选择本地CPX描述文件…
        </button>
        <label>
          公开CPX描述HTTPS地址
          <input
            aria-label="公开CPX描述HTTPS地址"
            value={sourceURL}
            maxLength={4096}
            onChange={(event) => setSourceURL(event.target.value)}
            placeholder="https://provider.example/plugin.cpx"
          />
        </label>
        <button disabled={locked || !sourceURL.trim()} onClick={() => void run('preview-remote')}>
          读取公开描述…
        </button>
        <label>
          CPX描述文件内容
          <textarea
            rows={5}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setPlan(undefined)
            }}
            placeholder="粘贴.cpx文件中的JSON公开描述"
          />
        </label>
        <label>
          插件网络路由
          <select
            value={route}
            onChange={(event) => setRoute(event.target.value as RelayPluginRoute)}
          >
            <option value="proxy">仅本次Relay代理</option>
            <option value="direct">仅直连</option>
            <option value="auto">自动：直连优先，按安全条件尝试Relay代理</option>
          </select>
        </label>
        <p>
          代理路由只使用已验证的自有回环入口，不会自动启动核心；只有明确未发送的连接失败可改路，可能已发送的授权码请求不跨路由自动重放。
        </p>
      </fieldset>
      <div className="relay-action">
        <button disabled={locked || !text.trim()} onClick={() => void run('preview')}>
          校验描述文件
        </button>
        <button disabled={locked || !text.trim()} onClick={() => void run('install')}>
          安装插件
        </button>
        <button disabled={locked} onClick={() => void run('read')}>
          读取插件记录
        </button>
        <button disabled={!pending} onClick={() => void cancel()}>
          取消本次插件操作
        </button>
      </div>
      <label>
        本次运行自动更新周期（分钟，1–34560）
        <input
          type="number"
          min="1"
          max="34560"
          step="1"
          value={minutes}
          disabled={locked}
          onChange={(event) => setMinutes(event.target.value)}
        />
      </label>
      <p>
        调度默认关闭。授权绑定当前插件路由、来源与发现记录；修改、凭据失效、挂起、退出或备份恢复后停止，需重新确认。失败保留旧订阅并退避。
      </p>
      {(report?.pending || schedules?.pending) && (
        <p>读取时有插件操作在途，可稍后重新读取或撤销调度。</p>
      )}
      {plan && (
        <p>
          服务商：{plan.descriptor.provider.name} · 登录来源：{plan.origins.join('、')} ·
          描述SHA256：{plan.sha256}
        </p>
      )}
      {!report && <p>尚无有效插件状态；不会自动登录或更新。</p>}
      {report && !report.records.length && <p>尚未安装插件。</p>}
      {report?.records.map((record) => (
        <div key={record.id}>
          <h3>{record.descriptor.provider.name}</h3>
          <p>
            状态：{record.status} · 路由：{record.route} · 已授权来源：
            {record.approvedOrigins.join('、')}
          </p>
          {record.status === 'uncertain' && (
            <p>设备注册结果未确认；密钥已保留，下次登录先检查已有设备，不自动重放授权码。</p>
          )}
          <p>
            {record.subscription
              ? `已保存订阅：${record.subscription.size}字节 · SHA256 ${record.subscription.sha256}`
              : '尚未保存订阅'}
          </p>
          {record.lastError && <p>最近失败类别：{record.lastError}；请核对后手动重试。</p>}
          {schedules?.entries
            .filter((entry) => entry.id === record.id)
            .map((entry) => (
              <p key={entry.id}>
                本次调度：{entry.enabled ? '已授权' : '已停止'} · 周期{entry.minutes}分钟 · 最近结果
                {entry.lastStatus ?? '待运行'} · 失败{entry.failureCount}次
                {entry.nextAt ? ` · 下次 ${entry.nextAt}` : ''}
              </p>
            ))}
          <div className="relay-action">
            <button
              disabled={locked || record.status !== 'active' || !record.subscription}
              onClick={() => void schedule(record, true)}
            >
              授权本次运行自动更新
            </button>
            <button
              disabled={
                locked ||
                !schedules?.entries.some((entry) => entry.id === record.id && entry.enabled)
              }
              onClick={() => void schedule(record, false)}
            >
              撤销本次调度授权
            </button>
            <button disabled={locked} onClick={() => void run('login', record)}>
              登录／恢复授权
            </button>
            <button disabled={locked} onClick={() => void run('rediscover', record)}>
              重新发现网关…
            </button>
            <button
              disabled={locked || record.status === 'needs-reauth'}
              onClick={() => void run('update', record)}
            >
              手动更新订阅
            </button>
            <button
              disabled={locked || !record.subscription}
              onClick={() => void run('save-profile', record)}
            >
              另存为Relay配置副本
            </button>
            <button disabled={locked} onClick={() => void run('remove', record)}>
              撤销设备并移除插件
            </button>
            <button disabled={locked} onClick={() => void run('remove', record, true)}>
              仅移除本地插件
            </button>
          </div>
        </div>
      ))}
      {report?.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      <p>
        仅移除本地插件不会撤销服务商端设备；移除前另行确认。调度状态需手动读取，不会在打开面板时联网或恢复旧授权。
      </p>
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
