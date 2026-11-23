import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import { tunStatus, type TunStatus } from '../../../../shared/relay/tun'
import { relayProxyRunning } from './proxy-library-actions'

export const corePresentationKey = 'relay-core-presentation'
export interface CorePresentationSnapshot {
  local?: LocalProxyState
  tun?: TunStatus
}

export async function readCorePresentation(): Promise<CorePresentationSnapshot> {
  const ipc = window.electron.ipcRenderer
  const [local, tun] = await Promise.all([
    ipc.invoke('relayLocalProxyState').catch(() => undefined) as Promise<
      LocalProxyState | undefined
    >,
    ipc
      .invoke('relayTunStatus')
      .then(tunStatus)
      .catch(() => undefined)
  ])
  return { local, tun }
}

export function RelayCoreStatus({
  local,
  tun,
  sidebar,
  version
}: CorePresentationSnapshot & { sidebar?: boolean; version?: string }): React.JSX.Element {
  const session = tun?.session
  const ordinary = relayProxyRunning(local)
  const managed = session?.owned && session.phase === 'active' && session.traffic === 'forwarding'
  let label: string
  if (session?.pending || ['starting', 'stopping'].includes(session?.phase ?? '') || local?.pending)
    label = '操作进行中'
  else if (
    session?.phase === 'uncertain' ||
    session?.traffic === 'unconfirmed' ||
    local?.uncertain ||
    (managed && (ordinary || tun?.helper !== 'ready'))
  )
    label = '运行状态待核对'
  else if (managed) {
    label = sidebar ? 'TUN 托管' : '运行中 · TUN 托管'
    if (tun?.httpPort !== undefined) label += ` · 127.0.0.1:${tun.httpPort}`
  } else if (ordinary) {
    label = sidebar ? (version ?? '—') : '运行中'
    if (!sidebar && local?.httpPort !== undefined) label += ` · 127.0.0.1:${local.httpPort}`
  } else if (!session || !local) label = '待读取运行状态'
  else if (session.owned || local.owned || local.phase === 'unknown') label = '运行状态待核对'
  else label = '尚未运行'
  return (
    <span className="truncate" title={label}>
      {label}
    </span>
  )
}
