import {
  configurationEditDocument,
  defaultEditDocument,
  profileOverridesFor,
  profileRulePatchFor,
  configurationEditSaveRequest,
  configurationEditClearRequest,
  configurationEditRevision,
  updateProfileOverrides,
  type ConfigurationEditDocument,
  type ConfigurationEditPreview,
  type ConfigurationEditRecord
} from '../../../shared/relay/configuration-edit'
import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'
import type { LocalResolverMode } from '../../../shared/relay/local-proxy'
import type { CompleteConfigurationPlan } from '../../../shared/relay/configuration'
import type { ProfileStore } from '../profiles/store'
import type { ResourceStore } from '../resources/store'
import { profileHash } from '../profiles/source'
import { readConfigurationMap } from '../profiles/document'
import {
  localProxyInheritedKeys,
  localProxySeparateKeys,
  validateLocalProxySourceOptions
} from '../core/local-proxy-options'
import {
  OVERRIDE_LIBRARY_RUNTIME_PREFIX,
  overrideLibraryIdFromRuntimeId
} from '../../../shared/relay/override-library'
import type { ConfigurationEditStore } from './edit-store'
import { bindRuntimeResources, type RuntimeAsset } from './bindings'
import { collectRuntimeDependencies } from './dependencies'
import {
  composeRuntimeConfiguration,
  mergeConfiguration,
  type RuntimeMergeOptions,
  type RuntimeOverride
} from './merge'
export interface ConfigurationLibraryBindingUpdate {
  expectedRevision: string
  target?: RelayProfileSelection & { revision: string }
  overrides: RuntimeOverride[]
  order?: string[]
}
export type RuntimeProfileRead = Awaited<ReturnType<ProfileStore['read']>> & {
  runtimeAssets?: readonly RuntimeAsset[]
}
function libraryItem(item: RuntimeOverride): boolean {
  if (!item.id.startsWith(OVERRIDE_LIBRARY_RUNTIME_PREFIX)) return false
  if (
    !overrideLibraryIdFromRuntimeId(item.id) ||
    (item.role !== undefined && item.role !== 'normal')
  )
    throw new Error('覆写库引用标识或角色无效。')
  return true
}

function mergeOptions(
  document: ConfigurationEditDocument,
  selectedId: string
): Omit<RuntimeMergeOptions, 'source' | 'profileId'> {
  const options = structuredClone(document)
  delete options.profileId
  delete options.profileOverrideSets
  delete options.profileRulePatchSets
  delete options.overrideLibraryOrder
  const patch = profileRulePatchFor(document, selectedId)
  const globalLibraryIds = new Set(
    options.globalOverrides.filter(libraryItem).map((item) => item.id)
  )
  return {
    ...options,
    // Fixed upstream order is global first. Only the new library namespace
    // permits a global snapshot to shadow an older per-profile snapshot.
    // Legacy inline duplicate/body checks remain owned by the existing merge.
    profileOverrides: profileOverridesFor(document, selectedId).filter(
      (item) => !libraryItem(item) || !globalLibraryIds.has(item.id)
    ),
    ...(patch ? { profileRulePatch: patch } : {})
  }
}

export function createConfigurationEditService(adapters: {
  store: ConfigurationEditStore
  profiles: Pick<ProfileStore, 'read'>
  runtimeResources?: Pick<ResourceStore, 'read'>
  defaultGeoResource?: Parameters<typeof bindRuntimeResources>[2]['defaultGeoResource']
  script?: Parameters<typeof composeRuntimeConfiguration>[1]
  assertLibraryBindings?(refs: { id: string; kind: RuntimeOverride['kind'] }[]): Promise<void>
  prepare?(
    request: unknown,
    recheck: () => Promise<void>,
    enableTun?: boolean
  ): Promise<CompleteConfigurationPlan>
}) {
  // Keep scripts' prepared output stable while the source and saved edits are
  // unchanged. Date/random in a worker must not generate new bytes at start.
  const runtimeSources = new Map<string, string>()
  const runtimePending = new Map<string, Promise<string>>()
  const assertLibraryItems = async (items: RuntimeOverride[]): Promise<void> => {
    const refs = items.filter(libraryItem)
    if (!refs.length) return
    if (!adapters.assertLibraryBindings) throw new Error('覆写库引用校验尚未接通。')
    await adapters.assertLibraryBindings(refs.map(({ id, kind }) => ({ id, kind })))
  }
  const assertLibrary = (document: ConfigurationEditDocument, selectedId?: string): Promise<void> =>
    assertLibraryItems([
      ...document.globalOverrides,
      ...(selectedId ? profileOverridesFor(document, selectedId) : [])
    ])
  const assertAllLibrary = (document: ConfigurationEditDocument): Promise<void> =>
    assertLibraryItems([
      ...document.globalOverrides,
      ...document.profileOverrides,
      ...(document.profileOverrideSets ?? []).flatMap((set) => set.overrides)
    ])
  const prepareRecord = async (
    selection: RelayProfileSelection,
    record: ConfigurationEditRecord,
    bindings: unknown[],
    enableTun = false
  ): Promise<CompleteConfigurationPlan> => {
    if (!adapters.prepare) throw new Error('完整配置准备尚未接通。')
    await assertLibrary(record.document, selection.id)
    const options = mergeOptions(record.document, selection.id)
    if (enableTun)
      options.controlled = mergeConfiguration(options.controlled, { tun: { enable: true } })
    const recheck = async (): Promise<void> => {
      const latest = await adapters.store.read()
      if (latest.exists !== record.exists || latest.revision !== record.revision)
        throw new Error('已保存的编辑版本已变化，请重新准备。')
      await assertLibrary(latest.document, selection.id)
    }
    const request = { profile: selection, options, bindings: structuredClone(bindings) }
    return enableTun ? adapters.prepare(request, recheck, true) : adapters.prepare(request, recheck)
  }
  let runtimeGeneration = 0
  const invalidateRuntimeCache = (): void => {
    runtimeGeneration++
    runtimeSources.clear()
    runtimePending.clear()
  }
  let pending = false
  const waiters: Array<() => void> = []
  const operation = async <T>(run: () => Promise<T>): Promise<T> => {
    if (pending) throw new Error('请等待当前配置编辑操作结束。')
    pending = true
    try {
      return await run()
    } finally {
      pending = false
      for (const resolve of waiters.splice(0)) resolve()
    }
  }
  const service = {
    invalidateRuntimeCache,
    async read(): Promise<ConfigurationEditRecord> {
      return adapters.store.read()
    },
    async save(raw: unknown): Promise<ConfigurationEditRecord> {
      const document = configurationEditDocument(raw)
      await assertAllLibrary(document)
      const saved = await adapters.store.save(document)
      invalidateRuntimeCache()
      return saved
    },
    async clear(): Promise<void> {
      await adapters.store.clear()
      invalidateRuntimeCache()
    },
    async saveChecked(raw: unknown): Promise<ConfigurationEditRecord> {
      const request = configurationEditSaveRequest(raw)
      await assertAllLibrary(request.document)
      const saved = await adapters.store.save(request.document, request.expectedRevision)
      invalidateRuntimeCache()
      return saved
    },
    async clearChecked(raw: unknown): Promise<void> {
      await adapters.store.clear(configurationEditClearRequest(raw))
      invalidateRuntimeCache()
    },
    async inheritProfileEdits(previousId: string, targetId: string): Promise<void> {
      await adapters.store.inherit(previousId, targetId, assertAllLibrary)
      invalidateRuntimeCache()
    },
    // Main-only bridge. The library service resolves selected body revisions;
    // this operation changes only one library scope and uses one edit-file CAS.
    async applyLibraryBindings(
      input: ConfigurationLibraryBindingUpdate
    ): Promise<ConfigurationEditRecord> {
      const expected = configurationEditRevision(input.expectedRevision),
        current = await adapters.store.read()
      if (current.revision !== expected)
        throw new Error('编辑版本已变化，请重新读取；未覆盖当前编辑。')
      const checked = configurationEditDocument({
          ...defaultEditDocument(),
          globalOverrides: input.overrides
        }),
        refs = checked.globalOverrides,
        ids = new Set<string>()
      for (const ref of refs) {
        if (!libraryItem(ref) || ids.has(ref.id)) throw new Error('覆写库引用含未知或重复ID。')
        ids.add(ref.id)
      }
      const target = input.target,
        selection = target ? profileSelection({ id: target.id, sha256: target.sha256 }) : undefined
      const assertTarget = async (): Promise<void> => {
        if (!target || !selection) return
        if (
          !/^[a-f0-9]{64}$/u.test(target.revision) ||
          (await adapters.profiles.read(selection)).revision !== target.revision
        )
          throw new Error('所选配置版本已变化，请重新读取。')
      }
      await assertTarget()
      let next = structuredClone(current.document)
      if (selection) {
        if (input.order !== undefined) throw new Error('配置级选择不能修改全局库顺序。')
        next = updateProfileOverrides(next, selection.id, [
          ...profileOverridesFor(next, selection.id).filter((item) => !libraryItem(item)),
          ...refs
        ])
      } else {
        const order = input.order ?? next.overrideLibraryOrder ?? [],
          ranks = new Map(order.map((id, index) => [id, index]))
        refs.sort(
          (a, b) =>
            (ranks.get(overrideLibraryIdFromRuntimeId(a.id) ?? '') ?? Infinity) -
            (ranks.get(overrideLibraryIdFromRuntimeId(b.id) ?? '') ?? Infinity)
        )
        next.globalOverrides = [
          ...next.globalOverrides.filter((item) => !libraryItem(item)),
          ...refs
        ]
        if (input.order !== undefined) next.overrideLibraryOrder = [...input.order]
      }
      next = configurationEditDocument(next)
      await assertAllLibrary(next)
      await assertTarget()
      const saved = await adapters.store.save(next, expected)
      invalidateRuntimeCache()
      return saved
    },
    async preview(raw: unknown): Promise<ConfigurationEditPreview> {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('配置编辑预览参数无效。')
      const input = raw as Record<string, unknown>
      const { profile: profileField, ...documentFields } = input
      const document = configurationEditDocument(documentFields)
      const selection = profileSelection(profileField ?? {})
      const stored = await adapters.profiles.read(selection)
      await assertLibrary(document, selection.id)
      const composed = await composeRuntimeConfiguration(
        {
          profileId: stored.profile.id,
          source: stored.text,
          ...mergeOptions(document, stored.profile.id)
        },
        adapters.script
      )
      await assertLibrary(document, selection.id)
      return { order: composed.order, dns: composed.dns, configuration: composed.configuration }
    },
    async optionsFor(selection: RelayProfileSelection): Promise<{
      source: string
      profileId: string
      options: Omit<RuntimeMergeOptions, 'source' | 'profileId'>
    }> {
      const stored = await adapters.profiles.read(selection)
      const record = await adapters.store.read()
      await assertLibrary(record.document, selection.id)
      return {
        source: stored.text,
        profileId: stored.profile.id,
        options: mergeOptions(record.document, stored.profile.id)
      }
    },
    async prepare(raw: unknown): Promise<CompleteConfigurationPlan> {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('已保存编辑准备参数无效。')
      const input = raw as Record<string, unknown>
      if (
        Object.keys(input).sort().join(',') !== 'bindings,profile,revision' ||
        !Array.isArray(input.bindings) ||
        typeof input.revision !== 'string'
      )
        throw new Error('已保存编辑准备参数无效。')
      const selection = profileSelection(input.profile)
      const record = await adapters.store.read()
      if (!record.exists || input.revision !== record.revision)
        throw new Error('已保存的编辑版本已变化，请重新读取。')
      return prepareRecord(selection, record, input.bindings)
    },
    async prepareForTun(raw: unknown): Promise<CompleteConfigurationPlan> {
      const selection = profileSelection(raw)
      // This intent belongs only to the checked candidate. The saved source and
      // editor remain unchanged, including when no edit document exists yet.
      return prepareRecord(selection, await adapters.store.read(), [], true)
    },
    async readRuntimeProfile(
      selection: RelayProfileSelection,
      resolverMode: LocalResolverMode = 'off'
    ): Promise<RuntimeProfileRead> {
      const generation = runtimeGeneration
      const recheckGeneration = (): void => {
        if (generation !== runtimeGeneration) throw new Error('运行配置缓存已失效，请重新准备。')
      }
      const stored = await adapters.profiles.read(selection)
      const record = await adapters.store.read()
      await assertLibrary(record.document, selection.id)
      recheckGeneration()
      const bindGeo = async (text: string, revision: string): Promise<RuntimeProfileRead> => {
        const configuration = readConfigurationMap(text).data
        if (!configuration) throw new Error('HTTP 运行配置无效。')
        // Bind only databases used by HTTP's rules and selected DNS policies.
        // Source TUN, TLS/state files and provider acquisition remain separate.
        const geoSource = JSON.stringify({
          rules: configuration.rules,
          ...(resolverMode === 'profile' ? { dns: configuration.dns } : {}),
          'geodata-mode': configuration['geodata-mode']
        })
        const dependencies = collectRuntimeDependencies(geoSource).dependencies
        if (!dependencies.length) return { ...stored, text, revision }
        if (
          dependencies.some(
            (dependency) => !['geoip-dat', 'geosite-dat', 'country-mmdb'].includes(dependency.kind)
          ) ||
          !adapters.runtimeResources ||
          !adapters.defaultGeoResource
        )
          throw new Error('HTTP 地理规则需要已保存并检查的本地数据库；不会自动下载。')
        const bundle = await bindRuntimeResources(geoSource, [], {
          resources: adapters.runtimeResources,
          providers: adapters.profiles,
          defaultGeoResource: adapters.defaultGeoResource
        })
        if (bundle.unresolved.length)
          throw new Error('HTTP 地理规则的本地数据库尚未齐全；不会自动下载。')
        await bundle.recheck()
        const [latestSource, latestEdit] = await Promise.all([
          adapters.profiles.read(selection),
          adapters.store.read()
        ])
        if (
          latestSource.revision !== stored.revision ||
          latestEdit.revision !== record.revision ||
          latestEdit.exists !== record.exists
        )
          throw new Error('绑定数据库期间来源或编辑版本已变化，请重新准备。')
        recheckGeneration()
        return {
          ...stored,
          text,
          revision: profileHash(revision + '\0' + bundle.sha256),
          runtimeAssets: bundle.assets.map((asset) => ({
            ...asset,
            bytes: Buffer.from(asset.bytes)
          }))
        }
      }
      if (!record.exists) return bindGeo(stored.text, stored.revision)
      const revision = profileHash(stored.revision + '\0' + record.revision)
      const cacheKey = revision + '\0' + resolverMode
      const cached = runtimeSources.get(cacheKey)
      if (cached !== undefined) return bindGeo(cached, revision)
      let sourcePending = runtimePending.get(cacheKey)
      if (!sourcePending) {
        sourcePending = (async () => {
          const input = { profileId: stored.profile.id, source: stored.text }
          const [base, edited] = await Promise.all([
            composeRuntimeConfiguration({ ...input, ...defaultEditDocument() }),
            composeRuntimeConfiguration(
              { ...input, ...mergeOptions(record.document, stored.profile.id) },
              adapters.script
            )
          ])
          const allowed = new Set([
            'proxies',
            'proxy-groups',
            'proxy-providers',
            'rules',
            'dns',
            'hosts',
            'ipv6',
            'sniffer',
            ...localProxyInheritedKeys,
            ...localProxySeparateKeys
          ])
          const changed = [
            ...new Set([...Object.keys(base.configuration), ...Object.keys(edited.configuration)])
          ].filter(
            (key) =>
              JSON.stringify(base.configuration[key]) !== JSON.stringify(edited.configuration[key])
          )
          if (changed.some((key) => !allowed.has(key)))
            throw new Error(
              '编辑包含当前HTTP投影未支持的字段，请使用完整配置检查；未静默忽略编辑。'
            )
          validateLocalProxySourceOptions(edited.configuration)
          if (
            resolverMode !== 'profile' &&
            changed.some((key) => ['dns', 'hosts', 'ipv6'].includes(key))
          )
            throw new Error('请先选择配置内DNS／hosts模式，再准备含DNS编辑的本地代理。')
          const source = JSON.stringify(edited.configuration)
          if (!readConfigurationMap(source).data) throw new Error('已编辑运行配置无效。')
          const [latestSource, latestEdit] = await Promise.all([
            adapters.profiles.read(selection),
            adapters.store.read()
          ])
          if (
            latestSource.revision !== stored.revision ||
            latestEdit.revision !== record.revision ||
            !latestEdit.exists
          )
            throw new Error('来源或编辑在生成期间已变化，请重新准备。')
          await assertLibrary(record.document, selection.id)
          recheckGeneration()
          if (runtimeSources.size >= 16) runtimeSources.clear()
          runtimeSources.set(cacheKey, source)
          return source
        })()
        runtimePending.set(cacheKey, sourcePending)
      }
      try {
        const source = await sourcePending
        await assertLibrary(record.document, selection.id)
        recheckGeneration()
        // Preserve the original id and SHA used by ProfileStore selection.
        return bindGeo(source, revision)
      } finally {
        if (runtimePending.get(cacheKey) === sourcePending) runtimePending.delete(cacheKey)
      }
    }
  }
  return {
    ...service,
    isBusy: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    save: (raw: unknown) => operation(() => service.save(raw)),
    clear: () => operation(() => service.clear()),
    saveChecked: (raw: unknown) => operation(() => service.saveChecked(raw)),
    clearChecked: (raw: unknown) => operation(() => service.clearChecked(raw)),
    applyLibraryBindings: (input: ConfigurationLibraryBindingUpdate) =>
      operation(() => service.applyLibraryBindings(input)),
    inheritProfileEdits: (previousId: string, targetId: string) =>
      operation(() => service.inheritProfileEdits(previousId, targetId)),
    preview: (raw: unknown) => operation(() => service.preview(raw)),
    prepare: (raw: unknown) => operation(() => service.prepare(raw)),
    prepareForTun: (raw: unknown) => operation(() => service.prepareForTun(raw))
  }
}
