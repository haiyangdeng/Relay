import {
  floatingTrafficFreshMS,
  parseFloatingTrafficSnapshot,
  relayFloatingTrafficChannel,
  type RelayFloatingTrafficSnapshot
} from '../shared/relay/floating-traffic'

export interface ReadonlyFloatingBridge {
  onSnapshot(listener: (snapshot: RelayFloatingTrafficSnapshot) => void): () => void
}
type Receiver = (_event: unknown, ...args: unknown[]) => void
interface FloatingIO {
  on(channel: typeof relayFloatingTrafficChannel, listener: Receiver): void
  removeListener(channel: typeof relayFloatingTrafficChannel, listener: Receiver): void
}

// One fixed inbound channel only. This bridge grants no Core/window/file or
// generic invoke/send API. Main still owns sender/window and view-epoch checks.
export function createReadonlyFloatingBridge(
  io: FloatingIO,
  clock = { now: () => Date.now(), tick: () => performance.now() }
): { api: ReadonlyFloatingBridge; dispose(): void } {
  const listeners = new Set<(snapshot: RelayFloatingTrafficSnapshot) => void>()
  let snapshot: RelayFloatingTrafficSnapshot = { version: 1, status: 'loading' },
    receiptWall = clock.now(),
    receiptTick = clock.tick(),
    allowance = 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    disposed = false
  const unavailable = (): RelayFloatingTrafficSnapshot =>
    Object.freeze({ version: 1, status: 'unavailable' })
  const current = (): RelayFloatingTrafficSnapshot => {
    if (snapshot.status !== 'ready') return snapshot
    const now = clock.now(),
      wall = now - receiptWall,
      tick = clock.tick() - receiptTick,
      age = now - snapshot.sample.receivedAt
    if (!(
      wall >= 0 &&
      wall < allowance &&
      tick >= 0 &&
      tick < allowance &&
      age >= 0 &&
      age < floatingTrafficFreshMS
    )) {
      snapshot = unavailable()
      clearTimeout(timer)
    }
    return snapshot
  }
  const deliver = (listener: (value: RelayFloatingTrafficSnapshot) => void): void => {
    try {
      listener(current())
    } catch {
      listeners.delete(listener)
    }
  }
  const publish = (): void => {
    for (const listener of [...listeners]) if (listeners.has(listener)) deliver(listener)
  }
  const receive: Receiver = (_event, ...args) => {
    if (disposed) return
    clearTimeout(timer)
    snapshot =
      args.length === 1 ? (parseFloatingTrafficSnapshot(args[0]) ?? unavailable()) : unavailable()
    receiptWall = clock.now()
    receiptTick = clock.tick()
    if (snapshot.status === 'ready') {
      const age = receiptWall - snapshot.sample.receivedAt
      allowance = floatingTrafficFreshMS - age
      if (!(age >= 0 && age < floatingTrafficFreshMS)) snapshot = unavailable()
      else
        timer = setTimeout(() => {
          snapshot = unavailable()
          publish()
        }, allowance)
    }
    publish()
  }
  io.on(relayFloatingTrafficChannel, receive)
  return {
    api: Object.freeze({
      onSnapshot(listener: (value: RelayFloatingTrafficSnapshot) => void): () => void {
        if (disposed || typeof listener !== 'function') return () => {}
        if (listeners.size >= 32) throw new Error('浮窗订阅数量超限。')
        const before = snapshot
        current()
        if (snapshot !== before) publish()
        listeners.add(listener)
        deliver(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }),
    dispose(): void {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      listeners.clear()
      io.removeListener(relayFloatingTrafficChannel, receive)
    }
  }
}
