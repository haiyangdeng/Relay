import type { VariantAcquireRequest } from '../../../shared/relay/variant'
import type { RelayUpdateCandidate } from '../../../shared/relay/updates'
import { trustedCoreVariant } from '../core/trusted-variants'
import { trustedSmartModel } from '../core/smart-models'
import { trustedUpdateCatalog } from './catalog'

export function candidateVariantImport(candidate: {
  record: RelayUpdateCandidate
  path: string
}): VariantAcquireRequest {
  const { record, path } = candidate
  const asset = trustedUpdateCatalog(record.architecture ?? process.arch).find(
    (asset) => asset.target === record.target
  )
  if (
    !asset ||
    asset.version !== record.version ||
    asset.payloadBytes !== record.payloadBytes ||
    asset.payloadSHA256 !== record.payloadSHA256 ||
    asset.architecture !== record.architecture ||
    record.installed !== false ||
    record.applied !== false
  )
    throw new Error('候选与固定变体清单不符。')
  const request = {
    sourcePath: path,
    version: asset.version,
    sha256: asset.payloadSHA256,
    size: asset.payloadBytes
  }
  if (['core', 'core-alpha', 'core-smart'].includes(asset.target)) {
    const core = { kind: 'core' as const, ...request, architecture: asset.architecture }
    trustedCoreVariant(core)
    return core
  }
  if (['smart-model', 'smart-model-middle', 'smart-model-large'].includes(asset.target)) {
    trustedSmartModel(request)
    return { kind: 'smart', ...request }
  }
  throw new Error('该候选不属于核心或Smart模型；未导入。')
}
