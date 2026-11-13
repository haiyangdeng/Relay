import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'
import type { ResourceStore } from '../resources/store'
import type { ProfileStore } from '../profiles/store'
import { resourceHash } from '../resources/source'
import { canonicalNode, inspectNode } from '../profiles/nodes'
import { parseProviderResource } from '../providers/materialize'
import { plainConfigurationMap as object } from '../profiles/document'
import { resourceRuleEntries, type ResourceValidationJob } from '../resources/check-definition'
import { isGeoResourceKind, type GeoResourceKind } from '../../../shared/relay/geo-origins'
import { collectRuntimeDependencies, type RuntimeDependency } from './dependencies'
import { inspectRuntimeConfiguration } from './schema'

export interface RuntimeResourceBinding {
  dependencyId: string
  selection: RelayProfileSelection
}
export interface DefaultGeoResourceBinding {
  selection: RelayProfileSelection
  revision: string
  recheck(): Promise<void>
}
export interface RuntimeAsset {
  path: string
  sha256: string
  bytes: Buffer
  expectedRules?: number
}
export interface RuntimeResourcePin extends RelayProfileSelection {
  revision: string
  namespace: 'resource' | 'provider'
}
type Item = Record<string, unknown>
function ruleJob(read: Awaited<ReturnType<ResourceStore['read']>>): ResourceValidationJob {
  const { name, kind, behavior, selector } = read.info
  return {
    descriptor: { name, kind, behavior, selector },
    bytes: read.bytes,
    sha256: read.info.sha256
  }
}
function slot(root: Item, path: string[]): { parent: Item | unknown[]; key: string } {
  if (!path.length) throw new Error('依赖目标无效。')
  let current: unknown = root
  for (const part of path.slice(0, -1)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(part)) throw new Error()
      current = current[Number(part)]
    } else if (object(current) && Object.hasOwn(current, part)) current = current[part]
    else throw new Error('依赖目标已变化。')
  }
  if (!object(current) && !Array.isArray(current)) throw new Error('依赖目标已变化。')
  return { parent: current, key: path[path.length - 1] }
}
function replace(root: Item, path: string[], value: unknown): void {
  const { parent, key } = slot(root, path)
  if (Array.isArray(parent)) {
    if (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= parent.length) throw new Error()
    parent[Number(key)] = value
  } else parent[key] = value
}
function valueAt(root: Item, path: string[]): unknown {
  const { parent, key } = slot(root, path)
  return Array.isArray(parent) ? parent[Number(key)] : parent[key]
}
export async function bindRuntimeResources(
  source: string,
  raw: RuntimeResourceBinding[],
  adapters: {
    resources: Pick<ResourceStore, 'read'>
    providers: Pick<ProfileStore, 'read'>
    defaultGeoResource?(kind: GeoResourceKind): Promise<DefaultGeoResourceBinding | undefined>
  }
): Promise<{
  configuration: Item
  assets: RuntimeAsset[]
  pins: RuntimeResourcePin[]
  unresolved: RuntimeDependency[]
  sha256: string
  recheck(): Promise<void>
}> {
  if (!Array.isArray(raw) || raw.length > 200) throw new Error('资源绑定列表无效。')
  const bindings = new Map<string, RelayProfileSelection>()
  for (const item of raw) {
    if (
      !object(item) ||
      Object.keys(item).sort().join(',') !== 'dependencyId,selection' ||
      typeof item.dependencyId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.dependencyId) ||
      bindings.has(item.dependencyId)
    )
      throw new Error('资源绑定重复或无效。')
    bindings.set(item.dependencyId, profileSelection(item.selection))
  }
  let collected = collectRuntimeDependencies(source)
  const used = new Set<string>(),
    pins: RuntimeResourcePin[] = [],
    assets: RuntimeAsset[] = [],
    unresolved: RuntimeDependency[] = [],
    extraRules: string[] = [],
    defaults = new Map<GeoResourceKind, DefaultGeoResourceBinding | undefined>()
  let providerBytes = 0,
    totalBytes = 0
  const pin = (
    namespace: RuntimeResourcePin['namespace'],
    selection: RelayProfileSelection,
    revision: string
  ): void => {
    const prior = pins.find((item) => item.namespace === namespace && item.id === selection.id)
    if (prior && (prior.sha256 !== selection.sha256 || prior.revision !== revision))
      throw new Error('相同资源在生成期间发生变化。')
    if (!prior) pins.push({ ...selection, revision, namespace })
  }
  for (const dependency of collected.dependencies.filter(
    (item) => item.kind === 'proxy-provider'
  )) {
    const selection = bindings.get(dependency.id)
    if (!selection) continue
    const read = await adapters.providers.read(selection)
    providerBytes += Buffer.byteLength(read.text)
    if (providerBytes > 4 * 1024 * 1024) throw new Error('提供者缓存合计超过4MiB。')
    const nodes = parseProviderResource(read.text).nodes
    if (nodes.some((node) => !inspectNode(node).supported))
      throw new Error('提供者节点结构未通过固定版本校验。')
    const definition = valueAt(collected.configuration, dependency.target)
    if (!object(definition)) throw new Error()
    const inline: Item = { type: 'inline', payload: nodes.map(canonicalNode) }
    // Acquisition stays in Relay's explicit cache/scheduler workflow. All core
    // provider transformations and health settings remain on this boundary.
    for (const key of [
      'filter',
      'exclude-filter',
      'exclude-type',
      'dialer-proxy',
      'override',
      'health-check',
      'age-secret-key'
    ])
      if (Object.hasOwn(definition, key)) inline[key] = definition[key]
    // Cached text is already decrypted by the acquisition transaction. Passing
    // its old AGE key to an inline provider would attempt to decrypt it again.
    delete inline['age-secret-key']
    replace(collected.configuration, dependency.target, inline)
    used.add(dependency.id)
    pin('provider', selection, read.revision)
  }
  collected = collectRuntimeDependencies(JSON.stringify(collected.configuration))
  const resources = new Map<string, Awaited<ReturnType<ResourceStore['read']>>>()
  for (const dependency of collected.dependencies.filter(
    (item) => item.kind.startsWith('rule-') && item.kind !== 'rule-bundle'
  )) {
    const selection = bindings.get(dependency.id)
    if (!selection) continue
    const read = await adapters.resources.read(selection)
    if (read.info.kind !== dependency.kind || read.info.behavior !== dependency.behavior)
      throw new Error('规则资源类型或行为与来源不符。')
    const entries = resourceRuleEntries(ruleJob(read), true)
    if (read.info.behavior === 'classical' && entries.entries) extraRules.push(...entries.entries)
    resources.set(dependency.id, read)
  }
  // Cached classical rules can introduce databases absent from the subscription
  // text. Discover those before deciding whether the candidate is complete.
  collected = collectRuntimeDependencies(JSON.stringify(collected.configuration), extraRules)
  for (const dependency of collected.dependencies) {
    let selection = bindings.get(dependency.id)
    let defaultBinding: DefaultGeoResourceBinding | undefined
    if (!selection && isGeoResourceKind(dependency.kind) && adapters.defaultGeoResource) {
      if (!defaults.has(dependency.kind))
        defaults.set(dependency.kind, await adapters.defaultGeoResource(dependency.kind))
      defaultBinding = defaults.get(dependency.kind)
      if (defaultBinding) {
        selection = profileSelection(defaultBinding.selection)
        bindings.set(dependency.id, selection)
      }
    }
    if (!selection) {
      unresolved.push(dependency)
      continue
    }
    if (
      ['proxy-provider', 'state-directory', 'ui-directory', 'rule-bundle'].includes(dependency.kind)
    )
      throw new Error('此依赖尚未取得对应导入／状态工作流的绑定，不能用普通文件代替。')
    const read = resources.get(dependency.id) ?? (await adapters.resources.read(selection))
    if (defaultBinding && read.revision !== defaultBinding.revision)
      throw new Error('默认地理来源的缓存元数据与head不一致。')
    if (read.info.kind !== dependency.kind) throw new Error('缓存文件用途与配置依赖不符。')
    totalBytes += read.bytes.length
    if (totalBytes > 256 * 1024 * 1024) throw new Error('运行资源合计超过256MiB。')
    let path: string, expectedRules: number | undefined
    if (dependency.kind.startsWith('rule-')) {
      if (read.info.behavior !== dependency.behavior) throw new Error('规则行为已变化。')
      expectedRules = resourceRuleEntries(ruleJob(read)).expected
      path = `relay-files/${read.info.sha256}.${dependency.kind.slice(5)}`
      const definition = valueAt(collected.configuration, dependency.target)
      if (!object(definition)) throw new Error()
      replace(collected.configuration, dependency.target, {
        type: 'file',
        behavior: definition.behavior,
        format: definition.format ?? 'yaml',
        path,
        interval: 0
      })
    } else if (dependency.kind === 'runtime-file') {
      path = `relay-files/${read.info.sha256}.bin`
      replace(collected.configuration, dependency.target, path)
    } else {
      const files: Readonly<Record<string, string>> = {
        'geoip-dat': 'GeoIP.dat',
        'geosite-dat': 'GeoSite.dat',
        'country-mmdb': 'Country.mmdb',
        'asn-mmdb': 'ASN.mmdb'
      }
      path = files[dependency.kind]
      if (!path) throw new Error()
    }
    const prior = assets.find((item) => item.path === path)
    if (prior && prior.sha256 !== read.info.sha256) throw new Error('运行文件名冲突。')
    if (!prior)
      assets.push({
        path,
        sha256: read.info.sha256,
        bytes: Buffer.from(read.bytes),
        ...(expectedRules !== undefined ? { expectedRules } : {})
      })
    used.add(dependency.id)
    pin('resource', selection, read.revision)
  }
  if ([...bindings.keys()].some((key) => !used.has(key)))
    throw new Error('绑定不属于当前来源／覆写／缓存依赖；未忽略额外绑定。')
  const validated = inspectRuntimeConfiguration(JSON.stringify(collected.configuration))
  if (!validated.configuration) throw new Error('资源绑定后的完整配置结构未通过。')
  const configuration = validated.configuration
  // Original acquisition references remain in source records; the executable
  // candidate receives only immutable local resources and no implicit updater.
  configuration['geo-auto-update'] = false
  configuration['geox-url'] = { geoip: '', geosite: '', mmdb: '', asn: '' }
  const fingerprint = (): string =>
    resourceHash(
      Buffer.from(
        JSON.stringify({
          configuration,
          assets: assets.map(({ path, sha256, expectedRules }) => ({
            path,
            sha256,
            ...(expectedRules !== undefined ? { expectedRules } : {})
          })),
          pins,
          unresolved
        })
      )
    )
  const sha256 = fingerprint()
  const recheck = async (): Promise<void> => {
    if (fingerprint() !== sha256) throw new Error('生成后的配置、资源清单或来源绑定已变化。')
    for (const binding of defaults.values()) await binding?.recheck()
    for (const item of pins) {
      const reread = await (
        item.namespace === 'resource' ? adapters.resources : adapters.providers
      ).read({ id: item.id, sha256: item.sha256 })
      if (reread.revision !== item.revision) throw new Error('生成后的资源正文或元数据已变化。')
    }
    for (const asset of assets)
      if (resourceHash(asset.bytes) !== asset.sha256)
        throw new Error('生成后的运行资源正文已变化。')
    for (const binding of defaults.values()) await binding?.recheck()
    if (fingerprint() !== sha256) throw new Error('复核期间的生成快照已变化。')
  }
  return { configuration, assets, pins, unresolved, sha256, recheck }
}
