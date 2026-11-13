import { describe, expect, it, vi } from 'vitest'
import {
  localProxyAction,
  localProxyPrepare,
  type LocalProxyState,
  type LocalProxyResult,
  type LocalReloadPreparation
} from '../../shared/relay/local-proxy'
import { createClashBackend } from './clash-backend'
import { inspectProfile } from './profiles/inspect'
import { profileHash } from './profiles/source'

function fixture() {
  const text = JSON.stringify({
    proxies: [{ name: 'A', type: 'http', server: '127.0.0.1', port: 1, password: 'PRIVATE' }],
    'proxy-groups': [{ name: 'Group', type: 'select', proxies: ['A'] }],
    rules: ['MATCH,Group']
  })
  const summary = inspectProfile(text).summary
  if (!summary) throw new Error('fixture summary missing')
  const profile = {
    id: '00000000-0000-0000-0000-000000000001',
    sha256: profileHash(text),
    name: 'Private copy',
    createdAt: '2026-10-25T00:00:00Z',
    summary
  }
  const state: LocalProxyState = {
    phase: 'idle',
    pending: false,
    owned: false,
    hasRecord: false,
    uncertain: false,
    traffic: 'inactive',
    groups: [],
    systemProxyChanged: false,
    liveGuardEnabled: false,
    warnings: []
  }
  const live = {
    instanceId: '00000000-0000-0000-0000-000000000025',
    config: { mode: 'rule', port: 18191 },
    runtime: JSON.parse(text) as Record<string, unknown>,
    proxies: {
      proxies: {
        A: { name: 'A', type: 'Http', history: [] },
        Group: { name: 'Group', type: 'Selector', now: 'A', all: ['A'] },
        GLOBAL: { name: 'GLOBAL', type: 'Selector', now: 'Group', all: ['Group'] }
      }
    },
    providers: { providers: {} },
    version: { version: 'v1.19.33' },
    rules: { rules: [] }
  }
  const local = {
    connections: vi.fn(async () => ({ connections: [], download: 0, upload: 0 })),
    logs: vi.fn(() => []),
    closeConnection: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {}),
    state: vi.fn(() => structuredClone(state)),
    whenIdle: vi.fn(async () => {}),
    inspectLive: vi.fn(async () => (state.phase === 'running' ? structuredClone(live) : undefined)),
    action: vi.fn(async (raw: unknown): Promise<LocalProxyResult> => {
      const input = localProxyAction(raw)
      if (input.action === 'mode') {
        state.mode = input.mode
        live.config.mode = input.mode
        return { status: 'modeChanged', state: structuredClone(state) }
      }
      if (input.action === 'probe')
        return { status: 'tested', state: structuredClone(state), delay: 17 }
      return { status: 'selected', state: structuredClone(state) }
    })
  }
  const profiles = {
    list: vi.fn(async () => ({ profiles: [profile], incomplete: 0, activeId: null, warnings: [] })),
    read: vi.fn(async () => ({ profile, text, revision: 'a'.repeat(64) }))
  }
  const notify = vi.fn(),
    backend = createClashBackend({ local, profiles, notify })
  return {
    backend,
    local,
    profiles,
    profile,
    state,
    live,
    notify,
    running: () => {
      Object.assign(state, {
        phase: 'running',
        traffic: 'listening',
        owned: true,
        instanceId: live.instanceId,
        profileId: profile.id,
        mode: 'rule'
      })
    }
  }
}
describe('Ordinary Clash channels routed to the owned service', () => {
  it('pins connection close actions to the observed instance and configuration', async () => {
    const f = fixture()
    f.running()
    const target = {
      instanceId: f.state.instanceId,
      configurationRevision: f.state.configurationRevision
    }
    await f.backend.invoke('mihomoCloseConnection', ['connection-1', target])
    await f.backend.invoke('mihomoCloseAllConnections', [target])
    expect(f.local.closeConnection).toHaveBeenCalledExactlyOnceWith('connection-1')
    expect(f.local.closeAllConnections).toHaveBeenCalledOnce()
    f.state.configurationRevision = 'b'.repeat(64)
    await expect(
      f.backend.invoke('mihomoCloseConnection', ['connection-1', target])
    ).rejects.toThrow('已变化')
    await expect(f.backend.invoke('mihomoCloseAllConnections', [target])).rejects.toThrow('已变化')
    expect(f.local.closeConnection).toHaveBeenCalledTimes(1)
    expect(f.local.closeAllConnections).toHaveBeenCalledTimes(1)
  })
  it('refuses stale instance and unexpected close-target fields before mutation', async () => {
    const f = fixture()
    f.running()
    for (const target of [
      { instanceId: 'foreign', configurationRevision: undefined },
      { instanceId: f.state.instanceId, configurationRevision: undefined, path: '/foreign' }
    ])
      await expect(f.backend.invoke('mihomoCloseAllConnections', [target])).rejects.toThrow()
    expect(f.local.closeAllConnections).not.toHaveBeenCalled()
  })
  it('restores a saved choice lazily and cannot overwrite a newer explicit selection with a late read', async () => {
    const f = fixture()
    let finish: ((value: { id: string; sha256: string } | undefined) => void) | undefined
    const readSelection = vi.fn(
        () =>
          new Promise<{ id: string; sha256: string } | undefined>((resolve) => {
            finish = resolve
          })
      ),
      rememberSelection = vi.fn(async () => {}),
      backend = createClashBackend({ ...f, readSelection, rememberSelection })
    expect(readSelection).not.toHaveBeenCalled()
    await expect(backend.invoke('getProfileConfig', ['bad'])).rejects.toThrow('参数')
    expect(readSelection).not.toHaveBeenCalled()
    const reading = backend.invoke('getProfileConfig', [])
    await vi.waitFor(() => expect(readSelection).toHaveBeenCalledOnce())
    await backend.invoke('changeCurrentProfile', [f.profile.id])
    finish?.(undefined)
    expect(await reading).toMatchObject({ current: f.profile.id })
    expect(rememberSelection).toHaveBeenCalledExactlyOnceWith({
      id: f.profile.id,
      sha256: f.profile.sha256
    })
    expect(f.local.action).not.toHaveBeenCalled()
  })
  it('binds the workspace selection and read-only original to the exact held profile digest', async () => {
    const f = fixture()
    const expected = { id: f.profile.id, sha256: f.profile.sha256 }
    const stored = await f.profiles.read()
    const read = vi.fn(async (selection: typeof expected) => {
      if (selection.id !== expected.id || selection.sha256 !== expected.sha256)
        throw new Error('原文已变化')
      return stored
    })
    const backend = createClashBackend({ ...f, profiles: { ...f.profiles, read } })
    const stale = { ...expected, sha256: 'f'.repeat(64) }
    await expect(backend.invoke('getProfileStr', [stale])).rejects.toThrow('已变化')
    await expect(backend.invoke('changeCurrentProfile', [stale])).rejects.toThrow('已变化')
    await expect(
      backend.invoke('getProfileStr', [{ ...expected, path: '/foreign' }])
    ).rejects.toThrow('只接受')
    await expect(backend.invoke('getProfileStr', [expected])).resolves.toBe(stored.text)
    await backend.invoke('changeCurrentProfile', [expected])
    expect(await backend.invoke('getProfileConfig', [])).toMatchObject({ current: expected.id })
    expect(f.local.action).not.toHaveBeenCalled()
    for (const channel of [
      'addProfileItem',
      'setProfileConfig',
      'setProfileStr',
      'updatePluginProfile'
    ]) {
      expect(backend.handles(channel)).toBe(false)
      await expect(backend.invoke(channel, [expected])).rejects.toThrow('尚未接入')
    }
  })
  it('routes an exact workspace selection through the running instance confirmation and reports a cancelled reload as unchanged', async () => {
    const f = fixture()
    f.running()
    const oldProfileId = '00000000-0000-0000-0000-000000000010'
    f.state.profileId = oldProfileId
    f.state.httpPort = 18191
    const selection = { id: f.profile.id, sha256: f.profile.sha256 }
    const prepareReload = vi.fn(async (): Promise<LocalReloadPreparation> => ({
      evidenceId: 'fixture-evidence',
      instanceId: f.live.instanceId,
      profile: f.profile,
      httpPort: 18191,
      previousSHA256: 'a'.repeat(64),
      runtimeSHA256: 'b'.repeat(64),
      scope: 'controlled-local-projection',
      warnings: []
    }))
    const reload = vi.fn(async (): Promise<LocalProxyResult> => ({
      status: 'cancelled',
      state: structuredClone(f.state)
    }))
    const rememberSelection = vi.fn(async () => {})
    const backend = createClashBackend({
      ...f,
      local: { ...f.local, prepareReload, reload },
      rememberSelection
    })
    await backend.invoke('changeCurrentProfile', [selection])
    expect(prepareReload).toHaveBeenCalledExactlyOnceWith({
      profile: selection,
      httpPort: 18191,
      resolverMode: 'off'
    })
    expect(reload).toHaveBeenCalledExactlyOnceWith({ evidenceId: 'fixture-evidence' })
    expect(rememberSelection).not.toHaveBeenCalled()
    expect(await backend.invoke('getProfileConfig', [])).toMatchObject({ current: oldProfileId })
  })
  it.each([
    { http: 0, socks: 18192, mixed: 18194, redir: 18195 },
    { http: 18191, socks: 18192, mixed: 18194, redir: 18195 }
  ])(
    'retains all live inbound ports and only valid AI plan fields during profile switching: %j',
    async (ports) => {
      const f = fixture()
      f.running()
      f.state.profileId = '00000000-0000-0000-0000-000000000010'
      f.state.httpPort = ports.http || ports.mixed
      f.state.ports = ports
      f.state.dedicated = {
        httpPort: 18193,
        socksPort: 18190,
        route: 'A',
        httpName: 'relay-ai-http',
        socksName: 'relay-ai-socks'
      }
      const selection = { id: f.profile.id, sha256: f.profile.sha256 }
      const prepareReload = vi.fn(async (raw: unknown): Promise<LocalReloadPreparation> => {
        const request = localProxyPrepare(raw)
        expect(request.ports).toEqual(ports)
        expect(request.httpPort).toBe(ports.http || ports.mixed)
        expect(request.dedicated).toEqual({ httpPort: 18193, socksPort: 18190, route: 'A' })
        return {
          evidenceId: 'fixture-evidence',
          instanceId: f.live.instanceId,
          profile: f.profile,
          httpPort: request.httpPort,
          ports: request.ports,
          previousSHA256: 'a'.repeat(64),
          runtimeSHA256: 'b'.repeat(64),
          scope: 'controlled-local-projection',
          warnings: []
        }
      })
      const reload = vi.fn(async (): Promise<LocalProxyResult> => {
        f.state.profileId = f.profile.id
        return { status: 'reloaded', state: structuredClone(f.state) }
      })
      const rememberSelection = vi.fn(async () => {})
      const backend = createClashBackend({
        ...f,
        local: { ...f.local, prepareReload, reload },
        rememberSelection
      })
      await backend.invoke('changeCurrentProfile', [selection])
      expect(prepareReload).toHaveBeenCalledExactlyOnceWith({
        profile: selection,
        httpPort: ports.http || ports.mixed,
        ports,
        dedicated: { httpPort: 18193, socksPort: 18190, route: 'A' },
        resolverMode: 'off'
      })
      expect(reload).toHaveBeenCalledExactlyOnceWith({ evidenceId: 'fixture-evidence' })
      expect(rememberSelection).toHaveBeenCalledExactlyOnceWith(selection)
      expect(f.local.action).not.toHaveBeenCalled()
      expect(f.state.dedicated).toMatchObject({
        httpName: 'relay-ai-http',
        socksName: 'relay-ai-socks'
      })
      expect(await backend.invoke('getProfileConfig', [])).toMatchObject({ current: f.profile.id })
    }
  )
  it('keeps selection and quit barriers while persistence is pending, preserving the selected source on a lost acknowledgement', async () => {
    const f = fixture()
    let fail: ((error: Error) => void) | undefined
    const rememberSelection = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject
          })
      ),
      backend = createClashBackend({ ...f, rememberSelection })
    const changing = backend.invoke('changeCurrentProfile', [f.profile.id])
    const outcome = expect(changing).rejects.toThrow('lost ack')
    await vi.waitFor(() => expect(rememberSelection).toHaveBeenCalledOnce())
    expect(backend.isBusy()).toBe(true)
    let idle = false
    const waiting = backend.whenIdle().then(() => {
      idle = true
    })
    await expect(backend.invoke('changeCurrentProfile', [f.profile.id])).rejects.toThrow('等待')
    expect(idle).toBe(false)
    fail?.(new Error('lost ack'))
    await outcome
    await waiting
    expect(backend.isBusy()).toBe(false)
    expect(await backend.invoke('getProfileConfig', [])).toMatchObject({ current: f.profile.id })
    expect(f.local.action).not.toHaveBeenCalled()
  })
  it('does no startup IO, keeps system capabilities out and does not pretend there is a running mode', async () => {
    const f = fixture()
    expect(f.local.inspectLive).not.toHaveBeenCalled()
    expect(f.profiles.list).not.toHaveBeenCalled()
    expect(f.backend.handles('setSystemProxy')).toBe(false)
    expect(f.backend.handles('mihomoCloseAllConnections')).toBe(true)
    expect(f.backend.handles('mihomoCloseConnection')).toBe(true)
    expect(f.backend.handles('restartCore')).toBe(false)
    expect(await f.backend.invoke('getControledMihomoConfig', [])).not.toHaveProperty('mode')
    await expect(f.backend.invoke('patchMihomoConfig', [{ mode: 'global' }])).rejects.toThrow(
      '启动'
    )
    expect(f.local.action).not.toHaveBeenCalled()
  })
  it('lists only private metadata, rejects paths and never activates a selected source implicitly', async () => {
    const f = fixture()
    await expect(f.backend.invoke('getProfileStr', ['/PRIVATE'])).rejects.toThrow('ID')
    expect(f.profiles.read).not.toHaveBeenCalled()
    await f.backend.invoke('changeCurrentProfile', [f.profile.id])
    const list = await f.backend.invoke('getProfileConfig', [false])
    expect(list).toMatchObject({
      current: f.profile.id,
      items: [{ id: f.profile.id, type: 'local' }]
    })
    expect(JSON.stringify(list)).not.toContain('PRIVATE')
    expect(f.local.action).not.toHaveBeenCalled()
    f.running()
    await expect(f.backend.invoke('changeCurrentProfile', [f.profile.id])).rejects.toThrow('停止')
  })
  it('rejects extra fields/arguments before a write and sends exactly one mode transaction', async () => {
    const f = fixture()
    f.running()
    for (const args of [
      [{ mode: 'global', tun: { enable: true } }],
      [{ mode: 'global' }, 'extra'],
      [{ mode: 'bad' }]
    ])
      await expect(f.backend.invoke('patchMihomoConfig', args)).rejects.toThrow()
    expect(f.local.action).not.toHaveBeenCalled()
    await f.backend.invoke('patchControledMihomoConfig', [{ mode: 'global' }])
    expect(f.local.action).toHaveBeenCalledExactlyOnceWith({
      action: 'mode',
      instanceId: f.live.instanceId,
      mode: 'global'
    })
    expect(f.notify).toHaveBeenCalledTimes(1)
    expect(await f.backend.invoke('getControledMihomoConfig', [])).toMatchObject({ mode: 'global' })
  })
  it('combines complete provider records and refuses missing members rather than deleting them', async () => {
    const f = fixture()
    f.running()
    const provider = {
      providers: { P: { proxies: [{ name: 'PNode', type: 'Http', 'provider-name': 'P' }] } }
    }
    f.local.inspectLive.mockResolvedValueOnce({
      ...f.live,
      providers: provider,
      proxies: {
        proxies: {
          ...f.live.proxies.proxies,
          Group: { ...f.live.proxies.proxies.Group, all: ['PNode'] }
        }
      }
    })
    const groups = await f.backend.invoke('mihomoGroups', [false])
    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Group',
          all: [{ name: 'PNode', type: 'Http', 'provider-name': 'P' }]
        })
      ])
    )
    f.local.inspectLive.mockResolvedValueOnce({
      ...f.live,
      proxies: {
        proxies: {
          ...f.live.proxies.proxies,
          Group: { ...f.live.proxies.proxies.Group, all: ['Missing'] }
        }
      }
    })
    await expect(f.backend.invoke('mihomoGroups', [])).rejects.toThrow('缺少')
    await expect(f.backend.invoke('mihomoGroups', [true, 'ignored'])).rejects.toThrow('参数')
  })
  it('pins queued probes to the original instance and refuses arbitrary protocols/credentials', async () => {
    const f = fixture()
    f.running()
    for (const url of [
      'file:///PRIVATE',
      'https://user:PRIVATE@example.invalid/',
      'https://example.invalid/#x'
    ])
      await expect(f.backend.invoke('mihomoProxyDelay', ['A', url])).rejects.toThrow()
    expect(f.local.action).not.toHaveBeenCalled()
    let release!: () => void
    f.local.whenIdle.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const pending = f.backend.invoke('mihomoProxyDelay', ['A', 'http://fixture.invalid/'])
    await vi.waitFor(() => expect(f.local.whenIdle).toHaveBeenCalled())
    f.state.instanceId = '00000000-0000-0000-0000-000000000099'
    release()
    await expect(pending).rejects.toThrow('实例已改变')
    expect(f.local.action).not.toHaveBeenCalled()
  })
  it('drops a queued probe when configuration changes on the same owned process', async () => {
    const f = fixture()
    f.running()
    f.state.configurationRevision = 'a'.repeat(64)
    let release: () => void = () => {}
    f.local.whenIdle.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const pending = f.backend.invoke('mihomoProxyDelay', ['A', 'http://fixture.invalid/'])
    await vi.waitFor(() => expect(f.local.whenIdle).toHaveBeenCalled())
    f.state.configurationRevision = 'b'.repeat(64)
    release()
    await expect(pending).rejects.toThrow('配置已改变')
    expect(f.local.action).not.toHaveBeenCalled()
  })
})
