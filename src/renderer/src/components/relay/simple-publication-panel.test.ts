import { mkdtemp, realpath, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ProfileStore, ProfileWriteUncertain } from '../../../../main/relay/profiles/store'
import { createProfileService } from '../../../../main/relay/profiles/service'
import { SimpleDraftStore } from '../../../../main/relay/simple/store'
import { createSimpleDraftService } from '../../../../main/relay/simple/service'
import { createPinnedSimpleCapture } from '../../../../main/relay/simple/capture'
import { createPinnedSimpleConfigurationReader } from '../../../../main/relay/simple/configuration'
import { SimpleFailure } from '../../../../main/relay/simple/model'
import { SimplePublicationJournal } from '../../../../main/relay/simple/publication-journal'
import { createSimplePublicationService } from '../../../../main/relay/simple/publication-service'
import { createSimplePublicationHandlers } from '../../../../main/relay/simple/publication-handlers'
import { createSimpleHandlers } from '../../../../main/relay/simple/handlers'
import { defaultSimpleDraft } from '../../../../shared/simple-config'
import type { RelaySimpleIpcApi, RelaySimpleReply } from '../../../../shared/relay/simple'
import type {
  RelaySimplePublicationIpcApi,
  RelaySimplePublicationState,
  RelaySimplePublicationResult
} from '../../../../shared/relay/simple-publication'
import type { RelaySimpleConfigurationIpcApi } from '../../../../shared/relay/simple-configuration'
import {
  createSimplePanelController,
  isPublicationBlocking,
  type SimplePanelSourcesAdapter
} from './simple-panel-state'
import { SimplePublicationPanel } from './simple-publication-panel'
import { readPublicationState } from './simple-publication-state'

const A = 'a'.repeat(64),
  B = 'b'.repeat(64),
  P = '1'.repeat(64),
  M = '2'.repeat(64),
  OP = '11111111-1111-4111-8111-111111111111',
  EVIDENCE = '22222222-2222-4222-8222-222222222222',
  PROFILE = '33333333-3333-4333-8333-333333333333'
const info = {
  exists: true,
  revision: A,
  publishedRevision: 7,
  dirty: true,
  sharedConfigurationPinned: false,
  sources: []
}
const none: RelaySimplePublicationState = {
  initialized: true,
  pending: false,
  closing: false,
  blocking: false,
  classification: 'none',
  needsRetirement: false,
  markerRevision: ''
}
const prepared = {
  operationId: OP,
  preparation: {
    evidenceId: EVIDENCE,
    name: 'Publish.yaml',
    sha256: P,
    bytes: 100,
    inspection: {
      structure: 'passed' as const,
      coreCompatibility: 'notVerified' as const,
      active: false as const,
      issues: []
    }
  }
}
const published: RelaySimplePublicationResult = {
  status: 'published',
  operationId: OP,
  profile: { id: PROFILE, sha256: P },
  publishedRevision: 8,
  revision: B,
  needsRecovery: false
}
const transfer = <T>(raw: unknown): T => raw as T
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  let live = true,
    blocked = false
  const api: RelaySimpleIpcApi = {
    relaySimpleReadEditableDraft: vi.fn(async () => ({
      status: 'ok' as const,
      value: { ...info, modules: defaultSimpleDraft().modules }
    })),
    relaySimpleSaveModule: vi.fn(async () => ({
      status: 'ok' as const,
      value: { ...info, revision: B }
    })),
    relaySimplePreview: vi.fn(async () => ({
      status: 'ok' as const,
      value: { valid: true, bytes: 100, errors: [], yamlSHA256: P }
    })),
    relaySimplePrepareProfile: vi.fn(async () => ({
      status: 'ok' as const,
      value: prepared.preparation
    })),
    relaySimpleRecover: vi.fn(async () => ({ status: 'ok' as const, value: info }))
  }
  const sources: SimplePanelSourcesAdapter = {
    relaySimpleReadSourceBindings: vi.fn(async () => ({ status: 'ok' as const, value: info })),
    relaySimpleSaveSourceBinding: vi.fn(async () => ({ status: 'ok' as const, value: info })),
    listProfiles: vi.fn(async () => ({
      profiles: [],
      activeId: null,
      incomplete: 0,
      warnings: []
    })),
    listSources: vi.fn(async () => ({ sources: [], incomplete: 0, warnings: [] }))
  }
  const { sources: _sourceSummaries, ...configurationInfo } = info
  const configuration: RelaySimpleConfigurationIpcApi = {
    relaySimpleReadConfigurationBinding: vi.fn(async () => ({
      status: 'ok' as const,
      value: {
        ...configurationInfo,
        configurationRevision: '',
        candidate: { status: 'missing' as const }
      }
    })),
    relaySimpleSaveConfigurationBinding: vi.fn(async () => ({
      status: 'ok' as const,
      value: { ...configurationInfo, configurationRevision: '' }
    }))
  }
  const publication: RelaySimplePublicationIpcApi = {
    relaySimplePublicationState: vi.fn(async () => ({ status: 'ok' as const, value: none })),
    relaySimplePublicationPrepare: vi.fn(async () => ({ status: 'ok' as const, value: prepared })),
    relaySimplePublicationConfirm: vi.fn(async () => ({ status: 'ok' as const, value: published })),
    relaySimplePublicationRecover: vi.fn(async () => ({ status: 'ok' as const, value: none })),
    relaySimplePublicationAbandon: vi.fn(async () => ({
      status: 'ok' as const,
      value: { status: 'abandoned' as const, operationId: OP, needsRecovery: false }
    }))
  }
  const saveProfile = vi.fn(async () => ({
      status: 'saved' as const,
      profile: {
        id: PROFILE,
        name: 'Copy',
        sha256: P,
        createdAt: '2026-11-04',
        summary: { proxies: 1, groups: 0, rules: 0, proxyProviders: 0, ruleProviders: 0 }
      },
      warnings: []
    })),
    busy = vi.fn(),
    controller = createSimplePanelController({
      api,
      sources,
      configuration,
      publication,
      saveProfile,
      isCurrent: () => live,
      isBlocked: () => blocked,
      onBusy: busy
    })
  const ready = async () => {
    await controller.read()
    await controller.preview()
    await controller.readPublicationState()
  }
  const stateReply = (state: RelaySimplePublicationState) =>
    vi
      .mocked(publication.relaySimplePublicationState)
      .mockResolvedValueOnce({ status: 'ok', value: state })
  return {
    api,
    sources,
    configuration,
    publication,
    saveProfile,
    busy,
    controller,
    ready,
    stateReply,
    revoke: () => {
      live = false
    },
    block: () => {
      blocked = true
    }
  }
}
it('has no automatic publication read/resume or raw token/value controls', () => {
  const f = fixture(),
    html = renderToStaticMarkup(
      createElement(SimplePublicationPanel, {
        state: f.controller.getSnapshot(),
        controller: f.controller,
        busy: false
      })
    )
  for (const call of Object.values(f.publication)) expect(call).not.toHaveBeenCalled()
  expect(html).toContain('查看发布状态')
  expect(html).not.toMatch(/<(input|textarea|select)/u)
  expect(html).toContain('另存副本按钮只另存')
})

it('requires explicit initialized idle state, clean saved modules and no uncommitted source form before preparation', async () => {
  const f = fixture()
  await f.controller.read()
  await f.controller.preview()
  await f.controller.preparePublication()
  expect(f.publication.relaySimplePublicationPrepare).not.toHaveBeenCalled()
  await f.controller.readPublicationState()
  await f.controller.readSources()
  f.controller.newSource()
  await f.controller.preparePublication()
  expect(f.publication.relaySimplePublicationPrepare).not.toHaveBeenCalled()
  f.controller.cancelSourceForm()
  f.controller.setText('DIRTY')
  await f.controller.preparePublication()
  expect(f.publication.relaySimplePublicationPrepare).not.toHaveBeenCalled()
})

it('publishes through its own one-shot proof, never relayProfileSave, and advances only matching file snapshots', async () => {
  const f = fixture()
  await f.controller.read()
  await f.controller.readSources()
  await f.controller.readConfigurationBinding()
  await f.controller.preview()
  await f.controller.readPublicationState()
  await f.controller.preparePublication()
  await f.controller.confirmSave()
  expect(f.saveProfile).not.toHaveBeenCalled()
  await Promise.all([f.controller.confirmPublication(), f.controller.confirmPublication()])
  expect(f.publication.relaySimplePublicationConfirm).toHaveBeenCalledOnce()
  expect(f.publication.relaySimplePublicationConfirm).toHaveBeenCalledWith({ evidenceId: EVIDENCE })
  expect(f.controller.getSnapshot().metadata).toMatchObject({
    revision: B,
    publishedRevision: 8,
    dirty: false
  })
  expect(f.controller.getSnapshot().sourceSnapshot?.revision).toBe(B)
  expect(f.controller.getSnapshot().configurationSnapshot?.revision).toBe(B)
  expect(f.controller.getSnapshot().configurationSnapshot).not.toHaveProperty('sources')
  expect(f.controller.getSnapshot().modules).toEqual(defaultSimpleDraft().modules)
  expect(f.controller.getSnapshot().publicationPreparation).toBeUndefined()
  expect(f.publication.relaySimplePublicationState).toHaveBeenCalledOnce()
})

it('accepts exact published facts requiring record cleanup but holds all ordinary writes until explicit state verification', async () => {
  const f = fixture()
  await f.ready()
  await f.controller.preparePublication()
  vi.mocked(f.publication.relaySimplePublicationConfirm).mockResolvedValueOnce({
    status: 'ok',
    value: { ...published, needsRecovery: true }
  })
  await f.controller.confirmPublication()
  expect(f.controller.getSnapshot().notice).toContain('已确认发布')
  expect(f.controller.getSnapshot().notice).toContain('收尾')
  expect(f.controller.getSnapshot().metadata?.publishedRevision).toBe(8)
  expect(isPublicationBlocking(f.controller.getSnapshot())).toBe(true)
  await f.controller.read()
  await f.controller.preview()
  await f.controller.prepareProfile()
  await f.controller.readSources()
  await f.controller.readConfigurationBinding()
  expect(f.api.relaySimpleReadEditableDraft).toHaveBeenCalledOnce()
  expect(f.api.relaySimplePreview).toHaveBeenCalledOnce()
  expect(f.api.relaySimplePrepareProfile).not.toHaveBeenCalled()
  expect(f.sources.relaySimpleReadSourceBindings).not.toHaveBeenCalled()
  expect(f.configuration.relaySimpleReadConfigurationBinding).not.toHaveBeenCalled()
  await f.controller.readPublicationState()
  expect(isPublicationBlocking(f.controller.getSnapshot())).toBe(false)
})

it.each(['operation', 'profileSHA', 'revision', 'publishedRevision'] as const)(
  'rejects a forged published %s field rather than claiming success',
  async (key) => {
    const f = fixture()
    await f.ready()
    await f.controller.preparePublication()
    const value =
      key === 'operation'
        ? { ...published, operationId: PROFILE }
        : key === 'profileSHA'
          ? { ...published, profile: { id: PROFILE, sha256: M } }
          : key === 'revision'
            ? { ...published, revision: A }
            : { ...published, publishedRevision: 7 }
    vi.mocked(f.publication.relaySimplePublicationConfirm).mockResolvedValueOnce({
      status: 'ok',
      value
    })
    await f.controller.confirmPublication()
    expect(f.controller.getSnapshot().metadata?.publishedRevision).toBe(7)
    expect(f.controller.getSnapshot().publicationReadInvalid).toBe(true)
    expect(f.controller.getSnapshot().publicationResult).toBeUndefined()
    expect(isPublicationBlocking(f.controller.getSnapshot())).toBe(true)
  }
)

it('refuses abandon without a known operation and never bypasses another actor busy gate', async () => {
  const f = fixture()
  await f.ready()
  f.stateReply({
    ...none,
    blocking: true,
    classification: 'uncertain',
    markerRevision: ''
  })
  await f.controller.readPublicationState()
  await f.controller.abandonPublication()
  expect(f.publication.relaySimplePublicationAbandon).not.toHaveBeenCalled()
  f.block()
  await f.controller.recoverPublication()
  await f.controller.readPublicationState()
  expect(f.publication.relaySimplePublicationRecover).not.toHaveBeenCalled()
  expect(f.publication.relaySimplePublicationState).toHaveBeenCalledTimes(2)
})

it('suppresses a postcommit-shaped late success after owner invalidation and drains busy before releasing', async () => {
  const f = fixture()
  await f.ready()
  await f.controller.preparePublication()
  const late = deferred<RelaySimpleReply<RelaySimplePublicationResult>>()
  vi.mocked(f.publication.relaySimplePublicationConfirm).mockImplementationOnce(() => late.promise)
  const pending = f.controller.confirmPublication()
  f.revoke()
  f.controller.invalidate()
  expect(f.controller.getSnapshot().pending).toBe(true)
  expect(f.controller.getSnapshot().modules).toBeUndefined()
  late.resolve({ status: 'ok', value: published })
  await pending
  expect(f.controller.getSnapshot().publicationResult).toBeUndefined()
  expect(f.controller.getSnapshot().metadata).toBeUndefined()
  expect(f.controller.getSnapshot().pending).toBe(false)
})

it('rejects private/unknown metadata without reflecting raw secrets or opaque tokens', async () => {
  const f = fixture()
  vi.mocked(f.publication.relaySimplePublicationState).mockResolvedValueOnce(
    transfer<RelaySimpleReply<RelaySimplePublicationState>>({
      status: 'ok',
      value: { ...none, opaqueToken: 'PRIVATE_TOKEN', path: '/private/value' }
    })
  )
  await f.controller.readPublicationState()
  expect(f.controller.getSnapshot().publicationReadInvalid).toBe(true)
  expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('PRIVATE_TOKEN')
  expect(() => readPublicationState({ ...none, classification: ['none'] })).toThrow()
  expect(() =>
    readPublicationState({
      ...none,
      profile: { id: PROFILE, sha256: P, authorization: 'PRIVATE_AUTH' }
    })
  ).toThrow()
})

it.each(['complete', 'abandoned'] as const)(
  'terminal %s without retirement has no abandonment control or request',
  async (classification) => {
    const f = fixture()
    await f.ready()
    f.stateReply({ ...none, classification, operationId: OP, markerRevision: M })
    await f.controller.readPublicationState()
    await f.controller.abandonPublication()
    expect(f.publication.relaySimplePublicationAbandon).not.toHaveBeenCalled()
    const html = renderToStaticMarkup(
      createElement(SimplePublicationPanel, {
        state: f.controller.getSnapshot(),
        controller: f.controller,
        busy: false
      })
    )
    expect(html).not.toContain('明确放弃未完成意图（保留全部副本）')
  }
)
async function withFixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-own-portable-publication-')))
  let f: Awaited<ReturnType<typeof setup>> | undefined
  try {
    f = await setup(home)
    await run(f)
  } finally {
    if (f) {
      f.controller.deactivate()
      f.pub.clear()
      f.simple.clear()
      f.profileService.clear()
      await f.pub.whenIdle()
      await f.simple.whenIdle()
      await f.profileService.whenIdle()
    }
    await rm(home, { recursive: true, force: true })
  }
}
async function setup(home: string) {
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  const store = new SimpleDraftStore(context),
    journal = new SimplePublicationJournal(context),
    profiles = new ProfileStore(context)
  await store.saveDraft(
    { expectedRevision: '', draft: defaultSimpleDraft(), bindings: [], configurationRevision: '' },
    () => {}
  )
  const owner = { isCurrent: () => true }
  const simple = createSimpleDraftService({
    store,
    capture: createPinnedSimpleCapture(context),
    configurationReader: createPinnedSimpleConfigurationReader(context)
  })
  const save = vi.fn((name: string, text: string) => profiles.save(name, text)),
    confirm = vi.fn(async () => true),
    list = vi.fn(() => profiles.list())
  const profileService = createProfileService({ pick: async () => undefined, save, confirm, list })
  let profileUnavailable = false
  const pubAdapters = {
    store: {
      read: () => store.read(),
      promotePublished: vi.fn((...args: Parameters<SimpleDraftStore['promotePublished']>) =>
        store.promotePublished(...args)
      )
    },
    journal,
    simple,
    profiles: profileService,
    readProfile: vi.fn((selection: Parameters<ProfileStore['read']>[0]) => {
      if (profileUnavailable)
        return Promise.reject(new Error('OWN_SYNTHETIC_TEMPORARILY_UNAVAILABLE'))
      return profiles.read(selection)
    })
  }
  const pub = createSimplePublicationService(pubAdapters)
  await pub.initialize()
  const idle = () => {
    if (simple.isBusy() || profileService.isBusy()) throw new SimpleFailure('busy')
  }
  const facade = createSimplePublicationHandlers({
    service: pub,
    authorize: () => owner,
    assertOtherActorsIdle: idle
  })
  const publication = {
    relaySimplePublicationState: vi.fn(() => facade.relaySimplePublicationState()),
    relaySimplePublicationPrepare: vi.fn(
      (request: Parameters<typeof facade.relaySimplePublicationPrepare>[0]) =>
        facade.relaySimplePublicationPrepare(request)
    ),
    relaySimplePublicationConfirm: vi.fn(
      (request: Parameters<typeof facade.relaySimplePublicationConfirm>[0]) =>
        facade.relaySimplePublicationConfirm(request)
    ),
    relaySimplePublicationRecover: vi.fn(() => facade.relaySimplePublicationRecover()),
    relaySimplePublicationAbandon: vi.fn(
      (request: Parameters<typeof facade.relaySimplePublicationAbandon>[0]) =>
        facade.relaySimplePublicationAbandon(request)
    )
  }
  const handlers = createSimpleHandlers({
    service: simple,
    profiles: profileService,
    authorize: () => owner,
    assertIdle: () => {
      idle()
      if (pub.isBlocking()) throw new SimpleFailure('busy')
    }
  })
  const controller = createSimplePanelController({
    api: handlers,
    configuration: handlers,
    publication,
    saveProfile: (request) => profileService.save(request),
    isCurrent: owner.isCurrent
  })
  const ready = async () => {
    await controller.read()
    await controller.preview()
    await controller.readPublicationState()
    await controller.preparePublication()
    expect(controller.getSnapshot().publicationPreparation).toBeDefined()
  }
  return {
    context,
    store,
    journal,
    profiles,
    simple,
    profileService,
    pub,
    pubAdapters,
    facade,
    publication,
    controller,
    ready,
    save,
    confirm,
    list,
    owner,
    setProfileUnavailable: (value: boolean) => {
      profileUnavailable = value
    }
  }
}

it('explicitly retires its known missing intent through actual Store, journal, facade and controller without retrying a Profile write', async () =>
  withFixture(async (f) => {
    await f.ready()
    const original = await f.store.read()
    f.save.mockRejectedValueOnce(new ProfileWriteUncertain())
    await f.controller.confirmPublication()
    const operationId = f.pub.state().operationId
    expect(operationId).toBeDefined()
    await unlink(f.journal.path)
    await f.controller.recoverPublication()
    expect(f.controller.getSnapshot().publicationState).toMatchObject({
      initialized: true,
      classification: 'uncertain',
      markerRevision: '',
      operationId
    })
    await f.controller.abandonPublication()
    expect(f.publication.relaySimplePublicationAbandon).toHaveBeenCalledExactlyOnceWith({
      operationId,
      expectedMarkerRevision: ''
    })
    expect(f.controller.getSnapshot().publicationResult?.status).toBe('abandoned')
    expect(f.controller.getSnapshot().moduleRevisionStale).toBe(true)
    expect(f.save).toHaveBeenCalledOnce()
    const after = await f.store.read()
    expect(after.revision).toBe(original.revision)
    expect(after.document).toEqual(original.document)
    expect((await f.journal.read()).value?.phase).toBe('abandoned')
  }))
it('retains the actual published receipt discovered after a transient Profile verification failure, requiring explicit draft reread', async () =>
  withFixture(async (f) => {
    await f.ready()
    const original = f.pubAdapters.store.promotePublished.getMockImplementation()
    if (!original) throw new Error('Missing real promotion adapter')
    f.pubAdapters.store.promotePublished.mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      f.setProfileUnavailable(true)
      return result
    })
    await f.controller.confirmPublication()
    const committed = await f.store.read()
    expect(committed.document.state.revision).toBe(1)
    await f.controller.readPublicationState()
    const before = f.controller.getSnapshot().publicationState
    expect(before).toMatchObject({ classification: 'uncertain', needsRetirement: false })
    expect(before?.profile).toBeDefined()
    f.setProfileUnavailable(false)
    await f.controller.abandonPublication()
    expect(f.publication.relaySimplePublicationAbandon).toHaveBeenCalledOnce()
    const after = f.controller.getSnapshot()
    expect(after.publicationResult).toMatchObject({
      status: 'published',
      operationId: before?.operationId,
      profile: before?.profile,
      publishedRevision: 1,
      revision: committed.revision
    })
    expect(after.publicationReadInvalid).toBe(false)
    expect(after.moduleRevisionStale).toBe(true)
    expect(after.modules).toEqual(defaultSimpleDraft().modules)
    expect(after.notice).toContain('不是放弃或回滚')
    expect(f.save).toHaveBeenCalledOnce()
    expect((await f.journal.read()).value?.phase).toBe('complete')
  }))

it('prepares and publishes once from a single click', async () => {
  const f = fixture()
  await f.controller.read()
  await f.controller.preview()
  await f.controller.readPublicationState()
  await Promise.all([f.controller.preparePublication(true), f.controller.preparePublication(true)])
  expect(f.publication.relaySimplePublicationPrepare).toHaveBeenCalledOnce()
  expect(f.publication.relaySimplePublicationConfirm).toHaveBeenCalledOnce()
  expect(f.saveProfile).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot().metadata?.publishedRevision).toBe(8)
})
