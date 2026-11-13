import { useState } from 'react'
import { smartOverrideContent, updateSmartOverride } from '../../../../shared/relay/smart-override'
import { SMART_COLLECTOR_DEFAULT_MIB } from '../../../../shared/relay/smart-settings'

export function RelaySmartOverrideDraft({
  draft,
  disabled,
  onChange
}: {
  draft: string
  disabled: boolean
  onChange(value: string): void
}): React.JSX.Element {
  const [useLightGBM, setUseLightGBM] = useState(false),
    [collectData, setCollectData] = useState(false),
    [collectorSize, setCollectorSize] = useState(String(SMART_COLLECTOR_DEFAULT_MIB)),
    [url, setURL] = useState(''),
    [notice, setNotice] = useState('')
  let content: string | undefined,
    valid = false
  try {
    content = smartOverrideContent(JSON.parse(draft))
    valid = true
  } catch {
    // The main editor retains malformed drafts for correction.
  }
  const change = (enabled: boolean): void => {
    if (disabled || !valid) return
    try {
      const next = updateSmartOverride(
        JSON.parse(draft),
        enabled
          ? {
              useLightGBM,
              collectData,
              collectorSizeMiB: Number(collectorSize),
              healthURL: url
            }
          : undefined
      )
      onChange(JSON.stringify(next, null, 2))
      setNotice('')
    } catch {
      setNotice('请核对测速URL、正整数MiB和编辑文档；草稿保持原样。')
    }
  }
  return (
    <details>
      <summary>Smart覆写</summary>
      <p>
        将url-test／load-balance组转换为Smart；否则更新已有Smart组，有顶层节点时可新建，并按上游模板更新规则目标。
        已有测速URL保留，新组使用下方明确填写的地址。LightGBM需要已选择可信模型。
      </p>
      <p>
        {content === undefined ? '全局草稿未启用标准Smart覆写。' : '全局草稿已有标准Smart覆写。'}
      </p>
      <fieldset disabled={disabled || !valid}>
        <legend>生成参数</legend>
        <label>
          <input
            type="checkbox"
            checked={useLightGBM}
            onChange={(event) => setUseLightGBM(event.target.checked)}
          />
          使用LightGBM
        </label>
        <label>
          <input
            type="checkbox"
            checked={collectData}
            onChange={(event) => setCollectData(event.target.checked)}
          />
          采集Smart数据
        </label>
        <label>
          采集文件大小（MiB）
          <input
            aria-label="Smart采集文件大小（MiB）"
            type="number"
            min={1}
            step={1}
            value={collectorSize}
            onChange={(event) => setCollectorSize(event.target.value)}
          />
        </label>
        <label>
          新Smart组测速URL
          <input
            aria-label="新Smart组测速URL"
            value={url}
            onChange={(event) => setURL(event.target.value)}
          />
        </label>
      </fieldset>
      <div className="relay-action">
        <button disabled={disabled || !valid} onClick={() => change(true)}>
          生成并写入标准Smart覆写草稿
        </button>
        <button
          disabled={disabled || !valid || content === undefined}
          onClick={() => change(false)}
        >
          从全局草稿移除标准Smart覆写
        </button>
      </div>
      {content !== undefined && (
        <details>
          <summary>查看当前草稿中的Smart覆写</summary>
          <textarea aria-label="当前Smart覆写内容" value={content} readOnly rows={10} />
        </details>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  )
}
