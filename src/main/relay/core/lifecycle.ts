import type { CoreLifecycleState, OwnedCoreObservation } from '../../../shared/relay/lifecycle'

// Power notifications invalidate uncommitted work; they do not stop, reload,
// restart, rebind system settings or adopt any process from a stored PID.
export function createCoreLifecycle(adapters: {
  invalidate(): void
  pauseScheduling(): Promise<void>
  resumeScheduling(): void
  observeCore(): Promise<OwnedCoreObservation>
  observeProxy(): Promise<OwnedCoreObservation>
  notify(): void
}) {
  let state: CoreLifecycleState = {
    phase: 'awake',
    generation: 0,
    core: 'none',
    localProxy: 'none',
    automaticRestartEnabled: false,
    observed: false,
    warnings: []
  }
  let tail: Promise<void> = Promise.resolve(),
    closed = false
  const snapshot = (): CoreLifecycleState => structuredClone(state)
  const publish = (): void => {
    adapters.notify()
  }
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    tail = tail.then(operation, operation).catch(() => {
      if (!closed) {
        state = {
          ...state,
          phase: 'attention',
          warnings: ['唤醒复核未确认；没有自动重载、重启或切换直连。']
        }
        publish()
      }
    })
    return tail
  }
  const verify = (): Promise<void> => {
    const generation = ++state.generation
    state = {
      ...state,
      phase: 'checking',
      observed: false,
      warnings: ['仅复核本次持有的核心与私有接口；不会自动重启、热载或修改系统网络。']
    }
    publish()
    return enqueue(async () => {
      if (closed || state.generation !== generation) return
      await adapters.pauseScheduling()
      if (closed || state.generation !== generation) return
      const observations = await Promise.allSettled([
        adapters.observeCore(),
        adapters.observeProxy()
      ])
      if (closed || state.generation !== generation) return
      const values = observations.map<OwnedCoreObservation>((result) =>
        result.status === 'fulfilled' ? result.value : 'unconfirmed'
      )
      const attention = values.some(
        (value) => value === 'unexpectedExit' || value === 'unconfirmed'
      )
      state = {
        ...state,
        observed: true,
        core: values[0],
        localProxy: values[1],
        phase: attention ? 'attention' : 'awake',
        warnings: attention
          ? [
              '本次核心退出或状态未确认；调度保持暂停，请人工复核后明确操作。没有自动重启或切换直连。'
            ]
          : ['本次核心状态已读取；若从挂起恢复，调度从新的完整周期开始，不补发睡眠期间的请求。']
      }
      if (!attention) adapters.resumeScheduling()
      publish()
    })
  }
  return {
    state: snapshot,
    whenIdle: (): Promise<void> => tail,
    suspend(): Promise<void> {
      if (closed) return tail
      ++state.generation
      state = {
        ...state,
        phase: 'asleep',
        observed: false,
        warnings: ['系统挂起：未提交凭据已失效，本次订阅调度暂停；在用核心保持原状。']
      }
      adapters.invalidate()
      publish()
      return enqueue(() => adapters.pauseScheduling())
    },
    resume(): Promise<void> {
      if (closed || state.phase !== 'asleep') return tail
      return verify()
    },
    recheck(): Promise<void> {
      if (closed || state.phase === 'checking' || state.phase === 'asleep') return tail
      return verify()
    },
    cancelClose(): void {
      if (!closed) return
      closed = false
      ++state.generation
      state = {
        ...state,
        phase: state.phase === 'asleep' ? 'asleep' : 'attention',
        core: 'unconfirmed',
        localProxy: 'unconfirmed',
        observed: false,
        warnings: ['退出已取消；请重新核对核心状态，调度未自动恢复。']
      }
      adapters.invalidate()
      publish()
    },
    async close(): Promise<void> {
      closed = true
      ++state.generation
      adapters.invalidate()
      await tail
    }
  }
}
