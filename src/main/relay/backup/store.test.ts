import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  rename,
  readdir
} from 'fs/promises'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { BackupRecovery } from './recovery'
import { RelayBackupStore } from './store'
import { recoveryFixtureAdapters, readRecoveryJournal } from './recovery.test-fixture'
import {
  backupSnapshotSHA256,
  createBackupArchive,
  readBackupArchive,
  type BackupSnapshot
} from './archive'

afterEach(() => vi.restoreAllMocks())

async function fixture(
  run: (context: { home: string; stateRoot: string; store: RelayBackupStore }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-backup-'))
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
  await mkdir(join(context.stateRoot, 'Configuration'), { recursive: true, mode: 0o700 })
  await writeFile(join(context.stateRoot, 'Configuration/configuration-edit.json'), 'original', {
    mode: 0o600
  })
  try {
    await run({
      ...context,
      store: new RelayBackupStore(context, recoveryFixtureAdapters(context))
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
const target = (): BackupSnapshot => ({
  directories: ['Configuration', 'Configurations', 'Configurations/empty'],
  entries: [
    { path: 'Configuration/configuration-edit.json', mode: 0o600, bytes: Buffer.from('restored') }
  ]
})

describe('Private backup storage and restore conflicts', () => {
  it('only includes fixed Relay persistent data, preserving runtime, backups and unrelated files', async () => {
    await fixture(async ({ stateRoot, store }) => {
      await mkdir(join(stateRoot, 'Core'), { mode: 0o700 })
      await writeFile(join(stateRoot, 'Core/session.json'), 'active-pid', { mode: 0o600 })
      await writeFile(join(stateRoot, 'Core/selection.json'), 'selection', { mode: 0o600 })
      await mkdir(join(stateRoot, 'NativeRuntime'), { mode: 0o700 })
      await writeFile(join(stateRoot, 'NativeRuntime/worker'), 'runtime', { mode: 0o600 })
      await mkdir(join(stateRoot, 'UI'), { mode: 0o700 })
      await writeFile(join(stateRoot, 'UI/shell.json'), '{"theme":"dark"}', { mode: 0o600 })
      const archive = await store.archive()
      const paths = readBackupArchive(archive.bytes).manifest.files.map((file) => file.path)
      expect(paths).toEqual([
        'Configuration/configuration-edit.json',
        'Core/selection.json',
        'UI/shell.json'
      ])
      expect(archive.containsSecrets).toBe(true)
      const staged = await store.stageRestore(createBackupArchive(target()))
      expect(staged.replacedFiles).toBe(1)
      expect(staged.removedFiles).toBe(2)
      expect(await store.commitRestore(staged.id, staged.baselineSHA256, () => {})).toBe('restored')
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'restored'
      )
      expect(await readFile(join(stateRoot, 'Core/session.json'), 'utf8')).toBe('active-pid')
      expect(await readFile(join(stateRoot, 'NativeRuntime/worker'), 'utf8')).toBe('runtime')
      expect(
        await readFile(
          join(
            stateRoot,
            'ApplicationBackups/restore-' + staged.id,
            'original/Configuration/configuration-edit.json'
          ),
          'utf8'
        )
      ).toBe('original')
      expect(
        JSON.parse(
          await readRecoveryJournal(join(stateRoot, 'ApplicationBackups/restore-' + staged.id))
        ).phase
      ).toBe('applied')
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(staged.targetSHA256)
    })
  })
  it('refuses target edits and file additions after preparation before moving any managed root', async () => {
    await fixture(async ({ stateRoot, store }) => {
      const staged = await store.stageRestore(createBackupArchive(target()))
      await writeFile(join(stateRoot, 'Configuration/new.json'), 'external', { mode: 0o600 })
      await expect(store.commitRestore(staged.id, staged.baselineSHA256, () => {})).rejects.toThrow(
        '未知修改'
      )
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'original'
      )
    })
  })
  it('refuses tampered staged files and a non-idle lifecycle gate without restoring data', async () => {
    await fixture(async ({ stateRoot, store }) => {
      const staged = await store.stageRestore(createBackupArchive(target()))
      await expect(
        store.commitRestore(staged.id, staged.baselineSHA256, () => {
          throw new Error('runtime active')
        })
      ).rejects.toThrow('runtime active')
      await writeFile(
        join(
          stateRoot,
          'ApplicationBackups/restore-' + staged.id,
          'candidate/Configuration/configuration-edit.json'
        ),
        'tampered',
        { mode: 0o600 }
      )
      await expect(store.commitRestore(staged.id, staged.baselineSHA256, () => {})).rejects.toThrow(
        '未完成或未知'
      )
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'original'
      )
    })
  })
  it('rejects symlinks, hardlinks and active lock directories while collecting', async () => {
    await fixture(async ({ home, stateRoot, store }) => {
      const path = join(stateRoot, 'Configuration/link.json')
      await writeFile(join(home, 'outside'), 'external', { mode: 0o600 })
      await symlink(join(home, 'outside'), path)
      await expect(store.snapshot()).rejects.toThrow()
      await rm(path)
      await link(join(home, 'outside'), path)
      await expect(store.snapshot()).rejects.toThrow()
      await rm(path)
      await mkdir(join(stateRoot, 'Configuration/.write-lock'), { mode: 0o700 })
      await expect(store.snapshot()).rejects.toThrow('活动锁')
    })
  })
  it('rechecks both unchanged snapshots after a conflict before the first rename, consumes the old proof and permits a fresh preparation', async () => {
    await fixture(async ({ home, stateRoot, store }) => {
      const archive = createBackupArchive(target()),
        staged = await store.stageRestore(archive),
        directory = join(stateRoot, 'ApplicationBackups/restore-' + staged.id)
      let calls = 0
      await expect(
        store.commitRestore(staged.id, staged.baselineSHA256, () => {
          if (++calls === 2) throw new Error('lifecycle changed before first rename')
        })
      ).rejects.toThrow('当前数据未写入')
      expect(JSON.parse(await readRecoveryJournal(directory))).toMatchObject({
        phase: 'staged',
        completed: []
      })
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(staged.baselineSHA256)
      expect(
        await readFile(join(directory, 'candidate/Configuration/configuration-edit.json'), 'utf8')
      ).toBe('restored')
      expect(await readFile(join(directory, 'archive.zip'))).toEqual(archive)
      expect(await readFile(join(directory, 'recheck-pending'), 'utf8')).toBe('v1\n')
      expect(
        (await readdir(directory)).some((name) => /^settled-[a-f0-9]{64}\.json$/u.test(name))
      ).toBe(true)
      expect(await new RelayBackupStore({ home, stateRoot }).unresolved()).toEqual([])
      await expect(store.commitRestore(staged.id, staged.baselineSHA256, () => {})).rejects.toThrow(
        '重新准备'
      )
      expect((await store.archive()).containsSecrets).toBe(true)
      expect((await store.stageRestore(createBackupArchive(target()))).id).not.toBe(staged.id)
    })
  })
  it.each(['current', 'candidate'] as const)(
    'retains an unresolved record if %s changes before the zero-mutation recheck',
    async (location) => {
      await fixture(async ({ home, stateRoot, store }) => {
        const staged = await store.stageRestore(createBackupArchive(target())),
          directory = join(stateRoot, 'ApplicationBackups/restore-' + staged.id),
          changed = join(
            location === 'current' ? stateRoot : join(directory, 'candidate'),
            'Configuration/configuration-edit.json'
          )
        let calls = 0
        await expect(
          store.commitRestore(staged.id, staged.baselineSHA256, () => {
            if (++calls === 2) {
              writeFileSync(changed, 'unknown edit during restore failure')
              throw new Error('conflict before rename')
            }
          })
        ).rejects.toThrow('当前数据未写入')
        expect(JSON.parse(await readRecoveryJournal(directory)).phase).toBe('uncertain')
        expect(await readFile(changed, 'utf8')).toBe('unknown edit during restore failure')
        expect(await new RelayBackupStore({ home, stateRoot }).unresolved()).toEqual([
          'restore-' + staged.id
        ])
        await expect(store.archive()).rejects.toThrow('完整备份')
        await expect(store.stageRestore(createBackupArchive(target()))).rejects.toThrow('未完成')
      })
    }
  )
  it('does not converge a zero-mutation record when the current snapshot cannot be re-read', async () => {
    await fixture(async ({ home, stateRoot, store }) => {
      const staged = await store.stageRestore(createBackupArchive(target())),
        snapshot = store.snapshot.bind(store)
      vi.spyOn(store, 'snapshot')
        .mockImplementationOnce(snapshot)
        .mockRejectedValueOnce(new Error('recheck read failed'))
      let calls = 0
      await expect(
        store.commitRestore(staged.id, staged.baselineSHA256, () => {
          if (++calls === 2) throw new Error('conflict before rename')
        })
      ).rejects.toThrow('当前数据未写入')
      expect(await new RelayBackupStore({ home, stateRoot }).unresolved()).toEqual([
        'restore-' + staged.id
      ])
    })
  })
  it.each([false, true])(
    'keeps a durable cross-restart blocker after staged publication sync fails (uncertain rewrite also fails: %s)',
    async (failUncertainRewrite) => {
      await fixture(async ({ home, stateRoot, store }) => {
        const staged = await store.stageRestore(createBackupArchive(target())),
          directory = join(stateRoot, 'ApplicationBackups/restore-' + staged.id),
          persist = BackupRecovery.prototype.persist,
          sync = SubscriptionFiles.prototype.sync
        let rechecking = false,
          stagedSyncFailed = false,
          uncertainRewriteFailed = false
        vi.spyOn(BackupRecovery.prototype, 'persist').mockImplementation(async function (
          this: BackupRecovery,
          path,
          journal
        ) {
          if (
            failUncertainRewrite &&
            stagedSyncFailed &&
            path === directory &&
            journal.phase === 'uncertain'
          ) {
            uncertainRewriteFailed = true
            throw new Error('uncertain revision publication failed')
          }
          await persist.call(this, path, journal)
        })
        vi.spyOn(SubscriptionFiles.prototype, 'sync').mockImplementation(async function (
          this: SubscriptionFiles,
          path
        ) {
          if (
            rechecking &&
            path === directory &&
            JSON.parse(await readRecoveryJournal(directory)).phase === 'staged'
          ) {
            stagedSyncFailed = true
            throw new Error('staged journal was replaced but directory sync failed')
          }
          await sync.call(this, path)
        })
        let calls = 0
        await expect(
          store.commitRestore(staged.id, staged.baselineSHA256, () => {
            if (++calls === 2) {
              rechecking = true
              throw new Error('conflict before rename')
            }
          })
        ).rejects.toThrow('当前数据未写入')
        expect(stagedSyncFailed).toBe(true)
        expect(uncertainRewriteFailed).toBe(failUncertainRewrite)
        expect(JSON.parse(await readRecoveryJournal(directory)).phase).toBe(
          failUncertainRewrite ? 'staged' : 'uncertain'
        )
        expect(await readFile(join(directory, 'recheck-pending'), 'utf8')).toBe('v1\n')
        const reopened = new RelayBackupStore({ home, stateRoot })
        expect(await reopened.unresolved()).toEqual(['restore-' + staged.id])
        await expect(reopened.archive()).rejects.toThrow('完整备份')
        await expect(reopened.stageRestore(createBackupArchive(target()))).rejects.toThrow('未完成')
        expect(backupSnapshotSHA256(await reopened.snapshot())).toBe(staged.baselineSHA256)
      })
    }
  )
  it.each(['overwrite', 'replace'] as const)(
    'preserves an unknown marker after %s during the final journal sync',
    async (change) => {
      await fixture(async ({ home, stateRoot, store }) => {
        const staged = await store.stageRestore(createBackupArchive(target())),
          directory = join(stateRoot, 'ApplicationBackups/restore-' + staged.id),
          marker = join(directory, 'recheck-pending'),
          sync = SubscriptionFiles.prototype.sync
        let rechecking = false,
          changed = false
        vi.spyOn(SubscriptionFiles.prototype, 'sync').mockImplementation(async function (
          this: SubscriptionFiles,
          path
        ) {
          await sync.call(this, path)
          if (
            rechecking &&
            !changed &&
            path === directory &&
            JSON.parse(await readRecoveryJournal(directory)).phase === 'staged'
          ) {
            changed = true
            if (change === 'replace') await rename(marker, marker + '-owned')
            await writeFile(marker, 'FOREIGN-MARKER', { mode: 0o600 })
          }
        })
        let calls = 0
        await expect(
          store.commitRestore(staged.id, staged.baselineSHA256, () => {
            if (++calls === 2) {
              rechecking = true
              throw new Error('conflict before first rename')
            }
          })
        ).rejects.toThrow('当前数据未写入')
        expect(changed).toBe(true)
        expect(await readFile(marker, 'utf8')).toBe('FOREIGN-MARKER')
        expect(JSON.parse(await readRecoveryJournal(directory)).phase).toBe('uncertain')
        expect(await new RelayBackupStore({ home, stateRoot }).unresolved()).toEqual([
          'restore-' + staged.id
        ])
        expect(backupSnapshotSHA256(await store.snapshot())).toBe(staged.baselineSHA256)
      })
    }
  )
  it('preserves a replacement restore directory and its foreign marker without journal writes or unlink', async () => {
    await fixture(async ({ home, stateRoot, store }) => {
      const staged = await store.stageRestore(createBackupArchive(target())),
        directory = join(stateRoot, 'ApplicationBackups/restore-' + staged.id),
        retained = directory + '-retained',
        foreignJournal = JSON.stringify({ version: 1, phase: 'staged', foreign: true }),
        sync = SubscriptionFiles.prototype.sync
      let rechecking = false,
        changed = false
      vi.spyOn(SubscriptionFiles.prototype, 'sync').mockImplementation(async function (
        this: SubscriptionFiles,
        path
      ) {
        await sync.call(this, path)
        if (
          rechecking &&
          !changed &&
          path === directory &&
          JSON.parse(await readRecoveryJournal(directory)).phase === 'staged'
        ) {
          changed = true
          await rename(directory, retained)
          await mkdir(directory, { mode: 0o700 })
          await writeFile(join(directory, 'journal.json'), foreignJournal, { mode: 0o600 })
          await writeFile(join(directory, 'recheck-pending'), 'FOREIGN-MARKER', { mode: 0o600 })
        }
      })
      let calls = 0
      await expect(
        store.commitRestore(staged.id, staged.baselineSHA256, () => {
          if (++calls === 2) {
            rechecking = true
            throw new Error('conflict before first rename')
          }
        })
      ).rejects.toThrow('当前数据未写入')
      expect(changed).toBe(true)
      expect(await readRecoveryJournal(directory)).toBe(foreignJournal)
      expect(await readFile(join(directory, 'recheck-pending'), 'utf8')).toBe('FOREIGN-MARKER')
      expect(await readFile(join(retained, 'recheck-pending'), 'utf8')).toBe('v1\n')
      expect(await new RelayBackupStore({ home, stateRoot }).unresolved()).toEqual([
        'restore-' + staged.id
      ])
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(staged.baselineSHA256)
    })
  })
  it('preserves originals and a journal on a mid-transaction lifecycle conflict', async () => {
    await fixture(async ({ stateRoot, store }) => {
      const staged = await store.stageRestore(createBackupArchive(target()))
      const result = await store.commitRestore(staged.id, staged.baselineSHA256, () => {
        if (
          existsSync(join(stateRoot, 'Configurations')) &&
          !existsSync(
            join(stateRoot, 'ApplicationBackups/restore-' + staged.id, 'candidate/Configurations')
          )
        )
          throw new Error('another operation started after the first root moved')
      })
      expect(result).toBe('uncertain')
      const journal = JSON.parse(
        await readRecoveryJournal(join(stateRoot, 'ApplicationBackups/restore-' + staged.id))
      )
      expect(journal.phase).toBe('uncertain')
      expect((await store.unresolved()).length).toBe(1)
      await expect(store.stageRestore(createBackupArchive(target()))).rejects.toThrow('未完成')
      await expect(store.archive()).rejects.toThrow('完整备份')
      expect(journal.completed).toEqual(['Configurations'])
      expect(await readFile(join(stateRoot, 'Configuration/configuration-edit.json'), 'utf8')).toBe(
        'original'
      )
      await expect(store.commitRestore(staged.id, staged.baselineSHA256, () => {})).rejects.toThrow(
        '未完成'
      )
    })
  })
})

describe('Native Code backup namespace isolation', () => {
  it('keeps native manifest inventories separate from full private-data restoration journals', async () => {
    await fixture(async ({ stateRoot, store }) => {
      const native = join(stateRoot, 'Backups', 'code-existing')
      await mkdir(native, { recursive: true, mode: 0o700 })
      const manifest = '{"version":2,"phase":"committed","entries":[]}'
      await writeFile(join(native, 'manifest.json'), manifest, { mode: 0o600 })
      const plan = await store.stageRestore(createBackupArchive(target()))
      expect(await readFile(join(native, 'manifest.json'), 'utf8')).toBe(manifest)
      expect(
        await readFile(
          join(stateRoot, 'ApplicationBackups', 'restore-' + plan.id, 'journal.json'),
          'utf8'
        )
      ).toContain('baselineSHA256')
      expect(
        (await store.snapshot()).entries.some((entry) => entry.path.startsWith('Backups/'))
      ).toBe(false)
    })
  })
})
