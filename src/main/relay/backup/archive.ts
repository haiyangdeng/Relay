import { createHash } from 'crypto'
import { posix } from 'path'
import AdmZip from 'adm-zip'

export const backupDirectories = [
  'Configurations',
  'ProviderResources',
  'ResourceSnapshots',
  'SubscriptionSources',
  'Configuration',
  'Variants',
  'UI',
  'SubStore/Data',
  'Plugins'
] as const
export const backupFiles = ['preferences.json', 'Core/selection.json'] as const
export const BACKUP_MAX_BYTES = 256 * 1024 * 1024
export const BACKUP_MAX_FILES = 2000
export const BACKUP_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024
export interface BackupEntry {
  path: string
  mode: 0o600 | 0o700
  bytes: Buffer
}
export interface BackupSnapshot {
  directories: string[]
  entries: BackupEntry[]
}
export interface BackupManifest {
  format: 'relay-private-backup'
  version: 1
  createdAt: string
  containsSecrets: true
  directories: string[]
  files: { path: string; mode: 0o600 | 0o700; size: number; sha256: string }[]
}
export const backupHash = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex')

export function backupPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > 1024 ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\'
    ) ||
    posix.normalize(value) !== value ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part.startsWith('.')) ||
    !(
      backupFiles.some((file) => file === value) ||
      backupDirectories.some((root) => value === root || value.startsWith(root + '/'))
    )
  )
    throw new Error('备份条目路径不在Relay私有持久数据范围。')
  return value
}
function checkedSnapshot(snapshot: BackupSnapshot): BackupSnapshot {
  if (
    !snapshot ||
    !Array.isArray(snapshot.directories) ||
    !Array.isArray(snapshot.entries) ||
    snapshot.directories.length + snapshot.entries.length > BACKUP_MAX_FILES
  )
    throw new Error('备份清单无效或条目超限。')
  const names = new Set<string>()
  const folded = new Set<string>()
  const add = (path: string): void => {
    const identity = path.normalize('NFC').toLocaleLowerCase('en-US')
    if (names.has(path) || folded.has(identity)) throw new Error('备份路径重复或在macOS上冲突。')
    names.add(path)
    folded.add(identity)
  }
  const directories = snapshot.directories
    .map((value) => {
      const path = backupPath(value)
      if (backupFiles.some((file) => file === path) || names.has(path))
        throw new Error('备份目录重复或无效。')
      add(path)
      return path
    })
    .sort()
  let total = 0
  const entries = snapshot.entries
    .map((entry) => {
      const path = backupPath(entry.path)
      if (
        names.has(path) ||
        backupDirectories.some((root) => root === path) ||
        !Buffer.isBuffer(entry.bytes) ||
        ![0o600, 0o700].includes(entry.mode)
      )
        throw new Error('备份文件重复、权限或正文无效。')
      add(path)
      total += entry.bytes.length
      if (total > BACKUP_MAX_BYTES) throw new Error('备份正文合计超限。')
      return { path, mode: entry.mode, bytes: Buffer.from(entry.bytes) }
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'en'))
  for (const entry of entries) {
    if (entries.some((other) => other !== entry && entry.path.startsWith(other.path + '/')))
      throw new Error('备份文件与目录路径冲突。')
    if (directories.some((directory) => directory.startsWith(entry.path + '/')))
      throw new Error('备份文件与目录路径冲突。')
  }
  for (const path of [...directories, ...entries.map((entry) => entry.path)]) {
    if (
      backupFiles.some((file) => file === path) ||
      backupDirectories.some((root) => root === path)
    )
      continue
    const parent = posix.dirname(path)
    if (parent !== '.' && !directories.includes(parent)) throw new Error('备份条目缺少所属目录。')
  }
  return { directories, entries }
}
function manifest(snapshot: BackupSnapshot, createdAt: string): BackupManifest {
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('备份日期无效。')
  return {
    format: 'relay-private-backup',
    version: 1,
    createdAt,
    containsSecrets: true,
    directories: snapshot.directories,
    files: snapshot.entries.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      size: entry.bytes.length,
      sha256: backupHash(entry.bytes)
    }))
  }
}
export function backupSnapshotSHA256(input: BackupSnapshot): string {
  return backupHash(
    Buffer.from(JSON.stringify(manifest(checkedSnapshot(input), '2000-01-01T00:00:00.000Z')))
  )
}
export function createBackupArchive(
  input: BackupSnapshot,
  createdAt = new Date().toISOString()
): Buffer {
  const snapshot = checkedSnapshot(input)
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest(snapshot, createdAt))))
  for (const entry of snapshot.entries) zip.addFile('files/' + entry.path, entry.bytes)
  const bytes = zip.toBuffer()
  if (bytes.length > BACKUP_ARCHIVE_MAX_BYTES) throw new Error('备份压缩文件超限。')
  return bytes
}
export function readBackupArchive(bytes: Buffer): {
  manifest: BackupManifest
  snapshot: BackupSnapshot
} {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > BACKUP_ARCHIVE_MAX_BYTES)
    throw new Error('备份压缩文件大小无效。')
  try {
    const zip = new AdmZip(bytes)
    const archive = zip.getEntries()
    if (archive.length > BACKUP_MAX_FILES + 1) throw new Error()
    const names = new Set<string>()
    let total = 0
    for (const entry of archive) {
      total += entry.header.size
      if (
        entry.isDirectory ||
        names.has(entry.entryName) ||
        entry.header.size > BACKUP_MAX_BYTES ||
        total > BACKUP_MAX_BYTES + 1024 * 1024 ||
        ((entry.attr >>> 16) & 0o170000) === 0o120000
      )
        throw new Error()
      names.add(entry.entryName)
    }
    const metadata = zip.getEntry('manifest.json')
    if (!metadata || metadata.header.size > 1024 * 1024) throw new Error()
    const value: unknown = JSON.parse(metadata.getData().toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    const raw = value as Record<string, unknown>
    if (
      Object.keys(raw).sort().join(',') !==
        'containsSecrets,createdAt,directories,files,format,version' ||
      raw.format !== 'relay-private-backup' ||
      raw.version !== 1 ||
      raw.containsSecrets !== true ||
      typeof raw.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(raw.createdAt)) ||
      !Array.isArray(raw.files) ||
      !Array.isArray(raw.directories) ||
      names.size !== raw.files.length + 1
    )
      throw new Error()
    const files: BackupEntry[] = raw.files.map((file: unknown) => {
      if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error()
      const record = file as Record<string, unknown>
      if (
        Object.keys(record).sort().join(',') !== 'mode,path,sha256,size' ||
        ![0o600, 0o700].includes(Number(record.mode)) ||
        typeof record.mode !== 'number' ||
        typeof record.size !== 'number' ||
        !Number.isSafeInteger(record.size) ||
        record.size < 0 ||
        record.size > BACKUP_MAX_BYTES ||
        typeof record.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(record.sha256)
      )
        throw new Error()
      const path = backupPath(record.path)
      const archived = zip.getEntry('files/' + path)
      if (!archived || archived.header.size !== record.size) throw new Error()
      const content = archived.getData()
      if (content.length !== record.size || backupHash(content) !== record.sha256) throw new Error()
      return { path, mode: record.mode as BackupEntry['mode'], bytes: content }
    })
    const snapshot = checkedSnapshot({ directories: raw.directories as string[], entries: files })
    return { manifest: manifest(snapshot, raw.createdAt), snapshot }
  } catch {
    throw new Error('备份清单、路径、版本或正文完整性未通过校验，未解压到用户目录。')
  }
}
