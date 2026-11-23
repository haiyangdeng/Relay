import { relayProxyCanPrepare } from '../../../shared/relay/local-proxy'
import type {
  LocalProxyPreparation,
  localProxyPrepare,
  LocalProxyResult,
  LocalProxyState
} from '../../../shared/relay/local-proxy'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'
import {
  localProxyPlanRecord,
  type LocalProxyPlan,
  type LocalProxyPlanRecord
} from '../../../shared/relay/local-proxy-plan'

export function createProfileStartup(adapters: {
  readSelection(): Promise<RelayProfileSelection | undefined>
  readPlan(): Promise<LocalProxyPlanRecord>
  onStarted?(current: () => void): Promise<void>
  resolveSelection?(current: () => void): Promise<RelayProfileSelection | undefined>
  selectOnClick?(current: () => void): Promise<RelayProfileSelection | undefined>
  state(): Pick<
    LocalProxyState,
    'owned' | 'pending' | 'uncertain' | 'hasRecord' | 'traffic' | 'phase'
  >
  context(): () => void
  waitForPorts?(plan: LocalProxyPlan, current: () => void): Promise<boolean>
  waitForInventory?(current: () => void): Promise<boolean>
  prepare(
    input: Pick<
      ReturnType<typeof localProxyPrepare>,
      'profile' | 'httpPort' | 'resolverMode' | 'lifetime'
    > &
      Partial<Pick<ReturnType<typeof localProxyPrepare>, 'dedicated' | 'ports'>>
  ): Promise<
    Pick<LocalProxyPreparation, 'evidenceId' | 'canStart' | 'hasRecord'> &
      Partial<Pick<LocalProxyPreparation, 'warnings'>>
  >
  start(
    evidenceId: string,
    current: () => void
  ): Promise<Pick<LocalProxyResult, 'status'> & { state?: Pick<LocalProxyState, 'warnings'> }>
  invalidate(): void
}) {
  let attempted = false,
    cancelled = false,
    running = false
  let operation: Promise<'started' | 'skipped' | 'cancelled' | 'failed'> | undefined
  let generation = 0
  let manualRun = false
  let failure: unknown
  const cancel = (): void => {
    ++generation
    attempted = true
    cancelled = true
    if (running) adapters.invalidate()
  }
  const begin = (click?: () => void) => {
    manualRun = !!click
    cancelled = false
    failure = undefined
    attempted = true
    running = true
    operation = (async () => {
      let prepared = false
      try {
        const live = click ?? adapters.context()
        const current = (): void => {
          if (cancelled) throw new Error('Startup superseded')
          live()
        }
        current()
        const state = adapters.state()
        if (!relayProxyCanPrepare(state) || (!click && state.phase === 'blocked')) {
          if (click)
            failure = new Error(
              state.pending
                ? '普通代理正在处理上一次操作。'
                : '普通代理上次会话尚未确认结束，请查看内核设置。'
            )
          return 'skipped'
        }
        const resolve = click ? adapters.selectOnClick : adapters.resolveSelection
        const selection = await (resolve?.(current) ?? adapters.readSelection())
        current()
        if (!selection) {
          if (click) throw new Error('请先导入订阅或本地配置，再开启系统代理。')
          return 'skipped'
        }
        const startupPlan = localProxyPlanRecord(await adapters.readPlan())
        current()
        await adapters.waitForInventory?.(current)
        current()
        const recheckBeforeMutation = async (): Promise<void> => {
          // Inventory reads can begin while reading the plan or selection.
          do {
            const selected = await adapters.readSelection()
            current()
            if (selected?.id !== selection.id || selected.sha256 !== selection.sha256)
              throw new Error('Selected profile changed during startup')
            const latestPlan = localProxyPlanRecord(await adapters.readPlan())
            current()
            if (
              latestPlan.revision !== startupPlan.revision ||
              JSON.stringify(latestPlan.document) !== JSON.stringify(startupPlan.document)
            )
              throw new Error('Local proxy startup plan changed during startup')
          } while (await adapters.waitForInventory?.(current))
          current()
        }
        const prepare = () =>
          adapters.prepare({
            profile: selection,
            ...startupPlan.document,
            lifetime: 'main'
          })
        let plan = await prepare()
        prepared = plan.canStart
        current()
        if (!plan.canStart && plan.hasRecord === false && adapters.waitForPorts) {
          // A clean TUN quit can leave privileged TCP connections in TIME_WAIT.
          const currentOwner = (): void => {
            current()
            if (!relayProxyCanPrepare(adapters.state())) throw new Error('Startup owner changed')
          }
          currentOwner()
          const available = await adapters.waitForPorts(startupPlan.document, currentOwner)
          currentOwner()
          if (!available) {
            if (click) failure = new Error(plan.warnings?.[0] ?? '普通代理监听端口不可用。')
            return 'skipped'
          }
          await recheckBeforeMutation()
          currentOwner()
          plan = await prepare()
          prepared = plan.canStart
          current()
        }
        if (!plan.canStart) {
          if (click) failure = new Error(plan.warnings?.[0] ?? '普通代理启动准备未完成。')
          return 'skipped'
        }
        await recheckBeforeMutation()
        const result = await adapters.start(plan.evidenceId, current)
        prepared = false
        current()
        if (result.status !== 'started') {
          if (result.status === 'cancelled' || cancelled) {
            failure = new Error('普通代理启动已取消。')
            return 'cancelled'
          }
          failure = new Error(result.state?.warnings[0] ?? '普通代理核心启动未完成。')
          return 'failed'
        }
        if (!click) await adapters.onStarted?.(current)
        return 'started'
      } catch (error) {
        failure = error
        if (prepared && !cancelled) adapters.invalidate()
        return cancelled ? 'cancelled' : 'failed'
      } finally {
        running = false
      }
    })()
    return operation
  }
  return {
    run(): Promise<'started' | 'skipped' | 'cancelled' | 'failed'> {
      if (attempted) return operation ?? Promise.resolve('skipped')
      return begin()
    },
    whenIdle: () => (running ? operation?.then(() => {}) : undefined),
    async startOnClick(current: () => void): Promise<void> {
      const epoch = generation
      // A click during cold start must join it, not invalidate its proof.
      const joinedClick = running && manualRun
      if (running) await operation
      current()
      if (epoch !== generation) throw new Error('本次启动已取消。')
      if (adapters.state().owned) return
      if (!joinedClick) {
        // A second caller may have begun the click while the cold start settled.
        const result = await (running ? operation : begin(current))
        current()
        if (result === 'started') return
      }
      throw failure instanceof Error ? failure : new Error('普通代理未就绪，请核对端口和运行状态。')
    },
    cancel,
    cancelAndWait(): Promise<void> | undefined {
      cancel()
      return running ? operation?.then(() => undefined) : undefined
    }
  }
}
