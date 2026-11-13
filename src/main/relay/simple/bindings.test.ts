import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { defaultSimpleDraft } from '../../../shared/simple-config'
import { defaultEditDocument } from '../../../shared/relay/configuration-edit'
import type { RelaySimpleSourceValue } from '../../../shared/relay/simple-sources'
import { ProfileStore } from '../profiles/store'
import { profileHash } from '../profiles/source'
import { SubscriptionSourceStore } from '../subscriptions/source-store'
import { SimpleDraftStore } from './store'
import { createSimpleDraftService } from './service'
import { createPinnedSimpleCapture } from './capture'
import { createPinnedSimpleBindingReader } from './bindings'
import { createPinnedSimpleConfigurationReader } from './configuration'
import { document } from './model'

const selectSource = (source: { id: string; revision: string }) => ({
  id: source.id,
  revision: source.revision
})
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((done) => {
    release = done
  })
  return { promise, release }
}
async function fixture(home: string, seed: boolean) {
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    store = new SimpleDraftStore(context),
    profiles = new ProfileStore(context),
    sources = new SubscriptionSourceStore(context)
  const old = await profiles.save(
      'Historical',
      'proxies:\n  - {name: Old, type: http, server: 192.0.2.1, port: 8080}\n'
    ),
    selected = { id: old.id, sha256: old.sha256 },
    next = await profiles.save(
      'Current',
      'proxy-providers:\n  Remote: {type: http, url: https://nested.invalid/nodes}\n'
    )
  let info = await sources.create(
    { name: 'Origin', url: 'https://source.invalid/list?token=PRIVATE_QUERY', proxyPort: 18191 },
    {
      headers: { authorization: 'PRIVATE_AUTH' },
      ageSecretKey: '',
      redirects: 'none',
      schedule: { kind: 'manual' },
      useServerInterval: false
    }
  )
  info = await sources.commit(selectSource(info), async () => ({ profile: selected }))
  info = await sources.commit(selectSource(info), async () => ({
    profile: { id: next.id, sha256: next.sha256 }
  }))
  if (seed) {
    await store.saveDraft(
      {
        expectedRevision: '',
        draft: defaultSimpleDraft(),
        bindings: [],
        configurationRevision: ''
      },
      () => {}
    )
    const initial = await store.read(),
      published = structuredClone(initial.document.state.published)
    published.modules.hosts = '# preserved-published\n{}\n'
    await writeFile(
      store.path,
      JSON.stringify(
        document({
          ...initial.document,
          state: { ...initial.document.state, revision: 7, published },
          configurationRevision: { draft: '', published: 'b'.repeat(64) }
        }),
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
  }
  let live = true
  const actualConfiguration = createPinnedSimpleConfigurationReader(context),
    reader = {
      inspectCurrent: vi.fn(actualConfiguration.inspectCurrent),
      readPinned: vi.fn(actualConfiguration.readPinned)
    },
    bindingReader = vi.fn(createPinnedSimpleBindingReader(context)),
    simple = createSimpleDraftService({
      store,
      capture: createPinnedSimpleCapture(context),
      bindingReader,
      configurationReader: reader
    }),
    owner = { isCurrent: () => live },
    releases: (() => void)[] = []
  const configPath = join(context.stateRoot, 'Configuration/configuration-edit.json')
  const config = async (address = '192.0.2.5') => {
    const text =
      JSON.stringify({
        ...defaultEditDocument(),
        controlled: {
          hosts: { 'private.invalid': address },
          dns: { enable: false },
          'geodata-mode': false
        }
      }) + '\n'
    await writeFile(configPath, text, { mode: 0o600 })
    return profileHash(text)
  }
  const value = (): RelaySimpleSourceValue => ({
    profile: selected,
    source: selectSource(info),
    name: 'Bound',
    mode: 'http',
    prefix: '',
    interval: 0,
    providerOptions: { 'size-limit': 0, override: { udp: false } }
  })
  const add = async () =>
    simple.saveSourceBinding(
      { action: 'add', expectedRevision: (await store.read()).revision, value: value() },
      owner
    )
  const pin = async (configurationRevision: string) =>
    simple.saveConfigurationBinding(
      { expectedRevision: (await store.read()).revision, configurationRevision },
      owner
    )
  return {
    context,
    store,
    profiles,
    sources,
    selected,
    info,
    configPath,
    reader,
    bindingReader,
    simple,
    owner,
    releases,
    config,
    value,
    add,
    pin,
    revoke: () => {
      live = false
    }
  }
}
async function own(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, seed = true) {
  const temporary = await mkdtemp(join(tmpdir(), 'relay-simple-binding-test-'))
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    f = await fixture(await realpath(temporary), seed)
    await run(f)
  } finally {
    for (const release of f?.releases ?? []) release()
    f?.simple.clear()
    await f?.simple.requestClose()
    await rm(temporary, { recursive: true, force: true })
    expect(existsSync(temporary)).toBe(false)
  }
}
it('binds explicit historical profile/current source and false0 options while preserving modules, pins and published7', async () => {
  await own(async (f) => {
    const current = await f.store.read()
    await f.store.saveDraft(
      {
        expectedRevision: current.revision,
        draft: current.document.state.draft,
        bindings: [],
        configurationRevision: 'c'.repeat(64)
      },
      () => {}
    )
    const before = await f.store.read(),
      view = await f.add(),
      after = await f.store.read(),
      binding = after.document.bindings.draft[0]
    expect(f.info.versions.at(-1)?.profile).not.toEqual(f.selected)
    expect(binding.profile).toEqual(f.selected)
    expect(binding.profileRevision).toBe((await f.profiles.read(f.selected)).revision)
    expect(binding.source).toEqual(selectSource(f.info))
    expect(after.document.state.draft.modules).toEqual(before.document.state.draft.modules)
    expect(after.document.state.published).toEqual(before.document.state.published)
    expect(after.document.state.revision).toBe(7)
    expect(after.document.bindings.published).toEqual(before.document.bindings.published)
    expect(after.document.configurationRevision).toEqual(before.document.configurationRevision)
    expect(view.sources[0]).toMatchObject({
      prefix: '',
      interval: 0,
      providerOptions: { 'size-limit': 0, override: { udp: false } }
    })
    expect(JSON.stringify(view)).not.toContain('PRIVATE_')
    expect(JSON.stringify(view)).not.toContain('profileRevision')
  })
})
it('owner-only loss after real ProfileStore await stops following SourceStore reads before any write', async () => {
  await own(async (f) => {
    const original = ProfileStore.prototype.read,
      entered = gate(),
      released = gate(),
      before = await readFile(f.store.path)
    f.releases.push(released.release)
    const profileSpy = vi.spyOn(ProfileStore.prototype, 'read').mockImplementation(async function (
        this: ProfileStore,
        selection
      ) {
        const result = await original.call(this, selection)
        entered.release()
        await released.promise
        return result
      }),
      sourceSpy = vi.spyOn(SubscriptionSourceStore.prototype, 'read')
    try {
      const pending = f.add(),
        rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
      await entered.promise
      f.revoke()
      released.release()
      await rejected
      expect(sourceSpy).not.toHaveBeenCalled()
      expect(await readFile(f.store.path)).toEqual(before)
    } finally {
      profileSpy.mockRestore()
      sourceSpy.mockRestore()
    }
  })
})
it('rejects array mode, credential/unknown options and forged ProfileRevision before selected reads or writes', async () => {
  await own(async (f) => {
    const before = await readFile(f.store.path),
      expectedRevision = (await f.store.read()).revision
    for (const value of [
      { ...f.value(), mode: ['http'] },
      { ...f.value(), profileRevision: 'a'.repeat(64) },
      { ...f.value(), providerOptions: { header: { authorization: 'PRIVATE_AUTH' } } },
      { ...f.value(), providerOptions: { 'health-check': { url: 'https://check.invalid' } } }
    ])
      await expect(
        f.simple.saveSourceBinding({ action: 'add', expectedRevision, value }, f.owner)
      ).rejects.toMatchObject({ code: 'invalid' })
    expect(f.bindingReader).not.toHaveBeenCalled()
    expect(await readFile(f.store.path)).toEqual(before)
  })
})
it('uses exact raw file CAS and never overwrites a BOM-only change with an old source request', async () => {
  await own(async (f) => {
    const before = await f.store.read(),
      bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(f.store.path)])
    await writeFile(f.store.path, bytes, { mode: 0o600 })
    await expect(
      f.simple.saveSourceBinding(
        { action: 'add', expectedRevision: before.revision, value: f.value() },
        f.owner
      )
    ).rejects.toMatchObject({ code: 'stale' })
    expect(f.bindingReader).not.toHaveBeenCalled()
    expect(await readFile(f.store.path)).toEqual(bytes)
  })
})
it('explicitly pins false shared data without resolving unrelated sources and same-pin is a validated no-op', async () => {
  await own(async (f) => {
    const selected = await f.config(),
      before = await f.store.read()
    const reply = await f.pin(selected),
      after = await f.store.read()
    expect(reply.configurationRevision).toBe(selected)
    expect(after.document.state).toEqual(before.document.state)
    expect(after.document.bindings).toEqual(before.document.bindings)
    expect(after.document.configurationRevision.published).toBe(
      before.document.configurationRevision.published
    )
    expect(
      (await f.reader.readPinned(selected, new AbortController().signal)).shared['geodata-mode']
    ).toBe(false)
    expect(f.bindingReader).not.toHaveBeenCalled()
    f.reader.readPinned.mockClear()
    const bytes = await readFile(f.store.path)
    await f.pin(selected)
    expect(f.reader.readPinned).toHaveBeenCalledTimes(2)
    expect(await readFile(f.store.path)).toEqual(bytes)
  })
})
it('unpins a bad configuration and stale source without any external reader and preserves all other document fields', async () => {
  await own(async (f) => {
    await f.add()
    const selected = await f.config()
    await f.pin(selected)
    await rm(join(f.sources.directory, f.info.id), { recursive: true })
    await writeFile(f.configPath, '{broken', { mode: 0o600 })
    const before = await f.store.read()
    f.reader.readPinned.mockClear()
    f.reader.inspectCurrent.mockClear()
    f.bindingReader.mockClear()
    await f.pin('')
    const after = await f.store.read()
    expect(after.document.state).toEqual(before.document.state)
    expect(after.document.bindings).toEqual(before.document.bindings)
    expect(after.document.configurationRevision.draft).toBe('')
    expect(f.reader.readPinned).not.toHaveBeenCalled()
    expect(f.reader.inspectCurrent).not.toHaveBeenCalled()
    expect(f.bindingReader).not.toHaveBeenCalled()
    expect(await readFile(f.configPath, 'utf8')).toBe('{broken')
  })
})
it('rejects a chosen pin that changed before the second actual read without writing Simple', async () => {
  await own(async (f) => {
    const pin = await f.config(),
      before = await readFile(f.store.path),
      original = f.reader.readPinned.getMockImplementation()
    if (!original) throw new Error('Missing reader')
    let reads = 0
    f.reader.readPinned.mockImplementation(async (...args) => {
      if (++reads === 2) await f.config('192.0.2.6')
      return original(...args)
    })
    await expect(f.pin(pin)).rejects.toMatchObject({ code: 'stale' })
    expect(await readFile(f.store.path)).toEqual(before)
  })
})
it('empty-pin save on a missing Simple file is a no-op without creating its configuration file', async () => {
  await own(async (f) => {
    expect(existsSync(f.store.path)).toBe(false)
    expect(await f.pin('')).toMatchObject({
      exists: false,
      revision: '',
      configurationRevision: ''
    })
    expect(existsSync(f.store.path)).toBe(false)
    expect(f.reader.readPinned).not.toHaveBeenCalled()
    expect(f.reader.inspectCurrent).not.toHaveBeenCalled()
  }, false)
})
