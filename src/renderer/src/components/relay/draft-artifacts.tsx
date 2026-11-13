import { useState } from 'react'
import type {
  RelayArtifactAction,
  RelayGeneratedArtifacts
} from '../../../../shared/relay/protocol'

export function RelayDraftArtifacts({
  result,
  busy,
  onAction
}: {
  result: RelayGeneratedArtifacts
  busy: boolean
  onAction(request: RelayArtifactAction): void
}): React.JSX.Element {
  const [selected, setSelected] = useState(result.artifacts[0]?.id)
  const document = result.artifacts.find((entry) => entry.id === selected)
  return (
    <div className="relay-output">
      <label>
        生成结果（只读文本）
        <select value={selected} onChange={(event) => setSelected(event.target.value)}>
          {result.artifacts.map((entry) => (
            <option value={entry.id} key={entry.id}>
              {entry.title}
            </option>
          ))}
        </select>
      </label>
      {document && (
        <>
          <textarea aria-label={document.title} readOnly rows={14} value={document.content} />
          <div className="relay-action">
            <button disabled={busy} onClick={() => onAction({ id: document.id, action: 'copy' })}>
              复制文本
            </button>
            <button disabled={busy} onClick={() => onAction({ id: document.id, action: 'save' })}>
              导出文本…
            </button>
            <span>不会应用配置，也不会执行文档中的代码。</span>
          </div>
        </>
      )}
      <ul>
        {result.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  )
}
