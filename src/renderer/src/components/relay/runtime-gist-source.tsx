import type { RelayRuntimeGistSource } from '../../../../shared/relay/runtime-gist'

export function RelayRuntimeGistSourcePicker({
  source,
  tunSessionId,
  label,
  onChange
}: {
  source?: RelayRuntimeGistSource
  tunSessionId?: string
  label: string
  onChange(source: RelayRuntimeGistSource | undefined): void
}): React.JSX.Element {
  return (
    <div>
      <label>
        {label}{' '}
        <select
          aria-label={label}
          value={source?.kind ?? 'local-proxy'}
          onChange={(event) => {
            if (event.target.value === 'local-proxy') onChange(undefined)
            else if (tunSessionId) onChange({ kind: 'tun-managed', sessionId: tunSessionId })
          }}
        >
          <option value="local-proxy">Relay本地代理</option>
          <option value="tun-managed" disabled={!tunSessionId}>
            Relay托管TUN（需支持读取的活动会话）
          </option>
        </select>
      </label>
      {source?.kind === 'tun-managed' && (
        <p>
          已选TUN会话：{source.sessionId}
          。只读取本次已加载正文与观察到的mode，不是核心内存全量导出。
          {source.sessionId !== tunSessionId && '所选会话已失效，请重新选择来源。'}
          不会自动改用本地代理、启动或重启TUN；不支持读取的旧宿主会拒绝准备。
        </p>
      )}
    </div>
  )
}
