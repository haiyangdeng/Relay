// Read-only observation helpers for the owned local proxy core: live
// connections snapshot, the bounded core log ring buffer, and an aggregate
// real-time traffic sample derived from the connections endpoint. These never
// mutate the core; close actions live on the owned runtime itself.
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import type { ConnectionSnapshot } from '../../../shared/relay/observability'
import type { RelayOwnedCore } from './owned-runtime'
export type { ConnectionSnapshot } from '../../../shared/relay/observability'

const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : NaN

export async function readConnections(
  session: Pick<RelayOwnedCore, 'read'>
): Promise<ConnectionSnapshot> {
  const value = await session.read('connections')
  const download = number(value.downloadTotal),
    upload = number(value.uploadTotal)
  if (
    !(Array.isArray(value.connections) || value.connections === null) ||
    !Number.isFinite(download) ||
    !Number.isFinite(upload)
  )
    throw new Error('本次核心连接快照无效，请重新读取。')
  return { connections: value.connections ?? [], download, upload }
}

export function readLogs(session: RelayOwnedCore | undefined): readonly string[] {
  return session?.logs?.() ?? []
}

export interface RuntimeProcessInfo {
  pid: number | undefined
  version: string | undefined
  mode: LocalProxyState['mode']
  phase: LocalProxyState['phase']
  httpPort: number | undefined
  ports?: LocalProxyState['ports']
  dedicated: LocalProxyState['dedicated']
}

export function runtimeProcessInfo(state: LocalProxyState): RuntimeProcessInfo {
  return {
    pid: state.pid,
    version: undefined,
    mode: state.mode,
    phase: state.phase,
    httpPort: state.httpPort,
    ...(state.ports ? { ports: state.ports } : {}),
    dedicated: state.dedicated
  }
}
