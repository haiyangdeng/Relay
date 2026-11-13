import { createHash } from 'crypto'
import { constants } from 'fs'
import { lstat, open, realpath } from 'fs/promises'
import { basename, dirname, isAbsolute, join } from 'path'
import { variantImportRequest } from '../../../shared/relay/variant'
import { readBinaryResource } from '../resources/source'
import manifest from './manifest.json'
import geodataManifest from './geodata-manifest.json'
import { trustedCoreVariant } from './trusted-variants'

export type RelayCoreArchitecture = 'arm64' | 'x64'
export interface RelayCorePin {
  sha256: string
  size: number
  cpuType: number
}
export interface RelayCoreResource {
  executable: string
  version: string
  architecture: RelayCoreArchitecture
  sha256: string
  capability?: 'local-geodata-v1'
}

// This lower-level verifier is also exercised with inert fixture bytes. Actual
// callers obtain their pins only from the build-time manifest below, not IPC.
export async function verifyCoreExecutable(executable: string, pin: RelayCorePin): Promise<void> {
  if (
    !isAbsolute(executable) ||
    !/^[a-f0-9]{64}$/u.test(pin.sha256) ||
    !Number.isInteger(pin.size) ||
    pin.size < 1_000_000 ||
    pin.size > 134_217_728 ||
    ![0x1000007, 0x100000c].includes(pin.cpuType)
  )
    throw new Error('核心固定资源参数无效。')
  const file = await open(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const before = await file.stat()
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== pin.size ||
      before.mode & 0o7022 ||
      !(before.mode & 0o111) ||
      ![0, process.getuid?.()].includes(before.uid) ||
      (await realpath(executable)) !== executable
    )
      throw new Error('核心资源类型、权限或路径无效。')
    const buffer = Buffer.alloc(65536),
      hash = createHash('sha256')
    let count = 0
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, count)
      if (!bytesRead) break
      if (
        count === 0 &&
        (buffer.readUInt32LE(0) !== 0xfeedfacf || buffer.readUInt32LE(4) !== pin.cpuType)
      )
        throw new Error('核心Mach-O架构与固定资源不符。')
      count += bytesRead
      if (count > pin.size) throw new Error('核心资源读取期间发生改变。')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await file.stat(),
      linked = await lstat(executable)
    if (
      count !== pin.size ||
      hash.digest('hex') !== pin.sha256 ||
      [after, linked].some(
        (item) =>
          item.dev !== before.dev ||
          item.ino !== before.ino ||
          item.size !== before.size ||
          item.mtimeMs !== before.mtimeMs ||
          item.ctimeMs !== before.ctimeMs ||
          item.mode !== before.mode ||
          item.nlink !== 1 ||
          item.uid !== before.uid
      )
    )
      throw new Error('核心资源摘要或版本已改变。')
  } finally {
    await file.close()
  }
}

export async function verifyCoreResource(
  root: string,
  architecture = process.arch,
  platform = process.platform
): Promise<RelayCoreResource> {
  if (platform !== 'darwin' || (architecture !== 'arm64' && architecture !== 'x64'))
    throw new Error('此版本仅提供macOS ARM或Intel核心。')
  const geodata = basename(root) === 'core-geodata-v1' && basename(dirname(root)) === 'relay',
    profile = geodata ? geodataManifest : manifest,
    pin = profile.assets[architecture]
  if (
    !isAbsolute(root) ||
    pin.path !== `darwin-${architecture}/mihomo` ||
    profile.schemaVersion !== 1 ||
    (geodata
      ? geodataManifest.version !== 'relay-geodata-v1p1-3f27' ||
        geodataManifest.capability !== 'local-geodata-v1' ||
        geodataManifest.source.commit !== '3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8'
      : manifest.version !== 'v1.19.33')
  )
    throw new Error('核心资源目录或固定清单无效。')
  try {
    const directory = await lstat(root)
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.mode & 0o022 ||
      (await realpath(root)) !== root
    )
      throw new Error()
    let selected: RelayCorePin & { version: string; path: string } = {
      ...pin,
      version: profile.version
    }
    // Only the private VariantStore namespace can opt into an additional pin.
    // The default bundled core keeps its original exact pin, even with a sidecar.
    if (
      /^core-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(basename(root)) &&
      basename(dirname(root)) === 'variants' &&
      basename(dirname(dirname(root))) === 'Variants'
    ) {
      let receipt: Buffer | undefined
      try {
        receipt = await readBinaryResource(join(root, 'relay-core.json'), true, 4096)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (receipt) {
        const request = variantImportRequest(JSON.parse(receipt.toString('utf8')))
        if (request.kind !== 'core' || request.architecture !== architecture)
          throw new Error('核心回执架构不符。')
        const trusted = trustedCoreVariant(request)
        selected = trusted
      }
    }
    const executable = join(root, selected.path)
    await verifyCoreExecutable(executable, selected)
    return {
      executable,
      version: selected.version,
      architecture,
      sha256: selected.sha256,
      ...(geodata ? { capability: 'local-geodata-v1' as const } : {})
    }
  } catch {
    throw new Error('固定核心资源缺失、改动或架构不符；未尝试其他程序。')
  }
}
