import { mkdtemp, realpath, lstat, rm } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { requestOnce, PluginResponse } from '../../resolve/plugin/http-client'
import {
  defaultEditDocument,
  configurationEditDocument,
  profileOverridesFor
} from '../../../shared/relay/configuration-edit'
import {
  overrideLibraryRuntimeId,
  type OverrideLibraryRecord,
  type OverrideLibraryFetchPlan
} from '../../../shared/relay/override-library'
import { ProfileStore } from '../profiles/store'
import { profileHash } from '../profiles/source'
import { ConfigurationEditStore } from './edit-store'
import { createConfigurationEditService } from './edit-service'
import { OverrideLibraryStore } from './override-library-store'
import { createOverrideLibraryService } from './override-library-service'

const source = JSON.stringify({ proxies: [], 'proxy-groups': [], rules: ['MATCH,REJECT'] }),
  oldBody = 'sniffer:\n  enable: true\n',
  newBody = 'sniffer:\n  enable: false\n'
const response = (body = newBody): PluginResponse => ({
  status: 200,
  headers: {},
  body: '',
  bytes: Buffer.from(body)
})
const selected = (target: { id: string; sha256: string }) => ({
  id: target.id,
  sha256: target.sha256
})
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup()
  try {
    await run(f)
  } finally {
    f.service.invalidate()
    await f.service.whenIdle()
    const identity = await lstat(f.home)
    expect(identity.dev).toBe(f.identity.dev)
    expect(identity.ino).toBe(f.identity.ino)
    expect(await realpath(f.home)).toBe(f.home)
    await rm(f.home, { recursive: true, force: true })
  }
}
async function setup() {
  const home = await realpath(await mkdtemp('/private/tmp/relay-override-library-service-')),
    identity = await lstat(home),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
  let at = 1000000,
    visible = true
  const store = new OverrideLibraryStore(context, { now: () => at }),
    edits = new ConfigurationEditStore(context),
    profiles = new ProfileStore(context),
    script = vi.fn(async (_code: string, configuration: Record<string, unknown>) => ({
      configuration,
      logs: []
    })),
    editor = createConfigurationEditService({
      store: edits,
      profiles,
      script,
      assertLibraryBindings: (refs) => store.assertBindings(refs)
    }),
    assertIdle = vi.fn(),
    confirmFetch = vi.fn(async () => true),
    request = vi.fn<typeof requestOnce>(async () => response()),
    service = createOverrideLibraryService({
      store,
      editor,
      profiles,
      assertIdle,
      confirmFetch,
      request,
      now: () => at
    }),
    assertLive = vi.fn(() => {
      if (!visible) throw new Error('PRIVATE-window-gone')
    }),
    selection = async () => {
      const saved = await profiles.save('Synthetic', source),
        selected = { id: saved.id, sha256: saved.sha256 },
        read = await profiles.read(selected)
      return { ...selected, revision: read.revision }
    },
    create = async (name = 'Fixture', kind: 'yaml' | 'js' = 'yaml') =>
      service.create({
        expectedLibraryRevision: (await store.list()).revision,
        name,
        kind,
        type: 'local',
        content: kind === 'yaml' ? oldBody : 'globalThis.__RELAY_LIBRARY_EXECUTED__ = true'
      }),
    remote = async () =>
      service.create({
        expectedLibraryRevision: (await store.list()).revision,
        name: 'Remote fixture',
        kind: 'yaml',
        type: 'remote',
        remote: {
          url: 'https://override.invalid/PRIVATE_PATH/fixture.yaml?token=PRIVATE_QUERY',
          proxyPort: 18191
        }
      }),
    fetch = (record: OverrideLibraryRecord) =>
      service.fetchPrepare(
        {
          id: record.item.id,
          expectedLibraryRevision: record.revision,
          expectedMetadataRevision: record.item.metadataRevision,
          expectedBodyRevision: record.item.bodyRevision
        },
        assertLive
      )
  return {
    home,
    identity,
    store,
    edits,
    profiles,
    editor,
    service,
    request,
    script,
    confirmFetch,
    assertIdle,
    assertLive,
    selection,
    create,
    remote,
    fetch,
    advance: (delta: number) => {
      at += delta
    },
    loseContext: () => {
      visible = false
    },
    contextIsLive: () => visible
  }
}

describe('Override library private scope snapshots', () => {
  it.each(['global', 'legacy-scope', 'inactive-scope', 'wrong-kind', 'smart-role'])(
    'refuses manual %s library references before writing any edit file',
    async (kind) =>
      fixture(async (f) => {
        const target = await f.selection(),
          item = await f.create(),
          ref = {
            id: overrideLibraryRuntimeId(
              kind === 'wrong-kind' || kind === 'smart-role'
                ? item.item.id
                : '99999999-9999-4999-8999-999999999999'
            ),
            kind: kind === 'wrong-kind' ? ('js' as const) : ('yaml' as const),
            content: oldBody,
            ...(kind === 'smart-role' ? { role: 'smart' as const } : {})
          },
          document = {
            ...defaultEditDocument(),
            ...(kind === 'legacy-scope'
              ? { profileId: target.id, profileOverrides: [ref] }
              : kind === 'inactive-scope'
                ? { profileOverrideSets: [{ profileId: target.id, overrides: [ref] }] }
                : { globalOverrides: [ref] })
          }
        const checked = vi.spyOn(f.store, 'assertBindings')
        await f.editor.saveChecked({
          expectedRevision: '',
          document: {
            ...defaultEditDocument(),
            globalOverrides: [{ id: 'ordinary-legacy', kind: 'yaml', content: oldBody }]
          }
        })
        expect(checked).not.toHaveBeenCalled()
        const before = await f.editor.read()
        await expect(f.editor.save(document)).rejects.toThrow()
        await expect(
          f.editor.saveChecked({ expectedRevision: before.revision, document })
        ).rejects.toThrow()
        expect(await f.editor.read()).toEqual(before)
      })
  )
  it('refuses to rewrite a bad inactive scope through the private apply bridge or inheritance queue', async () =>
    fixture(async (f) => {
      const previous = await f.selection(),
        target = await f.selection(),
        other = await f.selection(),
        bad = await f.edits.save({
          ...defaultEditDocument(),
          profileOverrideSets: [
            {
              profileId: previous.id,
              overrides: [{ id: 'ordinary-legacy', kind: 'yaml', content: oldBody }]
            },
            {
              profileId: other.id,
              overrides: [
                {
                  id: overrideLibraryRuntimeId('99999999-9999-4999-8999-999999999999'),
                  kind: 'yaml',
                  content: oldBody
                }
              ]
            }
          ]
        })
      await expect(
        f.editor.applyLibraryBindings({ expectedRevision: bad.revision, overrides: [] })
      ).rejects.toThrow()
      expect((await f.edits.read()).revision).toBe(bad.revision)
      await expect(f.editor.inheritProfileEdits(previous.id, target.id)).rejects.toThrow()
      expect((await f.edits.read()).revision).toBe(bad.revision)
      expect(profileOverridesFor((await f.edits.read()).document, target.id)).toEqual([])
    }))
  it('saves local/remote definitions and JS as inert data without fetching, executing or editing scopes', async () =>
    fixture(async (f) => {
      const js = await f.create('JS', 'js'),
        remote = await f.remote()
      expect(js.item.kind).toBe('js')
      expect(remote.item.bodyState).toBe('missing')
      expect(f.request).not.toHaveBeenCalled()
      expect(f.script).not.toHaveBeenCalled()
      expect(Reflect.get(globalThis, '__RELAY_LIBRARY_EXECUTED__')).toBeUndefined()
      expect((await f.editor.read()).exists).toBe(false)
      expect(JSON.stringify(await f.service.list())).not.toMatch(
        /PRIVATE|"remote":|"content":|"url":/u
      )
    }))
  it('binds once, preserves old bodies on sort/toggle, and advances only explicitly refreshed references', async () =>
    fixture(async (f) => {
      let first = await f.create('A')
      const second = await f.create('B')
      let bindings = await f.service.bind({
        expectedEditRevision: '',
        refs: [
          { id: first.item.id, bodyRevision: first.item.bodyRevision },
          { id: second.item.id, bodyRevision: second.item.bodyRevision }
        ]
      })
      const originalEdit = await f.editor.read(),
        originalRevision = originalEdit.revision
      first = await f.service.saveBody({
        id: first.item.id,
        expectedLibraryRevision: second.revision,
        expectedBodyRevision: first.item.bodyRevision,
        content: newBody
      })
      expect((await f.editor.read()).revision).toBe(originalRevision)
      bindings = await f.service.order({
        expectedEditRevision: bindings.editRevision,
        ids: [second.item.id, first.item.id]
      })
      expect(bindings.globalRefs.map((r) => r.id)).toEqual([second.item.id, first.item.id])
      expect(bindings.globalRefs.find((r) => r.id === first.item.id)?.bodyRevision).toBe(
        profileHash(oldBody)
      )
      bindings = await f.service.bind({
        expectedEditRevision: bindings.editRevision,
        refs: [{ id: first.item.id, bodyRevision: profileHash(oldBody) }]
      })
      await expect(
        f.service.bind({
          expectedEditRevision: bindings.editRevision,
          refs: [{ id: first.item.id, bodyRevision: first.item.bodyRevision }]
        })
      ).rejects.toThrow('明确更新引用')
      const updated = await f.service.refresh({
        expectedEditRevision: bindings.editRevision,
        refs: [
          {
            id: first.item.id,
            expectedOldBodyRevision: profileHash(oldBody),
            bodyRevision: first.item.bodyRevision
          }
        ]
      })
      expect(updated.globalRefs[0].bodyRevision).toBe(profileHash(newBody))
      expect((await f.editor.read()).document.globalOverrides[0].content).toBe(newBody)
      expect(f.request).not.toHaveBeenCalled()
      expect(f.script).not.toHaveBeenCalled()
    }))
  it('keeps other scopes/rules/flags and gives only library global snapshots priority over older profile snapshots', async () =>
    fixture(async (f) => {
      const a = await f.selection(),
        b = await f.selection(),
        item = await f.create()
      await f.editor.saveChecked({
        expectedRevision: '',
        document: {
          ...defaultEditDocument(),
          controlled: { 'tcp-concurrent': false },
          controlSniff: false,
          profileRulePatchSets: [
            { profileId: b.id, rulePatch: { append: ['DOMAIN,b.invalid,REJECT'] } }
          ]
        }
      })
      let binding = await f.service.bind({
        expectedEditRevision: (await f.editor.read()).revision,
        target: a,
        refs: [{ id: item.item.id, bodyRevision: item.item.bodyRevision }]
      })
      const oldScope = profileOverridesFor((await f.editor.read()).document, a.id),
        latest = await f.service.saveBody({
          id: item.item.id,
          expectedLibraryRevision: item.revision,
          expectedBodyRevision: item.item.bodyRevision,
          content: newBody
        })
      binding = await f.service.bind({
        expectedEditRevision: binding.editRevision,
        refs: [{ id: item.item.id, bodyRevision: latest.item.bodyRevision }]
      })
      const record = await f.editor.read(),
        preview = await f.editor.preview({ ...record.document, profile: selected(a) })
      expect((preview.configuration.sniffer as Record<string, unknown>).enable).toBe(false)
      expect(profileOverridesFor(record.document, a.id)).toEqual(oldScope)
      expect(record.document.controlSniff).toBe(false)
      expect(record.document.controlled).toEqual({ 'tcp-concurrent': false })
      expect(record.document.profileRulePatchSets?.[0].profileId).toBe(b.id)
      await f.service.bind({ expectedEditRevision: binding.editRevision, refs: [] })
      const restored = await f.editor.preview({
        ...(await f.editor.read()).document,
        profile: selected(a)
      })
      expect((restored.configuration.sniffer as Record<string, unknown>).enable).toBe(true)
    }))
  it('does not relax legacy same-ID different-body errors or read the library for documents without refs', async () =>
    fixture(async (f) => {
      const target = await f.selection(),
        check = vi.spyOn(f.store, 'assertBindings')
      await f.editor.preview({ ...defaultEditDocument(), profile: selected(target) })
      expect(check).not.toHaveBeenCalled()
      await expect(
        f.editor.preview({
          ...defaultEditDocument(),
          profile: selected(target),
          globalOverrides: [{ id: 'legacy', kind: 'yaml', content: oldBody }],
          profileId: target.id,
          profileOverrides: [{ id: 'legacy', kind: 'yaml', content: newBody }]
        })
      ).rejects.toThrow('相同覆写ID')
    }))
  it('keeps cached runtime content/revision across library head changes and inherits the exact old inline scope', async () =>
    fixture(async (f) => {
      const target = await f.selection(),
        next = await f.selection(),
        item = await f.create()
      await f.service.bind({
        expectedEditRevision: '',
        target,
        refs: [{ id: item.item.id, bodyRevision: item.item.bodyRevision }]
      })
      const runtime = await f.editor.readRuntimeProfile(selected(target))
      await f.service.saveBody({
        id: item.item.id,
        expectedLibraryRevision: item.revision,
        expectedBodyRevision: item.item.bodyRevision,
        content: newBody
      })
      expect(await f.editor.readRuntimeProfile(selected(target))).toEqual(runtime)
      await f.editor.inheritProfileEdits(target.id, next.id)
      expect(profileOverridesFor((await f.editor.read()).document, next.id)).toEqual(
        profileOverridesFor((await f.editor.read()).document, target.id)
      )
      expect(
        JSON.parse((await f.editor.readRuntimeProfile(selected(next))).text).sniffer.enable
      ).toBe(true)
    }))
  it('refuses missing library metadata even for a cached snapshot and fails closed without an adapter', async () =>
    fixture(async (f) => {
      const target = await f.selection(),
        item = await f.create()
      await f.service.bind({
        expectedEditRevision: '',
        target,
        refs: [{ id: item.item.id, bodyRevision: item.item.bodyRevision }]
      })
      await f.editor.readRuntimeProfile(selected(target))
      const unbound = createConfigurationEditService({ store: f.edits, profiles: f.profiles })
      await expect(unbound.readRuntimeProfile(selected(target))).rejects.toThrow('校验尚未接通')
      await f.store.remove({
        id: item.item.id,
        expectedLibraryRevision: item.revision,
        expectedMetadataRevision: item.item.metadataRevision,
        expectedBodyRevision: item.item.bodyRevision
      })
      await expect(f.editor.readRuntimeProfile(selected(target))).rejects.toThrow('引用缺失')
    }))
  it('rejects deleting any used historical/current scope and rejects stale edit/profile CAS without changing drafts', async () =>
    fixture(async (f) => {
      const target = await f.selection(),
        item = await f.create(),
        before = await f.editor.read()
      await f.service.bind({
        expectedEditRevision: before.revision,
        target,
        refs: [{ id: item.item.id, bodyRevision: item.item.bodyRevision }]
      })
      const after = await f.editor.read()
      await expect(
        f.service.remove({
          id: item.item.id,
          expectedLibraryRevision: item.revision,
          expectedMetadataRevision: item.item.metadataRevision,
          expectedBodyRevision: item.item.bodyRevision
        })
      ).rejects.toThrow('仍被')
      await expect(
        f.service.bind({ expectedEditRevision: before.revision, refs: [] })
      ).rejects.toThrow('编辑版本已变化')
      await expect(
        f.service.bind({
          expectedEditRevision: after.revision,
          target: { ...target, revision: '0'.repeat(64) },
          refs: []
        })
      ).rejects.toThrow('配置版本已变化')
      await expect(
        f.editor.saveChecked({ expectedRevision: before.revision, document: before.document })
      ).rejects.toThrow('编辑版本已变化')
      expect(await f.editor.read()).toEqual(after)
      expect((await f.store.list()).items).toHaveLength(1)
    }))
  it('bounds optional card order and does not forward it into runtime options', async () =>
    fixture(async (f) => {
      const item = await f.create(),
        target = await f.selection()
      await f.service.order({ expectedEditRevision: '', ids: [item.item.id] })
      const options = await f.editor.optionsFor(selected(target))
      expect(options.options).not.toHaveProperty('overrideLibraryOrder')
      expect((await f.editor.read()).document.overrideLibraryOrder).toEqual([item.item.id])
      for (const order of [
        [item.item.id, item.item.id],
        ['../foreign'],
        Array(201).fill(item.item.id)
      ])
        expect(() =>
          configurationEditDocument({ ...defaultEditDocument(), overrideLibraryOrder: order })
        ).toThrow()
    }))
  it('bootstraps the real saved-profile revision without exposing its body or accepting a fabricated mutation revision', async () =>
    fixture(async (f) => {
      const target = await f.selection(),
        bindings = await f.service.bindings({ target: selected(target) })
      expect(bindings.target).toEqual(target)
      expect(JSON.stringify(bindings)).not.toMatch(/proxies|configuration|content|MATCH/u)
      await expect(
        f.service.bind({
          expectedEditRevision: bindings.editRevision,
          target: selected(target),
          refs: []
        })
      ).rejects.toThrow()
      const read = f.profiles.read.bind(f.profiles)
      vi.spyOn(f.profiles, 'read').mockImplementation(async (selection) => ({
        ...(await read(selection)),
        revision: 'f'.repeat(64)
      }))
      await expect(
        f.service.bind({
          expectedEditRevision: bindings.editRevision,
          target: bindings.target,
          refs: []
        })
      ).rejects.toThrow('配置版本已变化')
      expect((await f.editor.read()).exists).toBe(false)
    }))
  it('rechecks library existence after an awaited script and does not cache a body whose metadata disappeared', async () =>
    fixture(async (f) => {
      const target = await f.selection(),
        item = await f.create('Script', 'js'),
        entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>()
      await f.service.bind({
        expectedEditRevision: '',
        target,
        refs: [{ id: item.item.id, bodyRevision: item.item.bodyRevision }]
      })
      f.script.mockImplementationOnce(async (_code, configuration) => {
        entered.resolve()
        await finish.promise
        return { configuration, logs: [] }
      })
      const reading = f.editor.readRuntimeProfile(selected(target))
      await entered.promise
      await f.store.remove({
        id: item.item.id,
        expectedLibraryRevision: item.revision,
        expectedMetadataRevision: item.item.metadataRevision,
        expectedBodyRevision: item.item.bodyRevision
      })
      finish.resolve()
      await expect(reading).rejects.toThrow('引用缺失')
      await expect(f.editor.readRuntimeProfile(selected(target))).rejects.toThrow('引用缺失')
    }))
})

describe('Explicit bounded remote override fetch', () => {
  it('does not expose secret pathname/query in errors while dispatching the exact privately saved URL', async () =>
    fixture(async (f) => {
      const record = await f.remote(),
        plan = await f.fetch(record)
      f.request.mockRejectedValueOnce(new Error(record.item.remote?.url))
      let failure = ''
      try {
        await f.service.fetchExecute({ evidenceId: plan.evidenceId })
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      expect(failure).toContain('未确认')
      expect(failure).not.toMatch(/PRIVATE|override.invalid|token=/u)
      expect(f.request.mock.calls[0][0]).toBe(record.item.remote?.url)
      expect((await f.store.list()).revision).toBe(record.revision)
      expect(JSON.stringify(plan)).not.toMatch(/PRIVATE|fixture.yaml|token=/u)
    }))
  it('prepares redacted scope without a request and Native cancellation leaves the old cache unchanged', async () =>
    fixture(async (f) => {
      const item = await f.remote(),
        plan = await f.fetch(item)
      expect(plan.endpoint).toBe('https://override.invalid')
      expect(JSON.stringify(plan)).not.toMatch(/PRIVATE|token=/u)
      expect(f.request).not.toHaveBeenCalled()
      f.confirmFetch.mockResolvedValueOnce(false)
      expect(await f.service.fetchExecute({ evidenceId: plan.evidenceId })).toEqual({
        status: 'cancelled'
      })
      expect((await f.store.list()).revision).toBe(item.revision)
      expect(f.request).not.toHaveBeenCalled()
    }))
  it('updates only a library cache after one explicit fixed proxy GET and never advances an existing reference', async () =>
    fixture(async (f) => {
      let item = await f.remote()
      item = await f.service.saveBody({
        id: item.item.id,
        expectedLibraryRevision: item.revision,
        expectedBodyRevision: '',
        content: oldBody
      })
      await f.service.bind({
        expectedEditRevision: '',
        refs: [{ id: item.item.id, bodyRevision: item.item.bodyRevision }]
      })
      const oldEdit = await f.editor.read(),
        plan = await f.fetch(item),
        result = await f.service.fetchExecute({ evidenceId: plan.evidenceId })
      expect(result).toMatchObject({
        status: 'updated',
        item: { bodyState: 'current', bodyRevision: profileHash(newBody) }
      })
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE|token=|"content":|"remote":|sourceFingerprint/u
      )
      expect(await f.editor.read()).toEqual(oldEdit)
      expect(f.request).toHaveBeenCalledExactlyOnceWith(
        'https://override.invalid/PRIVATE_PATH/fixture.yaml?token=PRIVATE_QUERY',
        expect.objectContaining({
          method: 'GET',
          proxy: { host: '127.0.0.1', port: 18191 },
          binary: true,
          maxBytes: 128 * 1024,
          timeout: 15000,
          headers: { 'User-Agent': 'clash.meta/Relay', 'Accept-Encoding': 'identity' }
        })
      )
      expect(f.script).not.toHaveBeenCalled()
    }))
  it.each(['redirect', 'status', 'gzip', 'utf8', 'size', 'yaml'])(
    'preserves the exact old head after a %s failure, without retry or execution',
    async (kind) =>
      fixture(async (f) => {
        const item = await f.remote(),
          bad = response()
        if (kind === 'redirect') {
          bad.status = 302
          bad.headers.location = 'https://foreign.invalid/PRIVATE'
        }
        if (kind === 'status') bad.status = 500
        if (kind === 'gzip') bad.headers['content-encoding'] = 'gzip'
        if (kind === 'utf8') bad.bytes = Buffer.from([0xff])
        if (kind === 'size') bad.bytes = Buffer.alloc(128 * 1024 + 1)
        if (kind === 'yaml') bad.bytes = Buffer.from('age-encryption.org/v1\nPRIVATE')
        f.request.mockResolvedValueOnce(bad)
        const plan = await f.fetch(item)
        await expect(f.service.fetchExecute({ evidenceId: plan.evidenceId })).rejects.toThrow(
          '未确认'
        )
        expect((await f.store.list()).revision).toBe(item.revision)
        expect(f.request).toHaveBeenCalledOnce()
        expect(f.script).not.toHaveBeenCalled()
      })
  )
  it.each(['native', 'expired', 'backward', 'metadata', 'final-idle'])(
    'refuses %s scope loss before any request',
    async (kind) =>
      fixture(async (f) => {
        const item = await f.remote(),
          plan = await f.fetch(item)
        if (kind === 'native')
          f.confirmFetch.mockImplementationOnce(async () => {
            f.loseContext()
            return true
          })
        if (kind === 'expired') f.advance(60000)
        if (kind === 'backward') f.advance(-1)
        if (kind === 'metadata')
          await f.store.saveMetadata({
            id: item.item.id,
            expectedLibraryRevision: item.revision,
            expectedMetadataRevision: item.item.metadataRevision,
            name: 'Changed',
            remote: { url: 'https://other.invalid/changed', proxyPort: 18192 }
          })
        if (kind === 'final-idle') {
          const read = vi.spyOn(f.store, 'read')
          let postRead = 0
          f.assertIdle.mockImplementation(() => {
            if (read.mock.calls.length === 2 && ++postRead === 2) f.loseContext()
          })
        }
        const work = f.service.fetchExecute({ evidenceId: plan.evidenceId })
        if (kind === 'metadata') await expect(work).rejects.toThrow('未确认')
        else expect(await work).toEqual({ status: 'cancelled' })
        expect(f.request).not.toHaveBeenCalled()
        expect(f.script).not.toHaveBeenCalled()
      })
  )
  it('keeps a matching cancelled request busy until its real response settles, drops the late cache and ignores old IDs', async () =>
    fixture(async (f) => {
      const item = await f.remote(),
        old = await f.fetch(item),
        plan = await f.fetch(item),
        held = Promise.withResolvers<PluginResponse>()
      expect(f.service.fetchCancel({ evidenceId: old.evidenceId })).toBe(false)
      f.request.mockReturnValueOnce(held.promise)
      const work = f.service.fetchExecute({ evidenceId: plan.evidenceId })
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
      expect(f.service.fetchCancel({ evidenceId: plan.evidenceId })).toBe(true)
      let idle = false
      const waited = f.service.whenIdle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(f.service.isBusy()).toBe(true)
      expect(idle).toBe(false)
      await expect(f.service.saveBody({})).rejects.toThrow('请等待')
      expect(f.request.mock.calls[0][1].signal?.aborted).toBe(true)
      held.resolve(response())
      expect(await work).toEqual({ status: 'cancelled' })
      await waited
      expect(idle).toBe(true)
      expect((await f.store.list()).revision).toBe(item.revision)
    }))
  it('rejects a late definition read after lifecycle invalidation and never publishes its proof', async () =>
    fixture(async (f) => {
      const item = await f.remote(),
        held = Promise.withResolvers<OverrideLibraryRecord>()
      vi.spyOn(f.store, 'read').mockReturnValueOnce(held.promise)
      const preparing = f.fetch(item)
      f.service.invalidate()
      held.resolve(item)
      await expect(preparing).rejects.toThrow()
      expect(f.request).not.toHaveBeenCalled()
      expect(f.confirmFetch).not.toHaveBeenCalled()
    }))
  it('refuses a changed definition while a response is pending without publishing the fetched body', async () =>
    fixture(async (f) => {
      const item = await f.remote(),
        plan = await f.fetch(item),
        held = Promise.withResolvers<PluginResponse>()
      f.request.mockReturnValueOnce(held.promise)
      const work = f.service.fetchExecute({ evidenceId: plan.evidenceId })
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
      const changed = await f.store.saveMetadata({
        id: item.item.id,
        expectedLibraryRevision: item.revision,
        expectedMetadataRevision: item.item.metadataRevision,
        name: 'Changed',
        remote: { url: 'https://new.invalid/', proxyPort: 18192 }
      })
      held.resolve(response())
      await expect(work).rejects.toThrow('未确认')
      expect((await f.store.list()).revision).toBe(changed.revision)
      expect((await f.store.read({ id: item.item.id })).item.content).toBeUndefined()
    }))
  it('lets an admitted single-file cache transaction finish after cancellation rather than claiming no write', async () =>
    fixture(async (f) => {
      const item = await f.remote(),
        plan: OverrideLibraryFetchPlan = await f.fetch(item),
        admitted = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>(),
        save = f.store.saveFetched.bind(f.store)
      vi.spyOn(f.store, 'saveFetched').mockImplementationOnce(async (input) => {
        admitted.resolve()
        await finish.promise
        return save(input)
      })
      const work = f.service.fetchExecute({ evidenceId: plan.evidenceId })
      await admitted.promise
      expect(f.service.fetchCancel({ evidenceId: plan.evidenceId })).toBe(true)
      expect(f.service.isBusy()).toBe(true)
      finish.resolve()
      expect(await work).toMatchObject({
        status: 'updated',
        item: { bodyRevision: profileHash(newBody) }
      })
      expect((await f.store.read({ id: item.item.id })).item.content).toBe(newBody)
    }))
})
