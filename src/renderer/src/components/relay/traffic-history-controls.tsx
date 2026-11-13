import { useEffect, useRef, useState } from 'react'
import type { TrafficHistoryState } from '../../../../shared/relay/traffic-history'
import { legacyTrafficUsageDatabase } from '../../utils/legacy-traffic-db'
import { importTrafficUsage } from '../../utils/ipc'

export function RelayTrafficHistoryControls({
  onChanged,
  busy,
  onBusy
}: {
  onChanged(): Promise<void>
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [state, setState] = useState<TrafficHistoryState>(),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    operation = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true)
  const read = async (): Promise<void> => {
    const at = epoch.current
    try {
      const next = await window.electron.ipcRenderer.invoke('relayTrafficHistoryState')
      if (mounted.current && at === epoch.current) setState(next)
    } catch {
      if (mounted.current && at === epoch.current) setState(undefined)
    }
  }
  useEffect(() => {
    mounted.current = true
    const lifecycle = epoch
    const at = lifecycle.current
    void window.electron.ipcRenderer
      .invoke('relayTrafficHistoryState')
      .then((next) => {
        if (mounted.current && at === epoch.current) setState(next)
      })
      .catch(() => {})
    return () => {
      mounted.current = false
      ++lifecycle.current
    }
  }, [])
  const run = async (
    action: 'record' | 'stop' | 'import' | 'read' | 'retry' | 'tun'
  ): Promise<void> => {
    if (operation.current || busy) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const at = ++epoch.current
    try {
      if (action === 'record') {
        if (!state?.availableOwner) throw new Error('本次自有核心尚未确认。')
        const next = await window.electron.ipcRenderer.invoke(
          'relayTrafficHistoryRecord',
          state.availableOwner
        )
        if (mounted.current && at === epoch.current) {
          setState(next)
          setNotice(
            next.recording ? '已开始保存本次核心已读取的连接统计。' : '记录未开启，历史库保持原样。'
          )
        }
      } else if (action === 'tun') {
        const next = await window.electron.ipcRenderer.invoke('relayTrafficHistoryReadTun')
        if (mounted.current && at === epoch.current) {
          setState(next)
          setNotice('已读取并保存本次TUN实例的连接统计。')
        }
        if (mounted.current && at === epoch.current) await onChanged()
      } else if (action === 'stop') {
        const next = await window.electron.ipcRenderer.invoke('relayTrafficHistoryStop')
        if (mounted.current && at === epoch.current) {
          setState(next)
          setNotice('已停止保存历史；现有核心和连接不变。')
        }
      } else if (action === 'retry') {
        const next = await window.electron.ipcRenderer.invoke('relayTrafficHistoryRetry')
        if (mounted.current && at === epoch.current) setState(next)
        if (mounted.current && at === epoch.current) await onChanged()
      } else if (action === 'import') {
        if (!(await window.electron.ipcRenderer.invoke('relayTrafficHistoryImportAuthorize'))) {
          if (mounted.current && at === epoch.current) setNotice('已取消旧缓存迁移。')
          return
        }
        await legacyTrafficUsageDatabase.migrateToBackend(importTrafficUsage)
        if (mounted.current && at === epoch.current)
          setNotice('本应用旧缓存迁移完成；已确认批次不会重复计入。')
        if (mounted.current && at === epoch.current) await onChanged()
      }
      await read()
    } catch {
      if (mounted.current && at === epoch.current) {
        setNotice('历史操作未确认；保留已有数据和迁移进度，没有自动重试。')
        await read()
      }
    } finally {
      operation.current = false
      if (mounted.current) {
        setPending(false)
        onBusy(false)
      }
    }
  }
  return (
    <section className="rounded-xl border border-foreground/10 bg-content1 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <strong className="mr-auto">流量记录</strong>
        <span>{!state ? '正在读取…' : state.recording ? '记录中' : '未开启'}</span>
        {state?.recording ? (
          <button
            className="rounded-lg bg-default-200 px-3 py-2"
            disabled={busy || pending}
            onClick={() => void run('stop')}
          >
            停止记录
          </button>
        ) : (
          <button
            className="rounded-lg bg-primary text-primary-foreground px-3 py-2"
            disabled={
              busy ||
              pending ||
              !state?.availableOwner ||
              state.pending ||
              state.writeRecoveryRequired ||
              state.clearRecoveryRequired
            }
            onClick={() => void run('record')}
          >
            开始记录
          </button>
        )}
        <button
          className="rounded-lg bg-default-200 px-3 py-2"
          disabled={busy || pending}
          onClick={() => void run('read')}
        >
          刷新
        </button>
        {state?.recording && state.owner?.kind === 'tun-managed' && (
          <button disabled={busy || pending} onClick={() => void run('tun')}>
            读取 TUN 用量
          </button>
        )}
      </div>
      {state && !state.recording && !state.availableOwner && (
        <p className="mt-2 text-xs text-default-500">
          运行 Relay 内核并
          <a href="#/relay?panel=connections" className="text-primary">
            读取连接
          </a>
          后，可开始记录用量。
        </p>
      )}
      {(state?.warning || notice) && (
        <p role="status" className="mt-2 text-xs">
          {notice}
          {state?.warning ? ` · ${state.warning}` : ''}
        </p>
      )}
      {state?.writeRecoveryRequired && (
        <button disabled={busy || pending} onClick={() => void run('retry')}>
          恢复未确认的历史写入…
        </button>
      )}
      <details className="mt-2 text-xs text-default-500">
        <summary className="cursor-pointer">历史管理与记录说明</summary>
        <p className="my-2">
          仅保存已授权的 Relay
          自有内核连接统计；未记录的时段不补算，不采集其他代理客户端。历史保留在本机，普通配置备份不包含此库。
        </p>
        {state?.owner?.instanceId && <p>记录实例：{state.owner.instanceId}</p>}
        <button
          className="rounded-lg bg-default-200 px-3 py-2"
          disabled={busy || pending}
          onClick={() => void run('import')}
        >
          导入本应用旧流量缓存…
        </button>
        {state?.droppedRecords ? <p>未保存条目：{state.droppedRecords}，统计可能不完整。</p> : null}
      </details>
    </section>
  )
}
