import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ProfileStore } from '../profiles/store'
import { createProfileService } from '../profiles/service'
import { defaultSimpleDraft } from '../../../shared/simple-config'
import { SimpleDraftStore } from './store'
import { createSimpleDraftService } from './service'
import { createPinnedSimpleCapture } from './capture'
import { SimplePublicationJournal } from './publication-journal'
import { createSimplePublicationService } from './publication-service'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
it('owner-only loss during prepare classification must prevent the following private SimpleStore read', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-own-pub-owner-')))
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  const profiles = new ProfileStore(context),
    store = new SimpleDraftStore(context),
    journal = new SimplePublicationJournal(context)
  let live = true,
    revoked = false,
    readsAfterRevoke = 0
  const owner = { isCurrent: () => live },
    entered = gate(),
    release = gate()
  const simple = createSimpleDraftService({ store, capture: createPinnedSimpleCapture(context) })
  const confirm = vi.fn(async () => true),
    save = vi.fn((name: string, text: string) => profiles.save(name, text)),
    list = vi.fn(() => profiles.list())
  const profileService = createProfileService({ pick: async () => undefined, confirm, save, list })
  const read = vi.fn(() => {
    if (revoked) readsAfterRevoke++
    return store.read()
  })
  const markerRead = vi.fn(() => journal.read())
  const pub = createSimplePublicationService({
    store: { read, promotePublished: store.promotePublished.bind(store) },
    journal: {
      read: markerRead,
      write: journal.write.bind(journal),
      retireMissing: journal.retireMissing.bind(journal)
    },
    simple,
    profiles: profileService,
    readProfile: profiles.read.bind(profiles)
  })
  try {
    const draft = defaultSimpleDraft()
    await store.saveDraft(
      { expectedRevision: '', draft, bindings: [], configurationRevision: '' },
      () => {}
    )
    await pub.initialize()
    const record = await store.read(),
      before = await readFile(store.path),
      preview = await simple.preview(record.revision, owner)
    markerRead.mockImplementationOnce(async () => {
      const facts = await journal.read()
      entered.resolve()
      await release.promise
      return facts
    })
    read.mockClear()
    const pending = pub.prepare(
      {
        expectedRevision: record.revision,
        previewSHA256: preview.yamlSHA256,
        name: 'OwnPublication'
      },
      owner
    )
    const rejection = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await entered.promise
    live = false
    revoked = true
    release.resolve()
    await rejection
    expect(pub.isBusy()).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(await readFile(store.path)).toEqual(before)
    expect(readsAfterRevoke).toBe(0)
  } finally {
    release.resolve()
    pub.clear()
    profileService.clear()
    simple.clear()
    await pub.whenIdle()
    await profileService.whenIdle()
    await simple.whenIdle()
    await rm(home, { recursive: true, force: true })
  }
})
