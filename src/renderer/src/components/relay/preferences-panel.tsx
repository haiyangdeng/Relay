import type {
  RelayPreferenceSnapshot,
  RelayPreferences,
  RelayPreviewInput
} from '../../../../shared/relay/protocol'

export function mergeLoadedPreferences(
  current: RelayPreviewInput,
  preferences: RelayPreferences,
  userHasStarted: boolean
): RelayPreviewInput {
  return userHasStarted ? current : { ...current, ...preferences }
}

export function RelayPreferencesPanel({
  snapshot,
  notice,
  busy,
  ready,
  onRead,
  onSave
}: {
  snapshot?: RelayPreferenceSnapshot
  notice: string
  busy: boolean
  ready: boolean
  onRead(): void
  onSave(): void
}): React.JSX.Element {
  const labels = { relay: 'Relay 自有偏好', legacy: '旧助手参数（只读载入）', defaults: '默认草稿' }
  return (
    <section className="relay-panel">
      <h2>参数记忆</h2>
      <p>来源：{snapshot ? labels[snapshot.source] : '尚未读取'}</p>
      <p>
        只记住端口、节点名称和内网例外，不保存 settings.json 草稿。保存写入 Relay
        自有目录，不修改客户端或旧助手。重新读取会替换上面的三个参数，保留 JSON 草稿。
      </p>
      <div className="relay-action">
        <button disabled={busy || !ready} onClick={onRead}>
          重新读取参数
        </button>
        <button disabled={busy || !ready || !snapshot} onClick={onSave}>
          记住当前参数
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {snapshot && (
        <ul>
          {snapshot.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
