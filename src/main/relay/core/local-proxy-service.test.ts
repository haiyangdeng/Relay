import { describe, expect, it, vi } from 'vitest'
import { profileRuntimeSource } from '../__fixtures__/profile-runtime'
import { profileHash } from '../profiles/source'
import { resourceHash } from '../resources/source'
import { analyzeProfile, inspectProfile } from '../profiles/inspect'
import { MissingRuntimeGeoDataError, type RuntimeProfileRead } from '../configuration/edit-service'
import type { RuntimeAsset } from '../configuration/bindings'
import type { LocalProxyState, LocalResolverMode } from '../../../shared/relay/local-proxy'
import type { LocalProxyPorts } from '../../../shared/relay/local-proxy-ports'
import type { RelayCoreMode } from '../../../shared/relay/core'
import type { DedicatedListenerPlan } from '../../../shared/relay/dedicated-listeners'
import type { OwnedTrafficSample } from './owned-traffic'
import { createLocalProxyService } from './local-proxy-service'
import { localProxyConfiguration } from './local-proxy-runtime'
import type {
  RelayOwnedCore,
  OwnedCoreProfileOwner,
  OwnedCoreTrafficGuards,
  OwnedCoreCleanupRegistration
} from './owned-runtime'
import type { CoreStoreLease, CoreStoreSnapshot } from './store'
import type { SmartLearningStopResult } from './smart-state-runtime'

describe('Local proxy preparation diagnostics', () => {
  it('identifies missing local databases without acquiring a core', async () => {
    const f = fixture()
    const missing = new MissingRuntimeGeoDataError(['geosite-dat', 'country-mmdb'])
    f.adapters.read.mockRejectedValue(missing)
    await expect(f.service.prepare({ profile: f.selection, httpPort: 18191 })).rejects.toThrow(
      missing.message
    )
    expect(f.adapters.acquire).not.toHaveBeenCalled()
    expect(f.adapters.start).not.toHaveBeenCalled()
    expect(f.service.state().pending).toBe(false)
  })

  it('does not expose arbitrary reader errors containing private configuration', async () => {
    const f = fixture()
    f.adapters.read.mockRejectedValue(new Error('https://private.invalid/?token=private-token'))
    const failure = await f.service
      .prepare({ profile: f.selection, httpPort: 18191 })
      .catch((e) => e)
    expect(failure.message).toContain('本地代理准备未完成')
    expect(failure.message).not.toContain('private')
    expect(f.adapters.acquire).not.toHaveBeenCalled()
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
})

describe('Saved dedicated startup plan admission', () => {
  it.each([18191, 18193, 18190])(
    'refuses occupied port %i without choosing a replacement',
    async (occupied) => {
      const f = fixture()
      f.adapters.portAvailable.mockImplementation(async (port: number) => port !== occupied)
      const report = await f.service.prepare({
        profile: f.selection,
        httpPort: 18191,
        resolverMode: 'off',
        dedicated: { httpPort: 18193, socksPort: 18190, route: 'Node' }
      })
      expect(report.canStart).toBe(false)
      expect(report.dedicated).toMatchObject({ httpPort: 18193, socksPort: 18190, route: 'Node' })
      expect(f.adapters.start).not.toHaveBeenCalled()
      expect(f.adapters.acquire).not.toHaveBeenCalled()
      expect(f.adapters.portAvailable.mock.calls.flat()).not.toContain(7890)
    }
  )
  it('refuses a saved dedicated node absent from the selected profile before core acquisition', async () => {
    const f = fixture()
    await expect(
      f.service.prepare({
        profile: f.selection,
        httpPort: 18191,
        resolverMode: 'off',
        dedicated: { httpPort: 18193, socksPort: 18190, route: 'absent-fixed-node' }
      })
    ).rejects.toThrow('本地代理准备未完成')
    expect(f.adapters.start).not.toHaveBeenCalled()
    expect(f.adapters.acquire).not.toHaveBeenCalled()
  })
})

// Shape verified from fixed462 Smart.Now/MarshalJSON and the real Unix reply.
function smartAutomaticFixture(sentinelMember = false) {
  const f = fixture(),
    original = f.read.getMockImplementation()
  if (!original) throw new Error('missing synthetic reader')
  const text = f.stored.text
    .replace(
      'type: select, proxies:',
      'type: smart, url: "http://127.0.0.1:19002/health", proxies:'
    )
    .replaceAll('Node', sentinelMember ? 'Smart - Select' : 'Node')
  const inspected = inspectProfile(text)
  if (!inspected.summary) throw new Error('Smart fixture summary missing')
  f.stored.text = text
  f.stored.profile.sha256 = profileHash(text)
  f.stored.profile.summary = inspected.summary
  f.selection.sha256 = f.stored.profile.sha256
  let now: unknown = 'Smart - Select',
    fixed: unknown = '',
    all: unknown = [sentinelMember ? 'Smart - Select' : 'Node', 'DIRECT'],
    type = 'Smart'
  f.read.mockImplementation(async (endpoint) =>
    endpoint === 'proxies' ? { proxies: { Group: { type, now, fixed, all } } } : original(endpoint)
  )
  const select = vi.fn(async (_group: string, member: string) => {
    now = member
    fixed = member
  })
  const automatic = vi.fn(async () => {
    now = 'Smart - Select'
    fixed = ''
  })
  f.session.select = select
  f.session.automatic = automatic
  f.session.group = async () => ({ type, now, fixed, all })
  return {
    ...f,
    select,
    automatic,
    set: (value: { now?: unknown; fixed?: unknown; all?: unknown; type?: string }) => {
      if (Object.hasOwn(value, 'now')) now = value.now
      if (Object.hasOwn(value, 'fixed')) fixed = value.fixed
      if (Object.hasOwn(value, 'all')) all = value.all
      if (Object.hasOwn(value, 'type')) type = value.type ?? type
    }
  }
}

describe('Bound local Geo runtime ownership', () => {
  function geography(f: ReturnType<typeof fixture>): void {
    const bytes = Buffer.from('synthetic saved site database')
    f.stored.text = f.stored.text.replace('rules: [', "rules: ['GEOSITE,CN,Group', ")
    f.stored.profile.sha256 = profileHash(f.stored.text)
    f.selection.sha256 = f.stored.profile.sha256
    f.stored.runtimeAssets = [{ path: 'GeoSite.dat', bytes, sha256: resourceHash(bytes) }]
  }
  it('passes fixed assets to core selection/start and refuses a changed library before reload confirmation', async () => {
    const f = reloadFixture()
    geography(f)
    await start(f)
    expect(f.service.state().phase).toBe('running')
    expect(f.adapters.resources).toHaveBeenCalledWith('main', f.stored.runtimeAssets)
    expect(f.adapters.start.mock.calls[0][8]).toEqual(f.stored.runtimeAssets)
    const nextBytes = Buffer.from('different saved site database')
    f.stored.runtimeAssets = [
      { path: 'GeoSite.dat', bytes: nextBytes, sha256: resourceHash(nextBytes) }
    ]
    f.stored.revision = 'd'.repeat(64)
    await expect(
      f.service.prepareReload({ profile: f.selection, httpPort: 18191 })
    ).rejects.toThrow('明确停止本次 Relay')
    expect(f.confirmReload).not.toHaveBeenCalled()
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.service.state().phase).toBe('running')
  })
  it('rechecks the asset revision and core identity after confirmation before delegating start', async () => {
    for (const change of ['asset-revision', 'core-hash'] as const) {
      const f = fixture()
      geography(f)
      const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 })
      f.adapters.confirmStart.mockImplementation(async () => {
        if (change === 'asset-revision') f.stored.revision = 'e'.repeat(64)
        else
          f.adapters.resources.mockResolvedValue({
            executable: '/fixture/core',
            version: 'v1.19.33',
            architecture: 'arm64',
            sha256: 'f'.repeat(64)
          })
        return true
      })
      expect(
        (await f.service.action({ action: 'start', evidenceId: plan.evidenceId })).status
      ).toBe('failed')
      expect(f.adapters.start).not.toHaveBeenCalled()
      expect(f.adapters.acquire).not.toHaveBeenCalled()
    }
  })
  it('passes the unchanged fixed database set through a confirmed reload', async () => {
    const f = reloadFixture()
    geography(f)
    await start(f)
    f.confirmReload.mockResolvedValue(true)
    const plan = await f.service.prepareReload({ profile: f.selection, httpPort: 18191 })
    expect((await f.service.reload({ evidenceId: plan.evidenceId })).status).toBe('reloaded')
    expect(f.reload).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      f.stored.runtimeAssets
    )
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('switches between subscription resource subsets and back without restarting or releasing ownership', async () => {
    const f = reloadFixture()
    geography(f)
    const local = { ...f.stored, profile: { ...f.stored.profile } }
    await start(f)
    f.confirmReload.mockResolvedValue(true)
    const subscription = {
      ...local,
      text: profileRuntimeSource,
      runtimeAssets: [],
      revision: 'd'.repeat(64),
      profile: {
        ...local.profile,
        id: '00000000-0000-0000-0000-000000000002',
        name: 'Subscription',
        sha256: profileHash(profileRuntimeSource)
      }
    }
    for (const stored of [subscription, local, subscription, local]) {
      f.adapters.read.mockResolvedValue(stored)
      const plan = await f.service.prepareReload({
        profile: { id: stored.profile.id, sha256: stored.profile.sha256 },
        httpPort: 18191
      })
      expect((await f.service.reload({ evidenceId: plan.evidenceId })).status).toBe('reloaded')
      expect(f.service.state().profileId).toBe(stored.profile.id)
    }
    expect(f.reload).toHaveBeenCalledTimes(4)
    expect(f.adapters.start).toHaveBeenCalledOnce()
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
  })
  it('admits the inherited routing mode in the post-start observation', async () => {
    const f = fixture()
    f.stored.text += '\nmode: global\n'
    f.stored.profile.sha256 = profileHash(f.stored.text)
    f.selection.sha256 = f.stored.profile.sha256
    await start(f)
    expect(f.service.state().phase).toBe('running')
    expect(f.service.state().mode).toBe('global')
    expect(f.stop).not.toHaveBeenCalled()
  })
})

describe('Fixed Smart automatic now sentinel admission', () => {
  it('starts valid automatic Smart without treating its sentinel as a selected member', async () => {
    const f = smartAutomaticFixture()
    f.adapters.confirmStart.mockResolvedValue(true)
    const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 }),
      result = await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    expect(result.status).toBe('started')
    expect(result.state.groups[0]).toMatchObject({ type: 'smart', fixed: '', confirmed: true })
    expect(result.state.groups[0].now).toBeUndefined()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('keeps explicit select and automatic reset readback coherent', async () => {
    const f = smartAutomaticFixture(),
      id = await start(f)
    expect(
      (await f.service.action({ action: 'select', instanceId: id, group: 'Group', member: 'Node' }))
        .status
    ).toBe('selected')
    expect(f.service.state().groups[0]).toMatchObject({ now: 'Node', fixed: 'Node' })
    expect(
      (await f.service.action({ action: 'automatic', instanceId: id, group: 'Group' })).status
    ).toBe('automatic')
    expect(f.service.state().groups[0].now).toBeUndefined()
    expect(f.service.state().groups[0].fixed).toBe('')
    expect(f.select).toHaveBeenCalledOnce()
    expect(f.automatic).toHaveBeenCalledOnce()
  })
  it.each([
    { now: 'unknown automatic label', fixed: '' },
    { now: 'Smart - Select', fixed: 'Node' },
    { now: 'Smart - Select', fixed: undefined },
    { now: 12, fixed: '' },
    { now: 'Node', fixed: '' },
    { now: 'Node', fixed: 'DIRECT' },
    { now: 'Node', fixed: undefined },
    { now: 'Smart - Select', fixed: '', all: ['Injected'] },
    { now: 'Smart - Select', fixed: '', type: 'Selector' }
  ])('keeps malformed or nonmatching Smart replies closed: %j', async (raw) => {
    const f = smartAutomaticFixture()
    f.set(raw)
    f.adapters.confirmStart.mockResolvedValue(true)
    const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 }),
      result = await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    expect(result.status).toBe('failed')
    expect(f.stop).toHaveBeenCalledOnce()
  })
  it('preserves a real Smart selected member', async () => {
    const f = smartAutomaticFixture()
    f.set({ now: 'Node', fixed: 'Node' })
    await start(f)
    expect(f.service.state().groups[0]).toMatchObject({ now: 'Node', fixed: 'Node' })
  })
  it('keeps a member named like the sentinel distinct from automatic mode', async () => {
    const f = smartAutomaticFixture(true),
      id = await start(f)
    expect(f.service.state().groups[0].now).toBeUndefined()
    expect(
      (
        await f.service.action({
          action: 'select',
          instanceId: id,
          group: 'Group',
          member: 'Smart - Select'
        })
      ).status
    ).toBe('selected')
    expect(f.service.state().groups[0]).toMatchObject({
      now: 'Smart - Select',
      fixed: 'Smart - Select'
    })
    expect(
      (await f.service.action({ action: 'automatic', instanceId: id, group: 'Group' })).status
    ).toBe('automatic')
    expect(f.service.state().groups[0].now).toBeUndefined()
    expect(f.service.state().groups[0].fixed).toBe('')
  })
  it('rejects mismatched fixed state even when the sentinel is also a member', async () => {
    const f = smartAutomaticFixture(true)
    f.set({ fixed: 'DIRECT' })
    f.adapters.confirmStart.mockResolvedValue(true)
    const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 })
    expect((await f.service.action({ action: 'start', evidenceId: plan.evidenceId })).status).toBe(
      'failed'
    )
    expect(f.stop).toHaveBeenCalledOnce()
  })
  it('does not give a normal Selector the Smart automatic exception', async () => {
    const f = fixture(),
      original = f.read.getMockImplementation()
    if (!original) throw new Error('missing ordinary fixture reader')
    f.read.mockImplementation(async (endpoint) =>
      endpoint === 'proxies'
        ? {
            proxies: {
              Group: { type: 'Selector', all: ['Node', 'DIRECT'], now: 'Smart - Select', fixed: '' }
            }
          }
        : original(endpoint)
    )
    f.adapters.confirmStart.mockResolvedValue(true)
    const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 }),
      result = await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    expect(result.status).toBe('failed')
    expect(f.stop).toHaveBeenCalledOnce()
  })
})

function fixture() {
  let selected = 'Node',
    port = 18191,
    child: ReturnType<RelayOwnedCore['state']> = 'running',
    activeSource = profileRuntimeSource,
    resolverMode: LocalResolverMode = 'off',
    activeLogLevel: Parameters<typeof localProxyConfiguration>[4],
    activeAssets: readonly RuntimeAsset[] | undefined,
    activePorts: LocalProxyPorts | undefined,
    activeDedicated: DedicatedListenerPlan | undefined,
    activePinnedNode: Record<string, unknown> | undefined
  const summary = inspectProfile(profileRuntimeSource).summary
  if (!summary) throw new Error('fixture summary missing')
  const selection = {
    id: '00000000-0000-0000-0000-000000000001',
    sha256: profileHash(profileRuntimeSource)
  }
  const stored: RuntimeProfileRead = {
    profile: { ...selection, name: 'Local', createdAt: '2026-10-24', summary },
    text: profileRuntimeSource,
    revision: 'b'.repeat(64)
  }
  const update = vi.fn(async () => {}),
    release = vi.fn(async () => {})
  const read = vi.fn(
    async (endpoint: 'version' | 'configs' | 'proxies'): Promise<Record<string, unknown>> =>
      endpoint === 'configs'
        ? JSON.parse(
            localProxyConfiguration(
              activeSource,
              port,
              resolverMode,
              activeDedicated,
              activeLogLevel,
              activeAssets,
              activePorts,
              activePinnedNode
            ).configuration
          )
        : endpoint === 'version'
          ? { version: 'v1.19.33' }
          : { proxies: { Group: { type: 'Selector', now: selected, all: ['Node', 'DIRECT'] } } }
  )
  const select = vi.fn(async (_group: string, member: string) => {
    selected = member
  })
  const stop = vi.fn(async () => {
    child = 'stopped'
  })
  const session: RelayOwnedCore = {
    pid: 1234,
    directory: '/fixture',
    socket: '/fixture/api.sock',
    version: 'v1.19.33',
    state: () => child,
    read,
    group: async () => ({ now: selected }),
    select,
    stop
  }
  const adapters = {
    read: vi.fn(async (): Promise<RuntimeProfileRead> => ({
      ...structuredClone(stored),
      ...(stored.runtimeAssets
        ? {
            runtimeAssets: stored.runtimeAssets.map((asset) => ({
              ...asset,
              bytes: Buffer.from(asset.bytes)
            }))
          }
        : {})
    })),
    inspect: vi.fn(async (): Promise<CoreStoreSnapshot> => ({
      mode: 'rule',
      revision: 'a'.repeat(64),
      lease: 'missing'
    })),
    resources: vi.fn(async () => ({
      executable: '/fixture/core',
      version: 'v1.19.33',
      architecture: 'arm64' as const,
      sha256: 'c'.repeat(64)
    })),
    portAvailable: vi.fn(async (_port: number) => true),
    portAvailableUDP: vi.fn(async (_port: number) => true),
    acquire: vi.fn(async (): Promise<CoreStoreLease> => ({ update, release })),
    start: vi.fn(
      async (
        _source: string,
        httpPort: number,
        register: OwnedCoreCleanupRegistration,
        mode: LocalResolverMode,
        _dedicated: DedicatedListenerPlan | undefined,
        _owner: OwnedCoreProfileOwner,
        _lifetime?: 'main' | 'persistent',
        level?: Parameters<typeof localProxyConfiguration>[4],
        assets?: readonly RuntimeAsset[],
        ports?: LocalProxyPorts,
        pinnedNode?: Record<string, unknown>
      ) => {
        activeSource = _source
        resolverMode = mode
        activeLogLevel = level
        activeAssets = assets
        activePorts = ports
        activeDedicated = _dedicated
        activePinnedNode = pinnedNode
        port = httpPort
        child = 'running'
        register(stop)
        return session
      }
    ),
    confirmStart: vi.fn(async () => false),
    confirmStop: vi.fn(async () => false),
    onRuntimeChanged: vi.fn(() => {}),
    ownsHttpListener: vi.fn(async () => true),
    ownsUDPListener: vi.fn(async (_pid: number, _port: number) => true)
  }
  return {
    adapters,
    service: createLocalProxyService(adapters),
    selection,
    stored,
    stop,
    select,
    read,
    update,
    release,
    session
  }
}
async function start(f: ReturnType<typeof fixture>) {
  f.adapters.confirmStart.mockResolvedValue(true)
  const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 })
  const result = await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
  if (!result.state.instanceId) throw new Error('fixture instance missing')
  return result.state.instanceId
}

describe('Main-owned startup context cancellation', () => {
  it.each(['resources', 'lease', 'spawn', 'readback'] as const)(
    'stops the startup when context is revoked during %s, cleaning only its own acquired instance',
    async (boundary) => {
      const f = fixture()
      f.adapters.confirmStart.mockResolvedValue(true)
      const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 })
      let live = true
      const current = (): void => {
        if (!live) throw new Error('Startup cancelled')
      }
      if (boundary === 'resources') {
        const resource = await f.adapters.resources()
        f.adapters.resources.mockImplementation(async () => {
          live = false
          return resource
        })
      } else if (boundary === 'lease') {
        f.adapters.acquire.mockImplementation(async () => {
          live = false
          return { update: f.update, release: f.release }
        })
      } else if (boundary === 'spawn') {
        const original = f.adapters.start.getMockImplementation()!
        f.adapters.start.mockImplementation(async (...args) => {
          const session = await original(...args)
          live = false
          return session
        })
      } else {
        f.update.mockImplementation(async () => {
          live = false
        })
      }
      const result = await f.service.action(
        { action: 'start', evidenceId: plan.evidenceId },
        current
      )
      expect(result.status).toBe('failed')
      expect(result.state.owned).toBe(false)
      expect(result.state.systemProxyChanged).toBe(false)
      if (boundary === 'resources') {
        expect(f.adapters.acquire).not.toHaveBeenCalled()
        expect(f.adapters.start).not.toHaveBeenCalled()
        expect(f.stop).not.toHaveBeenCalled()
      } else {
        expect(f.release).toHaveBeenCalledOnce()
        if (boundary === 'lease') expect(f.adapters.start).not.toHaveBeenCalled()
        else expect(f.stop).toHaveBeenCalledOnce()
      }
    }
  )
})

function reloadFixture() {
  const f = fixture(),
    updateRuntime = vi.fn(async () => {}),
    confirmReload = vi.fn(async () => false)
  const reload = vi.fn(async (configuration: string) => ({
    evidenceId: '00000000-0000-0000-0000-000000000004',
    runtimeSHA256: profileHash(configuration)
  }))
  f.session.reload = reload
  f.adapters.acquire.mockResolvedValue({ update: f.update, release: f.release, updateRuntime })
  return {
    ...f,
    service: createLocalProxyService({ ...f.adapters, confirmReload }),
    updateRuntime,
    confirmReload,
    reload
  }
}
describe('Owned configuration hot reload transaction', () => {
  const next = (f: ReturnType<typeof reloadFixture>) => {
    const stored = {
      ...f.stored,
      profile: { ...f.stored.profile, id: '00000000-0000-0000-0000-000000000002', name: 'Next' },
      revision: 'c'.repeat(64)
    }
    f.adapters.read.mockResolvedValue(stored)
    return stored
  }
  it('requires fresh native consent and consumes a cancelled proof without applying or stopping', async () => {
    const f = reloadFixture()
    await start(f)
    const stored = next(f)
    const plan = await f.service.prepareReload({
      profile: { id: stored.profile.id, sha256: stored.profile.sha256 },
      httpPort: 18191
    })
    expect((await f.service.reload({ evidenceId: plan.evidenceId })).status).toBe('cancelled')
    await expect(f.service.reload({ evidenceId: plan.evidenceId })).rejects.toThrow('重新准备')
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.updateRuntime).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('publishes source and runtime ownership only after a matching core receipt and lease update', async () => {
    const f = reloadFixture(),
      instance = await start(f),
      stored = next(f)
    f.confirmReload.mockResolvedValue(true)
    const plan = await f.service.prepareReload({
      profile: { id: stored.profile.id, sha256: stored.profile.sha256 },
      httpPort: 18191
    })
    const observed: LocalProxyState[] = []
    f.adapters.onRuntimeChanged.mockImplementation(() => {
      observed.push(f.service.state())
    })
    const result = await f.service.reload({ evidenceId: plan.evidenceId })
    expect(result.status).toBe('reloaded')
    expect(result.state).toMatchObject({
      instanceId: instance,
      profileId: stored.profile.id,
      traffic: 'listening',
      uncertain: false
    })
    expect(f.updateRuntime).toHaveBeenCalledWith({
      kind: 'localProxy',
      httpPort: 18191,
      ports: { http: 18191, socks: 0, mixed: 0, redir: 0 },
      profileId: stored.profile.id,
      sourceSHA256: stored.profile.sha256,
      resolverMode: 'off'
    })
    expect(f.adapters.start).toHaveBeenCalledOnce()
    expect(f.stop).not.toHaveBeenCalled()
    expect(observed).toMatchObject([
      { pending: false, instanceId: instance, profileId: stored.profile.id, phase: 'running' }
    ])
  })
  it('rejects a changed source after consent and does not send a candidate to the kernel', async () => {
    const f = reloadFixture()
    await start(f)
    const stored = next(f)
    const plan = await f.service.prepareReload({
      profile: { id: stored.profile.id, sha256: stored.profile.sha256 },
      httpPort: 18191
    })
    f.confirmReload.mockImplementation(async () => {
      f.adapters.read.mockResolvedValue({ ...stored, revision: 'd'.repeat(64) })
      return true
    })
    expect((await f.service.reload({ evidenceId: plan.evidenceId })).status).toBe('failed')
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.service.state().phase).toBe('running')
    expect(f.stop).not.toHaveBeenCalled()
  })
  it.each(['receipt', 'lease'])(
    'preserves the live instance and unknown evidence after %s uncertainty, never retrying or restarting',
    async (reason) => {
      const f = reloadFixture()
      await start(f)
      const stored = next(f)
      f.confirmReload.mockResolvedValue(true)
      if (reason === 'receipt') f.reload.mockRejectedValue(new Error('ack lost'))
      else f.updateRuntime.mockRejectedValue(new Error('sync lost'))
      const plan = await f.service.prepareReload({
        profile: { id: stored.profile.id, sha256: stored.profile.sha256 },
        httpPort: 18191
      })
      const observed: LocalProxyState[] = []
      f.adapters.onRuntimeChanged.mockImplementation(() => {
        observed.push(f.service.state())
      })
      const result = await f.service.reload({ evidenceId: plan.evidenceId })
      expect(result).toMatchObject({
        status: 'uncertain',
        state: { owned: true, uncertain: true, traffic: 'unconfirmed', phase: 'failed' }
      })
      expect(result.state.profileId).toBeUndefined()
      expect(result.state.mode).toBeUndefined()
      await expect(f.service.reload({ evidenceId: plan.evidenceId })).rejects.toThrow()
      expect(f.reload).toHaveBeenCalledOnce()
      expect(f.adapters.start).toHaveBeenCalledOnce()
      expect(f.stop).not.toHaveBeenCalled()
      expect(observed).toMatchObject([{ pending: false, phase: 'failed', uncertain: true }])
    }
  )
  it('cancels submission when an explicit stop arrives during native consent', async () => {
    const f = reloadFixture(),
      instance = await start(f),
      stored = next(f)
    let resolve: (value: boolean) => void = () => {}
    f.confirmReload.mockImplementation(
      () =>
        new Promise<boolean>((yes) => {
          resolve = yes
        })
    )
    const plan = await f.service.prepareReload({
      profile: { id: stored.profile.id, sha256: stored.profile.sha256 },
      httpPort: 18191
    })
    const loading = f.service.reload({ evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(f.confirmReload).toHaveBeenCalledOnce())
    const stopping = f.service.action({ action: 'stop', instanceId: instance })
    resolve(true)
    expect((await loading).status).toBe('failed')
    await stopping
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.service.state().phase).toBe('running') // stop confirmation is still default-cancel
  })
})
function modes() {
  const f = fixture()
  let actual: RelayCoreMode = 'rule'
  const read = f.read.getMockImplementation()
  if (!read) throw new Error('fixture read missing')
  f.read.mockImplementation(async (endpoint) =>
    endpoint === 'configs' ? { ...(await read(endpoint)), mode: actual } : read(endpoint)
  )
  const patch = vi.fn(async (next: RelayCoreMode) => {
    actual = next
  })
  f.session.patchMode = patch
  const confirm = vi.fn(async () => false)
  f.service = createLocalProxyService({ ...f.adapters, confirmMode: confirm })
  return {
    ...f,
    confirm,
    patch,
    setActual: (mode: RelayCoreMode) => {
      actual = mode
    }
  }
}
describe('Main-private active runtime capture', () => {
  const capture = async (f: ReturnType<typeof fixture>) => {
    const result = await f.service.captureRuntime(new AbortController().signal)
    if (result.status !== 'captured') throw new Error('fixture runtime unavailable')
    return result.capture
  }
  it('captures an immutable active body using only owner version, port and listener checks without notification', async () => {
    const f = fixture()
    expect(await f.service.captureRuntime(new AbortController().signal)).toEqual({
      status: 'unavailable'
    })
    const id = await start(f)
    f.read.mockClear()
    f.adapters.onRuntimeChanged.mockClear()
    const current = await capture(f)
    expect(current.snapshot).toMatchObject({
      instanceId: id,
      proxyPort: 18191,
      revision: f.service.state().configurationRevision
    })
    expect(JSON.parse(current.snapshot.configuration)).toEqual(
      JSON.parse(localProxyConfiguration(f.stored.text, 18191).configuration)
    )
    expect(Object.isFrozen(current.snapshot)).toBe(true)
    expect(current.isCurrent()).toBe(true)
    expect(current.isOwnerLive()).toBe(true)
    expect(f.read.mock.calls.map(([endpoint]) => endpoint).sort()).toEqual(['configs', 'version'])
    expect(f.adapters.ownsHttpListener).toHaveBeenCalledExactlyOnceWith(1234, 18191)
    expect(f.adapters.onRuntimeChanged).not.toHaveBeenCalled()
    const abort = new AbortController()
    abort.abort()
    await expect(f.service.captureRuntime(abort.signal)).rejects.toThrow('取消')
  })
  it('defers same-owner pending mode work and verifies the submitted owner without waiting for that work', async () => {
    const f = modes(),
      id = await start(f),
      current = await capture(f)
    let resolve: (value: boolean) => void = () => {}
    f.confirm.mockImplementation(() => new Promise<boolean>((done) => (resolve = done)))
    const changing = f.service.action({ action: 'mode', instanceId: id, mode: 'global' })
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce())
    expect(current.isCurrent()).toBe(false)
    expect(current.isOwnerLive()).toBe(true)
    expect(await f.service.captureRuntime(new AbortController().signal)).toEqual({ status: 'busy' })
    await current.assertOwner(new AbortController().signal)
    resolve(true)
    expect((await changing).status).toBe('modeChanged')
    expect(current.isCurrent()).toBe(false)
    expect(current.isOwnerLive()).toBe(true)
    expect(JSON.parse((await capture(f)).snapshot.configuration).mode).toBe('global')
  })
  it('keeps a changed reload under the same submitted owner but invalidates the previous active body', async () => {
    const f = reloadFixture(),
      id = await start(f),
      current = await capture(f)
    const next = {
      ...f.stored,
      text: f.stored.text.replace('port: 12345', 'port: 12346'),
      revision: 'd'.repeat(64)
    }
    f.adapters.read.mockResolvedValue(next)
    f.confirmReload.mockResolvedValue(true)
    const plan = await f.service.prepareReload({ profile: f.selection, httpPort: 18191 })
    expect((await f.service.reload({ evidenceId: plan.evidenceId })).status).toBe('reloaded')
    expect(current.isCurrent()).toBe(false)
    expect(current.isOwnerLive()).toBe(true)
    await current.assertOwner(new AbortController().signal)
    const latest = await capture(f)
    expect(latest.snapshot.instanceId).toBe(id)
    expect(JSON.parse(latest.snapshot.configuration).proxies[0].port).toBe(12346)
  })
  it('invalidates a captured body when an owner check observes an external mode change without revoking the owner', async () => {
    const f = modes()
    await start(f)
    const current = await capture(f)
    f.setActual('global')
    await current.assertOwner(new AbortController().signal)
    expect(current.isOwnerLive()).toBe(true)
    expect(current.isCurrent()).toBe(false)
    expect(f.service.state().mode).toBe('rule')
    expect(JSON.parse((await capture(f)).snapshot.configuration).mode).toBe('global')
  })
  it('discards a capture overlapped by a completed mode operation instead of labelling the old GET body current', async () => {
    const f = modes(),
      id = await start(f),
      read = f.read.getMockImplementation()
    if (!read) throw new Error('fixture read missing')
    const oldConfig = await read('configs')
    let resolve: (value: Record<string, unknown>) => void = () => {}
    f.read.mockImplementationOnce(() => new Promise((done) => (resolve = done)))
    const capturing = f.service.captureRuntime(new AbortController().signal)
    f.confirm.mockResolvedValue(true)
    expect(
      (await f.service.action({ action: 'mode', instanceId: id, mode: 'global' })).status
    ).toBe('modeChanged')
    resolve(oldConfig)
    expect(await capturing).toEqual({ status: 'busy' })
    expect(JSON.parse((await capture(f)).snapshot.configuration).mode).toBe('global')
  })
  it.each(['port', 'version', 'listener'] as const)(
    'rejects observed %s ownership loss and never upgrades the old capture back to current',
    async (loss) => {
      const f = fixture()
      await start(f)
      const current = await capture(f),
        read = f.read.getMockImplementation()
      if (!read) throw new Error('fixture read missing')
      if (loss === 'listener') f.adapters.ownsHttpListener.mockResolvedValue(false)
      else
        f.read.mockImplementation(async (endpoint) => ({
          ...(await read(endpoint)),
          ...(loss === 'port' && endpoint === 'configs' ? { port: 18192 } : {}),
          ...(loss === 'version' && endpoint === 'version' ? { version: 'foreign' } : {})
        }))
      await expect(current.assertOwner(new AbortController().signal)).rejects.toThrow('归属')
      expect(current.isOwnerLive()).toBe(false)
      expect(current.isCurrent()).toBe(false)
      expect(await f.service.captureRuntime(new AbortController().signal)).toEqual({
        status: 'unavailable'
      })
    }
  )
  it('invalidates the captured owner as soon as a stop is requested without waiting for confirmation', async () => {
    const f = fixture(),
      id = await start(f),
      current = await capture(f)
    let resolve: (value: boolean) => void = () => {}
    f.adapters.confirmStop.mockImplementation(
      () => new Promise<boolean>((done) => (resolve = done))
    )
    const stopping = f.service.action({ action: 'stop', instanceId: id })
    expect(current.isOwnerLive()).toBe(false)
    await expect(current.assertOwner(new AbortController().signal)).rejects.toThrow('失效')
    resolve(true)
    expect((await stopping).status).toBe('stopped')
    expect(current.isOwnerLive()).toBe(false)
  })
})
describe('Manual local proxy ownership, selection and close consent', () => {
  it('binds a selected diagnostic level to the confirmed ordinary start and keeps it on reload', async () => {
    const f = reloadFixture(),
      request = { profile: f.selection, httpPort: 18191 }
    await expect(f.service.prepare({ ...request, logLevel: 'verbose' })).rejects.toThrow('日志级别')
    await expect(
      f.service.prepare({ ...request, lifetime: 'persistent', logLevel: 'debug' })
    ).rejects.toThrow('持久')
    expect(f.adapters.read).not.toHaveBeenCalled()
    const plan = await f.service.prepare({ ...request, logLevel: 'debug' })
    expect(plan.logLevel).toBe('debug')
    const baseline = JSON.parse(localProxyConfiguration(f.stored.text, 18191).configuration)
    expect(plan.runtimeSHA256).toBe(
      profileHash(JSON.stringify({ ...baseline, 'log-level': 'debug' }))
    )
    plan.logLevel = 'error'
    f.adapters.confirmStart.mockResolvedValue(true)
    const started = await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    expect(started).toMatchObject({ status: 'started', state: { logLevel: 'debug' } })
    expect(f.adapters.confirmStart).toHaveBeenCalledWith(
      expect.objectContaining({ logLevel: 'debug' })
    )
    expect(f.adapters.start.mock.calls[0][7]).toBe('debug')
    await expect(f.service.prepareReload({ ...request, logLevel: 'info' })).rejects.toThrow(
      '下次启动'
    )
    f.confirmReload.mockResolvedValue(true)
    const reload = await f.service.prepareReload(request)
    const refreshed = await f.service.reload({ evidenceId: reload.evidenceId })
    expect(refreshed).toMatchObject({ status: 'reloaded', state: { logLevel: 'debug' } })
    expect(JSON.parse(f.reload.mock.calls[0][0])).toMatchObject({ 'log-level': 'debug' })
  })
  it('opens only the captured live work directory and refuses after ownership ends during validation', async () => {
    const f = fixture()
    expect(f.service.captureWorkDirectory()).toBeUndefined()
    let validation = Promise.resolve()
    f.session.openWorkDirectory = async (open, assertLive) => {
      await validation
      assertLive()
      await open(f.session.directory)
    }
    const id = await start(f)
    const capture = f.service.captureWorkDirectory()
    if (!capture) throw new Error('fixture work directory missing')
    const open = vi.fn(async (_path: string) => {})
    await capture(open)
    expect(open).toHaveBeenCalledExactlyOnceWith('/fixture')

    let resume = () => {}
    validation = new Promise<void>((resolve) => {
      resume = () => resolve()
    })
    const pending = capture(open)
    f.adapters.confirmStop.mockResolvedValue(true)
    const result = await f.service.action({ action: 'stop', instanceId: id })
    resume()
    await expect(pending).rejects.toThrow('归属已变化')
    expect(result.status).toBe('stopped')
    expect(open).toHaveBeenCalledTimes(1)
    expect(f.service.captureWorkDirectory()).toBeUndefined()
  })
  it('notifies settled ownership and mode changes without looping from inspection or propagating observer errors', async () => {
    const f = modes(),
      observed: LocalProxyState[] = []
    f.adapters.onRuntimeChanged.mockImplementation(() => {
      observed.push(f.service.state())
      throw new Error('observer failure')
    })
    const id = await start(f)
    expect(observed.at(-1)).toMatchObject({
      pending: false,
      phase: 'running',
      owned: true,
      instanceId: id
    })
    expect(f.adapters.onRuntimeChanged.mock.calls.every((args) => !args.length)).toBe(true)
    const notifications = observed.length
    await f.service.inspectLive()
    await f.service.inspectLive()
    expect(observed).toHaveLength(notifications)
    f.confirm.mockResolvedValue(true)
    expect(
      (await f.service.action({ action: 'mode', instanceId: id, mode: 'global' })).status
    ).toBe('modeChanged')
    expect(observed.at(-1)).toMatchObject({ pending: false, mode: 'global', instanceId: id })
    f.adapters.confirmStop.mockResolvedValue(true)
    expect((await f.service.action({ action: 'stop', instanceId: id })).status).toBe('stopped')
    expect(observed.at(-1)).toMatchObject({ pending: false, owned: false, phase: 'idle' })
  })
  it('notifies uncertain stop ownership without claiming the live owner was released', async () => {
    const f = fixture(),
      id = await start(f),
      observed: LocalProxyState[] = []
    f.adapters.onRuntimeChanged.mockImplementation(() => {
      observed.push(f.service.state())
    })
    f.adapters.confirmStop.mockResolvedValue(true)
    f.stop.mockRejectedValueOnce(new Error('stop unconfirmed'))
    expect((await f.service.action({ action: 'stop', instanceId: id })).status).toBe('uncertain')
    expect(observed).toMatchObject([
      { pending: false, owned: true, phase: 'failed', uncertain: true, instanceId: id }
    ])
  })
  it('changes only an owned mode after consent and fresh GETs; repeated mode does not mutate twice', async () => {
    const f = modes(),
      id = await start(f)
    const action = { action: 'mode', instanceId: id, mode: 'global' }
    expect((await f.service.action(action)).status).toBe('cancelled')
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.service.state().mode).toBe('rule')
    f.confirm.mockResolvedValue(true)
    expect((await f.service.action(action)).status).toBe('modeChanged')
    expect(f.patch).toHaveBeenCalledExactlyOnceWith('global')
    expect(f.service.state().mode).toBe('global')
    expect((await f.service.action(action)).status).toBe('refreshed')
    expect(f.confirm).toHaveBeenCalledTimes(2)
    expect(f.patch).toHaveBeenCalledTimes(1)
    await expect(f.service.action({ ...action, tun: { enable: true } })).rejects.toThrow()
    await expect(f.service.action({ ...action, mode: 'other' })).rejects.toThrow()
    f.adapters.confirmStop.mockResolvedValue(true)
    expect(await f.service.requestClose()).toBe('closed')
  })
  it('clears mode confirmation after lost patch acknowledgement and never rolls back or retries', async () => {
    const f = modes(),
      id = await start(f)
    f.confirm.mockResolvedValue(true)
    f.patch.mockImplementationOnce(async () => {
      f.setActual('direct')
      throw new Error('PRIVATE lost ack')
    })
    const result = await f.service.action({ action: 'mode', instanceId: id, mode: 'direct' })
    expect(result.status).toBe('unconfirmed')
    expect(result.state.mode).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(f.patch).toHaveBeenCalledTimes(1)
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.adapters.start).toHaveBeenCalledTimes(1)
    expect((await f.service.action({ action: 'refresh', instanceId: id })).state.mode).toBe(
      'direct'
    )
    f.adapters.confirmStop.mockResolvedValue(true)
    expect(await f.service.requestClose()).toBe('closed')
  })
  it('invalidates mode consent if the read mode changed or quit arrived during the prompt', async () => {
    for (const reason of ['changed', 'quit']) {
      const f = modes(),
        id = await start(f)
      let answer!: (value: boolean) => void
      f.confirm.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          })
      )
      const operation = f.service.action({ action: 'mode', instanceId: id, mode: 'global' })
      await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled())
      let closing: Promise<unknown> | undefined
      if (reason === 'changed') f.setActual('direct')
      else {
        f.adapters.confirmStop.mockResolvedValue(true)
        closing = f.service.requestClose()
      }
      answer(true)
      expect((await operation).status).toBe(reason === 'changed' ? 'unconfirmed' : 'cancelled')
      expect(f.patch).not.toHaveBeenCalled()
      if (closing) expect(await closing).toBe('closed')
      else {
        f.adapters.confirmStop.mockResolvedValue(true)
        expect(await f.service.requestClose()).toBe('closed')
      }
    }
  })
  it.each([
    ['url-test', 'URLTest'],
    ['fallback', 'Fallback'],
    ['smart', 'Smart']
  ])(
    'keeps active %s probes disabled while preserving explicit selection and return to automatic mode',
    async (type, runtimeType) => {
      const f = fixture()
      const target = 'http://fixture.invalid/health?PRIVATE'
      f.stored.text = JSON.stringify({
        proxies: [{ name: 'Node', type: 'http', server: '127.0.0.1', port: 1 }],
        'proxy-groups': [{ name: 'Group', type, proxies: ['Node'], url: target }],
        rules: ['MATCH,Group']
      })
      let fixed = ''
      const originalRead = f.read.getMockImplementation()
      if (!originalRead) throw new Error('fixture read missing')
      f.read.mockImplementation(async (endpoint) =>
        endpoint === 'proxies'
          ? {
              proxies: {
                Group: {
                  type: runtimeType,
                  now: type === 'smart' && fixed === '' ? 'Smart - Select' : 'Node',
                  all: ['Node'],
                  fixed
                },
                Node: { alive: true }
              }
            }
          : originalRead(endpoint)
      )
      const test = vi.fn(async () => 17)
      f.session.testDelay = test
      f.session.automatic = vi.fn(async () => {
        fixed = ''
      })
      f.select.mockImplementation(async (_group, member) => {
        fixed = member
      })
      const confirmTest = vi.fn(async () => true)
      const service = createLocalProxyService({ ...f.adapters, confirmTest })
      f.adapters.confirmStart.mockResolvedValue(true)
      const plan = await service.prepare({ profile: f.selection, httpPort: 18191 })
      const result = await service.action({ action: 'start', evidenceId: plan.evidenceId }),
        id = result.state.instanceId
      expect(result.status).toBe('started')
      expect(JSON.stringify(service.state())).not.toContain('PRIVATE')
      const action = { action: 'delay', instanceId: id, group: 'Group', member: 'Node' }
      await expect(service.action(action)).rejects.toThrow('当前保护要求下暂不开放在用核心测速')
      await expect(service.action({ ...action, member: 'Injected' })).rejects.toThrow(
        '当前保护要求下暂不开放在用核心测速'
      )
      expect(test).not.toHaveBeenCalled()
      expect(confirmTest).not.toHaveBeenCalled()
      expect(
        (await service.action({ action: 'select', instanceId: id, group: 'Group', member: 'Node' }))
          .state.groups[0].fixed
      ).toBe('Node')
      expect(
        (await service.action({ action: 'automatic', instanceId: id, group: 'Group' })).state
          .groups[0].fixed
      ).toBe('')
      expect(f.select).toHaveBeenCalledTimes(1)
      expect(f.adapters.start).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(service.state())).not.toContain('PRIVATE')
      f.adapters.confirmStop.mockResolvedValue(true)
      expect(await service.requestClose()).toBe('closed')
    }
  )
  it('refuses an active probe before native confirmation and keeps explicit owner quit available', async () => {
    const f = fixture(),
      test = vi.fn(async () => 12)
    f.session.testDelay = test
    // Build a valid explicit source independent of the YAML fixture's layout.
    f.stored.text = JSON.stringify({
      proxies: [{ name: 'Node', type: 'http', server: '127.0.0.1', port: 1 }],
      'proxy-groups': [
        {
          name: 'Group',
          type: 'select',
          proxies: ['Node', 'DIRECT'],
          url: 'http://fixture.invalid'
        }
      ],
      rules: ['MATCH,Group']
    })
    const confirmTest = vi.fn(async () => true)
    const service = createLocalProxyService({ ...f.adapters, confirmTest })
    f.adapters.confirmStart.mockResolvedValue(true)
    const plan = await service.prepare({ profile: f.selection, httpPort: 18191 })
    const id = (await service.action({ action: 'start', evidenceId: plan.evidenceId })).state
      .instanceId
    const pending = service.action({
      action: 'delay',
      instanceId: id,
      group: 'Group',
      member: 'Node'
    })
    f.adapters.confirmStop.mockResolvedValue(true)
    const closing = service.requestClose()
    await expect(pending).rejects.toThrow('当前保护要求下暂不开放在用核心测速')
    expect(confirmTest).not.toHaveBeenCalled()
    expect(test).not.toHaveBeenCalled()
    expect(await closing).toBe('closed')
  })
  it('binds explicit DNS mode to preparation, private ownership and the actual launch adapter', async () => {
    const f = fixture()
    f.stored.text = profileRuntimeSource.replace(
      /dns:.*\n/u,
      'dns: {enable: true, nameserver: [127.0.0.1:5353], use-system-hosts: false}\n'
    )
    f.selection.sha256 = profileHash(f.stored.text)
    f.stored.profile.sha256 = f.selection.sha256
    await expect(
      f.service.prepare({ profile: f.selection, httpPort: 18191, resolverMode: 'system' })
    ).rejects.toThrow('DNS模式')
    expect(f.adapters.read).not.toHaveBeenCalled()
    const plan = await f.service.prepare({
      profile: f.selection,
      httpPort: 18191,
      resolverMode: 'profile'
    })
    expect(plan.resolution).toMatchObject({ enabled: true, mode: 'profile' })
    // The renderer cannot mutate the opaque proof by modifying its report.
    plan.resolverMode = 'off'
    f.adapters.confirmStart.mockResolvedValue(true)
    const result = await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    expect(result.status).toBe('started')
    expect(result.state.resolution?.enabled).toBe(true)
    expect(f.adapters.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ resolverMode: 'profile' }),
      expect.any(String),
      'main'
    )
    expect(f.adapters.start).toHaveBeenCalledWith(
      f.stored.text,
      18191,
      expect.any(Function),
      'profile',
      undefined,
      expect.objectContaining({ profileUUID: f.selection.id }),
      'main',
      undefined,
      undefined,
      { http: 18191, socks: 0, mixed: 0, redir: 0 },
      undefined
    )
    await expect(
      f.service.action({ action: 'start', evidenceId: plan.evidenceId, resolverMode: 'off' })
    ).rejects.toThrow()
    f.adapters.confirmStop.mockResolvedValue(true)
    expect(await f.service.requestClose()).toBe('closed')
  })
  it('has no startup IO and cancels a prepared start without acquiring or launching anything', async () => {
    const f = fixture()
    expect(f.service.state()).toMatchObject({
      phase: 'unknown',
      owned: false,
      traffic: 'inactive',
      liveGuardEnabled: false,
      systemProxyChanged: false
    })
    expect(f.adapters.read).not.toHaveBeenCalled()
    const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 })
    expect(plan.canStart).toBe(true)
    expect((await f.service.action({ action: 'start', evidenceId: plan.evidenceId })).status).toBe(
      'cancelled'
    )
    expect(f.adapters.acquire).not.toHaveBeenCalled()
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
  it('rejects injected messages, unsupported ports, occupied ports and existing records without takeover', async () => {
    const f = fixture()
    for (const httpPort of [0, 80, 65536, NaN, '18191'])
      await expect(f.service.prepare({ profile: f.selection, httpPort })).rejects.toThrow()
    await expect(
      f.service.prepare({ profile: f.selection, httpPort: 18191, path: '/PRIVATE' })
    ).rejects.toThrow('只接受')
    expect(f.adapters.read).not.toHaveBeenCalled()
    f.adapters.portAvailable.mockResolvedValue(false)
    expect((await f.service.prepare({ profile: f.selection, httpPort: 18191 })).canStart).toBe(
      false
    )
    f.adapters.portAvailable.mockClear()
    f.adapters.inspect.mockResolvedValue({
      mode: 'rule',
      revision: 'a'.repeat(64),
      lease: 'present'
    })
    const blocked = await f.service.prepare({ profile: f.selection, httpPort: 18191 })
    expect(blocked).toMatchObject({ canStart: false, hasRecord: true })
    expect(f.adapters.portAvailable).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('pins source revision/expiry after confirmation before any persistent lease or launch', async () => {
    for (const reason of ['source', 'expiry']) {
      let now = 0
      const f = fixture(),
        service = createLocalProxyService({ ...f.adapters, now: () => now })
      const plan = await service.prepare({ profile: f.selection, httpPort: 18191 })
      f.adapters.confirmStart.mockImplementation(async () => {
        if (reason === 'expiry') now = 60001
        return true
      })
      if (reason === 'source')
        f.adapters.read.mockResolvedValueOnce({ ...f.stored, revision: 'c'.repeat(64) })
      expect((await service.action({ action: 'start', evidenceId: plan.evidenceId })).status).toBe(
        'failed'
      )
      expect(f.adapters.acquire).not.toHaveBeenCalled()
      expect(f.adapters.start).not.toHaveBeenCalled()
    }
  })
  it('persists typed source/port ownership, confirms live groups and rejects a stale instance', async () => {
    const f = fixture(),
      id = await start(f)
    expect(f.service.state()).toMatchObject({
      phase: 'running',
      traffic: 'listening',
      owned: true,
      groups: [{ now: 'Node', confirmed: true }]
    })
    expect(f.adapters.acquire).toHaveBeenCalledWith(
      {
        kind: 'localProxy',
        httpPort: 18191,
        ports: { http: 18191, socks: 0, mixed: 0, redir: 0 },
        profileId: f.selection.id,
        sourceSHA256: f.selection.sha256,
        resolverMode: 'off'
      },
      'a'.repeat(64),
      'main'
    )
    expect(f.update).toHaveBeenCalledWith('running', 1234)
    await expect(
      f.service.action({ action: 'stop', instanceId: '00000000-0000-0000-0000-000000000002' })
    ).rejects.toThrow('实例已变化')
    expect(f.stop).not.toHaveBeenCalled()
    expect(
      (
        await f.service.action({
          action: 'select',
          instanceId: id,
          group: 'Group',
          member: 'DIRECT'
        })
      ).state.groups[0]
    ).toMatchObject({ now: 'DIRECT', confirmed: true })
    expect(f.select).toHaveBeenCalledTimes(1)
  })
  it('does not write an undeclared member or retry an ambiguous selection, then refreshes real state', async () => {
    const f = fixture(),
      id = await start(f)
    expect(
      (
        await f.service.action({
          action: 'select',
          instanceId: id,
          group: 'Group',
          member: 'Missing'
        })
      ).status
    ).toBe('unconfirmed')
    expect(f.select).not.toHaveBeenCalled()
    f.select.mockImplementationOnce(async () => {
      f.read.mockRejectedValueOnce(new Error('PRIVATE lost acknowledgement'))
    })
    expect(
      (
        await f.service.action({
          action: 'select',
          instanceId: id,
          group: 'Group',
          member: 'DIRECT'
        })
      ).status
    ).toBe('unconfirmed')
    expect(f.select).toHaveBeenCalledTimes(1)
    expect(f.service.state().groups[0].confirmed).toBe(false)
    expect(JSON.stringify(f.service.state())).not.toContain('PRIVATE')
    expect(
      (await f.service.action({ action: 'refresh', instanceId: id })).state.groups[0]
    ).toMatchObject({ now: 'Node', confirmed: true })
    expect(f.adapters.start).toHaveBeenCalledTimes(1)
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('cancelled stop and quit preserve the live proxy without extra shutdowns', async () => {
    const f = fixture(),
      id = await start(f)
    expect((await f.service.action({ action: 'stop', instanceId: id })).status).toBe('cancelled')
    expect(await f.service.requestClose()).toBe('cancelled')
    expect(f.service.state()).toMatchObject({ owned: true, traffic: 'listening', pending: false })
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
  })
  it('shares concurrent stop confirmations, waits for cleanup and makes repeated stop harmless', async () => {
    const f = fixture(),
      id = await start(f)
    let answer!: (value: boolean) => void
    f.adapters.confirmStop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const first = f.service.action({ action: 'stop', instanceId: id }),
      second = f.service.action({ action: 'stop', instanceId: id })
    expect(f.adapters.confirmStop).toHaveBeenCalledTimes(1)
    answer(true)
    expect((await first).status).toBe('stopped')
    expect((await second).status).toBe('stopped')
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.release).toHaveBeenCalledTimes(1)
    expect((await f.service.action({ action: 'stop', instanceId: id })).status).toBe('stopped')
    expect(await f.service.requestClose()).toBe('closed')
  })
  it('retains ownership after an unconfirmed shutdown and permits a consented retry', async () => {
    const f = fixture(),
      id = await start(f)
    f.adapters.confirmStop.mockResolvedValue(true)
    f.stop.mockRejectedValueOnce(new Error('PRIVATE still alive'))
    expect((await f.service.action({ action: 'stop', instanceId: id })).state).toMatchObject({
      phase: 'failed',
      owned: true,
      uncertain: true,
      traffic: 'unconfirmed'
    })
    expect(f.release).not.toHaveBeenCalled()
    expect(await f.service.requestClose()).toBe('closed')
    expect(f.stop).toHaveBeenCalledTimes(2)
  })
  it('retries journal cleanup without stopping a process twice or asking for a nonexistent live listener', async () => {
    const f = fixture(),
      id = await start(f)
    f.adapters.confirmStop.mockResolvedValue(true)
    f.release.mockRejectedValueOnce(new Error('PRIVATE metadata error'))
    expect((await f.service.action({ action: 'stop', instanceId: id })).state).toMatchObject({
      owned: true,
      traffic: 'inactive',
      uncertain: true
    })
    expect((await f.service.action({ action: 'stop', instanceId: id })).status).toBe('stopped')
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.release).toHaveBeenCalledTimes(2)
    expect(f.adapters.confirmStop).toHaveBeenCalledTimes(1)
  })
  it('waits for an in-flight startup on quit, then cleans only that newly owned instance', async () => {
    const f = fixture()
    f.adapters.confirmStart.mockResolvedValue(true)
    let ready!: (value: RelayOwnedCore) => void
    f.adapters.start.mockImplementationOnce((_source, _port, register) => {
      register(f.stop)
      return new Promise((resolve) => {
        ready = resolve
      })
    })
    const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 })
    const starting = f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(f.adapters.start).toHaveBeenCalled())
    const closing = f.service.requestClose()
    expect(f.stop).not.toHaveBeenCalled()
    ready(f.session)
    expect((await starting).status).toBe('stopped')
    expect(await closing).toBe('closed')
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.adapters.confirmStop).not.toHaveBeenCalled()
  })
  it('shares a pending quit confirmation and keeps the instance after cancellation', async () => {
    const f = fixture()
    await start(f)
    let answer!: (value: boolean) => void
    f.adapters.confirmStop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const a = f.service.requestClose(),
      b = f.service.requestClose()
    await vi.waitFor(() => expect(f.adapters.confirmStop).toHaveBeenCalled())
    expect(f.adapters.confirmStop).toHaveBeenCalledTimes(1)
    answer(false)
    expect(await a).toBe('cancelled')
    expect(await b).toBe('cancelled')
    expect(f.service.state().owned).toBe(true)
    expect(f.stop).not.toHaveBeenCalled()
  })
})

describe('Private Main-only Smart state source binding and retirement', () => {
  const retained: SmartLearningStopResult = { status: 'retained', retainedEvidence: true }
  function owner(f: ReturnType<typeof fixture>): OwnedCoreProfileOwner {
    const submitted = f.adapters.start.mock.calls[0]?.[5]
    if (!submitted) throw new Error('missing verified Main owner')
    return submitted
  }
  function bind(f: ReturnType<typeof fixture>): void {
    Object.assign(f.session, {
      smartStateBinding: Object.freeze({
        profileUUID: f.selection.id,
        key: 'a'.repeat(64),
        collectCSV: false
      })
    })
  }
  it('passes the verified UUID and permits a normal stopping phase without using UI generation as the save lease', async () => {
    const f = fixture(),
      id = await start(f),
      submitted = owner(f),
      original = f.stop.getMockImplementation()
    if (!original) throw new Error('missing synthetic stop')
    expect(submitted.profileUUID).toBe(f.selection.id)
    expect(submitted.mayPersist()).toBe(true)
    f.stop.mockImplementationOnce(async () => {
      expect(() => submitted.assertLive()).not.toThrow()
      expect(submitted.mayPersist()).toBe(true)
      await original()
    })
    f.adapters.confirmStop.mockResolvedValue(true)
    expect((await f.service.action({ action: 'stop', instanceId: id })).status).toBe('stopped')
    expect(submitted.mayPersist()).toBe(false)
    expect(() => submitted.assertLive()).toThrow()
  })
  it('refuses another UUID before Smart PUT without changing the existing non-Smart reload contract', async () => {
    const f = reloadFixture()
    bind(f)
    await start(f)
    const changed = {
      ...f.stored,
      profile: { ...f.stored.profile, id: '00000000-0000-0000-0000-000000000002' },
      revision: 'd'.repeat(64)
    }
    f.adapters.read.mockResolvedValue(changed)
    await expect(
      f.service.prepareReload({
        profile: { id: changed.profile.id, sha256: changed.profile.sha256 },
        httpPort: 18191
      })
    ).rejects.toThrow('明确停止')
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    expect(owner(f).profileUUID).toBe(f.selection.id)
  })
  it('refuses a same-UUID CSV capability change before PUT', async () => {
    const f = reloadFixture()
    bind(f)
    await start(f)
    const text = f.stored.text.replace(
      'type: select, proxies:',
      'type: smart, collectdata: true, url: "http://127.0.0.1:19002/health", proxies:'
    )
    expect(text).not.toBe(f.stored.text)
    const changed = {
      ...f.stored,
      profile: { ...f.stored.profile, sha256: profileHash(text) },
      text,
      revision: 'd'.repeat(64)
    }
    f.adapters.read.mockResolvedValue(changed)
    await expect(
      f.service.prepareReload({
        profile: { id: changed.profile.id, sha256: changed.profile.sha256 },
        httpPort: 18191
      })
    ).rejects.toThrow('明确停止')
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('keeps one start owner during a same-UUID same-CSV hot reload', async () => {
    const f = reloadFixture()
    bind(f)
    await start(f)
    const submitted = owner(f),
      binding = f.session.smartStateBinding
    f.confirmReload.mockResolvedValue(true)
    const plan = await f.service.prepareReload({ profile: f.selection, httpPort: 18191 })
    expect((await f.service.reload({ evidenceId: plan.evidenceId })).status).toBe('reloaded')
    expect(f.reload).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      f.selection.id,
      undefined
    )
    expect(f.adapters.start).toHaveBeenCalledOnce()
    expect(f.session.smartStateBinding).toBe(binding)
    expect(owner(f)).toBe(submitted)
    expect(submitted.mayPersist()).toBe(true)
  })
  it('retains the immutable UUID when an applied reload loses ACK and the active UI binding is cleared', async () => {
    const f = reloadFixture()
    bind(f)
    const id = await start(f),
      submitted = owner(f)
    f.confirmReload.mockResolvedValue(true)
    const plan = await f.service.prepareReload({ profile: f.selection, httpPort: 18191 })
    f.reload.mockRejectedValue(new Error('lost ACK'))
    expect((await f.service.reload({ evidenceId: plan.evidenceId })).status).toBe('uncertain')
    expect(f.service.state().profileId).toBeUndefined()
    expect(submitted.profileUUID).toBe(f.selection.id)
    expect(submitted.mayPersist()).toBe(false)
    Object.assign(f.session, { smartStateStopResult: () => retained })
    f.adapters.confirmStop.mockResolvedValue(true)
    const stopped = await f.service.action({ action: 'stop', instanceId: id })
    expect(stopped.state.traffic).toBe('inactive')
    expect(stopped.state.warnings.join(' ')).toContain('保存结果未确认')
    expect(f.release).toHaveBeenCalledOnce()
  })
  it('keeps retained diagnostics through a first lease-release failure and a later stop retry', async () => {
    const f = fixture(),
      id = await start(f)
    Object.assign(f.session, { smartStateStopResult: () => retained })
    f.adapters.confirmStop.mockResolvedValue(true)
    f.release.mockRejectedValueOnce(new Error('lease release changed'))
    const first = await f.service.action({ action: 'stop', instanceId: id })
    expect(first.status).toBe('uncertain')
    expect(first.state.traffic).toBe('inactive')
    const retry = await f.service.action({ action: 'stop', instanceId: id })
    expect(retry.status).toBe('stopped')
    expect(retry.state.warnings.join(' ')).toContain('保存结果未确认')
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledTimes(2)
  })
  it('reads retained evidence from the cleanup registration even when start never returned a session', async () => {
    const f = fixture()
    f.adapters.start.mockImplementationOnce(async (_text, _port, register) => {
      register(f.stop, () => retained)
      throw new Error('private startup failed after registration')
    })
    f.adapters.confirmStart.mockResolvedValue(true)
    const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 }),
      failed = await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    expect(failed.status).toBe('failed')
    expect(failed.state.traffic).toBe('inactive')
    expect(failed.state.owned).toBe(false)
    expect(failed.state.warnings.join(' ')).toContain('保存结果未确认')
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledOnce()
  })
})

function toolsFixture() {
  const f = smartAutomaticFixture()
  const definition = { configurationRevision: 'd'.repeat(64), groups: ['Group'] }
  f.session.smartToolsDefinition = () => structuredClone(definition)
  const weights = vi.fn(async (guard: import('./owned-runtime').OwnedCoreRequestGuards) => {
    guard.assertLive()
    return {
      version: 1 as const,
      kind: 'weights' as const,
      configurationRevision: definition.configurationRevision,
      groups: [
        {
          name: 'Group',
          status: 'ready' as const,
          weights: [{ Name: 'historic node', Rank: '' as const, Weight: 0 }]
        }
      ]
    }
  })
  const clear = vi.fn(async (guard: import('./owned-runtime').OwnedCoreRequestGuards) => {
    guard.assertLive()
    guard.submitted?.()
    guard.assertLive()
  })
  f.session.smartWeights = weights
  f.session.clearSmartCache = clear
  return { ...f, weights, clear, definition }
}
function toolGate() {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve: () => resolve()
  }
}
describe('Smart tools lifecycle independent boundary', () => {
  it('binds current declarations and empty Rank/zero; clearing defaults cancelled with zero writes', async () => {
    const f = toolsFixture(),
      id = await start(f),
      base = {
        target: 'ordinary',
        instanceId: id,
        configurationRevision: f.definition.configurationRevision
      }
    expect(await f.service.smartTools({ action: 'inspect', target: 'ordinary' })).toMatchObject({
      status: 'ready',
      inspection: { instanceId: id, groups: ['Group'] }
    })
    expect(await f.service.smartTools({ ...base, action: 'weights', group: 'Group' })).toEqual({
      status: 'weights',
      weights: [{ Name: 'historic node', Rank: '', Weight: 0 }]
    })
    expect(await f.service.smartTools({ ...base, action: 'clear-cache' })).toEqual({
      status: 'cancelled'
    })
    expect(f.clear).not.toHaveBeenCalled()
    expect(
      await f.service.smartTools({ ...base, action: 'clear-cache' }, async () => true)
    ).toEqual({ status: 'accepted' })
    expect(f.clear).toHaveBeenCalledOnce()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('does not use tools busy to block an ordinary stop while GET is delayed', async () => {
    const f = toolsFixture(),
      id = await start(f),
      gate = toolGate(),
      entered = toolGate()
    f.weights.mockImplementation(async (guard) => {
      entered.resolve()
      await gate.promise
      guard.assertLive()
      throw new Error('late')
    })
    const pending = f.service.smartTools({
      action: 'weights',
      target: 'ordinary',
      instanceId: id,
      configurationRevision: f.definition.configurationRevision,
      group: 'Group'
    })
    await entered.promise
    expect(
      (
        await f.service.smartTools({
          action: 'weights',
          target: 'ordinary',
          instanceId: id,
          configurationRevision: f.definition.configurationRevision,
          group: 'Group'
        })
      ).status
    ).toBe('busy')
    f.adapters.confirmStop.mockResolvedValue(true)
    expect((await f.service.action({ action: 'stop', instanceId: id })).status).toBe('stopped')
    expect(f.release).toHaveBeenCalledOnce()
    gate.resolve()
    expect((await pending).status).toBe('unavailable')
  })
  it('rechecks ownership after delayed confirmation and submits no POST after stop', async () => {
    const f = toolsFixture(),
      id = await start(f),
      gate = toolGate(),
      entered = toolGate()
    const pending = f.service.smartTools(
      {
        action: 'clear-cache',
        target: 'ordinary',
        instanceId: id,
        configurationRevision: f.definition.configurationRevision
      },
      async () => {
        entered.resolve()
        await gate.promise
        return true
      }
    )
    await entered.promise
    f.adapters.confirmStop.mockResolvedValue(true)
    expect((await f.service.action({ action: 'stop', instanceId: id })).status).toBe('stopped')
    gate.resolve()
    expect((await pending).status).toBe('cancelled')
    expect(f.clear).not.toHaveBeenCalled()
  })
  it('keeps attempted POST uncertain without replay and stops independently of its delayed completion', async () => {
    const f = toolsFixture(),
      id = await start(f),
      gate = toolGate(),
      entered = toolGate()
    f.clear.mockImplementation(async (guard) => {
      guard.assertLive()
      guard.submitted?.()
      entered.resolve()
      await gate.promise
      throw new Error('unknown after send')
    })
    const pending = f.service.smartTools(
      {
        action: 'clear-cache',
        target: 'ordinary',
        instanceId: id,
        configurationRevision: f.definition.configurationRevision
      },
      async () => true
    )
    await entered.promise
    f.adapters.confirmStop.mockResolvedValue(true)
    expect((await f.service.action({ action: 'stop', instanceId: id })).status).toBe('stopped')
    expect(f.release).toHaveBeenCalledOnce()
    gate.resolve()
    expect((await pending).status).toBe('uncertain')
    expect(f.clear).toHaveBeenCalledOnce()
  })
  it('rejects stale revision/group before IO and rechecks revision after a delayed read', async () => {
    const f = toolsFixture(),
      id = await start(f),
      base = {
        action: 'weights',
        target: 'ordinary',
        instanceId: id,
        configurationRevision: f.definition.configurationRevision,
        group: 'Group'
      }
    expect(
      (await f.service.smartTools({ ...base, configurationRevision: 'e'.repeat(64) })).status
    ).toBe('unavailable')
    expect((await f.service.smartTools({ ...base, group: 'old history' })).status).toBe(
      'unavailable'
    )
    expect(f.weights).not.toHaveBeenCalled()
    const gate = toolGate(),
      entered = toolGate(),
      original = f.weights.getMockImplementation()
    if (!original) throw new Error('missing fixture weights')
    f.weights.mockImplementation(async (guard) => {
      entered.resolve()
      await gate.promise
      return original(guard)
    })
    const pending = f.service.smartTools(base)
    await entered.promise
    f.definition.configurationRevision = 'e'.repeat(64)
    gate.resolve()
    expect((await pending).status).toBe('unavailable')
  })
})

describe('Independent ordinary traffic read lane and owner epoch', () => {
  const sample = (guards: OwnedCoreTrafficGuards, up = 12): OwnedTrafficSample => ({
    instanceId: guards.instanceId,
    configurationRevision: guards.configurationRevision,
    receivedAt: Date.now(),
    up,
    down: 34,
    upTotal: 1000,
    downTotal: 2000
  })
  const view = (): AbortSignal => new AbortController().signal
  it('keeps inactive/unsupported/cancelled reads unavailable without fabricating zero', async () => {
    const f = fixture()
    expect(await f.service.readTraffic(view())).toBeUndefined()
    await start(f)
    expect(await f.service.readTraffic(view())).toBeUndefined()
    const read = vi.fn(async (guards: OwnedCoreTrafficGuards) => sample(guards))
    f.session.readTraffic = read
    const cancelled = new AbortController()
    cancelled.abort()
    expect(await f.service.readTraffic(cancelled.signal)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('captures its actual current instance and revision rather than caller/UI identifiers', async () => {
    const f = fixture(),
      id = await start(f)
    const read = vi.fn(async (guards: OwnedCoreTrafficGuards) => {
      guards.assertLive()
      return sample(guards, 0)
    })
    f.session.readTraffic = read
    const result = await f.service.readTraffic(view())
    expect(result).toMatchObject({
      instanceId: id,
      configurationRevision: f.service.state().configurationRevision,
      up: 0,
      upTotal: 1000
    })
    expect(f.service.state().pending).toBe(false)
    expect(f.service.state().uncertain).toBe(false)
    expect(f.release).not.toHaveBeenCalled()
  })
  it('single-flights the read while keeping lifecycle whenIdle independent', async () => {
    const f = fixture()
    await start(f)
    let resolve!: (value: OwnedTrafficSample) => void, held!: OwnedCoreTrafficGuards
    const read = vi.fn((guards: OwnedCoreTrafficGuards) => {
      held = guards
      return new Promise<OwnedTrafficSample>((done) => {
        resolve = done
      })
    })
    f.session.readTraffic = read
    const first = f.service.readTraffic(view())
    expect(f.service.isTrafficBusy()).toBe(true)
    expect(f.service.state().pending).toBe(false)
    await expect(f.service.whenIdle()).resolves.toBeUndefined()
    expect(await f.service.readTraffic(view())).toBeUndefined()
    expect(read).toHaveBeenCalledOnce()
    resolve(sample(held))
    expect(await first).toMatchObject({ up: 12 })
    expect(f.service.isTrafficBusy()).toBe(false)
  })
  it.each(['stop', 'quit'] as const)(
    'does not wait for a hanging stats response before %s and lease release',
    async (kind) => {
      const f = fixture(),
        id = await start(f)
      f.adapters.confirmStop.mockResolvedValue(true)
      let resolve!: (value: OwnedTrafficSample) => void,
        held!: OwnedCoreTrafficGuards,
        settled = false
      f.session.readTraffic = (guards) => {
        held = guards
        return new Promise<OwnedTrafficSample>((done) => {
          resolve = done
        })
      }
      const reading = f.service.readTraffic(view()).then((value) => {
        settled = true
        return value
      })
      if (kind === 'stop')
        expect((await f.service.action({ action: 'stop', instanceId: id })).status).toBe('stopped')
      else expect(await f.service.requestClose()).toBe('closed')
      expect(held.signal.aborted).toBe(true)
      expect(settled).toBe(false)
      expect(f.stop).toHaveBeenCalledOnce()
      expect(f.release).toHaveBeenCalledOnce()
      expect(f.service.state().phase).toBe('idle')
      resolve(sample(held))
      expect(await reading).toBeUndefined()
      expect(f.service.isTrafficBusy()).toBe(false)
    }
  )
  it('cancels its own stats view without stopping the Core and ignores the late old epoch', async () => {
    const f = fixture()
    await start(f)
    let resolve!: (value: OwnedTrafficSample) => void, held!: OwnedCoreTrafficGuards
    f.session.readTraffic = (guards) => {
      held = guards
      return new Promise<OwnedTrafficSample>((done) => {
        resolve = done
      })
    }
    const reading = f.service.readTraffic(view())
    f.service.cancelTraffic()
    expect(held.signal.aborted).toBe(true)
    expect(() => held.assertLive()).toThrow('已变化')
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
    resolve(sample(held))
    expect(await reading).toBeUndefined()
    f.session.readTraffic = async (guards) => sample(guards, 23)
    expect(await f.service.readTraffic(view())).toMatchObject({ up: 23 })
  })
  it('invalidates stats on owner/prepare revocation without changing Core lifecycle', async () => {
    const f = fixture()
    await start(f)
    let resolve!: (value: OwnedTrafficSample) => void, held!: OwnedCoreTrafficGuards
    f.session.readTraffic = (guards) => {
      held = guards
      return new Promise<OwnedTrafficSample>((done) => {
        resolve = done
      })
    }
    const reading = f.service.readTraffic(view())
    f.service.invalidatePending()
    expect(held.signal.aborted).toBe(true)
    resolve(sample(held))
    expect(await reading).toBeUndefined()
    expect(f.service.state().phase).toBe('running')
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('drops a delayed old-owner sample when reload selects another profile with the same runtime bytes', async () => {
    const f = reloadFixture()
    await start(f)
    const before = f.service.state().configurationRevision
    let resolve!: (value: OwnedTrafficSample) => void, held!: OwnedCoreTrafficGuards
    f.session.readTraffic = (guards) => {
      held = guards
      return new Promise<OwnedTrafficSample>((done) => {
        resolve = done
      })
    }
    const reading = f.service.readTraffic(view())
    const stored = {
      ...f.stored,
      profile: {
        ...f.stored.profile,
        id: '00000000-0000-0000-0000-000000000002',
        name: 'Next same bytes'
      },
      revision: 'c'.repeat(64)
    }
    f.adapters.read.mockResolvedValue(stored)
    f.confirmReload.mockResolvedValue(true)
    const plan = await f.service.prepareReload({
      profile: { id: stored.profile.id, sha256: stored.profile.sha256 },
      httpPort: 18191
    })
    expect((await f.service.reload({ evidenceId: plan.evidenceId })).status).toBe('reloaded')
    expect(f.service.state().profileId).toBe(stored.profile.id)
    expect(f.service.state().configurationRevision).toBe(before)
    expect(held.signal.aborted).toBe(true)
    resolve(sample(held))
    expect(await reading).toBeUndefined()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('links the mandatory view lease abort and never publishes its delayed sample', async () => {
    const f = fixture()
    await start(f)
    const control = new AbortController()
    let resolve!: (value: OwnedTrafficSample) => void, held!: OwnedCoreTrafficGuards
    f.session.readTraffic = (guards) => {
      held = guards
      return new Promise<OwnedTrafficSample>((done) => {
        resolve = done
      })
    }
    const reading = f.service.readTraffic(control.signal)
    control.abort()
    expect(held.signal.aborted).toBe(true)
    resolve(sample(held))
    expect(await reading).toBeUndefined()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it.each(['instanceId', 'configurationRevision'] as const)(
    'refuses a replayed sample with a different %s',
    async (key) => {
      const f = fixture()
      await start(f)
      f.session.readTraffic = async (guards) => ({
        ...sample(guards),
        [key]: key === 'instanceId' ? '00000000-0000-4000-8000-000000000039' : 'f'.repeat(64)
      })
      expect(await f.service.readTraffic(view())).toBeUndefined()
      expect(f.service.state().uncertain).toBe(false)
      expect(f.stop).not.toHaveBeenCalled()
    }
  )
  it('keeps failed telemetry separate from the Core/lease and releases read-busy', async () => {
    const f = fixture()
    await start(f)
    f.session.readTraffic = async () => {
      throw new Error('read failed')
    }
    expect(await f.service.readTraffic(view())).toBeUndefined()
    expect(f.service.isTrafficBusy()).toBe(false)
    expect(f.service.state().phase).toBe('running')
    expect(f.service.state().uncertain).toBe(false)
    expect(f.release).not.toHaveBeenCalled()
  })
})

describe('Runtime consumer revocation begins before an owned operation awaits', () => {
  it('publishes pending and revokes consumers before the first preparation read', async () => {
    const f = fixture()
    let observed: { pending: boolean; reads: number } | undefined
    const service = createLocalProxyService({
      ...f.adapters,
      onRuntimeChanging: () => {
        observed = { pending: service.state().pending, reads: f.adapters.read.mock.calls.length }
      }
    })
    await service.prepare({ profile: f.selection, httpPort: 18191 })
    expect(observed).toEqual({ pending: true, reads: 0 })
    expect(service.state().pending).toBe(false)
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
  it('does not let a throwing observer prevent the owned preparation or cleanup', async () => {
    const f = fixture()
    const onRuntimeChanging = vi.fn(() => {
      throw new Error('observer error')
    })
    const service = createLocalProxyService({ ...f.adapters, onRuntimeChanging })
    const plan = await service.prepare({ profile: f.selection, httpPort: 18191 })
    expect(onRuntimeChanging).toHaveBeenCalledOnce()
    expect(plan.evidenceId).toEqual(expect.any(String))
    expect(service.state().pending).toBe(false)
    expect((await service.action({ action: 'start', evidenceId: plan.evidenceId })).status).toBe(
      'cancelled'
    )
    expect(service.state().pending).toBe(false)
    expect(f.stop).not.toHaveBeenCalled()
  })
})

describe('ordinary multiport service lifecycle', () => {
  const ports = { http: 0, socks: 18192, mixed: 18194, redir: 18195 }
  it('prepares all TCP/UDP ports, starts mixed-only HTTP entry, and retains the complete owner plan', async () => {
    const f = fixture()
    f.adapters.confirmStart.mockResolvedValue(true)
    const plan = await f.service.prepare({ profile: f.selection, httpPort: ports.mixed, ports })
    expect(plan).toMatchObject({ canStart: true, httpPort: ports.mixed, ports })
    expect(f.adapters.portAvailable.mock.calls.flat().sort()).toEqual([18192, 18194, 18195])
    expect(f.adapters.portAvailableUDP.mock.calls.flat().sort()).toEqual([18192, 18194])
    const started = await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    expect(started.status).toBe('started')
    expect(started.state).toMatchObject({ httpPort: ports.mixed, ports })
    expect(f.adapters.start.mock.calls[0][9]).toEqual(ports)
    expect(f.adapters.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ ports }),
      expect.any(String),
      'main'
    )
    const capture = await f.service.captureRuntime(new AbortController().signal)
    expect(capture.status).toBe('captured')
    if (capture.status === 'captured') expect(capture.capture.snapshot.proxyPort).toBe(ports.mixed)
    expect(f.adapters.ownsUDPListener.mock.calls.map((call) => call[1]).sort()).toEqual([
      18192, 18194
    ])
  })
  it.each([
    ['TCP', 18192],
    ['TCP', 18194],
    ['TCP', 18195],
    ['UDP', 18192],
    ['UDP', 18194]
  ] as const)(
    'refuses an occupied %s port %i without acquiring or launching a core',
    async (protocol, occupied) => {
      const f = fixture()
      const probe = protocol === 'TCP' ? f.adapters.portAvailable : f.adapters.portAvailableUDP
      probe.mockImplementation(async (value) => value !== occupied)
      const plan = await f.service.prepare({ profile: f.selection, httpPort: ports.mixed, ports })
      expect(plan.canStart).toBe(false)
      expect(f.adapters.acquire).not.toHaveBeenCalled()
      expect(f.adapters.start).not.toHaveBeenCalled()
    }
  )
  it('rejects persistent multiport before consulting adapters', async () => {
    const f = fixture()
    await expect(
      f.service.prepare({
        profile: f.selection,
        httpPort: ports.mixed,
        ports,
        lifetime: 'persistent'
      })
    ).rejects.toThrow('仅支持普通 HTTP')
    expect(f.adapters.read).not.toHaveBeenCalled()
    expect(f.adapters.acquire).not.toHaveBeenCalled()
  })
  it('rejects an altered SOCKS/Redir plan during hot reload even when HTTP entry stays unchanged', async () => {
    const f = reloadFixture()
    f.adapters.confirmStart.mockResolvedValue(true)
    const plan = await f.service.prepare({ profile: f.selection, httpPort: ports.mixed, ports })
    await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    for (const key of ['socks', 'redir'] as const)
      await expect(
        f.service.prepareReload({
          profile: f.selection,
          httpPort: ports.mixed,
          ports: { ...ports, [key]: ports[key] + 10 }
        })
      ).rejects.toThrow('相同监听端口')
    const reload = await f.service.prepareReload({
      profile: f.selection,
      httpPort: ports.mixed,
      ports
    })
    expect(reload.ports).toEqual(ports)
    f.confirmReload.mockResolvedValue(true)
    expect((await f.service.reload({ evidenceId: reload.evidenceId })).status).toBe('reloaded')
    expect(f.updateRuntime).toHaveBeenCalledWith(expect.objectContaining({ ports }))
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('invalidates capture and refresh when a secondary listener drifts', async () => {
    const f = fixture()
    f.adapters.confirmStart.mockResolvedValue(true)
    const plan = await f.service.prepare({ profile: f.selection, httpPort: ports.mixed, ports })
    const result = await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    const original = f.read.getMockImplementation()
    if (!original) throw new Error('missing synthetic reader')
    f.read.mockImplementation(async (endpoint) => {
      const reply = await original(endpoint)
      return endpoint === 'configs' ? { ...reply, 'redir-port': ports.redir + 1 } : reply
    })
    expect((await f.service.captureRuntime(new AbortController().signal)).status).toBe(
      'unavailable'
    )
    expect(
      (await f.service.action({ action: 'refresh', instanceId: result.state.instanceId })).status
    ).toBe('unconfirmed')
  })
  it('refuses capture when UDP listener belongs to another process', async () => {
    const f = fixture()
    f.adapters.confirmStart.mockResolvedValue(true)
    const plan = await f.service.prepare({ profile: f.selection, httpPort: ports.mixed, ports })
    await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
    f.adapters.ownsUDPListener.mockResolvedValue(false)
    expect((await f.service.captureRuntime(new AbortController().signal)).status).toBe(
      'unavailable'
    )
  })
})

describe('Persisted dedicated node service admission', () => {
  const dedicated = { httpPort: 18193, socksPort: 18190, route: 'Node' }
  const make = () => {
    const f = reloadFixture()
    const node = (
      analyzeProfile(profileRuntimeSource).data?.proxies as Record<string, unknown>[]
    )[0]
    const pin = { node, revision: 'd'.repeat(64) }
    const resolvePinnedNode = vi.fn(async () => structuredClone(pin))
    f.service = createLocalProxyService({
      ...f.adapters,
      confirmReload: f.confirmReload,
      resolvePinnedNode
    })
    f.adapters.confirmStart.mockResolvedValue(true)
    return { ...f, pin, resolvePinnedNode }
  }
  it('forwards the same private snapshot through preparation and actual start without exposing it in IPC results', async () => {
    const f = make()
    const prepared = await f.service.prepare({ profile: f.selection, httpPort: 18191, dedicated })
    const result = await f.service.action({ action: 'start', evidenceId: prepared.evidenceId })
    expect(result.status).toBe('started')
    expect(f.resolvePinnedNode).toHaveBeenCalledTimes(2)
    expect(f.adapters.start.mock.calls[0][10]).toEqual(f.pin.node)
    expect(prepared).not.toHaveProperty('pinnedNode')
    expect(result.state).not.toHaveProperty('pinnedNode')
  })
  it('refuses a changed private revision between preparation and start before acquiring or spawning', async () => {
    const f = make()
    const prepared = await f.service.prepare({ profile: f.selection, httpPort: 18191, dedicated })
    f.pin.revision = 'e'.repeat(64)
    expect(
      (await f.service.action({ action: 'start', evidenceId: prepared.evidenceId })).status
    ).toBe('failed')
    expect(f.adapters.acquire).not.toHaveBeenCalled()
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
  it('injects the persisted node on cold start when the selected ordinary profile no longer contains it', async () => {
    const f = make()
    f.stored.text = profileRuntimeSource.replaceAll('Node', 'Other')
    f.stored.profile.sha256 = profileHash(f.stored.text)
    const original = f.read.getMockImplementation()
    if (!original) throw new Error('missing core reader fixture')
    f.read.mockImplementation(async (endpoint) =>
      endpoint === 'proxies'
        ? { proxies: { Group: { type: 'Selector', now: 'Other', all: ['Other', 'DIRECT'] } } }
        : original(endpoint)
    )
    const prepared = await f.service.prepare({ profile: f.selection, httpPort: 18191, dedicated })
    expect(prepared.canStart).toBe(true)
    expect(
      (await f.service.action({ action: 'start', evidenceId: prepared.evidenceId })).status
    ).toBe('started')
    expect(f.adapters.start.mock.calls[0][10]).toEqual(f.pin.node)
  })
  it('switches the ordinary profile on the same process while retaining the fixed node and listener plan', async () => {
    const f = make()
    const prepared = await f.service.prepare({ profile: f.selection, httpPort: 18191, dedicated })
    expect(
      (await f.service.action({ action: 'start', evidenceId: prepared.evidenceId })).status
    ).toBe('started')
    const originalState = f.service.state()
    f.stored.text = profileRuntimeSource.replaceAll('Node', 'Other')
    f.stored.profile = {
      ...f.stored.profile,
      id: '00000000-0000-0000-0000-000000000002',
      sha256: profileHash(f.stored.text)
    }
    f.stored.revision = 'f'.repeat(64)
    const candidate = await f.service.prepareReload({
      profile: { id: f.stored.profile.id, sha256: f.stored.profile.sha256 },
      httpPort: 18191,
      dedicated
    })
    const original = f.read.getMockImplementation()
    if (!original) throw new Error('missing core reader fixture')
    f.read.mockImplementation(async (endpoint) =>
      endpoint === 'proxies'
        ? { proxies: { Group: { type: 'Selector', now: 'Other', all: ['Other', 'DIRECT'] } } }
        : original(endpoint)
    )
    f.confirmReload.mockResolvedValue(true)
    const result = await f.service.reload({ evidenceId: candidate.evidenceId })
    expect(result.status).toBe('reloaded')
    expect(result.state).toMatchObject({
      pid: originalState.pid,
      instanceId: originalState.instanceId,
      dedicated: originalState.dedicated,
      profileId: f.stored.profile.id
    })
    const runtime = JSON.parse(f.reload.mock.calls[0][0])
    expect(runtime.proxies.find((node: { name: string }) => node.name === 'Node')).toEqual(
      f.pin.node
    )
    expect(
      runtime.listeners.every((listener: { proxy: string }) => listener.proxy === 'Node')
    ).toBe(true)
    expect(f.adapters.start).toHaveBeenCalledOnce()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('refuses a refreshed same-name replacement before preparing any core reload', async () => {
    const f = make()
    const prepared = await f.service.prepare({ profile: f.selection, httpPort: 18191, dedicated })
    expect(
      (await f.service.action({ action: 'start', evidenceId: prepared.evidenceId })).status
    ).toBe('started')
    const before = f.service.state()
    const source = analyzeProfile(profileRuntimeSource).data
    if (!source) throw new Error('missing profile fixture')
    ;(source.proxies as Record<string, unknown>[])[0].server = '192.0.2.55'
    f.stored.text = JSON.stringify(source)
    f.stored.revision = 'f'.repeat(64)
    await expect(
      f.service.prepareReload({ profile: f.selection, httpPort: 18191, dedicated })
    ).rejects.toThrow('同名')
    expect(f.service.state()).toMatchObject({
      pid: before.pid,
      instanceId: before.instanceId,
      owned: true,
      dedicated: before.dedicated
    })
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('preserves the running core when the private pin changes after reload preparation', async () => {
    const f = make()
    const prepared = await f.service.prepare({ profile: f.selection, httpPort: 18191, dedicated })
    expect(
      (await f.service.action({ action: 'start', evidenceId: prepared.evidenceId })).status
    ).toBe('started')
    const reload = await f.service.prepareReload({
      profile: f.selection,
      httpPort: 18191,
      dedicated
    })
    f.confirmReload.mockResolvedValue(true)
    f.pin.revision = 'e'.repeat(64)
    expect((await f.service.reload({ evidenceId: reload.evidenceId })).status).toBe('failed')
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.service.state().owned).toBe(true)
  })
})
