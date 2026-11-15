import { useEffect, useRef, useState } from 'react'
import { Button, Switch } from '@heroui/react'
import type { DedicatedListenerPlan } from '../../../../shared/relay/dedicated-listeners'
import type { RelayProfileNodes, RelayStoredProfile } from '../../../../shared/relay/profiles'
import { dedicatedNodeOptions } from './local-proxy-plan-actions'

export function RelayDedicatedListenersPanel({
  plan,
  disabled,
  defaultRoute,
  profile,
  onBusy,
  onChange
}: {
  plan?: DedicatedListenerPlan
  disabled: boolean
  defaultRoute: string
  profile?: RelayStoredProfile
  onBusy?(busy: boolean): void
  onChange(plan: DedicatedListenerPlan | undefined): void
}): React.JSX.Element {
  const [nodes, setNodes] = useState<string[]>([]),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState('')
  const context = `${profile?.id ?? ''}:${profile?.sha256 ?? ''}`,
    latest = useRef(context),
    mounted = useRef(true),
    working = useRef(false)
  latest.current = context
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    setNodes([])
    setNotice('')
  }, [context])
  const readNodes = async (enable: boolean): Promise<void> => {
    if (!profile || disabled || working.current) return
    const source = { id: profile.id, sha256: profile.sha256 },
      expected = context
    working.current = true
    setPending(true)
    onBusy?.(true)
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'relayProfileNodesRead',
        source
      )) as RelayProfileNodes
      if (!mounted.current || latest.current !== expected) return
      if (result.profile.id !== source.id || result.profile.sha256 !== source.sha256)
        throw new Error('所选配置已变化，请重新读取。')
      const available = dedicatedNodeOptions(result.nodes)
      setNodes(available)
      if (!available.length) throw new Error('此配置没有可用的固定代理节点。')
      if (enable)
        onChange({
          httpPort: 18193,
          socksPort: 18190,
          route: available.includes(defaultRoute) ? defaultRoute : available[0]
        })
      setNotice('已读取具体代理节点；保存计划后随核心启动。')
    } catch (error) {
      if (mounted.current && latest.current === expected)
        setNotice(error instanceof Error ? error.message : '读取节点失败，未启用专用监听。')
    } finally {
      working.current = false
      if (mounted.current) setPending(false)
      onBusy?.(false)
    }
  }
  return (
    <fieldset disabled={disabled || pending}>
      <div className="relay-setting-row">
        <span>AI 专用监听</span>
        <Switch
          size="sm"
          aria-label="AI 专用监听"
          isDisabled={disabled || pending || (!plan && !profile)}
          isSelected={!!plan}
          onValueChange={(enabled) => (enabled ? void readNodes(true) : onChange(undefined))}
        />
      </div>
      {plan && (
        <>
          <div className="relay-setting-row">
            <span>专用 HTTP 端口</span>
            <input
              aria-label="专用 HTTP 端口"
              placeholder="关闭"
              type="number"
              min={1024}
              max={65535}
              value={plan.httpPort ?? ''}
              onChange={(event) => {
                const { httpPort: _previous, ...rest } = plan
                onChange({
                  ...rest,
                  ...(event.target.value ? { httpPort: Number(event.target.value) } : {})
                })
              }}
            />
          </div>
          <div className="relay-setting-row">
            <span>专用 SOCKS 端口</span>
            <input
              aria-label="专用 SOCKS 端口"
              placeholder="关闭"
              type="number"
              min={1024}
              max={65535}
              value={plan.socksPort ?? ''}
              onChange={(event) => {
                const { socksPort: _previous, ...rest } = plan
                onChange({
                  ...rest,
                  ...(event.target.value ? { socksPort: Number(event.target.value) } : {})
                })
              }}
            />
          </div>
          <div className="relay-setting-row">
            <span>固定节点名称</span>
            <select
              aria-label="专用监听固定节点"
              value={plan.route}
              onChange={(event) => onChange({ ...plan, route: event.target.value })}
            >
              {!nodes.includes(plan.route) && (
                <option value={plan.route}>{plan.route}（保存的节点）</option>
              )}
              {nodes.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="light"
              isDisabled={disabled || pending || !profile}
              onPress={() => void readNodes(false)}
            >
              读取节点
            </Button>
          </div>
          <p className="relay-network-state">
            至少填写一个独立端口；空白表示关闭。计划保存后在下次核心启动时应用，并在重开 Relay
            后沿用。固定节点会单独保存，切换订阅时继续沿用；端口被占用时拒绝启动，不回退直连。
          </p>
        </>
      )}
      {notice && (
        <p role="status" className="relay-network-state">
          {notice}
        </p>
      )}
    </fieldset>
  )
}
