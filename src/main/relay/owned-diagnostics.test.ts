import { describe, expect, it, vi } from 'vitest'
import type { LocalProxyState } from '../../shared/relay/local-proxy'
import { externalDiagnosticRecord } from '../../shared/relay/diagnostic-evidence'
import { validateReadOnlyReport } from '../../shared/relay/protocol'
import { createOwnedDiagnosticService } from './owned-diagnostics'
import { readOnlyFixture } from './__fixtures__/read-only'
import { guardReadinessFixture } from './__fixtures__/guard'
import { createAiClientService } from './ai-clients/service'
import { injectDedicatedListeners } from './core/dedicated-listeners'

export function ownedDiagnosticFixture() {
  const runtime = {
    proxies: [
      {
        name: 'fixed',
        type: 'ss',
        server: '127.0.0.1',
        port: 1443,
        cipher: 'aes-128-gcm',
        password: 'fixture'
      }
    ],
    listeners: []
  }
  const dedicated = injectDedicatedListeners(runtime, {
    httpPort: 17891,
    socksPort: 17890,
    route: 'fixed'
  })
  const state: LocalProxyState = {
    phase: 'running',
    pending: false,
    owned: true,
    hasRecord: true,
    uncertain: false,
    instanceId: '00000000-0000-4000-8000-000000000001',
    pid: 123,
    configurationRevision: 'c'.repeat(64),
    httpPort: 18191,
    ports: { http: 0, mixed: 18191, socks: 0, redir: 0 },
    dedicated,
    resolution: {
      mode: 'profile',
      enabled: true,
      policies: 0,
      hosts: 0,
      bootstrapDerived: false,
      listenerSuppressed: true
    },
    traffic: 'listening',
    groups: [],
    systemProxyChanged: false,
    liveGuardEnabled: false,
    warnings: []
  }
  const report = readOnlyFixture()
  report.owned = {
    appVersion: '1.0.0',
    appBuild: '7',
    browsers: [{ bundleId: 'com.google.Chrome', version: '100.0', profile: 'relay-private' }]
  }
  report.snapshot.browserIntegrated = true
  const live = {
    instanceId: state.instanceId ?? '',
    runtime,
    config: { mode: 'rule' },
    proxies: { proxies: { fixed: { type: 'Shadowsocks' }, shared: { type: 'Selector' } } },
    providers: {},
    rules: {},
    version: { version: 'fixture' },
    coreSHA256: 'd'.repeat(64)
  }
  const record = externalDiagnosticRecord({
    schemaVersion: 1,
    recordedAt: '2026-11-14T01:00:00Z',
    binding: {
      architecture: 'x64',
      appVersion: '1.0.0',
      appBuild: '7',
      coreSHA256: 'd'.repeat(64),
      configurationRevision: 'c'.repeat(64)
    },
    tests: [
      {
        id: 'webrtc',
        testedAt: '2026-11-14T00:59:00Z',
        result: 'noLeakObserved',
        browser: report.owned.browsers[0],
        method: 'Dedicated browser ICE fixture',
        scope: ['Only this browser probe'],
        limitations: ['No packet capture or system filter test'],
        evidenceSHA256: 'e'.repeat(64)
      }
    ]
  })
  const ai = createAiClientService({ state: () => state, liveListener: async () => true })
  const adapters = {
    state: () => structuredClone(state),
    live: vi.fn(async () => structuredClone(live)),
    association: () => ai.inspect(),
    clients: vi.fn(async () => structuredClone(report)),
    guard: async () => guardReadinessFixture(),
    evidence: vi.fn(async () => ({
      status: 'available' as const,
      record: structuredClone(record)
    })),
    listener: vi.fn(async () => true),
    now: () => Date.parse('2026-11-14T02:00:00Z'),
    architecture: 'x64'
  }
  return { state, live, report, record, adapters, service: createOwnedDiagnosticService(adapters) }
}
describe('Owned Relay diagnostics', () => {
  it('separates ordinary and dedicated ports, validates fixed runtime and never makes DNS or runtime checks green', async () => {
    const f = ownedDiagnosticFixture(),
      result = await f.service.observe()
    expect(f.adapters.clients).toHaveBeenCalledWith({
      systemHTTPPort: 18191,
      systemSOCKSPort: 18191,
      codeHTTPPort: 17891,
      dedicatedSOCKSPort: 17890
    })
    expect(result.owned?.route).toBe('fixed')
    expect(result.report.checks.find((r) => r.id === 'routing')?.state).toBe(
      'verifiedConfiguration'
    )
    expect(result.report.checks.find((r) => r.id === 'dns-policy')?.state).toBe('pending')
    expect(result.report.checks.find((r) => r.id === 'guard')?.value).toContain('未提供')
    expect(result.report.checks.slice(5).every((r) => r.state === 'pending')).toBe(true)
    expect(result.owned?.external.bindingMatches).toBe(true)
    expect(result.owned?.external.browserMatches).toEqual([true])
    expect(result.owned?.binding).toEqual(f.record.binding)
    expect(() => validateReadOnlyReport(result.report)).not.toThrow()
    expect(JSON.stringify(result)).not.toContain('password')
  })
  it.each(['DIRECT', 'shared', 'foreign'])(`cannot confirm a %s listener target`, async (route) => {
    const f = ownedDiagnosticFixture()
    ;(f.live.runtime.listeners as Record<string, unknown>[])[0].proxy = route
    expect((await f.service.observe()).report.checks.find((r) => r.id === 'routing')?.state).toBe(
      'attention'
    )
  })
  it('does not substitute other listeners or a stale successful snapshot when the owned core is unavailable', async () => {
    const f = ownedDiagnosticFixture()
    f.adapters.live.mockRejectedValueOnce(new Error('fixture unavailable'))
    const result = await f.service.observe()
    expect(result.owned?.running).toBe(false)
    expect(result.owned?.binding).toBeUndefined()
    expect(result.owned?.external.bindingMatches).toBe(false)
    expect(f.adapters.clients).toHaveBeenCalledWith({
      systemHTTPPort: null,
      systemSOCKSPort: null,
      codeHTTPPort: null,
      dedicatedSOCKSPort: null
    })
    expect(result.report.snapshot.nodeNames).toEqual([])
  })
  it('does not query a core while idle', async () => {
    const f = ownedDiagnosticFixture()
    f.state.phase = 'idle'
    f.state.owned = false
    expect((await f.service.observe()).owned?.running).toBe(false)
    expect(f.adapters.live).not.toHaveBeenCalled()
  })
  it('checks separately configured ordinary SOCKS ownership before declaring system proxy matched', async () => {
    const f = ownedDiagnosticFixture()
    f.state.ports = { http: 18191, socks: 18192, mixed: 0, redir: 0 }
    f.adapters.listener.mockImplementation(async (_pid?: number, port?: number) => port !== 18192)
    const result = await f.service.observe()
    expect(f.adapters.listener).toHaveBeenCalledWith(123, 18192)
    expect(result.report.snapshot.systemProxy).toBe(false)
    expect(result.report.checks.find((row) => row.id === 'clients')?.state).toBe('attention')
  })
  it('rejects a changed instance before returning any successful observation', async () => {
    const f = ownedDiagnosticFixture()
    f.adapters.clients.mockImplementationOnce(async () => {
      f.state.configurationRevision = 'f'.repeat(64)
      return f.report
    })
    await expect(f.service.observe()).rejects.toThrow('实例或配置已变化')
  })
  it.each(['appBuild', 'coreSHA256', 'configurationRevision', 'architecture'] as const)(
    'marks %s mismatches historical',
    async (key) => {
      const f = ownedDiagnosticFixture()
      Object.assign(f.record.binding, {
        [key]: key === 'architecture' ? 'arm64' : key === 'appBuild' ? '6' : 'f'.repeat(64)
      })
      expect((await f.service.observe()).owned?.external.bindingMatches).toBe(false)
    }
  )
  it('does not transfer Chrome evidence to a different browser version or profile', async () => {
    const f = ownedDiagnosticFixture()
    if (!f.report.owned) throw new Error('Missing native fixture')
    f.report.owned.browsers[0].version = '101.0'
    expect((await f.service.observe()).owned?.external.browserMatches).toEqual([false])
  })
  it('does not accept future-dated evidence as current', async () => {
    const f = ownedDiagnosticFixture()
    f.record.recordedAt = '2027-01-01T00:00:00Z'
    expect((await f.service.observe()).owned?.external.bindingMatches).toBe(false)
  })
})
