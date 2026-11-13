import { tunDigest } from '../../../shared/relay/tun'
import type { CoreExecutionReceiptV2 } from '../configuration/core-snapshot-prototype'
import geodata from '../core/geodata-manifest.json'
import { trustedCoreVariants } from '../core/trusted-variants'
import { resourceHash } from '../resources/source'
import clientPin from './execution-client.json'
import workDirectoryClient from './runtime-work-directory-client.json'
import { parseTunHostFrame } from './wire-json'

export interface ExecutionCoreV2 {
  readonly profile: CoreExecutionReceiptV2['profile']
  readonly architecture: CoreExecutionReceiptV2['architecture']
  readonly version: string
  readonly sha256: string
  readonly size: number
}
export interface ExecutionInstallationV2 {
  readonly revision: string
  readonly core: ExecutionCoreV2
  readonly clientSHA256: string
  readonly clientSize: number
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const invalid = (): Error => new Error('execution-v2安装角色、固定资源或受托客户端不匹配。')

export function matchesRuntimeWorkDirectoryClient(
  digest: unknown,
  pin: unknown = workDirectoryClient
): boolean {
  return (
    object(pin) &&
    keys(pin, ['version', 'capability', 'clientSHA256']) &&
    pin.version === 1 &&
    pin.capability === 'runtime-work-directory-v1' &&
    tunDigest(pin.clientSHA256) &&
    pin.clientSHA256 === digest
  )
}

export function compiledExecutionCoreV2(
  profile: unknown,
  architecture: 'arm64' | 'x64'
): ExecutionCoreV2 {
  if (architecture !== 'arm64' && architecture !== 'x64') throw invalid()
  if (profile === 'local-geodata-v1') {
    const pin = geodata.assets[architecture]
    return Object.freeze({
      profile,
      architecture,
      version: geodata.version,
      sha256: pin.sha256,
      size: pin.size
    })
  }
  const pins = trustedCoreVariants().filter(
    (pin) => pin.family === profile && pin.architecture === architecture
  )
  if (pins.length !== 1) throw invalid()
  const pin = pins[0]
  return Object.freeze({
    profile: pin.family,
    architecture,
    version: pin.version,
    sha256: pin.sha256,
    size: pin.size
  })
}

// Pure admission of bounded manifest bytes, separate from filesystem trust.
// The caller must still verify the fixed root/client files and Native signature.
// A missing compiled client pin disables v2; no manifest can enroll its own hash.
export function decodeExecutionInstallationV2(
  bytes: Uint8Array,
  architecture: 'arm64' | 'x64',
  currentUID: number,
  capability: unknown = clientPin,
  workDirectoryCapability?: unknown
): ExecutionInstallationV2 {
  if (
    !Number.isSafeInteger(currentUID) ||
    currentUID < 1 ||
    currentUID > 0xffffffff ||
    !object(capability) ||
    !keys(capability, ['version', 'capability', 'clientSHA256']) ||
    capability.version !== 1 ||
    capability.capability !== 'execution-v2' ||
    !tunDigest(capability.clientSHA256)
  )
    throw invalid()
  const raw = parseTunHostFrame(bytes, 16384)
  if (
    !object(raw) ||
    !keys(raw, [
      'version',
      'role',
      'clientUID',
      'client',
      'coreProfile',
      'cores',
      'uninstallerSHA256'
    ]) ||
    raw.version !== 2 ||
    raw.role !== 'core-managed-v2' ||
    raw.clientUID !== currentUID ||
    !object(raw.client) ||
    !keys(raw.client, ['sha256', 'size', 'cdhashes']) ||
    !tunDigest(raw.client.sha256) ||
    (raw.client.sha256 !== capability.clientSHA256 &&
      !matchesRuntimeWorkDirectoryClient(raw.client.sha256, workDirectoryCapability)) ||
    typeof raw.client.size !== 'number' ||
    !Number.isSafeInteger(raw.client.size) ||
    raw.client.size < 1 ||
    raw.client.size > 134217728 ||
    !object(raw.client.cdhashes) ||
    !keys(raw.client.cdhashes, ['arm64', 'x86_64']) ||
    !Object.values(raw.client.cdhashes).every(
      (value) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
    ) ||
    !tunDigest(raw.uninstallerSHA256) ||
    !object(raw.cores) ||
    !keys(raw.cores, ['arm64', 'x86_64'])
  )
    throw invalid()
  for (const arch of ['arm64', 'x64'] as const) {
    const pin = compiledExecutionCoreV2(raw.coreProfile, arch),
      item = raw.cores[arch === 'arm64' ? 'arm64' : 'x86_64']
    if (
      !object(item) ||
      !keys(item, ['sha256', 'size']) ||
      item.sha256 !== pin.sha256 ||
      item.size !== pin.size
    )
      throw invalid()
  }
  return Object.freeze({
    revision: resourceHash(Buffer.from(bytes)),
    core: compiledExecutionCoreV2(raw.coreProfile, architecture),
    clientSHA256: raw.client.sha256,
    clientSize: raw.client.size
  })
}
