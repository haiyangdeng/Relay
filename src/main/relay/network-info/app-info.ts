import { performance } from 'perf_hooks'
import { isAbsolute } from 'path'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import type { ConnectionSnapshot } from '../../../shared/relay/observability'
import {
  connectionAppInfoRequest,
  type ConnectionAppInfo
} from '../../../shared/relay/connection-app-info'
const missing = (): ConnectionAppInfo => ({ status: 'unavailable', name: '', icon: '' })
type Owner = { instanceId: string; configurationRevision: string; pid: number }
export function createConnectionAppInfo(adapters: {
  home: string
  local(): LocalProxyState
  resolve(path: string): Promise<{ name: string; icon: string }>
}) {
  let epoch = 0,
    sequence = 0,
    latest = 0,
    pending = 0,
    owner: Owner | undefined,
    wall = 0,
    mono = 0
  const paths = new Map<string, string>()
  const current = (): Owner | undefined => {
    const state = adapters.local()
    return state.owned &&
      !state.pending &&
      !state.uncertain &&
      state.phase === 'running' &&
      state.traffic === 'listening' &&
      state.instanceId &&
      state.configurationRevision &&
      state.pid &&
      Number.isSafeInteger(state.pid) &&
      state.pid > 0
      ? {
          instanceId: state.instanceId,
          configurationRevision: state.configurationRevision,
          pid: state.pid
        }
      : undefined
  }
  const same = (left: Owner | undefined, right: Owner | undefined): boolean =>
    !!left &&
    !!right &&
    left.instanceId === right.instanceId &&
    left.configurationRevision === right.configurationRevision &&
    left.pid === right.pid
  const invalidate = (): void => {
    ++epoch
    owner = undefined
    paths.clear()
    wall = 0
    mono = 0
  }
  const allowed = (path: unknown): path is string =>
    typeof path === 'string' &&
    isAbsolute(path) &&
    path.length <= 4096 &&
    ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !path.split('/').includes('..') &&
    path.split('/').some((part) => part.toLowerCase().endsWith('.app')) &&
    [
      '/Applications/',
      '/System/Applications/',
      '/System/Library/',
      adapters.home + '/Applications/'
    ].some((root) => path.startsWith(root))
  const fresh = (): boolean => {
    const now = Date.now(),
      tick = performance.now()
    return wall > 0 && now >= wall && tick >= mono && now - wall < 15000 && tick - mono < 15000
  }
  return {
    invalidate,
    ticket() {
      const next = current()
      if (!same(owner, next)) {
        invalidate()
        owner = next
      }
      return next ? { epoch, sequence: ++sequence, owner: { ...next } } : undefined
    },
    observe(
      ticket: { epoch: number; sequence: number; owner: Owner } | undefined,
      snapshot: ConnectionSnapshot | undefined
    ): void {
      if (
        !ticket ||
        !snapshot ||
        ticket.epoch !== epoch ||
        ticket.sequence < latest ||
        !same(ticket.owner, owner) ||
        !same(owner, current())
      )
        return
      latest = ticket.sequence
      paths.clear()
      wall = Date.now()
      mono = performance.now()
      for (const value of snapshot.connections.slice(0, 200)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const row = value as Record<string, unknown>,
          metadata = row.metadata
        if (
          typeof row.id !== 'string' ||
          row.id.length > 256 ||
          !metadata ||
          typeof metadata !== 'object' ||
          Array.isArray(metadata)
        )
          continue
        const path = (metadata as Record<string, unknown>).processPath
        if (allowed(path)) paths.set(row.id, path)
      }
    },
    async read(input: unknown, assertCurrent: () => void): Promise<ConnectionAppInfo> {
      const request = connectionAppInfoRequest(input),
        captured = owner,
        generation = epoch,
        path = paths.get(request.connectionId)
      const live = (): boolean =>
        same(owner, captured) &&
        same(owner, current()) &&
        generation === epoch &&
        fresh() &&
        paths.get(request.connectionId) === path &&
        request.instanceId === owner?.instanceId &&
        request.configurationRevision === owner.configurationRevision
      assertCurrent()
      if (!path || !live() || pending >= 4) return missing()
      ++pending
      try {
        const result = await adapters.resolve(path)
        assertCurrent()
        if (
          !live() ||
          typeof result.name !== 'string' ||
          typeof result.icon !== 'string' ||
          result.icon.length > 32768 ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(result.icon)
        )
          return missing()
        const bytes = Buffer.from(result.icon.slice('data:image/png;base64,'.length), 'base64')
        if (
          bytes.length < 33 ||
          bytes.toString('base64') !== result.icon.slice('data:image/png;base64,'.length) ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.toString('ascii', 12, 16) !== 'IHDR' ||
          bytes.readUInt32BE(16) < 1 ||
          bytes.readUInt32BE(20) < 1 ||
          bytes.readUInt32BE(16) > 128 ||
          bytes.readUInt32BE(20) > 128
        )
          return missing()
        const name = [...result.name]
          .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
          .join('')
          .slice(0, 120)
        return { status: 'found', name, icon: result.icon }
      } catch {
        return missing()
      } finally {
        --pending
      }
    }
  }
}
