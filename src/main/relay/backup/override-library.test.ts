import { mkdir, mkdtemp, readFile, realpath, rm } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { defaultEditDocument } from '../../../shared/relay/configuration-edit'
import { overrideLibraryRuntimeId } from '../../../shared/relay/override-library'
import { ConfigurationEditStore } from '../configuration/edit-store'
import { OverrideLibraryStore } from '../configuration/override-library-store'
import { backupSnapshotSHA256, readBackupArchive } from './archive'
import { recoveryFixtureAdapters } from './recovery.test-fixture'
import { RelayBackupStore } from './store'

describe('Override library and inline references in complete Native backup recovery', () => {
  it('restores both private files together and rolls back to the exact later library/reference pair', async () => {
    const home = await realpath(await mkdtemp('/private/tmp/relay-library-backup-')),
      context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
    try {
      await mkdir(context.stateRoot, { recursive: true, mode: 0o700 })
      const library = new OverrideLibraryStore(context),
        edits = new ConfigurationEditStore(context),
        oldBody = 'log-level: info\n',
        nextBody = 'log-level: warning\n',
        original = await library.create({
          expectedLibraryRevision: '',
          name: 'Synthetic private library',
          kind: 'yaml',
          type: 'local',
          content: oldBody
        }),
        document = {
          ...defaultEditDocument(),
          globalOverrides: [
            {
              id: overrideLibraryRuntimeId(original.item.id),
              kind: 'yaml' as const,
              content: oldBody
            }
          ]
        },
        oldEdit = await edits.save(document, ''),
        backup = new RelayBackupStore(context, recoveryFixtureAdapters(context)),
        archive = await backup.archive(),
        snapshot = readBackupArchive(archive.bytes).snapshot
      expect(snapshot.entries.map((entry) => entry.path)).toEqual([
        'Configuration/configuration-edit.json',
        'Configuration/override-library.json'
      ])
      const exactOldLibrary = await readFile(library.path)
      await library.saveBody({
        id: original.item.id,
        expectedLibraryRevision: original.revision,
        expectedBodyRevision: original.item.bodyRevision,
        content: nextBody
      })
      await edits.save(
        {
          ...document,
          globalOverrides: [{ ...document.globalOverrides[0], content: nextBody }]
        },
        oldEdit.revision
      )
      const beforeRestore = backupSnapshotSHA256(await backup.snapshot()),
        exactNewLibrary = await readFile(library.path),
        plan = await backup.stageRestore(archive.bytes)
      expect(await backup.commitRestore(plan.id, plan.baselineSHA256, () => {})).toBe('restored')
      expect(await readFile(library.path)).toEqual(exactOldLibrary)
      expect(
        (await new OverrideLibraryStore(context).read({ id: original.item.id })).item.content
      ).toBe(oldBody)
      expect((await new ConfigurationEditStore(context).read()).document.globalOverrides).toEqual(
        document.globalOverrides
      )
      const reopened = new RelayBackupStore(context, recoveryFixtureAdapters(context)),
        rollback = await reopened.prepareRecovery({ id: plan.id, action: 'rollback' })
      expect(await reopened.commitRecovery(rollback.evidenceId, () => {})).toBe('rolled-back')
      expect(await readFile(library.path)).toEqual(exactNewLibrary)
      expect((await new ConfigurationEditStore(context).read()).document.globalOverrides).toEqual([
        { ...document.globalOverrides[0], content: nextBody }
      ])
      expect(backupSnapshotSHA256(await reopened.snapshot())).toBe(beforeRestore)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 30000)
})
