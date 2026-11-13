import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { defaultSimpleDraft } from '../../../../shared/simple-config'
import { defaultEditDocument } from '../../../../shared/relay/configuration-edit'
import { SimpleDraftStore } from '../../../../main/relay/simple/store'
import { createSimpleDraftService } from '../../../../main/relay/simple/service'
import { createPinnedSimpleCapture } from '../../../../main/relay/simple/capture'
import { createPinnedSimpleBindingReader } from '../../../../main/relay/simple/bindings'
import { createPinnedSimpleConfigurationReader } from '../../../../main/relay/simple/configuration'
import { createSimpleHandlers } from '../../../../main/relay/simple/handlers'
import { ProfileStore } from '../../../../main/relay/profiles/store'
import { createSimplePanelController, hasUnsavedModules } from './simple-panel-state'
import { SimpleConfigurationPanel } from './simple-configuration-panel'
import { readConfigurationSnapshot } from './simple-configuration-state'

const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((done) => {
    release = done
  })
  return { promise, release }
}
async function fixture(home: string) {
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    store = new SimpleDraftStore(context),
    profiles = new ProfileStore(context)
  await store.saveDraft(
    { expectedRevision: '', draft: defaultSimpleDraft(), bindings: [], configurationRevision: '' },
    () => {}
  )
  const selected = await profiles.save(
      'Local',
      'proxies:\n  - {name: Local, type: http, server: 192.0.2.1, port: 8080}\n'
    ),
    simple = createSimpleDraftService({
      store,
      capture: createPinnedSimpleCapture(context),
      bindingReader: createPinnedSimpleBindingReader(context),
      configurationReader: createPinnedSimpleConfigurationReader(context)
    })
  const handlers = createSimpleHandlers({
    service: simple,
    profiles: {
      prepareGenerated: vi.fn(async () => {
        throw new Error('Not used')
      })
    },
    authorize: () => ({ isCurrent: () => true }),
    assertIdle: () => {}
  })
  const read = vi.fn(handlers.relaySimpleReadConfigurationBinding),
    save = vi.fn(handlers.relaySimpleSaveConfigurationBinding),
    busy: boolean[] = [],
    releases: (() => void)[] = []
  const controller = createSimplePanelController({
      api: handlers,
      configuration: {
        relaySimpleReadConfigurationBinding: read,
        relaySimpleSaveConfigurationBinding: save
      },
      sources: {
        relaySimpleReadSourceBindings: handlers.relaySimpleReadSourceBindings,
        relaySimpleSaveSourceBinding: handlers.relaySimpleSaveSourceBinding,
        listProfiles: () => profiles.list(),
        listSources: async () => ({ sources: [], incomplete: 0, warnings: [] })
      },
      saveProfile: vi.fn(async () => ({ status: 'cancelled' as const, warnings: [] })),
      isCurrent: () => true,
      onBusy: (value) => busy.push(value)
    }),
    path = join(context.stateRoot, 'Configuration/configuration-edit.json')
  const config = async () => {
    const value = defaultEditDocument()
    value.controlled = {
      dns: { enable: false },
      hosts: { 'private.invalid': '192.0.2.5' },
      'geodata-mode': false
    }
    await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  }
  return { store, simple, controller, read, save, busy, releases, config, path, selected }
}
async function own(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), 'relay-config-panel-test-'))
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    f = await fixture(await realpath(temporary))
    await run(f)
  } finally {
    for (const release of f?.releases ?? []) release()
    f?.controller.deactivate()
    f?.simple.clear()
    await f?.simple.requestClose()
    await rm(temporary, { recursive: true, force: true })
    expect(existsSync(temporary)).toBe(false)
  }
}
it('only reads after explicit action and renders metadata/keys without private values or input controls', async () => {
  await own(async (f) => {
    await f.config()
    expect(f.read).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
    await f.controller.readConfigurationBinding()
    const html = renderToStaticMarkup(
      createElement(SimpleConfigurationPanel, {
        state: f.controller.getSnapshot(),
        controller: f.controller,
        busy: false
      })
    )
    expect(html).toContain('明确采用此候选版本')
    expect(html).toContain('geodata-mode')
    expect(html).not.toContain('192.0.2.5')
    expect(html).not.toContain('private.invalid')
    expect(html).not.toMatch(/<(input|textarea|select)/u)
    expect(f.save).not.toHaveBeenCalled()
  })
})
it('real bind and unpin preserve dirty module text and keep only same-baseline source/config/module snapshots aligned', async () => {
  await own(async (f) => {
    await f.config()
    await f.controller.read()
    await f.controller.readSources()
    f.controller.setText('UNSAVED_GENERAL')
    await f.controller.readConfigurationBinding()
    await f.controller.bindViewedConfiguration()
    expect(hasUnsavedModules(f.controller.getSnapshot())).toBe(true)
    expect(f.controller.getSnapshot().modules?.general).toBe('UNSAVED_GENERAL')
    expect(f.controller.getSnapshot().sourceSnapshot?.revision).toBe(
      f.controller.getSnapshot().metadata?.revision
    )
    f.controller.selectModule('hosts')
    f.controller.setText('{}\n# explicitly saved\n')
    await f.controller.saveModule()
    expect(f.controller.getSnapshot().configurationSnapshot?.revision).toBe(
      f.controller.getSnapshot().metadata?.revision
    )
    expect(f.controller.getSnapshot().sourceSnapshot?.revision).toBe(
      f.controller.getSnapshot().metadata?.revision
    )
    f.controller.newSource()
    f.controller.chooseSourceProfile(f.selected.id + ':' + f.selected.sha256)
    f.controller.updateSourceForm({ name: 'Extract local', intervalText: '17' })
    await f.controller.saveSource()
    const pinned = f.controller.getSnapshot().configurationSnapshot?.configurationRevision
    expect(pinned).toMatch(/^[a-f0-9]{64}$/u)
    expect(f.controller.getSnapshot().configurationSnapshot?.revision).toBe(
      f.controller.getSnapshot().sourceSnapshot?.revision
    )
    expect(f.controller.getSnapshot().modules?.general).toBe('UNSAVED_GENERAL')
    await f.controller.unbindConfiguration()
    const disk = await f.store.read()
    expect(disk.document.configurationRevision.draft).toBe('')
    expect(disk.document.state.draft.sources).toHaveLength(1)
    expect(disk.document.state.draft.modules.hosts).toBe('{}\n# explicitly saved\n')
    expect(f.controller.getSnapshot().sourceSnapshot?.sharedConfigurationPinned).toBe(false)
    expect(hasUnsavedModules(f.controller.getSnapshot())).toBe(true)
  })
})
it('protects a divergent module baseline through configuration save until explicit reread', async () => {
  await own(async (f) => {
    await f.config()
    await f.controller.read()
    f.controller.setText('KEEP_OLD_BASELINE')
    const old = await f.store.read()
    await f.simple.saveModule(
      { expectedRevision: old.revision, module: 'hosts', text: '{}\n# external\n' },
      { isCurrent: () => true }
    )
    await f.controller.readConfigurationBinding()
    expect(f.controller.getSnapshot().moduleRevisionStale).toBe(true)
    await f.controller.bindViewedConfiguration()
    const bytes = await readFile(f.store.path)
    await f.controller.saveModule()
    await f.controller.preview()
    expect(await readFile(f.store.path)).toEqual(bytes)
    expect(f.controller.getSnapshot().modules?.general).toBe('KEEP_OLD_BASELINE')
    expect(f.controller.getSnapshot().moduleRevisionStale).toBe(true)
    await f.controller.read()
    expect(f.controller.getSnapshot().moduleRevisionStale).toBe(false)
  })
})
it('keeps the viewed exactSHA when the current configuration changes and requires another explicit view', async () => {
  await own(async (f) => {
    await f.config()
    await f.controller.readConfigurationBinding()
    await writeFile(f.path, JSON.stringify(defaultEditDocument()), { mode: 0o600 })
    const before = await readFile(f.store.path)
    await f.controller.bindViewedConfiguration()
    expect(await readFile(f.store.path)).toEqual(before)
    expect(f.controller.getSnapshot().configurationSnapshot).toBeUndefined()
    expect(f.read).toHaveBeenCalledOnce()
  })
})
it('supports same-pin no-op and explicit unpin despite bad current config, without changing its bytes', async () => {
  await own(async (f) => {
    await f.config()
    await f.controller.readConfigurationBinding()
    await f.controller.bindViewedConfiguration()
    const before = await readFile(f.store.path)
    await f.controller.bindViewedConfiguration()
    expect(await readFile(f.store.path)).toEqual(before)
    await writeFile(f.path, '{broken', { mode: 0o600 })
    await f.controller.readConfigurationBinding()
    expect(f.controller.getSnapshot().configurationSnapshot?.candidate.status).toBe('unavailable')
    await f.controller.unbindConfiguration()
    expect((await f.store.read()).document.configurationRevision.draft).toBe('')
    expect(await readFile(f.path, 'utf8')).toBe('{broken')
  })
})
it('holds busy until late metadata settles and suppresses results after editor invalidation', async () => {
  await own(async (f) => {
    const late = gate()
    f.releases.push(late.release)
    const value = await f.read()
    f.read.mockImplementationOnce(async () => {
      await late.promise
      return value
    })
    const pending = f.controller.readConfigurationBinding()
    f.controller.invalidate()
    expect(f.controller.getSnapshot().pending).toBe(true)
    await f.controller.readSources()
    late.release()
    await pending
    expect(f.controller.getSnapshot().configurationSnapshot).toBeUndefined()
    expect(f.controller.getSnapshot().sourceSnapshot).toBeUndefined()
    expect(f.controller.getSnapshot().pending).toBe(false)
    expect(f.busy).toEqual([true, false])
  })
})
it('preserves dirty text and blocks writes after uncertain pin receipt until explicit recovery', async () => {
  await own(async (f) => {
    await f.config()
    await f.controller.read()
    f.controller.setText('UNSAVED_BEFORE_UNCERTAIN')
    await f.controller.readConfigurationBinding()
    f.save.mockResolvedValueOnce({ status: 'uncertain' })
    await f.controller.bindViewedConfiguration()
    expect(f.controller.getSnapshot().needsRecovery).toBe(true)
    expect(f.controller.getSnapshot().modules?.general).toBe('UNSAVED_BEFORE_UNCERTAIN')
    const calls = f.save.mock.calls.length
    await f.controller.unbindConfiguration()
    await f.controller.saveModule()
    expect(f.save).toHaveBeenCalledTimes(calls)
    await f.controller.recover()
    expect(f.controller.getSnapshot().modules).toBeUndefined()
    expect(f.controller.getSnapshot().configurationSnapshot).toBeUndefined()
  })
})
it('rejects private response fields, unknown shared keys and duplicate keys rather than projecting them into state', () => {
  const base = {
    exists: false,
    revision: '',
    publishedRevision: 0,
    dirty: false,
    sharedConfigurationPinned: false,
    configurationRevision: '',
    candidate: { status: 'available', configurationRevision: 'a'.repeat(64), keys: ['dns'] }
  }
  expect(() => readConfigurationSnapshot({ ...base, private: 'SECRET' })).toThrow()
  expect(() =>
    readConfigurationSnapshot({ ...base, candidate: { ...base.candidate, keys: ['tun'] } })
  ).toThrow()
  expect(() =>
    readConfigurationSnapshot({ ...base, candidate: { ...base.candidate, keys: ['dns', 'dns'] } })
  ).toThrow()
})
