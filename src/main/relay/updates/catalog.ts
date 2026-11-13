import type { RelayUpdateAsset, RelayUpdateTarget } from '../../../shared/relay/updates'
import core from '../core/manifest.json'
import substore from '../substore/manifest.json'
import variants from '../core/variants-manifest.json'

export interface TrustedUpdateAsset extends RelayUpdateAsset {
  url: string
  releaseURL: string
  downloadSHA256: string
  encoding: 'identity' | 'gzip'
  payloadSHA256: string
  payloadBytes: number
  cpuType?: number
}
// Compressed sizes were retained in the fixed v1.19.33 release evidence. Future
// versions require a new reviewed build-time catalog, never renderer pins.
const coreArchiveBytes = { arm64: 20784157, x64: 22333945 } as const
export function trustedUpdateCatalog(architecture = process.arch): TrustedUpdateAsset[] {
  if (architecture !== 'arm64' && architecture !== 'x64') return []
  const pin = core.assets[architecture]
  const pinnedCore: TrustedUpdateAsset = {
    target: 'core',
    version: core.version,
    architecture,
    url: pin.url,
    releaseURL: core.releaseURL,
    downloadBytes: coreArchiveBytes[architecture],
    downloadSHA256: pin.archiveSHA256,
    encoding: 'gzip',
    sha256: pin.sha256,
    payloadSHA256: pin.sha256,
    payloadBytes: pin.size,
    cpuType: pin.cpuType
  }
  const resource = (
    target: RelayUpdateTarget,
    asset: typeof substore.backend
  ): TrustedUpdateAsset => ({
    target,
    version: asset.version,
    url: asset.url,
    releaseURL: asset.releaseURL,
    downloadBytes: asset.size,
    downloadSHA256: asset.sha256,
    encoding: 'identity',
    sha256: asset.sha256,
    payloadSHA256: asset.sha256,
    payloadBytes: asset.size
  })
  return [
    pinnedCore,
    ...variants.cores.map((variant): TrustedUpdateAsset => {
      if (variant.family !== 'alpha' && variant.family !== 'smart')
        throw new Error('核心清单类型无效。')
      const pin = variant.assets[architecture]
      return {
        target: variant.family === 'alpha' ? 'core-alpha' : 'core-smart',
        version: variant.version,
        architecture,
        url: pin.url,
        releaseURL: variant.releaseURL,
        downloadBytes: pin.archiveBytes,
        downloadSHA256: pin.archiveSHA256,
        encoding: 'gzip',
        sha256: pin.sha256,
        payloadSHA256: pin.sha256,
        payloadBytes: pin.size,
        cpuType: pin.cpuType
      }
    }),
    ...variants.models.map((model): TrustedUpdateAsset => {
      const target =
        model.asset === 'Model.bin'
          ? 'smart-model'
          : model.asset === 'Model-middle.bin'
            ? 'smart-model-middle'
            : model.asset === 'Model-large.bin'
              ? 'smart-model-large'
              : undefined
      if (!target) throw new Error('模型清单类型无效。')
      return {
        target,
        version: model.version,
        url: model.url,
        releaseURL: model.releaseURL,
        downloadBytes: model.size,
        downloadSHA256: model.sha256,
        encoding: 'identity',
        sha256: model.sha256,
        payloadSHA256: model.sha256,
        payloadBytes: model.size
      }
    }),
    resource('substore-backend', substore.backend),
    resource('substore-frontend', substore.frontend)
  ]
}
export function publicUpdateAsset(asset: TrustedUpdateAsset): RelayUpdateAsset {
  return {
    target: asset.target,
    version: asset.version,
    ...(asset.architecture ? { architecture: asset.architecture } : {}),
    downloadBytes: asset.downloadBytes,
    sha256: asset.payloadSHA256
  }
}
