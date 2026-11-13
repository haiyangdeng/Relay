import { resolve } from 'path'
import type { RelayStateContext } from '../context'
import { backupMoveNative, backupPublishNative, backupFileNative } from '../native'
import type {
  BackupRecoveryMoveRequest,
  BackupRecoveryPublishRequest,
  BackupFileRequest,
  BackupFileReceipt
} from './recovery'

// Test-only bridge to the actual packaged Darwin exclusive-rename primitive.
// Missing/unavailable native code fails the fixture; there is no rename fallback.
export function recoveryFixtureAdapters(context: RelayStateContext): {
  moveExclusive(request: BackupRecoveryMoveRequest): Promise<void>
  publishExclusive(request: BackupRecoveryPublishRequest): Promise<void>
  publishFile(request: BackupFileRequest): Promise<BackupFileReceipt>
} {
  return {
    publishFile: (request) =>
      backupFileNative(
        process.env.RELAY_BACKUP_MOVE_EXECUTABLE ?? resolve('extra/relay/RelayNative'),
        context,
        request
      ),
    publishExclusive: (request) =>
      backupPublishNative(
        process.env.RELAY_BACKUP_MOVE_EXECUTABLE ?? resolve('extra/relay/RelayNative'),
        context,
        request
      ),
    moveExclusive: (request) =>
      backupMoveNative(
        process.env.RELAY_BACKUP_MOVE_EXECUTABLE ?? resolve('extra/relay/RelayNative'),
        context,
        request
      )
  }
}

// Tests observe the immutable chain's current body; journal.json stays the anchor.
export async function readRecoveryJournal(directory: string): Promise<string> {
  const { readdir, readFile } = await import('fs/promises')
  const { join } = await import('path')
  const names = (await readdir(directory))
    .filter((name) => /^journal-[0-9]{6}\.json$/u.test(name))
    .sort()
  const latest = names.at(-1)
  const raw = await readFile(join(directory, latest ?? 'journal.json'), 'utf8')
  return latest ? JSON.stringify(JSON.parse(raw).journal) : raw
}
