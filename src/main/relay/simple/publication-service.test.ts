import { access, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { defaultSimpleDraft } from '../../../shared/simple-config'
import { ProfileStore, ProfileWriteUncertain } from '../profiles/store'
import { createProfileService } from '../profiles/service'
import {
  createBackupArchive,
  readBackupArchive,
  backupDirectories,
  type BackupSnapshot
} from '../backup/archive'
import { createSimpleDraftService } from './service'
import { createPinnedSimpleCapture } from './capture'
import { SimpleDraftStore, SimpleWriteUncertain } from './store'
import { SimplePublicationJournal } from './publication-journal'
import { createSimplePublicationService } from './publication-service'
import { SimpleFailure } from './model'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function makeFixture(home: string) {
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  const profiles = new ProfileStore(context),
    store = new SimpleDraftStore(context),
    journal = new SimplePublicationJournal(context)
  const text =
    'proxies:\n  - { name: Original, type: http, server: 192.0.2.7, port: 8080, password: synthetic-private-source }\n'
  const original = await profiles.save('Original.yaml', text),
    selection = { id: original.id, sha256: original.sha256 },
    held = await profiles.read(selection)
  const draft = defaultSimpleDraft()
  draft.sources = [
    {
      id: 'bound',
      name: 'Bound',
      mode: 'extract',
      prefix: '',
      interval: 3600,
      proxies: [],
      profileId: selection.id
    }
  ]
  await store.saveDraft(
    {
      expectedRevision: '',
      draft,
      bindings: [{ id: 'bound', profile: selection, profileRevision: held.revision }],
      configurationRevision: ''
    },
    () => {}
  )
  let live = true,
    time = 1000
  const owner = { isCurrent: () => live }
  const simple = createSimpleDraftService({ store, capture: createPinnedSimpleCapture(context) })
  const profileAdapters = {
    pick: async () => undefined,
    confirm: vi.fn(async () => true),
    save: vi.fn((name: string, body: string) => profiles.save(name, body)),
    list: vi.fn(() => profiles.list()),
    now: () => time
  }
  const profileService = createProfileService(profileAdapters)
  const pubAdapters = {
    store: {
      read: vi.fn(() => store.read()),
      promotePublished: vi.fn((...args: Parameters<SimpleDraftStore['promotePublished']>) =>
        store.promotePublished(...args)
      )
    },
    journal: {
      read: vi.fn(() => journal.read()),
      write: vi.fn((...args: Parameters<SimplePublicationJournal['write']>) =>
        journal.write(...args)
      ),
      retireMissing: vi.fn((...args: Parameters<SimplePublicationJournal['retireMissing']>) =>
        journal.retireMissing(...args)
      )
    },
    simple,
    profiles: profileService,
    readProfile: vi.fn((value: Parameters<ProfileStore['read']>[0]) => profiles.read(value)),
    now: () => time
  }
  const publication = createSimplePublicationService(pubAdapters)
  return {
    profiles,
    store,
    journal,
    simple,
    profileService,
    publication,
    pubAdapters,
    profileAdapters,
    owner,
    original,
    selection,
    text,
    retire: () => {
      live = false
    },
    revive: () => {
      live = true
    },
    advance: () => {
      time += 60001
    },
    invalidClock: () => {
      time = Number.NaN
    },
    restart: () => createSimplePublicationService(pubAdapters)
  }
}
async function fixture(run: (f: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-publication-coordinator-')))
  let f: Awaited<ReturnType<typeof makeFixture>> | undefined
  try {
    f = await makeFixture(home)
    await run(f)
  } finally {
    f?.publication.clear()
    f?.simple.clear()
    f?.profileService.clear()
    await f?.publication.whenIdle()
    await f?.simple.whenIdle()
    await f?.profileService.whenIdle()
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
    await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
  }
}
async function prepare(f: Awaited<ReturnType<typeof makeFixture>>) {
  await f.publication.initialize()
  const record = await f.store.read(),
    preview = await f.simple.preview(record.revision, f.owner)
  return f.publication.prepare(
    {
      expectedRevision: record.revision,
      previewSHA256: preview.yamlSHA256,
      name: 'Published copy'
    },
    f.owner
  )
}
async function abandon(f: Awaited<ReturnType<typeof makeFixture>>, operationId: string) {
  return f.publication.abandon(
    { operationId, expectedMarkerRevision: f.publication.state().markerRevision },
    { isCurrent: () => true }
  )
}
describe('RealFS publication coordinator and purpose boundary', () => {
  it('requires disk initialization; ordinary missing marker is inert and does not pretend busy after init', async () =>
    fixture(async (f) => {
      expect(f.publication.isBlocking()).toBe(true)
      expect(f.publication.isBusy()).toBe(false)
      await expect(
        f.publication.prepare(
          { expectedRevision: '', previewSHA256: 'a'.repeat(64), name: 'Copy' },
          f.owner
        )
      ).rejects.toMatchObject({ code: 'uncertain' })
      const state = await f.publication.initialize()
      expect(state).toMatchObject({
        initialized: true,
        pending: false,
        blocking: false,
        closing: false,
        classification: 'none'
      })
      await expect(access(f.journal.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }))
  it('publishes once through actual capture/Profile/journal and never changes original or chooses a config', async () =>
    fixture(async (f) => {
      const before = await f.store.read(),
        p = await prepare(f)
      expect(f.publication.isBusy()).toBe(false)
      await expect(f.profileService.save({ evidenceId: p.preparation.evidenceId })).rejects.toThrow(
        '重新选择'
      )
      const result = await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      expect(result).toMatchObject({
        status: 'published',
        operationId: p.operationId,
        publishedRevision: 1,
        needsRecovery: false
      })
      expect(f.profileAdapters.confirm).toHaveBeenCalledOnce()
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
      expect(f.profileAdapters.list).not.toHaveBeenCalled()
      expect(f.pubAdapters.store.promotePublished).toHaveBeenCalledOnce()
      const after = await f.store.read()
      expect(after.document.state.draft).toEqual(before.document.state.draft)
      expect(after.document.state.published).toEqual(before.document.state.draft)
      expect(after.document.bindings.published).toEqual(before.document.bindings.draft)
      expect(after.document.publication?.profile).toEqual(result.profile)
      expect((await f.profiles.read(f.selection)).text).toBe(f.text)
      expect((await f.journal.read()).value?.phase).toBe('complete')
      expect(await readFile(f.journal.path, 'utf8')).not.toContain('synthetic-private-source')
      await expect(
        f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      ).rejects.toMatchObject({ code: 'stale' })
    }))
  it('cancellation does not write intent, profile or published data', async () =>
    fixture(async (f) => {
      const before = await readFile(f.store.path),
        p = await prepare(f)
      f.profileAdapters.confirm.mockResolvedValueOnce(false)
      expect(
        (await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)).status
      ).toBe('cancelled')
      expect(f.publication.isBlocking()).toBe(false)
      expect(f.pubAdapters.journal.write).not.toHaveBeenCalled()
      expect(f.profileAdapters.save).not.toHaveBeenCalled()
      expect(await readFile(f.store.path)).toEqual(before)
    }))
  it.each(['clear', 'owner', 'expired'] as const)(
    'retires %s while actual confirmation waits with no Profile write',
    async (kind) =>
      fixture(async (f) => {
        const p = await prepare(f),
          enter = deferred<void>(),
          gate = deferred<boolean>()
        f.profileAdapters.confirm.mockImplementationOnce(async () => {
          enter.resolve()
          return gate.promise
        })
        const saving = f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
        await enter.promise
        let drained = false
        const idle = f.publication.whenIdle().then(() => {
          drained = true
        })
        await Promise.resolve()
        expect(drained).toBe(false)
        if (kind === 'clear') f.publication.clear()
        if (kind === 'owner') f.retire()
        if (kind === 'expired') f.advance()
        gate.resolve(true)
        await saving
        await idle
        expect(f.profileAdapters.save).not.toHaveBeenCalled()
        expect(f.pubAdapters.journal.write).not.toHaveBeenCalled()
        expect((await f.store.read()).document.state.revision).toBe(0)
      })
  )
  it('keeps a newly saved copy after owner retires inside admitted save, without promotion', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      f.profileAdapters.save.mockImplementationOnce(async (name, text) => {
        const profile = await f.profiles.save(name, text)
        f.retire()
        return profile
      })
      const result = await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      expect(result.status).toBe('uncertain')
      expect(result.profile).toBeDefined()
      expect((await f.journal.read()).value?.phase).toBe('profile-saved')
      expect((await f.profiles.list()).profiles).toHaveLength(2)
      expect((await f.store.read()).document.state.revision).toBe(0)
      expect(f.pubAdapters.store.promotePublished).not.toHaveBeenCalled()
      expect((await abandon(f, p.operationId)).status).toBe('abandoned')
      expect(f.publication.isBlocking()).toBe(false)
      expect((await f.profiles.list()).profiles).toHaveLength(2)
    }))
  it('unknown Profile ID remains unresolved across restart without list/save retry; explicit abandon preserves copy', async () =>
    fixture(async (f) => {
      const p = await prepare(f),
        before = await readFile(f.store.path)
      f.profileAdapters.save.mockImplementationOnce(async (name, text) => {
        await f.profiles.save(name, text)
        throw new ProfileWriteUncertain()
      })
      const result = await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      expect(result).toMatchObject({ status: 'uncertain', needsRecovery: true })
      expect(result.profile).toBeUndefined()
      expect(f.profileAdapters.list).not.toHaveBeenCalled()
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
      const restarted = f.restart(),
        state = await restarted.initialize()
      expect(state.classification).toBe('unknown-profile')
      expect(restarted.isBlocking()).toBe(true)
      await expect(
        restarted.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      ).rejects.toMatchObject({ code: 'stale' })
      expect(
        (
          await restarted.abandon(
            { operationId: p.operationId, expectedMarkerRevision: state.markerRevision },
            f.owner
          )
        ).status
      ).toBe('abandoned')
      expect(await readFile(f.store.path)).toEqual(before)
      expect((await f.profiles.list()).profiles).toHaveLength(2)
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
    }))
  it('intent failure never reaches Profile and remains explicit-recovery blocked', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      f.pubAdapters.journal.write.mockRejectedValueOnce(new SimpleFailure('uncertain'))
      expect(
        (await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)).status
      ).toBe('uncertain')
      expect(f.profileAdapters.save).not.toHaveBeenCalled()
      expect(f.publication.isBlocking()).toBe(true)
      expect((await abandon(f, p.operationId)).status).toBe('abandoned')
      expect(f.publication.isBlocking()).toBe(false)
    }))
  it('a lost held marker is uncertain while a fresh absent marker is none; only explicit exact abandon retires known facts', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      f.profileAdapters.save.mockRejectedValueOnce(new ProfileWriteUncertain())
      await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      await unlink(f.journal.path)
      expect((await f.publication.recover(f.owner)).classification).toBe('uncertain')
      expect(f.publication.isBlocking()).toBe(true)
      expect((await abandon(f, p.operationId)).status).toBe('abandoned')
      expect((await f.journal.read()).value?.phase).toBe('abandoned')
    }))
  it('known Profile marker failure keeps the saved copy without attempting promotion', async () =>
    fixture(async (f) => {
      const p = await prepare(f),
        original = f.pubAdapters.journal.write.getMockImplementation()
      if (!original) throw new Error('Missing actual journal adapter')
      f.pubAdapters.journal.write.mockImplementation(async (...args) => {
        if ((args[1] as { phase: string }).phase === 'profile-saved')
          throw new SimpleFailure('uncertain')
        return original(...args)
      })
      const result = await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      expect(result.status).toBe('uncertain')
      expect(result.profile).toBeDefined()
      expect(f.pubAdapters.store.promotePublished).not.toHaveBeenCalled()
      expect((await f.profiles.list()).profiles).toHaveLength(2)
      expect((await abandon(f, p.operationId)).status).toBe('abandoned')
    }))
  it('does not retry promotion if its return is uncertain after actual commit', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      f.pubAdapters.store.promotePublished.mockImplementationOnce(async (...args) => {
        await f.store.promotePublished(...args)
        throw new SimpleWriteUncertain()
      })
      expect(
        (await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)).status
      ).toBe('published')
      expect((await f.store.read()).document.state.revision).toBe(1)
      expect(f.pubAdapters.store.promotePublished).toHaveBeenCalledOnce()
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
      expect((await f.publication.recover(f.owner)).classification).toBe('complete')
    }))
  it('recognizes committed receipt when terminal cleanup fails and explicit retirement does not publish twice', async () =>
    fixture(async (f) => {
      const p = await prepare(f),
        original = f.pubAdapters.journal.write.getMockImplementation()
      if (!original) throw new Error('Missing journal adapter')
      f.pubAdapters.journal.write.mockImplementation(async (...args) => {
        if ((args[1] as { phase: string }).phase === 'complete')
          throw new SimpleFailure('uncertain')
        return original(...args)
      })
      expect(
        await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      ).toMatchObject({ status: 'published', needsRecovery: true })
      expect(f.publication.state()).toMatchObject({
        classification: 'complete',
        needsRetirement: true
      })
      const restarted = f.restart(),
        state = await restarted.initialize()
      expect(state).toMatchObject({ classification: 'complete', needsRetirement: true })
      f.pubAdapters.journal.write.mockImplementation(original)
      expect(
        (
          await restarted.abandon(
            { operationId: p.operationId, expectedMarkerRevision: state.markerRevision },
            f.owner
          )
        ).status
      ).toBe('published')
      expect((await f.store.read()).document.state.revision).toBe(1)
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
      expect(f.pubAdapters.store.promotePublished).toHaveBeenCalledOnce()
    }))
  it('terminal complete remains valid after future ordinary draft-only SHA changes', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      const result = await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      const before = await f.store.read(),
        draft = structuredClone(before.document.state.draft)
      draft.modules.hosts = 'future.invalid: 192.0.2.44\n'
      const after = await f.store.saveDraft(
        {
          expectedRevision: before.revision,
          draft,
          bindings: before.document.bindings.draft,
          configurationRevision: ''
        },
        () => {}
      )
      expect(after.revision).not.toBe(result.revision)
      expect((await f.restart().initialize()).classification).toBe('complete')
      expect(after.document.publication).toEqual(before.document.publication)
    }))
  it('an unresolved active commit cannot be recognized from receipt after its exact postimage has drifted', async () =>
    fixture(async (f) => {
      const p = await prepare(f),
        original = f.pubAdapters.journal.write.getMockImplementation()
      if (!original) throw new Error('Missing journal adapter')
      f.pubAdapters.journal.write.mockImplementation(async (...args) => {
        if ((args[1] as { phase: string }).phase === 'complete')
          throw new SimpleFailure('uncertain')
        return original(...args)
      })
      await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      const before = await f.store.read(),
        draft = structuredClone(before.document.state.draft)
      draft.modules.hosts = 'changed-after-commit.invalid: 192.0.2.88\n'
      await f.store.saveDraft(
        {
          expectedRevision: before.revision,
          draft,
          bindings: before.document.bindings.draft,
          configurationRevision: ''
        },
        () => {}
      )
      expect((await f.restart().initialize()).classification).toBe('uncertain')
    }))
  it('afterRestore classifies an old backup without marker/receipt and never restores old tokens', async () =>
    fixture(async (f) => {
      const original = await readFile(f.store.path),
        p = await prepare(f)
      await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      await writeFile(f.store.path, original, { mode: 0o600 })
      await unlink(f.journal.path)
      expect((await f.publication.afterRestore()).classification).toBe('none')
      expect(f.publication.isBlocking()).toBe(false)
      await expect(
        f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      ).rejects.toMatchObject({ code: 'stale' })
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
    }))
  it('close drains in-flight confirmation and reopen retires proof without clearing unresolved journal', async () =>
    fixture(async (f) => {
      const p = await prepare(f),
        entered = deferred<void>(),
        release = deferred<boolean>()
      f.profileAdapters.confirm.mockImplementationOnce(async () => {
        entered.resolve()
        return release.promise
      })
      const saving = f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      await entered.promise
      let drained = false
      const closing = f.publication.requestClose().then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      release.resolve(true)
      await saving
      await closing
      expect(drained).toBe(true)
      expect(f.profileAdapters.save).not.toHaveBeenCalled()
      f.publication.reopen()
      expect(f.publication.isBusy()).toBe(false)
      await expect(
        f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      ).rejects.toMatchObject({ code: 'stale' })
    }))
  it('keeps the old complete profile out of a later cancelled operation receipt', async () =>
    fixture(async (f) => {
      const first = await prepare(f)
      await f.publication.confirm({ evidenceId: first.preparation.evidenceId }, f.owner)
      const second = await prepare(f)
      f.profileAdapters.confirm.mockResolvedValueOnce(false)
      const result = await f.publication.confirm(
        { evidenceId: second.preparation.evidenceId },
        f.owner
      )
      expect(result.status).toBe('cancelled')
      expect(result.profile).toBeUndefined()
    }))
  it('rejects an unusable clock after Profile save before promotion', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      f.profileAdapters.save.mockImplementationOnce(async (name, text) => {
        const profile = await f.profiles.save(name, text)
        f.invalidClock()
        return profile
      })
      expect(
        (await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)).status
      ).toBe('uncertain')
      expect(f.pubAdapters.store.promotePublished).not.toHaveBeenCalled()
      expect((await f.store.read()).document.state.revision).toBe(0)
    }))
  it('checks original expiry again at the final synchronous promotion admission', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      let admissions = 0
      f.pubAdapters.store.promotePublished.mockImplementationOnce((raw, recheck, admit) =>
        f.store.promotePublished(raw, recheck, () => {
          if (++admissions === 3) f.advance()
          admit()
        })
      )
      expect(
        (await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)).status
      ).toBe('uncertain')
      expect((await f.store.read()).document.state.revision).toBe(0)
    }))
  it('does not classify none if another marker arrives during its read-only snapshot', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      f.profileAdapters.save.mockRejectedValueOnce(new ProfileWriteUncertain())
      await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      const marker = await readFile(f.journal.path)
      await unlink(f.journal.path)
      const restarted = f.restart()
      const original = f.pubAdapters.store.read.getMockImplementation()
      if (!original) throw new Error('Missing store reader')
      f.pubAdapters.store.read.mockImplementationOnce(async () => {
        const value = await original()
        await writeFile(f.journal.path, marker, { mode: 0o600 })
        return value
      })
      expect((await restarted.initialize()).classification).toBe('uncertain')
      expect(restarted.isBlocking()).toBe(true)
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
    }))
  it('does not release a complete classification if the marker changes during known-profile verification', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      const restarted = f.restart(),
        original = f.pubAdapters.readProfile.getMockImplementation()
      if (!original) throw new Error('Missing Profile reader')
      f.pubAdapters.readProfile.mockImplementationOnce(async (value) => {
        const profile = await original(value)
        const marker = await f.journal.read()
        await writeFile(
          f.journal.path,
          JSON.stringify({
            ...marker.value,
            phase: 'intent',
            profile: null,
            postimageSHA256: null
          }),
          { mode: 0o600 }
        )
        return profile
      })
      expect((await restarted.initialize()).classification).toBe('uncertain')
      expect(restarted.isBlocking()).toBe(true)
    }))
  it.each([
    'journal-read',
    'classification-read',
    'record-read',
    'simple-prepare',
    'cap-after-await',
    'purpose-after-await'
  ] as const)('fails closed at prepare boundary %s without persistence', async (boundary) =>
    fixture(async (f) => {
      await f.publication.initialize()
      const before = await f.store.read(),
        preview = await f.simple.preview(before.revision, f.owner),
        bytes = await readFile(f.store.path)
      if (boundary === 'journal-read')
        f.pubAdapters.journal.read.mockRejectedValueOnce(new Error('synthetic-private'))
      if (boundary === 'classification-read')
        f.pubAdapters.store.read.mockRejectedValueOnce(new Error('synthetic-private'))
      if (boundary === 'record-read') {
        const original = f.pubAdapters.store.read.getMockImplementation()
        if (!original) throw new Error('Missing reader')
        let reads = 0
        f.pubAdapters.store.read.mockImplementation(async () => {
          if (++reads === 3) throw new Error('synthetic-private')
          return original()
        })
      }
      if (boundary === 'simple-prepare')
        vi.spyOn(f.simple, 'prepareProfile').mockRejectedValueOnce(new Error('synthetic-private'))
      if (boundary === 'cap-after-await') {
        const original = f.simple.prepareProfile
        vi.spyOn(f.simple, 'prepareProfile').mockImplementationOnce(async (...args) => {
          const source = await original(...args)
          return {
            ...source,
            assertCurrent: async () => {
              await source.assertCurrent?.()
              f.retire()
            }
          }
        })
      }
      if (boundary === 'purpose-after-await') {
        const original = f.profileService.preparePublication
        vi.spyOn(f.profileService, 'preparePublication').mockImplementationOnce(async (...args) => {
          const result = await original(...args)
          f.publication.clear()
          return result
        })
      }
      await expect(
        f.publication.prepare(
          {
            expectedRevision: before.revision,
            previewSHA256: preview.yamlSHA256,
            name: 'Boundary copy'
          },
          f.owner
        )
      ).rejects.toBeInstanceOf(SimpleFailure)
      expect(f.profileAdapters.save).not.toHaveBeenCalled()
      expect(f.pubAdapters.journal.write).not.toHaveBeenCalled()
      expect(await readFile(f.store.path)).toEqual(bytes)
      expect(f.publication.isBusy()).toBe(false)
    })
  )
  it.each([
    'initial-journal',
    'intent-return',
    'known-profile-read',
    'lease-read',
    'draft-changed',
    'final-owner'
  ] as const)('does not publish after confirm boundary %s fails', async (boundary) =>
    fixture(async (f) => {
      const p = await prepare(f),
        before = await f.store.read()
      if (boundary === 'initial-journal')
        f.pubAdapters.journal.read.mockRejectedValueOnce(new Error('synthetic-private'))
      if (boundary === 'intent-return') {
        const original = f.pubAdapters.journal.write.getMockImplementation()
        if (!original) throw new Error('Missing writer')
        f.pubAdapters.journal.write.mockImplementationOnce(async (...args) => {
          await original(...args)
          throw new SimpleFailure('uncertain')
        })
      }
      if (boundary === 'known-profile-read')
        f.pubAdapters.readProfile.mockRejectedValueOnce(new Error('synthetic-private'))
      if (boundary === 'lease-read') {
        const original = f.pubAdapters.journal.read.getMockImplementation()
        if (!original) throw new Error('Missing reader')
        let reads = 0
        f.pubAdapters.journal.read.mockImplementation(async () => {
          if (++reads === 2) throw new Error('synthetic-private')
          return original()
        })
      }
      if (boundary === 'draft-changed')
        f.profileAdapters.save.mockImplementationOnce(async (name, text) => {
          const profile = await f.profiles.save(name, text),
            current = await f.store.read(),
            draft = structuredClone(current.document.state.draft)
          draft.modules.hosts = 'changed-mid-confirm.invalid: 192.0.2.99\n'
          await f.store.saveDraft(
            {
              expectedRevision: current.revision,
              draft,
              bindings: current.document.bindings.draft,
              configurationRevision: ''
            },
            () => {}
          )
          return profile
        })
      if (boundary === 'final-owner')
        f.pubAdapters.store.promotePublished.mockImplementationOnce((raw, recheck, admission) => {
          let calls = 0
          return f.store.promotePublished(raw, recheck, () => {
            if (++calls === 3) f.retire()
            admission()
          })
        })
      const result = await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      expect(result.status).not.toBe('published')
      const after = await f.store.read()
      expect(after.document.state.revision).toBe(0)
      expect(after.document.state.published).toEqual(before.document.state.published)
      expect(f.profileAdapters.save.mock.calls.length).toBeLessThanOrEqual(1)
      expect(f.profileAdapters.list).not.toHaveBeenCalled()
      expect((await f.profiles.read(f.selection)).text).toBe(f.text)
    })
  )
  it('refuses recovery and retirement against unknown unsafe marker bytes without repair', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      f.profileAdapters.save.mockRejectedValueOnce(new ProfileWriteUncertain())
      await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      const bytes = Buffer.from('{"version":99,"secret":"synthetic-private"}\n')
      await writeFile(f.journal.path, bytes, { mode: 0o600 })
      expect((await f.publication.recover(f.owner)).classification).toBe('uncertain')
      await expect(abandon(f, p.operationId)).rejects.toMatchObject({ code: 'uncertain' })
      expect(await readFile(f.journal.path)).toEqual(bytes)
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
    }))
  it('cannot reopen an unresolved journal through a normal close/reopen cycle', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      f.profileAdapters.save.mockRejectedValueOnce(new ProfileWriteUncertain())
      await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      await f.publication.requestClose()
      f.publication.reopen()
      expect(f.publication.isBusy()).toBe(false)
      expect(f.publication.isBlocking()).toBe(true)
      const record = await f.store.read()
      await expect(
        f.publication.prepare(
          { expectedRevision: record.revision, previewSHA256: 'a'.repeat(64), name: 'No retry' },
          f.owner
        )
      ).rejects.toMatchObject({ code: 'uncertain' })
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
    }))
  it.each(['owner', 'epoch'] as const)(
    'stops classification private reads immediately after recover %s withdrawal',
    async (kind) =>
      fixture(async (f) => {
        await f.publication.initialize()
        const entered = deferred<void>(),
          release = deferred<void>(),
          original = f.pubAdapters.journal.read.getMockImplementation()
        if (!original) throw new Error('Missing journal reader')
        f.pubAdapters.journal.read.mockImplementationOnce(async () => {
          const record = await original()
          entered.resolve()
          await release.promise
          return record
        })
        let retired = false,
          reads = 0
        const storeRead = f.pubAdapters.store.read.getMockImplementation()
        if (!storeRead) throw new Error('Missing store reader')
        f.pubAdapters.store.read.mockImplementation(() => {
          if (retired) reads++
          return storeRead()
        })
        const recovering = f.publication.recover(f.owner)
        const rejected = expect(recovering).rejects.toMatchObject({ code: 'cancelled' })
        await entered.promise
        retired = true
        if (kind === 'owner') f.retire()
        else f.publication.clear()
        release.resolve()
        await rejected
        expect(reads).toBe(0)
        expect(f.publication.isBusy()).toBe(false)
      })
  )
  it('stops ownerless startup classification on epoch retirement without a following store read', async () =>
    fixture(async (f) => {
      const entered = deferred<void>(),
        release = deferred<void>(),
        original = f.pubAdapters.journal.read.getMockImplementation()
      if (!original) throw new Error('Missing journal reader')
      f.pubAdapters.journal.read.mockImplementationOnce(async () => {
        const record = await original()
        entered.resolve()
        await release.promise
        return record
      })
      const initializing = f.publication.initialize(),
        rejected = expect(initializing).rejects.toMatchObject({ code: 'cancelled' })
      await entered.promise
      f.publication.clear()
      f.pubAdapters.store.read.mockClear()
      release.resolve()
      await rejected
      expect(f.pubAdapters.store.read).not.toHaveBeenCalled()
      expect(f.publication.state().initialized).toBe(false)
    }))
  it('postcommit owner retirement still records already-admitted facts without repeating publication', async () =>
    fixture(async (f) => {
      const p = await prepare(f)
      f.pubAdapters.store.promotePublished.mockImplementationOnce(async (...args) => {
        const result = await f.store.promotePublished(...args)
        f.retire()
        f.publication.clear()
        return result
      })
      expect(
        (await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)).status
      ).toBe('published')
      expect((await f.journal.read()).value?.phase).toBe('complete')
      expect((await f.store.read()).document.state.revision).toBe(1)
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
      expect(f.pubAdapters.store.promotePublished).toHaveBeenCalledOnce()
    }))
  it('round-trips old/new publication files through unchanged backup roots and classifies restored facts', async () =>
    fixture(async (f) => {
      expect(backupDirectories).toContain('Configuration')
      expect(backupDirectories).toContain('Configurations')
      const oldBytes = await readFile(f.store.path)
      const oldSnapshot: BackupSnapshot = {
        directories: ['Configuration'],
        entries: [{ path: 'Configuration/simple.json', bytes: oldBytes, mode: 0o600 }]
      }
      expect(readBackupArchive(createBackupArchive(oldSnapshot)).snapshot).toEqual(oldSnapshot)
      const p = await prepare(f)
      const result = await f.publication.confirm({ evidenceId: p.preparation.evidenceId }, f.owner)
      if (!result.profile) throw new Error('Missing saved Profile')
      const root = join(f.profiles.directory, result.profile.id)
      const snapshot: BackupSnapshot = {
        directories: ['Configuration', 'Configurations', 'Configurations/' + result.profile.id],
        entries: [
          { path: 'Configuration/simple.json', bytes: await readFile(f.store.path), mode: 0o600 },
          {
            path: 'Configuration/simple-publication.json',
            bytes: await readFile(f.journal.path),
            mode: 0o600
          },
          {
            path: 'Configurations/' + result.profile.id + '/profile.yaml',
            bytes: await readFile(join(root, 'profile.yaml')),
            mode: 0o600
          },
          {
            path: 'Configurations/' + result.profile.id + '/metadata.json',
            bytes: await readFile(join(root, 'metadata.json')),
            mode: 0o600
          }
        ]
      }
      const archived = readBackupArchive(createBackupArchive(snapshot))
      expect(archived.snapshot).toEqual({
        directories: [...snapshot.directories].sort(),
        entries: [...snapshot.entries].sort((left, right) =>
          left.path.localeCompare(right.path, 'en')
        )
      })
      // Only replay this fixture's exact Configuration bytes; the actual backup
      // restore transaction and user filesystem remain outside this backend slice.
      await writeFile(f.store.path, oldBytes, { mode: 0o600 })
      await unlink(f.journal.path)
      expect((await f.publication.afterRestore()).classification).toBe('none')
      const simpleBytes = archived.snapshot.entries.find(
        (row) => row.path === 'Configuration/simple.json'
      )?.bytes
      const journalBytes = archived.snapshot.entries.find(
        (row) => row.path === 'Configuration/simple-publication.json'
      )?.bytes
      if (!simpleBytes || !journalBytes) throw new Error('Missing archived owned facts')
      await writeFile(f.store.path, simpleBytes, { mode: 0o600 })
      await writeFile(f.journal.path, journalBytes, { mode: 0o600 })
      expect((await f.publication.afterRestore()).classification).toBe('complete')
      expect(f.profileAdapters.save).toHaveBeenCalledOnce()
    }))
})
