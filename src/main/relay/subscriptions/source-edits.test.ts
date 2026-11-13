import { mkdtemp, realpath, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultEditDocument,
  profileOverridesFor,
  profileRulePatchFor,
  type ConfigurationEditDocument
} from '../../../shared/relay/configuration-edit'
import type { SubscriptionSourceInfo } from '../../../shared/relay/subscription-sources'
import { ProfileStore } from '../profiles/store'
import { ConfigurationEditStore } from '../configuration/edit-store'
import { createConfigurationEditService } from '../configuration/edit-service'
import { bindRuntimeResources } from '../configuration/bindings'
import { checkCompleteConfiguration } from '../configuration/checker'
import { ResourceStore } from '../resources/store'
import { SubscriptionSourceStore } from './source-store'
import { createSubscriptionSourceService } from './source-service'

const clean: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of clean.splice(0)) await dispose()
})
const configuration = (name: string) =>
  JSON.stringify({
    proxies: [{ name, type: 'http', server: '127.0.0.1', port: 18192 }],
    'proxy-groups': [{ name: 'G', type: 'select', proxies: [name] }],
    rules: ['MATCH,G']
  })
const select = (source: SubscriptionSourceInfo) => ({ id: source.id, revision: source.revision })
async function fixture() {
  const home = await realpath(await mkdtemp('/private/tmp/relay-source-edit-inheritance-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    profiles = new ProfileStore(context),
    store = new SubscriptionSourceStore(context),
    edits = new ConfigurationEditStore(context),
    editor = createConfigurationEditService({ store: edits, profiles }),
    service = createSubscriptionSourceService({
      store,
      profiles,
      download: async () => configuration('Updated'),
      confirm: async () => true,
      inheritProfileEdits: (previousId, targetId) =>
        editor.inheritProfileEdits(previousId, targetId)
    })
  clean.push(async () => {
    await service.requestClose()
    await rm(home, { recursive: true, force: true })
  })
  const create = async (name: string) => {
    const profile = await profiles.save(name, configuration(name)),
      source = await store.create({ name, url: 'https://source.invalid/' + name, proxyPort: 18191 })
    return store.commit(select(source), async () => ({
      profile: { id: profile.id, sha256: profile.sha256 }
    }))
  }
  const update = async (source: SubscriptionSourceInfo) => {
    const plan = await service.prepareUpdate(select(source)),
      downloaded = await service.execute({ evidenceId: plan.evidenceId })
    if (!downloaded.plan) throw new Error('Missing staged subscription')
    return service.execute({ evidenceId: downloaded.plan.evidenceId })
  }
  return { context, profiles, store, edits, editor, service, create, update }
}
const editsFor = (profileId: string, name = 'migrated'): ConfigurationEditDocument => ({
  ...defaultEditDocument(),
  globalOverrides: [{ id: 'shared', kind: 'yaml', content: 'sniffer: {enable: false}' }],
  controlled: { sniffer: { enable: true } },
  profileOverrideSets: [
    {
      profileId,
      overrides: [{ id: name, kind: 'yaml', content: '+rules: ["DOMAIN,override.test,G"]' }]
    }
  ],
  profileRulePatchSets: [{ profileId, rulePatch: { prepend: ['DOMAIN,' + name + '.test,G'] } }]
})

describe('Subscription versions retain configuration edit scope', () => {
  it('copies local edits to the new snapshot before publishing its source head and keeps historical and global values', async () => {
    const f = await fixture(),
      source = await f.create('Original'),
      previous = source.versions[0].profile,
      document = editsFor(previous.id)
    await f.editor.save(document)
    const result = await f.update(source)
    expect(result.status).toBe('saved')
    const target = result.source?.versions.at(-1)?.profile
    if (!target) throw new Error('Missing new snapshot')
    expect(target.id).not.toBe(previous.id)
    const after = (await f.edits.read()).document
    expect(profileOverridesFor(after, target.id)).toEqual(
      profileOverridesFor(document, previous.id)
    )
    expect(profileRulePatchFor(after, target.id)).toEqual(
      profileRulePatchFor(document, previous.id)
    )
    expect(profileOverridesFor(after, previous.id)).toEqual(
      profileOverridesFor(document, previous.id)
    )
    expect(after.globalOverrides).toEqual(document.globalOverrides)
    expect(after.controlled).toEqual(document.controlled)
    const runtimeRead = await f.editor.readRuntimeProfile(target),
      runtime = JSON.parse(runtimeRead.text)
    expect(runtime.rules).toEqual(['DOMAIN,migrated.test,G', 'DOMAIN,override.test,G', 'MATCH,G'])
    expect(runtime.sniffer).toEqual({ enable: true })
    const bundle = await bindRuntimeResources(runtimeRead.text, [], {
      resources: new ResourceStore(f.context),
      providers: f.profiles
    })
    expect(bundle.unresolved).toEqual([])
    await bundle.recheck()
    expect(
      await checkCompleteConfiguration(
        resolve('extra/relay/core'),
        JSON.stringify(bundle.configuration),
        bundle.assets
      )
    ).toMatchObject({
      status: 'passed',
      active: false,
      runtimeAccepted: false
    })
  })
  it('does not publish a source version if inherited edits cannot be saved', async () => {
    const f = await fixture(),
      source = await f.create('Original'),
      original = await f.edits.save(editsFor(source.versions[0].profile.id))
    vi.spyOn(f.edits, 'inherit').mockRejectedValueOnce(new Error('private fixture write failure'))
    expect((await f.update(source)).status).toBe('uncertain')
    expect((await f.store.read(select(source))).info.versions).toEqual(source.versions)
    expect(await f.edits.read()).toEqual(original)
  })
  it('restores the target history scope exactly, including a history snapshot with no local edits', async () => {
    const f = await fixture(),
      source = await f.create('Original'),
      original = source.versions[0]
    await f.edits.save(editsFor(original.profile.id))
    const updated = (await f.update(source)).source
    if (!updated) throw new Error('Missing updated source')
    const current = updated.versions.at(-1)?.profile
    if (!current) throw new Error('Missing current profile')
    const beforeRestore = await f.edits.save(editsFor(current.id, 'current-only')),
      plan = await f.service.prepareRestore({ source: select(updated), versionId: original.id }),
      restored = await f.service.execute({ evidenceId: plan.evidenceId })
    expect(restored.status).toBe('saved')
    expect(restored.source?.versions.at(-1)?.profile).toEqual(original.profile)
    expect(await f.edits.read()).toEqual(beforeRestore)
    expect(profileOverridesFor((await f.edits.read()).document, original.profile.id)).toEqual([])
    expect(
      profileRulePatchFor((await f.edits.read()).document, original.profile.id)
    ).toBeUndefined()
  })
  it('isolates different subscriptions and never replaces an explicit target binding', async () => {
    const f = await fixture(),
      a = await f.create('A'),
      b = await f.create('B'),
      aId = a.versions[0].profile.id,
      bId = b.versions[0].profile.id,
      aEdits = editsFor(aId, 'only-a'),
      bEdits = editsFor(bId, 'only-b')
    await f.edits.save({
      ...aEdits,
      profileOverrideSets: [
        ...(aEdits.profileOverrideSets ?? []),
        ...(bEdits.profileOverrideSets ?? [])
      ],
      profileRulePatchSets: [
        ...(aEdits.profileRulePatchSets ?? []),
        ...(bEdits.profileRulePatchSets ?? [])
      ]
    })
    const result = (await f.update(b)).source,
      target = result?.versions.at(-1)?.profile
    if (!target) throw new Error('Missing B target')
    const inherited = (await f.edits.read()).document
    expect(profileOverridesFor(inherited, target.id)[0].id).toBe('only-b')
    expect(profileRulePatchFor(inherited, target.id)?.prepend).toEqual(['DOMAIN,only-b.test,G'])
    const explicit = await f.edits.save({
      ...inherited,
      profileOverrideSets: inherited.profileOverrideSets?.map((set) =>
        set.profileId === target.id ? { ...set, overrides: [] } : set
      ),
      profileRulePatchSets: inherited.profileRulePatchSets?.map((set) =>
        set.profileId === target.id ? { ...set, rulePatch: {} } : set
      )
    })
    await f.editor.inheritProfileEdits(aId, target.id)
    expect(await f.edits.read()).toEqual(explicit)
  })
  it('serializes inheritance against another store and refuses stale UI saves and clears', async () => {
    const f = await fixture(),
      source = await f.create('Original'),
      target = await f.profiles.save('New', configuration('New')),
      original = await f.edits.save(editsFor(source.versions[0].profile.id)),
      other = new ConfigurationEditStore(f.context),
      latestDocument = {
        ...original.document,
        controlSniff: false,
        controlled: { sniffer: { enable: false } }
      }
    await Promise.all([
      other.save(latestDocument, original.revision),
      f.edits.inherit(source.versions[0].profile.id, target.id)
    ])
    const inherited = await f.edits.read()
    expect(inherited.document.controlled).toEqual(latestDocument.controlled)
    expect(inherited.document.controlSniff).toBe(false)
    expect(profileRulePatchFor(inherited.document, target.id)).toEqual(
      profileRulePatchFor(original.document, source.versions[0].profile.id)
    )
    await expect(
      f.editor.saveChecked({ document: original.document, expectedRevision: original.revision })
    ).rejects.toThrow('版本已变化')
    await expect(f.editor.clearChecked({ expectedRevision: original.revision })).rejects.toThrow(
      '版本已变化'
    )
    expect(await f.edits.read()).toEqual(inherited)
  })
  it('allows only one queued writer for a revision and requires the renderer to supply that revision', async () => {
    const f = await fixture(),
      original = await f.edits.read(),
      results = await Promise.allSettled([
        f.edits.save({ ...defaultEditDocument(), controlDns: true }, original.revision),
        new ConfigurationEditStore(f.context).save(
          { ...defaultEditDocument(), controlDns: false },
          original.revision
        )
      ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((await f.edits.read()).document.controlDns).toBe(true)
    await expect(f.editor.saveChecked(defaultEditDocument())).rejects.toThrow('已读取的版本')
    await expect(f.editor.clearChecked(undefined)).rejects.toThrow('已读取的版本')
  })
})
