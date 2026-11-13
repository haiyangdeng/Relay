import { createHash, randomUUID } from 'crypto'
import { profileEvidence } from '../../../shared/relay/profiles'
import {
  systemProxyReport,
  systemProxySettings,
  type NativeSystemProxySettings,
  type SystemProxyPreparation,
  type SystemProxyReport,
  type SystemProxySettings,
  type SystemProxyResult
} from '../../../shared/relay/system-proxy'
import type { OwnedPacServer } from './pac'

export function createSystemProxyService(adapters: {
  native(
    action: 'inspect' | 'prepare' | 'apply' | 'prepareRestore' | 'restore',
    settings?: NativeSystemProxySettings,
    revision?: string
  ): Promise<SystemProxyReport>
  pac(settings: SystemProxySettings): Promise<OwnedPacServer>
  confirm(plan: SystemProxyPreparation, reason: 'user' | 'quit'): Promise<boolean>
  verifyTarget(settings: SystemProxySettings): Promise<void>
  notify(): void
  now?(): number
}) {
  type Proof = {
    public: SystemProxyPreparation
    native?: NativeSystemProxySettings
    pac?: OwnedPacServer
    generation: number
    at: number
  }
  let proof: Proof | undefined,
    report: SystemProxyReport | undefined,
    knownRecord: string | undefined,
    busy = false,
    generation = 0,
    needsRestore = true,
    closing = false
  const retained = new Set<OwnedPacServer>(),
    waiters: (() => void)[] = [],
    now = adapters.now ?? Date.now
  const end = (): void => {
    busy = false
    waiters.splice(0).forEach((resolve) => resolve())
    adapters.notify()
  }
  const markUnknown = (): void => {
    needsRestore = true
    if (report)
      report = {
        ...report,
        status: 'uncertain',
        canApply: false,
        canRestore: false,
        canRetireDetached: false,
        quitProxyPorts: undefined,
        currentProxyPorts: undefined,
        currentPacURLHashes: undefined,
        warnings: ['系统代理或恢复记录未确认；当前显示不能作为已应用或已恢复的证据。']
      }
    adapters.notify()
  }
  const accept = (raw: unknown, completedWrite = false): SystemProxyReport => {
    const next = systemProxyReport(raw)
    if (
      knownRecord &&
      !next.recordID &&
      !(completedWrite && ['restored', 'rolledBack'].includes(next.status))
    ) {
      markUnknown()
      throw new Error('已持有的恢复记录丢失；不能确认系统已恢复，不关闭PAC或核心。')
    }
    knownRecord = next.recordID
    report = next
    needsRestore = !!next.recordID || next.status === 'uncertain'
    adapters.notify()
    return next
  }
  const dispose = async (pac?: OwnedPacServer): Promise<void> => {
    if (!pac) return
    // Failed cleanup retains the object and keeps quit blocked for a retry.
    retained.add(pac)
    await pac.close()
    retained.delete(pac)
  }
  const releasePacServers = async (
    candidates: OwnedPacServer[],
    observed?: SystemProxyReport
  ): Promise<void> => {
    if (!candidates.length) return
    // A restore only changes its selected services. Another service/location
    // may still reference an owned PAC copied by an external settings editor.
    const current = observed ?? accept(await adapters.native('inspect'))
    if (
      !current.currentPacURLHashes ||
      !current.currentProxyPorts ||
      candidates.some(
        (pac) =>
          current.currentPacURLHashes?.includes(
            createHash('sha256').update(pac.url).digest('hex')
          ) || current.currentProxyPorts?.includes(Number(new URL(pac.url).port))
      )
    )
      throw new Error('系统代理仍引用本次PAC或引用检查未确认，保留服务供重试。')
    for (const pac of candidates) await dispose(pac)
  }
  const releaseRetained = (except?: OwnedPacServer, observed?: SystemProxyReport): Promise<void> =>
    releasePacServers(
      [...retained].filter((pac) => pac !== except),
      observed
    )
  const clear = (): void => {
    ++generation
    const previous = proof
    proof = undefined
    if (previous?.pac)
      void dispose(previous.pac).catch(() => {
        needsRestore = true
        adapters.notify()
      })
  }
  const prepare = async (
    action: 'apply' | 'restore',
    raw?: unknown
  ): Promise<SystemProxyPreparation> => {
    if (busy || closing) throw new Error('请先结束系统代理操作。')
    const settings = action === 'apply' ? systemProxySettings(raw) : undefined
    if (action === 'restore' && raw !== undefined) throw new Error('恢复准备不接受参数。')
    clear()
    busy = true
    const epoch = generation
    let pac: OwnedPacServer | undefined
    try {
      let native: NativeSystemProxySettings | undefined
      if (settings) {
        await adapters.verifyTarget(settings)
        if (settings.mode === 'pac') pac = await adapters.pac(settings)
        const { pacScript: _script, ...fields } = settings
        native = { ...fields, ...(pac ? { pacURL: pac.url } : {}) }
      }
      const current = accept(
        await adapters.native(action === 'apply' ? 'prepare' : 'prepareRestore', native)
      )
      if (epoch !== generation) throw new Error('准备期间发生挂起或取消，请重新准备。')
      const output: SystemProxyPreparation = {
        evidenceId: randomUUID(),
        action,
        report: current,
        ...(settings ? { settings } : {})
      }
      proof = { public: structuredClone(output), native, pac, generation: epoch, at: now() }
      pac = undefined
      return output
    } finally {
      try {
        await dispose(pac)
      } finally {
        end()
      }
    }
  }
  const execute = async (
    raw: unknown,
    reason: 'user' | 'quit' = 'user'
  ): Promise<SystemProxyResult> => {
    const id = profileEvidence(raw),
      current = proof
    if (
      busy ||
      !current ||
      current.public.evidenceId !== id ||
      current.generation !== generation ||
      now() - current.at > 60000
    )
      throw new Error('请重新准备并核对系统代理。')
    proof = undefined
    busy = true
    const action = current.public.action
    let submitted = false
    try {
      if (!(action === 'apply' ? current.public.report.canApply : current.public.report.canRestore))
        throw new Error('当前状态不能应用或恢复，请先处理冲突。')
      if (!(await adapters.confirm(structuredClone(current.public), reason)))
        return { status: 'cancelled', warnings: ['已取消；未提交系统网络变更。'] }
      if (current.generation !== generation || now() - current.at > 60000)
        throw new Error('确认期间凭据失效。')
      if (current.public.settings) await adapters.verifyTarget(current.public.settings)
      const fresh = accept(
        await adapters.native(action === 'apply' ? 'prepare' : 'prepareRestore', current.native)
      )
      if (
        fresh.revision !== current.public.report.revision ||
        !(action === 'apply' ? fresh.canApply : fresh.canRestore) ||
        current.generation !== generation
      )
        throw new Error('确认后系统代理、网络服务或恢复记录已变化。')
      submitted = true
      needsRestore = true
      if (current.pac) retained.add(current.pac)
      const output = accept(await adapters.native(action, current.native, fresh.revision), true)
      if (current.generation !== generation) {
        markUnknown()
        return {
          status: 'uncertain',
          ...(report ? { report: structuredClone(report) } : {}),
          warnings: [
            '原生提交期间发生挂起或取消；已提交操作不能按未执行处理。保留恢复证据和PAC服务，请重新复核。'
          ]
        }
      }
      if (action === 'apply' && output.status === 'applied' && output.recordID) {
        await releaseRetained(current.pac)
        return { status: 'applied', report: output, warnings: output.warnings }
      }
      if (action === 'restore' && output.status === 'restored' && !output.recordID) {
        await releaseRetained()
        return { status: 'restored', report: output, warnings: output.warnings }
      }
      if (output.status === 'rolledBack') {
        // Rollback restores the previous applied PAC, so it remains live.
        // Only the failed candidate is eligible for dependency-checked cleanup.
        await releasePacServers(current.pac ? [current.pac] : [])
        return { status: 'rolledBack', report: output, warnings: output.warnings }
      }
      needsRestore = true
      return {
        status: 'uncertain',
        report: output,
        warnings: ['系统代理结果未确认；保留原值和本次PAC服务，请检查后显式恢复。']
      }
    } catch {
      if (submitted) markUnknown()
      return {
        status: submitted ? 'uncertain' : 'failed',
        ...(report ? { report: structuredClone(report) } : {}),
        warnings: [
          submitted
            ? '提交回执或后续清理未确认；保留恢复证据与PAC服务，没有自动重试或停止核心。'
            : '提交前条件变化，未发出系统写入；请重新检查。'
        ]
      }
    } finally {
      try {
        if (!submitted) await dispose(current.pac)
      } finally {
        end()
      }
    }
  }
  const externalProxyIsIndependent = (
    current: SystemProxyReport,
    ownedProxyPorts: readonly number[]
  ): boolean =>
    retained.size === 0 &&
    (current.recordID ? current.quitProxyPorts : current.currentProxyPorts)?.every(
      (port) => !ownedProxyPorts.includes(port)
    ) === true
  return {
    prepare: (raw: unknown) => prepare('apply', raw),
    prepareRestore: (raw?: unknown) => prepare('restore', raw),
    execute,
    clear,
    cancel(raw: unknown): void {
      const id = profileEvidence(raw)
      if (proof?.public.evidenceId === id) clear()
    },
    isBusy: (): boolean => busy || closing,
    isBlocking: (): boolean => busy || needsRestore || retained.size > 0,
    whenIdle: (): Promise<void> =>
      busy ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    state: () => ({
      pending: busy,
      observed: !!report,
      ...(report ? { report: structuredClone(report) } : {}),
      pacServersRetained: retained.size
    }),
    async inspect(raw?: unknown): Promise<SystemProxyReport> {
      if (raw !== undefined) throw new Error('系统代理检查不接受参数。')
      if (busy || closing) throw new Error('请先结束系统代理操作。')
      busy = true
      try {
        const current = accept(await adapters.native('inspect'))
        if (!current.recordID) await releaseRetained(undefined, current)
        return current
      } catch {
        markUnknown()
        throw new Error('系统代理状态未确认，保留现场，不自动恢复或重试。')
      } finally {
        end()
      }
    },
    async verifyExternalProxyForQuit(ownedProxyPorts: readonly number[]): Promise<boolean> {
      if (busy || closing) return false
      busy = true
      const epoch = generation
      try {
        const current = accept(await adapters.native('inspect'))
        return epoch === generation && externalProxyIsIndependent(current, ownedProxyPorts)
      } catch {
        markUnknown()
        return false
      } finally {
        end()
      }
    },
    async requestClose(ownedProxyPorts?: readonly number[]): Promise<boolean> {
      if (closing) return false
      closing = true
      // Existing work settles before a fresh read; close never destroys a PAC
      // server which may still be referenced by the live system configuration.
      if (busy) await new Promise<void>((resolve) => waiters.push(resolve))
      clear()
      try {
        const current = accept(await adapters.native('inspect'))
        if (!current.recordID && current.status !== 'uncertain') {
          await releaseRetained(undefined, current)
          if (ownedProxyPorts?.length && !externalProxyIsIndependent(current, ownedProxyPorts))
            return false
          return true
        }
        if (!current.canRestore)
          return !!ownedProxyPorts && externalProxyIsIndependent(current, ownedProxyPorts)
        closing = false
        const plan = await prepare('restore')
        closing = true
        const result = await execute({ evidenceId: plan.evidenceId }, 'quit')
        if (result.status !== 'restored') return false
        if (!ownedProxyPorts?.length) return true
        // Restoring a no-op or earlier proxy may still leave a reference to this
        // core. Observe the actual configuration before releasing the listener.
        return externalProxyIsIndependent(accept(await adapters.native('inspect')), ownedProxyPorts)
      } catch {
        markUnknown()
        return false
      } finally {
        closing = false
      }
    }
  }
}
