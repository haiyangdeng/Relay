import { useRef } from 'react'
import { Switch } from '@heroui/react'
import type { LocalProxyPorts } from '../../../../shared/relay/local-proxy-ports'

const rows = [
  { key: 'mixed', label: '混合端口', initial: 18194 },
  { key: 'socks', label: 'SOCKS 端口', initial: 18192 },
  { key: 'http', label: 'HTTP 端口', initial: 18191 },
  { key: 'redir', label: 'Redir 端口', initial: 18195 }
] as const

export function RelayLocalProxyPortsEditor({
  ports,
  livePorts,
  disabled,
  onChange
}: {
  ports: LocalProxyPorts
  livePorts?: LocalProxyPorts
  disabled: boolean
  onChange(ports: LocalProxyPorts): void
}): React.JSX.Element {
  const remembered = useRef<Partial<LocalProxyPorts>>({})
  return (
    <>
      {rows.map(({ key, label, initial }) => (
        <div className="relay-setting-row" key={key}>
          <span>{label}</span>
          <div className="flex items-center gap-3">
            <input
              aria-label={`本地 ${label}`}
              type="number"
              min={1024}
              max={65535}
              placeholder="关闭"
              value={ports[key] && Number.isFinite(ports[key]) ? ports[key] : ''}
              disabled={disabled || ports[key] === 0}
              onChange={(event) => {
                const value = event.target.value === '' ? NaN : Number(event.target.value)
                if (Number.isInteger(value) && value >= 1024 && value <= 65535)
                  remembered.current[key] = value
                onChange({ ...ports, [key]: value })
              }}
            />
            <Switch
              size="sm"
              aria-label={`启用${label}`}
              isSelected={ports[key] !== 0}
              isDisabled={disabled}
              onValueChange={(enabled) => {
                if (Number.isInteger(ports[key]) && ports[key] >= 1024 && ports[key] <= 65535)
                  remembered.current[key] = ports[key]
                onChange({ ...ports, [key]: enabled ? (remembered.current[key] ?? initial) : 0 })
              }}
            />
          </div>
        </div>
      ))}
      {livePorts && (
        <p className="relay-network-state" role="status">
          当前实际监听：
          {rows.map(({ key, label }) => `${label} ${livePorts[key] || '关闭'}`).join(' · ')}
        </p>
      )}
      <p className="relay-network-state">
        普通端口使用当前分流规则；至少开启 HTTP
        或混合端口。修改属于启动设置，保存后在下次核心启动时生效。 Redir
        仅开启监听，不会自动配置系统流量重定向。
      </p>
    </>
  )
}
