import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { defaultSimpleDraft } from '../../../shared/simple-config'
import { configurationEditDocument } from '../../../shared/relay/configuration-edit'
import { ProfileStore } from '../profiles/store'
import { createProfileService } from '../profiles/service'
import { SubscriptionSourceStore } from '../subscriptions/source-store'
import { createPinnedSimpleCapture } from './capture'
import { SimpleDraftStore } from './store'
import { createSimpleDraftService } from './service'
import { document, hash, SimpleFailure, type SimpleBinding } from './model'

const providerOnly =
  'proxy-providers:\n  Remote:\n    type: http\n    url: https://nested.invalid/nodes.yaml\n    interval: 3600\n'
const sourceURL = 'https://source.invalid/list.yaml'
const selectSource = (value: { id: string; revision: string }) => ({
  id: value.id,
  revision: value.revision
})

async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  options: { http?: boolean; configuration?: boolean } = {}
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'relay-simple-service-test-'))
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined
  try {
    fixture = await createFixture(await realpath(temporary), options)
    await run(fixture)
  } finally {
    try {
      fixture?.simple.clear()
      await fixture?.simple.requestClose()
      await fixture?.profilesService.whenIdle()
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
async function createFixture(home: string, options: { http?: boolean; configuration?: boolean }) {
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  const profiles = new ProfileStore(context),
    sources = new SubscriptionSourceStore(context),
    store = new SimpleDraftStore(context)
  const body = options.http
    ? providerOnly
    : JSON.stringify({
        proxies: [{ name: 'Original', type: 'http', server: '192.0.2.1', port: 8080 }]
      })
  const original = await profiles.save('Original', body),
    selection = { id: original.id, sha256: original.sha256 },
    held = await profiles.read(selection)
  let sourceInfo = options.http
    ? await sources.create({ name: 'Bound source', url: sourceURL, proxyPort: 18191 })
    : undefined
  if (sourceInfo)
    sourceInfo = await sources.commit(selectSource(sourceInfo), async () => ({
      profile: selection
    }))
  const draft = defaultSimpleDraft()
  draft.sources = [
    {
      id: 'bound',
      name: 'Bound source',
      mode: options.http ? 'http' : 'extract',
      prefix: '',
      interval: 3600,
      proxies: [],
      profileId: selection.id
    }
  ]
  const bindings: SimpleBinding[] = [
    {
      id: 'bound',
      profile: selection,
      profileRevision: held.revision,
      ...(sourceInfo ? { source: selectSource(sourceInfo) } : {})
    }
  ]
  const configurationPath = join(context.stateRoot, 'Configuration/configuration-edit.json')
  const configText = (ip: string) =>
    JSON.stringify(
      configurationEditDocument({
        globalOverrides: [],
        profileOverrides: [],
        controlled: { hosts: { 'pinned.invalid': ip }, 'geodata-mode': false }
      })
    ) + '\n'
  const initialConfig = options.configuration ? configText('192.0.2.10') : undefined
  if (initialConfig) {
    await mkdir(dirname(configurationPath), { recursive: true, mode: 0o700 })
    await writeFile(configurationPath, initialConfig, { mode: 0o600, flag: 'wx' })
  }
  await store.saveDraft(
    {
      expectedRevision: '',
      draft,
      bindings,
      configurationRevision: initialConfig ? hash(initialConfig) : ''
    },
    () => {}
  )
  let live = true
  const owner = { isCurrent: () => live },
    simple = createSimpleDraftService({ store, capture: createPinnedSimpleCapture(context) })
  const adapters = {
    pick: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    save: vi.fn((name: string, text: string) => profiles.save(name, text)),
    list: () => profiles.list()
  }
  const profilesService = createProfileService(adapters)
  return {
    store,
    simple,
    profiles,
    profilesService,
    adapters,
    sources,
    sourceInfo,
    owner,
    selection,
    body,
    configurationPath,
    configText,
    revoke: () => {
      live = false
    }
  }
}
async function prepare(f: Awaited<ReturnType<typeof createFixture>>) {
  const view = await f.simple.readEditableDraft(f.owner),
    preview = await f.simple.preview(view.revision, f.owner)
  expect(preview.valid).toBe(true)
  const source = await f.simple.prepareProfile(
    { expectedRevision: view.revision, previewSHA256: preview.yamlSHA256, name: 'Simple copy' },
    f.owner
  )
  const report = await f.profilesService.prepareGenerated(source)
  return { view, preview, source, report }
}

describe('Simple file CAS, pinned capture and inactive-profile handoff', () => {
  it('CAS-saves one module, previews and confirms one inactive copy without changing published state or the original profile', async () => {
    await withFixture(async (f) => {
      const initial = await f.store.read(),
        published = structuredClone(initial.document.state.published)
      published.modules.hosts = '# published-fixture-marker\n{}\n'
      const seeded = document({
        ...initial.document,
        state: { ...initial.document.state, revision: 7, published },
        configurationRevision: {
          ...initial.document.configurationRevision,
          published: 'b'.repeat(64)
        }
      })
      // Seed only this owned fixture; saving an inactive copy must never publish it.
      await writeFile(f.store.path, JSON.stringify(seeded, null, 2) + '\n', { mode: 0o600 })
      const before = await f.store.read(),
        view = await f.simple.readEditableDraft(f.owner)
      expect(view.publishedRevision).toBe(7)
      expect(before.document.state.published.modules.hosts).toContain('published-fixture-marker')
      const saved = await f.simple.saveModule(
        { expectedRevision: view.revision, module: 'hosts', text: 'edited.invalid: 192.0.2.9\n' },
        f.owner
      )
      expect(saved.revision).not.toBe(view.revision)
      const after = await f.store.read()
      expect(after.document.state.published).toEqual(before.document.state.published)
      expect(after.document.state.revision).toBe(before.document.state.revision)
      expect(after.document.state.revision).toBe(7)
      expect(after.document.bindings).toEqual(before.document.bindings)
      expect(after.document.configurationRevision).toEqual(before.document.configurationRevision)
      await expect(
        f.simple.saveModule(
          { expectedRevision: view.revision, module: 'hosts', text: '{}' },
          f.owner
        )
      ).rejects.toMatchObject({ code: 'stale' })
      const p = await prepare(f),
        result = await f.profilesService.save({ evidenceId: p.report.evidenceId })
      expect(result.status).toBe('saved')
      expect(f.adapters.confirm).toHaveBeenCalledOnce()
      expect(f.adapters.save).toHaveBeenCalledOnce()
      if (!result.profile) throw new Error('Missing saved copy')
      expect(result.profile.id).not.toBe(f.selection.id)
      expect(
        (await f.profiles.read({ id: result.profile.id, sha256: result.profile.sha256 })).text
      ).toBe(p.source.text)
      expect((await f.profiles.read(f.selection)).text).toBe(f.body)
      expect((await f.store.read()).document).toEqual(after.document)
      expect(p.report.inspection).toMatchObject({ active: false, coreCompatibility: 'notVerified' })
    })
  })
  it('rejects a module save with the pre-BOM file revision and preserves every changed file byte', async () => {
    await withFixture(async (f) => {
      const before = await f.store.read(),
        view = await f.simple.readEditableDraft(f.owner),
        raw = await readFile(f.store.path),
        changedBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw])
      await writeFile(f.store.path, changedBytes, { mode: 0o600 })
      const current = await f.store.read()
      expect(current.document).toEqual(before.document)
      expect(current.revision).toBe(createHash('sha256').update(changedBytes).digest('hex'))
      expect(current.revision).not.toBe(view.revision)
      await expect(
        f.simple.saveModule(
          { expectedRevision: view.revision, module: 'hosts', text: 'new.invalid: 192.0.2.8\n' },
          f.owner
        )
      ).rejects.toMatchObject({ code: 'stale' })
      expect(await readFile(f.store.path)).toEqual(changedBytes)
      expect((await f.store.read()).document).toEqual(before.document)
      expect(f.adapters.save).not.toHaveBeenCalled()
    })
  })
  it.each(['before', 'during'] as const)(
    'revokes owner %s confirmation with no save admission or published change',
    async (when) => {
      await withFixture(async (f) => {
        const before = await f.store.read(),
          p = await prepare(f)
        if (when === 'before') f.revoke()
        else
          f.adapters.confirm.mockImplementationOnce(async () => {
            f.revoke()
            return true
          })
        expect((await f.profilesService.save({ evidenceId: p.report.evidenceId })).status).toBe(
          'failed'
        )
        expect(f.adapters.confirm).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
        expect(f.adapters.save).not.toHaveBeenCalled()
        expect((await f.store.read()).document).toEqual(before.document)
        expect((await f.profiles.list()).profiles).toHaveLength(1)
      })
    }
  )
  it('does not admit save if ProfileService.clear retires the proof during readAgain', async () => {
    await withFixture(async (f) => {
      const p = await prepare(f),
        before = await f.store.read()
      const source = {
        ...p.source,
        readAgain: async () => {
          const text = await p.source.readAgain()
          f.profilesService.clear()
          return text
        }
      }
      const report = await f.profilesService.prepareGenerated(source)
      expect((await f.profilesService.save({ evidenceId: report.evidenceId })).status).toBe(
        'failed'
      )
      expect(f.adapters.confirm).toHaveBeenCalledOnce()
      expect(f.adapters.save).not.toHaveBeenCalled()
      expect((await f.store.read()).document).toEqual(before.document)
    })
  })
  it('keeps a stale nonempty configuration pin through explicit read/recover and rejects the old prepared copy before confirmation', async () => {
    await withFixture(
      async (f) => {
        const before = await f.store.read(),
          p = await prepare(f)
        await writeFile(f.configurationPath, f.configText('192.0.2.11'), { mode: 0o600 })
        expect((await f.profilesService.save({ evidenceId: p.report.evidenceId })).status).toBe(
          'failed'
        )
        expect(f.adapters.confirm).not.toHaveBeenCalled()
        expect(f.adapters.save).not.toHaveBeenCalled()
        expect((await f.simple.readEditableDraft(f.owner)).revision).toBe(before.revision)
        await f.simple.recover(f.owner)
        expect((await f.store.read()).document).toEqual(before.document)
        await expect(f.simple.preview(before.revision, f.owner)).rejects.toBeInstanceOf(
          SimpleFailure
        )
      },
      { configuration: true }
    )
  })
  it('supports a real provider-only HTTP source version, while a later source revision invalidates its prepared copy before confirmation', async () => {
    await withFixture(
      async (f) => {
        const before = await f.store.read(),
          p = await prepare(f)
        expect(p.source.text).toContain(sourceURL)
        expect((await f.profilesService.save({ evidenceId: p.report.evidenceId })).status).toBe(
          'saved'
        )
        expect((await f.store.read()).document).toEqual(before.document)
        f.adapters.confirm.mockClear()
        f.adapters.save.mockClear()
        const next = await prepare(f)
        if (!f.sourceInfo) throw new Error('Missing real source version')
        await f.sources.commit(selectSource(f.sourceInfo), async () => ({ profile: f.selection }))
        expect((await f.profilesService.save({ evidenceId: next.report.evidenceId })).status).toBe(
          'failed'
        )
        expect(f.adapters.confirm).not.toHaveBeenCalled()
        expect(f.adapters.save).not.toHaveBeenCalled()
        expect((await f.store.read()).document).toEqual(before.document)
      },
      { http: true }
    )
  })
})
