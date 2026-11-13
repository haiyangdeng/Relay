import { describe, expect, it } from 'vitest'
import { trustedCoreVariant, trustedCoreVariants } from './trusted-variants'
import base from './manifest.json'

describe('Build-time core catalog does not trust renderer-supplied hashes', () => {
  it('preserves both original fixed pins and includes a separately pinned Alpha for both architectures', () => {
    const pins = trustedCoreVariants()
    for (const architecture of ['arm64', 'x64'] as const) {
      const stable = pins.find(
        (pin) => pin.family === 'stable' && pin.architecture === architecture
      )
      expect(stable).toMatchObject({ ...base.assets[architecture], version: base.version })
      const alpha = pins.find((pin) => pin.family === 'alpha' && pin.architecture === architecture)
      expect(alpha).toMatchObject({
        family: 'alpha',
        architecture,
        path: `darwin-${architecture}/mihomo`
      })
      expect(alpha?.version).toMatch(/^alpha-[a-f0-9]+$/u)
    }
  })
  it('requires the exact version, architecture, bytes and digest and does not expose mutable pin references', () => {
    const first = trustedCoreVariants()[0]
    expect(trustedCoreVariant(first)).toMatchObject(first)
    for (const change of [
      { sha256: 'a'.repeat(64) },
      { size: first.size + 1 },
      { version: 'arbitrary' },
      { architecture: undefined }
    ])
      expect(() => trustedCoreVariant({ ...first, ...change })).toThrow('可信清单')
    first.sha256 = 'b'.repeat(64)
    expect(trustedCoreVariants()[0].sha256).not.toBe(first.sha256)
  })
})
