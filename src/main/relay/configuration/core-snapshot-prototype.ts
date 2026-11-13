// Main-private batch-34 snapshot shared by complete checks and one-time take.
import { join } from 'path'
import {
  variantImportRequest,
  variantRecord,
  type VariantInventory,
  type VariantRecord
} from '../../../shared/relay/variant'
import type { VariantStore } from '../core/variant-store'
import { verifyCoreResource, type RelayCoreResource } from '../core/resources'
import { trustedCoreVariant, trustedCoreVariants } from '../core/trusted-variants'
import {
  trustedSmartModel,
  readTrustedSmartModel,
  type TrustedSmartModel
} from '../core/smart-models'
import { checkSmartConfiguration } from '../core/smart-runtime'
import geodataManifest from '../core/geodata-manifest.json'
import { readBinaryResource, resourceHash } from '../resources/source'
import type { RuntimeAsset } from './bindings'
import { validateBoundConfiguration } from './checker'

export interface CoreSnapshotScope {
  // Main owns this data property and increments it for selection/restore changes.
  generation: number
  assertLive(): void
}
export interface CoreExecutionReceiptV2 {
  readonly version: 2
  readonly profile: 'stable' | 'alpha' | 'smart' | 'local-geodata-v1'
  readonly architecture: 'arm64' | 'x64'
  readonly core: Readonly<{ version: string; sha256: string; size: number }>
  readonly model?: Readonly<TrustedSmartModel & { path: 'Model.bin' }>
  readonly configurationSHA256: string
  readonly selectionSHA256: string
  readonly snapshotSHA256: string
  readonly expiresAt: number
  readonly assets: readonly Readonly<{
    path: string
    sha256: string
    size: number
    expectedRules?: number
  }>[]
}
export interface CapturedCoreExecutionV2 {
  readonly receipt: CoreExecutionReceiptV2
  copyAssets(): RuntimeAsset[]
  recheck(): Promise<void>
  // This path is main-private parser input, never Native execution authority.
  parserRoot(): Promise<string>
}
interface CaptureInput {
  store: Pick<VariantStore, 'list' | 'resolveCoreRoot'>
  defaultRoot: string
  configuration: string
  resources: readonly RuntimeAsset[]
  scope: CoreSnapshotScope
  signal?: AbortSignal
  now?: () => number
  expiresAt?: number
}
const hashJSON = (value: unknown): string => resourceHash(Buffer.from(JSON.stringify(value)))
const same = (left: unknown, right: unknown): boolean => hashJSON(left) === hashJSON(right)

function selected(inventory: VariantInventory): { core?: VariantRecord; model?: VariantRecord } {
  if (!inventory.activeCoreId) return {}
  const record = inventory.records.find((item) => item.id === inventory.activeCoreId)
  if (!record) throw new Error('所选核心记录已失效。')
  const core = variantRecord(record)
  if (core.kind !== 'core') throw new Error('所选核心类型无效。')
  const pin = trustedCoreVariant(core)
  if (pin.family !== 'smart') return { core }
  const modelRecord = inventory.records.find((item) => item.id === inventory.activeSmartId)
  if (!modelRecord) throw new Error('所选Smart模型缺失。')
  const model = variantRecord(modelRecord)
  if (model.kind !== 'smart') throw new Error('所选模型类型无效。')
  trustedSmartModel(model)
  return { core, model }
}

export async function captureSelectedCoreSnapshot(
  input: CaptureInput
): Promise<CapturedCoreExecutionV2> {
  const { scope, signal, store, configuration, defaultRoot } = input,
    now = input.now ?? Date.now,
    startedAt = now(),
    generation = scope.generation,
    expiresAt = input.expiresAt ?? startedAt + 60_000
  if (
    !Object.hasOwn(Object.getOwnPropertyDescriptor(scope, 'generation') ?? {}, 'value') ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !Number.isSafeInteger(startedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= startedAt ||
    expiresAt > startedAt + 60_000
  )
    throw new Error('核心快照范围或时限无效。')
  const live = (): void => {
    scope.assertLive()
    const at = now()
    // Scope work cannot extend the TTL; pure cancellation/generation/time
    // checks follow the clock adapter, which may itself expose invalidation.
    if (
      signal?.aborted ||
      scope.generation !== generation ||
      !Number.isSafeInteger(at) ||
      at < startedAt ||
      at >= expiresAt
    )
      throw new Error('核心或模型选择范围已失效；未提供可交接快照。')
  }
  const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
    live()
    const result = await operation()
    live()
    return result
  }
  live()
  const resources: RuntimeAsset[] = input.resources.map((asset) => ({
    ...asset,
    bytes: Buffer.from(asset.bytes)
  }))
  validateBoundConfiguration(configuration, resources)
  const selection = selected(await wait(() => store.list())),
    selectionSHA256 = hashJSON(selection),
    root = await wait(() => store.resolveCoreRoot(defaultRoot))
  const selectionLive = async (): Promise<void> => {
    if (hashJSON(selected(await wait(() => store.list()))) !== selectionSHA256)
      throw new Error('核心或模型选择已改变。')
  }
  await selectionLive()
  const resource = await wait(() => verifyCoreResource(root)),
    corePin =
      resource.capability === 'local-geodata-v1'
        ? {
            ...geodataManifest.assets[resource.architecture],
            version: geodataManifest.version,
            family: 'local-geodata-v1' as const
          }
        : trustedCoreVariants().find(
            (pin) =>
              pin.architecture === resource.architecture &&
              pin.version === resource.version &&
              pin.sha256 === resource.sha256
          )
  if (!corePin) throw new Error('核心不在编译可信清单中。')
  if (selection.core && !same(trustedCoreVariant(selection.core), corePin))
    throw new Error('解析核心与所选固定核心不一致。')
  if (!selection.core && !['stable', 'local-geodata-v1'].includes(corePin.family))
    throw new Error('默认核心不能隐式选择额外变体。')
  if (resource.version !== corePin.version || resource.sha256 !== corePin.sha256)
    throw new Error('核心版本或摘要与固定清单不符。')
  const smart = checkSmartConfiguration(resource, configuration)
  let model: TrustedSmartModel | undefined, modelReceiptSHA256: string | undefined
  const readModel = async (): Promise<{
    pin: TrustedSmartModel
    bytes: Buffer
    receipt: string
  }> => {
    const raw = await wait(() => readBinaryResource(join(root, 'relay-model.json'), true, 4096)),
      record = variantImportRequest(JSON.parse(raw.toString('utf8')))
    if (record.kind !== 'smart' || record.architecture !== undefined)
      throw new Error('Smart模型回执格式无效。')
    const pin = trustedSmartModel(record)
    if (!selection.model || !same(pin, trustedSmartModel(selection.model)))
      throw new Error('模型回执与所选模型不一致。')
    const bytes = await wait(() => readTrustedSmartModel(join(root, 'Model.bin'), pin)),
      after = await wait(() => readBinaryResource(join(root, 'relay-model.json'), true, 4096))
    if (!raw.equals(after)) throw new Error('读取期间模型回执已改变。')
    return { pin, bytes, receipt: resourceHash(raw) }
  }
  if (smart) {
    const captured = await readModel()
    model = captured.pin
    modelReceiptSHA256 = captured.receipt
    resources.push({ path: 'Model.bin', sha256: model.sha256, bytes: captured.bytes })
  }
  if (
    resources.length > 200 ||
    resources.reduce((total, asset) => total + asset.bytes.length, 0) > 256 * 1024 * 1024
  )
    throw new Error('含模型的完整运行资产超过原有预算。')
  const core = Object.freeze({
      version: corePin.version,
      sha256: corePin.sha256,
      size: corePin.size
    }),
    assets = Object.freeze(
      resources.map(({ path, sha256, bytes, expectedRules }) =>
        Object.freeze({
          path,
          sha256,
          size: bytes.length,
          ...(expectedRules === undefined ? {} : { expectedRules })
        })
      )
    ),
    fields = {
      version: 2 as const,
      profile: corePin.family,
      architecture: resource.architecture,
      core,
      ...(model ? { model: Object.freeze({ ...model, path: 'Model.bin' as const }) } : {}),
      configurationSHA256: resourceHash(Buffer.from(configuration)),
      selectionSHA256,
      expiresAt,
      assets
    },
    receipt = Object.freeze({
      ...fields,
      snapshotSHA256: hashJSON(['relay-core-execution-v2', fields])
    })
  const recheck = async (): Promise<void> => {
    await selectionLive()
    // Resolving again could silently rewrite Model.bin to a newer selection.
    const current: RelayCoreResource = await wait(() => verifyCoreResource(root))
    if (!same(current, resource)) throw new Error('解析核心已改变。')
    if (model) {
      const captured = await readModel()
      if (!same(captured.pin, model) || captured.receipt !== modelReceiptSHA256)
        throw new Error('固定模型或原始回执已改变。')
    }
    await selectionLive()
    live()
  }
  await recheck()
  live()
  return Object.freeze({
    receipt,
    copyAssets() {
      live()
      return resources.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes) }))
    },
    recheck,
    async parserRoot() {
      await recheck()
      live()
      return root
    }
  })
}
