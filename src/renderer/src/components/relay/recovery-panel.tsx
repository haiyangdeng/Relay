import type {
  RelayRecoveryStatus,
  RelayBackupPhase,
  RelayRecoverySelection,
  RelayRecoveryPreflight,
  RelayRecoveryIssue,
  RelayBackupSource
} from '../../../../shared/relay/protocol'
import { recoveryCanRequestRestore } from '../../../../shared/relay/protocol'

const issues: Record<RelayRecoveryIssue, string> = {
  manifestInvalid: '清单缺失、不可读或无效',
  targetOutsideScope: '目标超出固定配置范围或路径有链接',
  originalInvalid: '原始备份缺失、摘要不符或记录无效',
  targetChanged: '目标内容、权限已改变或文件被删除',
  targetUnreadable: '当前目标不可读取',
  targetModeUnknown: '旧记录没有安装后权限，当前权限无法确认',
  legacyConfirmationRequired: '旧版没有可信原始摘要，恢复前请核对备份内容',
  transactionFinished: '事务已经完成恢复或回滚',
  browserRunning: '专用浏览器仍在运行',
  browserProcessUnconfirmed: '浏览器退出状态待完整进程核对'
}
const targetNames: Record<RelayRecoveryPreflight['targets'][number]['target'], string> = {
  claudeSettings: 'Claude Code 用户设置',
  assistantPreferences: '助手参数',
  browserLocalState: '专用浏览器 Local State',
  browserPreferences: '专用浏览器 Preferences',
  unknown: '范围外目标'
}
const originalNames: Record<RelayRecoveryPreflight['targets'][number]['original'], string> = {
  verified: '原始摘要匹配',
  absent: '原文件不存在',
  unverifiedLegacy: '旧版原始内容无可信摘要',
  invalid: '原始摘要不匹配',
  unreadable: '原始备份不可核对',
  unassessed: '原始内容未读取'
}
const currentNames: Record<RelayRecoveryPreflight['targets'][number]['current'], string> = {
  original: '当前已是原始状态',
  installed: '当前匹配安装后状态',
  unverifiedMode: '当前内容匹配，但权限未确认',
  changed: '当前有后续更改',
  unreadable: '当前不可读取',
  unassessed: '当前内容未读取'
}

const phases: Record<RelayBackupPhase, string> = {
  legacy: '旧版记录，待人工核对',
  prepared: '准备中断，需预检',
  committed: '已提交（元数据）',
  recoveryNeeded: '事务记录要求恢复处理',
  restoring: '恢复曾中断，需预检',
  rolledBack: '已回滚（元数据）',
  restored: '已恢复（元数据）',
  unreadable: '清单不可读取或无效'
}
export function RelayRecoveryPanel({
  status,
  notice,
  busy,
  ready,
  onRead,
  preflight,
  onInspect,
  onRestore,
  onOpenDirectory
}: {
  status?: RelayRecoveryStatus
  notice: string
  busy: boolean
  ready: boolean
  onRead(): void
  preflight?: RelayRecoveryPreflight
  onInspect(selection: RelayRecoverySelection): void
  onRestore?(): void
  onOpenDirectory?(source: RelayBackupSource): void
}): React.JSX.Element {
  return (
    <section className="relay-panel">
      <h2>备份与恢复记录</h2>
      <p>
        读取列表只查看清单元数据；逐条预检会核对备份摘要、目标内容与权限。两者都不执行恢复或创建目录。
      </p>
      <div className="relay-action">
        <button disabled={busy || !ready} onClick={onRead}>
          读取恢复记录
        </button>
        <button
          disabled={
            busy || !ready || !preflight || !onRestore || !recoveryCanRequestRestore(preflight)
          }
          title="恢复当前预检对应的备份"
          onClick={onRestore}
        >
          {preflight?.requiresLegacyConfirmation || preflight?.issues.includes('targetModeUnknown')
            ? '恢复旧版备份（摘要或权限不完整）'
            : '恢复配置'}
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {status && (
        <>
          {status.inventories.map((inventory) => (
            <div key={inventory.source} className="relay-output">
              <h3>{inventory.source === 'relay' ? 'Relay 自有记录' : '旧助手记录（独立保留）'}</h3>
              <p>
                {inventory.availability === 'missing'
                  ? '备份目录不存在。'
                  : inventory.availability === 'unreadable'
                    ? '目录不可读取，不能判断待恢复记录。'
                    : `读取 ${inventory.entries.length} 条清单元数据。`}
              </p>
              {!inventory.complete && <p>读取结果不完整，不能视为没有待恢复记录。</p>}
              <button
                disabled={busy || inventory.availability !== 'readable' || !onOpenDirectory}
                onClick={() => onOpenDirectory?.(inventory.source)}
              >
                在 Finder 打开备份目录
              </button>
              <ul>
                {inventory.entries.map((entry) => (
                  <li key={entry.id}>
                    {entry.id} · {phases[entry.phase]} ·{' '}
                    {entry.version === 0 ? '目标数量未知' : `${entry.targetCount} 个目标`}
                    {entry.createdAt ? ` · ${entry.createdAt}` : ''}
                    <button
                      disabled={busy || !ready || !/^[a-zA-Z0-9_-]{1,200}$/u.test(entry.id)}
                      onClick={() => onInspect({ source: inventory.source, id: entry.id })}
                    >
                      只读预检
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <ul>
            {status.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      )}
      {preflight && (
        <div className="relay-output">
          <h3>记录预检：{preflight.selection.id}</h3>
          <p>
            {preflight.fileChecksPassed
              ? '本次文件检查通过，可以恢复。'
              : preflight.issues.every((issue) =>
                    ['legacyConfirmationRequired', 'targetModeUnknown'].includes(issue)
                  )
                ? '旧记录摘要或权限不完整，请核对内容后使用旧版恢复入口。'
                : '文件检查未通过，不能执行恢复。'}
          </p>
          <p>这是当前时点的快照，不代表恢复授权；不会显示原文件内容。</p>
          <ul>
            {preflight.targets.map((target) => (
              <li key={target.index}>
                {targetNames[target.target]} · {originalNames[target.original]} ·{' '}
                {currentNames[target.current]}
              </li>
            ))}
          </ul>
          <ul>
            {preflight.issues.map((issue) => (
              <li key={issue}>{issues[issue]}</li>
            ))}
          </ul>
          <ul>
            {preflight.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
