import { open, writeFile, type FileHandle } from 'fs/promises'
import { join } from 'path'
import { types } from 'util'
import { variantImportRequest } from '../../../shared/relay/variant'
import { SMART_MODEL_CONTROLS } from '../profiles/groups'
import { smartCollectorSizeMiB } from '../../../shared/relay/smart-settings'
import { readBinaryResource } from '../resources/source'
import type { CoreExecutionReceiptV2 } from '../configuration/core-snapshot-prototype'
import type { RelayCoreResource } from './resources'
import { readTrustedSmartModel, trustedSmartModel, type TrustedSmartModel } from './smart-models'
import { trustedCoreVariants } from './trusted-variants'

export function checkSmartConfiguration(
  resource: RelayCoreResource,
  configuration: string
): boolean {
  const parsed = JSON.parse(configuration) as Record<string, unknown>
  const groups = parsed['proxy-groups']
  const usesSmart = Array.isArray(groups) && groups.some((group) => group?.type === 'smart')
  const profile = parsed.profile
  const usesCollector =
    profile !== null &&
    typeof profile === 'object' &&
    !Array.isArray(profile) &&
    Object.hasOwn(profile, 'smart-collector-size')
  if (usesCollector)
    smartCollectorSizeMiB((profile as Record<string, unknown>)['smart-collector-size'])
  const core = trustedCoreVariants().find(
    (pin) =>
      pin.version === resource.version &&
      pin.architecture === resource.architecture &&
      pin.sha256 === resource.sha256
  )
  if (
    (usesSmart || usesCollector) &&
    (core?.family !== 'smart' ||
      (usesSmart &&
        Object.entries(SMART_MODEL_CONTROLS).some(([key, value]) => parsed[key] !== value)))
  )
    throw new Error('Smart组需要可信Smart核心和固定模型控制；未执行检查或启动。')
  return core?.family === 'smart'
}
export async function stageSmartRuntimeModel(
  resourceRoot: string,
  directory: string,
  resource: RelayCoreResource,
  configuration: string,
  registerCreator?: (file: FileHandle, pin: TrustedSmartModel) => void
): Promise<TrustedSmartModel | undefined> {
  if (!checkSmartConfiguration(resource, configuration)) return undefined
  const receipt = variantImportRequest(
    JSON.parse(
      (await readBinaryResource(join(resourceRoot, 'relay-model.json'), true, 4096)).toString(
        'utf8'
      )
    )
  )
  if (receipt.kind !== 'smart' || receipt.architecture !== undefined)
    throw new Error('Smart模型回执格式无效。')
  const pin = trustedSmartModel(receipt)
  const bytes = await readTrustedSmartModel(join(resourceRoot, 'Model.bin'), pin)
  if (registerCreator) {
    const file = await open(join(directory, 'Model.bin'), 'wx+', 0o600)
    let transferred = false
    try {
      const returned: unknown = registerCreator(file, pin)
      if (returned !== undefined) {
        if (types.isPromise(returned))
          void Promise.prototype.then.call(returned, undefined, () => undefined)
        throw new Error('模型创建登记必须同步完成。')
      }
      transferred = true
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      if (!transferred) await file.close()
    }
  } else await writeFile(join(directory, 'Model.bin'), bytes, { flag: 'wx', mode: 0o600 })
  await verifySmartRuntimeModel(directory, pin)
  return pin
}
export async function verifySmartRuntimeModel(
  directory: string,
  pin: TrustedSmartModel | undefined
): Promise<void> {
  if (pin) await readTrustedSmartModel(join(directory, 'Model.bin'), pin)
}

// A captured complete candidate already wrote Model.bin with its other assets.
// Verify that exact copy; never stage from the mutable current variant root.
export async function verifyCapturedSmartRuntimeModel(
  directory: string,
  resource: RelayCoreResource,
  configuration: string,
  execution: CoreExecutionReceiptV2
): Promise<void> {
  const smart = checkSmartConfiguration(resource, configuration)
  if (smart !== (execution.profile === 'smart') || smart !== !!execution.model)
    throw new Error('已捕获的核心与模型配置不一致。')
  if (execution.model) {
    if (execution.model.path !== 'Model.bin') throw new Error('固定模型路径无效。')
    await verifySmartRuntimeModel(directory, trustedSmartModel(execution.model))
  }
}
