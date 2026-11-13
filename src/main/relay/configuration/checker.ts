import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { coreEnvironment } from '../core/configuration'
import { verifyCoreResource } from '../core/resources'
import { stageSmartRuntimeModel, verifyCapturedSmartRuntimeModel } from '../core/smart-runtime'
import { trustedSmartModel } from '../core/smart-models'
import { trustedCoreVariants } from '../core/trusted-variants'
import geodataManifest from '../core/geodata-manifest.json'
import type { RelayCoreResource } from '../core/resources'
import { readBinaryResource, resourceHash } from '../resources/source'
import { resourceCheckDefinition } from '../resources/check-definition'
import { plainConfigurationMap as object } from '../profiles/document'
import type { CompleteConfigurationResult } from '../../../shared/relay/configuration'
import type { CapturedCoreExecutionV2, CoreExecutionReceiptV2 } from './core-snapshot-prototype'
import { collectRuntimeDependencies } from './dependencies'
import type { RuntimeAsset } from './bindings'

const exec = promisify(execFile)
const denyNetworkPolicy = '(version 1) (allow default) (deny network*)'
export function validateBoundConfiguration(
  source: string,
  assets: readonly RuntimeAsset[],
  execution?: CoreExecutionReceiptV2
): void {
  if (execution) {
    if (
      execution.version !== 2 ||
      execution.configurationSHA256 !== resourceHash(Buffer.from(source)) ||
      execution.assets.length !== assets.length ||
      execution.assets.some(
        (item, index) =>
          item.path !== assets[index].path ||
          item.sha256 !== assets[index].sha256 ||
          item.size !== assets[index].bytes.length ||
          item.expectedRules !== assets[index].expectedRules
      )
    )
      throw new Error('完整候选与已捕获的执行资产不一致。')
    const model = assets.filter((asset) => asset.path === 'Model.bin')
    if (execution.profile === 'smart') {
      if (!execution.model || execution.model.path !== 'Model.bin' || model.length !== 1)
        throw new Error('Smart候选必须含同一固定模型。')
      const pin = trustedSmartModel(execution.model)
      if (model[0].sha256 !== pin.sha256 || model[0].bytes.length !== pin.size)
        throw new Error('固定模型资产不一致。')
    } else if (execution.model || model.length) throw new Error('当前核心不接收Smart模型槽。')
  }
  if (!Array.isArray(assets) || assets.length > 200) throw new Error('运行资源清单无效。')
  const names = new Set<string>()
  let total = 0
  for (const asset of assets) {
    if (
      !asset ||
      !(
        /^(?:GeoIP\.dat|GeoSite\.dat|Country\.mmdb|ASN\.mmdb|relay-files\/[a-f0-9]{64}\.(?:bin|yaml|text|mrs))$/u.test(
          asset.path
        ) ||
        (execution?.profile === 'smart' && asset.path === 'Model.bin')
      ) ||
      names.has(asset.path) ||
      !Buffer.isBuffer(asset.bytes) ||
      asset.bytes.length < 1 ||
      asset.bytes.length > 128 * 1024 * 1024 ||
      resourceHash(asset.bytes) !== asset.sha256
    )
      throw new Error('运行资源摘要、大小或路径无效。')
    names.add(asset.path)
    total += asset.bytes.length
    if (total > 256 * 1024 * 1024) throw new Error('运行资源合计过大。')
  }
  const { configuration, dependencies } = collectRuntimeDependencies(source)
  if (
    configuration['geo-auto-update'] !== false ||
    !object(configuration['geox-url']) ||
    Object.values(configuration['geox-url']).some((value) => value !== '')
  )
    throw new Error('隐式资源更新尚未交由明确工作流处理。')
  for (const dependency of dependencies) {
    if (dependency.kind === 'runtime-file') {
      if (!names.has(dependency.reference)) throw new Error('配置仍含未绑定文件。')
    } else if (dependency.kind.startsWith('rule-') && dependency.kind !== 'rule-bundle') {
      let current: unknown = configuration
      for (const part of dependency.target) current = object(current) ? current[part] : undefined
      if (
        !object(current) ||
        current.type !== 'file' ||
        typeof current.path !== 'string' ||
        !names.has(current.path) ||
        Object.keys(current).some(
          (key) => !['type', 'path', 'format', 'behavior', 'interval'].includes(key)
        ) ||
        current.interval !== 0
      )
        throw new Error('规则提供者仍含未绑定来源。')
    } else {
      const files: Readonly<Record<string, string>> = {
        'geoip-dat': 'GeoIP.dat',
        'geosite-dat': 'GeoSite.dat',
        'country-mmdb': 'Country.mmdb',
        'asn-mmdb': 'ASN.mmdb'
      }
      if (!files[dependency.kind] || !names.has(files[dependency.kind]))
        throw new Error('配置仍含未解决的资源或状态依赖。')
    }
  }
}
export function validateCapturedCore(
  resource: RelayCoreResource,
  execution: CoreExecutionReceiptV2
): void {
  const fixed =
    resource.capability === 'local-geodata-v1'
      ? {
          ...geodataManifest.assets[resource.architecture],
          family: 'local-geodata-v1',
          version: geodataManifest.version
        }
      : trustedCoreVariants().find(
          (pin) =>
            pin.architecture === resource.architecture &&
            pin.version === resource.version &&
            pin.sha256 === resource.sha256
        )
  if (
    !fixed ||
    resource.version !== fixed.version ||
    resource.sha256 !== fixed.sha256 ||
    execution.architecture !== resource.architecture ||
    execution.profile !== fixed.family ||
    execution.core.version !== fixed.version ||
    execution.core.sha256 !== fixed.sha256 ||
    execution.core.size !== fixed.size
  )
    throw new Error('解析核心与已捕获的固定核心不一致。')
}

export async function checkCompleteConfiguration(
  resourceRoot: string,
  source: string,
  assets: readonly RuntimeAsset[],
  signal?: AbortSignal,
  execution?: CapturedCoreExecutionV2
): Promise<CompleteConfigurationResult> {
  validateBoundConfiguration(source, assets, execution?.receipt)
  const result: CompleteConfigurationResult = {
    status: 'unavailable',
    scope: 'complete-parser',
    configurationSHA256: resourceHash(Buffer.from(source)),
    active: false,
    runtimeAccepted: false,
    warnings: []
  }
  if (signal?.aborted)
    return { ...result, status: 'cancelled', warnings: ['已取消完整配置解析检查。'] }
  await execution?.recheck()
  const resource = await verifyCoreResource(resourceRoot)
  if (execution) {
    validateCapturedCore(resource, execution.receipt)
    if ((await execution.parserRoot()) !== resourceRoot)
      throw new Error('解析核心目录与快照不一致。')
  }
  const directory = await realpath(await mkdtemp('/private/tmp/relay-complete-check-')),
    identity = await lstat(directory)
  const same = async (): Promise<void> => {
    const current = await lstat(directory)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.uid !== process.getuid?.() ||
      (current.mode & 0o7777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error()
  }
  try {
    const written = new Set<string>()
    for (const asset of assets) {
      await same()
      if (dirname(asset.path) !== '.' && !written.has(dirname(asset.path))) {
        await mkdir(join(directory, dirname(asset.path)), { mode: 0o700 })
        written.add(dirname(asset.path))
      }
      await writeFile(join(directory, asset.path), asset.bytes, { flag: 'wx', mode: 0o600 })
      if (
        resourceHash(await readBinaryResource(join(directory, asset.path), true)) !== asset.sha256
      )
        throw new Error()
    }
    const config = join(directory, 'config.json')
    await writeFile(config, source, { flag: 'wx', mode: 0o600 })
    if (resourceHash(await readBinaryResource(config, true)) !== result.configurationSHA256)
      throw new Error()
    await same()
    await verifyCoreResource(resourceRoot)
    if (execution)
      await verifyCapturedSmartRuntimeModel(directory, resource, source, execution.receipt)
    else await stageSmartRuntimeModel(resourceRoot, directory, resource, source)
    // Fixed main.go's -t returns immediately after Parse; it never reaches
    // hub.Parse/Apply, proxy listeners, NTP system writes or update schedulers.
    // Stateful outbound constructors are blocked above until their own import
    // workflow exists; resources cannot be fetched from original paths/URLs.
    try {
      const asn = assets.find((asset) => asset.path === 'ASN.mmdb')
      if (asn) {
        // Smart only warns when its ASN database cannot load. Use the existing
        // IP-ASN parser probe so corrupt bound bytes cannot pass on that warning.
        const probe = resourceCheckDefinition({
            name: 'ASN parser probe',
            kind: 'asn-mmdb',
            behavior: null,
            selector: '64512'
          }),
          probePath = join(directory, 'asn-preflight.json')
        await writeFile(probePath, JSON.stringify(probe.configuration), {
          flag: 'wx',
          mode: 0o600
        })
        if (signal?.aborted) throw new Error()
        await execution?.recheck()
        await exec(
          '/usr/bin/sandbox-exec',
          ['-p', denyNetworkPolicy, resource.executable, '-t', '-d', directory, '-f', probePath],
          {
            cwd: directory,
            env: {
              ...coreEnvironment({ ...process.env, HOME: directory, TMPDIR: directory }),
              ...(resource.capability === 'local-geodata-v1' ? { RELAY_LOCAL_GEODATA_V1: '1' } : {})
            },
            timeout: 10000,
            killSignal: 'SIGKILL',
            maxBuffer: 65536,
            signal
          }
        )
        await same()
        if (
          resourceHash(await readBinaryResource(join(directory, asn.path), true)) !== asn.sha256 ||
          signal?.aborted
        )
          throw new Error()
      }
      const parserArgs = ['-t', '-d', directory, '-f', config],
        sandboxed = !!execution || !!asn
      await execution?.recheck()
      await exec(
        sandboxed ? '/usr/bin/sandbox-exec' : resource.executable,
        sandboxed ? ['-p', denyNetworkPolicy, resource.executable, ...parserArgs] : parserArgs,
        {
          cwd: directory,
          env: {
            ...coreEnvironment({ ...process.env, HOME: directory, TMPDIR: directory }),
            ...(resource.capability === 'local-geodata-v1' ? { RELAY_LOCAL_GEODATA_V1: '1' } : {})
          },
          timeout: 10000,
          killSignal: 'SIGKILL',
          maxBuffer: 65536,
          signal
        }
      )
      await execution?.recheck()
      validateBoundConfiguration(source, assets, execution?.receipt)
      result.status = signal?.aborted ? 'cancelled' : 'passed'
      result.coreVersion = resource.version
    } catch (error) {
      const failure = error as { code?: unknown; signal?: unknown }
      result.status = signal?.aborted
        ? 'cancelled'
        : typeof failure.code === 'number' && !failure.signal
          ? 'rejected'
          : 'unavailable'
    }
  } catch {
    result.status = signal?.aborted ? 'cancelled' : 'unavailable'
  } finally {
    try {
      await same()
      await rm(directory, { recursive: true })
    } catch {
      result.status = 'uncertain'
    }
  }
  result.warnings = [
    result.status === 'passed'
      ? '固定核心已解析完整生成配置及所绑定的文件；未启用代理／DNS／TUN，未验证提供者初始化、实际规则数量、远端握手或流量。'
      : result.status === 'uncertain'
        ? '检查工作目录清理未确认，保留证据；没有操作其他核心。'
        : '完整配置解析未通过、已取消或未完成；未自动重试或启用，原始输出未回传。'
  ]
  return result
}
