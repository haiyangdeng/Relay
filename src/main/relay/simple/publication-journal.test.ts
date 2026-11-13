import { access, link, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { defaultSimpleDraft } from '../../../shared/simple-config'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { document, hash, type SimplePublicationReceipt } from './model'
import { SimpleDraftStore, publicationPostimage } from './store'
import { SimplePublicationJournal, type PublicationMarker } from './publication-journal'

const receipt: SimplePublicationReceipt = {
  operationId: '11111111-1111-4111-8111-111111111111',
  inputDigest: 'a'.repeat(64),
  profile: { id: '22222222-2222-4222-8222-222222222222', sha256: 'b'.repeat(64) }
}
async function fixture(
  run: (f: { store: SimpleDraftStore; journal: SimplePublicationJournal }) => Promise<void>
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-publication-layer1-')))
  try {
    const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
    await run({
      store: new SimpleDraftStore(context),
      journal: new SimplePublicationJournal(context)
    })
  } finally {
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
    await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
  }
}
async function seed(store: SimpleDraftStore) {
  const draft = defaultSimpleDraft()
  draft.modules.hosts = 'draft.invalid: 192.0.2.5\n'
  return store.saveDraft(
    { expectedRevision: '', draft, bindings: [], configurationRevision: '' },
    () => {}
  )
}
function marker(): PublicationMarker {
  return {
    version: 1,
    operationId: receipt.operationId,
    phase: 'intent',
    expectedSimpleRevision: '',
    publishedRevision: 0,
    inputDigest: receipt.inputDigest,
    outputSHA256: receipt.profile.sha256,
    profileNameSHA256: 'c'.repeat(64),
    publishedPayloadSHA256: 'd'.repeat(64),
    profile: null,
    postimageSHA256: null,
    createdAt: 1000
  }
}
describe('Publication receipt and shared strict CAS file', () => {
  it('keeps old receipt-less v1 and first missing journal inert', async () =>
    fixture(async ({ store, journal }) => {
      const missing = await store.read()
      expect(missing.exists).toBe(false)
      expect(Object.hasOwn(missing.document, 'publication')).toBe(false)
      expect(await journal.read()).toEqual({ value: null, revision: '', exists: false })
      await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(journal.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }))
  it('promotes only current draft and increments once; later draft saves preserve published receipt', async () =>
    fixture(async ({ store }) => {
      const before = await seed(store),
        predicted = publicationPostimage(before, receipt),
        recheck = vi.fn(async () => {})
      const after = await store.promotePublished(
        { expectedRevision: before.revision, receipt },
        recheck,
        () => {}
      )
      expect(after).toEqual(predicted)
      expect(after.document.state.revision).toBe(1)
      expect(after.document.state.published).toEqual(before.document.state.draft)
      expect(after.document.state.draft).toEqual(before.document.state.draft)
      expect(after.document.publication).toEqual(receipt)
      expect(recheck).toHaveBeenCalledOnce()
      await expect(
        store.promotePublished({ expectedRevision: before.revision, receipt }, recheck, () => {})
      ).rejects.toMatchObject({ code: 'stale' })
      const draft = structuredClone(after.document.state.draft)
      draft.modules.hosts = '{}\n'
      const edited = await store.saveDraft(
        { expectedRevision: after.revision, draft, bindings: [], configurationRevision: '' },
        () => {}
      )
      expect(edited.revision).not.toBe(after.revision)
      expect(edited.document.publication).toEqual(receipt)
      expect(edited.document.state.revision).toBe(1)
      expect(edited.document.state.published).toEqual(after.document.state.published)
    }))
  it('rechecks async authority and old bytes after the last callback before rename', async () =>
    fixture(async ({ store }) => {
      const before = await seed(store),
        raw = await readFile(store.path)
      await expect(
        store.promotePublished(
          { expectedRevision: before.revision, receipt },
          async () => {
            await writeFile(store.path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]))
          },
          () => {}
        )
      ).rejects.toMatchObject({ code: 'stale' })
      expect(await readFile(store.path)).toEqual(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw])
      )
      expect((await store.read()).document.publication).toBeUndefined()
    }))
  it('does not rename after the final synchronous owner is retired', async () =>
    fixture(async ({ store }) => {
      const before = await seed(store),
        raw = await readFile(store.path)
      let live = true
      await expect(
        store.promotePublished(
          { expectedRevision: before.revision, receipt },
          async () => {
            live = false
          },
          () => {
            if (!live) throw new Error('retired')
          }
        )
      ).rejects.toThrow('retired')
      expect(await readFile(store.path)).toEqual(raw)
    }))
  it('can recognize the exact postimage after a post-rename sync failure', async () =>
    fixture(async ({ store }) => {
      const before = await seed(store),
        expected = publicationPostimage(before, receipt)
      const original = SubscriptionFiles.prototype.sync
      vi.spyOn(SubscriptionFiles.prototype, 'sync').mockImplementationOnce(async function (
        this: SubscriptionFiles,
        directory
      ) {
        await original.call(this, directory)
        throw new Error('synthetic-sync-failure')
      })
      await expect(
        store.promotePublished(
          { expectedRevision: before.revision, receipt },
          async () => {},
          () => {}
        )
      ).rejects.toMatchObject({ code: 'uncertain' })
      expect(await store.read()).toEqual(expected)
    }))
  it('preflights expanded whole postimage budget and revision overflow before any write', async () =>
    fixture(async ({ store }) => {
      const draft = defaultSimpleDraft()
      for (const key of ['proxies', 'hosts', 'dns', 'sniffer'] as const)
        draft.modules[key] = 'x'.repeat(128 * 1024)
      const before = await store.saveDraft(
        { expectedRevision: '', draft, bindings: [], configurationRevision: '' },
        () => {}
      )
      const raw = await readFile(store.path)
      expect(() => publicationPostimage(before, receipt)).toThrow('invalid')
      await expect(
        store.promotePublished(
          { expectedRevision: before.revision, receipt },
          async () => {},
          () => {}
        )
      ).rejects.toMatchObject({ code: 'invalid' })
      expect(await readFile(store.path)).toEqual(raw)
      const overflow = document({
        ...before.document,
        state: { ...before.document.state, revision: Number.MAX_SAFE_INTEGER }
      })
      expect(() => publicationPostimage({ ...before, document: overflow }, receipt)).toThrow(
        'invalid'
      )
    }))
  it('still rejects persisted array source modes in the model4c baseline', () => {
    const d = defaultSimpleDraft()
    expect(() =>
      document({
        version: 1,
        state: {
          version: 2,
          revision: 0,
          draft: {
            ...d,
            sources: [
              {
                id: 'bad',
                name: 'Bad',
                mode: ['extract'],
                prefix: '',
                interval: 0,
                proxies: [],
                profileId: receipt.profile.id
              }
            ]
          },
          published: d
        },
        bindings: {
          draft: [{ id: 'bad', profile: receipt.profile, profileRevision: 'a'.repeat(64) }],
          published: []
        },
        configurationRevision: { draft: '', published: '' }
      })
    ).toThrow('invalid')
  })
})
describe('Bounded fixed publication journal', () => {
  it('records intent, exact known profile and complete terminal without raw content', async () =>
    fixture(async ({ journal }) => {
      const none = await journal.read(),
        intent = await journal.write(none.revision, marker(), () => {})
      const saved = await journal.write(
        intent.revision,
        {
          ...intent.value,
          phase: 'profile-saved',
          profile: receipt.profile,
          postimageSHA256: 'e'.repeat(64)
        },
        () => {}
      )
      const complete = await journal.write(
        saved.revision,
        { ...saved.value, phase: 'complete' },
        () => {}
      )
      expect(complete.value?.profile).toEqual(receipt.profile)
      expect(complete.revision).toBe(hash(await readFile(journal.path, 'utf8')))
      const next = await journal.write(
        complete.revision,
        { ...marker(), operationId: '33333333-3333-4333-8333-333333333333' },
        () => {}
      )
      expect(next.value?.phase).toBe('intent')
    }))
  it('treats an unexpectedly lost existing lease as uncertain and never recreates it', async () =>
    fixture(async ({ journal }) => {
      const intent = await journal.write('', marker(), () => {})
      await unlink(journal.path)
      await expect(
        journal.write(intent.revision, { ...marker(), phase: 'abandoned' }, () => {})
      ).rejects.toMatchObject({ code: 'uncertain' })
      expect(await journal.read()).toEqual({ value: null, revision: '', exists: false })
    }))
  it('rejects extra/raw-secret fields, invalid phase arrays and hard links without repair', async () =>
    fixture(async ({ journal }) => {
      await expect(
        journal.write('', { ...marker(), raw: 'synthetic-secret' }, () => {})
      ).rejects.toMatchObject({ code: 'invalid' })
      await expect(
        journal.write('', { ...marker(), phase: ['intent'] }, () => {})
      ).rejects.toMatchObject({ code: 'invalid' })
      const intent = await journal.write('', marker(), () => {})
      await link(journal.path, journal.path + '.linked')
      await expect(journal.read()).rejects.toMatchObject({ code: 'invalid' })
      expect(hash(await readFile(journal.path, 'utf8'))).toBe(intent.revision)
    }))
  it('only abandons exact same operation facts and keeps the old bytes on mismatch', async () =>
    fixture(async ({ journal }) => {
      const intent = await journal.write('', marker(), () => {}),
        raw = await readFile(journal.path)
      await expect(
        journal.write(
          intent.revision,
          { ...marker(), phase: 'abandoned', inputDigest: 'f'.repeat(64) },
          () => {}
        )
      ).rejects.toMatchObject({ code: 'uncertain' })
      expect(await readFile(journal.path)).toEqual(raw)
      const abandoned = await journal.write(
        intent.revision,
        { ...marker(), phase: 'abandoned' },
        () => {}
      )
      expect(abandoned.value?.phase).toBe('abandoned')
    }))
})
