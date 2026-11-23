import { useEffect, useRef, useState } from 'react'
import type {
  RelayProfileInventory,
  RelayProfilePreparation,
  RelayProfileSummary,
  RelayStoredProfile,
  RelayProfileExportResult,
  RelayProfileSaveResult
} from '../../../../shared/relay/profiles'
import { RelayProfileNodeEditor } from './profile-node-editor'
import { RelayLibraryControls } from './library-controls'
import { RelayProfileRuleEditor } from './profile-rule-editor'

function summary(value: RelayProfileSummary): string {
  return `${value.proxies}个节点 · ${value.groups}个组 · ${value.rules}条规则 · ${value.proxyProviders}个节点提供者 · ${value.ruleProviders}个规则提供者`
}
export function RelayProfilesPanel({
  preparation,
  inventory,
  busy,
  selectionBusy = busy,
  notice,
  onPrepare,
  onList,
  onInspect,
  onChoose,
  currentSelection,
  activeProfileId
}: {
  preparation?: RelayProfilePreparation
  inventory?: RelayProfileInventory
  busy: boolean
  selectionBusy?: boolean
  notice: string
  onPrepare(): void
  onSave(): void
  onList(): void
  onInspect?(profile: RelayStoredProfile): void
  onChoose?(profile: RelayStoredProfile): void
  currentSelection?: string | null
  activeProfileId?: string
}): React.JSX.Element {
  const [editing, setEditing] = useState<RelayStoredProfile>(),
    [nodeBusy, setNodeBusy] = useState(false)
  const [importInvalidated, setImportInvalidated] = useState(false)
  const [collection, setCollection] = useState<'nodes' | 'groups' | 'rules' | 'rule-providers'>(
    'nodes'
  )
  const locked = busy || nodeBusy
  const [newName, setNewName] = useState('新配置'),
    [newProof, setNewProof] = useState<RelayProfilePreparation>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const creating = useRef(false)
  const readingOriginal = useRef(false)
  const [original, setOriginal] = useState<{ id: string; sha256: string; text: string }>()
  const exporting = useRef(false),
    [exportNotice, setExportNotice] = useState('')
  const exportProfile = async (profile: RelayStoredProfile): Promise<void> => {
    if (locked || exporting.current || creating.current) return
    exporting.current = true
    setNodeBusy(true)
    setExportNotice('请选择原文保存位置…')
    try {
      const result = (await window.electron.ipcRenderer.invoke('relayProfileExport', {
        id: profile.id,
        sha256: profile.sha256
      })) as RelayProfileExportResult
      setExportNotice(
        result.status === 'exported'
          ? `已导出 ${profile.name} 原文；外部资源未导出，也未启用配置。`
          : '已取消原文导出，未改动配置。'
      )
    } catch {
      setExportNotice('原文导出未确认，请检查来源、保存位置或等待其他操作结束后重试。')
    } finally {
      exporting.current = false
      setNodeBusy(false)
    }
  }
  const newProfile = async (): Promise<void> => {
    if (locked || creating.current || exporting.current) return
    creating.current = true
    setNodeBusy(true)
    setNewProof(undefined)
    setImportInvalidated(true)
    setEditing(undefined)
    try {
      const prepared = (await window.electron.ipcRenderer.invoke('relayProfileNewPrepare', {
        name: newName.trim()
      })) as RelayProfilePreparation
      if (!mounted.current) return
      setNewProof(prepared)
      if (prepared.inspection.structure === 'passed') {
        const result = (await window.electron.ipcRenderer.invoke('relayProfileSave', {
          evidenceId: prepared.evidenceId
        })) as RelayProfileSaveResult
        if (!mounted.current) return
        setExportNotice(
          result.status === 'saved'
            ? '空白配置已保存为未启用副本，请刷新配置列表后继续编辑。'
            : result.status === 'cancelled'
              ? '已取消空白配置保存。'
              : '保存未确认，请刷新列表核对，不会自动重试。'
        )
        if (result.status === 'saved') onList()
        setNewProof(undefined)
      }
    } catch {
      setExportNotice('空白配置未确认，请检查名称或等待其他操作结束后重新准备。')
    } finally {
      creating.current = false
      setNodeBusy(false)
    }
  }
  const readOriginal = async (profile: RelayStoredProfile): Promise<void> => {
    if (locked || readingOriginal.current || exporting.current || creating.current) return
    readingOriginal.current = true
    setNodeBusy(true)
    setOriginal(undefined)
    try {
      const { id, sha256 } = profile
      const text = await window.electron.ipcRenderer.invoke('getProfileStr', { id, sha256 })
      if (typeof text !== 'string') throw new Error('原文读取未确认。')
      setOriginal({ id, sha256, text })
      setExportNotice('已读取此副本的原文。')
    } catch {
      setExportNotice('原文读取未确认，请重新读取配置列表。')
    } finally {
      readingOriginal.current = false
      setNodeBusy(false)
    }
  }
  return (
    <section className="relay-panel relay-profiles">
      <h2>本地配置导入</h2>
      <p>
        选择 YAML／JSON，检查后保存到 Relay
        自有目录。原文保留为未启用副本，不改原文件；不下载订阅或提供者、不执行脚本、不切换核心或网络。
      </p>
      <RelayLibraryControls
        kind="profile"
        busy={locked}
        onBusy={setNodeBusy}
        onChanged={onList}
        selectedId={editing?.id}
      />
      <div className="relay-action">
        <button
          disabled={locked}
          onClick={() => {
            setEditing(undefined)
            setNewProof(undefined)
            setImportInvalidated(false)
            onPrepare()
          }}
        >
          导入本地配置…
        </button>
        <button disabled={selectionBusy || nodeBusy} onClick={onList}>
          读取已保存配置
        </button>
      </div>
      <div className="relay-action">
        <label>
          新配置名称{' '}
          <input
            disabled={locked}
            value={newName}
            maxLength={108}
            onChange={(event) => {
              setNewName(event.target.value)
              setNewProof(undefined)
            }}
          />
        </label>
        <button disabled={locked || !newName.trim()} onClick={() => void newProfile()}>
          新建空白配置
        </button>
      </div>
      <p>
        空白配置只包含初始节点／组／规则编辑模块。没有启用配置、设置监听或启动核心；保存后可逐项编辑，运行前仍会检查配置。
      </p>
      {newProof && (
        <p>
          待保存 {newProof.name} · SHA256 {newProof.sha256}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {exportNotice && <p role="status">{exportNotice}</p>}
      {preparation && !importInvalidated && (
        <div>
          <h3>{preparation.name}</h3>
          <p>
            {preparation.inspection.structure === 'passed' ? '结构检查通过' : '结构检查未通过'} ·
            核心兼容性未验证 · 未启用
          </p>
          {preparation.inspection.summary && <p>{summary(preparation.inspection.summary)}</p>}
          <p>
            {preparation.bytes} 字节 · SHA256：{preparation.sha256}
          </p>
          <ul>
            {preparation.inspection.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {inventory && (
        <div>
          <p>
            已保存 {inventory.profiles.length} 份 · 未确认／未知条目 {inventory.incomplete} 项 ·
            {activeProfileId ? '当前核心已加载配置' : '当前没有已确认的运行配置'}
          </p>
          <ul>
            {inventory.profiles.map((profile) => (
              <li key={profile.id}>
                {onChoose ? (
                  <button
                    type="button"
                    aria-pressed={(activeProfileId ?? currentSelection) === profile.id}
                    disabled={
                      selectionBusy ||
                      nodeBusy ||
                      (activeProfileId ?? currentSelection) === profile.id
                    }
                    onClick={() => onChoose(profile)}
                  >
                    <strong>{profile.name}</strong>
                  </button>
                ) : (
                  <strong>{profile.name}</strong>
                )}
                {' · '}
                {summary(profile.summary)}
                {activeProfileId === profile.id
                  ? ' · 当前核心已加载'
                  : currentSelection === profile.id
                    ? ' · 已选用'
                    : ''}
                <button disabled={locked} onClick={() => void readOriginal(profile)}>
                  查看此配置原文
                </button>
                <button disabled={locked} onClick={() => void exportProfile(profile)}>
                  导出此配置原文
                </button>
                <button
                  disabled={locked}
                  onClick={() => {
                    setEditing(profile)
                    setNewProof(undefined)
                    setCollection('nodes')
                    setImportInvalidated(true)
                  }}
                >
                  编辑此配置节点
                </button>
                <button
                  disabled={locked}
                  onClick={() => {
                    setEditing(profile)
                    setCollection('groups')
                    setNewProof(undefined)
                    setImportInvalidated(true)
                  }}
                >
                  编辑此配置代理组
                </button>
                <button
                  disabled={locked}
                  onClick={() => {
                    setEditing(profile)
                    setCollection('rules')
                    setNewProof(undefined)
                    setImportInvalidated(true)
                  }}
                >
                  编辑此配置规则
                </button>
                <button
                  disabled={locked}
                  onClick={() => {
                    setEditing(profile)
                    setCollection('rule-providers')
                    setNewProof(undefined)
                    setImportInvalidated(true)
                  }}
                >
                  编辑此配置规则提供者
                </button>
                {onInspect && (
                  <div className="relay-action">
                    <button disabled={locked} onClick={() => onInspect(profile)}>
                      查看节点与组
                    </button>
                  </div>
                )}
                {original?.id === profile.id && original.sha256 === profile.sha256 && (
                  <div>
                    <button onClick={() => setOriginal(undefined)}>关闭原文</button>
                    <pre className="max-h-96 overflow-auto" aria-label="自有配置原文">
                      {original.text}
                    </pre>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <ul>
            {inventory.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {editing && (collection === 'rules' || collection === 'rule-providers') && (
        <RelayProfileRuleEditor
          key={editing.id + collection}
          profile={editing}
          busy={busy}
          onBusy={setNodeBusy}
          providers={collection === 'rule-providers'}
        />
      )}
      {editing && (collection === 'nodes' || collection === 'groups') && (
        <RelayProfileNodeEditor
          key={editing.id + collection}
          profile={editing}
          busy={busy}
          onBusy={setNodeBusy}
          collection={collection}
        />
      )}
    </section>
  )
}
