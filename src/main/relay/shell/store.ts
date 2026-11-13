import { constants } from 'fs'
import { mkdir, open, readFile } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  defaultShellSettings,
  relayShellAppearanceKeys,
  relayShellDisplayKeys,
  relayShellStartupKeys,
  shellDisplaySettings,
  shellSettings,
  type RelayShellDisplaySettings,
  type RelayShellRecord,
  type RelayShellSettings
} from '../../../shared/relay/shell'
import { atomicWriteFile } from '../../utils/safeFile'

export const maxShellBytes = 262144
export const maxDisplayBytes = 2048
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const extensions = [
  { filename: 'shell-display.json', keys: relayShellAppearanceKeys },
  { filename: 'shell-startup.json', keys: relayShellStartupKeys }
] as const
const legacySettings = (settings: RelayShellSettings): RelayShellSettings => {
  const base = { ...settings }
  for (const key of relayShellDisplayKeys) delete base[key]
  return base
}

async function readDisplayFile(path: string): Promise<Buffer | undefined> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (!file) return undefined
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      stat.size > maxDisplayBytes ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error('窗口显示偏好文件不安全。')
    const bytes = Buffer.alloc(maxDisplayBytes + 1)
    const { bytesRead } = await file.read(bytes)
    if (bytesRead !== stat.size) throw new Error('窗口显示偏好读取期间已变化。')
    return bytes.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

function parseDisplayFile(
  bytes: Buffer,
  keys: readonly string[]
): Map<string, RelayShellDisplaySettings> {
  if (bytes.length > maxDisplayBytes) throw new Error('窗口显示偏好超过大小限制。')
  const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  if (
    !doc ||
    typeof doc !== 'object' ||
    !('version' in doc) ||
    doc.version !== 1 ||
    !('entries' in doc) ||
    !Array.isArray(doc.entries) ||
    doc.entries.length > 2 ||
    Object.keys(doc).length !== 2
  )
    throw new Error('窗口显示偏好格式无效。')
  const entries = new Map<string, RelayShellDisplaySettings>()
  for (const raw of doc.entries as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('窗口显示偏好记录无效。')
    const { baseRevision, ...fields } = raw as Record<string, unknown>
    if (
      typeof baseRevision !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(baseRevision) ||
      entries.has(baseRevision) ||
      Object.keys(fields).some((key) => !keys.includes(key))
    )
      throw new Error('窗口显示偏好记录无效。')
    entries.set(baseRevision, shellDisplaySettings(fields))
  }
  return entries
}

interface ShellStorage {
  record: RelayShellRecord
  baseRevision: string
  extensions: { revision: string; settings: RelayShellDisplaySettings }[]
}

export function readShellSnapshot(
  bytes?: Buffer,
  appearance?: Buffer,
  startup?: Buffer
): ShellStorage {
  if (bytes && bytes.length > maxShellBytes) throw new Error('窗口偏好超过持久化大小限制。')
  const baseRevision = bytes ? digest(bytes) : ''
  const normalized = bytes
    ? shellSettings(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    : defaultShellSettings()
  const base = legacySettings(normalized)
  const files = [appearance, startup].map((sidecar, index) => ({
    revision: sidecar ? digest(sidecar) : '',
    settings: sidecar
      ? (parseDisplayFile(sidecar, extensions[index].keys).get(baseRevision) ?? {})
      : {}
  }))
  const display = { ...files[0].settings, ...files[1].settings }
  const revision = Object.keys(display).length
    ? digest(JSON.stringify({ baseRevision, display }))
    : baseRevision
  return {
    record: { settings: { ...display, ...base }, revision, exists: !!bytes },
    baseRevision,
    extensions: files
  }
}

export class RelayShellStore {
  private readonly path: string
  private readonly extensionPaths: string[]
  constructor(context: { stateRoot: string }) {
    this.path = join(context.stateRoot, 'UI', 'shell.json')
    this.extensionPaths = extensions.map(({ filename }) => join(context.stateRoot, 'UI', filename))
  }
  private async storage(): Promise<ShellStorage> {
    try {
      const bytes = await readFile(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      })
      const [appearance, startup] = await Promise.all(this.extensionPaths.map(readDisplayFile))
      return readShellSnapshot(bytes, appearance, startup)
    } catch {
      throw new Error('Relay窗口偏好读取失败，请保留现有文件。')
    }
  }
  async read(): Promise<RelayShellRecord> {
    return (await this.storage()).record
  }
  async save(value: RelayShellSettings, expectedRevision: string): Promise<RelayShellRecord> {
    const settings = shellSettings(value)
    const previous = await this.storage()
    if (previous.record.revision !== expectedRevision)
      throw new Error('窗口偏好已被其他操作修改，请重新读取。')
    const next = extensions.map(({ keys }) =>
      shellDisplaySettings(
        Object.fromEntries(
          keys.filter((key) => Object.hasOwn(settings, key)).map((key) => [key, settings[key]])
        )
      )
    )
    const changes = next.map(
      (options, index) =>
        JSON.stringify(previous.extensions[index].settings) !== JSON.stringify(options)
    )
    let text = JSON.stringify(legacySettings(settings), null, 2)
    // If both extensions change, one base rename commits both selections.
    // Preserve the legacy JSON shape and use a distinct whitespace digest.
    if (changes.every(Boolean) && digest(text) === previous.baseRevision) text += '\n'
    if (Buffer.byteLength(text) > maxShellBytes) throw new Error('窗口偏好超过持久化大小限制。')
    const baseRevision = digest(text)
    await mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 })
    const revisions = previous.extensions.map(({ revision }) => revision)
    const verify = (current: ShellStorage, expectedBase: string): boolean =>
      current.baseRevision === expectedBase &&
      current.extensions.every(({ revision }, index) => revision === revisions[index])
    if (!verify(await this.storage(), previous.baseRevision))
      throw new Error('窗口偏好已被其他操作修改，请重新读取。')
    const baseChanged = previous.baseRevision !== baseRevision
    for (const [index, options] of next.entries()) {
      const old = previous.extensions[index]
      if (!changes[index] && !(baseChanged && (old.revision || Object.keys(options).length)))
        continue
      // Stage the old and new display selections. Until the base rename
      // commits, a reader still resolves the old digest, even after a crash.
      const entries = [
        ...(baseChanged && Object.keys(old.settings).length
          ? [{ baseRevision: previous.baseRevision, ...old.settings }]
          : []),
        ...(Object.keys(options).length ? [{ baseRevision, ...options }] : [])
      ]
      const encoded = JSON.stringify({ version: 1, entries })
      await atomicWriteFile(this.extensionPaths[index], encoded, { mode: 0o600 })
      revisions[index] = digest(encoded)
    }
    if (baseChanged) {
      if (!verify(await this.storage(), previous.baseRevision))
        throw new Error('窗口偏好保存期间已变化，请重新读取。')
      await atomicWriteFile(this.path, text, { mode: 0o600 })
    }
    const saved = await this.storage()
    if (!verify(saved, baseRevision)) throw new Error('窗口偏好保存结果未确认，请重新读取。')
    return saved.record
  }
}
