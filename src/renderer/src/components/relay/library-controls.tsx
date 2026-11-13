import { useEffect, useRef, useState } from 'react'
import type {
  RelayLibraryInventory,
  RelayLibraryKind,
  RelayLibraryChange
} from '../../../../shared/relay/library'
export function RelayLibraryControls({
  kind,
  busy,
  onBusy,
  onChanged,
  selectedId
}: {
  kind: RelayLibraryKind
  busy: boolean
  onBusy(value: boolean): void
  onChanged(): Promise<void> | void
  selectedId?: string
}): React.JSX.Element {
  const [inventory, setInventory] = useState<RelayLibraryInventory>(),
    [selected, setSelected] = useState(''),
    [name, setName] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    operation = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true)
  useEffect(() => {
    let active = true
    mounted.current = true
    const lifecycle = epoch
    const at = lifecycle.current
    void window.electron.ipcRenderer
      .invoke('relayLibraryList')
      .then((value) => {
        if (active && at === epoch.current) setInventory(value)
      })
      .catch(() => {
        if (active) setNotice('库显示设置未读取，可手动重读。')
      })
    return () => {
      active = false
      mounted.current = false
      ++lifecycle.current
    }
  }, [kind])
  const action = async (
    action: 'read' | 'rename' | 'hide' | 'restore' | 'up' | 'down'
  ): Promise<void> => {
    if (operation.current || busy) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const at = ++epoch.current
    try {
      let value: RelayLibraryInventory
      if (action === 'read') value = await window.electron.ipcRenderer.invoke('relayLibraryList')
      else {
        if (!inventory || !selected) throw new Error()
        const base = { kind, id: selected, expectedRevision: inventory.revision }
        const request: RelayLibraryChange =
          action === 'rename'
            ? { ...base, action, name: name.trim() }
            : action === 'hide' || action === 'restore'
              ? { ...base, action }
              : { ...base, action: 'move', direction: action === 'up' ? 'up' : 'down' }
        value = await window.electron.ipcRenderer.invoke('relayLibraryChange', request)
      }
      if (!mounted.current || at !== epoch.current) return
      setInventory(value)
      setNotice(
        action === 'read'
          ? '已读取本地库显示设置。'
          : '库显示设置已保存；原文、旧版本和当前连接保留。'
      )
      if (action !== 'read') await onChanged()
    } catch {
      if (mounted.current && at === epoch.current)
        setNotice(
          '库操作未确认。请重读列表；当前使用的配置不能移出，来源需先停用定时更新并结束待确认操作。'
        )
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  const items = inventory?.items.filter((item) => item.kind === kind) ?? [],
    current = items.find((item) => item.id === selected),
    locked = busy || pending
  return (
    <details className="relay-library-controls">
      <summary>{kind === 'profile' ? '整理配置库' : '整理订阅来源库'}</summary>
      <p>
        修改显示名或顺序；移出库的条目可恢复，原文与历史版本保留。当前使用的配置不能移出。订阅来源需先单独停用定时更新。
      </p>
      <select
        aria-label="整理库条目"
        disabled={locked}
        value={selected}
        onChange={(event) => {
          setSelected(event.target.value)
          setName(items.find((item) => item.id === event.target.value)?.name ?? '')
        }}
      >
        <option value="">选择条目（含已移出）</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
            {item.hidden ? ' · 已移出，可恢复' : ''}
            {item.active ? ' · 当前使用' : item.protectionReason ? ' · 运行记录待核对' : ''}
            {item.scheduled ? ' · 定时更新已启用' : ''}
          </option>
        ))}
      </select>
      <input
        aria-label="库显示名称"
        disabled={locked}
        maxLength={120}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="relay-action">
        <button disabled={locked} onClick={() => void action('read')}>
          重读库列表
        </button>
        <button disabled={locked || !current || !name.trim()} onClick={() => void action('rename')}>
          保存显示名称
        </button>
        <button disabled={locked || !current} onClick={() => void action('up')}>
          上移
        </button>
        <button disabled={locked || !current} onClick={() => void action('down')}>
          下移
        </button>
        {current?.hidden ? (
          <button disabled={locked} onClick={() => void action('restore')}>
            恢复到库
          </button>
        ) : (
          <button
            disabled={
              locked ||
              !current ||
              current.active ||
              !!current.protectionReason ||
              current.scheduled ||
              current.id === selectedId
            }
            onClick={() => void action('hide')}
          >
            移出库（可恢复）
          </button>
        )}
      </div>
      {current?.protectionReason && <p role="status">{current.protectionReason}</p>}
      <p role="status">{notice}</p>
    </details>
  )
}
