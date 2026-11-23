import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import type { SystemProxyReport } from '../../../shared/relay/system-proxy'
import { defaultSystemProxyDraft } from '../../../shared/relay/system-proxy-draft'
import { applyStartupSystemProxy } from './startup-system-proxy'
import { createStartupPreferences } from './startup-preferences'

function fixture() {
  const report: SystemProxyReport = {
    status: 'inactive',
    revision: 'a'.repeat(64),
    location: 'test',
    recordID: undefined,
    services: [
      {
        id: 'A',
        name: 'test',
        enabled: true,
        http: false,
        https: false,
        socks: false,
        pac: false,
        discovery: false
      }
    ],
    canApply: false,
    canRestore: false,
    currentProxyPorts: [],
    currentPacURLHashes: [],
    warnings: []
  }
  const state: LocalProxyState = {
    instanceId: 'owned',
    httpPort: 18191,
    phase: 'running',
    traffic: 'listening',
    owned: true,
    pending: false,
    uncertain: false,
    hasRecord: true,
    groups: [],
    systemProxyChanged: false,
    liveGuardEnabled: false,
    warnings: []
  }
  const adapters = {
    local: () => state,
    enabled: vi.fn(async () => true),
    inspect: vi.fn(async () => structuredClone(report)),
    draft: vi.fn(async () => defaultSystemProxyDraft()),
    prepare: vi.fn(async () => ({
      evidenceId: 'test',
      action: 'apply' as const,
      report: { ...report, canApply: true }
    })),
    execute: vi.fn(async () => ({ status: 'applied' as const, warnings: [] })),
    cancel: vi.fn()
  }
  return { adapters, report, state }
}

describe('Startup system proxy', () => {
  it('applies a clean network to the confirmed owned listener only', async () => {
    const { adapters } = fixture()
    await applyStartupSystemProxy(adapters, () => {})
    expect(adapters.prepare).toHaveBeenCalledWith({
      ...defaultSystemProxyDraft(),
      serviceIDs: ['A'],
      port: 18191
    })
    expect(adapters.execute).toHaveBeenCalledOnce()
  })
  it('uses the mixed listener for SOCKS and refuses a pure HTTP port', async () => {
    const { adapters, state } = fixture()
    adapters.draft.mockResolvedValue({ ...defaultSystemProxyDraft(), socks: true })
    await expect(applyStartupSystemProxy(adapters, () => {})).rejects.toThrow('混合端口')
    expect(adapters.execute).not.toHaveBeenCalled()
    state.ports = { http: 18191, socks: 18192, mixed: 18193, redir: 0 }
    await applyStartupSystemProxy(adapters, () => {})
    expect(adapters.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ port: 18193, socks: true })
    )
  })
  it.each(['http', 'socks', 'pac', 'discovery'] as const)(
    'preserves foreign %s and never submits',
    async (field) => {
      const { adapters, report } = fixture()
      report.services[0][field] = true
      await applyStartupSystemProxy(adapters, () => {})
      expect(adapters.prepare).not.toHaveBeenCalled()
      expect(adapters.execute).not.toHaveBeenCalled()
    }
  )
  it('honors a saved off, and refuses a configuration changed between inspect and prepare', async () => {
    const { adapters, report } = fixture()
    adapters.enabled.mockResolvedValueOnce(false)
    await applyStartupSystemProxy(adapters, () => {})
    expect(adapters.inspect).not.toHaveBeenCalled()
    adapters.prepare.mockResolvedValueOnce({
      action: 'apply',
      evidenceId: 'new',
      report: { ...report, revision: 'b'.repeat(64), canApply: true }
    })
    await applyStartupSystemProxy(adapters, () => {})
    expect(adapters.execute).not.toHaveBeenCalled()
    expect(adapters.cancel).toHaveBeenCalledOnce()
  })
  it('persists user off and selected member independently across launches', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-synthetic-startup-')))
    try {
      const ctx = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
      const data = createStartupPreferences(ctx)
      expect((await data.read()).systemProxy).toBe(false)
      await data.systemProxy(true)
      expect((await createStartupPreferences(ctx).read()).systemProxy).toBe(true)
      await Promise.all([data.select('profile', 'Policy', 'B'), data.systemProxy(false)])
      expect(await createStartupPreferences(ctx).selectors('other-profile')).toEqual(new Map())
      expect(await createStartupPreferences(ctx).selectors('profile')).toEqual(
        new Map([['Policy', 'B']])
      )
      expect(await createStartupPreferences(ctx).read()).toEqual({
        profileId: 'profile',
        selectors: [['Policy', 'B']],
        systemProxy: false
      })
      await data.select('other-profile', 'Policy', 'A')
      const reopened = createStartupPreferences(ctx)
      expect(await reopened.selectors('profile')).toEqual(new Map([['Policy', 'B']]))
      expect(await reopened.selectors('other-profile')).toEqual(new Map([['Policy', 'A']]))
      await reopened.select('profile', 'Policy')
      expect(await reopened.selectors('profile')).toEqual(new Map())
      expect(await reopened.selectors('other-profile')).toEqual(new Map([['Policy', 'A']]))
      const pairs = Array.from({ length: 80 }, (_, i) => [
        String(i) + 'g'.repeat(399),
        'n'.repeat(399)
      ])
      const path = join(ctx.stateRoot, 'Core', 'core-startup.json')
      await writeFile(
        path,
        JSON.stringify({ profileId: 'legacy', selectors: pairs, systemProxy: true })
      )
      await reopened.select('another', 'x'.repeat(512), 'y'.repeat(512))
      await reopened.systemProxy(false)
      expect((await reopened.selectors('legacy')).size).toBe(80)
      expect(await reopened.selectors('another')).toEqual(
        new Map([['x'.repeat(512), 'y'.repeat(512)]])
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
