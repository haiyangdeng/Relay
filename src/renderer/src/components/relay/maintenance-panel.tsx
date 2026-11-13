import { useEffect, useRef, useState } from 'react'
import {
  readMaintenancePlan,
  readMaintenanceState,
  maintenanceObject,
  type RelayMaintenancePlan,
  type RelayMaintenanceState,
  type RelayMaintenanceAction
} from '../../../../shared/relay/maintenance'
const actions: { action: RelayMaintenanceAction; label: string }[] = [
  { action: 'reset-interface', label: '重置界面与导航偏好…' },
  { action: 'restore-interface', label: '恢复最近一次界面偏好…' },
  { action: 'clear-renderer-cache', label: '清理本界面资源缓存…' },
  { action: 'export-heap', label: '导出Main堆快照…' }
]
export function RelayMaintenancePanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [state, setState] = useState<RelayMaintenanceState>(),
    [plan, setPlan] = useState<RelayMaintenancePlan>(),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    active = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true)
  useEffect(() => {
    const lifecycle = epoch,
      presence = mounted
    presence.current = true
    return () => {
      presence.current = false
      ++lifecycle.current
    }
  }, [])
  const run = async (action: 'state' | 'reveal' | RelayMaintenanceAction): Promise<void> => {
    if (active.current || busy) return
    active.current = true
    setPending(true)
    onBusy(true)
    const generation = ++epoch.current
    setPlan(undefined)
    try {
      let message = ''
      if (action === 'state') message = '已读取本地维护记录，没有清理或导出。'
      else if (action === 'reveal') {
        await window.electron.ipcRenderer.invoke('relayMaintenanceRevealHeap')
        message = '目录请求已结束。'
      } else {
        const selected = readMaintenancePlan(
          await window.electron.ipcRenderer.invoke('relayMaintenancePrepare', action)
        )
        if (epoch.current !== generation) return
        if (selected.action !== action) throw new Error('维护类型不符。')
        setPlan(selected)
        const raw = await window.electron.ipcRenderer.invoke('relayMaintenanceExecute', {
          evidenceId: selected.evidenceId
        })
        if (
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          !('status' in raw) ||
          typeof raw.status !== 'string'
        )
          throw new Error('维护回执未知。')
        const expected =
          selected.action === 'reset-interface'
            ? 'reset'
            : selected.action === 'restore-interface'
              ? 'restored'
              : selected.action === 'clear-renderer-cache'
                ? 'cleared'
                : 'exported'
        if (raw.status === 'cancelled') message = '已取消本次维护。'
        else if (raw.status !== expected) throw new Error('维护回执未知。')
        else if (raw.status === 'exported') {
          const result = maintenanceObject(raw, ['status', 'export']),
            item = maintenanceObject(result.export, [
              'id',
              'fileName',
              'bytes',
              'sha256',
              'containsSecrets'
            ])
          if (
            typeof item.fileName !== 'string' ||
            !/^Relay-main-[a-f0-9-]{36}\.heapsnapshot$/u.test(item.fileName) ||
            !Number.isSafeInteger(item.bytes) ||
            Number(item.bytes) < 1 ||
            typeof item.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(item.sha256) ||
            item.containsSecrets !== true
          )
            throw new Error('堆快照回执未知。')
          message = `已保存 ${item.fileName}（${item.bytes}字节，SHA256 ${item.sha256}）。文件可能包含秘密，请谨慎提供。`
        } else
          message =
            raw.status === 'reset'
              ? '界面偏好已重置，原值备份保留，可单独恢复。'
              : raw.status === 'restored'
                ? '已恢复备份中的原界面偏好值。'
                : '本Relay界面的资源缓存已清理；cookies、本地存储和配置保留。'
      }
      if (epoch.current !== generation) return
      const next = readMaintenanceState(
        await window.electron.ipcRenderer.invoke('relayMaintenanceState')
      )
      if (epoch.current === generation) {
        setState(next)
        setPlan(undefined)
        setNotice(message)
      }
    } catch {
      if (epoch.current === generation) {
        setNotice('本次维护结果未确认。原件/恢复记录保留，请读取状态；没有自动重试或重启。')
        try {
          const next = readMaintenanceState(
            await window.electron.ipcRenderer.invoke('relayMaintenanceState')
          )
          if (epoch.current === generation) setState(next)
        } catch {
          if (epoch.current === generation) setState(undefined)
        }
      }
    } finally {
      active.current = false
      if (mounted.current) {
        setPending(false)
        setPlan(undefined)
      }
      onBusy(false)
    }
  }
  const cancel = async (): Promise<void> => {
    const generation = ++epoch.current
    setPlan(undefined)
    try {
      await window.electron.ipcRenderer.invoke('relayMaintenanceCancel')
      if (epoch.current === generation)
        setNotice('已请求取消尚未提交的维护；已写入结果须读取记录核对。')
    } catch {
      if (epoch.current === generation) setNotice('取消未确认，请读取本地状态。')
    }
  }
  return (
    <section className="relay-panel">
      <h2>自有本地维护</h2>
      <p>
        这里的重置只针对界面与导航偏好，不是清空整个软件。保留订阅、核心、凭据、恢复日志、流量数据库和Claude配置；不会自动退出、重启或停止在用连接。
      </p>
      <p>
        堆快照只导出当前Relay主进程，可能包含令牌等秘密，生成时界面可能暂停且额外占用内存。点击导出后生成本地文件，不上传。
      </p>
      <div className="relay-action">
        <button disabled={busy || pending} onClick={() => void run('state')}>
          读取维护状态
        </button>
        {actions.map((item) => (
          <button
            key={item.action}
            disabled={busy || pending || (item.action === 'restore-interface' && !state?.reset)}
            onClick={() => void run(item.action)}
          >
            {item.label}
          </button>
        ))}
        <button disabled={busy || pending} onClick={() => void run('reveal')}>
          查看堆快照目录…
        </button>
        <button disabled={!pending && !plan} onClick={() => void cancel()}>
          取消本次维护准备
        </button>
      </div>
      {state?.reset && (
        <p>
          界面重置事务：{state.reset.id} · {state.reset.phase}。不确定记录不会自动删除。
        </p>
      )}
      {plan && (
        <div>
          <p>
            已准备：{actions.find((item) => item.action === plan.action)?.label}；
            {new Date(plan.expiresAt).toLocaleTimeString()}前有效。
          </p>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
