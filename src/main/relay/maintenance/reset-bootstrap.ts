import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { OwnedResetReport } from '../../../shared/relay/owned-reset'
import type { OwnedResetBridge } from './reset-native'

// Invoked only in the isolated Bootstrap profile, before any normal Relay
// actors, default target session, browser, Core or network controller is made.
// All destructive capability remains in the signed native coordinator.
export async function runOwnedResetBootstrap(
  bridge: OwnedResetBridge,
  dialogs: { showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> },
  isCurrent: () => boolean,
  inspectOwningIdle: () => Promise<void>
): Promise<void> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('维护启动已结束。')
  }
  let report: OwnedResetReport
  try {
    report = await bridge.acquire('maintenance')
    if (!report.lockHeld || report.mode !== 'maintenance') throw new Error('维护独占权未确认。')
  } catch {
    if (!isCurrent()) return
    await dialogs.showMessageBox({
      type: 'error',
      title: 'Relay维护保持暂停',
      message: '自有数据维护资源或独占身份未确认。',
      detail:
        '尚未初始化普通工作流，也没有隔离或删除原数据。请保留现场，手动退出后再处理；不会停止其他Relay/Clash/Core或自动重启。',
      buttons: ['保留现场'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    return
  }
  while (true) {
    if (!isCurrent()) return
    try {
      let owningIdle = true
      try {
        await inspectOwningIdle()
        assertCurrent()
      } catch {
        owningIdle = false
      }
      report = await bridge.inspect(assertCurrent)
      if (!owningIdle)
        report = {
          ...report,
          canReset: false,
          canRestore: false,
          reason: '自有备份/恢复记录未确认；仅保留未移动计划取消。'
        }
    } catch {
      if (!isCurrent()) return
      await dialogs.showMessageBox({
        type: 'error',
        title: 'Relay维护状态未知',
        message: '维护记录或原件身份未确认。',
        detail:
          '原件和隔离目录均保留；没有自动回滚、清理或重试。此启动只使用独立Bootstrap profile，普通工作流未初始化。请手动退出后处理。',
        buttons: ['保留现场'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return
    }
    const choices: {
      label: string
      action: 'later' | 'inspect' | 'reset' | 'restore' | 'cancel'
    }[] = [
      { label: '稍后处理', action: 'later' },
      { label: '重新只读检查', action: 'inspect' }
    ]
    if (report.canReset && report.evidenceID)
      choices.push({ label: '重置整套自有数据', action: 'reset' })
    if (report.canRestore && report.evidenceID)
      choices.push({ label: '恢复隔离原件', action: 'restore' })
    if (['resetScheduled', 'restoreScheduled'].includes(report.phase) && report.evidenceID)
      choices.push({ label: '取消未移动的数据计划', action: 'cancel' })
    const answer = await dialogs.showMessageBox({
      type: 'warning',
      title: 'Relay自有数据维护启动',
      message: `当前维护状态：${report.phase}`,
      detail:
        '此启动使用独立维护profile，尚未打开原Relay-Preview Chromium或普通工作流。重置会将整套自有数据（含订阅、凭据、缓存、流量数据库、私有浏览器和配置）原子隔离保存，不删除、不复制活动WAL。恢复会先保留当前数据根，再恢复已核实原件。独立受限CLI数据区另行保留，不随本流程移动或清理；入口退出不代表全部工具后代退出。任何活动/未知核心、系统接管、其他Relay实例或未完成安装事务都拒绝操作。每次变更前均由原生组件复核所有权和空闲状态。不会停止连接、退出或重启任何App，也不会修改Clash/Claude或系统配置。完成/取消后仍需你手动退出并重新打开Relay。' +
        (report.reason ? ` 原因：${report.reason}` : ''),
      buttons: choices.map((choice) => choice.label),
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (!isCurrent()) return
    const action = choices[answer.response]?.action ?? 'later'
    if (action === 'later') return
    if (action === 'inspect') continue
    try {
      // The native implementation consumes exactly this opaque observation,
      // rechecks generation/ownership/idle on the requested action and before
      // every renameEXCL. No renderer boolean or target path is supplied.
      const evidence = report.evidenceID
      if (!evidence) throw new Error('维护凭据缺失。')
      if (action !== 'cancel') {
        await inspectOwningIdle()
        assertCurrent()
      }
      report =
        action === 'reset'
          ? await bridge.reset(evidence, assertCurrent)
          : action === 'restore'
            ? await bridge.restore(evidence, assertCurrent)
            : await bridge.cancel(evidence, assertCurrent)
      if (!isCurrent()) return
      await dialogs.showMessageBox({
        type: report.phase === 'uncertain' ? 'warning' : 'info',
        title: 'Relay维护回执',
        message: `原生维护状态：${report.phase}`,
        detail:
          '当前仍停留在独立维护profile。请保留隔离原件；普通工作流不会在本次进程中自动启动。若要继续使用，请自行退出并重新打开Relay。打开或确认记录不代表系统验收通过。',
        buttons: ['保留回执'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return
    } catch {
      if (!isCurrent()) return
      await dialogs.showMessageBox({
        type: 'warning',
        title: 'Relay维护结果未确认',
        message: '本次数据维护未取得确定回执。',
        detail:
          '可能已有持久步骤完成。保持原件、当前根和维护记录，不自动反向移动、不重试、不删除。请重新只读检查，或手动退出后处理。',
        buttons: ['保留现场'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
    }
  }
}
