import { mkdtemp, realpath, rm, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { zstdCompressSync } from 'zlib'
import { describe, expect, it, vi } from 'vitest'
import { atomicWriteFile } from '../../utils/safeFile'
import type { ResourceInfo } from '../../../shared/relay/resources'
import type {
  RelayProfileInventory,
  RelayProfilePreparation,
  RelayStoredProfile
} from '../../../shared/relay/profiles'
import { ResourceStore } from '../resources/store'
import { resourceHash } from '../resources/source'
import { createProfileService } from './service'
import { ProfileWriteUncertain, ProfileStore } from './store'
import type { ProfileSource } from './source'
import { profileHash } from './source'

function fixture() {
  const source: ProfileSource = {
    name: 'Local.yaml',
    text: 'mode: rule\nPRIVATE: token\n',
    readAgain: vi.fn(async () => source.text)
  }
  const saved: RelayStoredProfile = {
    id: '00000000-0000-0000-0000-000000000001',
    name: source.name,
    createdAt: '2026-10-24T00:00:00.000Z',
    sha256: 'a'.repeat(64),
    summary: { proxies: 0, groups: 0, rules: 0, proxyProviders: 0, ruleProviders: 0 }
  }
  const adapters = {
    pick: vi.fn(async (): Promise<ProfileSource | undefined> => source),
    confirm: vi.fn(async (_report: RelayProfilePreparation) => false),
    save: vi.fn(async () => saved),
    list: vi.fn(async (): Promise<RelayProfileInventory> => ({
      profiles: [],
      activeId: null,
      incomplete: 0,
      warnings: []
    }))
  }
  return { adapters, source, saved, service: createProfileService(adapters) }
}
describe('Local profile preparation, cancellation and immutable save', () => {
  it('is inert until requested and never accepts renderer paths or content', async () => {
    const f = fixture()
    expect(f.service.isBusy()).toBe(false)
    expect(f.adapters.pick).not.toHaveBeenCalled()
    await expect(f.service.prepare({ path: '/PRIVATE' })).rejects.toThrow('不接受')
    await expect(f.service.list({ path: '/PRIVATE' })).rejects.toThrow('不接受')
    await expect(f.service.save({ evidenceId: 'fake', text: 'PRIVATE' })).rejects.toThrow()
    expect(f.adapters.pick).not.toHaveBeenCalled()
    expect(f.adapters.save).not.toHaveBeenCalled()
    const report = await f.service.prepare(undefined)
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect(report?.inspection).toMatchObject({
      structure: 'passed',
      active: false,
      coreCompatibility: 'notVerified'
    })
  })
  it('cancels picker/confirmation without re-reading, writing or automatically activating', async () => {
    const f = fixture()
    f.adapters.pick.mockResolvedValueOnce(undefined)
    expect(await f.service.prepare(undefined)).toBeUndefined()
    const report = await f.service.prepare(undefined)
    expect((await f.service.save({ evidenceId: report?.evidenceId })).status).toBe('cancelled')
    expect(f.source.readAgain).not.toHaveBeenCalled()
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('consumes a valid proof once, uses the held source and rejects renderer mutation', async () => {
    const f = fixture()
    f.adapters.confirm.mockImplementation(async (value) => {
      value.name = 'Injected'
      return true
    })
    const report = await f.service.prepare(undefined)
    if (!report) throw new Error('fixture proof missing')
    report.name = 'Changed in renderer'
    expect(await f.service.save({ evidenceId: report.evidenceId })).toMatchObject({
      status: 'saved',
      profile: f.saved
    })
    expect(f.adapters.save).toHaveBeenCalledWith('Local.yaml', f.source.text)
    await expect(f.service.save({ evidenceId: report.evidenceId })).rejects.toThrow('重新选择')
  })
  it('refuses a changed source or rejected structure before saving', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    const report = await f.service.prepare(undefined)
    f.source.text = 'mode: global\n'
    expect((await f.service.save({ evidenceId: report?.evidenceId })).status).toBe('failed')
    expect(f.adapters.save).not.toHaveBeenCalled()
    f.source.text = 'rules: ['
    const invalid = await f.service.prepare(undefined)
    expect(invalid?.inspection.structure).toBe('rejected')
    await expect(f.service.save({ evidenceId: invalid?.evidenceId })).rejects.toThrow('重新选择')
  })
  it('rechecks expiry after confirmation and source re-read', async () => {
    for (const afterRead of [false, true]) {
      let now = 0
      const f = fixture(),
        service = createProfileService({ ...f.adapters, now: () => now })
      f.adapters.confirm.mockImplementation(async () => {
        if (!afterRead) now = 60001
        return true
      })
      f.source.readAgain = async () => {
        now = 60001
        return f.source.text
      }
      const report = await service.prepare(undefined)
      expect((await service.save({ evidenceId: report?.evidenceId })).status).toBe('failed')
      expect(f.adapters.save).not.toHaveBeenCalled()
    }
  })
  it('excludes competing operations and lets quit wait until a save actually completes', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    let finish!: (profile: RelayStoredProfile) => void
    f.adapters.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const report = await f.service.prepare(undefined)
    const saving = f.service.save({ evidenceId: report?.evidenceId })
    await vi.waitFor(() => expect(f.adapters.save).toHaveBeenCalled())
    const idle = vi.fn()
    const closing = f.service.whenIdle().then(idle)
    await expect(f.service.prepare(undefined)).rejects.toThrow('先完成')
    await expect(f.service.list(undefined)).rejects.toThrow('先完成')
    expect(idle).not.toHaveBeenCalled()
    finish(f.saved)
    expect((await saving).status).toBe('saved')
    await closing
    expect(idle).toHaveBeenCalledTimes(1)
  })
  it('reports uncertain publication separately and never returns private lower-level errors', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    const proof = await f.service.prepare(undefined)
    f.adapters.save.mockRejectedValueOnce(new ProfileWriteUncertain())
    expect((await f.service.save({ evidenceId: proof?.evidenceId })).status).toBe('uncertain')
    f.adapters.pick.mockRejectedValueOnce(new Error('PRIVATE source /path'))
    await expect(f.service.prepare(undefined)).rejects.toThrow('未能安全读取')
    f.adapters.list.mockRejectedValueOnce(new Error('PRIVATE raw credential'))
    await expect(f.service.list(undefined)).rejects.toThrow('配置列表读取未完成')
  })
})

const proxy = (name: string) => ({
  name,
  type: 'ss',
  server: '192.0.2.1',
  port: 8388,
  cipher: 'aes-128-gcm',
  password: 'private-fixture',
  udp: false
})
function nodeFixture() {
  const f = fixture()
  const data = {
    proxies: [proxy('A'), proxy('B')],
    'proxy-groups': [{ name: 'Group', type: 'select', proxies: ['A', 'DIRECT'] }],
    rules: ['MATCH,Group'],
    sniffer: { enable: false },
    'proxy-providers': { preserved: { type: 'file', path: './not-read.yaml' } }
  }
  const source = {
    text: JSON.stringify(data),
    revision: 'revision-1',
    profile: { ...f.saved, sha256: profileHash(JSON.stringify(data)) }
  }
  const adapters = {
    ...f.adapters,
    read: vi.fn(async () => structuredClone(source)),
    save: vi.fn(async (_name: string, text: string) => ({ ...f.saved, sha256: profileHash(text) }))
  }
  return {
    source,
    data,
    adapters,
    service: createProfileService(adapters),
    selection: { id: source.profile.id, sha256: source.profile.sha256 }
  }
}
describe('Explicit atomic name-only rename preparation', () => {
  it('does not mint a save proof for parser-admitted shared YAML identities', async () => {
    const f = nodeFixture(),
      text = `proxies:\n  - &top {name: A, type: ss}\nproxy-groups:\n  - {name: G, type: select, proxies: [A]}\nproxy-providers:\n  P: &provider {type: inline, proxy: A, payload: [*top]}\nheaders: *provider\nrules: ['MATCH,G']\n`
    f.source.text = text
    f.source.profile.sha256 = profileHash(text)
    const selection = { id: f.source.profile.id, sha256: f.source.profile.sha256 }
    await expect(
      f.service.prepareNodeEdit({
        profile: selection,
        action: 'rename',
        originalName: 'A',
        newName: 'B'
      })
    ).rejects.toThrow()
    expect(f.source.text).toBe(text)
    expect(f.adapters.confirm).not.toHaveBeenCalled()
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it.each(['nodes', 'groups'] as const)(
    'prepares %s references then confirms one independent inactive save',
    async (collection) => {
      const f = nodeFixture(),
        original = f.source.text,
        originalName = collection === 'nodes' ? 'A' : 'Group'
      f.adapters.confirm.mockResolvedValue(true)
      const report = await f.service.prepareNodeEdit(
        { profile: f.selection, action: 'rename', originalName, newName: 'Renamed' },
        collection
      )
      expect(report.inspection).toMatchObject({
        structure: 'passed',
        active: false,
        coreCompatibility: 'notVerified'
      })
      expect(f.source.text).toBe(original)
      expect(f.adapters.save).not.toHaveBeenCalled()
      expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe('saved')
      const saved = JSON.parse(f.adapters.save.mock.calls[0][1])
      if (collection === 'nodes') {
        expect(saved.proxies[0]).toEqual({ ...proxy('A'), name: 'Renamed' })
        expect(saved['proxy-groups'][0].proxies).toEqual(['Renamed', 'DIRECT'])
      } else {
        expect(saved['proxy-groups'][0].name).toBe('Renamed')
        expect(saved.rules).toEqual(['MATCH,Renamed'])
      }
      expect(f.source.text).toBe(original)
      await expect(f.service.save({ evidenceId: report.evidenceId })).rejects.toThrow()
    }
  )
  it('does not silently permit ordinary update renames or combine other node edits', async () => {
    const f = nodeFixture()
    for (const raw of [
      { action: 'update', originalName: 'A', node: proxy('Renamed') },
      { action: 'rename', originalName: 'A', newName: 'Renamed', node: proxy('Renamed') },
      { action: 'rename', originalName: 'A', newName: 'Renamed', path: '/not-read' },
      { action: 'rename', originalName: 'A', newName: 'B' }
    ])
      await expect(f.service.prepareNodeEdit({ profile: f.selection, ...raw })).rejects.toThrow()
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it.each(['revision', 'bytes', 'confirmation'] as const)(
    'retires rename on source %s conflict without saving a partial copy',
    async (conflict) => {
      const f = nodeFixture()
      f.adapters.confirm.mockImplementation(async () => {
        if (conflict === 'revision') f.source.revision += '-changed'
        if (conflict === 'bytes') f.source.text += '\n'
        if (conflict === 'confirmation') f.service.clear()
        return true
      })
      const report = await f.service.prepareNodeEdit({
        profile: f.selection,
        action: 'rename',
        originalName: 'A',
        newName: 'Renamed'
      })
      expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe('failed')
      expect(f.adapters.save).not.toHaveBeenCalled()
      await expect(f.service.save({ evidenceId: report.evidenceId })).rejects.toThrow()
    }
  )
  it('rejects source bytes not matching the selection before minting a rename proof', async () => {
    const f = nodeFixture()
    f.source.text += '\n'
    await expect(
      f.service.prepareNodeEdit({
        profile: f.selection,
        action: 'rename',
        originalName: 'A',
        newName: 'Renamed'
      })
    ).rejects.toThrow()
    expect(f.adapters.confirm).not.toHaveBeenCalled()
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('keeps source bytes and existing failure/uncertainty behavior on a renamed copy', async () => {
    for (const failure of [new Error('private failure'), new ProfileWriteUncertain()]) {
      const f = nodeFixture(),
        original = f.source.text
      f.adapters.confirm.mockResolvedValue(true)
      f.adapters.save.mockRejectedValueOnce(failure)
      const report = await f.service.prepareNodeEdit({
        profile: f.selection,
        action: 'rename',
        originalName: 'A',
        newName: 'Renamed'
      })
      expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe(
        failure instanceof ProfileWriteUncertain ? 'uncertain' : 'failed'
      )
      expect(f.source.text).toBe(original)
      expect(f.adapters.save).toHaveBeenCalledTimes(1)
      await expect(f.service.save({ evidenceId: report.evidenceId })).rejects.toThrow()
    }
  })
  it('cancels the explicit confirmation or expires during its source re-read without writing', async () => {
    for (const cancelled of [true, false]) {
      let now = 0
      const f = nodeFixture(),
        original = f.source.text,
        service = createProfileService({ ...f.adapters, now: () => now })
      f.adapters.confirm.mockResolvedValue(!cancelled)
      const report = await service.prepareNodeEdit({
        profile: f.selection,
        action: 'rename',
        originalName: 'A',
        newName: 'Renamed'
      })
      f.adapters.read.mockImplementation(async () => {
        now = 60001
        return structuredClone(f.source)
      })
      expect((await service.save({ evidenceId: report.evidenceId })).status).toBe(
        cancelled ? 'cancelled' : 'failed'
      )
      expect(f.adapters.save).not.toHaveBeenCalled()
      expect(f.source.text).toBe(original)
    }
  })
})
describe('Node edits saved as independent inactive profiles', () => {
  it('reads only the selected immutable source and returns detached node values without mutating its metadata', async () => {
    const f = nodeFixture()
    expect(f.adapters.read).not.toHaveBeenCalled()
    await expect(f.service.readNodes({ path: '/private' })).rejects.toThrow('只接受')
    const result = await f.service.readNodes(f.selection)
    expect(f.adapters.read).toHaveBeenCalledWith(f.selection)
    result.nodes[0].password = 'renderer-change'
    expect(JSON.parse(f.source.text).proxies[0].password).toBe('private-fixture')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('preserves unrelated values, resource references and Boolean false while adding and updating only the requested node', async () => {
    for (const action of ['add', 'update'] as const) {
      const f = nodeFixture()
      f.adapters.confirm.mockResolvedValue(true)
      const changed = { ...proxy(action === 'add' ? 'C' : 'A'), server: '192.0.2.2', udp: false }
      const report = await f.service.prepareNodeEdit({
        profile: f.selection,
        action,
        ...(action === 'update' ? { originalName: 'A' } : {}),
        node: changed
      })
      expect(f.adapters.save).not.toHaveBeenCalled()
      expect(report.inspection.coreCompatibility).toBe('notVerified')
      expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe('saved')
      const text = f.adapters.save.mock.calls[0][1],
        saved = JSON.parse(text)
      expect(saved.sniffer).toEqual({ enable: false })
      expect(saved['proxy-providers']).toEqual(f.data['proxy-providers'])
      expect(saved.rules).toEqual(f.data.rules)
      expect(saved['proxy-groups']).toEqual(f.data['proxy-groups'])
      expect(saved.proxies.find((node: { name: string }) => node.name === changed.name)).toEqual(
        changed
      )
      expect(JSON.parse(f.source.text)).toEqual(f.data)
      await expect(f.service.save({ evidenceId: report.evidenceId })).rejects.toThrow('重新选择')
    }
  })
  it('blocks removal across group, rule, nested dialer references and rejects renames, duplicates or unknown node fields', async () => {
    const f = nodeFixture()
    const rejected = [
      { action: 'remove', originalName: 'A' },
      { action: 'update', originalName: 'A', node: proxy('Renamed') },
      { action: 'add', node: proxy('A') },
      { action: 'add', node: { ...proxy('C'), unsupported: true } },
      { action: 'add', node: { ...proxy('C'), type: 'unknown' } },
      { action: 'add', node: proxy('C'), path: '/private' }
    ]
    for (const value of rejected)
      await expect(f.service.prepareNodeEdit({ profile: f.selection, ...value })).rejects.toThrow(
        '节点编辑未通过'
      )
    for (const reference of [
      { rules: ['DOMAIN,example.test,B'] },
      { proxies: [proxy('A'), { ...proxy('B') }, { ...proxy('C'), 'dialer-proxy': 'B' }] }
    ]) {
      f.source.text = JSON.stringify({ ...f.data, ...reference })
      await expect(
        f.service.prepareNodeEdit({ profile: f.selection, action: 'remove', originalName: 'B' })
      ).rejects.toThrow('已引用')
    }
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('removes an unreferenced node only after native confirmation and revalidates the original source revision', async () => {
    const f = nodeFixture()
    const first = await f.service.prepareNodeEdit({
      profile: f.selection,
      action: 'remove',
      originalName: 'B'
    })
    expect((await f.service.save({ evidenceId: first.evidenceId })).status).toBe('cancelled')
    expect(f.adapters.save).not.toHaveBeenCalled()
    f.adapters.confirm.mockImplementation(async () => {
      f.source.revision = 'external-change'
      return true
    })
    expect((await f.service.save({ evidenceId: first.evidenceId })).status).toBe('failed')
    expect(f.adapters.save).not.toHaveBeenCalled()
    const next = await f.service.prepareNodeEdit({
      profile: f.selection,
      action: 'remove',
      originalName: 'B'
    })
    f.adapters.confirm.mockResolvedValue(true)
    expect((await f.service.save({ evidenceId: next.evidenceId })).status).toBe('saved')
    expect(
      JSON.parse(f.adapters.save.mock.calls[0][1]).proxies.map(
        (node: { name: string }) => node.name
      )
    ).toEqual(['A'])
  })
  it('bounds node size and count, invalidates previous import proof and keeps reads within the common busy gate', async () => {
    const f = nodeFixture(),
      imported = await f.service.prepare(undefined)
    await expect(
      f.service.prepareNodeEdit({
        profile: f.selection,
        action: 'add',
        node: { ...proxy('C'), password: 'x'.repeat(65536) }
      })
    ).rejects.toThrow('节点编辑未通过')
    await expect(f.service.save({ evidenceId: imported?.evidenceId })).rejects.toThrow('重新选择')
    const pending = Promise.withResolvers<typeof f.source>()
    f.adapters.read.mockImplementationOnce(() => pending.promise)
    const reading = f.service.readNodes(f.selection),
      idle = vi.fn(),
      waiting = f.service.whenIdle().then(idle)
    await expect(f.service.prepare(undefined)).rejects.toThrow('先完成')
    await expect(f.service.prepareNodeEdit({})).rejects.toThrow('先完成')
    expect(idle).not.toHaveBeenCalled()
    pending.resolve(f.source)
    await reading
    await waiting
    f.source.text = JSON.stringify({
      proxies: Array.from({ length: 501 }, (_, index) => proxy(`Node${index}`))
    })
    await expect(f.service.readNodes(f.selection)).rejects.toThrow('500')
  })
  it('writes an actual new private profile and keeps the original source unchanged', async () => {
    const home = await realpath(await mkdtemp('/private/tmp/relay-node-editor-'))
    try {
      const store = new ProfileStore({
        home,
        stateRoot: join(home, 'Library/Application Support/Relay')
      })
      const f = nodeFixture(),
        original = await store.save('Source.yaml', f.source.text)
      const selection = { id: original.id, sha256: original.sha256 }
      const service = createProfileService({
        ...f.adapters,
        read: (value) => store.read(value),
        save: (name, text) => store.save(name, text),
        confirm: async () => true
      })
      const prepared = await service.prepareNodeEdit({
        profile: selection,
        action: 'add',
        node: proxy('C')
      })
      const result = await service.save({ evidenceId: prepared.evidenceId })
      expect(result.status).toBe('saved')
      expect(result.profile?.id).not.toBe(original.id)
      if (!result.profile) throw new Error('new profile missing')
      expect((await store.read(selection)).text).toBe(f.source.text)
      expect(
        JSON.parse(
          (await store.read({ id: result.profile.id, sha256: result.profile.sha256 })).text
        ).proxies
      ).toHaveLength(3)
      expect((await store.list()).profiles).toHaveLength(2)
      const child = { id: result.profile.id, sha256: result.profile.sha256 }
      const groupProof = await service.prepareNodeEdit(
        {
          profile: child,
          action: 'update',
          originalName: 'Group',
          group: { name: 'Group', type: 'select', proxies: ['DIRECT'], hidden: false }
        },
        'groups'
      )
      const groupResult = await service.save({ evidenceId: groupProof.evidenceId })
      if (!groupResult.profile) throw new Error('group profile missing')
      const groupSaved = JSON.parse(
        (await store.read({ id: groupResult.profile.id, sha256: groupResult.profile.sha256 })).text
      )
      expect(groupSaved.proxies).toHaveLength(3)
      expect(groupSaved['proxy-groups'][0]).toEqual({
        name: 'Group',
        type: 'select',
        proxies: ['DIRECT'],
        hidden: false
      })
      expect(JSON.parse((await store.read(selection)).text)['proxy-groups']).toEqual(
        f.data['proxy-groups']
      )
      expect((await store.list()).profiles).toHaveLength(3)
      const ruleProof = await service.prepareRules({
        profile: selection,
        rules: ['DOMAIN,example.test,DIRECT', 'MATCH,Group']
      })
      const ruleResult = await service.save({ evidenceId: ruleProof.evidenceId })
      if (!ruleResult.profile) throw new Error('rule profile missing')
      const ruleSaved = JSON.parse(
        (await store.read({ id: ruleResult.profile.id, sha256: ruleResult.profile.sha256 })).text
      )
      expect(ruleSaved.rules).toEqual(['DOMAIN,example.test,DIRECT', 'MATCH,Group'])
      expect(ruleSaved.proxies).toEqual(f.data.proxies)
      expect((await store.read(selection)).text).toBe(f.source.text)
      expect((await store.list()).profiles).toHaveLength(4)
      const providerProof = await service.prepareRuleProviders({
        profile: selection,
        providers: { RP: { type: 'inline', behavior: 'domain', payload: ['example.test'] } }
      })
      const providerResult = await service.save({ evidenceId: providerProof.evidenceId })
      if (!providerResult.profile) throw new Error('provider profile missing')
      const providerSaved = JSON.parse(
        (await store.read({ id: providerResult.profile.id, sha256: providerResult.profile.sha256 }))
          .text
      )
      expect(providerSaved['rule-providers']).toEqual({
        RP: { type: 'inline', behavior: 'domain', payload: ['example.test'] }
      })
      expect(providerSaved.rules).toEqual(f.data.rules)
      expect((await store.read(selection)).text).toBe(f.source.text)
      expect((await store.list()).profiles).toHaveLength(5)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('Inactive proxy-group management', () => {
  const group = (name: string) => ({ name, type: 'select', proxies: ['DIRECT'], lazy: false })
  it('reads detached groups and reference names without exposing private node fields or loading providers', async () => {
    const f = nodeFixture(),
      result = await f.service.readGroups(f.selection)
    expect(result.targets).toEqual(expect.arrayContaining(['DIRECT', 'A', 'B', 'Group']))
    expect(result.providers).toEqual(['preserved'])
    expect(JSON.stringify(result)).not.toContain('private-fixture')
    result.groups[0].name = 'changed'
    expect(JSON.parse(f.source.text)['proxy-groups'][0].name).toBe('Group')
    expect(f.adapters.read).toHaveBeenCalledTimes(1)
  })
  it('adds and updates groups while preserving nodes, rule priority, resource paths and false options', async () => {
    for (const action of ['add', 'update'] as const) {
      const f = nodeFixture()
      f.adapters.confirm.mockResolvedValue(true)
      const changed = group(action === 'add' ? 'New' : 'Group')
      const proof = await f.service.prepareNodeEdit(
        {
          profile: f.selection,
          action,
          group: changed,
          ...(action === 'update' ? { originalName: 'Group' } : {})
        },
        'groups'
      )
      expect(f.adapters.save).not.toHaveBeenCalled()
      expect((await f.service.save({ evidenceId: proof.evidenceId })).status).toBe('saved')
      const saved = JSON.parse(f.adapters.save.mock.calls[0][1])
      expect(saved.proxies).toEqual(f.data.proxies)
      expect(saved.rules).toEqual(f.data.rules)
      expect(saved['proxy-providers']).toEqual(f.data['proxy-providers'])
      expect(
        saved['proxy-groups'].find((value: { name: string }) => value.name === changed.name)
      ).toEqual(changed)
    }
  })
  it('rejects missing members/providers, cycles, duplicate names, unsupported options and implicit health probes', async () => {
    const f = nodeFixture()
    for (const changed of [
      { ...group('New'), proxies: ['Missing'] },
      { ...group('New'), use: ['Missing'] },
      group('A'),
      group('DIRECT'),
      { ...group('New'), type: 'url-test' },
      { ...group('New'), unknown: true },
      { ...group('New'), type: 'smart', 'prefer-asn': true }
    ])
      await expect(
        f.service.prepareNodeEdit({ profile: f.selection, action: 'add', group: changed }, 'groups')
      ).rejects.toThrow('代理组编辑未通过')
    await expect(
      f.service.prepareNodeEdit(
        {
          profile: f.selection,
          action: 'update',
          originalName: 'Group',
          group: { ...group('Group'), proxies: ['Group'] }
        },
        'groups'
      )
    ).rejects.toThrow('循环引用')
    const proof = await f.service.prepareNodeEdit(
      {
        profile: f.selection,
        action: 'add',
        group: { ...group('ExplicitHealth'), type: 'url-test', url: 'https://health.example/204' }
      },
      'groups'
    )
    expect(proof.inspection.structure).toBe('passed')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('blocks referenced group removal and renames but can remove an unreferenced group after confirmation', async () => {
    const f = nodeFixture()
    await expect(
      f.service.prepareNodeEdit(
        { profile: f.selection, action: 'remove', originalName: 'Group' },
        'groups'
      )
    ).rejects.toThrow('已引用')
    await expect(
      f.service.prepareNodeEdit(
        { profile: f.selection, action: 'update', originalName: 'Group', group: group('Renamed') },
        'groups'
      )
    ).rejects.toThrow('保留名称')
    f.source.text = JSON.stringify({
      ...f.data,
      'proxy-groups': [...f.data['proxy-groups'], group('Spare')]
    })
    const prepared = await f.service.prepareNodeEdit(
      { profile: f.selection, action: 'remove', originalName: 'Spare' },
      'groups'
    )
    f.adapters.confirm.mockResolvedValue(true)
    expect((await f.service.save({ evidenceId: prepared.evidenceId })).status).toBe('saved')
    expect(
      JSON.parse(f.adapters.save.mock.calls[0][1])['proxy-groups'].map(
        (value: { name: string }) => value.name
      )
    ).toEqual(['Group'])
  })
  it('requires an exact group-name permutation and preserves every group record when reordering', async () => {
    const f = nodeFixture(),
      spare = group('Spare')
    f.source.text = JSON.stringify({
      ...f.data,
      'proxy-groups': [...f.data['proxy-groups'], spare]
    })
    for (const order of [
      ['Group'],
      ['Group', 'Group'],
      ['Group', 'Unknown'],
      ['Group', 'Spare', 'Added'],
      [1, 'Spare']
    ])
      await expect(
        f.service.prepareNodeEdit({ profile: f.selection, action: 'reorder', order }, 'groups')
      ).rejects.toThrow('排列')
    await expect(
      f.service.prepareNodeEdit({
        profile: f.selection,
        action: 'reorder',
        order: ['Spare', 'Group']
      })
    ).rejects.toThrow('节点编辑未通过')
    const prepared = await f.service.prepareNodeEdit(
      { profile: f.selection, action: 'reorder', order: ['Spare', 'Group'] },
      'groups'
    )
    f.adapters.confirm.mockResolvedValue(true)
    await f.service.save({ evidenceId: prepared.evidenceId })
    const saved = JSON.parse(f.adapters.save.mock.calls[0][1])
    expect(saved['proxy-groups']).toEqual([spare, f.data['proxy-groups'][0]])
    expect(saved.rules).toEqual(f.data.rules)
    expect(saved.proxies).toEqual(f.data.proxies)
  })
  it('holds group reads in the common quit barrier and rejects excessive groups and cross-collection payload fields', async () => {
    const f = nodeFixture(),
      pending = Promise.withResolvers<typeof f.source>()
    f.adapters.read.mockImplementationOnce(() => pending.promise)
    const reading = f.service.readGroups(f.selection),
      idle = vi.fn(),
      waiting = f.service.whenIdle().then(idle)
    await expect(f.service.readNodes(f.selection)).rejects.toThrow('先完成')
    expect(idle).not.toHaveBeenCalled()
    pending.resolve(f.source)
    await reading
    await waiting
    await expect(
      f.service.prepareNodeEdit(
        { profile: f.selection, action: 'add', node: group('New') },
        'groups'
      )
    ).rejects.toThrow('代理组编辑未通过')
    f.source.text = JSON.stringify({
      'proxy-groups': Array.from({ length: 501 }, (_, index) => group(`Group${index}`))
    })
    await expect(f.service.readGroups(f.selection)).rejects.toThrow('500')
  })
})

describe('Inactive rule-list editing', () => {
  it('reads only rule strings and reference names without loading resources or exposing node passwords', async () => {
    const f = nodeFixture(),
      result = await f.service.readRules(f.selection)
    expect(result.rules).toEqual(['MATCH,Group'])
    expect(result.targets).toEqual(expect.arrayContaining(['DIRECT', 'A', 'Group']))
    expect(result.providers).toEqual([])
    expect(JSON.stringify(result)).not.toContain('private-fixture')
    result.rules[0] = 'MATCH,REJECT'
    expect(JSON.parse(f.source.text).rules).toEqual(['MATCH,Group'])
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('preserves exact priority and duplicate rules while keeping all other configuration values', async () => {
    const f = nodeFixture(),
      rules = [
        'DOMAIN,example.test,Group',
        'IP-CIDR,192.0.2.0/24,DIRECT,no-resolve',
        'DOMAIN,example.test,Group',
        'MATCH,REJECT'
      ]
    const prepared = await f.service.prepareRules({ profile: f.selection, rules })
    expect(prepared.inspection.coreCompatibility).toBe('notVerified')
    expect(f.adapters.save).not.toHaveBeenCalled()
    f.adapters.confirm.mockResolvedValue(true)
    await f.service.save({ evidenceId: prepared.evidenceId })
    const saved = JSON.parse(f.adapters.save.mock.calls[0][1])
    expect(saved).toEqual({ ...f.data, rules })
    expect(JSON.parse(f.source.text)).toEqual(f.data)
  })
  it('reuses logical rule and nested rule-set parsing and accepts only existing sub-rule targets', async () => {
    const f = nodeFixture()
    f.source.text = JSON.stringify({
      ...f.data,
      'rule-providers': { RP: { type: 'inline', behavior: 'domain', payload: ['example.test'] } },
      'sub-rules': { child: ['MATCH,DIRECT'] }
    })
    const valid = [
      'RULE-SET,RP,Group',
      'AND,((RULE-SET,RP),(NETWORK,TCP)),Group',
      'SUB-RULE,(NETWORK,TCP),child',
      'MATCH,DIRECT'
    ]
    expect(
      (await f.service.prepareRules({ profile: f.selection, rules: valid })).inspection.structure
    ).toBe('passed')
    for (const rules of [
      ['AND,((RULE-SET,Missing),(NETWORK,TCP)),Group'],
      ['SUB-RULE,(NETWORK,TCP),Missing']
    ])
      await expect(f.service.prepareRules({ profile: f.selection, rules })).rejects.toThrow('引用')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('rejects invalid references, conflicting modifiers, unsafe lists and excessive logical depth', async () => {
    const f = nodeFixture()
    for (const rules of [
      ['DOMAIN,example.test,Missing'],
      ['RULE-SET,Missing,Group'],
      ['UNKNOWN,example.test,Group'],
      ['MATCH'],
      [''],
      ['IP-CIDR,192.0.2.0/24,DIRECT,src,no-resolve'],
      ['AND,((NETWORK,TCP),Group'],
      ['MATCH,DIRECT\nMATCH,REJECT'],
      ['DOMAIN,' + 'x'.repeat(8192) + ',DIRECT'],
      Array(10001).fill('MATCH,DIRECT'),
      ['AND,' + '('.repeat(33) + 'NETWORK,TCP' + ')'.repeat(33) + ',DIRECT']
    ])
      await expect(f.service.prepareRules({ profile: f.selection, rules })).rejects.toThrow(
        '规则编辑未通过'
      )
    await expect(
      f.service.prepareRules({ profile: f.selection, rules: [], path: '/private' })
    ).rejects.toThrow('规则编辑未通过')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('allows explicit empty-rule copies, consumes failed preparations and rejects source revisions changed during native confirmation', async () => {
    const f = nodeFixture(),
      empty = await f.service.prepareRules({ profile: f.selection, rules: [] })
    f.adapters.confirm.mockResolvedValue(true)
    await f.service.save({ evidenceId: empty.evidenceId })
    expect(JSON.parse(f.adapters.save.mock.calls[0][1]).rules).toEqual([])
    const pending = await f.service.prepareRules({ profile: f.selection, rules: ['MATCH,Group'] })
    f.adapters.confirm.mockImplementation(async () => {
      f.source.revision = 'changed'
      return true
    })
    expect((await f.service.save({ evidenceId: pending.evidenceId })).status).toBe('failed')
    expect(f.adapters.save).toHaveBeenCalledTimes(1)
    await expect(
      f.service.prepareRules({ profile: f.selection, rules: ['MATCH,Unknown'] })
    ).rejects.toThrow()
    await expect(f.service.save({ evidenceId: pending.evidenceId })).rejects.toThrow('重新选择')
  })
  it('holds rule reads in the shared busy barrier and releases it after a failed source read', async () => {
    const f = nodeFixture(),
      finish = Promise.withResolvers<typeof f.source>()
    f.adapters.read.mockImplementationOnce(() => finish.promise)
    const reading = f.service.readRules(f.selection),
      idle = vi.fn(),
      waiting = f.service.whenIdle().then(idle)
    await expect(f.service.prepareRules({ profile: f.selection, rules: [] })).rejects.toThrow(
      '先完成'
    )
    expect(idle).not.toHaveBeenCalled()
    finish.reject(new Error('private-source-error'))
    await expect(reading).rejects.toThrow('未能读取规则草稿')
    await waiting
    expect(f.service.isBusy()).toBe(false)
  })
})

describe('Inactive rule-provider definition editing', () => {
  const provider = { type: 'inline', behavior: 'domain', payload: ['example.test'] }
  it('reads private definitions explicitly and returns detached values without reading resource contents', async () => {
    const f = nodeFixture()
    f.source.text = JSON.stringify({ ...f.data, 'rule-providers': { RP: provider } })
    const result = await f.service.readRuleProviders(f.selection)
    expect(result.providers).toEqual({ RP: provider })
    result.providers.RP.payload = ['changed']
    expect(JSON.parse(f.source.text)['rule-providers'].RP.payload).toEqual(['example.test'])
    expect(f.adapters.read).toHaveBeenCalledTimes(1)
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('accepts fixed inline/HTTP/file definitions and preserves other data and false options in the saved copy', async () => {
    const f = nodeFixture(),
      providers = {
        RP: provider,
        HTTP: {
          type: 'http',
          behavior: 'domain',
          url: 'https://rules.example/never-fetched.yaml',
          path: './not-read.yaml',
          interval: 3600,
          proxy: 'DIRECT'
        },
        File: { type: 'file', behavior: 'classical', path: './not-opened.yaml' }
      }
    const prepared = await f.service.prepareRuleProviders({ profile: f.selection, providers })
    expect(f.adapters.save).not.toHaveBeenCalled()
    f.adapters.confirm.mockResolvedValue(true)
    expect((await f.service.save({ evidenceId: prepared.evidenceId })).status).toBe('saved')
    expect(JSON.parse(f.adapters.save.mock.calls[0][1])).toEqual({
      ...f.data,
      'rule-providers': providers
    })
    expect(prepared.inspection.coreCompatibility).toBe('notVerified')
  })
  it('blocks removal from top-level/logical/sub rules, DNS selector keys and TUN route arrays', async () => {
    for (const reference of [
      { rules: ['RULE-SET,RP,DIRECT'] },
      { rules: ['AND,((RULE-SET,RP),(NETWORK,TCP)),DIRECT'] },
      { 'sub-rules': { child: ['RULE-SET,RP,DIRECT'] } },
      { dns: { 'nameserver-policy': { 'rule-set:RP': ['https://resolver.example/dns-query'] } } },
      { tun: { 'route-address-set': ['RP'] } }
    ]) {
      const f = nodeFixture()
      f.source.text = JSON.stringify({
        ...f.data,
        'rule-providers': { RP: provider },
        ...reference
      })
      await expect(
        f.service.prepareRuleProviders({ profile: f.selection, providers: {} })
      ).rejects.toThrow('可能引用')
      expect(f.adapters.save).not.toHaveBeenCalled()
    }
  })
  it('allows removal of an unreferenced definition but keeps source revision verification at native save', async () => {
    const f = nodeFixture()
    f.source.text = JSON.stringify({ ...f.data, 'rule-providers': { UnusedResource: provider } })
    const first = await f.service.prepareRuleProviders({ profile: f.selection, providers: {} })
    expect((await f.service.save({ evidenceId: first.evidenceId })).status).toBe('cancelled')
    f.adapters.confirm.mockImplementation(async () => {
      f.source.revision = 'changed'
      return true
    })
    expect((await f.service.save({ evidenceId: first.evidenceId })).status).toBe('failed')
    expect(f.adapters.save).not.toHaveBeenCalled()
    const next = await f.service.prepareRuleProviders({ profile: f.selection, providers: {} })
    f.adapters.confirm.mockResolvedValue(true)
    expect((await f.service.save({ evidenceId: next.evidenceId })).status).toBe('saved')
    expect(JSON.parse(f.adapters.save.mock.calls[0][1])['rule-providers']).toEqual({})
  })
  it('rejects unknown fields, wrong types, invalid names, limits and unknown download proxy targets', async () => {
    const f = nodeFixture()
    for (const providers of [
      { RP: { ...provider, unknown: true } },
      { RP: { ...provider, interval: 'bad' } },
      { 'bad,name': provider },
      { ' trimmed ': provider },
      { RP: null },
      [],
      { RP: { ...provider, proxy: 'Missing' } },
      Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`Provider${index}`, provider])),
      { RP: { ...provider, payload: ['x'.repeat(512 * 1024)] } }
    ])
      await expect(
        f.service.prepareRuleProviders({ profile: f.selection, providers })
      ).rejects.toThrow('规则提供者编辑未通过')
    await expect(
      f.service.prepareRuleProviders({ profile: f.selection, providers: {}, path: '/private' })
    ).rejects.toThrow()
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('uses the common read barrier and rejects excessive stored provider maps without changing state', async () => {
    const f = nodeFixture(),
      finish = Promise.withResolvers<typeof f.source>()
    f.adapters.read.mockImplementationOnce(() => finish.promise)
    const reading = f.service.readRuleProviders(f.selection),
      idle = vi.fn(),
      waiting = f.service.whenIdle().then(idle)
    await expect(
      f.service.prepareRuleProviders({ profile: f.selection, providers: {} })
    ).rejects.toThrow('先完成')
    expect(idle).not.toHaveBeenCalled()
    finish.resolve(f.source)
    await reading
    await waiting
    f.source.text = JSON.stringify({
      'rule-providers': Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [`Provider${index}`, provider])
      )
    })
    await expect(f.service.readRuleProviders(f.selection)).rejects.toThrow('200')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
})

describe('Native-only saved profile source export', () => {
  it('requires an enabled host and explicit confirmation, and accepts no renderer path or source body', async () => {
    const f = nodeFixture()
    await expect(f.service.export(f.selection)).rejects.toThrow('尚未接通')
    const writeExport = vi.fn(async () => true),
      confirmExport = vi.fn(async () => false)
    const service = createProfileService({ ...f.adapters, confirmExport, writeExport })
    await expect(service.export({ ...f.selection, path: '/private' })).rejects.toThrow('只接受')
    expect(confirmExport).not.toHaveBeenCalled()
    expect(await service.export(f.selection)).toEqual({ status: 'cancelled' })
    expect(writeExport).not.toHaveBeenCalled()
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('writes exact UTF-8 source bytes with comments and CRLF into a real private export file, then clears its temporary buffer', async () => {
    const f = nodeFixture(),
      home = await realpath(await mkdtemp('/private/tmp/relay-profile-export-'))
    f.source.text = '# source comments retained\r\nproxies: []\r\nrules: ["MATCH,DIRECT"]\r\n'
    f.source.profile.sha256 = profileHash(f.source.text)
    f.selection.sha256 = f.source.profile.sha256
    let transient: Buffer | undefined
    const destination = join(home, 'exported.yaml')
    try {
      const service = createProfileService({
        ...f.adapters,
        confirmExport: async () => true,
        writeExport: async (_name, bytes, recheck) => {
          transient = bytes
          await recheck()
          await atomicWriteFile(destination, bytes, { mode: 0o600 })
          return true
        }
      })
      expect(await service.export(f.selection)).toEqual({ status: 'exported' })
      expect(await readFile(destination, 'utf8')).toBe(f.source.text)
      expect((await stat(destination)).mode & 0o777).toBe(0o600)
      expect(transient?.every((byte) => byte === 0)).toBe(true)
      expect(f.adapters.save).not.toHaveBeenCalled()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it('waits through the native save dialog and blocks competing operations until the actual publication completes', async () => {
    const f = nodeFixture(),
      writing = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<boolean>()
    const service = createProfileService({
      ...f.adapters,
      confirmExport: async () => true,
      writeExport: async (_name, _bytes, recheck) => {
        writing.resolve()
        await finish.promise
        await recheck()
        return true
      }
    })
    const pending = service.export(f.selection)
    await writing.promise
    await expect(service.prepare(undefined)).rejects.toThrow('先完成')
    await expect(service.export(f.selection)).rejects.toThrow('先完成')
    const idle = vi.fn(),
      waiting = service.whenIdle().then(idle)
    await Promise.resolve()
    expect(idle).not.toHaveBeenCalled()
    finish.resolve(true)
    expect(await pending).toEqual({ status: 'exported' })
    await waiting
    expect(idle).toHaveBeenCalledOnce()
  })
  it('rechecks the 60-second lifetime after both native confirmation and file selection', async () => {
    for (const stage of ['confirm', 'save'] as const) {
      const f = nodeFixture()
      let clock = 100,
        published = false
      const service = createProfileService({
        ...f.adapters,
        now: () => clock,
        confirmExport: async () => {
          if (stage === 'confirm') clock += 60001
          return true
        },
        writeExport: async (_name, _bytes, recheck) => {
          clock += 60001
          await recheck()
          published = true
          return true
        }
      })
      await expect(service.export(f.selection)).rejects.toThrow('导出未确认')
      expect(published).toBe(false)
      expect(service.isBusy()).toBe(false)
    }
  })
  it('refuses source changes made while either native dialog is open and never leaks private source errors', async () => {
    for (const stage of ['confirm', 'save'] as const) {
      const f = nodeFixture()
      let published = false
      const service = createProfileService({
        ...f.adapters,
        confirmExport: async () => {
          if (stage === 'confirm') f.source.revision = 'changed'
          return true
        },
        writeExport: async (_name, _bytes, recheck) => {
          f.source.text = 'private-changed-source'
          await recheck()
          published = true
          return true
        }
      })
      await expect(service.export(f.selection)).rejects.toThrow(/^配置导出未确认/)
      expect(published).toBe(false)
    }
  })
  it('keeps an independent import proof usable when source export is cancelled', async () => {
    const f = nodeFixture(),
      service = createProfileService({
        ...f.adapters,
        confirmExport: async () => false,
        writeExport: async () => true
      })
    const imported = await service.prepare(undefined)
    expect(await service.export(f.selection)).toEqual({ status: 'cancelled' })
    f.adapters.confirm.mockResolvedValue(true)
    expect((await service.save({ evidenceId: imported?.evidenceId })).status).toBe('saved')
  })
  it('does not return a body or destination when the save dialog is cancelled or fails and clears private buffers', async () => {
    const f = nodeFixture()
    let transient: Buffer | undefined
    const service = createProfileService({
      ...f.adapters,
      confirmExport: async () => true,
      writeExport: async (_name, bytes) => {
        transient = bytes
        return false
      }
    })
    expect(await service.export(f.selection)).toEqual({ status: 'cancelled' })
    expect(transient?.every((byte) => byte === 0)).toBe(true)
    const failed = createProfileService({
      ...f.adapters,
      confirmExport: async () => true,
      writeExport: async (_name, bytes) => {
        transient = bytes
        throw new Error(bytes.toString())
      }
    })
    await expect(failed.export(f.selection)).rejects.toThrow(/^配置导出未确认/)
    expect(transient?.every((byte) => byte === 0)).toBe(true)
  })
})

describe('Inactive blank configuration creation', () => {
  it('prepares the existing pure empty editing modules without reading files or carrying DNS/TUN/listener defaults', async () => {
    const f = nodeFixture(),
      prepared = await f.service.prepareNew({ name: '  Starter  ' })
    expect(prepared.name).toBe('Starter.json')
    expect(prepared.inspection).toMatchObject({
      structure: 'passed',
      coreCompatibility: 'notVerified',
      active: false,
      summary: { proxies: 0, groups: 1, rules: 1 }
    })
    expect(f.adapters.read).not.toHaveBeenCalled()
    expect(f.adapters.pick).not.toHaveBeenCalled()
    expect(f.adapters.save).not.toHaveBeenCalled()
    f.adapters.confirm.mockResolvedValue(true)
    await f.service.save({ evidenceId: prepared.evidenceId })
    const source = JSON.parse(f.adapters.save.mock.calls[0][1])
    expect(source.proxies).toEqual([])
    expect(source.rules).toEqual(['MATCH,PROXY'])
    expect(source['proxy-groups'][0]).toMatchObject({
      name: 'PROXY',
      type: 'select',
      proxies: ['DIRECT']
    })
    for (const field of [
      'dns',
      'tun',
      'mixed-port',
      'listeners',
      'external-controller',
      'secret',
      'sniffer'
    ])
      expect(source).not.toHaveProperty(field)
    expect(f.adapters.save.mock.calls[0][1]).not.toContain('https:')
  })
  it('rejects paths, arbitrary source fields and invalid names while revoking the previous proof', async () => {
    const f = nodeFixture(),
      imported = await f.service.prepare(undefined)
    for (const input of [
      null,
      {},
      { name: '' },
      { name: 'x'.repeat(109) },
      { name: '../file' },
      { name: 'a\\b' },
      { name: 'a\nb' },
      { name: '..' },
      { name: 'Valid', path: '/private' },
      { name: 'Valid', text: 'mode: global' }
    ])
      await expect(f.service.prepareNew(input)).rejects.toThrow('空白配置准备未通过')
    await expect(f.service.save({ evidenceId: imported?.evidenceId })).rejects.toThrow('重新选择')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('keeps native cancellation separate from saving and binds subsequent preparation and expiry', async () => {
    const f = nodeFixture()
    let clock = 100
    const service = createProfileService({ ...f.adapters, now: () => clock })
    const first = await service.prepareNew({ name: 'First' })
    expect((await service.save({ evidenceId: first.evidenceId })).status).toBe('cancelled')
    const second = await service.prepareNew({ name: 'Second' })
    await expect(service.save({ evidenceId: first.evidenceId })).rejects.toThrow('重新选择')
    f.adapters.confirm.mockImplementation(async () => {
      clock += 60001
      return true
    })
    expect((await service.save({ evidenceId: second.evidenceId })).status).toBe('failed')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('shares the existing picker/save busy gate and does not replace a source being handled by another operation', async () => {
    const f = nodeFixture(),
      pending = Promise.withResolvers<ProfileSource | undefined>()
    f.adapters.pick.mockImplementationOnce(() => pending.promise)
    const reading = f.service.prepare(undefined)
    await expect(f.service.prepareNew({ name: 'Blocked' })).rejects.toThrow('先完成')
    pending.resolve(undefined)
    await reading
    expect((await f.service.prepareNew({ name: 'Ready' })).inspection.structure).toBe('passed')
  })
  it('saves a real new private record only after native consent and remains usable as an editable source', async () => {
    const home = await realpath(await mkdtemp('/private/tmp/relay-blank-profile-'))
    try {
      const store = new ProfileStore({
          home,
          stateRoot: join(home, 'Library/Application Support/Relay')
        }),
        f = nodeFixture()
      const service = createProfileService({
        ...f.adapters,
        read: (selection) => store.read(selection),
        save: (name, text) => store.save(name, text),
        confirm: async () => true
      })
      const prepared = await service.prepareNew({ name: 'Blank' }),
        saved = await service.save({ evidenceId: prepared.evidenceId })
      if (!saved.profile) throw new Error('saved blank profile missing')
      expect((await store.list()).profiles).toHaveLength(1)
      const selection = { id: saved.profile.id, sha256: saved.profile.sha256 }
      expect((await service.readNodes(selection)).nodes).toEqual([])
      expect((await service.readGroups(selection)).groups).toHaveLength(1)
      const editing = await service.prepareNodeEdit({
        profile: selection,
        action: 'add',
        node: proxy('FirstNode')
      })
      expect((await service.save({ evidenceId: editing.evidenceId })).status).toBe('saved')
      expect((await store.list()).profiles).toHaveLength(2)
      expect(JSON.parse((await store.read(selection)).text).proxies).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

function snapshotFixture(kind: 'rule-yaml' | 'rule-text' = 'rule-yaml') {
  const f = nodeFixture()
  f.source.text = JSON.stringify({
    ...f.data,
    'rule-providers': {
      RP: {
        type: 'http',
        behavior: 'ipcidr',
        url: 'https://PRIVATE-never-requested.invalid',
        path: '/PRIVATE-never-read',
        interval: 1,
        header: { Authorization: ['PRIVATE'] }
      },
      Keep: { type: 'inline', behavior: 'domain', payload: ['preserved.test'] }
    },
    rules: ['RULE-SET,RP,Group', 'MATCH,REJECT']
  })
  f.source.profile.sha256 = profileHash(f.source.text)
  f.selection.sha256 = f.source.profile.sha256
  const bytes = Buffer.from(
    kind === 'rule-yaml' ? 'payload:\n  - 127.0.0.0/8\n' : '# private fixture\n127.0.0.0/8\n'
  )
  const info: ResourceInfo = {
    name: 'Cached loopback',
    kind,
    behavior: 'ipcidr',
    selector: '',
    id: '00000000-0000-0000-0000-000000000002',
    sha256: resourceHash(bytes),
    size: bytes.length,
    createdAt: '2026-10-29',
    integrity: 'notChecked'
  }
  const asset = { info, bytes, revision: 'asset-revision-1' }
  const adapters = {
    ...f.adapters,
    readRuleResource: vi.fn(async () => ({
      ...asset,
      info: structuredClone(asset.info),
      bytes: Buffer.from(asset.bytes)
    }))
  }
  const request = {
    profile: f.selection,
    provider: 'RP',
    resource: { id: info.id, sha256: info.sha256 }
  }
  return { ...f, asset, adapters, request, service: createProfileService(adapters) }
}
function mrsSnapshotFixture() {
  const f = snapshotFixture(),
    decoded = Buffer.alloc(21 + 1 + 8 + 32)
  decoded.set([77, 82, 83, 1, 1])
  decoded.writeBigInt64BE(1n, 5)
  decoded[21] = 1
  decoded.writeBigInt64BE(1n, 22)
  f.asset.bytes = zstdCompressSync(decoded)
  f.asset.info.kind = 'rule-mrs'
  f.asset.info.size = f.asset.bytes.length
  f.asset.info.sha256 = resourceHash(f.asset.bytes)
  f.request.resource.sha256 = f.asset.info.sha256
  const adapters = {
    ...f.adapters,
    convertRuleMRS: vi.fn(async () => ({ entries: ['127.0.0.0/8'], sourceRules: 1 }))
  }
  return { ...f, adapters, service: createProfileService(adapters) }
}
describe('Controlled rule-resource freezing into an independent profile', () => {
  it('uses the injected MRS worker once, retains confirmation and publishes only controlled inline payload', async () => {
    const f = mrsSnapshotFixture(),
      original = JSON.parse(f.source.text),
      report = await f.service.prepareRuleSnapshot(f.request)
    expect(f.adapters.convertRuleMRS).toHaveBeenCalledExactlyOnceWith({
      descriptor: {
        name: f.asset.info.name,
        kind: 'rule-mrs',
        behavior: 'ipcidr',
        selector: ''
      },
      bytes: f.asset.bytes,
      sha256: f.asset.info.sha256
    })
    expect(report.ruleSnapshot).toMatchObject({ rules: 1, resourceSHA256: f.asset.info.sha256 })
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe('cancelled')
    expect(f.adapters.save).not.toHaveBeenCalled()
    f.adapters.confirm.mockResolvedValue(true)
    expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe('saved')
    const saved = JSON.parse(f.adapters.save.mock.calls[0][1])
    expect(saved['rule-providers'].RP).toEqual({
      type: 'inline',
      behavior: 'ipcidr',
      payload: ['127.0.0.0/8']
    })
    expect(saved['rule-providers'].Keep).toEqual(original['rule-providers'].Keep)
    expect(saved.rules).toEqual(original.rules)
    expect(JSON.parse(f.source.text)).toEqual(original)
    expect(f.adapters.convertRuleMRS).toHaveBeenCalledTimes(1)
  })
  it('never invokes the MRS worker for YAML/text and rejects MRS without a worker or supported behavior', async () => {
    for (const kind of ['rule-yaml', 'rule-text'] as const) {
      const f = snapshotFixture(kind),
        convertRuleMRS = vi.fn(async () => ({ entries: ['127.0.0.0/8'], sourceRules: 1 })),
        service = createProfileService({ ...f.adapters, convertRuleMRS })
      await service.prepareRuleSnapshot(f.request)
      expect(convertRuleMRS).not.toHaveBeenCalled()
    }
    const f = mrsSnapshotFixture(),
      service = createProfileService({ ...f.adapters, convertRuleMRS: undefined })
    await expect(service.prepareRuleSnapshot(f.request)).rejects.toThrow('固化未通过')
    const data = JSON.parse(f.source.text)
    data['rule-providers'].RP.behavior = 'classical'
    f.source.text = JSON.stringify(data)
    f.selection.sha256 = profileHash(f.source.text)
    f.asset.info.behavior = 'classical'
    await expect(f.service.prepareRuleSnapshot(f.request)).rejects.toThrow('固化未通过')
    expect(f.adapters.convertRuleMRS).not.toHaveBeenCalled()
  })
  it('rejects worker failure or unsupported output, clears old preparation and releases the shared operation gate', async () => {
    for (const outcome of ['failure', 'empty', 'geodata', 'budget'] as const) {
      const f = mrsSnapshotFixture(),
        previous = await f.service.prepareRuleSnapshot(f.request)
      if (outcome === 'failure')
        f.adapters.convertRuleMRS.mockRejectedValueOnce(new Error('PRIVATE-worker-details'))
      else
        f.adapters.convertRuleMRS.mockResolvedValueOnce({
          entries:
            outcome === 'empty'
              ? []
              : outcome === 'geodata'
                ? ['GEOIP,CN']
                : Array(20001).fill('127.0.0.0/8'),
          sourceRules: 1
        })
      await expect(f.service.prepareRuleSnapshot(f.request)).rejects.toThrow('固化未通过')
      await expect(f.service.save({ evidenceId: previous.evidenceId })).rejects.toThrow('重新选择')
      expect(f.adapters.save).not.toHaveBeenCalled()
      expect(f.service.isBusy()).toBe(false)
      expect((await f.service.prepareRuleSnapshot(f.request)).inspection.structure).toBe('passed')
    }
  })
  it('holds the busy/quit barrier throughout MRS conversion and rechecks cached MRS before publication', async () => {
    const f = mrsSnapshotFixture(),
      conversion = Promise.withResolvers<{ entries: string[]; sourceRules: number }>()
    f.adapters.convertRuleMRS.mockImplementationOnce(() => conversion.promise)
    const pending = f.service.prepareRuleSnapshot(f.request)
    await vi.waitFor(() => expect(f.adapters.convertRuleMRS).toHaveBeenCalled())
    await expect(f.service.prepareNew({ name: 'Blocked' })).rejects.toThrow('先完成')
    const idle = vi.fn(),
      waiting = f.service.whenIdle().then(idle)
    expect(idle).not.toHaveBeenCalled()
    conversion.resolve({ entries: ['127.0.0.0/8'], sourceRules: 1 })
    const report = await pending
    await waiting
    expect(idle).toHaveBeenCalledTimes(1)
    f.adapters.confirm.mockImplementation(async () => {
      f.asset.bytes = Buffer.from('changed during confirmation')
      return true
    })
    expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe('failed')
    expect(f.adapters.save).not.toHaveBeenCalled()
    expect(f.adapters.convertRuleMRS).toHaveBeenCalledTimes(1)
  })
  it('prepares redacted transformation evidence and performs no save or original URL/path access', async () => {
    const f = snapshotFixture(),
      report = await f.service.prepareRuleSnapshot(f.request)
    expect(report.ruleSnapshot).toEqual({
      provider: 'RP',
      behavior: 'ipcidr',
      rules: 1,
      resourceSHA256: f.asset.info.sha256
    })
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect(f.adapters.readRuleResource).toHaveBeenCalledWith(f.request.resource)
    expect(f.adapters.save).not.toHaveBeenCalled()
    expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe('cancelled')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('freezes YAML and text payloads, removing only the selected provider acquisition options', async () => {
    for (const kind of ['rule-yaml', 'rule-text'] as const) {
      const f = snapshotFixture(kind),
        original = JSON.parse(f.source.text),
        report = await f.service.prepareRuleSnapshot(f.request)
      f.adapters.confirm.mockResolvedValue(true)
      expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe('saved')
      const saved = JSON.parse(f.adapters.save.mock.calls[0][1])
      expect(saved['rule-providers'].RP).toEqual({
        type: 'inline',
        behavior: 'ipcidr',
        payload: ['127.0.0.0/8']
      })
      expect(saved['rule-providers'].Keep).toEqual(original['rule-providers'].Keep)
      expect(saved.proxies).toEqual(original.proxies)
      expect(saved.rules).toEqual(original.rules)
      expect(JSON.parse(f.source.text)).toEqual(original)
      expect(f.adapters.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ ruleSnapshot: report.ruleSnapshot })
      )
    }
  })
  it('revalidates both source and resource metadata/body immediately before publication', async () => {
    for (const stage of ['source', 'resource-metadata', 'resource-body'] as const) {
      const f = snapshotFixture(),
        report = await f.service.prepareRuleSnapshot(f.request)
      f.adapters.confirm.mockImplementation(async () => {
        if (stage === 'source') f.source.revision = 'changed'
        else if (stage === 'resource-metadata') f.asset.revision = 'changed'
        else f.asset.bytes = Buffer.from('127.1.1.1/32')
        return true
      })
      expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe('failed')
      expect(f.adapters.save).not.toHaveBeenCalled()
    }
  })
  it('rejects mismatched behavior, MRS/opaque resources, invalid UTF-8 and incorrect or oversized bytes', async () => {
    for (const change of ['behavior', 'mrs', 'opaque', 'utf8', 'digest', 'size'] as const) {
      const f = snapshotFixture()
      if (change === 'behavior') f.asset.info.behavior = 'domain'
      if (change === 'mrs') f.asset.info.kind = 'rule-mrs'
      if (change === 'opaque') f.asset.info.kind = 'runtime-file'
      if (change === 'utf8') {
        f.asset.bytes = Buffer.from([0xff])
        f.asset.info.sha256 = resourceHash(f.asset.bytes)
        f.request.resource.sha256 = f.asset.info.sha256
      }
      if (change === 'digest') f.asset.bytes = Buffer.from('changed')
      if (change === 'size') f.asset.bytes = Buffer.alloc(2 * 1024 * 1024 + 1)
      await expect(f.service.prepareRuleSnapshot(f.request)).rejects.toThrow('固化未通过')
      expect(f.adapters.save).not.toHaveBeenCalled()
    }
    const f = snapshotFixture()
    await expect(
      f.service.prepareRuleSnapshot({ ...f.request, path: '/private' })
    ).rejects.toThrow()
    await expect(
      f.service.prepareRuleSnapshot({ ...f.request, provider: 'Missing' })
    ).rejects.toThrow()
  })
  it('keeps resource reads behind the shared busy/quit gate and rejects GEO-dependent classical snapshots', async () => {
    const f = snapshotFixture(),
      finish = Promise.withResolvers<typeof f.asset>()
    f.adapters.readRuleResource.mockImplementationOnce(() => finish.promise)
    const pending = f.service.prepareRuleSnapshot(f.request)
    await vi.waitFor(() => expect(f.adapters.readRuleResource).toHaveBeenCalled())
    await expect(f.service.prepareNew({ name: 'Blocked' })).rejects.toThrow('先完成')
    const idle = vi.fn(),
      waiting = f.service.whenIdle().then(idle)
    expect(idle).not.toHaveBeenCalled()
    finish.resolve(f.asset)
    await pending
    await waiting
    const original = JSON.parse(f.source.text)
    original['rule-providers'].RP.behavior = 'classical'
    f.source.text = JSON.stringify(original)
    f.selection.sha256 = profileHash(f.source.text)
    f.asset.info.behavior = 'classical'
    f.asset.bytes = Buffer.from('payload: ["GEOIP,CN"]')
    f.asset.info.sha256 = resourceHash(f.asset.bytes)
    f.request.resource.sha256 = f.asset.info.sha256
    await expect(f.service.prepareRuleSnapshot(f.request)).rejects.toThrow('固化未通过')
  })
  it('applies a strict metadata-before-read budget while keeping default resource reads compatible', async () => {
    const home = await realpath(await mkdtemp('/private/tmp/relay-rule-cache-budget-'))
    try {
      const store = new ResourceStore({
        home,
        stateRoot: join(home, 'Library/Application Support/Relay')
      })
      const info = await store.save(
        { name: 'Budget', kind: 'rule-text', behavior: 'domain', selector: '' },
        Buffer.from('example.test')
      )
      const selection = { id: info.id, sha256: info.sha256 }
      await expect(store.read(selection, 1)).rejects.toThrow('私有资源摘要')
      await expect(store.read(selection, 0)).rejects.toThrow('私有资源摘要')
      expect((await store.read(selection, info.size)).bytes.toString()).toBe('example.test')
      expect((await store.read(selection)).bytes.toString()).toBe('example.test')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
