import {
  relayProxyCanPrepare,
  type LocalProxyState,
  type RelayProxyPageOwner
} from '../../../shared/relay/local-proxy'
import type { RelayProfileSelection as Selection } from '../../../shared/relay/runtime'
import type {
  TunEvidenceRequest,
  TunOrdinaryRecovery,
  TunSessionPreparation,
  TunSessionRequest,
  TunSessionResult,
  TunSessionState
} from '../../../shared/relay/tun'

interface Adapters {
  owner(): RelayProxyPageOwner | undefined
  state(): TunSessionState
  local(): LocalProxyState
  ordinaryRecovery(): TunOrdinaryRecovery | undefined
  readSelection(): Promise<Selection | undefined>
  readProfile(profile: Selection): Promise<unknown>
  choose(profile: Selection): Promise<unknown>
  stop(request: TunSessionRequest): Promise<TunSessionResult>
  prepare(
    profile: Selection
  ): Promise<Pick<TunSessionPreparation, 'readyForConfirmation' | 'evidenceId'>>
  cancel(request: TunEvidenceRequest): void
  start(request: TunEvidenceRequest): Promise<TunSessionResult>
}
const matches = (left: Selection | undefined, right: Selection): boolean =>
  left?.id === right.id && left.sha256 === right.sha256
const active = (state: TunSessionState): boolean =>
  !state.pending &&
  state.owned &&
  state.phase === 'active' &&
  state.traffic === 'forwarding' &&
  !!state.sessionId
const released = (state: TunSessionState): boolean =>
  !state.pending &&
  !state.owned &&
  state.traffic === 'inactive' &&
  ['restored', 'released', 'idle'].includes(state.phase)

// A failed transport can conceal a committed start. Only a definite failure
// before ownership may be compensated by starting the original profile.
class Unconfirmed extends Error {}
const unknownStart = '虚拟网卡的启动结果待核对，请打开虚拟网卡页面查看当前会话。'
const unknownNetwork = '当前网络状态待核对，请在虚拟网卡页面查看会话及普通代理恢复状态。'

export function createTunProfileSwitch(adapters: Adapters) {
  let busy = false
  const ordinaryReady = (profile: Selection, expectedOwned?: boolean): boolean => {
    if (!released(adapters.state()) || adapters.ordinaryRecovery()) return false
    const local = adapters.local()
    if (expectedOwned !== undefined && local.owned !== expectedOwned) return false
    return local.owned
      ? !local.pending &&
          !local.uncertain &&
          local.phase === 'running' &&
          local.traffic === 'listening' &&
          local.profileId === profile.id
      : relayProxyCanPrepare(local)
  }
  const running = (profile: Selection): boolean => {
    const state = adapters.state(),
      owner = adapters.owner()
    return (
      active(state) &&
      owner?.kind === 'tun-managed' &&
      owner.instanceId === state.sessionId &&
      owner.profileId === profile.id
    )
  }
  const enable = async (profile: Selection, expectedOwned: boolean): Promise<void> => {
    if (!ordinaryReady(profile, expectedOwned) || !matches(await adapters.readSelection(), profile))
      throw new Unconfirmed(unknownNetwork)
    const prepared = await adapters.prepare(profile)
    try {
      if (!prepared.readyForConfirmation || !matches(await adapters.readSelection(), profile)) {
        throw new Error('所选配置或虚拟网卡准备条件已变化。')
      }
    } catch (error) {
      adapters.cancel({ evidenceId: prepared.evidenceId })
      throw error
    }
    let result: TunSessionResult
    try {
      result = await adapters.start({ evidenceId: prepared.evidenceId })
    } catch {
      if (running(profile) && matches(await adapters.readSelection(), profile)) return
      const stopped = adapters.state()
      if (
        (stopped.restorationVerified || stopped.phase === 'released') &&
        ordinaryReady(profile, expectedOwned)
      ) {
        throw new Error('虚拟网卡启动失败，系统已确认释放目标会话。')
      }
      throw new Unconfirmed(unknownStart)
    }
    if (
      result.status === 'started' &&
      active(result.state) &&
      result.state.sessionId === adapters.state().sessionId &&
      running(profile) &&
      matches(await adapters.readSelection(), profile)
    )
      return
    if (result.status === 'cancelled' && ordinaryReady(profile, expectedOwned)) {
      throw new Unconfirmed('已取消启动虚拟网卡，已保留当前配置和普通网络状态。')
    }
    if (
      result.status !== 'failed' ||
      result.ordinaryRecovery ||
      !ordinaryReady(profile, expectedOwned)
    )
      throw new Unconfirmed(unknownStart)
    throw new Error(result.state.warnings.join(' ') || '新配置未能启动虚拟网卡。')
  }
  return {
    isBusy: () => busy,
    async run(
      target: Selection,
      expected: RelayProxyPageOwner,
      assertCurrent: () => void = () => {}
    ): Promise<void> {
      if (busy) throw new Error('虚拟网卡正在切换配置。')
      busy = true
      try {
        const original = await adapters.readSelection()
        if (!original || expected.kind !== 'tun-managed' || expected.profileId !== original.id)
          throw new Error('当前运行配置已变化，请刷新代理组。')
        await adapters.readProfile(original)
        await adapters.readProfile(target)
        const selected = await adapters.readSelection()
        const owner = adapters.owner()
        if (
          !matches(selected, original) ||
          !running(original) ||
          !owner ||
          owner.instanceId !== expected.instanceId ||
          owner.configurationRevision !== expected.configurationRevision ||
          owner.mode !== expected.mode
        )
          throw new Error('虚拟网卡会话已变化，请刷新代理组。')
        if (original.id === target.id) {
          if (!matches(original, target)) throw new Error('配置内容已变化，请刷新配置列表。')
          return
        }
        let stopped: TunSessionResult
        assertCurrent()
        try {
          stopped = await adapters.stop({ sessionId: expected.instanceId })
        } catch {
          throw new Unconfirmed(unknownNetwork)
        }
        if (stopped.status === 'cancelled' && running(original))
          throw new Error('已取消切换，原虚拟网卡仍在运行。')
        if (
          !['restored', 'released'].includes(stopped.status) ||
          !released(stopped.state) ||
          stopped.ordinaryRecovery ||
          !ordinaryReady(original)
        )
          throw new Unconfirmed(unknownNetwork)
        const ordinaryWasRunning = adapters.local().owned
        try {
          if (!matches(await adapters.readSelection(), original))
            throw new Unconfirmed('所选配置已变化，请刷新代理组核对。')
          await adapters.choose(target)
          if (
            matches(await adapters.readSelection(), original) &&
            ordinaryReady(original, ordinaryWasRunning)
          ) {
            throw new Error('新配置未获选用。')
          }
          await enable(target, ordinaryWasRunning)
        } catch (error) {
          if (error instanceof Unconfirmed) throw error
          const current = await adapters.readSelection()
          if (
            !current ||
            (!matches(current, original) && !matches(current, target)) ||
            !ordinaryReady(current, ordinaryWasRunning)
          )
            throw new Unconfirmed(unknownNetwork)
          try {
            if (!matches(current, original)) await adapters.choose(original)
            await enable(original, ordinaryWasRunning)
          } catch (rollbackError) {
            if (rollbackError instanceof Unconfirmed) throw rollbackError
            throw new Error('配置切换未完成。请在虚拟网卡页面核对当前配置和网络状态后重新开启。')
          }
          const reason = error instanceof Error ? error.message : '新配置未能完成检查。'
          throw new Error(`切换未完成，已恢复原配置及虚拟网卡。${reason}`)
        }
      } finally {
        busy = false
      }
    }
  }
}
