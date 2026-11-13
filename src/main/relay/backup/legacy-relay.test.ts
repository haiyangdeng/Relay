import { randomUUID } from 'crypto'
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileStore } from '../profiles/store'
import * as profileSource from '../profiles/source'
import { backupHash, backupSnapshotSHA256, readBackupArchive } from './archive'
import { createLegacyRelayMigration, type LegacyRelayOrigin } from './legacy-relay'
import { recoveryFixtureAdapters } from './recovery.test-fixture'
import { RelayBackupStore } from './store'

afterEach(() => vi.restoreAllMocks())
const config =
  '\uFEFFproxies: [{name: Node, type: http, server: 127.0.0.1, port: 1234, username: PRIVATE_USER, password: PRIVATE_PASSWORD}]\nproxy-groups: [{name: G, type: select, proxies: [Node]}]\nrules: ["MATCH,G"]\n'
async function fixture(
  run: (f: {
    home: string
    context: { home: string; stateRoot: string }
    temporaryHome: string
    store: RelayBackupStore
    old(
      origin?: LegacyRelayOrigin,
      name?: string
    ): Promise<{
      profile: Awaited<ReturnType<ProfileStore['save']>>
      directory: string
      metadata: Buffer
      configuration: Buffer
    }>
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-legacy-profile-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
  try {
    await new ProfileStore(context).save('Existing active choice', config)
    await mkdir(join(context.stateRoot, 'Core'), { mode: 0o700 })
    await writeFile(join(context.stateRoot, 'Core/selection.json'), 'PRESERVE-CURRENT-SELECTION', {
      mode: 0o600
    })
    await mkdir(join(context.stateRoot, 'UI'), { mode: 0o700 })
    await writeFile(join(context.stateRoot, 'UI/notes.json'), 'PRESERVE-UI', { mode: 0o600 })
    await writeFile(join(context.stateRoot, 'preferences.json'), 'PRESERVE-PREFERENCES', {
      mode: 0o600
    })
    const temporaryHome = join(home, 'conversion')
    await mkdir(temporaryHome, { mode: 0o700 })
    await run({
      home,
      context,
      temporaryHome,
      store: new RelayBackupStore(context, recoveryFixtureAdapters(context)),
      async old(origin = 'Relay-Preview', name = 'Legacy Ω') {
        const sourceContext = {
            home,
            stateRoot: join(home, 'Library/Application Support', origin)
          },
          sourceStore = new ProfileStore(sourceContext),
          profile = await sourceStore.save(name, config),
          parent = join(sourceContext.stateRoot, 'Profiles'),
          directory = join(parent, profile.id)
        await mkdir(parent, { mode: 0o700, recursive: true })
        await rename(join(sourceStore.directory, profile.id), directory)
        // A valid old record need not use the current writer's whitespace.
        const metadata = Buffer.from(
          JSON.stringify(
            JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')),
            null,
            2
          ) + '\n'
        )
        await writeFile(join(directory, 'metadata.json'), metadata, { mode: 0o600 })
        return { profile, directory, metadata, configuration: Buffer.from(config) }
      }
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
const selections = (
  inspection: Awaited<ReturnType<ReturnType<typeof createLegacyRelayMigration>['inspect']>>
) => inspection.profiles.map(({ id, sha256, revision }) => ({ id, sha256, revision }))

describe('Explicit fixed-origin legacy Relay profile candidate', () => {
  it('rejects paths/boxed origins before filesystem access and never adopts another process inspection ID', async () => {
    const migrator = createLegacyRelayMigration({ home: '/private/tmp/relay-legacy-do-not-open' }),
      read = vi.spyOn(ProfileStore.prototype, 'listLegacy')
    for (const input of [
      { path: '/PRIVATE' },
      { origin: '../Relay' },
      { origin: new String('Relay') },
      { origin: 'Relay', path: '/PRIVATE' }
    ])
      await expect(migrator.inspect(input, new AbortController().signal)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    await expect(
      migrator.prepare(
        {
          inspectionId: randomUUID(),
          profiles: [{ id: randomUUID(), sha256: 'a'.repeat(64), revision: 'b'.repeat(64) }]
        },
        {
          baseline: { directories: [], entries: [] },
          temporaryHome: '/PRIVATE',
          signal: new AbortController().signal
        }
      )
    ).rejects.toThrow('凭据')
  })

  it('preserves exact originals, adds only new Configuration UUIDs, and uses actual Native restore/reopen rollback', async () => {
    await fixture(async (f) => {
      const old = await f.old(),
        other = await f.old('Relay-Preview', 'Not selected'),
        parent = join(old.directory, '..'),
        edge = join(parent, 'Claude-Edge-Network.mobileconfig')
      await writeFile(edge, 'EDGE_MUST_NOT_BE_READ', { mode: 0o600 })
      await writeFile(join(parent, 'unknown-note.txt'), 'UNKNOWN_MUST_NOT_BE_READ', { mode: 0o600 })
      const read = vi.spyOn(profileSource, 'readProfileFile'),
        before = await f.store.snapshot(),
        migrator = createLegacyRelayMigration({ home: f.home }),
        inspected = await migrator.inspect(
          { origin: 'Relay-Preview' },
          new AbortController().signal
        ),
        selection = selections(inspected).filter((p) => p.id === old.profile.id),
        result = await migrator.prepare(
          { inspectionId: inspected.inspectionId, profiles: selection },
          { baseline: before, temporaryHome: f.temporaryHome, signal: new AbortController().signal }
        )
      expect(inspected.profiles).toHaveLength(2)
      expect(JSON.stringify(inspected)).not.toContain('PRIVATE_PASSWORD')
      expect(
        read.mock.calls.every(
          ([path]) => !path.endsWith('.mobileconfig') && !path.endsWith('unknown-note.txt')
        )
      ).toBe(true)
      expect(result.report.format).toBe('relay-legacy-profiles-v1')
      expect(result.report.profiles).toHaveLength(1)
      expect(result.report.profiles[0]).toMatchObject({
        legacyId: old.profile.id,
        legacySHA256: old.profile.sha256,
        profileSHA256: old.profile.sha256
      })
      const newId = result.report.profiles[0].profileId
      expect(newId).not.toBe(old.profile.id)
      expect(JSON.stringify(result.report)).not.toContain('PRIVATE_PASSWORD')
      const originals = new AdmZip(result.originalArchiveBytes)
      expect(originals.readFile('Profiles/' + old.profile.id + '/metadata.json')).toEqual(
        old.metadata
      )
      expect(originals.readFile('Profiles/' + old.profile.id + '/profile.yaml')).toEqual(
        old.configuration
      )
      expect(
        originals
          .getEntries()
          .map((entry) => entry.entryName)
          .sort()
      ).toEqual(
        [
          'Profiles/' + old.profile.id + '/metadata.json',
          'Profiles/' + old.profile.id + '/profile.yaml',
          'source-manifest.json'
        ].sort()
      )
      expect(result.report.originalArchiveSHA256).toBe(backupHash(result.originalArchiveBytes))
      expect(() => readBackupArchive(result.originalArchiveBytes)).toThrow()
      const merged = readBackupArchive(result.archiveBytes).snapshot
      for (const entry of before.entries)
        expect(merged.entries.find((e) => e.path === entry.path)).toEqual(entry)
      expect(
        merged.entries
          .filter((entry) => !before.entries.some((e) => e.path === entry.path))
          .map((entry) => entry.path)
          .sort()
      ).toEqual([
        'Configurations/' + newId + '/metadata.json',
        'Configurations/' + newId + '/profile.yaml'
      ])
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(backupSnapshotSHA256(before))
      const plan = await f.store.stageRestore(result.archiveBytes, result.expectedBaselineSHA256)
      expect(plan.removedFiles).toBe(0)
      expect(plan.replacedFiles).toBe(0)
      expect(await f.store.commitRestore(plan.id, plan.baselineSHA256, () => {})).toBe('restored')
      expect(
        (await new ProfileStore(f.context).read({ id: newId, sha256: old.profile.sha256 })).text
      ).toBe(config)
      const reopened = new RelayBackupStore(f.context, recoveryFixtureAdapters(f.context)),
        rollback = await reopened.prepareRecovery({ id: plan.id, action: 'rollback' })
      expect(await reopened.commitRecovery(rollback.evidenceId, () => {})).toBe('rolled-back')
      expect(backupSnapshotSHA256(await reopened.snapshot())).toBe(backupSnapshotSHA256(before))
      for (const source of [old, other]) {
        expect(await readFile(join(source.directory, 'metadata.json'))).toEqual(source.metadata)
        expect(await readFile(join(source.directory, 'profile.yaml'))).toEqual(source.configuration)
      }
      expect(await readFile(edge, 'utf8')).toBe('EDGE_MUST_NOT_BE_READ')
    })
  }, 20000)

  it('uses the explicit old root despite a duplicate new UUID without weakening ordinary read refusal', async () => {
    await fixture(async (f) => {
      const old = await f.old('Relay'),
        store = new ProfileStore(f.context)
      await cp(old.directory, join(store.directory, old.profile.id), { recursive: true })
      await expect(store.read({ id: old.profile.id, sha256: old.profile.sha256 })).rejects.toThrow(
        '重复ID'
      )
      expect((await store.list()).incomplete).toBeGreaterThan(0)
      const migrator = createLegacyRelayMigration({ home: f.home }),
        inspected = await migrator.inspect({ origin: 'Relay' }, new AbortController().signal)
      expect(inspected.profiles.map((p) => p.id)).toEqual([old.profile.id])
      const prepared = await migrator.prepare(
        { inspectionId: inspected.inspectionId, profiles: selections(inspected) },
        {
          baseline: await f.store.snapshot(),
          temporaryHome: f.temporaryHome,
          signal: new AbortController().signal
        }
      )
      expect(prepared.report.profiles[0].profileId).not.toBe(old.profile.id)
      await expect(store.read({ id: old.profile.id, sha256: old.profile.sha256 })).rejects.toThrow(
        '重复ID'
      )
    })
  })

  it.each(['extra-member', 'hardlink', 'unknown-schema', 'directory-symlink'] as const)(
    'retains an invalid %s UUID record without reading Edge/unknown entries',
    async (kind) => {
      await fixture(async (f) => {
        const old = await f.old(),
          edge = join(old.directory, '../Claude-Edge-Network.mobileconfig')
        await writeFile(edge, 'EDGE_PRIVATE', { mode: 0o600 })
        if (kind === 'extra-member')
          await writeFile(join(old.directory, 'unknown.txt'), 'KEEP', { mode: 0o600 })
        else if (kind === 'hardlink')
          await link(join(old.directory, 'profile.yaml'), join(f.home, 'private-link'))
        else if (kind === 'directory-symlink') {
          const retired = join(f.home, 'retired-owned-source')
          await rename(old.directory, retired)
          await symlink(retired, old.directory)
        } else
          await writeFile(
            join(old.directory, 'metadata.json'),
            JSON.stringify({ ...JSON.parse(old.metadata.toString()), version: 2 })
          )
        const migrator = createLegacyRelayMigration({ home: f.home }),
          read = vi.spyOn(profileSource, 'readProfileFile'),
          inspected = await migrator.inspect(
            { origin: 'Relay-Preview' },
            new AbortController().signal
          )
        expect(inspected.profiles).toEqual([])
        expect(inspected.incomplete).toBe(1)
        expect(read.mock.calls.every(([path]) => !path.endsWith('.mobileconfig'))).toBe(true)
        expect(await readFile(edge, 'utf8')).toBe('EDGE_PRIVATE')
        expect((await readdir(old.directory)).includes('profile.yaml')).toBe(true)
        await expect(
          migrator.prepare(
            { inspectionId: inspected.inspectionId, profiles: [] },
            {
              baseline: await f.store.snapshot(),
              temporaryHome: f.temporaryHome,
              signal: new AbortController().signal
            }
          )
        ).rejects.toThrow('数量')
      })
    }
  )

  it('rejects source replacement before body read and keeps both old and replacement directories', async () => {
    await fixture(async (f) => {
      const old = await f.old(),
        migrator = createLegacyRelayMigration({ home: f.home }),
        inspected = await migrator.inspect(
          { origin: 'Relay-Preview' },
          new AbortController().signal
        ),
        root = join(old.directory, '..'),
        retired = root + '-retired'
      await rename(root, retired)
      await cp(retired, root, { recursive: true })
      const read = vi.spyOn(profileSource, 'readProfileFile')
      await expect(
        migrator.prepare(
          { inspectionId: inspected.inspectionId, profiles: selections(inspected) },
          {
            baseline: await f.store.snapshot(),
            temporaryHome: f.temporaryHome,
            signal: new AbortController().signal
          }
        )
      ).rejects.toThrow('身份已变化')
      expect(read).not.toHaveBeenCalled()
      expect(await readdir(f.temporaryHome)).toEqual([])
      expect(await readFile(join(retired, old.profile.id, 'profile.yaml'))).toEqual(
        old.configuration
      )
      expect(await readFile(join(root, old.profile.id, 'profile.yaml'))).toEqual(old.configuration)
    })
  })

  it('rejects source changes during isolated generation without rolling back or removing unknown source bytes', async () => {
    await fixture(async (f) => {
      const old = await f.old(),
        before = await f.store.snapshot(),
        migrator = createLegacyRelayMigration({ home: f.home }),
        inspected = await migrator.inspect(
          { origin: 'Relay-Preview' },
          new AbortController().signal
        ),
        save = ProfileStore.prototype.save,
        changed = Buffer.from(old.metadata.toString() + ' ')
      vi.spyOn(ProfileStore.prototype, 'save').mockImplementationOnce(async function (
        this: ProfileStore,
        name,
        text
      ) {
        const saved = await save.call(this, name, text)
        await writeFile(join(old.directory, 'metadata.json'), changed)
        return saved
      })
      await expect(
        migrator.prepare(
          { inspectionId: inspected.inspectionId, profiles: selections(inspected) },
          { baseline: before, temporaryHome: f.temporaryHome, signal: new AbortController().signal }
        )
      ).rejects.toThrow('身份已变化')
      expect(await readFile(join(old.directory, 'metadata.json'))).toEqual(changed)
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(backupSnapshotSHA256(before))
      expect(migrator.isBusy()).toBe(false)
    })
  })

  it('binds all selected SHA/revisions, rejects empty/duplicate/path-bearing selections, and enforces expiry', async () => {
    await fixture(async (f) => {
      await f.old()
      let time = 1000
      const migrator = createLegacyRelayMigration({ home: f.home, now: () => time }),
        baseline = await f.store.snapshot()
      for (const kind of ['wrong-sha', 'wrong-revision', 'duplicate', 'path', 'expired'] as const) {
        const inspected = await migrator.inspect(
            { origin: 'Relay-Preview' },
            new AbortController().signal
          ),
          selected = selections(inspected)
        const profiles =
          kind === 'wrong-sha'
            ? [{ ...selected[0], sha256: 'a'.repeat(64) }]
            : kind === 'wrong-revision'
              ? [{ ...selected[0], revision: 'b'.repeat(64) }]
              : kind === 'duplicate'
                ? [...selected, ...selected]
                : kind === 'path'
                  ? [{ ...selected[0], path: '/PRIVATE' }]
                  : selected
        if (kind === 'expired') time += 60000
        await expect(
          migrator.prepare(
            { inspectionId: inspected.inspectionId, profiles },
            { baseline, temporaryHome: f.temporaryHome, signal: new AbortController().signal }
          )
        ).rejects.toThrow()
        expect(await readdir(f.temporaryHome)).toEqual([])
      }
    })
  })

  it('keeps a late cancelled inspection from publishing and scopes stale cancellation to its own ID', async () => {
    await fixture(async (f) => {
      await f.old()
      const migrator = createLegacyRelayMigration({ home: f.home }),
        list = ProfileStore.prototype.listLegacy
      let release!: () => void, entered!: () => void
      const gate = new Promise<void>((resolve) => {
          release = resolve
        }),
        ready = new Promise<void>((resolve) => {
          entered = resolve
        })
      vi.spyOn(ProfileStore.prototype, 'listLegacy').mockImplementationOnce(async function (
        this: ProfileStore
      ) {
        const result = await list.call(this)
        entered()
        await gate
        return result
      })
      const pending = migrator.inspect({ origin: 'Relay-Preview' }, new AbortController().signal)
      await ready
      const outcome = expect(pending).rejects.toThrow('取消')
      await expect(
        migrator.inspect({ origin: 'Relay' }, new AbortController().signal)
      ).rejects.toThrow('等待')
      migrator.cancel()
      release()
      await outcome
      await migrator.whenIdle()
      const first = await migrator.inspect(
          { origin: 'Relay-Preview' },
          new AbortController().signal
        ),
        second = await migrator.inspect({ origin: 'Relay-Preview' }, new AbortController().signal)
      migrator.cancel(first.inspectionId)
      expect(
        (
          await migrator.prepare(
            { inspectionId: second.inspectionId, profiles: selections(second) },
            {
              baseline: await f.store.snapshot(),
              temporaryHome: f.temporaryHome,
              signal: new AbortController().signal
            }
          )
        ).report.profiles
      ).toHaveLength(1)
    })
  })

  it('revokes an in-flight preparation after its private save without modifying the real fixture baseline', async () => {
    await fixture(async (f) => {
      const old = await f.old(),
        baseline = await f.store.snapshot(),
        migrator = createLegacyRelayMigration({ home: f.home }),
        inspected = await migrator.inspect(
          { origin: 'Relay-Preview' },
          new AbortController().signal
        ),
        save = ProfileStore.prototype.save
      vi.spyOn(ProfileStore.prototype, 'save').mockImplementationOnce(async function (
        this: ProfileStore,
        name,
        text
      ) {
        const saved = await save.call(this, name, text)
        migrator.cancel(inspected.inspectionId)
        return saved
      })
      await expect(
        migrator.prepare(
          { inspectionId: inspected.inspectionId, profiles: selections(inspected) },
          { baseline, temporaryHome: f.temporaryHome, signal: new AbortController().signal }
        )
      ).rejects.toThrow('取消')
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(backupSnapshotSHA256(baseline))
      expect(await readFile(join(old.directory, 'profile.yaml'))).toEqual(old.configuration)
      expect(migrator.isBusy()).toBe(false)
      await migrator.whenIdle()
    })
  })

  it('does not adopt unknown staging files or a nonempty home', async () => {
    await fixture(async (f) => {
      await f.old()
      const migrator = createLegacyRelayMigration({ home: f.home }),
        inspected = await migrator.inspect(
          { origin: 'Relay-Preview' },
          new AbortController().signal
        )
      await writeFile(join(f.temporaryHome, 'KEEP'), 'FOREIGN', { mode: 0o600 })
      await expect(
        migrator.prepare(
          { inspectionId: inspected.inspectionId, profiles: selections(inspected) },
          {
            baseline: await f.store.snapshot(),
            temporaryHome: f.temporaryHome,
            signal: new AbortController().signal
          }
        )
      ).rejects.toThrow('空私有')
      expect(await readFile(join(f.temporaryHome, 'KEEP'), 'utf8')).toBe('FOREIGN')
      expect((await lstat(f.temporaryHome)).mode & 0o7777).toBe(0o700)
    })
  })

  it('retains a late foreign staging file and refuses to add it to the candidate', async () => {
    await fixture(async (f) => {
      await f.old()
      const migrator = createLegacyRelayMigration({ home: f.home }),
        inspected = await migrator.inspect(
          { origin: 'Relay-Preview' },
          new AbortController().signal
        ),
        baseline = await f.store.snapshot(),
        save = ProfileStore.prototype.save,
        foreign = join(f.temporaryHome, 'Library/Application Support/Relay/preferences.json')
      vi.spyOn(ProfileStore.prototype, 'save').mockImplementationOnce(async function (
        this: ProfileStore,
        name,
        text
      ) {
        const saved = await save.call(this, name, text)
        await writeFile(foreign, 'FOREIGN-PRESERVE', { mode: 0o600 })
        return saved
      })
      await expect(
        migrator.prepare(
          { inspectionId: inspected.inspectionId, profiles: selections(inspected) },
          { baseline, temporaryHome: f.temporaryHome, signal: new AbortController().signal }
        )
      ).rejects.toThrow('未知')
      expect(await readFile(foreign, 'utf8')).toBe('FOREIGN-PRESERVE')
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(backupSnapshotSHA256(baseline))
    })
  })
})
