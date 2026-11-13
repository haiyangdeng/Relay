import { useEffect, useRef, useState } from 'react'
import type {
  RelayProfileNodes,
  RelayProfileGroups,
  RelayProfilePreparation,
  RelayProfileSaveResult,
  RelayStoredProfile
} from '../../../../shared/relay/profiles'

const initial = JSON.stringify(
  {
    name: '新节点',
    type: 'ss',
    server: '127.0.0.1',
    port: 8388,
    cipher: 'aes-128-gcm',
    password: ''
  },
  null,
  2
)

export function RelayProfileNodeEditor({
  profile,
  busy,
  onBusy,
  collection = 'nodes'
}: {
  profile: RelayStoredProfile
  busy: boolean
  onBusy(value: boolean): void
  collection?: 'nodes' | 'groups'
}): React.JSX.Element {
  const groups = collection === 'groups',
    label = groups ? '代理组' : '节点'
  const initialText = groups
    ? JSON.stringify({ name: '新代理组', type: 'select', proxies: ['DIRECT'] }, null, 2)
    : initial
  const [nodes, setNodes] = useState<Record<string, unknown>[]>(),
    [selected, setSelected] = useState('')
  const [text, setText] = useState(initialText),
    [proof, setProof] = useState<RelayProfilePreparation>()
  const [pending, setPending] = useState(false),
    [notice, setNotice] = useState('')
  const [order, setOrder] = useState('[]'),
    [hints, setHints] = useState('')
  const [newName, setNewName] = useState(''),
    [loadedContext, setLoadedContext] = useState('')
  const operation = useRef(false),
    mounted = useRef(true),
    epoch = useRef(0),
    context = `${profile.id}:${profile.sha256}:${collection}`,
    latestContext = useRef(context),
    locked = busy || pending
  latestContext.current = context
  useEffect(() => {
    mounted.current = true
    const lifecycle = epoch
    return () => {
      mounted.current = false
      ++lifecycle.current
    }
  }, [])
  useEffect(() => {
    ++epoch.current
    setLoadedContext('')
    setNodes(undefined)
    setSelected('')
    setNewName('')
    setProof(undefined)
    setHints('')
    setText(initialText)
    setOrder('[]')
    setNotice('')
  }, [context, initialText])
  const selection = { id: profile.id, sha256: profile.sha256 }
  const action = async (
    kind: 'read' | 'prepare' | 'remove' | 'save' | 'reorder' | 'rename'
  ): Promise<void> => {
    if (
      !mounted.current ||
      operation.current ||
      busy ||
      (kind !== 'read' && loadedContext !== context)
    )
      return
    const ticket = ++epoch.current,
      currentContext = context,
      live = (): boolean =>
        mounted.current && ticket === epoch.current && currentContext === latestContext.current
    const check = (): void => {
      if (!live()) throw new Error('来源或页面已变化。')
    }
    operation.current = true
    setPending(true)
    onBusy(true)
    setNotice(`正在保存${label}…`)
    try {
      const current = proof
      setProof(undefined)
      if (kind === 'read') {
        const result = (await window.electron.ipcRenderer.invoke(
          groups ? 'relayProfileGroupsRead' : 'relayProfileNodesRead',
          selection
        )) as RelayProfileNodes | RelayProfileGroups
        check()
        const records = 'nodes' in result ? result.nodes : result.groups
        setLoadedContext(currentContext)
        setNodes(records)
        setOrder(
          JSON.stringify(
            records.map((record) => record.name),
            null,
            2
          )
        )
        if ('targets' in result)
          setHints(
            `成员名称：${result.targets.slice(0, 200).join('、')}${result.targets.length > 200 ? '（其余名称请查配置）' : ''}；提供者：${result.providers.join('、') || '无'}。自动检测组需显式填写检测URL。`
          )
        setSelected('')
        setNewName('')
        setText(initialText)
        setNotice(`已读取独立草稿。${label}内容可能含密码；保存时会先检查结构。`)
      } else if (kind === 'save' && current) {
        const result = (await window.electron.ipcRenderer.invoke('relayProfileSave', {
          evidenceId: current.evidenceId
        })) as RelayProfileSaveResult
        check()
        setNotice(
          result.status === 'saved'
            ? `已另存 ${result.profile?.name ?? '新配置'}，请刷新配置列表；原配置和运行实例未更改。`
            : result.status === 'cancelled'
              ? '已取消另存，原配置未更改。'
              : '保存未确认，请刷新列表核对；不会自动重试。'
        )
      } else if (
        kind === 'prepare' ||
        kind === 'remove' ||
        kind === 'reorder' ||
        kind === 'rename'
      ) {
        const existing = selected === '' ? undefined : nodes?.[Number(selected)]
        if (kind === 'rename' && !existing) throw new Error()
        const result = (await window.electron.ipcRenderer.invoke(
          groups ? 'relayProfileGroupsPrepare' : 'relayProfileNodesPrepare',
          {
            profile: selection,
            action:
              kind === 'reorder'
                ? 'reorder'
                : kind === 'rename'
                  ? 'rename'
                  : kind === 'remove'
                    ? 'remove'
                    : existing
                      ? 'update'
                      : 'add',
            ...(kind === 'reorder'
              ? { order: JSON.parse(order) }
              : {
                  ...(existing ? { originalName: existing.name } : {}),
                  ...(kind === 'rename'
                    ? { newName }
                    : kind === 'remove'
                      ? {}
                      : { [groups ? 'group' : 'node']: JSON.parse(text) })
                })
          }
        )) as RelayProfilePreparation
        check()
        setProof(result)
        if (result.inspection.structure !== 'passed') throw new Error('结构检查未通过。')
        const saved = (await window.electron.ipcRenderer.invoke('relayProfileSave', {
          evidenceId: result.evidenceId
        })) as RelayProfileSaveResult
        check()
        setProof(undefined)
        setNotice(
          saved.status === 'saved'
            ? '已另存配置副本，原配置和运行实例未更改。'
            : '保存未完成，请刷新配置列表核对。'
        )
      }
    } catch {
      if (!live()) return
      setProof(undefined)
      setNotice(
        `${label}操作未通过。检查JSON、类型、字段、名称、引用或排列；普通更新须保留名称，改名须全部引用可确认且不合并JSON修改，已引用项不能删除。来源变化时请重新读取。`
      )
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  return (
    <div className="relay-panel">
      <h3>
        配置{label}编辑：{profile.name}
      </h3>
      <p>
        仅编辑另存副本，不自动切换、热载或启动核心。保留其他字段的值；另存为JSON格式，不保留YAML注释。最多500个
        {label}，每次编辑不超过64KiB。
      </p>
      <button disabled={locked} onClick={() => void action('read')}>
        读取{label}草稿
      </button>
      {nodes && (
        <fieldset disabled={locked}>
          <label>
            编辑{label}{' '}
            <select
              value={selected}
              onChange={(event) => {
                const value = event.target.value
                setSelected(value)
                setNewName('')
                setProof(undefined)
                setText(value === '' ? initialText : JSON.stringify(nodes[Number(value)], null, 2))
              }}
            >
              <option value="">新增{label}</option>
              {nodes.map((node, index) => (
                <option key={String(node.name)} value={String(index)}>
                  {String(node.name)} · {String(node.type)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {label}JSON（可能包含密码）{' '}
            <textarea
              rows={12}
              spellCheck={false}
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                setProof(undefined)
              }}
            />
          </label>
          {hints && <p>{hints}</p>}
          <button onClick={() => void action('prepare')}>保存{label}到配置副本</button>
          <button disabled={selected === ''} onClick={() => void action('remove')}>
            删除此{label}并另存副本
          </button>
          {selected !== '' && (
            <div>
              <p>改名不接受共享的YAML对象或数组别名；仅检查独立JSON值，不改变原配置。</p>
              <label>
                此{label}的新名称（仅改名，不合并JSON编辑）{' '}
                <input
                  value={newName}
                  onChange={(event) => {
                    setNewName(event.target.value)
                    setProof(undefined)
                  }}
                />
              </label>
              <button disabled={!newName} onClick={() => void action('rename')}>
                改名并另存配置副本
              </button>
            </div>
          )}
          {groups && (
            <div>
              <label>
                代理组顺序JSON（全部名称各一次）{' '}
                <textarea
                  rows={4}
                  value={order}
                  onChange={(event) => {
                    setOrder(event.target.value)
                    setProof(undefined)
                  }}
                />
              </label>
              <button onClick={() => void action('reorder')}>保存顺序到配置副本</button>
            </div>
          )}
        </fieldset>
      )}
      {proof && (
        <p>
          待保存 {proof.name} · {proof.bytes}字节 · SHA256 {proof.sha256}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
