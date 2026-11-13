import { existsSync, writeFileSync, readdirSync } from 'fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { createWindowGeometryHost, flushWindowGeometryForExit } from '../shell/window-geometry-host'
import { createWindowGeometryService, RelayWindowStateStore } from '../shell/window-state'
import { RelayBackupStore } from './store'
import { recoveryFixtureAdapters, readRecoveryJournal } from './recovery.test-fixture'
import {
  backupSnapshotSHA256,
  createBackupArchive,
  readBackupArchive,
  type BackupSnapshot
} from './archive'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
type ExclusiveMove = ReturnType<typeof recoveryFixtureAdapters>['moveExclusive']
async function fixture(
  run: (f: {
    home: string
    stateRoot: string
    store: RelayBackupStore
    before: BackupSnapshot
    target: BackupSnapshot
    staged: Awaited<ReturnType<RelayBackupStore['stageRestore']>>
    directory: string
    move: Mock<ExclusiveMove>
    publish: ReturnType<
      typeof vi.fn<ReturnType<typeof recoveryFixtureAdapters>['publishExclusive']>
    >
    nativePublish: ReturnType<typeof recoveryFixtureAdapters>['publishExclusive']
    nativeMove: ExclusiveMove
    reopen(): RelayBackupStore
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-recovery-v2-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
    stateRoot = context.stateRoot
  await mkdir(join(stateRoot, 'Configuration'), { recursive: true, mode: 0o700 })
  await mkdir(join(stateRoot, 'Plugins'), { mode: 0o700 })
  await writeFile(join(stateRoot, 'Configuration/edit.json'), 'original-private', { mode: 0o600 })
  await writeFile(join(stateRoot, 'Plugins/old.json'), 'removed-by-restore', { mode: 0o600 })
  await writeFile(join(stateRoot, 'preferences.json'), 'old-preferences', { mode: 0o600 })
  const nativeMove = recoveryFixtureAdapters(context).moveExclusive,
    move = vi.fn(nativeMove),
    nativePublish = recoveryFixtureAdapters(context).publishExclusive,
    publish = vi.fn(nativePublish),
    store = new RelayBackupStore(context, {
      ...recoveryFixtureAdapters(context),
      moveExclusive: move,
      publishExclusive: publish
    }),
    before = await store.snapshot(),
    target: BackupSnapshot = {
      directories: ['Configuration', 'Configurations'],
      entries: [
        { path: 'Configuration/edit.json', mode: 0o600, bytes: Buffer.from('restored-private') },
        { path: 'preferences.json', mode: 0o600, bytes: Buffer.from('new-preferences') }
      ]
    },
    staged = await store.stageRestore(createBackupArchive(target)),
    directory = join(stateRoot, 'ApplicationBackups/restore-' + staged.id)
  try {
    await run({
      home,
      stateRoot,
      store,
      before,
      target,
      staged,
      directory,
      move,
      nativeMove,
      publish,
      nativePublish,
      reopen: () =>
        new RelayBackupStore(context, {
          ...recoveryFixtureAdapters(context),
          moveExclusive: move,
          publishExclusive: publish
        })
    })
  } finally {
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
  }
}
async function interrupt(
  f: Parameters<Parameters<typeof fixture>[0]>[0],
  afterRename: boolean
): Promise<void> {
  let interrupted = false
  f.move.mockImplementation(async (request) => {
    if (!interrupted && request.root === 'Configuration' && request.operation === 'park-original') {
      if (afterRename) await f.nativeMove(request)
      interrupted = true
      throw new Error('simulated interrupted root exchange')
    }
    await f.nativeMove(request)
  })
  try {
    const result = await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})
    expect(interrupted).toBe(true)
    expect(result).toBe('uncertain')
    expect(existsSync(join(f.directory, 'original/Configuration'))).toBe(afterRename)
    expect(existsSync(join(f.stateRoot, 'Configuration'))).toBe(!afterRename)
  } finally {
    f.move.mockImplementation(f.nativeMove)
  }
}

describe('Durable v2 backup recovery with no user data or system changes', () => {
  it('persists bounded baseline and target archives before staging and never mutates current data during preparation', async () => {
    await fixture(async (f) => {
      const journal = JSON.parse(await readRecoveryJournal(f.directory))
      expect(journal.version).toBe(2)
      expect(journal.phase).toBe('staged')
      expect(journal.intent).toBeUndefined()
      expect(
        backupSnapshotSHA256(
          readBackupArchive(await readFile(join(f.directory, 'baseline.zip'))).snapshot
        )
      ).toBe(f.staged.baselineSHA256)
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(backupSnapshotSHA256(f.before))
      expect((await f.reopen().listRecoveryRecords())[0]).toMatchObject({
        id: f.staged.id,
        version: 2,
        phase: 'staged',
        actions: ['resume'],
        containsSecrets: true
      })
      expect(JSON.stringify(await f.store.listRecoveryRecords())).not.toContain('private')
    })
  })
  it('rejects a supplied stale baseline before publishing another recovery proof', async () => {
    await fixture(async (f) => {
      await expect(
        f.store.stageRestore(createBackupArchive(f.target), 'a'.repeat(64))
      ).rejects.toThrow('基线已变化')
      await expect(f.store.stageRestore(createBackupArchive(f.target), 'invalid')).rejects.toThrow(
        '摘要无效'
      )
      expect((await f.store.listRecoveryRecords()).map((record) => record.id)).toEqual([
        f.staged.id
      ])
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(f.staged.baselineSHA256)
    })
  })
  it('does not accept a baseline changed during staging or leave that preparation executable', async () => {
    await fixture(async (f) => {
      const snapshot = f.store.snapshot.bind(f.store)
      vi.spyOn(f.store, 'snapshot')
        .mockImplementationOnce(snapshot)
        .mockImplementationOnce(async () => {
          await writeFile(join(f.stateRoot, 'Configuration/edit.json'), 'changed-during-merge', {
            mode: 0o600
          })
          return snapshot()
        })
      await expect(
        f.store.stageRestore(createBackupArchive(f.target), f.staged.baselineSHA256)
      ).rejects.toThrow('未发布恢复凭据')
      const records = await f.reopen().listRecoveryRecords()
      expect(records).toHaveLength(2)
      for (const record of records)
        await expect(
          f.reopen().prepareRecovery({ id: record.id, action: 'resume' })
        ).rejects.toThrow('未知修改')
      expect(await readFile(join(f.stateRoot, 'Configuration/edit.json'), 'utf8')).toBe(
        'changed-during-merge'
      )
      expect(await f.reopen().unresolved()).toEqual([])
    })
  })
  it('allows read-only preparation but refuses both commit APIs without an exclusive-move adapter', async () => {
    await fixture(async (f) => {
      const unconnected = new RelayBackupStore(
          { home: f.home, stateRoot: f.stateRoot },
          {
            publishExclusive: recoveryFixtureAdapters({ home: f.home, stateRoot: f.stateRoot })
              .publishExclusive,
            publishFile: recoveryFixtureAdapters({ home: f.home, stateRoot: f.stateRoot })
              .publishFile
          }
        ),
        plan = await unconnected.prepareRecovery({ id: f.staged.id, action: 'resume' }),
        staged = await unconnected.stageRestore(createBackupArchive(f.target))
      await expect(unconnected.commitRecovery(plan.evidenceId, () => {})).rejects.toThrow(
        '原子恢复移动尚未接通'
      )
      await expect(
        unconnected.commitRestore(staged.id, staged.baselineSHA256, () => {})
      ).rejects.toThrow('原子恢复移动尚未接通')
      expect(backupSnapshotSHA256(await unconnected.snapshot())).toBe(f.staged.baselineSHA256)
    })
  })
  it('resumes a staged record in a new store only with its newly prepared single-use proof', async () => {
    await fixture(async (f) => {
      const reopened = f.reopen(),
        plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'resume' })
      expect(plan).toMatchObject({
        id: f.staged.id,
        action: 'resume',
        currentSHA256: f.staged.baselineSHA256,
        containsSecrets: true
      })
      expect(await reopened.commitRecovery(plan.evidenceId, () => {})).toBe('restored')
      expect(backupSnapshotSHA256(await reopened.snapshot())).toBe(f.staged.targetSHA256)
      await expect(reopened.commitRecovery(plan.evidenceId, () => {})).rejects.toThrow('凭据已失效')
      expect(await readFile(join(f.directory, 'original/Configuration/edit.json'), 'utf8')).toBe(
        'original-private'
      )
      expect((await f.reopen().listRecoveryRecords())[0].actions).toEqual(['rollback'])
      expect(await f.reopen().unresolved()).toEqual([])
    })
  })
  it.each([false, true])(
    'resumes an intent whose rename completed=%s after reopening, without guessing or replaying a completed move',
    async (afterRename) => {
      await fixture(async (f) => {
        await interrupt(f, afterRename)
        const previousMoves = f.move.mock.calls.length,
          reopened = f.reopen(),
          plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'resume' })
        expect(await reopened.commitRecovery(plan.evidenceId, () => {})).toBe('restored')
        const replayed = f.move.mock.calls
          .slice(previousMoves)
          .some(
            ([request]) => request.root === 'Configuration' && request.operation === 'park-original'
          )
        expect(replayed).toBe(!afterRename)
        expect(backupSnapshotSHA256(await reopened.snapshot())).toBe(f.staged.targetSHA256)
        expect(await readFile(join(f.directory, 'original/Configuration/edit.json'), 'utf8')).toBe(
          'original-private'
        )
      })
    }
  )
  it.each([false, true])(
    'rolls back an interrupted apply whose pending rename completed=%s, preserving both target and baseline',
    async (afterRename) => {
      await fixture(async (f) => {
        await interrupt(f, afterRename)
        const reopened = f.reopen(),
          plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'rollback' })
        expect(await reopened.commitRecovery(plan.evidenceId, () => {})).toBe('rolled-back')
        expect(backupSnapshotSHA256(await reopened.snapshot())).toBe(f.staged.baselineSHA256)
        expect(existsSync(join(f.stateRoot, 'Configurations'))).toBe(false)
        expect(existsSync(join(f.directory, 'displaced/Configurations'))).toBe(true)
        expect(await f.reopen().unresolved()).toEqual([])
      })
    }
  )
  it('leaves backup-owned geometry untouched on quit so an interrupted rollback still works after restart', async () => {
    await fixture(async (f) => {
      const context = { home: f.home, stateRoot: f.stateRoot }
      const geometry = async (kind: 'main' | 'floating') => {
        const store = new RelayWindowStateStore(context, kind),
          display = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } },
          screen = {
            getAllDisplays: () => [display],
            getPrimaryDisplay: () => display,
            on: () => {},
            removeListener: () => {}
          },
          host = createWindowGeometryHost({
            screen,
            geometry: createWindowGeometryService({
              store,
              kind,
              displays: screen.getAllDisplays,
              primaryId: () => display.id
            })
          })
        await host.restore()
        return host
      }
      const main = await geometry('main'),
        floating = await geometry('floating')
      expect(main.state()).toMatchObject({ dirty: true, writable: true })
      await interrupt(f, true)
      await flushWindowGeometryForExit(f.reopen(), main, floating)
      expect(existsSync(join(f.stateRoot, 'UI'))).toBe(false)
      expect(main.state().writable).toBe(false)
      expect(floating.state().writable).toBe(false)

      const reopened = f.reopen(),
        plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'rollback' })
      expect(await reopened.commitRecovery(plan.evidenceId, () => {})).toBe('rolled-back')
      expect(backupSnapshotSHA256(await reopened.snapshot())).toBe(f.staged.baselineSHA256)
      await flushWindowGeometryForExit(reopened, await geometry('main'), await geometry('floating'))
      expect((await readdir(join(f.stateRoot, 'UI'))).sort()).toEqual([
        'floating-window.json',
        'window.json'
      ])
    })
  })
  it('rolls back a completed apply including roots absent from either side, retaining displaced target data', async () => {
    await fixture(async (f) => {
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'restored'
      )
      const reopened = f.reopen(),
        plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'rollback' })
      expect(await reopened.commitRecovery(plan.evidenceId, () => {})).toBe('rolled-back')
      expect(backupSnapshotSHA256(await reopened.snapshot())).toBe(backupSnapshotSHA256(f.before))
      expect(await readFile(join(f.directory, 'displaced/Configuration/edit.json'), 'utf8')).toBe(
        'restored-private'
      )
      expect(await readFile(join(f.stateRoot, 'Plugins/old.json'), 'utf8')).toBe(
        'removed-by-restore'
      )
      expect((await f.reopen().listRecoveryRecords())[0]).toMatchObject({
        phase: 'rolled-back',
        actions: []
      })
    })
  })
  it('continues an interrupted rollback only toward rollback and never enables forward resume', async () => {
    await fixture(async (f) => {
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'restored'
      )
      const reopened = f.reopen(),
        plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'rollback' }),
        sync = SubscriptionFiles.prototype.sync
      let failed = false
      const spy = vi.spyOn(SubscriptionFiles.prototype, 'sync').mockImplementation(async function (
        this: SubscriptionFiles,
        path
      ) {
        const journal = JSON.parse(await readRecoveryJournal(f.directory))
        if (
          !failed &&
          path === f.stateRoot &&
          journal.intent?.action === 'rollback' &&
          journal.intent.from === 'current' &&
          existsSync(join(f.directory, 'displaced', journal.intent.root))
        ) {
          failed = true
          throw new Error('rollback rename completed before fsync failed')
        }
        await sync.call(this, path)
      })
      expect(await reopened.commitRecovery(plan.evidenceId, () => {})).toBe('uncertain')
      expect(failed).toBe(true)
      spy.mockRestore()
      const next = f.reopen()
      expect((await next.listRecoveryRecords())[0].actions).toEqual(['rollback'])
      await expect(next.prepareRecovery({ id: f.staged.id, action: 'resume' })).rejects.toThrow(
        '不能执行'
      )
      const retry = await next.prepareRecovery({ id: f.staged.id, action: 'rollback' })
      expect(await next.commitRecovery(retry.evidenceId, () => {})).toBe('rolled-back')
      expect(backupSnapshotSHA256(await next.snapshot())).toBe(f.staged.baselineSHA256)
    })
  })
  it('recognizes a bound unfinished terminal marker after restart and confirms only its receipt without replaying data moves', async () => {
    await fixture(async (f) => {
      const sync = SubscriptionFiles.prototype.sync
      let failed = false
      const spy = vi.spyOn(SubscriptionFiles.prototype, 'sync').mockImplementation(async function (
        this: SubscriptionFiles,
        path
      ) {
        await sync.call(this, path)
        if (
          !failed &&
          path === f.directory &&
          JSON.parse(await readRecoveryJournal(f.directory)).phase === 'applied'
        ) {
          failed = true
          throw new Error('terminal journal replaced but its sync failed')
        }
      })
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'uncertain'
      )
      expect(failed).toBe(true)
      spy.mockRestore()
      const markerBefore = await readFile(join(f.directory, 'recheck-pending')),
        reopened = f.reopen()
      const moved = f.move.mock.calls.length
      expect(await reopened.unresolved()).toEqual(['restore-' + f.staged.id])
      const plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'resume' })
      expect(await reopened.commitRecovery(plan.evidenceId, () => {})).toBe('restored')
      expect(f.move).toHaveBeenCalledTimes(moved)
      expect(await readFile(join(f.directory, 'recheck-pending'))).toEqual(markerBefore)
      expect(
        (await readdir(f.directory)).some((name) => /^settled-[a-f0-9]{64}\.json$/u.test(name))
      ).toBe(true)
      expect(await f.reopen().unresolved()).toEqual([])
      expect(backupSnapshotSHA256(await f.reopen().snapshot())).toBe(f.staged.targetSHA256)
    })
  })
  it('uses the native no-replace operation when an unknown file appears after Node preparation', async () => {
    await fixture(async (f) => {
      let raced = false
      f.move.mockImplementation(async (request) => {
        if (request.root === 'preferences.json' && request.operation === 'activate-candidate') {
          raced = true
          await writeFile(join(f.stateRoot, 'preferences.json'), 'FOREIGN-NEVER-OVERWRITE', {
            mode: 0o600,
            flag: 'wx'
          })
        }
        await f.nativeMove(request)
      })
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'uncertain'
      )
      expect(raced).toBe(true)
      expect(await readFile(join(f.stateRoot, 'preferences.json'), 'utf8')).toBe(
        'FOREIGN-NEVER-OVERWRITE'
      )
      expect(await readFile(join(f.directory, 'candidate/preferences.json'), 'utf8')).toBe(
        'new-preferences'
      )
      expect(await readFile(join(f.directory, 'original/preferences.json'), 'utf8')).toBe(
        'old-preferences'
      )
      await expect(
        f.reopen().prepareRecovery({ id: f.staged.id, action: 'resume' })
      ).rejects.toThrow('布局')
    })
  })
  it('does not replace even an empty foreign directory appearing immediately before the native move', async () => {
    await fixture(async (f) => {
      let raced = false
      f.move.mockImplementation(async (request) => {
        if (request.root === 'Configurations' && request.operation === 'activate-candidate') {
          raced = true
          await mkdir(join(f.stateRoot, 'Configurations'), { mode: 0o700 })
        }
        await f.nativeMove(request)
      })
      await expect(
        f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})
      ).rejects.toThrow('当前数据未写入')
      expect(raced).toBe(true)
      expect(await readdir(join(f.stateRoot, 'Configurations'))).toEqual([])
      expect(existsSync(join(f.directory, 'candidate/Configurations'))).toBe(true)
      expect(await f.reopen().unresolved()).toEqual(['restore-' + f.staged.id])
    })
  })
  it.each(['overwrite-marker', 'replace-marker', 'replace-directory'] as const)(
    'preserves foreign evidence after %s in the terminal publication window',
    async (change) => {
      await fixture(async (f) => {
        const marker = join(f.directory, 'recheck-pending'),
          foreignJournal = JSON.stringify({ version: 1, phase: 'uncertain', foreign: true })
        let changed = false
        f.publish.mockImplementation(async (request) => {
          await f.nativePublish(request)
          if (changed || JSON.parse(request.bytes).journal?.phase !== 'applied') return
          if (change === 'replace-directory') {
            await rename(f.directory, f.directory + '-retained')
            await mkdir(f.directory, { mode: 0o700 })
            await writeFile(join(f.directory, 'journal.json'), foreignJournal, { mode: 0o600 })
          } else if (change === 'replace-marker') await rename(marker, marker + '-retained')
          await writeFile(marker, 'FOREIGN-MARKER', { mode: 0o600 })
          changed = true
        })
        const result = await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})
        expect(changed).toBe(true)
        expect(result).toBe('uncertain')
        expect(await readFile(marker, 'utf8')).toBe('FOREIGN-MARKER')
        if (change === 'replace-directory')
          expect(await readRecoveryJournal(f.directory)).toBe(foreignJournal)
        expect(await f.reopen().unresolved()).toEqual(['restore-' + f.staged.id])
        expect((await f.reopen().listRecoveryRecords())[0].actions).toEqual([])
      })
    }
  )
  it.each(['anchor', 'directory', 'next-revision'] as const)(
    'preserves foreign %s inserted after Node validation and refuses the native publication',
    async (change) => {
      await fixture(async (f) => {
        let raced = false,
          foreignPath = ''
        f.publish.mockImplementation(async (request) => {
          if (!raced && request.revision > 0) {
            raced = true
            if (change === 'directory') {
              await rename(f.directory, f.directory + '-retained')
              await mkdir(f.directory, { mode: 0o700 })
              foreignPath = join(f.directory, 'journal.json')
            } else
              foreignPath = join(
                f.directory,
                change === 'anchor'
                  ? 'journal.json'
                  : 'journal-' + String(request.revision).padStart(6, '0') + '.json'
              )
            await writeFile(foreignPath, 'FOREIGN-KEEP-EXACT', { mode: 0o600 })
          }
          await f.nativePublish(request)
        })
        await expect(
          f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})
        ).rejects.toThrow('当前数据未写入')
        expect(raced).toBe(true)
        expect(await readFile(foreignPath, 'utf8')).toBe('FOREIGN-KEEP-EXACT')
        if (change === 'directory') expect(await readdir(f.directory)).toEqual(['journal.json'])
        expect(f.move).not.toHaveBeenCalled()
        expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(f.staged.baselineSHA256)
        expect(await f.reopen().unresolved()).toEqual(['restore-' + f.staged.id])
      })
    }
  )
  it('does not create candidate directories or disclose bytes in a record directory replaced before native mkdirat', async () => {
    await fixture(async (f) => {
      const context = { home: f.home, stateRoot: f.stateRoot },
        adapters = recoveryFixtureAdapters(context)
      let foreignDirectory = '',
        raced = false
      const store = new RelayBackupStore(context, {
        ...adapters,
        publishFile: async (request) => {
          if (!raced && request.directory) {
            raced = true
            foreignDirectory = join(f.stateRoot, 'ApplicationBackups/restore-' + request.id)
            await rename(foreignDirectory, foreignDirectory + '-retained')
            await mkdir(foreignDirectory, { mode: 0o700 })
            await writeFile(join(foreignDirectory, 'FOREIGN'), 'keep', { mode: 0o600 })
          }
          return adapters.publishFile(request)
        }
      })
      await expect(store.stageRestore(createBackupArchive(f.target))).rejects.toThrow(
        '事务结果未确认'
      )
      expect(raced).toBe(true)
      expect(await readdir(foreignDirectory)).toEqual(['FOREIGN'])
      expect(await readFile(join(foreignDirectory, 'FOREIGN'), 'utf8')).toBe('keep')
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(f.staged.baselineSHA256)
    })
  })
  it('does not accept an old applied body and receipt replayed after a durable rollback revision and restart', async () => {
    await fixture(async (f) => {
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'restored'
      )
      const oldApplied = await readRecoveryJournal(f.directory),
        reopened = f.reopen(),
        plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'rollback' })
      let interrupted = false
      f.publish.mockImplementation(async (request) => {
        await f.nativePublish(request)
        const frame = JSON.parse(request.bytes)
        if (!interrupted && frame.journal?.phase === 'rolling-back') {
          interrupted = true
          throw new Error('crash after durable rollback revision, before first data move')
        }
      })
      expect(await reopened.commitRecovery(plan.evidenceId, () => {})).toBe('uncertain')
      expect(interrupted).toBe(true)
      expect((await readdir(f.directory)).some((name) => name.startsWith('settled-'))).toBe(true)
      await writeFile(join(f.directory, 'journal.json'), oldApplied, { mode: 0o600 })
      const afterRestart = f.reopen()
      expect(await afterRestart.unresolved()).toEqual(['restore-' + f.staged.id])
      expect((await afterRestart.listRecoveryRecords())[0].actions).toEqual([])
      expect(backupSnapshotSHA256(await afterRestart.snapshot())).toBe(f.staged.targetSHA256)
      expect(await readFile(join(f.directory, 'journal.json'), 'utf8')).toBe(oldApplied)
    })
  })
  it('refuses a missing immutable revision instead of selecting a lower acknowledged receipt', async () => {
    await fixture(async (f) => {
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'restored'
      )
      const names = (await readdir(f.directory))
        .filter((name) => /^journal-[0-9]{6}\.json$/u.test(name))
        .sort()
      await rename(join(f.directory, names[0]), join(f.directory, 'retained-first-frame'))
      expect((await f.reopen().listRecoveryRecords())[0].actions).toEqual([])
      expect(await f.reopen().unresolved()).toEqual(['restore-' + f.staged.id])
      expect(backupSnapshotSHA256(await f.reopen().snapshot())).toBe(f.staged.targetSHA256)
    })
  })
  it('rejects a well-formed copied receipt whose digest is absent from the immutable history', async () => {
    await fixture(async (f) => {
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'restored'
      )
      const name = (await readdir(f.directory)).find((name) => name.startsWith('settled-'))
      if (!name) throw new Error('missing committed receipt')
      const receipt = JSON.parse(await readFile(join(f.directory, name), 'utf8'))
      receipt.journalSHA256 = 'f'.repeat(64)
      const foreign = join(f.directory, 'settled-' + receipt.journalSHA256 + '.json'),
        raw = JSON.stringify(receipt)
      await writeFile(foreign, raw, { mode: 0o600, flag: 'wx' })
      expect(await f.reopen().unresolved()).toEqual(['restore-' + f.staged.id])
      expect((await f.reopen().listRecoveryRecords())[0].actions).toEqual([])
      expect(await readFile(foreign, 'utf8')).toBe(raw)
    })
  })
  it('rejects an old settled prefix after rollback moved data even if its new revision suffix is removed', async () => {
    await fixture(async (f) => {
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'restored'
      )
      const oldNames = new Set(await readdir(f.directory)),
        reopened = f.reopen(),
        plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'rollback' })
      f.move.mockImplementation(async (request) => {
        await f.nativeMove(request)
        if (request.operation === 'park-restored')
          throw new Error('crash after first rollback rename')
      })
      expect(await reopened.commitRecovery(plan.evidenceId, () => {})).toBe('uncertain')
      const retained = join(f.home, 'retained-new-frames')
      await mkdir(retained, { mode: 0o700 })
      for (const name of await readdir(f.directory))
        if (name.startsWith('journal-') && !oldNames.has(name))
          await rename(join(f.directory, name), join(retained, name))
      const afterRestart = f.reopen()
      expect(await afterRestart.unresolved()).toEqual(['restore-' + f.staged.id])
      expect((await afterRestart.listRecoveryRecords())[0].actions).toEqual([])
      await expect(afterRestart.archive()).rejects.toThrow('完整备份')
      expect((await readdir(retained)).length).toBeGreaterThan(0)
    })
  })
  it('allows normal current-data edits after settlement while retaining strict rollback proof checks', async () => {
    await fixture(async (f) => {
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'restored'
      )
      await writeFile(join(f.stateRoot, 'Configuration/edit.json'), 'normal-user-edit', {
        mode: 0o600
      })
      const reopened = f.reopen()
      expect(await reopened.unresolved()).toEqual([])
      expect((await reopened.archive()).files).toBe(f.target.entries.length)
      await expect(
        reopened.prepareRecovery({ id: f.staged.id, action: 'rollback' })
      ).rejects.toThrow('布局')
      expect(await readFile(join(f.stateRoot, 'Configuration/edit.json'), 'utf8')).toBe(
        'normal-user-edit'
      )
    })
  })
  it('does not treat a malformed or foreign receipt as an acknowledged terminal operation', async () => {
    await fixture(async (f) => {
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'restored'
      )
      const receipts = (await readdir(f.directory)).filter((name) => name.startsWith('settled-'))
      expect(receipts).toHaveLength(1)
      const path = join(f.directory, receipts[0])
      await writeFile(path, '{"version":1,"FOREIGN":true}', { mode: 0o600 })
      expect(await f.reopen().unresolved()).toEqual(['restore-' + f.staged.id])
      await expect(
        f.reopen().prepareRecovery({ id: f.staged.id, action: 'rollback' })
      ).rejects.toThrow('不能执行')
      expect(await readFile(path, 'utf8')).toContain('FOREIGN')
      expect(backupSnapshotSHA256(await f.reopen().snapshot())).toBe(f.staged.targetSHA256)
    })
  })
  it('refuses a replayed acknowledged journal and keeps the pre-mutation marker blocking after restart', async () => {
    await fixture(async (f) => {
      const originalJournal = await readFile(join(f.directory, 'journal.json'))
      let replayed = false
      expect(
        await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {
          if (
            !replayed &&
            existsSync(join(f.stateRoot, 'Configurations')) &&
            !existsSync(join(f.directory, 'candidate/Configurations'))
          ) {
            replayed = true
            const latest = readdirSync(f.directory)
              .filter((name) => /^journal-[0-9]{6}\.json$/u.test(name))
              .sort()
              .at(-1)
            if (!latest) throw new Error('missing later immutable frame')
            writeFileSync(join(f.directory, latest), originalJournal)
          }
        })
      ).toBe('uncertain')
      expect(replayed).toBe(true)
      expect(await readFile(join(f.directory, 'journal.json'))).toEqual(originalJournal)
      expect(await readFile(join(f.directory, 'recheck-pending'), 'utf8')).toBe('v1\n')
      const reopened = f.reopen()
      expect(await reopened.unresolved()).toEqual(['restore-' + f.staged.id])
      await expect(reopened.archive()).rejects.toThrow('完整备份')
      await expect(reopened.prepareRecovery({ id: f.staged.id, action: 'resume' })).rejects.toThrow(
        '不能执行'
      )
      expect(await readFile(join(f.stateRoot, 'Configuration/edit.json'), 'utf8')).toBe(
        'original-private'
      )
    })
  })
  it.each(['current', 'candidate', 'baseline-archive', 'target-archive', 'record-extra'] as const)(
    'refuses unknown %s changes and never overwrites the changed bytes',
    async (change) => {
      await fixture(async (f) => {
        const reopened = f.reopen(),
          plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'resume' }),
          path =
            change === 'current'
              ? join(f.stateRoot, 'Configuration/edit.json')
              : change === 'candidate'
                ? join(f.directory, 'candidate/Configuration/edit.json')
                : change === 'baseline-archive'
                  ? join(f.directory, 'baseline.zip')
                  : change === 'target-archive'
                    ? join(f.directory, 'archive.zip')
                    : join(f.directory, 'FOREIGN')
        await writeFile(path, 'FOREIGN-KEEP', { mode: 0o600 })
        await expect(reopened.commitRecovery(plan.evidenceId, () => {})).rejects.toThrow()
        expect(await readFile(path, 'utf8')).toBe('FOREIGN-KEEP')
        expect(existsSync(join(f.stateRoot, 'Configurations'))).toBe(false)
      })
    }
  )
  it('rejects changed original and displaced resources instead of overwriting them from the baseline archive', async () => {
    await fixture(async (f) => {
      expect(await f.store.commitRestore(f.staged.id, f.staged.baselineSHA256, () => {})).toBe(
        'restored'
      )
      const original = join(f.directory, 'original/Configuration/edit.json')
      await writeFile(original, 'unknown-original', { mode: 0o600 })
      await expect(
        f.reopen().prepareRecovery({ id: f.staged.id, action: 'rollback' })
      ).rejects.toThrow('不能执行')
      expect(await readFile(original, 'utf8')).toBe('unknown-original')
      expect(await readFile(join(f.stateRoot, 'Configuration/edit.json'), 'utf8')).toBe(
        'restored-private'
      )
    })
  })
  it('rejects a same-content replacement root and preserves a replaced record directory', async () => {
    await fixture(async (f) => {
      const reopened = f.reopen(),
        plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'resume' })
      await rename(join(f.stateRoot, 'Configuration'), join(f.stateRoot, 'Configuration-retained'))
      await mkdir(join(f.stateRoot, 'Configuration'), { mode: 0o700 })
      await writeFile(join(f.stateRoot, 'Configuration/edit.json'), 'original-private', {
        mode: 0o600
      })
      await expect(reopened.commitRecovery(plan.evidenceId, () => {})).rejects.toThrow('未知修改')
      await rename(f.directory, f.directory + '-retained')
      await mkdir(f.directory, { mode: 0o700 })
      const foreign = JSON.stringify({ version: 1, phase: 'uncertain' })
      await writeFile(join(f.directory, 'journal.json'), foreign, { mode: 0o600 })
      expect((await f.reopen().listRecoveryRecords())[0]).toMatchObject({ version: 1, actions: [] })
      await expect(
        f.reopen().prepareRecovery({ id: f.staged.id, action: 'rollback' })
      ).rejects.toThrow('不能执行')
      expect(await readRecoveryJournal(f.directory)).toBe(foreign)
    })
  })
  it('keeps legacy interrupted or malformed records manual-only, without deriving a baseline from current data', async () => {
    await fixture(async (f) => {
      const stagedJournal = JSON.parse(await readRecoveryJournal(f.directory))
      await writeFile(
        join(f.directory, 'journal.json'),
        JSON.stringify({ version: 1, phase: 'uncertain', plan: stagedJournal.plan, completed: [] }),
        { mode: 0o600 }
      )
      const reopened = f.reopen()
      expect((await reopened.listRecoveryRecords())[0]).toMatchObject({
        version: 1,
        phase: 'uncertain',
        actions: [],
        reason: 'legacy-recovery-requires-review'
      })
      await expect(reopened.prepareRecovery({ id: f.staged.id, action: 'resume' })).rejects.toThrow(
        '不能执行'
      )
      expect(await reopened.unresolved()).toEqual(['restore-' + f.staged.id])
      await writeFile(join(f.directory, 'journal.json'), '{invalid', { mode: 0o600 })
      expect((await f.reopen().listRecoveryRecords())[0]).toMatchObject({
        version: 'unknown',
        actions: []
      })
    })
  })
  it('expires, replaces and discards recovery proofs without mutating the record or current data', async () => {
    await fixture(async (f) => {
      const reopened = f.reopen(),
        old = await reopened.prepareRecovery({ id: f.staged.id, action: 'resume' }),
        next = await reopened.prepareRecovery({ id: f.staged.id, action: 'resume' })
      await expect(reopened.commitRecovery(old.evidenceId, () => {})).rejects.toThrow('凭据已失效')
      reopened.discardRecovery(next.evidenceId)
      await expect(reopened.commitRecovery(next.evidenceId, () => {})).rejects.toThrow('凭据已失效')
      const expired = await reopened.prepareRecovery({ id: f.staged.id, action: 'resume' })
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(expired.expiresAt)
      await expect(reopened.commitRecovery(expired.evidenceId, () => {})).rejects.toThrow(
        '凭据已失效'
      )
      vi.useRealTimers()
      expect(backupSnapshotSHA256(await reopened.snapshot())).toBe(f.staged.baselineSHA256)
    })
  })
  it('rechecks proof expiry after its asynchronous layout read and before publishing the first intent', async () => {
    await fixture(async (f) => {
      const reopened = f.reopen(),
        plan = await reopened.prepareRecovery({ id: f.staged.id, action: 'resume' }),
        snapshot = reopened.snapshot.bind(reopened)
      vi.useFakeTimers({ toFake: ['Date'] })
      // The current-slot directory is reached only during the layout read.
      const directory = SubscriptionFiles.prototype.directory
      const spy = vi
        .spyOn(SubscriptionFiles.prototype, 'directory')
        .mockImplementation(async function (this: SubscriptionFiles, path, create) {
          const result = await directory.call(this, path, create)
          if (path === f.stateRoot) vi.setSystemTime(plan.expiresAt)
          return result
        })
      await expect(reopened.commitRecovery(plan.evidenceId, () => {})).rejects.toThrow('凭据已失效')
      spy.mockRestore()
      vi.useRealTimers()
      expect(backupSnapshotSHA256(await snapshot())).toBe(f.staged.baselineSHA256)
      expect(JSON.parse(await readRecoveryJournal(f.directory)).phase).toBe('staged')
    })
  })
})
