import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  appUpdateCandidateId,
  type RelayAppUpdateCandidate,
  type RelayAppUpdatePlan,
  type RelayAppUpdateState,
  type RelayAppInstallationRecord
} from '../../../../shared/relay/app-updates'
import { appReleaseConfiguration, relayAppReleaseConfiguration } from './configuration'
import {
  appVersion,
  newerAppVersion,
  parseAppRelease,
  publicAppRelease,
  type TrustedAppRelease
} from './release'
import { fetchAppUpdateBytes, type AppUpdateNetwork } from './transport'
import { type AppUpdateCandidateStore } from './store'
import { AppInstallationJournal, appInstallationPending } from './journal'
import { AppInstallerAlreadyRunning, type MacAppUpdatePlatform } from './macos'
import type { AppHandoffLease } from './runtime'

function deadline(milliseconds: number): () => boolean {
  const wallStart = Date.now(),
    monoStart = performance.now()
  let wallLast = wallStart,
    monoLast = monoStart,
    invalid = false
  return () => {
    const wall = Date.now(),
      mono = performance.now()
    const fresh =
      [wallStart, monoStart, wall, mono].every(Number.isFinite) &&
      wall >= wallLast &&
      mono >= monoLast &&
      wall - wallStart < milliseconds &&
      mono - monoStart < milliseconds
    if (!fresh) invalid = true
    wallLast = wall
    monoLast = mono
    return !invalid
  }
}
export interface AppInstallConsent {
  plan: RelayAppUpdatePlan
  mayContactAppleTrustServices: true
  opensSystemInstaller: true
  mayReplaceInstalledApplication: true
  serviceQuitsOrRestarts: false
  installerMayRequestApplicationExit: true
  requiresOwnSessionsEnded: true
}
export function createAppUpdateService(adapters: {
  store: AppUpdateCandidateStore
  journal: AppInstallationJournal
  platform: MacAppUpdatePlatform
  network: AppUpdateNetwork
  handoff(assertCurrent: () => void): Promise<AppHandoffLease>
  assertIdle(): void
  runningVersion(): string
  architecture: 'arm64' | 'x64'
  confirmDownload(plan: RelayAppUpdatePlan): Promise<boolean>
  confirmInstall(consent: AppInstallConsent): Promise<boolean>
  confirmRecovery(record: RelayAppInstallationRecord, dismiss: boolean): Promise<boolean>
  confirmRemove(candidate: RelayAppUpdateCandidate): Promise<boolean>
}) {
  const runningVersion = appVersion(adapters.runningVersion())
  let preparationGeneration = 0
  let installationGeneration = 0
  let initialized = false,
    pending = false,
    blocking = true
  let phase: RelayAppUpdateState['phase'] = 'idle'
  let latest: TrustedAppRelease | null = null
  let checkedAt: number | null = null
  let latestFresh: (() => boolean) | undefined
  let proof:
    | {
        plan: RelayAppUpdatePlan
        release?: TrustedAppRelease
        candidateId?: string
        fresh(): boolean
      }
    | undefined
  let controller: AbortController | undefined
  const waiters: (() => void)[] = []
  const config = () => appReleaseConfiguration(relayAppReleaseConfiguration)
  const begin = (next: RelayAppUpdateState['phase'], recovery = false): AbortSignal => {
    if (!initialized || pending || (blocking && !recovery))
      throw new Error('应用安装事务尚未完成核对。')
    adapters.assertIdle()
    pending = true
    phase = next
    controller = new AbortController()
    return controller.signal
  }
  const end = (): void => {
    pending = false
    phase = 'idle'
    controller = undefined
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const assertOpen = (signal: AbortSignal): void => {
    if (signal.aborted) throw new Error('本次应用更新已取消。')
    adapters.assertIdle()
  }
  const invalidatePreparation = (): void => {
    ++preparationGeneration
    proof = undefined
  }
  const settleInstallation = (record: RelayAppInstallationRecord | null): void => {
    ++installationGeneration
    blocking = appInstallationPending(record)
  }
  const consume = (raw: unknown, operation: RelayAppUpdatePlan['operation']) => {
    const id = appUpdateCandidateId(raw, 'evidenceId'),
      current = proof
    if (!current || current.plan.evidenceId !== id || current.plan.operation !== operation)
      throw new Error('请重新准备本次应用更新操作。')
    invalidatePreparation()
    if (!current.fresh()) throw new Error('请重新准备本次应用更新操作。')
    return current
  }
  const prepare = (
    operation: RelayAppUpdatePlan['operation'],
    release: TrustedAppRelease,
    candidateId?: string
  ) => {
    if (!initialized || pending || blocking) throw new Error('应用安装事务尚未完成核对。')
    adapters.assertIdle()
    invalidatePreparation()
    proof = {
      plan: {
        evidenceId: randomUUID(),
        operation,
        release: publicAppRelease(release),
        expiresAt: Date.now() + 60000
      },
      release,
      ...(candidateId ? { candidateId } : {}),
      fresh: deadline(60000)
    }
    return structuredClone(proof.plan)
  }
  return {
    isBusy: () => pending,
    isBlocking: () => !initialized || pending || blocking,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    cancel(): void {
      invalidatePreparation()
      controller?.abort()
    },
    async initialize(): Promise<void> {
      if (initialized || pending) throw new Error('应用更新初始化仅允许执行一次。')
      // Local bounded journal read only. Startup never checks releases, invokes
      // OS trust/Installer, downloads, quits or attempts unattended recovery.
      blocking = true
      const journal = await adapters.journal.read()
      blocking = appInstallationPending(journal.value)
      initialized = true
    },
    async state(): Promise<RelayAppUpdateState> {
      const generation = installationGeneration
      let journal: Awaited<ReturnType<AppInstallationJournal['read']>>
      try {
        journal = await adapters.journal.read()
      } catch (error) {
        if (generation === installationGeneration) blocking = true
        throw error
      }
      if (generation === installationGeneration)
        blocking = blocking || appInstallationPending(journal.value)
      const trusted = relayAppReleaseConfiguration ? config() : null
      const list = trusted
        ? await adapters.store.list(trusted.value, trusted.revision)
        : { candidates: [], incomplete: 0 }
      return {
        configured: !!trusted,
        runningVersion,
        checkedAt,
        pending,
        phase,
        latest: latest ? publicAppRelease(latest) : null,
        ...list,
        installation: journal.value,
        installationRevision: journal.revision,
        requiresApplicationExit: appInstallationPending(journal.value)
      }
    },
    async check(raw?: unknown): Promise<void> {
      if (raw !== undefined) throw new Error('应用检查不接受URL、版本或发布身份。')
      const trusted = config(),
        signal = begin('checking')
      latest = null
      checkedAt = null
      latestFresh = undefined
      invalidatePreparation()
      try {
        const lease = await adapters.network.acquire()
        assertOpen(signal)
        const bytes = await fetchAppUpdateBytes(
          trusted.value.feedURLs[adapters.architecture],
          256 * 1024,
          trusted.value,
          adapters.network,
          lease,
          signal
        )
        assertOpen(signal)
        latest = parseAppRelease(
          bytes,
          trusted.value,
          trusted.revision,
          adapters.architecture,
          runningVersion
        )
        checkedAt = Date.now()
        latestFresh = deadline(5 * 60000)
      } finally {
        end()
      }
    },
    prepareDownload(raw?: unknown): RelayAppUpdatePlan {
      if (raw !== undefined) throw new Error('应用下载准备不接受地址或摘要。')
      const trusted = config()
      if (
        !latest ||
        !latestFresh?.() ||
        latest.trustRevision !== trusted.revision ||
        !newerAppVersion(latest.version, runningVersion)
      )
        throw new Error('请先检查本次可信发布通道。')
      return prepare('download', latest)
    },
    async download(
      raw: unknown
    ): Promise<{ status: 'staged' | 'cancelled'; candidate?: RelayAppUpdateCandidate }> {
      const prepared = consume(raw, 'download'),
        trusted = config(),
        signal = begin('downloading')
      try {
        if (!(await adapters.confirmDownload(structuredClone(prepared.plan))) || signal.aborted)
          return { status: 'cancelled' }
        if (
          !prepared.fresh() ||
          !prepared.release ||
          prepared.release.trustRevision !== trusted.revision
        )
          throw new Error('应用下载确认已失效。')
        assertOpen(signal)
        const lease = await adapters.network.acquire()
        const bytes = await fetchAppUpdateBytes(
          prepared.release.url,
          prepared.release.bytes,
          trusted.value,
          adapters.network,
          lease,
          signal,
          { sha512: prepared.release.sha512, bytes: prepared.release.bytes }
        )
        assertOpen(signal)
        phase = 'verifying'
        const candidate = await adapters.store.stage(prepared.release, bytes, signal)
        return { status: 'staged', candidate }
      } catch (error) {
        if (signal.aborted) return { status: 'cancelled' }
        throw error
      } finally {
        end()
      }
    },
    async prepareInstall(raw: unknown): Promise<RelayAppUpdatePlan> {
      const id = appUpdateCandidateId(raw),
        trusted = config(),
        generation = ++preparationGeneration
      const stored = await adapters.store.resolve(id, trusted.value, trusted.revision)
      if (generation !== preparationGeneration) throw new Error('本次界面准备已失效。')
      if (
        stored.release.architecture !== adapters.architecture ||
        !newerAppVersion(stored.release.version, runningVersion)
      )
        throw new Error('应用候选不能用于本架构升级。')
      // Hash/private metadata only; no spctl, stapler, signature trust or OS
      // queries are hidden in preparation/state inspection.
      return prepare('install', stored.release, id)
    },
    async install(raw: unknown): Promise<{ status: 'installer-opened' | 'cancelled' }> {
      const prepared = consume(raw, 'install'),
        trusted = config(),
        signal = begin('verifying')
      let lease: AppHandoffLease | undefined
      let journalRevision: string | undefined
      let intent: RelayAppInstallationRecord | undefined
      try {
        if (
          !(await adapters.confirmInstall({
            plan: structuredClone(prepared.plan),
            mayContactAppleTrustServices: true,
            opensSystemInstaller: true,
            mayReplaceInstalledApplication: true,
            serviceQuitsOrRestarts: false,
            installerMayRequestApplicationExit: true,
            requiresOwnSessionsEnded: true
          })) ||
          signal.aborted
        )
          return { status: 'cancelled' }
        if (!prepared.fresh() || !prepared.candidateId) throw new Error('应用安装确认已失效。')
        const currentOperation = deadline(5 * 60000)
        const assertCurrent = (): void => {
          assertOpen(signal)
          if (!currentOperation()) throw new Error('应用安装核验期限已过。')
        }
        lease = await adapters.handoff(assertCurrent)
        await lease.assertCurrent()
        assertCurrent()
        if (await adapters.platform.installerRunning(assertCurrent))
          throw new AppInstallerAlreadyRunning()
        const installed = await adapters.platform.inspectInstalled(trusted.value, assertCurrent)
        if (
          installed.application.version !== runningVersion ||
          installed.receiptVersion !== runningVersion
        )
          throw new Error('当前已安装App及安装收据版本未确认。')
        const stored = await adapters.store.resolve(
          prepared.candidateId,
          trusted.value,
          trusted.revision
        )
        if (
          JSON.stringify(publicAppRelease(stored.release)) !== JSON.stringify(prepared.plan.release)
        )
          throw new Error('安装确认期间应用候选已变化。')
        const verification = await adapters.platform.verifyPackage(
          stored,
          trusted.value,
          assertCurrent
        )
        assertCurrent()
        await lease.assertCurrent()
        const current = await adapters.store.resolve(
          prepared.candidateId,
          trusted.value,
          trusted.revision
        )
        if (
          current.candidate.sha256 !== verification.sha256 ||
          current.release.version !== verification.version
        )
          throw new Error('安装器交接前候选已变化。')
        const journal = await adapters.journal.read()
        if (appInstallationPending(journal.value)) throw new Error('有未完成的应用安装事务。')
        intent = {
          version: 1,
          operationId: randomUUID(),
          candidateId: current.candidate.id,
          previousVersion: runningVersion,
          targetVersion: current.release.version,
          targetSHA256: current.candidate.sha256,
          trustRevision: trusted.revision,
          phase: 'handoff-intent',
          updatedAt: Date.now()
        }
        const saved = await adapters.journal.write(journal.revision, intent, assertCurrent)
        journalRevision = saved.revision
        blocking = true
        phase = 'handoff'
        await lease.assertCurrent()
        assertCurrent()
        await adapters.platform.openInstaller(
          current,
          assertCurrent,
          lease.assertCurrent.bind(lease)
        )
        const opened = await adapters.journal.write(
          saved.revision,
          { ...intent, phase: 'installer-opened', updatedAt: Date.now() },
          () => {}
        )
        journalRevision = opened.revision
        return { status: 'installer-opened' }
      } catch (error) {
        if (intent) {
          if (journalRevision === undefined) {
            // Handoff has not started. A fresh local read can distinguish a
            // rejected write from an uncertain or durable pending intent.
            const readback = await adapters.journal.read().catch(() => undefined)
            if (readback && !appInstallationPending(readback.value)) {
              settleInstallation(readback.value)
              if (signal.aborted) return { status: 'cancelled' }
              throw error
            }
          }
          if (error instanceof AppInstallerAlreadyRunning && journalRevision !== undefined) {
            // The affirmative process check refused before our open call. Close
            // only this intent, and retain the barrier if that write is unconfirmed.
            const dismissal = { ...intent, phase: 'dismissed' as const, updatedAt: Date.now() }
            const saved = await adapters.journal
              .write(journalRevision, dismissal, () => {})
              .catch(() => adapters.journal.read().catch(() => undefined))
            if (JSON.stringify(saved?.value) === JSON.stringify(dismissal)) {
              settleInstallation(dismissal)
              throw error
            }
          }
          blocking = true
          if (journalRevision)
            await adapters.journal
              .write(
                journalRevision,
                { ...intent, phase: 'uncertain', updatedAt: Date.now() },
                () => {}
              )
              .catch(() => {})
          throw new Error(
            '安装器交接或回执未确认；保留候选和事务，请显式核对。没有自动安装、退出、重试或回滚。'
          )
        }
        if (signal.aborted) return { status: 'cancelled' }
        throw error
      } finally {
        lease?.release()
        end()
      }
    },
    async recover(dismiss = false): Promise<void> {
      const trusted = config(),
        signal = begin('recovering', true)
      try {
        const journal = await adapters.journal.read(),
          record = journal.value
        if (!record || !appInstallationPending(record))
          throw new Error('没有待核实的应用安装事务。')
        if (record.trustRevision !== trusted.revision)
          throw new Error('应用发布身份已变化，旧事务需保留核对。')
        assertOpen(signal)
        if (!(await adapters.confirmRecovery(record, dismiss))) return
        assertOpen(signal)
        if (await adapters.platform.installerRunning(() => assertOpen(signal)))
          throw new Error('系统Installer仍在运行，不能推断安装结果。')
        const observed = await adapters.platform.inspectInstalled(trusted.value, () =>
          assertOpen(signal)
        )
        let next: RelayAppInstallationRecord['phase'] = 'uncertain'
        if (
          runningVersion === record.targetVersion &&
          observed.application.version === record.targetVersion &&
          observed.receiptVersion === record.targetVersion
        )
          next = 'installed'
        else if (
          runningVersion === record.previousVersion &&
          observed.application.version === record.previousVersion &&
          observed.receiptVersion === record.previousVersion
        )
          next = dismiss ? 'dismissed' : 'not-confirmed'
        if (dismiss && next !== 'dismissed')
          throw new Error('未确认原安装保持完整，不能取消此事务记录。')
        assertOpen(signal)
        if (await adapters.platform.installerRunning(() => assertOpen(signal)))
          throw new Error('核对期间Installer重新启动。')
        const result = { ...record, phase: next, updatedAt: Date.now() }
        const saved = await adapters.journal
          .write(journal.revision, result, () => assertOpen(signal))
          .catch(async (error: unknown) => {
            if (appInstallationPending(result)) throw error
            // Rename can succeed before directory sync or write readback fails.
            // Release the barrier only after this exact terminal record is readable.
            const readback = await adapters.journal.read().catch(() => undefined)
            if (!readback || JSON.stringify(readback.value) !== JSON.stringify(result)) throw error
            return readback
          })
        settleInstallation(saved.value)
      } finally {
        end()
      }
    },
    async remove(raw: unknown): Promise<void> {
      const trusted = config(),
        id = appUpdateCandidateId(raw),
        signal = begin('verifying', true)
      try {
        const journal = await adapters.journal.read()
        if (appInstallationPending(journal.value) && journal.value?.candidateId === id)
          throw new Error('安装事务引用的候选必须保留。')
        const stored = await adapters.store.resolve(id, trusted.value, trusted.revision)
        assertOpen(signal)
        if (!(await adapters.confirmRemove(stored.candidate))) return
        assertOpen(signal)
        await adapters.store.remove(id, trusted.value, trusted.revision, () => assertOpen(signal))
      } finally {
        end()
      }
    }
  }
}
