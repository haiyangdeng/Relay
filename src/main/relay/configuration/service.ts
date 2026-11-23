import { randomUUID } from 'crypto'
import { DEFAULT_MIHOMO_TUN_CONFIG, getDefaultMihomoTunDevice } from '../../../shared/appConfig'
import { profileEvidence } from '../../../shared/relay/profiles'
import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'
import type {
  CompleteConfigurationPlan,
  CompleteConfigurationResult
} from '../../../shared/relay/configuration'
import { plainConfigurationMap as object } from '../profiles/document'
import type { ProfileStore } from '../profiles/store'
import type { ResourceStore } from '../resources/store'
import { resourceHash } from '../resources/source'
import geodataManifest from '../core/geodata-manifest.json'
import { composeRuntimeConfiguration, mergeConfiguration, type RuntimeMergeOptions } from './merge'
import {
  bindRuntimeResources,
  type RuntimeResourceBinding,
  type RuntimeResourcePin,
  type RuntimeAsset
} from './bindings'
import { collectRuntimeDependencies } from './dependencies'
import type { CapturedCoreExecutionV2, CoreExecutionReceiptV2 } from './core-snapshot-prototype'
import { validateBoundConfiguration } from './checker'

export class CheckedConfigurationFailure extends Error {
  constructor(
    readonly code: 'checked-invalidated' | 'checked-expired' | 'checked-assets' | 'checked-profile'
  ) {
    super('已检查的候选已过期、失效或运行资源已变化。')
  }
}

interface Request {
  selection: RelayProfileSelection
  options: Omit<RuntimeMergeOptions, 'source' | 'profileId'>
  bindings: RuntimeResourceBinding[]
}
// Main-process capability only. Keep configuration/credentials and asset bytes
// out of IPC replies; the TUN session consumes this exact parser-checked bundle.
export interface CheckedConfigurationSnapshot {
  readonly profileId: string
  readonly expiresAt: number
  readonly configuration: string
  readonly configurationSHA256: string
  readonly bundleSHA256: string
  readonly assets: readonly RuntimeAsset[]
  readonly pins: readonly RuntimeResourcePin[]
  readonly parser: CompleteConfigurationResult
  readonly execution?: CoreExecutionReceiptV2
  recheck(): Promise<void>
}
export function configurationRequest(raw: unknown): Request {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(',') !== 'bindings,options,profile' ||
    !object(raw.options) ||
    !Array.isArray(raw.bindings)
  )
    throw new Error('完整配置准备参数无效。')
  const allowed = new Set([
    'globalOverrides',
    'profileOverrides',
    'controlled',
    'rulePatch',
    'profileRulePatch',
    'controlDns',
    'controlSniff',
    'useNameserverPolicy',
    'disableDnsOverrideGuard',
    'confirmedDnsFingerprint'
  ])
  if (
    Object.keys(raw.options).some((key) => !allowed.has(key)) ||
    !Array.isArray(raw.options.globalOverrides) ||
    !Array.isArray(raw.options.profileOverrides) ||
    !object(raw.options.controlled)
  )
    throw new Error('完整配置选项无效。')
  return {
    selection: profileSelection(raw.profile),
    options: structuredClone(raw.options) as Request['options'],
    bindings: structuredClone(raw.bindings) as RuntimeResourceBinding[]
  }
}
export function createCompleteConfigurationService(adapters: {
  profiles: Pick<ProfileStore, 'read'>
  providers: Pick<ProfileStore, 'read'>
  resources: Pick<ResourceStore, 'read'>
  defaultGeoResource?: Parameters<typeof bindRuntimeResources>[2]['defaultGeoResource']
  script(
    script: string,
    configuration: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ configuration: Record<string, unknown>; logs: string[] }>
  captureExecution?(
    source: string,
    assets: readonly RuntimeAsset[],
    signal: AbortSignal,
    expiresAt: number
  ): Promise<CapturedCoreExecutionV2 | undefined>
  check(
    source: string,
    assets: readonly RuntimeAsset[],
    signal: AbortSignal,
    execution?: CapturedCoreExecutionV2
  ): Promise<CompleteConfigurationResult>
  now?(): number
}) {
  let pending = false,
    closing = false,
    generation = 0,
    controller: AbortController | undefined
  let proof:
    | {
        report: CompleteConfigurationPlan
        source: string
        read: Awaited<ReturnType<ProfileStore['read']>>
        selection: RelayProfileSelection
        bundle: Awaited<ReturnType<typeof bindRuntimeResources>>
        recheckEdits?: () => Promise<void>
        at: number
      }
    | undefined
  let checkedProof:
    | {
        proof: NonNullable<typeof proof>
        parser: CompleteConfigurationResult
        execution?: CapturedCoreExecutionV2
        assets?: readonly RuntimeAsset[]
      }
    | undefined
  const waiters: (() => void)[] = [],
    now = adapters.now ?? Date.now
  const whenIdle = (): Promise<void> =>
    pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const end = (): void => {
    pending = false
    controller = undefined
    waiters.splice(0).forEach((resolve) => resolve())
  }
  return {
    isBusy: (): boolean => pending,
    whenIdle,
    clear(): void {
      proof = undefined
      checkedProof = undefined
      ++generation
      controller?.abort()
    },
    cancel(): void {
      proof = undefined
      checkedProof = undefined
      ++generation
      controller?.abort()
    },
    async requestClose(): Promise<void> {
      closing = true
      proof = undefined
      checkedProof = undefined
      ++generation
      controller?.abort()
      await whenIdle()
      closing = false
    },
    async prepare(
      raw: unknown,
      recheckEdits?: () => Promise<void>,
      enableTun = false,
      transform?: (configuration: Record<string, unknown>) => Record<string, unknown>
    ): Promise<CompleteConfigurationPlan> {
      const request = configurationRequest(raw)
      if (pending || closing) throw new Error('请等待完整配置操作结束。')
      pending = true
      proof = undefined
      checkedProof = undefined
      const epoch = ++generation,
        abort = new AbortController()
      controller = abort
      const live = (): void => {
        if (closing || generation !== epoch || abort.signal.aborted) throw new Error()
      }
      try {
        await recheckEdits?.()
        const read = await adapters.profiles.read(request.selection)
        live()
        const composed = await composeRuntimeConfiguration(
          { ...request.options, profileId: read.profile.id, source: read.text },
          (script, configuration) => adapters.script(script, configuration, abort.signal)
        )
        live()
        if (enableTun) {
          const tun = composed.configuration.tun
          if (!object(tun)) throw new Error('TUN候选设置必须是映射。')
          composed.configuration.tun = mergeConfiguration(
            { ...DEFAULT_MIHOMO_TUN_CONFIG, device: getDefaultMihomoTunDevice(process.platform) },
            { ...tun, enable: true }
          )
        }
        if (transform) {
          if (!enableTun) throw new Error('监听投影仅供 TUN 准备使用。')
          composed.configuration = {
            ...composed.configuration,
            ...transform(composed.configuration)
          }
        }
        const bundle = await bindRuntimeResources(
          JSON.stringify(composed.configuration),
          request.bindings,
          adapters
        )
        live()
        await bundle.recheck()
        live()
        const again = await adapters.profiles.read(request.selection)
        live()
        if (again.revision !== read.revision) throw new Error()
        const source = JSON.stringify(bundle.configuration),
          configurationSHA256 = resourceHash(Buffer.from(source))
        const unresolved = new Set(bundle.unresolved.map((item) => item.id))
        const dependencies = [
          ...new Map(
            [
              ...collectRuntimeDependencies(JSON.stringify(composed.configuration)).dependencies,
              ...bundle.unresolved
            ].map((item) => [item.id, item])
          ).values()
        ]
        const report: CompleteConfigurationPlan = {
          evidenceId: randomUUID(),
          profileId: read.profile.id,
          configurationSHA256,
          bundleSHA256: bundle.sha256,
          readyForParserCheck: !bundle.unresolved.length,
          stageOrder: composed.order,
          scriptLogLines: composed.logs.reduce((count, item) => count + item.lines.length, 0),
          dns: composed.dns,
          dependencies: dependencies.map((item) => ({
            id: item.id,
            kind: item.kind,
            resolved: !unresolved.has(item.id)
          })),
          resources: bundle.assets.length,
          active: false,
          warnings: [
            '来源→全局/当前覆写→规则补丁→Smart覆写→受控设置；原文与用户配置不变。只返回摘要和依赖状态，不返回私钥、脚本日志或配置正文。',
            '生成副本将提供者及文件绑定到所选私有缓存；内核不自动下载订阅、地理库或更新。原始获取设置仍在来源记录，调度另行授权。',
            ...(composed.dns.autoDisabled
              ? ['原来源含自定义DNS，当前DNS覆写已在候选中关闭；确认必须绑定当前指纹。']
              : []),
            ...(bundle.unresolved.length
              ? ['依赖未齐全，不能进行核心检查或启用。状态目录与外部UI目录仍需对应导入工作流。']
              : []),
            '完整解析检查仅运行固定核心-t；不启用代理、DNS/TUN或系统代理，不代表流量、提供者初始化或断线保护通过。'
          ]
        }
        await recheckEdits?.()
        live()
        proof = {
          report,
          source,
          read,
          selection: request.selection,
          bundle,
          at: now(),
          recheckEdits
        }
        return structuredClone(report)
      } catch {
        proof = undefined
        throw new Error('完整配置生成未完成、已取消或来源／资源已变化；没有生成可启用的凭据。')
      } finally {
        end()
      }
    },
    async check(raw: unknown): Promise<CompleteConfigurationResult> {
      let checked: CompleteConfigurationResult | undefined
      const id = profileEvidence(raw),
        current = proof
      if (
        pending ||
        closing ||
        !current ||
        current.report.evidenceId !== id ||
        !current.report.readyForParserCheck ||
        now() < current.at ||
        now() - current.at > 60000
      )
        throw new Error('请重新准备资源齐全的完整配置。')
      pending = true
      proof = undefined
      checkedProof = undefined
      const epoch = ++generation,
        abort = new AbortController()
      controller = abort
      try {
        await current.recheckEdits?.()
        const read = await adapters.profiles.read(current.selection)
        if (read.revision !== current.read.revision) throw new Error()
        await current.bundle.recheck()
        await current.recheckEdits?.()
        if (
          generation !== epoch ||
          closing ||
          abort.signal.aborted ||
          now() < current.at ||
          now() - current.at > 60000
        )
          throw new Error()
        // Do not rerun JS after approval/preparation: Date/random/global state
        // could generate different bytes. Check exactly the prepared snapshot.
        const execution = await adapters.captureExecution?.(
          current.source,
          current.bundle.assets,
          abort.signal,
          current.at + 60000
        )
        const assets = execution
          ? Object.freeze(execution.copyAssets().map((asset) => Object.freeze(asset)))
          : current.bundle.assets
        if (execution) {
          await execution.recheck()
          validateBoundConfiguration(current.source, assets, execution.receipt)
        }
        const result = execution
          ? await adapters.check(current.source, assets, abort.signal, execution)
          : await adapters.check(current.source, assets, abort.signal)
        checked = result
        if (
          result.configurationSHA256 !== current.report.configurationSHA256 ||
          result.scope !== 'complete-parser' ||
          result.active !== false ||
          result.runtimeAccepted !== false
        )
          throw new Error()
        if (result.status === 'uncertain') return result
        await current.bundle.recheck()
        await current.recheckEdits?.()
        if (execution) {
          await execution.recheck()
          validateBoundConfiguration(current.source, assets, execution.receipt)
        }
        if ((await adapters.profiles.read(current.selection)).revision !== current.read.revision)
          throw new Error()
        const finishedAt = now()
        if (
          result.status === 'passed' &&
          (execution
            ? result.coreVersion === execution.receipt.core.version
            : result.coreVersion === 'v1.19.33' ||
              result.coreVersion === geodataManifest.version) &&
          !abort.signal.aborted &&
          generation === epoch &&
          !closing &&
          finishedAt >= current.at &&
          finishedAt - current.at <= 60000
        )
          checkedProof = {
            proof: current,
            parser: structuredClone(result),
            ...(execution ? { execution, assets } : {})
          }
        return abort.signal.aborted || generation !== epoch
          ? { ...result, status: 'cancelled' }
          : result
      } catch {
        if (checked?.status === 'uncertain') return checked
        return {
          status: abort.signal.aborted ? 'cancelled' : 'unavailable',
          scope: 'complete-parser',
          configurationSHA256: current.report.configurationSHA256,
          active: false,
          runtimeAccepted: false,
          warnings: ['完整检查未确认、凭据过期或来源／资源已变化；未自动重试或启用。']
        }
      } finally {
        end()
      }
    },
    async takeChecked(raw: unknown): Promise<CheckedConfigurationSnapshot> {
      const id = profileEvidence(raw),
        checked = checkedProof,
        epoch = generation
      if (pending || closing || !checked || checked.proof.report.evidenceId !== id)
        throw new Error('请先完成当前候选的固定核心完整检查。')
      // Consume before the first await: one checked snapshot cannot open two
      // competing core/TUN sessions. Failed consumption requires a fresh check.
      checkedProof = undefined
      pending = true
      const current = checked.proof,
        assets = (checked.assets ?? current.bundle.assets).map((asset) =>
          Object.freeze({ ...asset, bytes: Buffer.from(asset.bytes) })
        ),
        pins = current.bundle.pins.map((pin) => Object.freeze({ ...pin }))
      const recheck = async (): Promise<void> => {
        const live = (): void => {
          const at = now()
          if (closing || generation !== epoch || at < current.at)
            throw new CheckedConfigurationFailure('checked-invalidated')
          if (at - current.at > 60000) throw new CheckedConfigurationFailure('checked-expired')
          if (assets.some((asset) => resourceHash(asset.bytes) !== asset.sha256))
            throw new CheckedConfigurationFailure('checked-assets')
        }
        live()
        await checked.execution?.recheck()
        if (checked.execution)
          validateBoundConfiguration(current.source, assets, checked.execution.receipt)
        await current.bundle.recheck()
        await current.recheckEdits?.()
        live()
        if ((await adapters.profiles.read(current.selection)).revision !== current.read.revision)
          throw new CheckedConfigurationFailure('checked-profile')
        await checked.execution?.recheck()
        if (checked.execution)
          validateBoundConfiguration(current.source, assets, checked.execution.receipt)
        live()
      }
      try {
        await recheck()
        return Object.freeze({
          profileId: current.selection.id,
          expiresAt: current.at + 60000,
          configuration: current.source,
          configurationSHA256: current.report.configurationSHA256,
          bundleSHA256: checked.execution
            ? resourceHash(
                Buffer.from(
                  JSON.stringify({
                    configuration: JSON.parse(current.source),
                    assets: assets.map(({ path, sha256, expectedRules }) => ({
                      path,
                      sha256,
                      ...(expectedRules !== undefined ? { expectedRules } : {})
                    })),
                    pins,
                    unresolved: []
                  })
                )
              )
            : current.report.bundleSHA256,
          assets: Object.freeze(assets),
          pins: Object.freeze(pins),
          parser: Object.freeze(structuredClone(checked.parser)),
          ...(checked.execution ? { execution: checked.execution.receipt } : {}),
          recheck
        })
      } finally {
        end()
      }
    }
  }
}
