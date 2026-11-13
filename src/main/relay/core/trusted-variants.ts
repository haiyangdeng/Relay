import type { VariantArchitecture, VariantAcquireRequest } from '../../../shared/relay/variant'
import type { RelayCorePin } from './resources'
import base from './manifest.json'
import extra from './variants-manifest.json'

export interface TrustedCoreVariant extends RelayCorePin {
  family: 'stable' | 'alpha' | 'smart'
  version: string
  architecture: VariantArchitecture
  path: string
}
const architectures = ['arm64', 'x64'] as const
const pins: readonly Readonly<TrustedCoreVariant>[] = [
  ...architectures.map((architecture): TrustedCoreVariant => ({
    ...base.assets[architecture],
    architecture,
    family: 'stable',
    version: base.version
  })),
  ...extra.cores.flatMap((core) => {
    if (core.family !== 'alpha' && core.family !== 'smart')
      throw new Error('额外核心清单类型无效。')
    const family = core.family
    return architectures.map((architecture): TrustedCoreVariant => ({
      ...core.assets[architecture],
      architecture,
      family,
      version: core.version
    }))
  })
].map((pin) => {
  if (
    !/^[a-f0-9]{64}$/u.test(pin.sha256) ||
    pin.size < 1000000 ||
    pin.size > 134217728 ||
    pin.path !== `darwin-${pin.architecture}/mihomo` ||
    pin.cpuType !== (pin.architecture === 'arm64' ? 0x100000c : 0x1000007)
  )
    throw new Error('固定核心清单参数无效。')
  return Object.freeze(pin)
})
export function trustedCoreVariants(): TrustedCoreVariant[] {
  return pins.map((pin) => ({ ...pin }))
}
export function trustedCoreVariant(
  request: Pick<VariantAcquireRequest, 'architecture' | 'version' | 'sha256' | 'size'>
): TrustedCoreVariant {
  const found = pins.find(
    (pin) =>
      pin.architecture === request.architecture &&
      pin.version === request.version &&
      pin.sha256 === request.sha256 &&
      pin.size === request.size
  )
  if (!found) throw new Error('此核心不在Relay固定可信清单中；未执行或选择。')
  return { ...found }
}
