import { useRef, useState } from 'react'
import type {
  CoreLifecycleState,
  CoreRecordPreparation,
  CoreRecordRecoveryResult
} from '../../../../shared/relay/lifecycle'

export function RelayCoreRecoveryPanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [life, setLife] = useState<CoreLifecycleState>(),
    [plan, setPlan] = useState<CoreRecordPreparation>(),
    [result, setResult] = useState<CoreRecordRecoveryResult>(),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    operation = useRef(false)
  const run = async (action: 'state' | 'prepare' | 'archive'): Promise<void> => {
    if (operation.current) return
    operation.current = true
    setPending(true)
    onBusy(true)
    setNotice('处理中…')
    const current = plan
    if (action !== 'state') {
      setPlan(undefined)
      setResult(undefined)
    }
    try {
      if (action === 'state') {
        setLife(
          (await window.electron.ipcRenderer.invoke(
            'relayCoreLifecycleCheck'
          )) as CoreLifecycleState
        )
        setNotice('已复核本次持有的核心；没有重载、重启或修改网络配置。')
      } else if (action === 'prepare') {
        const next = (await window.electron.ipcRenderer.invoke(
          'relayCoreRecordPrepare'
        )) as CoreRecordPreparation
        setPlan(next)
        setNotice(next.report.warnings.join(' ') || '没有遗留会话记录。')
      } else {
        if (!current?.report.canArchive) throw new Error()
        const output = (await window.electron.ipcRenderer.invoke('relayCoreRecordArchive', {
          evidenceId: current.evidenceId
        })) as CoreRecordRecoveryResult
        setResult(output)
        setNotice(output.warnings.join(' '))
      }
    } catch {
      setNotice(
        '检查或归档未确认；可能存在本次会话、活跃PID、未知文件或来源变化。没有按旧PID接管、停止或重启核心。'
      )
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  return (
    <section className="relay-panel relay-profiles">
      <h2>核心生命周期与启动记录</h2>
      <p>
        睡眠时失效未提交凭据并暂停调度；唤醒只复核本次核心。自动重载、重启和直连回退均未启用。启动遗留记录只在核实PID不存在后归档，归档后仍需单独启动。
      </p>
      <div className="relay-action">
        <button disabled={busy || pending} onClick={() => void run('state')}>
          复核生命周期状态
        </button>
        <button disabled={busy || pending} onClick={() => void run('prepare')}>
          检查旧会话记录
        </button>
        <button
          disabled={busy || pending || !plan?.report.canArchive}
          onClick={() => void run('archive')}
        >
          确认归档旧记录…
        </button>
      </div>
      {life && (
        <p>
          上次复核：{life.phase} · 隔离核心 {life.observed ? life.core : '尚未复核'} · 本地代理{' '}
          {life.observed ? life.localProxy : '尚未复核'} · 自动重启关闭
        </p>
      )}
      {life?.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      {plan && (
        <p>
          记录状态：{plan.report.status} ·{' '}
          {plan.report.canArchive ? '60秒内可请求确认归档' : '不会归档或按PID操作'}
        </p>
      )}
      {result?.report?.archiveID && <p>归档标识：{result.report.archiveID}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
