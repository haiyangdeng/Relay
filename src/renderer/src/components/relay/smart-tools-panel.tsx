import { useEffect, useRef, useState } from 'react'
import type {
  SmartNodeRank,
  SmartToolsInspection,
  SmartToolsReply,
  SmartToolsTarget
} from '../../../../shared/relay/smart-tools'

const rankLabel = (rank: SmartNodeRank['Rank']): string =>
  rank === ''
    ? '尚未分级'
    : rank === 'MostUsed'
      ? '经常使用'
      : rank === 'OccasionalUsed'
        ? '偶尔使用'
        : '较少使用'
const statusText = (status: SmartToolsReply['status']): string => {
  switch (status) {
    case 'accepted':
      return 'Core已接受清除统计缓存请求；CSV、Model和已保存历史版本保持。'
    case 'uncertain':
      return '清除结果未确认；没有自动重试，Core继续运行。'
    case 'cancelled':
      return '已取消清除统计缓存。'
    case 'busy':
      return 'Smart工具有一项操作尚未结束。'
    case 'unsupported':
      return '当前实例未提供Smart工具；请使用相配的固定Smart组件。'
    default:
      return '当前Smart实例或配置尚未确认，请刷新工具状态。'
  }
}
export function RelaySmartToolsPanel({
  ordinaryInstanceId,
  ordinaryConfigurationRevision,
  tunSessionId,
  busy = false
}: {
  ordinaryInstanceId?: string
  ordinaryConfigurationRevision?: string
  tunSessionId?: string
  busy?: boolean
}): React.ReactElement {
  const [target, setTarget] = useState<SmartToolsTarget>('ordinary')
  const [inspection, setInspection] = useState<SmartToolsInspection>()
  const [group, setGroup] = useState('')
  const [weights, setWeights] = useState<readonly SmartNodeRank[]>()
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const sequence = useRef(0)
  const instance = target === 'ordinary' ? ordinaryInstanceId : tunSessionId
  const revision = target === 'ordinary' ? ordinaryConfigurationRevision : undefined
  const owner = useRef('')
  owner.current = target + ':' + (instance ?? '') + ':' + (revision ?? '')
  useEffect(() => {
    ++sequence.current
    setInspection(undefined)
    setWeights(undefined)
    setGroup('')
    setPending(false)
    setNotice('')
    if (!instance && (ordinaryInstanceId || tunSessionId))
      setTarget(ordinaryInstanceId ? 'ordinary' : 'tun')
  }, [target, instance, ordinaryInstanceId, tunSessionId, revision])
  const refresh = async (): Promise<void> => {
    if (!instance || pending || busy) return
    const epoch = ++sequence.current,
      ownerKey = owner.current
    setPending(true)
    setInspection(undefined)
    setWeights(undefined)
    setNotice('')
    try {
      const reply = (await window.electron.ipcRenderer.invoke('relaySmartTools', {
        action: 'inspect',
        target
      })) as SmartToolsReply
      if (sequence.current !== epoch || owner.current !== ownerKey) return
      if (
        reply.status === 'ready' &&
        reply.inspection.instanceId === instance &&
        reply.inspection.target === target
      ) {
        setInspection(reply.inspection)
        setGroup(reply.inspection.groups[0] ?? '')
        if (!reply.inspection.available) setNotice(statusText('unsupported'))
      } else setNotice(statusText(reply.status))
    } catch {
      if (sequence.current === epoch && owner.current === ownerKey)
        setNotice(statusText('unavailable'))
    } finally {
      if (sequence.current === epoch && owner.current === ownerKey) setPending(false)
    }
  }
  const action = async (action: 'weights' | 'clear-cache'): Promise<void> => {
    if (
      !inspection ||
      !inspection.available ||
      inspection.target !== target ||
      inspection.instanceId !== instance ||
      pending ||
      busy
    )
      return
    const epoch = ++sequence.current,
      ownerKey = owner.current,
      captured = inspection
    setPending(true)
    setNotice('')
    setWeights(undefined)
    try {
      const reply = (await window.electron.ipcRenderer.invoke('relaySmartTools', {
        action,
        target,
        instanceId: captured.instanceId,
        configurationRevision: captured.configurationRevision,
        ...(action === 'weights' ? { group } : {})
      })) as SmartToolsReply
      if (sequence.current !== epoch || owner.current !== ownerKey) return
      if (reply.status === 'weights') {
        setWeights(reply.weights)
        setNotice(reply.weights.length ? '' : '当前Smart组尚无排名数据。')
      } else setNotice(statusText(reply.status))
    } catch {
      if (sequence.current === epoch && owner.current === ownerKey)
        setNotice(statusText(action === 'clear-cache' ? 'uncertain' : 'unavailable'))
    } finally {
      if (sequence.current === epoch && owner.current === ownerKey) setPending(false)
    }
  }
  const disabled = busy || pending
  return (
    <section className="rounded-lg border border-default-200 p-4 space-y-3">
      <h3 className="font-semibold">Smart运行工具</h3>
      <p className="text-sm text-default-500">
        查看固定Smart核心的学习排名，或清除当前Core全部Smart统计缓存。点击清除后执行。
      </p>
      <div className="flex flex-wrap gap-2 items-center">
        <label>
          当前实例{' '}
          <select
            aria-label="Smart工具实例"
            value={target}
            disabled={disabled}
            onChange={(event) => setTarget(event.target.value as SmartToolsTarget)}
          >
            <option value="ordinary" disabled={!ordinaryInstanceId}>
              普通代理
            </option>
            <option value="tun" disabled={!tunSessionId}>
              TUN
            </option>
          </select>
        </label>
        <button type="button" disabled={disabled || !instance} onClick={() => void refresh()}>
          刷新工具状态
        </button>
        <select
          aria-label="Smart排名组"
          value={group}
          disabled={disabled || !inspection?.available}
          onChange={(event) => {
            ++sequence.current
            setGroup(event.target.value)
            setWeights(undefined)
            setNotice('')
          }}
        >
          {!inspection && <option value="">先刷新工具状态</option>}
          {inspection?.groups.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled || !inspection?.available || !group}
          onClick={() => void action('weights')}
        >
          读取学习排名
        </button>
        <button
          type="button"
          disabled={disabled || !inspection?.available}
          onClick={() => void action('clear-cache')}
        >
          清除统计缓存…
        </button>
      </div>
      {!instance && <p>启动固定Smart实例后可使用这些工具。</p>}
      {weights && weights.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th>节点</th>
              <th>分级</th>
              <th>权重</th>
            </tr>
          </thead>
          <tbody>
            {weights.map((row) => (
              <tr key={row.Name}>
                <td>{row.Name}</td>
                <td>{rankLabel(row.Rank)}</td>
                <td>{row.Weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
