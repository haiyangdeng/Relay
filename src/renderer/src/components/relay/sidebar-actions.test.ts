import { describe, expect, it, vi } from 'vitest'
import { defaultEditDocument } from '../../../../shared/relay/configuration-edit'
import { defaultSystemProxyDraft } from '../../../../shared/relay/system-proxy-draft'
import { localProxyPrepare } from '../../../../shared/relay/local-proxy'
import { sidebarConfigurationSwitch, sidebarSystemProxy } from './sidebar-actions'
import { sidebarRates } from './use-sidebar-status'
const state = {
  owned: true,
  phase: 'running',
  traffic: 'listening',
  instanceId: 'owned',
  profileId: 'profile',
  configurationRevision: 'before',
  httpPort: 18191,
  resolution: { mode: 'off' },
  pending: false,
  uncertain: false
}
function fixture() {
  const document = {
    ...defaultEditDocument(),
    controlled: { dns: { enable: true }, sniffer: { enable: true } }
  }
  let runtime = structuredClone(document.controlled)
  const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (channel === 'relayLocalProxyState') return state
    if (channel === 'relayConfigEditRead')
      return { document: structuredClone(document), revision: 'rev', exists: true }
    if (channel === 'relayConfigEditSave') {
      Object.assign(document, (args[0] as { document: typeof document }).document)
      return { document, revision: 'next', exists: true }
    }
    if (channel === 'relayProfileList') return { profiles: [{ id: 'profile', sha256: 'source' }] }
    if (channel === 'relayLocalProxyReloadPrepare')
      return { evidenceId: 'prepared', instanceId: 'owned', previousSHA256: 'before' }
    if (channel === 'relayLocalProxyReload') {
      runtime = structuredClone(document.controlled)
      return { status: 'reloaded', state }
    }
    if (channel === 'getRuntimeConfig') return runtime
    throw new Error('Unexpected action ' + channel)
  })
  return { invoke, document }
}
describe('Relay sidebar shortcuts', () => {
  it.each([
    { kind: 'dns' as const, ports: { http: 18191, socks: 18192, mixed: 18194, redir: 18195 } },
    { kind: 'sniff' as const, ports: { http: 18191, socks: 18192, mixed: 18194, redir: 18195 } },
    { kind: 'dns' as const, ports: { http: 0, socks: 18192, mixed: 18191, redir: 0 } },
    { kind: 'sniff' as const, ports: { http: 0, socks: 18192, mixed: 18191, redir: 0 } }
  ])(
    'preserves live ports and projects full AI summaries into strict reload input %j',
    async ({ kind, ports }) => {
      const f = fixture(),
        original = f.invoke.getMockImplementation()
      if (!original) throw Error('fixture')
      const profile = { id: '63f90396-1cd2-4f63-b7ba-8e8f3dba1444', sha256: 'a'.repeat(64) }
      const dedicated = {
        httpName: 'relay-ai-http',
        socksName: 'relay-ai-socks',
        httpPort: 18193,
        socksPort: 18190,
        route: 'fixed'
      }
      const current = { ...state, profileId: profile.id, ports, dedicated }
      const validated: ReturnType<typeof localProxyPrepare>[] = []
      f.invoke.mockImplementation(async (channel, ...args) => {
        if (channel === 'relayLocalProxyState') return current
        if (channel === 'relayProfileList') return { profiles: [profile] }
        if (channel === 'relayLocalProxyReloadPrepare') {
          // Exercise the real strict IPC parser: forwarding httpName/socksName
          // or silently dropping ordinary ports must not hide behind a mock.
          validated.push(localProxyPrepare(args[0]))
        }
        const result = await original(channel, ...args)
        return channel === 'relayLocalProxyReload' ? { status: 'reloaded', state: current } : result
      })
      expect(await sidebarConfigurationSwitch(kind, false, profile.id, f.invoke, () => true)).toBe(
        'applied'
      )
      expect(validated).toEqual([
        {
          profile,
          httpPort: 18191,
          ports,
          resolverMode: 'off',
          lifetime: 'main',
          dedicated: { httpPort: 18193, socksPort: 18190, route: 'fixed' }
        }
      ])
      expect(f.invoke).toHaveBeenCalledWith('relayLocalProxyReloadPrepare', {
        profile,
        httpPort: 18191,
        ports,
        resolverMode: 'off',
        dedicated: { httpPort: 18193, socksPort: 18190, route: 'fixed' }
      })
      expect(current.dedicated).toEqual(dedicated)
    }
  )
  it('saves the requested DNS switch and applies through the existing current-instance reload', async () => {
    const f = fixture()
    expect(await sidebarConfigurationSwitch('dns', false, 'profile', f.invoke, () => true)).toBe(
      'applied'
    )
    expect(f.document.controlled.dns.enable).toBe(false)
    expect(f.document.controlled.sniffer.enable).toBe(true)
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayLocalProxyState',
      'relayConfigEditRead',
      'relayConfigEditSave',
      'relayProfileList',
      'relayLocalProxyReloadPrepare',
      'relayLocalProxyReload',
      'getRuntimeConfig',
      'relayLocalProxyState'
    ])
    expect(
      f.invoke.mock.calls.some(([channel]) => ['restartCore', 'patchAppConfig'].includes(channel))
    ).toBe(false)
  })
  it('preserves source protection and reports a runtime switch that did not take effect', async () => {
    const f = fixture(),
      original = f.invoke.getMockImplementation()
    if (!original) throw Error('fixture')
    f.invoke.mockImplementation((channel, ...args) =>
      channel === 'getRuntimeConfig'
        ? Promise.resolve({ dns: { enable: true } })
        : original(channel, ...args)
    )
    await expect(
      sidebarConfigurationSwitch('dns', false, 'profile', f.invoke, () => true)
    ).rejects.toThrow('来源保护')
    expect(f.document).not.toHaveProperty('disableDnsOverrideGuard', true)
  })
  it('never starts or restarts an inactive core and saves for its next activation', async () => {
    const f = fixture(),
      original = f.invoke.getMockImplementation()
    if (!original) throw Error('fixture')
    f.invoke.mockImplementation((channel, ...args) =>
      channel === 'relayLocalProxyState'
        ? Promise.resolve({ ...state, owned: false, phase: 'idle' })
        : original(channel, ...args)
    )
    expect(await sidebarConfigurationSwitch('sniff', false, 'profile', f.invoke, () => true)).toBe(
      'saved'
    )
    expect(f.invoke.mock.calls.map(([channel]) => channel)).not.toContain(
      'relayLocalProxyReloadPrepare'
    )
  })
  it('does not apply a late candidate after the selected profile changes', async () => {
    const f = fixture(),
      original = f.invoke.getMockImplementation()
    if (!original) throw Error('fixture')
    let current = true
    f.invoke.mockImplementation(async (channel, ...args) => {
      const result = await original(channel, ...args)
      if (channel === 'relayLocalProxyReloadPrepare') current = false
      return result
    })
    await expect(
      sidebarConfigurationSwitch('dns', false, 'profile', f.invoke, () => current)
    ).rejects.toThrow('已变化')
    expect(f.invoke.mock.calls.map(([channel]) => channel)).not.toContain('relayLocalProxyReload')
  })
  it('uses saved system proxy settings and only enabled network services, with guarded preparation', async () => {
    const report = {
      canApply: true,
      canRestore: false,
      status: 'inactive',
      services: [
        { id: 'a', enabled: true },
        { id: 'b', enabled: false }
      ]
    }
    const completed = { ...report, status: 'applied', recordID: 'owned-record', canRestore: true }
    const invoke = vi.fn(async (channel: string, ..._args: unknown[]): Promise<unknown> => {
      if (channel === 'relayLocalProxyState') return state
      if (channel === 'relaySystemProxyDraftRead')
        return { document: defaultSystemProxyDraft(), revision: '', exists: false }
      if (channel === 'relaySystemProxyInspect') return report
      if (channel === 'relaySystemProxyPrepare')
        return { action: 'apply', evidenceId: 'plan', report }
      if (channel === 'relaySystemProxyExecute')
        return { status: 'applied', report: completed, warnings: [] }
      throw Error('Unexpected ' + channel)
    })
    expect(await sidebarSystemProxy(true, invoke)).toBe(completed)
    expect(invoke).toHaveBeenCalledWith('relaySystemProxyPrepare', {
      ...defaultSystemProxyDraft(),
      port: 18191,
      serviceIDs: ['a']
    })
    expect(invoke).toHaveBeenCalledWith('relaySystemProxyExecute', { evidenceId: 'plan' })
  })
  it('computes rates only across comparable samples; unknown, reset, stale, and changed cores are blank', () => {
    const prior = { id: 'a', at: 1000, upload: 100, download: 500 },
      next = { id: 'a', at: 3000, upload: 300, download: 1500 }
    expect(sidebarRates(prior, next)).toEqual({ upload: 100, download: 500 })
    for (const changed of [
      { ...next, id: 'b' },
      { ...next, at: 1000 },
      { ...next, at: 12000 },
      { ...next, upload: 0 }
    ])
      expect(sidebarRates(prior, changed)).toBeUndefined()
    expect(sidebarRates(undefined, next)).toBeUndefined()
  })
  it('returns only completed restoration receipts and never presents an uncertain result as success', async () => {
    const inspected = { status: 'active', recordID: 'owned-record', canRestore: true },
      restored = { status: 'restored', canRestore: false }
    for (const status of ['restored', 'uncertain']) {
      const invoke = vi.fn(async (channel: string): Promise<unknown> => {
        if (channel === 'relaySystemProxyInspect') return inspected
        if (channel === 'relaySystemProxyRestorePrepare')
          return { action: 'restore', evidenceId: 'plan', report: inspected }
        if (channel === 'relaySystemProxyExecute')
          return { status, report: status === 'restored' ? restored : inspected, warnings: [] }
        throw Error('Unexpected ' + channel)
      })
      if (status === 'restored') expect(await sidebarSystemProxy(false, invoke)).toBe(restored)
      else await expect(sidebarSystemProxy(false, invoke)).rejects.toThrow('恢复结果需要核对')
      expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
        'relaySystemProxyInspect',
        'relaySystemProxyRestorePrepare',
        'relaySystemProxyExecute'
      ])
    }
  })
  it('refuses system takeover while the owned core is pending, uncertain, or stopping', async () => {
    for (const changed of [{ pending: true }, { uncertain: true }, { phase: 'stopping' }]) {
      const invoke = vi.fn(async (channel: string): Promise<unknown> => {
        if (channel === 'relayLocalProxyState') return { ...state, ...changed }
        if (channel === 'relaySystemProxyDraftRead')
          return { document: defaultSystemProxyDraft(), revision: '', exists: false }
        if (channel === 'relaySystemProxyInspect') return { canApply: true }
        throw Error('Unexpected mutation ' + channel)
      })
      await expect(sidebarSystemProxy(true, invoke)).rejects.toThrow('状态需要核对')
      expect(invoke.mock.calls.some(([channel]) => channel === 'relaySystemProxyPrepare')).toBe(
        false
      )
    }
  })
  it('checks an unobserved enable intent and avoids rewriting an already owned active proxy', async () => {
    for (const status of ['active', 'applied']) {
      const invoke = vi.fn(async (channel: string): Promise<unknown> => {
        if (channel === 'relaySystemProxyInspect') return { status, recordID: 'owned-record' }
        throw Error('Unexpected mutation ' + channel)
      })
      expect(await sidebarSystemProxy(true, invoke)).toEqual({ status, recordID: 'owned-record' })
      expect(invoke.mock.calls).toEqual([['relaySystemProxyInspect']])
    }
  })
  it('starts the selected idle configuration before the single explicit system-proxy application', async () => {
    const f = startupFixture()
    await sidebarSystemProxy(true, f.invoke)
    expect(f.invoke).toHaveBeenCalledWith('relayLocalProxyPrepare', {
      profile: { id: 'profile', sha256: 'source' },
      httpPort: 18191,
      resolverMode: 'profile',
      lifetime: 'main'
    })
    const calls = f.invoke.mock.calls.map(([channel]) => channel)
    expect(calls.indexOf('relayLocalProxyAction')).toBeLessThan(
      calls.indexOf('relaySystemProxyPrepare')
    )
    expect(calls.filter((channel) => channel === 'relaySystemProxyExecute')).toHaveLength(1)
    expect(calls).not.toContain('relayLocalProxyReload')
    expect(calls).not.toContain('relayTunStart')
  })
  it.each(['unavailable', 'blocked', 'uncertain', 'changed-selection', 'cancelled-view'])(
    'never applies system settings after %s prevents confirming the selected core',
    async (failure) => {
      const f = startupFixture(failure)
      await expect(sidebarSystemProxy(true, f.invoke, () => f.current())).rejects.toThrow()
      expect(f.invoke.mock.calls.map(([channel]) => channel)).not.toContain(
        'relaySystemProxyPrepare'
      )
      expect(f.invoke.mock.calls.map(([channel]) => channel)).not.toContain(
        'relaySystemProxyExecute'
      )
      if (failure !== 'uncertain')
        expect(f.invoke.mock.calls.map(([channel]) => channel)).not.toContain(
          'relayLocalProxyAction'
        )
    }
  )
})

function startupFixture(failure?: string) {
  let started = false,
    prepared = false,
    current = true
  const report = {
    status: 'inactive',
    canApply: true,
    canRestore: false,
    services: [{ id: 'a', enabled: true }]
  }
  const invoke = vi.fn(async (channel: string, ..._args: unknown[]): Promise<unknown> => {
    if (channel === 'relaySystemProxyInspect') return report
    if (channel === 'relaySystemProxyDraftRead')
      return { document: defaultSystemProxyDraft(), revision: '', exists: false }
    if (channel === 'relayLocalProxyState')
      return started
        ? { ...state, uncertain: failure === 'uncertain' }
        : {
            ...state,
            phase: 'idle',
            owned: false,
            hasRecord: false,
            traffic: 'inactive'
          }
    if (channel === 'getProfileConfig')
      return {
        current: failure === 'changed-selection' && prepared ? 'other' : 'profile',
        items: []
      }
    if (channel === 'relayProfileList')
      return { profiles: failure === 'unavailable' ? [] : [{ id: 'profile', sha256: 'source' }] }
    if (channel === 'relayLocalProxyPlanRead')
      return { document: { httpPort: 18191, resolverMode: 'profile' }, revision: '', exists: false }
    if (channel === 'changeCurrentProfile') return
    if (channel === 'relayLocalProxyPrepare') {
      prepared = true
      if (failure === 'cancelled-view') current = false
      return { canStart: failure !== 'blocked', evidenceId: 'start', warnings: ['port occupied'] }
    }
    if (channel === 'relayLocalProxyAction') {
      started = true
      return { status: 'started', state }
    }
    if (channel === 'relaySystemProxyPrepare')
      return { action: 'apply', evidenceId: 'apply', report }
    if (channel === 'relaySystemProxyExecute') return { status: 'applied', warnings: [] }
    throw Error('Unexpected ' + channel)
  })
  return { invoke, current: () => current }
}
