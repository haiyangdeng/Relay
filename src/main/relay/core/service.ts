import { randomUUID } from 'crypto'
import {
  validateCoreAction,
  validateCorePrepare,
  type RelayCoreMode,
  type RelayCorePreparation,
  type RelayCoreResult,
  type RelayCoreState
} from '../../../shared/relay/core'
import type { RelayCoreResource } from './resources'
import type { RelayIsolatedCore } from './isolated-runtime'
import type { CoreStoreLease, CoreStoreSnapshot } from './store'

export function createCoreService(adapters: {
  inspect(): Promise<CoreStoreSnapshot>
  resources(): Promise<RelayCoreResource>
  acquire(mode: RelayCoreMode, revision: string): Promise<CoreStoreLease>
  start(
    mode: RelayCoreMode,
    registerCleanup: (stop: () => Promise<void>) => void
  ): Promise<RelayIsolatedCore>
  confirm(preparation: RelayCorePreparation): Promise<boolean>
  now?(): number
}) {
  let phase: RelayCoreState['phase'] = 'unknown',
    mode: RelayCoreMode = 'rule',
    version: string | undefined
  let hasRecord = false,
    uncertain = false,
    pending = false,
    abortStart = false,
    generation = 0
  let warnings: string[] = [],
    session: RelayIsolatedCore | undefined,
    lease: CoreStoreLease | undefined
  let cleanup: (() => Promise<void>) | undefined, ending: Promise<RelayCoreResult> | undefined
  let closing: Promise<boolean> | undefined
  let proof: { preparation: RelayCorePreparation; revision: string; at: number } | undefined
  const now = adapters.now ?? Date.now,
    waiters: (() => void)[] = []
  const owned = (): boolean => !!lease || !!session || !!cleanup
  const state = (): RelayCoreState => ({
    phase: session?.state() === 'unexpectedExit' ? 'failed' : phase,
    mode,
    version,
    pending,
    hasRecord,
    owned: owned(),
    uncertain,
    trafficEnabled: false,
    warnings: [
      ...warnings,
      ...(session?.state() === 'unexpectedExit'
        ? ['隔离子进程意外退出；没有自动重启，请结束本次记录。']
        : [])
    ]
  })
  const whenIdle = (): Promise<void> =>
    pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const end = (): void => {
    pending = false
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const result = (status: RelayCoreResult['status']): RelayCoreResult => ({
    status,
    state: { ...state(), pending: false }
  })
  const finish = (): Promise<RelayCoreResult> => {
    if (ending) return ending
    ending = (async () => {
      pending = true
      phase = 'stopping'
      proof = undefined
      ++generation
      try {
        if (lease) {
          try {
            await lease.update('stopping', session?.pid)
          } catch {
            warnings = ['会话记录复核未完成，仍将结束本次持有的隔离子进程。']
          }
        }
        if (cleanup) await cleanup()
        else if (session) await session.stop()
        session = undefined
        cleanup = undefined
        if (lease) await lease.release()
        lease = undefined
        hasRecord = false
        uncertain = false
        phase = 'idle'
        warnings = ['本次隔离实例已结束，核心模式偏好保留；没有停止其他核心。']
        return result('stopped')
      } catch {
        phase = 'failed'
        uncertain = true
        warnings = [
          '本次退出或记录清理未确认，保留所有权和窗口；可重试停止。没有按磁盘PID操作其他进程。'
        ]
        return result('uncertain')
      } finally {
        end()
        ending = undefined
      }
    })()
    return ending
  }
  return {
    state,
    whenIdle,
    invalidatePending(): void {
      proof = undefined
      ++generation
      if (pending) abortStart = true
    },
    async observeOwned(): Promise<'none' | 'running' | 'unexpectedExit' | 'unconfirmed'> {
      await whenIdle()
      const current = session
      if (!owned()) return 'none'
      if (!current) return 'unconfirmed'
      if (current.state() === 'unexpectedExit' || current.state() === 'stopped')
        return 'unexpectedExit'
      if (uncertain || phase !== 'running') return 'unconfirmed'
      try {
        const observed = await current.read('configs')
        if (
          session !== current ||
          current.state() !== 'running' ||
          observed.mode !== mode ||
          observed.port !== 0 ||
          observed['mixed-port'] !== 0
        )
          return 'unconfirmed'
        return 'running'
      } catch {
        return 'unconfirmed'
      }
    },
    isBlocking: (): boolean => pending || owned(),
    async prepare(raw: unknown): Promise<RelayCorePreparation> {
      const selected = validateCorePrepare(raw)
      if (pending || owned() || closing) throw new Error('请先结束本次核心操作。')
      const current = ++generation
      proof = undefined
      try {
        const [snapshot, resource] = await Promise.all([adapters.inspect(), adapters.resources()])
        if (generation !== current) throw new Error()
        mode = snapshot.mode
        version = resource.version
        hasRecord = snapshot.lease !== 'missing'
        phase = hasRecord ? 'blocked' : 'idle'
        uncertain = false
        warnings = hasRecord
          ? ['存在另一实例或未结束的磁盘记录；不自动恢复或按PID结束。']
          : ['仅准备无代理端口、无DNS/TUN的隔离实例；开始仍需系统确认。']
        const preparation: RelayCorePreparation = {
          evidenceId: randomUUID(),
          mode: selected,
          version: resource.version,
          canStart: !hasRecord,
          hasRecord,
          warnings: [...warnings]
        }
        proof = { preparation, revision: snapshot.revision, at: now() }
        return structuredClone(preparation)
      } catch {
        if (generation === current) {
          phase = 'blocked'
          warnings = ['资源或持久配置未能安全读取，请检查已有文件；未启动子进程。']
        }
        throw new Error('核心准备未完成，未启动或覆盖未知配置。')
      }
    },
    async action(raw: unknown): Promise<RelayCoreResult> {
      const input = validateCoreAction(raw)
      if (input.action === 'stop') {
        if (pending) {
          abortStart = true
          await whenIdle()
        }
        if (!owned()) {
          if (hasRecord) throw new Error('没有本次会话所有权，不能按磁盘记录停止进程。')
          return result('stopped')
        }
        return finish()
      }
      if (pending || owned() || closing) throw new Error('已有核心操作或实例，请先结束。')
      const current = proof
      const fresh = (): boolean =>
        !!current &&
        proof === current &&
        current.preparation.evidenceId === input.evidenceId &&
        now() >= current.at &&
        now() - current.at <= 60000 &&
        current.preparation.canStart
      if (!fresh() || !current) throw new Error('请重新准备核心配置。')
      pending = true
      abortStart = false
      try {
        if (!(await adapters.confirm(structuredClone(current.preparation))) || abortStart)
          return result('cancelled')
        if (!fresh()) throw new Error('核心准备结果已过期。')
        proof = undefined
        ++generation
        phase = 'starting'
        mode = current.preparation.mode
        lease = await adapters.acquire(mode, current.revision)
        hasRecord = true
        if (abortStart) return await finish()
        session = await adapters.start(mode, (stop) => {
          cleanup = stop
        })
        cleanup ??= () => session?.stop() ?? Promise.resolve()
        const config = await session.read('configs'),
          tun = config.tun
        if (
          config.mode !== mode ||
          config['allow-lan'] !== false ||
          !tun ||
          typeof tun !== 'object' ||
          Array.isArray(tun) ||
          (tun as Record<string, unknown>).enable !== false ||
          ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port'].some(
            (key) => config[key] !== 0
          )
        )
          throw new Error('隔离配置运行条件不符。')
        await lease.update('running', session.pid)
        if (abortStart) return await finish()
        phase = 'running'
        uncertain = false
        warnings = ['隔离核心运行中，未承接正常流量；现有系统代理、DNS和TUN未改变。']
        return result('started')
      } catch {
        if (owned()) {
          const stopped = await finish()
          if (stopped.status === 'uncertain') return stopped
        } else {
          try {
            const snapshot = await adapters.inspect()
            hasRecord = snapshot.lease !== 'missing'
            mode = snapshot.mode
          } catch {
            hasRecord = true
          }
        }
        phase = hasRecord ? 'blocked' : 'failed'
        warnings = ['启动未完成，偏好可能已保存；请重新准备。没有自动重启或接管其他核心。']
        return result('failed')
      } finally {
        end()
      }
    },
    requestClose(): Promise<boolean> {
      if (closing) return closing
      abortStart = true
      proof = undefined
      ++generation
      closing = (async () => {
        await whenIdle()
        return !owned() || (await finish()).status === 'stopped'
      })().finally(() => {
        closing = undefined
      })
      return closing
    }
  }
}
