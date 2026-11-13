import { useEffect, useRef, useState } from 'react'
import { IoDesktopOutline } from 'react-icons/io5'
import type {
  ConnectionAppInfo,
  ConnectionAppInfoRequest
} from '../../../../shared/relay/connection-app-info'
export function RelayConnectionAppIcon({
  selection,
  disabled
}: {
  selection: ConnectionAppInfoRequest
  disabled: boolean
}): React.JSX.Element {
  const [info, setInfo] = useState<ConnectionAppInfo>(),
    [pending, setPending] = useState(false),
    operation = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    setInfo(undefined)
    const lifecycle = epoch
    return () => {
      mounted.current = false
      ++lifecycle.current
    }
  }, [selection.instanceId, selection.configurationRevision, selection.connectionId])
  const read = async (): Promise<void> => {
    if (disabled || operation.current) return
    operation.current = true
    setPending(true)
    const at = epoch.current
    try {
      const next = await window.electron.ipcRenderer.invoke('relayConnectionAppInfo', selection)
      if (mounted.current && at === epoch.current) setInfo(next)
    } catch {
      if (mounted.current && at === epoch.current)
        setInfo({ status: 'unavailable', name: '', icon: '' })
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
    }
  }
  return (
    <span>
      {info?.status === 'found' ? (
        <img
          width={24}
          height={24}
          src={info.icon}
          alt={info.name || '连接应用'}
          title={info.name}
        />
      ) : (
        <button
          type="button"
          className="relay-connection-icon"
          aria-label={info ? '应用图标不可用，点击重试' : '读取应用图标'}
          title={info ? '应用图标不可用，点击重试' : '读取应用图标'}
          disabled={disabled || pending}
          onClick={() => void read()}
        >
          <IoDesktopOutline size={26} />
        </button>
      )}
    </span>
  )
}
