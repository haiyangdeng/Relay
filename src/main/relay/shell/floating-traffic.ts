import {
  copyFloatingTrafficSample,
  floatingTrafficFreshMS,
  type RelayFloatingTrafficSample,
  type RelayFloatingTrafficSnapshot
} from '../../../shared/relay/floating-traffic'

const pollMS = 1000

export function createFloatingTrafficController(adapters: {
  readTraffic(signal: AbortSignal): Promise<RelayFloatingTrafficSample | undefined>
  publish(snapshot: RelayFloatingTrafficSnapshot): void
  wallNow?(): number
  monotonicNow?(): number
}) {
  // Capture the Main-owned adapter methods. The floating view supplies no path,
  // instance selector or Core authority; the backend verifies its held owner.
  const readTraffic = adapters.readTraffic,
    publish = adapters.publish,
    wallNow = adapters.wallNow ?? Date.now,
    monotonicNow = adapters.monotonicNow ?? (() => performance.now())
  let current: RelayFloatingTrafficSnapshot = Object.freeze({ version: 1, status: 'hidden' })
  let visible = false,
    disposed = false,
    epoch = 0
  let pending: { controller: AbortController; epoch: number } | undefined
  let lastReadStart: number | undefined
  let nextTimer: ReturnType<typeof setTimeout> | undefined,
    expiryTimer: ReturnType<typeof setTimeout> | undefined
  let freshness: { wall: number; mono: number; remaining: number } | undefined

  const time = (clock: () => number): number => {
    try {
      return clock()
    } catch {
      return Number.NaN
    }
  }

  const clearTimers = (): void => {
    clearTimeout(nextTimer)
    clearTimeout(expiryTimer)
    nextTimer = undefined
    expiryTimer = undefined
    freshness = undefined
  }
  const shutdown = (): void => {
    disposed = true
    visible = false
    ++epoch
    clearTimers()
    pending?.controller.abort()
    current = Object.freeze({ version: 1, status: 'hidden' })
  }
  const emit = (snapshot: RelayFloatingTrafficSnapshot): void => {
    current = snapshot
    try {
      publish(snapshot)
    } catch {
      // A broken display observer ends only its own polling lane.
      shutdown()
    }
  }
  const unavailable = (): void => {
    clearTimeout(expiryTimer)
    expiryTimer = undefined
    freshness = undefined
    emit(Object.freeze({ version: 1, status: 'unavailable' }))
  }
  const fresh = (): boolean => {
    if (!freshness) return false
    const wall = time(wallNow),
      mono = time(monotonicNow)
    return (
      Number.isFinite(wall) &&
      Number.isFinite(mono) &&
      wall >= freshness.wall &&
      mono >= freshness.mono &&
      wall - freshness.wall < freshness.remaining &&
      mono - freshness.mono < freshness.remaining
    )
  }
  const begin = (): void => {
    if (!visible || disposed || pending) return
    const started = time(monotonicNow)
    if (!Number.isFinite(started) || !Number.isFinite(time(wallNow))) {
      unavailable()
      return
    }
    if (lastReadStart !== undefined) {
      if (started < lastReadStart) {
        unavailable()
        return
      }
      const remaining = pollMS - (started - lastReadStart)
      if (remaining > 0) {
        clearTimeout(nextTimer)
        nextTimer = setTimeout(() => {
          nextTimer = undefined
          begin()
        }, remaining)
        return
      }
    }
    const operation = { controller: new AbortController(), epoch }
    pending = operation
    const live = (): boolean =>
      visible &&
      !disposed &&
      pending === operation &&
      epoch === operation.epoch &&
      !operation.controller.signal.aborted
    void (async () => {
      try {
        // Hiding before this microtask starts must not dispatch a backend read.
        await Promise.resolve()
        if (!live()) return
        const wallStart = time(wallNow),
          actualStart = time(monotonicNow)
        if (
          !Number.isFinite(wallStart) ||
          !Number.isFinite(actualStart) ||
          (lastReadStart !== undefined && actualStart < lastReadStart)
        ) {
          unavailable()
          return
        }
        if (lastReadStart !== undefined && actualStart - lastReadStart < pollMS) return
        if (!live()) return
        // Preserve this fence across every visibility/owner epoch. Timestamp the
        // actual invocation after the microtask, including a synchronous throw.
        lastReadStart = actualStart
        const value = await readTraffic(operation.controller.signal)
        if (!live()) return
        const sample = copyFloatingTrafficSample(value),
          wall = time(wallNow),
          mono = time(monotonicNow)
        if (
          !sample ||
          !Number.isFinite(wall) ||
          !Number.isFinite(mono) ||
          wall < sample.receivedAt ||
          wall - sample.receivedAt >= floatingTrafficFreshMS ||
          !live()
        ) {
          unavailable()
          return
        }
        const snapshot = Object.freeze({ version: 1 as const, status: 'ready' as const, sample })
        clearTimeout(expiryTimer)
        freshness = { wall, mono, remaining: floatingTrafficFreshMS - (wall - sample.receivedAt) }
        emit(snapshot)
        if (live() && current === snapshot) {
          expiryTimer = setTimeout(() => {
            expiryTimer = undefined
            if (visible && !disposed && epoch === operation.epoch && current === snapshot)
              unavailable()
          }, freshness?.remaining ?? 0)
        }
      } catch {
        if (live()) unavailable()
      } finally {
        if (pending === operation) pending = undefined
        if (visible && !disposed) {
          const elapsed = lastReadStart === undefined ? pollMS : time(monotonicNow) - lastReadStart
          const delay =
            Number.isFinite(elapsed) && elapsed >= 0 ? Math.max(0, pollMS - elapsed) : pollMS
          nextTimer = setTimeout(() => {
            nextTimer = undefined
            begin()
          }, delay)
        }
      }
    })()
  }
  return {
    show(): void {
      if (disposed || visible) return
      visible = true
      ++epoch
      clearTimers()
      emit(Object.freeze({ version: 1, status: 'loading' }))
      begin()
    },
    hide(): void {
      if (disposed || !visible) return
      visible = false
      ++epoch
      clearTimers()
      pending?.controller.abort()
      emit(Object.freeze({ version: 1, status: 'hidden' }))
    },
    invalidate(): void {
      if (disposed) return
      ++epoch
      clearTimers()
      pending?.controller.abort()
      if (visible) {
        emit(Object.freeze({ version: 1, status: 'loading' }))
        begin()
      }
    },
    dispose(): void {
      if (disposed) return
      shutdown()
      emit(current)
    },
    state(): RelayFloatingTrafficSnapshot {
      if (current.status === 'ready' && !fresh()) unavailable()
      return current
    },
    isReading: (): boolean => !!pending
  }
}
