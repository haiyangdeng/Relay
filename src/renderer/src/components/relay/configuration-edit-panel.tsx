import { useRef, useState } from 'react'
import {
  configurationEditDocument,
  defaultEditDocument,
  profileOverridesFor,
  updateProfileOverrides,
  type ConfigurationEditPreview,
  type ConfigurationEditRecord
} from '../../../../shared/relay/configuration-edit'
import type { RelayProfileInventory } from '../../../../shared/relay/profiles'
import { RelayCompleteConfigurationPanel } from './complete-configuration-panel'
import { RelaySmartOverrideDraft } from './smart-override-draft'
import { relayProfileRead } from './profile-read-queue'

export function RelayConfigurationEditPanel({
  busy,
  onBusy,
  onChecked
}: {
  busy: boolean
  onBusy(value: boolean): void
  onChecked?(evidenceId: string | undefined): void
}): React.JSX.Element {
  const [draft, setDraft] = useState(JSON.stringify(defaultEditDocument(), null, 2)),
    [saved, setSaved] = useState<ConfigurationEditRecord>(),
    [baseRevision, setBaseRevision] = useState<string>(),
    [profiles, setProfiles] = useState<RelayProfileInventory>(),
    [selected, setSelected] = useState(''),
    [localDraft, setLocalDraft] = useState('[]'),
    [localOriginal, setLocalOriginal] = useState('[]'),
    [localFor, setLocalFor] = useState(''),
    [preview, setPreview] = useState<ConfigurationEditPreview>(),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    operation = useRef(false)
  const locked = busy || pending
  const localDirty = !!localFor && localFor === selected && localDraft !== localOriginal
  const changed = (value: string): void => {
    onChecked?.(undefined)
    setDraft(value)
    setSaved(undefined)
    setPreview(undefined)
    setLocalFor('')
    setLocalDraft('[]')
    setNotice('草稿已修改，保存后再准备运行或热载。')
    void window.electron.ipcRenderer.invoke('relayCompleteConfigurationCancel').catch(() => {})
  }
  const localAction = (kind: 'read' | 'write' | 'remove'): void => {
    if (!profiles?.profiles.some((profile) => profile.id === selected)) return
    try {
      const document = configurationEditDocument(JSON.parse(draft))
      if (kind === 'read') {
        setLocalDraft(JSON.stringify(profileOverridesFor(document, selected), null, 2))
        setLocalOriginal(JSON.stringify(profileOverridesFor(document, selected), null, 2))
        setLocalFor(selected)
        setNotice('已从当前草稿读入此来源的配置级覆写；尚未保存。')
      } else {
        if (kind === 'write' && localFor !== selected) throw new Error('请先读入此来源。')
        changed(
          JSON.stringify(
            updateProfileOverrides(
              document,
              selected,
              kind === 'remove' ? [] : JSON.parse(localDraft)
            ),
            null,
            2
          )
        )
        setNotice(
          kind === 'remove'
            ? '已从草稿移除此来源覆写；其他来源保留，保存后才生效。'
            : '已将此来源覆写写入草稿；其他来源保留，保存后才生效。'
        )
      }
    } catch {
      setNotice('请核对主文档与此来源覆写数组；未改变其他来源，请先读入所选来源后再编辑。')
    }
  }
  const action = async (kind: 'read' | 'save' | 'clear' | 'preview'): Promise<void> => {
    if (operation.current) return
    operation.current = true
    onChecked?.(undefined)
    setPending(true)
    onBusy(true)
    setPreview(undefined)
    let mutationSent = false
    try {
      if (kind === 'read') {
        const record = (await window.electron.ipcRenderer.invoke(
          'relayConfigEditRead'
        )) as ConfigurationEditRecord
        setSaved(record)
        setBaseRevision(record.revision)
        setDraft(JSON.stringify(record.document, null, 2))
        setLocalFor('')
        setLocalDraft('[]')
        setProfiles(await relayProfileRead('relayProfileList'))
        setNotice(record.exists ? '已读取保存的编辑，运行中的配置未改变。' : '尚无已保存的编辑。')
      } else if (kind === 'save') {
        if (baseRevision === undefined) throw new Error('请先读取保存的编辑。')
        const document = configurationEditDocument(JSON.parse(draft))
        mutationSent = true
        const record = (await window.electron.ipcRenderer.invoke('relayConfigEditSave', {
          document,
          expectedRevision: baseRevision
        })) as ConfigurationEditRecord
        setSaved(record)
        setBaseRevision(record.revision)
        setDraft(JSON.stringify(record.document, null, 2))
        setNotice('已保存。到本地代理面板重新准备并启动，或明确确认热载后才会应用。')
      } else if (kind === 'clear') {
        if (baseRevision === undefined) throw new Error('请先读取保存的编辑。')
        mutationSent = true
        await window.electron.ipcRenderer.invoke('relayConfigEditClear', {
          expectedRevision: baseRevision
        })
        setSaved(undefined)
        setBaseRevision('')
        setDraft(JSON.stringify(defaultEditDocument(), null, 2))
        setLocalFor('')
        setLocalDraft('[]')
        setNotice('已清除保存的编辑；运行中的实例保持原配置，后续重新准备才会使用来源配置。')
      } else {
        const profile = profiles?.profiles.find((item) => item.id === selected)
        if (!profile) throw new Error('请选择来源。')
        const document = configurationEditDocument(JSON.parse(draft))
        const result = await relayProfileRead('relayConfigEditPreview', {
          profile: { id: profile.id, sha256: profile.sha256 },
          ...document
        })
        setPreview(result)
        setNotice('合并预览已生成；未保存、未启用。')
      }
    } catch {
      setSaved(undefined)
      if (mutationSent) {
        setBaseRevision(undefined)
        setNotice('已保存版本变化或写入未完成；草稿保留，请重新读取后再编辑，没有应用运行配置。')
      } else {
        setNotice('草稿格式、读取或预览未通过；草稿保留，可修正后重试，没有应用运行配置。')
      }
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  return (
    <section className="relay-panel relay-profiles">
      <h2>覆写、DNS与嗅探编辑</h2>
      <p>
        编辑保存到Relay私有目录，原配置保持不变。保存后，本地代理的下一次准备、启动或确认热载会使用受支持的编辑；系统代理与TUN保持原状。
      </p>
      <div className="relay-action">
        <button disabled={locked} onClick={() => void action('read')}>
          读取保存的编辑与来源
        </button>
        <button
          disabled={locked || localDirty || baseRevision === undefined}
          onClick={() => void action('save')}
        >
          保存编辑
        </button>
        <button disabled={locked || !saved?.exists} onClick={() => void action('clear')}>
          清除保存的编辑
        </button>
      </div>
      <p>保存和清除绑定最近读取的版本；订阅更新继承编辑后，旧草稿会被拒绝，请先重新读取再修改。</p>
      <RelaySmartOverrideDraft
        draft={draft}
        disabled={locked || baseRevision === undefined || localDirty}
        onChange={changed}
      />
      <details>
        <summary>编辑格式与支持范围</summary>
        <p>
          globalOverrides为全局有序覆写数组。profileOverrideSets按来源保存多组配置级覆写，每项使用profileId和overrides数组；覆写使用id、kind（yaml或js）、content。旧profileId与profileOverrides仍可读取，同一来源不能重复出现在旧绑定和新库中。全局覆写、rulePatch与controlled供所有来源共用，配置级覆写仅应用到对应来源。profileRulePatchSets按profileId保存来源专用的rulePatch，在共享规则补丁之后应用，旧备份迁移的规则保存在这里。controlled可编辑dns、hosts、sniffer、ipv6等设置，controlDns与controlSniff决定是否合并对应字段。
        </p>
        <p>
          示例：
          {`{"globalOverrides":[],"profileOverrides":[],"rulePatch":{"prepend":["DOMAIN,example.com,NodeA"]},"controlled":{"sniffer":{"enable":true,"sniff":{"TLS":{"ports":["443"]}}}},"controlSniff":true}`}
        </p>
        <p>
          DNS／hosts编辑要求本地代理选择“配置内DNS／hosts”。HTTP投影未支持的顶层编辑或外部资源会明确拒绝；外部资源可在下方绑定私有缓存并检查完整候选。完整解析通过仍需相应运行工作流。
        </p>
      </details>
      <label>
        编辑文档 JSON
        <textarea
          aria-label="编辑文档 JSON"
          value={draft}
          disabled={locked}
          rows={14}
          spellCheck={false}
          onChange={(event) => changed(event.target.value)}
        />
      </label>
      <label>
        预览来源
        <select
          aria-label="预览来源"
          value={selected}
          disabled={locked}
          onChange={(event) => {
            setSelected(event.target.value)
            setPreview(undefined)
            setLocalFor('')
            setLocalDraft('[]')
          }}
        >
          <option value="">选择配置</option>
          {profiles?.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset disabled={locked || !selected}>
        <legend>所选来源的配置级覆写</legend>
        <p>
          先从当前草稿读入，再编辑此来源的有序数组。写入草稿或移除仅影响所选来源；仍需点击“保存编辑”。切换来源会清空尚未写入的此处内容。
        </p>
        {localDirty && <p>此来源的修改尚未写入草稿，请先写入再保存或预览。</p>}
        <button onClick={() => localAction('read')}>从草稿读入此来源覆写</button>
        <textarea
          aria-label="所选来源覆写 JSON"
          rows={8}
          spellCheck={false}
          value={localDraft}
          disabled={locked || !selected || localFor !== selected}
          onChange={(event) => setLocalDraft(event.target.value)}
        />
        <button
          disabled={locked || !selected || localFor !== selected}
          onClick={() => localAction('write')}
        >
          将此来源覆写写入草稿
        </button>
        <button onClick={() => localAction('remove')}>从草稿移除此来源覆写</button>
      </fieldset>
      <button
        disabled={locked || !selected}
        onClick={() => {
          try {
            const input: unknown = JSON.parse(draft)
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error()
            const document = configurationEditDocument({ ...input, profileId: selected })
            changed(JSON.stringify(document, null, 2))
          } catch {
            setNotice('请先核对编辑文档格式；可先绑定来源，再填写配置级覆写。')
          }
        }}
      >
        将旧格式覆写绑定到预览来源
      </button>
      <button disabled={locked || !selected || localDirty} onClick={() => void action('preview')}>
        预览合并顺序与DNS状态
      </button>
      {saved?.exists && <p>已保存版本：{saved.revision.slice(0, 12)}</p>}
      {preview && (
        <div>
          <p>合并顺序：{preview.order.join(' → ')}</p>
          <p>
            DNS覆写：
            {preview.dns.effective
              ? '已合并到预览'
              : preview.dns.autoDisabled
                ? '来源含自定义DNS，保留来源配置'
                : '未启用'}
          </p>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <RelayCompleteConfigurationPanel
        busy={locked}
        onBusy={onBusy}
        savedEdits
        onChecked={onChecked}
      />
    </section>
  )
}
