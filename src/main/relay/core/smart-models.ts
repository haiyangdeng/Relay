import type { VariantImportRequest } from '../../../shared/relay/variant'
import { readBinaryResource, resourceHash } from '../resources/source'
import catalog from './variants-manifest.json'

export interface TrustedSmartModel {
  version: string
  sha256: string
  size: number
}
export function trustedSmartModels(): TrustedSmartModel[] {
  return catalog.models.map(({ version, sha256, size }) => ({ version, sha256, size }))
}
export function trustedSmartModel(
  request: Pick<VariantImportRequest, 'version' | 'sha256' | 'size'>
): TrustedSmartModel {
  const found = trustedSmartModels().find(
    (pin) =>
      pin.version === request.version && pin.sha256 === request.sha256 && pin.size === request.size
  )
  if (!found) throw new Error('模型不在Relay固定可信清单中；未交给Smart核心加载。')
  return found
}
export async function readTrustedSmartModel(
  path: string,
  request: TrustedSmartModel
): Promise<Buffer> {
  const pin = trustedSmartModel(request)
  const bytes = await readBinaryResource(path, true, pin.size)
  if (
    bytes.length !== pin.size ||
    resourceHash(bytes) !== pin.sha256 ||
    !bytes.subarray(0, 64).toString('latin1').startsWith('tree') ||
    !bytes.subarray(-64).toString('latin1').trimEnd().endsWith('[/target_enhance]')
  )
    throw new Error('固定Smart模型字节已改变；未加载。')
  return bytes
}
