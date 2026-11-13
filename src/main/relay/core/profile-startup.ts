import type {
  LocalProxyPreparation,
  localProxyPrepare,
  LocalProxyResult,
  LocalProxyState
} from '../../../shared/relay/local-proxy'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'
import {
  localProxyPlanRecord,
  type LocalProxyPlanRecord
} from '../../../shared/relay/local-proxy-plan'

export function createProfileStartup(adapters: {
  readSelection(): Promise<RelayProfileSelection | undefined>
  readPlan(): Promise<LocalProxyPlanRecord>
  resolveSelection?(current: () => void): Promise<RelayProfileSelection | undefined>
  state(): Pick<
    LocalProxyState,
    'owned' | 'pending' | 'uncertain' | 'hasRecord' | 'traffic' | 'phase'
  >
  context(): () => void
  waitForInventory?(current: () => void): Promise<boolean>
  prepare(
    input: Pick<
      ReturnType<typeof localProxyPrepare>,
      'profile' | 'httpPort' | 'resolverMode' | 'lifetime'
    > &
      Partial<Pick<ReturnType<typeof localProxyPrepare>, 'dedicated' | 'ports'>>
  ): Promise<Pick<LocalProxyPreparation, 'evidenceId' | 'canStart'>>
  start(evidenceId: string, current: () => void): Promise<Pick<LocalProxyResult, 'status'>>
  invalidate(): void
}) {
  let attempted = false,
    cancelled = false,
    running = false
  let operation: Promise<'started' | 'skipped' | 'cancelled' | 'failed'> | undefined
  const cancel = (): void => {
    attempted = true
    cancelled = true
    if (running) adapters.invalidate()
  }
  return {
    run(): Promise<'started' | 'skipped' | 'cancelled' | 'failed'> {
      if (attempted) return operation ?? Promise.resolve('skipped')
      attempted = true
      running = true
      operation = (async () => {
        let prepared = false
        try {
          const live = adapters.context()
          const current = (): void => {
            if (cancelled) throw new Error('Startup superseded')
            live()
          }
          current()
          const state = adapters.state()
          if (
            state.owned ||
            state.pending ||
            state.uncertain ||
            state.hasRecord ||
            state.traffic !== 'inactive' ||
            !['unknown', 'idle', 'failed'].includes(state.phase)
          )
            return 'skipped'
          const selection = await (adapters.resolveSelection?.(current) ?? adapters.readSelection())
          current()
          if (!selection) return 'skipped'
          const startupPlan = localProxyPlanRecord(await adapters.readPlan())
          current()
          await adapters.waitForInventory?.(current)
          current()
          // Selection resolution pins and remembers a verified default when
          // necessary. Never restore an unknown owner or change proxy/TUN here.
          const plan = await adapters.prepare({
            profile: selection,
            ...startupPlan.document,
            lifetime: 'main'
          })
          prepared = plan.canStart
          current()
          if (!plan.canStart) return 'skipped'
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
            // A list may begin during the preference read. If we had to wait,
            // revalidate the selection before submitting the prepared start.
          } while (await adapters.waitForInventory?.(current))
          current()
          const result = await adapters.start(plan.evidenceId, current)
          return result.status === 'started' ? 'started' : cancelled ? 'cancelled' : 'failed'
        } catch {
          if (prepared && !cancelled) adapters.invalidate()
          return cancelled ? 'cancelled' : 'failed'
        } finally {
          running = false
        }
      })()
      return operation
    },
    cancel,
    cancelAndWait(): Promise<void> | undefined {
      cancel()
      return running ? operation?.then(() => undefined) : undefined
    }
  }
}
