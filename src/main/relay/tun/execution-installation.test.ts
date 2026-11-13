import { describe, expect, it } from 'vitest'
import { compiledExecutionCoreV2, decodeExecutionInstallationV2 } from './execution-installation'

const profiles = ['stable', 'alpha', 'smart', 'local-geodata-v1'] as const
const capability = { version: 1, capability: 'execution-v2', clientSHA256: 'c'.repeat(64) }
const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value))
function fixture(profile: (typeof profiles)[number] = 'smart') {
  const core = (architecture: 'arm64' | 'x64') => {
    const pin = compiledExecutionCoreV2(profile, architecture)
    return { sha256: pin.sha256, size: pin.size }
  }
  return {
    version: 2,
    role: 'core-managed-v2',
    clientUID: 501,
    client: {
      sha256: capability.clientSHA256,
      size: 7777,
      cdhashes: { arm64: 'a'.repeat(40), x86_64: 'b'.repeat(40) }
    },
    coreProfile: profile,
    cores: { arm64: core('arm64'), x86_64: core('x64') },
    uninstallerSHA256: 'd'.repeat(64)
  }
}

describe('Pure execution-v2 installation admission before any filesystem or Native operation', () => {
  it.each(profiles)('binds both architecture tuples for profile %s', (profile) => {
    for (const architecture of ['arm64', 'x64'] as const) {
      const result = decodeExecutionInstallationV2(
        bytes(fixture(profile)),
        architecture,
        501,
        capability
      )
      expect(result.core).toEqual(compiledExecutionCoreV2(profile, architecture))
      expect(result.clientSHA256).toBe(capability.clientSHA256)
      expect(Object.isFrozen(result) && Object.isFrozen(result.core)).toBe(true)
    }
  })
  it('requires a positive compiled client pin and never enrolls a manifest hash', () => {
    expect(() => decodeExecutionInstallationV2(bytes(fixture()), 'arm64', 501)).toThrow()
    for (const pin of [
      null,
      { ...capability, clientSHA256: null },
      { ...capability, capability: 'runtime-rules-v1' },
      { ...capability, extra: true }
    ])
      expect(() => decodeExecutionInstallationV2(bytes(fixture()), 'arm64', 501, pin)).toThrow()
  })
  it('admits the additive work-directory client only by its exact independent pin', () => {
    const original = fixture('stable'),
      pin = { version: 1, capability: 'runtime-work-directory-v1', clientSHA256: 'e'.repeat(64) },
      revised = { ...original, client: { ...original.client, sha256: pin.clientSHA256 } }
    expect(
      decodeExecutionInstallationV2(bytes(original), 'arm64', 501, capability, pin).clientSHA256
    ).toBe(capability.clientSHA256)
    expect(
      decodeExecutionInstallationV2(bytes(revised), 'arm64', 501, capability, pin).clientSHA256
    ).toBe(pin.clientSHA256)
    for (const bad of [null, { ...pin, capability: 'execution-v2' }, { ...pin, extra: true }])
      expect(() =>
        decodeExecutionInstallationV2(bytes(revised), 'arm64', 501, capability, bad)
      ).toThrow()
  })
  it.each([
    { version: 1 },
    { role: 'core-managed-v1' },
    { clientUID: 502 },
    { coreProfile: 'smart-latest' },
    { executable: '/tmp/other-core' },
    { uninstallerSHA256: 'bad' },
    { client: { ...fixture().client, sha256: 'f'.repeat(64) } },
    { client: { ...fixture().client, size: true } },
    { client: { ...fixture().client, size: 0 } },
    { client: { ...fixture().client, size: 134217729 } },
    { client: { ...fixture().client, path: '/tmp/client' } },
    { client: { ...fixture().client, cdhashes: { arm64: 'a'.repeat(40) } } },
    {
      client: { ...fixture().client, cdhashes: { arm64: 'a'.repeat(40), x86_64: 'z'.repeat(40) } }
    },
    { cores: { arm64: fixture().cores.arm64 } },
    {
      cores: { ...fixture().cores, x86_64: { ...fixture().cores.x86_64, sha256: '0'.repeat(64) } }
    },
    {
      cores: {
        ...fixture().cores,
        x86_64: { ...fixture().cores.x86_64, size: fixture().cores.x86_64.size + 1 }
      }
    },
    { cores: { ...fixture().cores, arm64: { ...fixture().cores.arm64, executable: '/tmp/core' } } }
  ])('rejects unsupported or mismatched manifest fields %j', (patch) => {
    expect(() =>
      decodeExecutionInstallationV2(bytes({ ...fixture(), ...patch }), 'arm64', 501, capability)
    ).toThrow()
  })
  it.each([0, -1, 0x100000000, NaN, 501.5])('rejects invalid current UID %s', (uid) => {
    expect(() =>
      decodeExecutionInstallationV2(bytes(fixture()), 'arm64', uid, capability)
    ).toThrow()
  })
  it('keeps bounded strict UTF-8 JSON and duplicate decoded key rejection', () => {
    const raw = bytes(fixture())
    for (const body of [
      Buffer.alloc(16385, 32),
      Buffer.from([0xff]),
      Buffer.concat([Buffer.from('\ufeff'), raw]),
      Buffer.from('{"version":2,' + raw.subarray(1).toString()),
      Buffer.from('{"\\u0076ersion":2,' + raw.subarray(1).toString())
    ])
      expect(() => decodeExecutionInstallationV2(body, 'arm64', 501, capability)).toThrow()
  })
})
