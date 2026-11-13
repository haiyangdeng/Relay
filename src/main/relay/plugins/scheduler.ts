import {
  pluginId,
  type RelayPluginRoute,
  type RelayPluginSchedulerState
} from '../../../shared/relay/plugins'
import { computeBackoff } from '../../resolve/plugin/backoff'

export interface PluginSchedulePermission {
  id: string
  name: string
  route: RelayPluginRoute
  origins: string[]
  revision: string
  discoveryRevision: string
}
export interface PluginSchedulePermit {
  permission: PluginSchedulePermission
  activate(): Promise<void>
  run(): Promise<{
    status: 'updated' | 'failed' | 'credentials' | 'changed' | 'uncertain' | 'cancelled'
  }>
  revoke(): void
}
type Entry = RelayPluginSchedulerState['entries'][number] & {
  permit: PluginSchedulePermit
  timer?: ReturnType<typeof setTimeout>
}
function selection(raw: unknown, schedule: true): { id: string; minutes: number }
function selection(raw: unknown, schedule: false): { id: string }
function selection(raw: unknown, schedule: boolean): { id: string; minutes?: number } {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== (schedule ? 'id,minutes' : 'id')
  )
    throw new Error('插件调度参数无效。')
  const input = raw as Record<string, unknown>,
    id = pluginId(input.id)
  if (
    schedule &&
    (typeof input.minutes !== 'number' ||
      !Number.isInteger(input.minutes) ||
      input.minutes < 1 ||
      input.minutes > 34560)
  )
    throw new Error('插件更新周期应为1至34560的整数分钟。')
  return { id, ...(schedule ? { minutes: input.minutes as number } : {}) }
}

export function createRelayPluginScheduler(adapters: {
  prepare(id: string): Promise<PluginSchedulePermit>
  canRun(): boolean
  confirm(permission: PluginSchedulePermission, minutes: number): Promise<boolean>
  notify?(): void
  now?(): number
  random?(): number
}) {
  const entries = new Map<string, Entry>(),
    now = adapters.now ?? Date.now,
    waiters: (() => void)[] = []
  let arming = false,
    armingId: string | undefined,
    armingPermit: PluginSchedulePermit | undefined,
    running: Entry | undefined,
    closing = false,
    suspended = false,
    generation = 0,
    stopPromise: Promise<void> | undefined
  const busy = (): boolean => arming || !!running || closing
  const changed = (): void => {
    if (!arming && !running) waiters.splice(0).forEach((resolve) => resolve())
    adapters.notify?.()
  }
  const waitForWork = (): Promise<void> =>
    arming || running ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const snapshot = (): RelayPluginSchedulerState => ({
    pending: busy(),
    ...(suspended ? { suspended: true } : {}),
    entries: [...entries.values()].map(({ permit: _permit, timer: _timer, ...entry }) => ({
      ...entry,
      origins: [...entry.origins]
    }))
  })
  const disable = (entry: Entry, status: Entry['lastStatus']): void => {
    entry.enabled = false
    entry.lastStatus = status
    entry.nextAt = undefined
    clearTimeout(entry.timer)
    entry.permit.revoke()
  }
  const schedule = (entry: Entry, delay = entry.minutes * 60000): void => {
    clearTimeout(entry.timer)
    if (entries.get(entry.id) !== entry || !entry.enabled || closing || suspended) return
    const at = now() + Math.max(60000, delay)
    entry.nextAt = new Date(at).toISOString()
    entry.timer = setTimeout(() => void fire(entry), at - now())
    entry.timer.unref?.()
  }
  const fire = async (entry: Entry): Promise<void> => {
    if (entries.get(entry.id) !== entry || !entry.enabled || closing || suspended) return
    if (running || arming || !adapters.canRun()) {
      entry.lastStatus = 'busy'
      schedule(entry, 60000)
      changed()
      return
    }
    running = entry
    entry.nextAt = undefined
    changed()
    let delay = entry.minutes * 60000
    try {
      const result = await entry.permit.run()
      // A stop that raced with completion remains stopped, even if a save completed.
      if (!entry.enabled || closing || suspended) return
      entry.lastStatus = result.status
      if (result.status === 'updated') entry.failureCount = 0
      else if (result.status === 'failed') {
        entry.failureCount = Math.min(32, entry.failureCount + 1)
        const failedAt = now()
        delay = Math.max(
          delay,
          computeBackoff(entry.failureCount - 1, failedAt, adapters.random).nextRetryAt - failedAt
        )
      } else disable(entry, result.status)
    } catch {
      if (entry.enabled) disable(entry, 'uncertain')
    } finally {
      running = undefined
      schedule(entry, delay)
      changed()
    }
  }
  const stop = (status: 'stopped' | 'suspended'): Promise<void> => {
    ++generation
    closing = true
    armingPermit?.revoke()
    entries.forEach((entry) => disable(entry, status))
    if (stopPromise) return stopPromise
    stopPromise = waitForWork().finally(() => {
      closing = false
      stopPromise = undefined
      changed()
    })
    changed()
    return stopPromise
  }
  return {
    state: snapshot,
    isBusy: busy,
    isBlocking: busy,
    async whenIdle(): Promise<void> {
      if (stopPromise) await stopPromise
      else await waitForWork()
    },
    async arm(raw: unknown): Promise<{
      status: 'armed' | 'cancelled'
      state: RelayPluginSchedulerState
    }> {
      const selected = selection(raw, true),
        minutes = selected.minutes
      if (busy() || suspended) throw new Error('插件调度操作尚未结束或系统正在挂起。')
      arming = true
      armingId = selected.id
      const epoch = generation
      let permit: PluginSchedulePermit | undefined,
        installed = false,
        status: 'armed' | 'cancelled' = 'cancelled'
      changed()
      const authorize = async (): Promise<'armed' | 'cancelled'> => {
        permit = await adapters.prepare(selected.id)
        armingPermit = permit
        if (permit.permission.id !== selected.id) throw new Error('插件授权记录不匹配。')
        if (closing || suspended || generation !== epoch) return 'cancelled'
        if (!(await adapters.confirm(structuredClone(permit.permission), minutes)))
          return 'cancelled'
        if (closing || suspended || generation !== epoch) return 'cancelled'
        await permit.activate()
        if (closing || suspended || generation !== epoch) return 'cancelled'
        const previous = entries.get(selected.id)
        if (previous) disable(previous, 'stopped')
        const permission = permit.permission,
          entry: Entry = {
            id: permission.id,
            name: permission.name,
            route: permission.route,
            origins: [...permission.origins],
            discoveryRevision: permission.discoveryRevision,
            minutes,
            enabled: true,
            failureCount: 0,
            lastStatus: 'armed',
            permit
          }
        entries.set(entry.id, entry)
        installed = true
        schedule(entry)
        return 'armed'
      }
      try {
        status = await authorize()
      } finally {
        if (!installed) permit?.revoke()
        arming = false
        armingId = undefined
        armingPermit = undefined
        changed()
      }
      return { status, state: snapshot() }
    },
    async disarm(raw: unknown): Promise<RelayPluginSchedulerState> {
      const { id } = selection(raw, false)
      if (armingId === id) {
        ++generation
        armingPermit?.revoke()
      }
      const entry = entries.get(id)
      if (entry) disable(entry, 'stopped')
      changed()
      if (armingId === id || running?.id === id) await waitForWork()
      return snapshot()
    },
    requestClose: (): Promise<void> => stop('stopped'),
    suspend(): Promise<void> {
      suspended = true
      return stop('suspended')
    },
    resume(): void {
      suspended = false
      changed()
    }
  }
}
