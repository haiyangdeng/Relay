import { Cron } from 'croner'
import { profileSelection } from '../../../shared/relay/runtime'
import {
  sourceSelection,
  type SourceSchedule,
  type SourceSchedulerState,
  type SubscriptionSourceInfo,
  type SubscriptionSourceSelection,
  type SourceOptions,
  type SourceMetadata,
  type SubscriptionSourceResult
} from '../../../shared/relay/subscription-sources'

// The timer only needs this projection, so Geo sources can reuse the same
// scheduler without inventing subscription request/version/cache records.
export interface SourceScheduleRecord {
  info: Pick<SubscriptionSourceInfo, 'id' | 'revision' | 'name' | 'origin' | 'locked'>
  options: Pick<SourceOptions, 'schedule' | 'useServerInterval'>
  originRevision: string
  cache?: { metadata: Pick<SourceMetadata, 'intervalMinutes'> }
}
type Entry = SourceSchedulerState['entries'][number] & {
  originRevision: string
  timer?: ReturnType<typeof setTimeout>
}
export function effectiveSourceSchedule(stored: SourceScheduleRecord): SourceSchedule {
  return stored.options.useServerInterval && stored.cache?.metadata.intervalMinutes
    ? { kind: 'interval', minutes: stored.cache.metadata.intervalMinutes }
    : stored.options.schedule
}
export function nextSourceRun(schedule: SourceSchedule, at: number): number | undefined {
  if (schedule.kind === 'manual') return undefined
  if (schedule.kind === 'interval') return at + schedule.minutes * 60000
  const cron = new Cron(schedule.expression, { paused: true })
  try {
    return cron.nextRun(new Date(at + 59999))?.getTime()
  } finally {
    cron.stop()
  }
}
export function createSourceScheduler<T extends SourceScheduleRecord>(adapters: {
  store: {
    read(selection: SubscriptionSourceSelection): Promise<T>
    readId(id: string): Promise<T>
  }
  canRun(): boolean
  run(id: string, originRevision: string): Promise<SubscriptionSourceResult>
  requestStop(): Promise<void>
  confirm(source: T['info'], schedule: SourceSchedule): Promise<boolean>
  now?(): number
}) {
  const entries = new Map<string, Entry>(),
    now = adapters.now ?? Date.now,
    idle: (() => void)[] = []
  let arming = false,
    running: Entry | undefined,
    closing = false,
    suspended = false,
    generation = 0,
    executionGeneration = 0
  const settle = (): void => {
    if (!arming && !running && !closing) idle.splice(0).forEach((resolve) => resolve())
  }
  const snapshot = (): SourceSchedulerState => ({
    pending: arming || !!running || closing,
    ...(suspended ? { suspended: true } : {}),
    entries: [...entries.values()].map(
      ({ originRevision: _origin, timer: _timer, ...publicEntry }) => publicEntry
    )
  })
  const schedule = (entry: Entry, retry = false): void => {
    clearTimeout(entry.timer)
    if (!entry.enabled || closing || suspended) return
    const at = retry ? now() + 60000 : nextSourceRun(entry.schedule, now())
    if (at === undefined) {
      entry.enabled = false
      entry.lastStatus = 'noNextRun'
      entry.nextAt = undefined
      return
    }
    entry.nextAt = new Date(at).toISOString()
    waitUntil(entry, at, 60000)
  }
  const waitUntil = (entry: Entry, at: number, minimum = 1): void => {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(
      () => void fire(entry),
      Math.min(2147483647, Math.max(minimum, at - now()))
    )
    entry.timer.unref?.()
  }
  const fire = async (entry: Entry): Promise<void> => {
    if (entries.get(entry.id) !== entry || !entry.enabled || closing || suspended) return
    const at = entry.nextAt === undefined ? undefined : Date.parse(entry.nextAt)
    if (at !== undefined && now() < at) {
      // Long cron waits use bounded timer chunks, not an early execution or a
      // newly computed cron occurrence. Preserve the original authorized date.
      waitUntil(entry, at)
      return
    }
    if (running || arming || !adapters.canRun()) {
      entry.lastStatus = 'busy'
      schedule(entry, true)
      return
    }
    const epoch = executionGeneration
    let delegated = false,
      settled = false
    running = entry
    entry.nextAt = undefined
    try {
      const stored = await adapters.store.readId(entry.id)
      if (epoch !== executionGeneration || !entry.enabled || closing || suspended) return
      if (stored.originRevision !== entry.originRevision || stored.info.locked) {
        entry.enabled = false
        entry.lastStatus = 'sourceChanged'
        return
      }
      delegated = true
      const result = await adapters.run(entry.id, entry.originRevision)
      settled = true
      if (result.status === 'uncertain') {
        entry.lastStatus = result.status
        entry.enabled = false
        entry.nextAt = undefined
        clearTimeout(entry.timer)
        return
      }
      if (epoch !== executionGeneration || !entry.enabled || closing || suspended) return
      entry.lastStatus = result.status
      const after = await adapters.store.readId(entry.id)
      if (epoch !== executionGeneration || !entry.enabled || closing || suspended) return
      if (after.originRevision !== entry.originRevision) {
        entry.enabled = false
        entry.lastStatus = 'sourceChanged'
        return
      }
      entry.schedule = effectiveSourceSchedule(after)
    } catch {
      if (epoch === executionGeneration || (delegated && !settled)) {
        entry.enabled = false
        entry.lastStatus = 'unconfirmed'
        entry.nextAt = undefined
        clearTimeout(entry.timer)
      }
    } finally {
      running = undefined
      // resume may already own a new wake-time timer. An old awaited fire must
      // neither run nor replace that timer after its execution epoch expires.
      if (epoch === executionGeneration) schedule(entry)
      settle()
    }
  }
  return {
    state: snapshot,
    async suspend(): Promise<void> {
      ++generation
      ++executionGeneration
      suspended = true
      entries.forEach((entry) => {
        clearTimeout(entry.timer)
        entry.nextAt = undefined
        if (entry.enabled) entry.lastStatus = 'suspended'
      })
      if (running) await adapters.requestStop()
    },
    resume(): void {
      if (!suspended) return
      suspended = false
      // Start the next interval from wake time; never replay missed runs.
      entries.forEach((entry) => {
        if (entry.enabled) schedule(entry)
      })
    },
    isBusy: (): boolean => arming || !!running || closing,
    whenIdle: (): Promise<void> =>
      arming || running || closing
        ? new Promise((resolve) => idle.push(resolve))
        : Promise.resolve(),
    async arm(
      raw: unknown
    ): Promise<{ status: 'armed' | 'cancelled'; state: SourceSchedulerState }> {
      const selected = sourceSelection(raw)
      if (arming || running || closing || suspended)
        throw new Error('调度操作尚未结束或系统正在挂起。')
      arming = true
      const epoch = generation
      try {
        const stored = await adapters.store.read(selected),
          effective = effectiveSourceSchedule(stored)
        if (
          stored.info.locked ||
          effective.kind === 'manual' ||
          nextSourceRun(effective, now()) === undefined
        )
          throw new Error('来源没有可用调度。')
        if (!(await adapters.confirm(stored.info, effective)) || closing || generation !== epoch)
          return { status: 'cancelled', state: snapshot() }
        await adapters.store.read(selected)
        if (closing || suspended || generation !== epoch)
          return { status: 'cancelled', state: snapshot() }
        const previous = entries.get(selected.id)
        if (previous) clearTimeout(previous.timer)
        const entry: Entry = {
          id: stored.info.id,
          name: stored.info.name,
          origin: stored.info.origin,
          schedule: effective,
          enabled: true,
          originRevision: stored.originRevision
        }
        entries.set(entry.id, entry)
        schedule(entry)
        return { status: 'armed', state: snapshot() }
      } finally {
        arming = false
        settle()
      }
    },
    async disarm(raw: unknown): Promise<SourceSchedulerState> {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).join(',') !== 'id'
      )
        throw new Error('只接受调度来源ID。')
      const id = profileSelection({ id: (raw as { id: unknown }).id, sha256: '0'.repeat(64) }).id,
        entry = entries.get(id)
      // A stop also revokes any in-flight arming consent/final source read.
      ++generation
      if (entry) {
        entry.enabled = false
        entry.nextAt = undefined
        entry.lastStatus = 'stopped'
        clearTimeout(entry.timer)
      }
      if (running?.id === id) {
        ++executionGeneration
        await adapters.requestStop()
      }
      return snapshot()
    },
    async requestClose(): Promise<void> {
      ++generation
      ++executionGeneration
      closing = true
      entries.forEach((entry) => {
        entry.enabled = false
        entry.nextAt = undefined
        entry.lastStatus = 'stopped'
        clearTimeout(entry.timer)
      })
      try {
        if (running) await adapters.requestStop()
      } finally {
        closing = false
        settle()
      }
    }
  }
}
