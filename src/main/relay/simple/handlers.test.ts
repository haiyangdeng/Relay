import { describe, expect, it, vi } from 'vitest'
import { defaultSimpleDraft } from '../../../shared/simple-config'
import type { RelayProfilePreparation } from '../../../shared/relay/profiles'
import { createSimpleHandlers, reopenSimpleWhenIdle } from './handlers'
import { createSimpleDraftService, type SimpleOwner } from './service'
import { document, hash, SimpleFailure } from './model'

const report: RelayProfilePreparation = {
  evidenceId: '11111111-1111-4111-8111-111111111111',
  name: 'Copy.yaml',
  sha256: 'a'.repeat(64),
  bytes: 20,
  inspection: { structure: 'passed', active: false, coreCompatibility: 'notVerified', issues: [] }
}
function fixture() {
  let live = true
  const owner = { isCurrent: () => live },
    metadata = {
      exists: false,
      revision: '',
      publishedRevision: 0,
      dirty: false,
      sharedConfigurationPinned: false,
      sources: []
    }
  const source = Object.freeze({
    name: 'Private.yaml',
    text: 'private-generated-source',
    assertCurrent: async () => {},
    readAgain: async () => 'private-generated-source'
  })
  const configurationMetadata = {
    exists: false,
    revision: '',
    publishedRevision: 0,
    dirty: false,
    sharedConfigurationPinned: false,
    configurationRevision: ''
  }
  const configurationSnapshot = {
    ...configurationMetadata,
    candidate: { status: 'missing' as const }
  }
  const service = {
    readEditableDraft: vi.fn(async (_owner: SimpleOwner) => ({
      ...metadata,
      modules: defaultSimpleDraft().modules
    })),
    saveModule: vi.fn(async (_request: unknown, _owner: SimpleOwner) => metadata),
    preview: vi.fn(async (_revision: unknown, _owner: SimpleOwner) => ({
      yamlSHA256: 'a'.repeat(64),
      bytes: 20,
      errors: [],
      valid: true
    })),
    prepareProfile: vi.fn(async (_request: unknown, _owner: SimpleOwner) => source),
    recover: vi.fn(async (_owner: SimpleOwner) => metadata),
    readSourceBindings: vi.fn(async (_owner: SimpleOwner) => metadata),
    saveSourceBinding: vi.fn(async (_request: unknown, _owner: SimpleOwner) => metadata),
    readConfigurationBinding: vi.fn(async (_owner: SimpleOwner) => configurationSnapshot),
    saveConfigurationBinding: vi.fn(
      async (_request: unknown, _owner: SimpleOwner) => configurationMetadata
    )
  }
  const profiles = { prepareGenerated: vi.fn(async () => report) },
    assertIdle = vi.fn(() => {})
  const handlers = createSimpleHandlers({ service, profiles, authorize: () => owner, assertIdle })
  return {
    owner,
    source,
    configurationMetadata,
    configurationSnapshot,
    service,
    profiles,
    assertIdle,
    handlers,
    revoke: () => {
      live = false
    }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Simple fixed IPC facade and cancelled-quit observation', () => {
  it('rejects all nine operations from a revoked owner before a service is called', async () => {
    const f = fixture()
    f.revoke()
    const results = await Promise.all([
      f.handlers.relaySimpleReadEditableDraft(),
      f.handlers.relaySimpleSaveModule({}),
      f.handlers.relaySimplePreview(''),
      f.handlers.relaySimplePrepareProfile({}),
      f.handlers.relaySimpleRecover(),
      f.handlers.relaySimpleReadSourceBindings(),
      f.handlers.relaySimpleSaveSourceBinding({}),
      f.handlers.relaySimpleReadConfigurationBinding(),
      f.handlers.relaySimpleSaveConfigurationBinding({})
    ])
    expect(results).toEqual(Array.from({ length: 9 }, () => ({ status: 'cancelled' })))
    for (const method of Object.values(f.service)) expect(method).not.toHaveBeenCalled()
  })
  it('runs source reads and writes through the same owner and idle gate', async () => {
    const f = fixture(),
      request = { action: 'remove', expectedRevision: 'a'.repeat(64), bindingId: 'source-id' }
    const read = await f.handlers.relaySimpleReadSourceBindings()
    expect(read.status).toBe('ok')
    expect(f.service.readSourceBindings).toHaveBeenCalledWith(f.owner)
    await f.handlers.relaySimpleSaveSourceBinding(request)
    expect(f.service.saveSourceBinding).toHaveBeenCalledWith(request, f.owner)
    const blocked = fixture()
    blocked.assertIdle.mockImplementation(() => {
      throw new SimpleFailure('busy')
    })
    expect(await blocked.handlers.relaySimpleReadSourceBindings()).toEqual({ status: 'busy' })
    expect(await blocked.handlers.relaySimpleSaveSourceBinding(request)).toEqual({ status: 'busy' })
    expect(blocked.service.readSourceBindings).not.toHaveBeenCalled()
    expect(blocked.service.saveSourceBinding).not.toHaveBeenCalled()
  })
  it('suppresses late source replies and credential-bearing source exceptions', async () => {
    const f = fixture()
    f.service.readSourceBindings.mockImplementationOnce(async () => {
      f.revoke()
      return {
        exists: false,
        revision: '',
        publishedRevision: 0,
        dirty: false,
        sharedConfigurationPinned: false,
        sources: []
      }
    })
    expect(await f.handlers.relaySimpleReadSourceBindings()).toEqual({ status: 'cancelled' })
    const next = fixture()
    next.service.saveSourceBinding.mockImplementationOnce(async () => {
      next.revoke()
      return {
        exists: false,
        revision: '',
        publishedRevision: 0,
        dirty: false,
        sharedConfigurationPinned: false,
        sources: []
      }
    })
    expect(await next.handlers.relaySimpleSaveSourceBinding({})).toEqual({ status: 'cancelled' })
    const error = fixture()
    error.service.readSourceBindings.mockRejectedValueOnce(
      new Error('https://private.invalid/?token=credential')
    )
    expect(await error.handlers.relaySimpleReadSourceBindings()).toEqual({ status: 'invalid' })
    error.service.saveSourceBinding.mockRejectedValueOnce(new SimpleFailure('stale'))
    expect(await error.handlers.relaySimpleSaveSourceBinding({})).toEqual({ status: 'stale' })
  })
  it('uses the same owner and idle admission for explicit configuration pin operations', async () => {
    const f = fixture(),
      request = { expectedRevision: 'a'.repeat(64), configurationRevision: '' }
    expect(await f.handlers.relaySimpleReadConfigurationBinding()).toEqual({
      status: 'ok',
      value: f.configurationSnapshot
    })
    expect(f.service.readConfigurationBinding).toHaveBeenCalledWith(f.owner)
    expect(await f.handlers.relaySimpleSaveConfigurationBinding(request)).toEqual({
      status: 'ok',
      value: f.configurationMetadata
    })
    expect(f.service.saveConfigurationBinding).toHaveBeenCalledWith(request, f.owner)
    const blocked = fixture()
    blocked.assertIdle.mockImplementation(() => {
      throw new SimpleFailure('busy')
    })
    expect(await blocked.handlers.relaySimpleReadConfigurationBinding()).toEqual({ status: 'busy' })
    expect(await blocked.handlers.relaySimpleSaveConfigurationBinding(request)).toEqual({
      status: 'busy'
    })
    expect(blocked.service.readConfigurationBinding).not.toHaveBeenCalled()
    expect(blocked.service.saveConfigurationBinding).not.toHaveBeenCalled()
  })
  it('suppresses late configuration metadata and strips private error diagnostics', async () => {
    const f = fixture()
    f.service.readConfigurationBinding.mockImplementationOnce(async () => {
      f.revoke()
      return f.configurationSnapshot
    })
    expect(await f.handlers.relaySimpleReadConfigurationBinding()).toEqual({ status: 'cancelled' })
    const next = fixture()
    next.service.saveConfigurationBinding.mockImplementationOnce(async () => {
      next.revoke()
      return next.configurationMetadata
    })
    expect(await next.handlers.relaySimpleSaveConfigurationBinding({})).toEqual({
      status: 'cancelled'
    })
    const error = fixture()
    error.service.readConfigurationBinding.mockRejectedValueOnce(
      new Error('PRIVATE_VALUE_AND_PATH')
    )
    expect(await error.handlers.relaySimpleReadConfigurationBinding()).toEqual({
      status: 'invalid'
    })
    error.service.saveConfigurationBinding.mockRejectedValueOnce(new SimpleFailure('stale'))
    expect(await error.handlers.relaySimpleSaveConfigurationBinding({})).toEqual({
      status: 'stale'
    })
  })
  it('hands only a Main capability to ProfileService and returns the public preparation report', async () => {
    const f = fixture(),
      request = { expectedRevision: '', previewSHA256: 'a'.repeat(64), name: 'Copy' }
    expect(await f.handlers.relaySimplePrepareProfile(request)).toEqual({
      status: 'ok',
      value: report
    })
    expect(f.service.prepareProfile).toHaveBeenCalledWith(request, f.owner)
    expect(f.profiles.prepareGenerated).toHaveBeenCalledWith(f.source)
    expect(f.assertIdle).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(await f.handlers.relaySimplePrepareProfile(request))).not.toContain(
      'private-generated-source'
    )
  })
  it('suppresses late sensitive bodies and rechecks exclusivity before capability handoff', async () => {
    const f = fixture()
    f.service.readEditableDraft.mockImplementationOnce(async () => {
      f.revoke()
      return {
        exists: false,
        revision: '',
        publishedRevision: 0,
        dirty: false,
        sharedConfigurationPinned: false,
        sources: [],
        modules: defaultSimpleDraft().modules
      }
    })
    expect(await f.handlers.relaySimpleReadEditableDraft()).toEqual({ status: 'cancelled' })
    const next = fixture()
    next.assertIdle
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new SimpleFailure('busy')
      })
    expect(await next.handlers.relaySimplePrepareProfile({})).toEqual({ status: 'busy' })
    expect(next.profiles.prepareGenerated).not.toHaveBeenCalled()
  })
  it('keeps canonical failure codes but never serializes an unexpected credential-bearing exception', async () => {
    for (const code of ['invalid', 'stale', 'cancelled', 'busy', 'closed', 'uncertain'] as const) {
      const f = fixture()
      f.service.preview.mockRejectedValueOnce(new SimpleFailure(code))
      expect(await f.handlers.relaySimplePreview('')).toEqual({ status: code })
    }
    const f = fixture()
    f.service.preview.mockRejectedValueOnce(new Error('https://private.invalid/?secret=credential'))
    expect(await f.handlers.relaySimplePreview('')).toEqual({ status: 'invalid' })
  })
  it('does not return a profile report if authority changes during profile admission', async () => {
    const f = fixture()
    f.profiles.prepareGenerated.mockImplementationOnce(async () => {
      f.revoke()
      return report
    })
    expect(await f.handlers.relaySimplePrepareProfile({})).toEqual({ status: 'cancelled' })
  })
  it('waits for true idle then checks the captured quit generation; uncertainty is not reset', async () => {
    const idle = deferred<void>(),
      reopen = vi.fn(),
      state = { pending: false, restoring: false, closing: true, uncertain: true, epoch: 2 }
    let current = true
    const task = reopenSimpleWhenIdle(
      { whenIdle: () => idle.promise, state: () => state, reopen },
      () => current
    )
    await Promise.resolve()
    expect(reopen).not.toHaveBeenCalled()
    current = false
    idle.resolve()
    await task
    expect(reopen).not.toHaveBeenCalled()
    expect(state.uncertain).toBe(true)
    await reopenSimpleWhenIdle({ whenIdle: async () => {}, state: () => state, reopen }, () => true)
    expect(reopen).toHaveBeenCalledOnce()
    expect(state.uncertain).toBe(true)
  })
  it('retires a generated capability on cancelled idle quit even with no close latch', async () => {
    const draft = defaultSimpleDraft(),
      data = document({
        version: 1,
        state: { version: 2, revision: 0, draft, published: structuredClone(draft) },
        bindings: { draft: [], published: [] },
        configurationRevision: { draft: '', published: '' }
      })
    const record = { document: data, revision: hash(JSON.stringify(data)), exists: true }
    const saveDraft = vi.fn(async () => structuredClone(record))
    const simple = createSimpleDraftService({
      store: {
        read: async () => structuredClone(record),
        saveDraft
      },
      capture: async () => ({
        configuration: { revision: '', shared: {} },
        profiles: [],
        recheck: async () => {}
      })
    })
    const owner = { isCurrent: () => true },
      preview = await simple.preview(record.revision, owner)
    const capability = await simple.prepareProfile(
      { expectedRevision: record.revision, previewSHA256: preview.yamlSHA256, name: 'Idle copy' },
      owner
    )
    expect(simple.state().closing).toBe(false)
    await reopenSimpleWhenIdle(simple, () => true)
    if (!capability.assertCurrent) throw new Error('Missing generated capability guard')
    await expect(capability.assertCurrent()).rejects.toMatchObject({ code: 'cancelled' })
    saveDraft.mockRejectedValueOnce(new SimpleFailure('uncertain'))
    await expect(
      simple.saveModule({ expectedRevision: record.revision, module: 'hosts', text: '{}\n' }, owner)
    ).rejects.toMatchObject({ code: 'uncertain' })
    await reopenSimpleWhenIdle(simple, () => true)
    expect(simple.state().uncertain).toBe(true)
    await expect(simple.readEditableDraft(owner)).rejects.toMatchObject({ code: 'uncertain' })
  })
})
