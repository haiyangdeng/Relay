import { createHash } from 'node:crypto'
import {
  guardManagementAction,
  type GuardManagementAction,
  type GuardManagementSnapshot
} from '../../../shared/relay/guard-management'
import {
  LocalProxyMutationRefused,
  type LocalRuntimeCaptureResult
} from '../core/local-proxy-service'
import { GuardNativeUnavailable, type GuardNativeBridge } from './native-addon'

const changesConfiguration = (action: GuardManagementAction): boolean =>
  action === 'install' || action === 'enable' || action === 'disable'

// Main-only lifecycle coordinator. Capture and PID come from the owned Core;
// renderer actions never carry configuration, identity, endpoints or readiness.
export function createGuardManagementService(adapters: {
  bridge: GuardNativeBridge
  assertIdle(): void
  capture(signal: AbortSignal): Promise<LocalRuntimeCaptureResult>
  owned(): { instanceId?: string; pid?: number }
  additionalActivity?(): boolean
  notify?(): void
}) {
  let report: GuardManagementSnapshot | undefined,
    operating = false,
    uncertain = false,
    configurationUnconfirmed = false,
    bound = false
  let changingRuntime = false
  let enabledConfigurationObserved = false
  const unavailable = (): GuardManagementSnapshot => ({
    phase: 'unavailable',
    pending: false,
    systemOperationAttempted: false,
    protectionVerified: false,
    runtimeEnforcement: 'notVerified',
    reason: 'nativeModuleUnavailable'
  })
  const unresolved = (): boolean => uncertain || configurationUnconfirmed
  const state = (): GuardManagementSnapshot => ({
    ...(report ? structuredClone(report) : unavailable()),
    ...(unresolved() ? { phase: 'uncertain' as const } : {}),
    pending: operating || adapters.bridge.pending()
  })
  const settledState = (): GuardManagementSnapshot => ({
    ...state(),
    pending: adapters.bridge.pending() || report?.pending === true
  })
  const accept = (
    next: GuardManagementSnapshot,
    action: GuardManagementAction
  ): GuardManagementSnapshot => {
    const configuration = next.configuration
    const configurationConfirmed =
      action !== 'revoke' &&
      !next.pending &&
      [
        'idle',
        'activationCompleted',
        'configurationEnabled',
        'configurationDisabled',
        'failedUnchanged'
      ].includes(next.phase) &&
      !!configuration &&
      (configuration.owned || (!configuration.exists && !configuration.enabled))
    // A successful proxy revoke can carry the controller's cached state. Only
    // a conclusive configuration reread resolves a possibly completed write.
    if (changesConfiguration(action) && next.systemOperationAttempted)
      configurationUnconfirmed = !configurationConfirmed
    else if (action === 'status' && configurationConfirmed) configurationUnconfirmed = false
    report =
      configurationUnconfirmed && action === 'revoke' && !configuration?.enabled
        ? { ...next, configuration: undefined }
        : next
    if (configuration?.owned && configuration.enabled) enabledConfigurationObserved = true
    else if (configurationConfirmed && !configuration.enabled) enabledConfigurationObserved = false
    uncertain = next.phase === 'uncertain' || next.policy?.phase === 'unconfirmed'
    bound =
      next.policy?.phase === 'unconfirmed' ||
      next.policy?.phase === 'preparedLocally' ||
      next.policy?.phase === 'prepared' ||
      next.policy?.phase === 'ready'
    return settledState()
  }
  const revoke = async (): Promise<void> => {
    if (!bound && !uncertain) return
    report = undefined
    try {
      const next = await adapters.bridge.request('revoke')
      if (next.pending || next.policy?.phase !== 'unbound') throw new Error('过滤会话撤销未确认。')
      accept(next, 'revoke')
    } catch {
      uncertain = true
      throw new Error('过滤会话撤销未确认；保留核心及宿主，不继续运行配置写入或退出。')
    }
  }
  return {
    state,
    isBlocking: () =>
      operating ||
      changingRuntime ||
      adapters.bridge.pending() ||
      unresolved() ||
      bound ||
      adapters.additionalActivity?.() === true,
    // Awaited before Core writes/stops. It does not call the public action gate
    // and therefore cannot deadlock on the Core's own pending operation.
    async beforeRuntimeMutation(): Promise<void> {
      if (
        operating ||
        changingRuntime ||
        adapters.bridge.pending() ||
        adapters.additionalActivity?.()
      )
        throw new LocalProxyMutationRefused('系统过滤或受限会话事务未结束，未更改核心。')
      changingRuntime = true
      try {
        await revoke()
        if (unresolved()) throw new Error('系统过滤状态未确认。')
      } catch {
        throw new LocalProxyMutationRefused('过滤租约撤销未确认或系统配置结果未知，未更改核心。')
      } finally {
        changingRuntime = false
      }
    },
    async inspectActivity(): Promise<'inactive' | 'active' | 'unknown'> {
      if (adapters.additionalActivity?.()) return 'active'
      if (operating || changingRuntime || adapters.bridge.pending()) return 'unknown'
      operating = true
      report = undefined
      try {
        const next = await adapters.bridge.request('status')
        accept(next, 'status')
        if (
          unresolved() ||
          next.pending ||
          ['blocked', 'unavailable', 'uncertain', 'checking'].includes(next.phase)
        )
          return 'unknown'
        if (bound || next.configuration?.enabled === true) return 'active'
        const configuration = next.configuration
        return configuration &&
          !configuration.enabled &&
          (configuration.owned || !configuration.exists)
          ? 'inactive'
          : 'unknown'
      } catch (error) {
        if (error instanceof GuardNativeUnavailable && !bound && !unresolved()) {
          report = unavailable()
        } else {
          uncertain = true
          report = undefined
        }
        return 'unknown'
      } finally {
        operating = false
        adapters.notify?.()
      }
    },
    invalidateIntent(): void {
      adapters.bridge.invalidateIntents()
      report = undefined
    },
    async requestClose(): Promise<boolean> {
      if (enabledConfigurationObserved) return false
      if (operating || changingRuntime || adapters.bridge.pending()) return false
      try {
        await revoke()
        return !enabledConfigurationObserved && !unresolved()
      } catch {
        return false
      }
    },
    async action(
      raw: unknown,
      assertCurrent: () => void = () => {}
    ): Promise<GuardManagementSnapshot> {
      assertCurrent()
      const action = guardManagementAction(raw)
      if (adapters.additionalActivity?.() && !['status', 'disable', 'revoke'].includes(action))
        throw new Error('请先结束本次受限 CLI，再更改系统过滤或代理绑定。')
      if (operating || changingRuntime || adapters.bridge.pending()) {
        if (action === 'status') return state()
        throw new Error('系统过滤管理事务尚未结束。')
      }
      adapters.assertIdle()
      operating = true
      report = undefined
      let attempted = false
      let bindingSubmitted = false
      try {
        if (action === 'prepare') {
          const signal = new AbortController().signal,
            captured = await adapters.capture(signal)
          if (captured.status !== 'captured') throw new Error('请先准备当前自有代理及专用监听。')
          const { capture } = captured
          await capture.assertOwner(signal)
          assertCurrent()
          const owner = adapters.owned()
          if (
            !capture.isCurrent() ||
            owner.instanceId !== capture.snapshot.instanceId ||
            !Number.isSafeInteger(owner.pid) ||
            !owner.pid
          )
            throw new Error('代理归属已变化。')
          const next = await adapters.bridge.bind(
            {
              instanceID: capture.snapshot.instanceId,
              configuration: capture.snapshot.configuration,
              pid: owner.pid
            },
            assertCurrent,
            () => {
              bindingSubmitted = true
            }
          )
          // Retain possible native binding before rechecking JS owner so a late
          // capture rejection always revokes the actual issued native lease.
          accept(next, action)
          const policy = next.policy
          if (
            next.pending ||
            next.phase === 'uncertain' ||
            !policy ||
            policy.phase === 'unconfirmed'
          )
            throw new Error('过滤会话绑定未确认。')
          if (policy.phase === 'unbound') bindingSubmitted = false
          else if (
            policy.instanceID !== capture.snapshot.instanceId ||
            policy.configurationSHA256 !==
              createHash('sha256').update(capture.snapshot.configuration).digest('hex')
          ) {
            if (next.phase !== 'blocked') throw new Error('过滤会话绑定未确认。')
            // A native refusal can report a previous, unrelated proof.
            bindingSubmitted = false
          }
          assertCurrent()
          try {
            await capture.assertOwner(signal)
            if (!capture.isCurrent()) throw new Error()
          } catch {
            throw new Error('代理已变化。')
          }
          assertCurrent()
          return settledState()
        }
        if (action === 'revoke') {
          await revoke()
          return settledState()
        }
        // The native disable operation owns confirmation and lease cleanup
        // after its owned configuration readback. Preserve protection while
        // the user decides, and when the configuration result is uncertain.
        attempted = true
        return accept(await adapters.bridge.request(action, assertCurrent), action)
      } catch (error) {
        if (bindingSubmitted) {
          // A missing, rejected or late receipt can follow an admitted bind.
          uncertain = true
          await revoke()
          throw error
        }
        if (attempted && changesConfiguration(action) && !(error instanceof GuardNativeUnavailable))
          configurationUnconfirmed = true
        if (error instanceof GuardNativeUnavailable && !bound && !unresolved()) {
          report = unavailable()
        } else if (attempted || bound || unresolved()) {
          uncertain = true
          report = undefined
        }
        throw error
      } finally {
        operating = false
        adapters.notify?.()
      }
    }
  }
}
