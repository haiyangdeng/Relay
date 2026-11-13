import { randomUUID } from 'crypto'
import { lstat, mkdir, mkdtemp, realpath } from 'fs/promises'
import { basename, join } from 'path'
import type { RelayStateContext } from '../context'
import type { RelayBackupRestorePlan } from '../../../shared/relay/backup'
import type { LegacyMigrationReport } from '../../../shared/relay/legacy-relay'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { readBinaryResource } from '../resources/source'
import type { backupFileNative } from '../native'
import {
  BACKUP_ARCHIVE_MAX_BYTES,
  backupHash,
  backupSnapshotSHA256,
  type BackupSnapshot
} from './archive'
import { convertLegacyClashArchive } from './legacy-clash'
import type { PreparedLegacyRelayMigration } from './legacy-relay'

interface ConversionResult {
  archiveBytes?: Buffer
  expectedBaselineSHA256: string
  report: LegacyMigrationReport
}
type RecordedMigration<T extends ConversionResult> = T & {
  migrationId: string
  recordPlan(plan: RelayBackupRestorePlan): Promise<void>
}
export type PreparedLegacyMigration = RecordedMigration<
  Awaited<ReturnType<typeof convertLegacyClashArchive>>
>
export type PreparedLegacyRelayMigrationRecord = RecordedMigration<PreparedLegacyRelayMigration>
type MigrationPublisher = (
  request: Parameters<typeof backupFileNative>[2]
) => ReturnType<typeof backupFileNative>

// Original bytes and the conversion report stay outside the managed restore
// roots. Conversion itself uses an isolated home; only the existing backup
// transaction can publish the merged result into the current Relay state.
async function prepareMigrationRecord<T extends ConversionResult>(
  context: RelayStateContext,
  baseline: BackupSnapshot,
  signal: AbortSignal,
  publishFile: MigrationPublisher,
  convert: (temporaryHome: string) => Promise<T>,
  original: Buffer | ((converted: T) => Buffer)
): Promise<RecordedMigration<T>> {
  if (signal.aborted) throw new Error('旧备份迁移已取消。')
  const baselineSHA256 = backupSnapshotSHA256(baseline)
  const files = new SubscriptionFiles(context),
    parent = join(context.stateRoot, 'Migrations'),
    migrationId = randomUUID(),
    directory = join(parent, migrationId)
  await files.directory(parent, true)
  if (((await lstat(parent)).mode & 0o7777) !== 0o700) throw new Error('迁移记录目录权限不安全。')
  await mkdir(directory, { mode: 0o700 })
  const identity = await lstat(directory)
  await files.sync(parent)
  const same = async (): Promise<void> => {
    await files.directory(directory)
    const current = await lstat(directory)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.uid !== process.getuid?.() ||
      (current.mode & 0o7777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error('本次迁移记录目录身份已变化。')
  }
  const publish = async (name: string, content: Buffer, limit: number): Promise<void> => {
    if (content.length > limit) throw new Error('迁移记录大小超限。')
    await same()
    const path = join(directory, name),
      written = await publishFile({
        namespace: 'migration',
        id: migrationId,
        directoryIdentity: {
          dev: Number(identity.dev),
          ino: Number(identity.ino),
          uid: Number(identity.uid),
          mode: Number(identity.mode)
        },
        name,
        mode: 0o600,
        bytes: content.toString('base64')
      })
    await same()
    const linked = await lstat(path)
    if (
      linked.dev !== written.identity.dev ||
      linked.ino !== written.identity.ino ||
      linked.uid !== written.identity.uid ||
      linked.mode !== written.identity.mode ||
      written.sha256 !== backupHash(content) ||
      backupHash(await readBinaryResource(path, true, limit)) !== written.sha256
    )
      throw new Error('迁移记录正文或身份未确认。')
    await files.sync(directory)
    await same()
  }
  const publishOriginal = async (bytes: Buffer): Promise<string> => {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > BACKUP_ARCHIVE_MAX_BYTES)
      throw new Error('旧备份原件大小无效。')
    await publish('original.zip', bytes, BACKUP_ARCHIVE_MAX_BYTES)
    return backupHash(bytes)
  }
  // Clash's chosen ZIP must remain durable before its parser/converter runs.
  // Relay source originals become available only from the fixed-root capture.
  let sourceSHA256 = Buffer.isBuffer(original) ? await publishOriginal(original) : undefined
  // Keep converter writes independent of the record path: replacing a migration
  // directory must not redirect isolated Profile/Source/EditStore operations.
  const temporaryHome = await realpath(await mkdtemp('/private/tmp/relay-legacy-conversion-')),
    temporaryIdentity = await lstat(temporaryHome)
  let prepared: RecordedMigration<T> | undefined, failure: Error | undefined
  try {
    if (signal.aborted) throw new Error('迁移已取消。')
    const converted = await convert(temporaryHome)
    await same()
    if (
      signal.aborted ||
      converted.expectedBaselineSHA256 !== baselineSHA256 ||
      backupSnapshotSHA256(baseline) !== baselineSHA256
    )
      throw new Error('迁移已取消或基线变化。')
    if (typeof original === 'function') sourceSHA256 = await publishOriginal(original(converted))
    if (!sourceSHA256) throw new Error('迁移原件尚未确认。')
    await publish(
      'report.json',
      Buffer.from(JSON.stringify(converted.report, null, 2)),
      4 * 1024 * 1024
    )
    const receipt = {
      version: 1,
      migrationId,
      sourceSHA256,
      baselineSHA256,
      conversionDirectoryName: basename(temporaryHome),
      candidateArchiveSHA256: converted.archiveBytes ? backupHash(converted.archiveBytes) : null
    }
    await publish('migration.json', Buffer.from(JSON.stringify(receipt)), 65536)
    prepared = {
      ...converted,
      migrationId,
      async recordPlan(plan): Promise<void> {
        await same()
        if (
          !converted.archiveBytes ||
          plan.baselineSHA256 !== baselineSHA256 ||
          plan.archiveSHA256 !== receipt.candidateArchiveSHA256
        )
          throw new Error('迁移候选与恢复凭据不符。')
        await publish(
          'restore-plan.json',
          Buffer.from(JSON.stringify({ ...receipt, restoreId: plan.id })),
          65536
        )
      }
    }
  } catch {
    // Preserve even an incomplete record; do not remove paths whose ownership
    // may have changed during conversion or an uncertain write.
    failure = new Error('旧备份迁移准备未完成；原备份及可用的私有记录保留，没有替换当前资料。')
  }
  try {
    const resolved = await realpath(temporaryHome),
      current = await lstat(temporaryHome)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== temporaryIdentity.dev ||
      current.ino !== temporaryIdentity.ino ||
      current.uid !== process.getuid?.() ||
      current.mode !== temporaryIdentity.mode ||
      (current.mode & 0o7777) !== 0o700 ||
      resolved !== temporaryHome
    )
      throw new Error('迁移转换证据目录身份变化；保留现场，未发布恢复凭据。')
    // Keep the private conversion evidence. Recursive removal by pathname
    // could delete a late replacement directory after the identity check.
  } catch {
    failure = new Error('迁移转换证据目录身份未确认；保留现场，未发布恢复凭据。')
  }
  if (signal.aborted) failure = new Error('旧备份迁移已取消；原件与私有转换证据保留。')
  if (failure) throw failure
  if (!prepared) throw new Error('旧备份迁移准备未完成。')
  return prepared
}

export async function prepareLegacyMigrationRecord(
  context: RelayStateContext,
  bytes: Buffer,
  baseline: BackupSnapshot,
  proxyPort: number | undefined,
  signal: AbortSignal,
  publishFile: MigrationPublisher
): Promise<PreparedLegacyMigration> {
  if (
    signal.aborted ||
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > BACKUP_ARCHIVE_MAX_BYTES
  )
    throw new Error('旧备份大小无效或迁移已取消。')
  return prepareMigrationRecord(
    context,
    baseline,
    signal,
    publishFile,
    (temporaryHome) =>
      convertLegacyClashArchive({ bytes, baseline, temporaryHome, proxyPort, signal }),
    bytes
  )
}

export async function prepareLegacyRelayMigrationRecord(
  context: RelayStateContext,
  baseline: BackupSnapshot,
  signal: AbortSignal,
  publishFile: MigrationPublisher,
  prepare: (temporaryHome: string) => Promise<PreparedLegacyRelayMigration>
): Promise<PreparedLegacyRelayMigrationRecord> {
  return prepareMigrationRecord(
    context,
    baseline,
    signal,
    publishFile,
    async (temporaryHome) => {
      const converted = await prepare(temporaryHome)
      if (
        converted.report.format !== 'relay-legacy-profiles-v1' ||
        !Buffer.isBuffer(converted.originalArchiveBytes) ||
        !Buffer.isBuffer(converted.archiveBytes) ||
        converted.report.originalArchiveSHA256 !== backupHash(converted.originalArchiveBytes)
      )
        throw new Error('旧Relay原件与报告摘要不符。')
      return converted
    },
    (converted) => converted.originalArchiveBytes
  )
}
