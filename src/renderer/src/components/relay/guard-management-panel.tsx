import { useEffect, useRef, useState } from 'react'
import {
  guardManagementSnapshot,
  type GuardExtensionState,
  type GuardManagementAction,
  type GuardManagementSnapshot,
  type GuardInstallationReceipt
} from '../../../../shared/relay/guard-management'

const phases: Record<GuardManagementSnapshot['phase'], string> = {
  unavailable: '发布资源尚未就绪',
  idle: '尚未启用',
  checking: '正在核对',
  awaitingUserApproval: '等待 macOS 批准',
  activationCompleted: '扩展激活请求已完成',
  rebootRequired: 'macOS 要求重启',
  configurationEnabled: '自有过滤配置已启用',
  configurationDisabled: '自有过滤配置已停用',
  failedUnchanged: '操作失败，配置读回原样',
  blocked: '本次操作未获准',
  uncertain: '结果未确认，请保留窗口与现场'
}
const installationSteps: Record<GuardInstallationReceipt['lineage'], string> = {
  notRequested: '未提交',
  requesting: '已提交，等待系统回执',
  awaitingUserApproval: '等待系统批准',
  completed: '本次系统请求已完成',
  rebootRequired: '系统要求重启后完成',
  failed: '请求失败，实际激活状态未确认',
  cancelled: '请求已取消，实际激活状态未确认'
}
const extensionStates: Record<GuardExtensionState, string> = {
  absent: '未发现',
  enabled: '已启用',
  disabled: '已停用',
  awaitingUserApproval: '等待系统批准',
  uninstalling: '卸载处理中',
  differentVersion: '与本包版本不同',
  unknown: '未确认'
}
const actions: readonly [GuardManagementAction, string][] = [
  ['status', '重新读取管理状态'],
  ['install', '安装两项扩展'],
  ['prepare', '绑定本次专用代理'],
  ['enable', '启用过滤'],
  ['disable', '停用自有过滤'],
  ['revoke', '撤销代理绑定'],
  ['launchDesktop', '通过保护门打开 Claude']
]

export function RelayGuardManagementPanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [report, setReport] = useState<GuardManagementSnapshot>(),
    [notice, setNotice] = useState('')
  const epoch = useRef(0),
    pending = useRef(false)
  useEffect(() => {
    const generation = epoch,
      ticket = ++generation.current
    // Reads Main memory only; mounting never installs, loads the native addon,
    // queries a system manager, captures a Core, or opens a client.
    void window.electron.ipcRenderer
      .invoke('relayGuardManagementState')
      .then((raw) => {
        if (ticket === generation.current) setReport(guardManagementSnapshot(raw))
      })
      .catch(() => {
        if (ticket === generation.current) setNotice('管理状态不可确认；实际保护尚未验收。')
      })
    return () => {
      ++generation.current
    }
  }, [])
  const act = async (action: GuardManagementAction): Promise<void> => {
    if (pending.current) return
    pending.current = true
    const ticket = ++epoch.current
    setReport(undefined)
    setNotice('正在处理本次请求；macOS可能要求系统授权。')
    onBusy(true)
    try {
      const raw: unknown = await window.electron.ipcRenderer.invoke(
        'relayGuardManagementAction',
        action
      )
      if (ticket === epoch.current) {
        setReport(guardManagementSnapshot(raw))
        setNotice('管理回执已返回；配置状态不能作为实际禁止直连的证明。')
      }
    } catch {
      if (ticket === epoch.current) {
        setNotice('本次结果未确认，没有自动重试、停用过滤或启动客户端。请重新读取状态。')
        try {
          const raw: unknown = await window.electron.ipcRenderer.invoke('relayGuardManagementState')
          if (ticket === epoch.current) setReport(guardManagementSnapshot(raw))
        } catch {
          /* Old success stays cleared. */
        }
      }
    } finally {
      pending.current = false
      if (ticket === epoch.current) onBusy(false)
    }
  }
  const releaseUnavailable = !report || report.phase === 'unavailable'
  return (
    <section className="relay-panel">
      <h2>系统过滤管理与启动门</h2>
      <p>
        当前发布身份、系统权限与完整客户端范围尚未验收，真实保护保持关闭。管理操作不会修改 Claude
        配置；安装可能需要macOS系统授权。
      </p>
      <p>
        自用版可在「AI
        客户端与指定节点代理」使用专用入口。该入口只处理客户端主动交给它的连接，系统过滤和 macOS
        终端自动拦截需要本包具备相应能力。
      </p>
      <div className="relay-action">
        {actions.map(([action, label]) => (
          <button
            key={action}
            disabled={busy || (action !== 'status' && (releaseUnavailable || report.pending))}
            onClick={() => void act(action)}
          >
            {label}
          </button>
        ))}
      </div>
      {notice && <p role="status">{notice}</p>}
      {report && (
        <div className="relay-output">
          <p>
            {phases[report.phase]}
            {report.pending ? '；事务仍在进行' : ''}。实际禁止直连：
            {report.phase === 'unavailable' ? '当前包不提供系统过滤' : '未验收'}。
          </p>
          {report.configuration && (
            <p>
              配置归属：{report.configuration.owned ? '已确认本次 Relay' : '未确认'}；配置开关：
              {report.configuration.enabled ? '启用' : '停用'}。
            </p>
          )}
          {report.installation && (
            <p>
              本次 App 进程内最近的安装请求：来源识别扩展
              {installationSteps[report.installation.lineage]}；网络过滤扩展
              {installationSteps[report.installation.filter]}
              。监控运行与全磁盘访问尚未确认；系统批准不能作为保护证明。
            </p>
          )}
          {report.extensions && (
            <p>
              macOS 扩展登记状态：来源识别扩展{extensionStates[report.extensions.lineage]}；
              网络过滤扩展{extensionStates[report.extensions.filter]}。
            </p>
          )}
          {report.policy && (
            <p>
              本次代理会话：
              {report.policy.phase === 'unconfirmed'
                ? '远端绑定或撤销结果未确认；保留窗口与核心，需显式处理'
                : report.policy.phase === 'ready'
                  ? 'Provider 已返回运行回执，保护范围仍未验收'
                  : report.policy.phase === 'preparedLocally'
                    ? '本机代理证据已准备，尚未取得 Provider 回执'
                    : report.policy.phase === 'prepared'
                      ? '已准备，等待 Provider'
                      : '未绑定'}
              。
            </p>
          )}
          {report.phase === 'blocked' && (
            <p>发布身份、权限、代理绑定或本次确认未满足；没有以旧成功状态放行。</p>
          )}
        </div>
      )}
    </section>
  )
}
