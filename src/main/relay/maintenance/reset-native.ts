import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  ownedResetID,
  ownedResetReport,
  type OwnedResetMode,
  type OwnedResetReport
} from '../../../shared/relay/owned-reset'
interface MaintenanceAddon {
  maintenance(json: string): Promise<string>
  invalidateMaintenanceIntents(): void
}
export class OwnedResetUnavailable extends Error {}
export function createOwnedResetBridge(adapters: {
  targetRoot: string
  inspect(): Promise<{ path: string; trusted: true; resourceSHA256: string }>
  require?(path: string): unknown
}) {
  if (
    !isAbsolute(adapters.targetRoot) ||
    resolve(adapters.targetRoot) !== adapters.targetRoot ||
    adapters.targetRoot.includes('\0') ||
    !adapters.targetRoot.endsWith('/Library/Application Support/Relay-Preview')
  )
    throw new Error('Main固定数据根未确认。')
  const expectedRootSHA256 = createHash('sha256').update(adapters.targetRoot, 'utf8').digest('hex')
  let addon: MaintenanceAddon | undefined,
    loaded: string | undefined,
    mode: OwnedResetMode | undefined,
    pending = false
  const load = async (): Promise<MaintenanceAddon> => {
    let resource: Awaited<ReturnType<typeof adapters.inspect>>
    try {
      resource = await adapters.inspect()
    } catch {
      throw new OwnedResetUnavailable('签名自有数据维护资源尚未配对；维护保持禁用。')
    }
    if (
      resource.trusted !== true ||
      !resource.path.startsWith('/') ||
      !resource.path.endsWith('/RelayGuard.node') ||
      resource.path.includes('\0') ||
      !/^[a-f0-9]{64}$/u.test(resource.resourceSHA256)
    )
      throw new OwnedResetUnavailable('维护资源身份未确认。')
    const identity = resource.path + ':' + resource.resourceSHA256
    if (loaded && loaded !== identity) throw new Error('已加载原生维护资源已变化，请保留现场。')
    if (!addon) {
      const raw = (adapters.require ?? createRequire(import.meta.url))(resource.path)
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof (raw as Partial<MaintenanceAddon>).maintenance !== 'function' ||
        typeof (raw as Partial<MaintenanceAddon>).invalidateMaintenanceIntents !== 'function'
      )
        throw new OwnedResetUnavailable('当前签名宿主尚不支持自有数据维护。')
      addon = raw as MaintenanceAddon
      loaded = identity
    }
    return addon
  }
  const request = async (
    action: 'acquire' | 'inspect' | 'reset' | 'restore' | 'cancel',
    input?: { mode: OwnedResetMode } | { evidenceID: string },
    assertCurrent: () => void = () => {}
  ): Promise<OwnedResetReport> => {
    if (pending) throw new Error('原生维护请求尚未完成。')
    pending = true
    try {
      const current = await load(),
        id = randomUUID()
      assertCurrent()
      const text = await current.maintenance(JSON.stringify({ version: 1, id, action, ...input }))
      if (typeof text !== 'string' || Buffer.byteLength(text) > 16384)
        throw new Error('维护回执过大。')
      const raw: unknown = JSON.parse(text)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('维护回执未知。')
      const {
        version,
        id: receivedID,
        action: receivedAction,
        ...observation
      } = raw as Record<string, unknown>
      if (version !== 1 || receivedID !== id || receivedAction !== action)
        throw new Error('维护回执不属于本次请求。')
      const result = ownedResetReport(observation)
      if (result.rootPathSHA256 && result.rootPathSHA256 !== expectedRootSHA256)
        throw new Error('原生维护根与Main固定根不匹配；保留现场。')
      if (mode && result.mode !== mode && result.mode !== 'unacquired')
        throw new Error('原生维护模式发生变化。')
      return result
    } finally {
      pending = false
    }
  }
  return {
    isBusy: () => pending,
    invalidate: () => addon?.invalidateMaintenanceIntents(),
    async acquire(next: OwnedResetMode): Promise<OwnedResetReport> {
      if (mode) throw new Error('维护独占模式仅可由Main初始化一次。')
      mode = next
      return request('acquire', { mode: next })
    },
    inspect: (assertCurrent?: () => void) => request('inspect', undefined, assertCurrent),
    reset: (evidenceID: string, assertCurrent?: () => void) =>
      request('reset', { evidenceID: ownedResetID(evidenceID) }, assertCurrent),
    restore: (evidenceID: string, assertCurrent?: () => void) =>
      request('restore', { evidenceID: ownedResetID(evidenceID) }, assertCurrent),
    cancel: (evidenceID?: string, assertCurrent?: () => void) =>
      request(
        'cancel',
        evidenceID ? { evidenceID: ownedResetID(evidenceID) } : undefined,
        assertCurrent
      )
  }
}
export type OwnedResetBridge = ReturnType<typeof createOwnedResetBridge>
