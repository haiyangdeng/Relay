import { randomUUID } from 'crypto'
import { profileEvidence } from '../../../shared/relay/profiles'
import {
  profileSelection,
  type RelayProfileSelection,
  type RelayRuntimePreparation,
  type RelayRuntimeCheckResult
} from '../../../shared/relay/runtime'
import type { ProfileStore } from './store'
import { compileProfileRuntime } from './runtime'
import { profileHash } from './source'

export function createProfileRuntimeService(adapters: {
  read(selection: RelayProfileSelection): ReturnType<ProfileStore['read']>
  check(source: string): Promise<RelayRuntimeCheckResult>
  now?(): number
}) {
  let busy = false
  let proof:
    | {
        report: RelayRuntimePreparation
        selection: RelayProfileSelection
        revision: string
        at: number
      }
    | undefined
  const now = adapters.now ?? Date.now,
    waiters: (() => void)[] = []
  const end = (): void => {
    busy = false
    waiters.splice(0).forEach((resolve) => resolve())
  }
  return {
    isBusy: (): boolean => busy,
    whenIdle: (): Promise<void> =>
      busy ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    clear(): void {
      proof = undefined
    },
    async prepare(raw: unknown): Promise<RelayRuntimePreparation> {
      const selection = profileSelection(raw)
      if (busy) throw new Error('请先等待本次配置检查结束。')
      busy = true
      proof = undefined
      try {
        const stored = await adapters.read(selection),
          compiled = compileProfileRuntime(stored.text)
        const report: RelayRuntimePreparation = {
          evidenceId: randomUUID(),
          profile: stored.profile,
          catalogue: compiled.catalogue,
          scope: 'isolated-projection',
          canValidate: !!compiled.configuration,
          runtimeSHA256: compiled.configuration ? profileHash(compiled.configuration) : undefined,
          fullSourceVerified: false,
          active: false,
          excluded: compiled.excluded,
          issues: compiled.issues
        }
        if (report.canValidate) proof = { report, selection, revision: stored.revision, at: now() }
        return structuredClone(report)
      } catch {
        throw new Error('已保存配置未能完整复核，请重新读取列表；没有启动核心或更改原文。')
      } finally {
        end()
      }
    },
    async check(raw: unknown): Promise<RelayRuntimeCheckResult> {
      const id = profileEvidence(raw),
        current = proof
      const fresh = (): boolean =>
        !!current &&
        proof === current &&
        current.report.evidenceId === id &&
        now() >= current.at &&
        now() - current.at <= 60000
      if (busy) throw new Error('请先等待本次配置检查结束。')
      if (!fresh() || !current) throw new Error('请重新查看配置并准备隔离检查。')
      busy = true
      try {
        const stored = await adapters.read(current.selection)
        if (!fresh() || stored.revision !== current.revision) throw new Error()
        const compiled = compileProfileRuntime(stored.text)
        if (
          !compiled.configuration ||
          profileHash(compiled.configuration) !== current.report.runtimeSHA256
        )
          throw new Error()
        proof = undefined
        const checked = await adapters.check(stored.text)
        if (
          checked.runtimeSHA256 !== current.report.runtimeSHA256 ||
          checked.scope !== 'isolated-projection' ||
          checked.fullSourceVerified !== false ||
          checked.active !== false
        )
          throw new Error()
        return checked
      } catch {
        proof = undefined
        return {
          status: 'unavailable',
          scope: 'isolated-projection',
          fullSourceVerified: false,
          active: false,
          runtimeSHA256: current.report.runtimeSHA256 ?? '',
          warnings: ['检查未完成、凭据过期或配置／资源已变化；没有自动重试或启用配置。']
        }
      } finally {
        end()
      }
    }
  }
}
