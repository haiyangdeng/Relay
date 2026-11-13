import type {
  RelayCoreMode,
  RelayCorePreparation,
  RelayCoreState
} from '../../../../shared/relay/core'

const phases: Record<RelayCoreState['phase'], string> = {
  unknown: '尚未读取持久配置',
  idle: '当前无本次实例',
  starting: '正在启动本次实例',
  running: '本次隔离实例运行中',
  stopping: '正在等待本次实例退出',
  blocked: '已有记录或条件待核对',
  failed: '操作或退出结果需要检查'
}
export function RelayCorePanel({
  state,
  preparation,
  mode,
  busy,
  notice,
  onMode,
  onPrepare,
  onStop
}: {
  state?: RelayCoreState
  preparation?: RelayCorePreparation
  mode: RelayCoreMode
  busy: boolean
  notice: string
  onMode(mode: RelayCoreMode): void
  onPrepare(): void
  onStart(): void
  onStop(): void
}): React.JSX.Element {
  const blocking = state?.owned || state?.pending
  return (
    <section className="relay-panel">
      <h2>自有核心：隔离运行控制</h2>
      <p>
        本面板仅启动无代理端口、无DNS/TUN的隔离实例。需要应用连接时，请使用「手动本地HTTP代理与动态组」。
      </p>
      <p role="status">
        {phases[state?.phase ?? 'unknown']}
        {state?.version ? ` · ${state.version}` : ''}
      </p>
      {state && state.phase !== 'unknown' && <p>已读取／本次隔离模式：{state.mode}</p>}
      <label>
        隔离实例模式
        <select
          value={mode}
          disabled={busy || !!blocking}
          onChange={(event) => onMode(event.target.value as RelayCoreMode)}
        >
          <option value="rule">Rule</option>
          <option value="global">Global</option>
          <option value="direct">Direct</option>
        </select>
      </label>
      <div className="relay-action">
        <button disabled={busy || !!blocking} onClick={onPrepare}>
          启动隔离实例
        </button>
        <button disabled={!state?.owned && !state?.pending} onClick={onStop}>
          停止本次实例／取消启动
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {preparation && (
        <p>
          准备模式：{preparation.mode}；
          {preparation.canStart ? '配置检查通过' : '存在待处理记录，不自动接管'}。
        </p>
      )}
      {state?.hasRecord && !state.owned && (
        <p className="relay-error">
          磁盘记录没有本次所有权。请先核对原实例；这里不会按记录PID停止或删除未知会话。
        </p>
      )}
      {state?.uncertain && (
        <p className="relay-error">退出或记录清理未确认，请保留窗口并重试停止本次实例。</p>
      )}
      <ul>
        {state?.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </section>
  )
}
