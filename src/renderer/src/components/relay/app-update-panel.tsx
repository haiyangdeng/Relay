import { useEffect, useRef, useState } from 'react'
import {
  readAppUpdatePlan,
  readAppUpdateState,
  type RelayAppUpdatePlan,
  type RelayAppUpdateState
} from '../../../../shared/relay/app-updates'

type Action = 'state' | 'check' | 'download' | 'install' | 'recover' | 'dismiss' | 'remove'

function actionStatus(raw: unknown, accepted: readonly string[]): string {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !('status' in raw) ||
    typeof raw.status !== 'string' ||
    !accepted.includes(raw.status)
  )
    throw new Error('应用更新操作回执未知。')
  return raw.status
}

export function RelayAppUpdatePanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [state, setState] = useState<RelayAppUpdateState>(),
    [plan, setPlan] = useState<RelayAppUpdatePlan>(),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    operation = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const generation = epoch
    return () => {
      mounted.current = false
      ++generation.current
    }
  }, [])
  const locked = busy || pending
  const run = async (action: Action, id?: string): Promise<void> => {
    if (operation.current || busy) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const current = ++epoch.current
    const live = (): boolean => mounted.current && current === epoch.current
    setPlan(undefined)
    try {
      let message = ''
      if (action === 'check') {
        await window.electron.ipcRenderer.invoke('relayAppUpdateCheck')
        message = '已结束本次发布检查；最新版本结果见下方。'
      } else if (action === 'download') {
        const prepared = readAppUpdatePlan(
          await window.electron.ipcRenderer.invoke('relayAppUpdatePrepareDownload')
        )
        if (!live()) return
        if (prepared.operation !== 'download') throw new Error('下载准备类型无效。')
        setPlan(prepared)
        const result = await window.electron.ipcRenderer.invoke('relayAppUpdateDownload', {
          evidenceId: prepared.evidenceId
        })
        message =
          actionStatus(result, ['staged', 'cancelled']) === 'staged'
            ? '安装包已校验摘要并保存为独立候选；选择安装时会核验发布签名及系统信任。'
            : '下载已取消；本次结果以重新读取的候选为准。'
      } else if (action === 'install') {
        if (!id) throw new Error('请选择安装候选。')
        const prepared = readAppUpdatePlan(
          await window.electron.ipcRenderer.invoke('relayAppUpdatePrepareInstall', { id })
        )
        if (!live()) return
        if (prepared.operation !== 'install') throw new Error('安装准备类型无效。')
        setPlan(prepared)
        const result = await window.electron.ipcRenderer.invoke('relayAppUpdateInstall', {
          evidenceId: prepared.evidenceId
        })
        message =
          actionStatus(result, ['installer-opened', 'cancelled']) === 'installer-opened'
            ? '已交给系统Installer，安装结果待核对。请按系统提示操作；Relay不会主动退出或重启。'
            : '已取消安装交接。'
      } else if (action === 'recover') {
        await window.electron.ipcRenderer.invoke('relayAppUpdateRecover')
        message = '本次安装结果核对已结束，事实状态见安装事务记录。'
      } else if (action === 'dismiss') {
        await window.electron.ipcRenderer.invoke('relayAppUpdateDismiss')
        message = '本次取消事务核对已结束，是否解除限制以安装事务记录为准。'
      } else if (action === 'remove') {
        if (!id) throw new Error('请选择候选。')
        await window.electron.ipcRenderer.invoke('relayAppUpdateRemove', { id })
        message = '候选移除已结束，保留结果见候选列表。'
      } else message = '已读取本地候选及安装事务；没有检查远端或调用系统信任服务。'
      if (!live()) return
      const next = readAppUpdateState(
        await window.electron.ipcRenderer.invoke('relayAppUpdateState')
      )
      if (live()) {
        setState(next)
        setPlan(undefined)
        setNotice(message)
      }
    } catch {
      if (live()) {
        setNotice('操作结果未确认，请读取本地状态核对。保留已有候选与安装事务，没有自动重试。')
        try {
          const next = readAppUpdateState(
            await window.electron.ipcRenderer.invoke('relayAppUpdateState')
          )
          if (live()) setState(next)
        } catch {
          if (live()) setState(undefined)
        }
      }
    } finally {
      operation.current = false
      if (mounted.current) {
        setPending(false)
      }
      onBusy(false)
    }
  }
  const cancel = async (): Promise<void> => {
    const current = ++epoch.current
    setPlan(undefined)
    try {
      await window.electron.ipcRenderer.invoke('relayAppUpdateCancel')
      if (mounted.current && current === epoch.current)
        setNotice('已请求取消尚未交接的操作；系统Installer及已持久记录的事务需单独核对。')
    } catch {
      if (mounted.current && current === epoch.current)
        setNotice('取消未确认，请读取本地状态核对。')
    }
  }
  return (
    <section className="relay-panel">
      <h2>Relay应用更新</h2>
      <p>
        先读取本地状态，再按需检查固定发布通道。检查与下载仅使用本次已确认的Relay自有代理；下载和安装是独立操作。
      </p>
      <p>
        安装前须结束并核实Relay自有会话。点击安装后可能访问Apple信任服务，并打开系统Installer替换应用；Installer可能要求退出Relay。此入口不会主动停止或重启应用、核心或当前Clash，也不修改Claude配置。
      </p>
      <div className="relay-action">
        <button disabled={locked} onClick={() => void run('state')}>
          读取本地更新状态
        </button>
        <button
          disabled={locked || !state?.configured || state.requiresApplicationExit}
          onClick={() => void run('check')}
        >
          经自有代理检查发布
        </button>
        <button
          disabled={locked || !state?.latest || state.requiresApplicationExit}
          onClick={() => void run('download')}
        >
          下载最新版本
        </button>
        <button disabled={!pending && !plan} onClick={() => void cancel()}>
          取消本次准备或获取
        </button>
      </div>
      {state && (
        <div>
          <p>
            当前版本 {state.runningVersion} ·{' '}
            {state.configured ? '固定发布通道已配置' : '本包使用手动更新'}
          </p>
          <p>
            {!state.configured
              ? '从本次交付目录取得适配本机架构的归档，核对 SHA256，解压到新目录。正常退出旧版后再启动新版，保留旧 App 以便回退。'
              : state.checkedAt === null
                ? '尚未完成本次发布检查，不能判断是否为最新版本。'
                : state.latest
                  ? `发现版本 ${state.latest.version}（${state.latest.architecture}）`
                  : '本次固定发布通道未提供更新版本。'}
          </p>
          {state.pending && <p>主进程操作中：{state.phase}</p>}
          {state.incomplete > 0 && <p>未确认的暂存条目：{state.incomplete}，未作为可安装候选。</p>}
          {state.candidates.map((candidate) => (
            <div key={candidate.id}>
              <p>
                {candidate.version} · {candidate.architecture} · {candidate.bytes}字节 · 摘要{' '}
                {candidate.sha256.slice(0, 12)}
              </p>
              <button
                disabled={locked || !state.configured || state.requiresApplicationExit}
                onClick={() => void run('install', candidate.id)}
              >
                安装此候选
              </button>
              <button
                disabled={
                  locked ||
                  (state.requiresApplicationExit &&
                    state.installation?.candidateId === candidate.id)
                }
                onClick={() => void run('remove', candidate.id)}
              >
                移除此候选…
              </button>
            </div>
          ))}
          {state.installation && (
            <div>
              <p>
                安装事务：{state.installation.previousVersion} → {state.installation.targetVersion}{' '}
                · {state.installation.phase}
              </p>
              {state.requiresApplicationExit && (
                <>
                  <p>
                    安装结果待核对，新会话保持受限。完成系统Installer后，请从已安装的Relay重新打开并核对实际版本与收据。
                  </p>
                  <button disabled={locked} onClick={() => void run('recover')}>
                    核对实际安装结果…
                  </button>
                  <button disabled={locked} onClick={() => void run('dismiss')}>
                    保留原安装并结束事务
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {plan && (
        <div>
          <p>
            本次{plan.operation === 'download' ? '下载' : '安装'}：{plan.release.version} ·{' '}
            {plan.release.architecture} · {plan.release.bytes}字节。凭据到期时间：
            {new Date(plan.expiresAt).toLocaleTimeString()}。
          </p>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
