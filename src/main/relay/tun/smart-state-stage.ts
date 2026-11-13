import { constants, type Stats } from 'fs'
import { lstat, mkdir, open, readdir, rmdir, unlink, type FileHandle } from 'fs/promises'
import { join } from 'path'
import type { PreparedSmartState } from '../core/smart-state-store'
import {
  smartStateDigest,
  smartStateSchema,
  type SmartStateFile,
  type SmartStateFileData
} from '../core/smart-state-schema'
import { tunDigest } from '../../../shared/relay/tun'
import type { TunSessionBinding } from './service'
import type { TunSmartStateSnapshot } from './smart-state-channel'
import { validateSmartStateSeedMetadata } from './checked-execution'
import { parseTunHostFrame } from './wire-json'

interface Held {
  path: string
  file: FileHandle
  info: Stats
  sha256: string
}
const invalid = (): Error => new Error('Smart状态暂存身份、正文或清单变化；原件保留。')
const same = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode
const fileShape = (info: Stats, maximum: number): void => {
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o7777) !== 0o600 ||
    info.nlink !== 1 ||
    info.size < 0 ||
    info.size > maximum
  )
    throw invalid()
}
async function readHeld(file: FileHandle, info: Stats, maximum: number): Promise<Buffer> {
  fileShape(info, maximum)
  const bytes = Buffer.alloc(info.size)
  let offset = 0
  while (offset < bytes.length) {
    const read = await file.read(bytes, offset, bytes.length - offset, offset)
    if (!read.bytesRead) throw invalid()
    offset += read.bytesRead
  }
  const after = await file.stat()
  if (
    !same(info, after) ||
    after.nlink !== 1 ||
    after.size !== info.size ||
    after.mtimeMs !== info.mtimeMs ||
    after.ctimeMs !== info.ctimeMs
  )
    throw invalid()
  return bytes
}

// Created before Native bootstrap so the immutable source root never gains new
// children during execution. This object owns only seed/result staging, never
// the Core home. Unknown output or partial writes are retained without retry.
export async function createTunSmartStateStage(directory: string, prepared: PreparedSmartState) {
  validateSmartStateSeedMetadata(
    prepared.receipt,
    prepared.receipt.files.some((file) => file.path === 'smart_weight_data.csv')
  )
  const root = await lstat(directory),
    seedPath = join(directory, 'state-seed'),
    resultPath = join(directory, 'state-result'),
    held: Held[] = []
  const directories: { path: string; info: Stats }[] = []
  let accepted = false,
    settled = false,
    closed = false,
    removed = false
  const roots = async (): Promise<void> => {
    if (!same(root, await lstat(directory))) throw invalid()
    for (const entry of directories) {
      const info = await lstat(entry.path)
      if (!same(entry.info, info) || !info.isDirectory()) throw invalid()
    }
  }
  const inventory = async (path: string, expected: readonly string[]): Promise<void> => {
    if ((await readdir(path)).sort().join(',') !== [...expected].sort().join(',')) throw invalid()
  }
  const register = async (path: string, pin: SmartStateFile | { sha256: string; size: number }) => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat(),
        bytes = await readHeld(file, info, pin.size)
      if (
        info.size !== pin.size ||
        smartStateDigest(bytes) !== pin.sha256 ||
        !same(info, await lstat(path))
      )
        throw invalid()
      held.push({ path, file, info, sha256: pin.sha256 })
      return bytes
    } catch (error) {
      await file.close()
      throw error
    }
  }
  const verifyHeld = async (): Promise<void> => {
    if (closed) throw invalid()
    await roots()
    for (const entry of held) {
      const bytes = await readHeld(entry.file, entry.info, entry.info.size),
        pathInfo = await lstat(entry.path)
      if (!same(entry.info, pathInfo) || smartStateDigest(bytes) !== entry.sha256) throw invalid()
    }
    await inventory(
      seedPath,
      prepared.receipt.files.map((file) => file.path)
    )
    await inventory(
      resultPath,
      held
        .filter((file) => file.path.startsWith(resultPath + '/'))
        .map((file) => file.path.slice(resultPath.length + 1))
    )
    await roots()
  }
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await Promise.allSettled(held.map((entry) => entry.file.close()))
  }
  try {
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o7777) !== 0o700)
      throw invalid()
    for (const path of [seedPath, resultPath]) {
      await roots()
      await mkdir(path, { mode: 0o700 })
      directories.push({ path, info: await lstat(path) })
    }
    await prepared.recheck()
    const data = prepared.copyFiles()
    for (const pin of prepared.receipt.files) {
      const bytes = data.find((entry) => entry.path === pin.path)?.bytes
      if (!bytes || bytes.length !== pin.size || smartStateDigest(bytes) !== pin.sha256)
        throw invalid()
      const path = join(seedPath, pin.path),
        file = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600
        )
      try {
        await file.writeFile(bytes)
        await file.sync()
        const info = await file.stat()
        fileShape(info, pin.size)
        held.push({ path, file, info, sha256: pin.sha256 })
      } catch (error) {
        await file.close()
        throw error
      }
    }
    await verifyHeld()
    return {
      recheck: verifyHeld,
      async readResult(
        inputSnapshot: TunSmartStateSnapshot,
        inputBinding: TunSessionBinding
      ): Promise<SmartStateFileData[]> {
        const snapshot = structuredClone(inputSnapshot),
          binding = structuredClone(inputBinding)
        if (accepted || closed) throw invalid()
        accepted = true
        validateSmartStateSeedMetadata(
          {
            version: snapshot.version,
            key: snapshot.key,
            previousRevision: snapshot.previousRevision,
            files: snapshot.files
          },
          prepared.receipt.files.some((file) => file.path === 'smart_weight_data.csv')
        )
        if (
          !tunDigest(snapshot.executionSHA256) ||
          !tunDigest(snapshot.resultSHA256) ||
          snapshot.key !== prepared.receipt.key ||
          snapshot.previousRevision !== prepared.receipt.previousRevision
        )
          throw invalid()
        await roots()
        await inventory(resultPath, [...snapshot.files.map((file) => file.path), 'receipt.json'])
        const metadataPath = join(resultPath, 'receipt.json'),
          metadataInfo = await lstat(metadataPath)
        fileShape(metadataInfo, 16384)
        const metadata = await register(metadataPath, {
            size: metadataInfo.size,
            sha256: snapshot.resultSHA256
          }),
          raw = parseTunHostFrame(metadata, 16384)
        if (
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          Object.keys(raw).sort().join(',') !==
            'evidenceSHA256,executionSHA256,files,key,kind,previousRevision,runtimeConfigurationSHA256,sessionId,version' ||
          !('version' in raw) ||
          raw.version !== 1 ||
          !('kind' in raw) ||
          raw.kind !== 'relay-smart-state-result' ||
          !('sessionId' in raw) ||
          raw.sessionId !== binding.sessionId ||
          !('evidenceSHA256' in raw) ||
          raw.evidenceSHA256 !== binding.evidenceSHA256 ||
          !('runtimeConfigurationSHA256' in raw) ||
          raw.runtimeConfigurationSHA256 !== binding.runtimeConfigurationSHA256 ||
          !('executionSHA256' in raw) ||
          raw.executionSHA256 !== snapshot.executionSHA256 ||
          !('key' in raw) ||
          raw.key !== snapshot.key ||
          !('previousRevision' in raw) ||
          raw.previousRevision !== snapshot.previousRevision ||
          !('files' in raw) ||
          JSON.stringify(raw.files) !== JSON.stringify(snapshot.files)
        )
          throw invalid()
        const result: SmartStateFileData[] = []
        let total = 0
        for (const pin of snapshot.files) {
          total += pin.size
          if (pin.size > smartStateSchema.fileByteLimit || total > smartStateSchema.totalByteLimit)
            throw invalid()
          result.push({ path: pin.path, bytes: await register(join(resultPath, pin.path), pin) })
        }
        await verifyHeld()
        settled = true
        return result
      },
      async cleanup(): Promise<void> {
        if (removed) return
        if (accepted && !settled) throw invalid()
        await verifyHeld()
        // Validate the entire known union before the first unlink. No basename
        // adoption or recursive removal after an unknown Native result.
        for (const entry of held) await unlink(entry.path)
        for (const entry of [...directories].reverse()) await rmdir(entry.path)
        removed = true
        await close()
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
