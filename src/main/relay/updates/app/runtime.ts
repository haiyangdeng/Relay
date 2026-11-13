import { createHash } from 'node:crypto'
import { ownsHttpListener } from '../../core/port'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import type { SystemProxyReport } from '../../../../shared/relay/system-proxy'
import type { TunSessionState } from '../../../../shared/relay/tun'
import type { RelayDesktopState } from '../../../../shared/relay/desktop'
import type { RelayDesktopReadiness } from '../../../../shared/relay/protocol'
import type { RelayCoreState } from '../../../../shared/relay/core'
import type { CoreStoreSnapshot } from '../../core/store'
import type { AppUpdateNetwork, AppUpdateProxyLease } from './transport'

export function appUpdateNetwork(local: () => LocalProxyState): AppUpdateNetwork {
  const snapshot = (): AppUpdateProxyLease => {
    const state = local()
    if (
      !state.owned ||
      state.pending ||
      state.uncertain ||
      state.phase !== 'running' ||
      state.traffic !== 'listening' ||
      !state.instanceId ||
      !state.configurationRevision ||
      !state.pid ||
      !state.httpPort
    )
      throw new Error('应用更新要求本次已确认的自有HTTP实例。')
    return {
      instanceId: state.instanceId,
      configurationRevision: state.configurationRevision,
      pid: state.pid,
      port: state.httpPort
    }
  }
  const assertCurrent = async (lease: AppUpdateProxyLease): Promise<void> => {
    if (
      JSON.stringify(snapshot()) !== JSON.stringify(lease) ||
      !(await ownsHttpListener(lease.pid, lease.port)) ||
      JSON.stringify(snapshot()) !== JSON.stringify(lease)
    )
      throw new Error('应用更新代理归属已变化。')
  }
  return {
    async acquire() {
      const lease = snapshot()
      await assertCurrent(lease)
      return lease
    },
    assertCurrent
  }
}

export interface AppHandoffSources {
  reserve(): Promise<() => void>
  local(): LocalProxyState
  core(): RelayCoreState
  coreStore(): Promise<CoreStoreSnapshot>
  tun(): TunSessionState
  systemProxy(): Promise<SystemProxyReport>
  desktop(): Promise<RelayDesktopState>
  desktopReadiness(): Promise<RelayDesktopReadiness>
  guard(): Promise<'inactive' | 'active' | 'unknown'>
  assertOtherOperationsIdle(): void
}
export interface AppHandoffLease {
  assertCurrent(): Promise<void>
  release(): void
}
// The Main coordinator supplies actual service observations and an exclusive
// maintenance reservation. No renderer Boolean can manufacture this lease.
export function appUpdateHandoff(
  sources: AppHandoffSources
): (assertOperationCurrent: () => void) => Promise<AppHandoffLease> {
  const observe = async (assertOperationCurrent: () => void): Promise<string> => {
    assertOperationCurrent()
    sources.assertOtherOperationsIdle()
    const local = structuredClone(sources.local()),
      core = structuredClone(sources.core()),
      tun = structuredClone(sources.tun())
    const lease = await sources.coreStore()
    assertOperationCurrent()
    const system = await sources.systemProxy()
    assertOperationCurrent()
    const desktop = await sources.desktop()
    assertOperationCurrent()
    const desktopReadiness = await sources.desktopReadiness()
    assertOperationCurrent()
    const guard = await sources.guard()
    assertOperationCurrent()
    if (
      lease.lease !== 'missing' ||
      core.pending ||
      core.owned ||
      core.hasRecord ||
      core.uncertain ||
      ['starting', 'running', 'stopping'].includes(core.phase) ||
      !['unknown', 'idle'].includes(local.phase) ||
      local.pending ||
      local.uncertain ||
      local.owned ||
      local.hasRecord ||
      local.pid ||
      local.instanceId ||
      local.traffic !== 'inactive' ||
      !['idle', 'restored'].includes(tun.phase) ||
      tun.pending ||
      tun.owned ||
      (tun.phase === 'idle' && !!tun.sessionId) ||
      tun.traffic !== 'inactive' ||
      (tun.phase === 'restored' && !tun.restorationVerified) ||
      !['inactive', 'restored'].includes(system.status) ||
      system.canRestore ||
      desktop.pending ||
      desktop.uncertain ||
      desktop.host !== 'absent' ||
      (desktop.snapshot &&
        (desktop.snapshot.phase !== 'idle' ||
          desktop.snapshot.busy ||
          desktop.snapshot.hasRecord ||
          desktop.snapshot.requiresRecoveryConsent)) ||
      desktopReadiness.records.length !== 2 ||
      new Set(desktopReadiness.records.map((record) => record.source)).size !== 2 ||
      desktopReadiness.records.some(
        (record) => record.state !== 'missing' || record.phase !== 'none'
      ) ||
      guard !== 'inactive'
    )
      throw new Error('请先通过原有流程结束并核实Relay自有会话；未知或活动网络状态不能交给安装器。')
    sources.assertOtherOperationsIdle()
    return createHash('sha256')
      .update(
        JSON.stringify({
          local,
          core,
          lease,
          tun,
          system,
          desktop,
          desktopRecords: desktopReadiness.records,
          guard
        })
      )
      .digest('hex')
  }
  return async (assertOperationCurrent) => {
    assertOperationCurrent()
    const release = await sources.reserve()
    let released = false
    try {
      const revision = await observe(assertOperationCurrent)
      return {
        async assertCurrent() {
          if (released || (await observe(assertOperationCurrent)) !== revision)
            throw new Error('应用安装交接证据已变化。')
        },
        release() {
          if (!released) {
            released = true
            release()
          }
        }
      }
    } catch (error) {
      release()
      throw error
    }
  }
}
