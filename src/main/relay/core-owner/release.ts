import { lstat, realpath } from 'fs/promises'
import { dirname, join } from 'path'
import { readBinaryResource, resourceHash } from '../resources/source'
import { verifyCoreResource, type RelayCoreResource } from '../core/resources'
import { CORE_OWNER_CONTRACT, keys, record, sha } from './protocol'
import manifest from './release-manifest.json'

export function coreOwnerReleaseEnabled(): boolean {
  return manifest.enabled === true
}
export async function coreOwnerResources(nativeExecutable: string): Promise<{
  executable: string
  sha256: string
  core: RelayCoreResource
}> {
  // This compiled resource authority cannot be supplied or enabled by IPC.
  const release = record(manifest)
  keys(
    release,
    'applicationID,assets,contract,enabled,helperID,helperName,publisherTeamID,schemaVersion'
  )
  if (
    process.platform !== 'darwin' ||
    !['arm64', 'x64'].includes(process.arch) ||
    release.schemaVersion !== 1 ||
    release.contract !== CORE_OWNER_CONTRACT ||
    release.enabled !== true ||
    release.applicationID !== 'local.relay.network.preview' ||
    release.helperID !== 'local.relay.network.preview.core-owner' ||
    release.helperName !== 'RelayCoreOwner' ||
    typeof release.publisherTeamID !== 'string' ||
    !/^[A-Z0-9]{10}$/u.test(release.publisherTeamID)
  )
    throw new Error('持久代理尚无已准入的配对发布身份和资源；本次不启动助手或转换现有核心。')
  const assets = record(release.assets)
  keys(assets, 'arm64,x64')
  const pin = record(assets[process.arch])
  keys(pin, 'sha256,size')
  const hash = sha(pin.sha256)
  if (
    typeof pin.size !== 'number' ||
    !Number.isSafeInteger(pin.size) ||
    pin.size < 1 ||
    pin.size > 32 * 1024 * 1024
  )
    throw new Error('持久助手资源预算无效。')
  const root = dirname(nativeExecutable),
    executable = join(root, 'RelayCoreOwner')
  if ((await realpath(root)) !== root) throw new Error('持久助手资源路径未确认。')
  const info = await lstat(executable)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.mode & 0o7022 ||
    !(info.mode & 0o111) ||
    ![0, process.getuid?.()].includes(info.uid)
  )
    throw new Error('持久助手资源权限未确认。')
  const bytes = await readBinaryResource(executable, false, 32 * 1024 * 1024)
  if (bytes.length !== pin.size || resourceHash(bytes) !== hash)
    throw new Error('持久助手与固定发布资源不匹配。')
  const core = await verifyCoreResource(join(root, 'core'))
  if (core.version !== 'v1.19.33' || core.capability)
    throw new Error('持久代理只接受固定普通核心。')
  // Native independently verifies actual signed Main, its own signature/Team,
  // fixed core bytes, peer birth and runtime validity before any reservation.
  return { executable, sha256: hash, core }
}
