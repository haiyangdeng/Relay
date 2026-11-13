import { useRef, useState } from 'react'
import { ownedResetReport, type OwnedResetReport } from '../../../../shared/relay/owned-reset'
export function RelayOwnedResetPanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [state, setState] = useState<OwnedResetReport>(),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    active = useRef(false)
  const run = async (action?: 'reset' | 'restore' | 'cancel'): Promise<void> => {
    if (active.current || busy) return
    active.current = true
    setPending(true)
    onBusy(true)
    try {
      const report = ownedResetReport(
        await window.electron.ipcRenderer.invoke(
          action ? 'relayOwnedResetAction' : 'relayOwnedResetState',
          ...(action ? [action] : [])
        )
      )
      setState(report)
      setNotice(
        report.phase === 'resetScheduled' || report.phase === 'restoreScheduled'
          ? '已登记下次启动维护计划；当前数据尚未移动。请按原有退出流程自行退出，再重新打开Relay，执行独立维护启动。'
          : report.phase === 'cancelled'
            ? '未移动的维护计划已由原生核实取消。'
            : report.phase === 'unavailable'
              ? '签名维护资源未就绪，维护保持禁用。'
              : '状态以本次原生回读为准；没有自动退出、重启、清理或安装。'
      )
    } catch {
      setState(undefined)
      setNotice(
        '整套数据维护结果未知，保留当前根、隔离原件和记录。请只读检查；不要删除目录或重复重置。'
      )
    } finally {
      active.current = false
      setPending(false)
      onBusy(false)
    }
  }
  return (
    <section className="relay-panel">
      <h2>整套Relay自有数据重置与恢复</h2>
      <p>
        与界面偏好重置分开。此流程可登记下次手动启动的完整数据隔离计划：原件整体保留在同盘自有隔离目录，包含订阅、凭据、私有浏览器和流量数据库，不复制活动WAL，不删除原件。恢复会先隔离当前根，避免覆盖；这不会回滚已安装App或原生组件版本。独立受限
        CLI 数据区另行保留，不随本流程移动或清理；入口退出不表示全部工具后代已退出。
      </p>
      <p>
        只有其他Relay实例、自有Core/TUN/桌面/系统代理/过滤及未完成安装事务都已排除，原生签名宿主才允许执行。当前没有签名维护能力时禁用。此入口不会替你停止连接、退出或重启App，也不会自动修改或还原外部Clash/Claude/系统配置。
      </p>
      <div className="relay-action">
        <button disabled={busy || pending} onClick={() => void run()}>
          读取原生维护状态
        </button>
        <button disabled={busy || pending || !state?.canReset} onClick={() => void run('reset')}>
          登记整套重置计划…
        </button>
        <button
          disabled={busy || pending || !state?.canRestore}
          onClick={() => void run('restore')}
        >
          登记原件恢复计划…
        </button>
        <button
          disabled={
            busy || pending || !['resetScheduled', 'restoreScheduled'].includes(state?.phase ?? '')
          }
          onClick={() => void run('cancel')}
        >
          取消尚未移动的计划…
        </button>
      </div>
      {state && (
        <p>
          状态：{state.phase} · 独占权：{state.lockHeld ? '本次已持有' : '未确认'}
          {state.reason ? ' · ' + state.reason : ''}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
