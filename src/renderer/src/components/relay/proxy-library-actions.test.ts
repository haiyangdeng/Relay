import { describe, expect, it, vi } from 'vitest'
import type { RelayStoredProfile } from '../../../../shared/relay/profiles'
import type { LocalProxyPreparation, LocalProxyState } from '../../../../shared/relay/local-proxy'
import {
  activateCachedProfile,
  relayProxyCanPrepare,
  relayProxyMatchesProfile,
  relayProxyRunning,
  startCachedProxy
} from './proxy-library-actions'

const profile: RelayStoredProfile = {
  id: '63f90396-1cd2-4f63-b7ba-8e8f3dba1444',
  name: 'Subscription',
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-09T00:00:00Z',
  summary: { proxies: 1, groups: 1, rules: 0, proxyProviders: 0, ruleProviders: 0 }
}
const idle = (patch: Partial<LocalProxyState> = {}): LocalProxyState => ({
  phase: 'idle',
  pending: false,
  owned: false,
  hasRecord: false,
  uncertain: false,
  traffic: 'inactive',
  groups: [],
  warnings: [],
  systemProxyChanged: false,
  liveGuardEnabled: false,
  ...patch
})
const running = (patch: Partial<LocalProxyState> = {}): LocalProxyState =>
  idle({
    phase: 'running',
    owned: true,
    hasRecord: true,
    traffic: 'listening',
    profileId: profile.id,
    instanceId: 'instance',
    configurationRevision: 'b'.repeat(64),
    ...patch
  })
const preparation: LocalProxyPreparation = {
  evidenceId: '030d8762-9f2e-4a0b-bb79-96397cf2984e',
  profile,
  httpPort: 18191,
  runtimeSHA256: 'b'.repeat(64),
  version: 'fixture',
  canStart: true,
  hasRecord: false,
  warnings: []
}
function ipc(
  options: {
    state?: LocalProxyState
    after?: LocalProxyState
    selected?: string
    canStart?: boolean
    cancelled?: boolean
  } = {}
) {
  let state = options.state ?? idle()
  return vi.fn(async (channel: string, ..._args: unknown[]): Promise<unknown> => {
    switch (channel) {
      case 'relayLocalProxyState':
        return state
      case 'changeCurrentProfile':
        if (state.owned) state = options.after ?? running()
        return undefined
      case 'getProfileConfig':
        return { current: options.selected ?? profile.id, items: [] }
      case 'relayLocalProxyPrepare':
        return { ...preparation, canStart: options.canStart ?? true }
      case 'relayLocalProxyAction':
        state = options.cancelled ? state : (options.after ?? running())
        return { status: options.cancelled ? 'cancelled' : 'started', state }
      default:
        throw new Error(`Unexpected IPC channel: ${channel}`)
    }
  })
}

describe('cached proxy activation', () => {
  it('stops before preparation when selection was cancelled or not read back', async () => {
    const invoke = ipc({ selected: 'previous' })
    await expect(startCachedProxy(profile, 18191, invoke)).rejects.toThrow('配置未选用')
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayLocalProxyState',
      'changeCurrentProfile',
      'getProfileConfig'
    ])
  })

  it.each([
    { owned: true },
    { pending: true },
    { uncertain: true },
    { hasRecord: true },
    { phase: 'unknown' as const, hasRecord: true },
    { phase: 'starting' as const },
    { phase: 'blocked' as const },
    { traffic: 'unconfirmed' as const }
  ])('never starts an occupied or uncertain service %j', async (patch) => {
    const invoke = ipc({ state: idle(patch) })
    await expect(startCachedProxy(profile, 18191, invoke)).rejects.toThrow('状态需要核对')
    expect(invoke.mock.calls).toEqual([['relayLocalProxyState']])
  })

  it('allows fresh unknown to prepare but blocks start when native preparation rejects it', async () => {
    const invoke = ipc({ state: idle({ phase: 'unknown' }), canStart: false })
    expect(relayProxyCanPrepare(idle({ phase: 'unknown' }))).toBe(true)
    await expect(startCachedProxy(profile, 18191, invoke)).rejects.toThrow('尚未就绪')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('relayLocalProxyAction')
  })

  it('pins id, digest, and port and invokes only existing explicit IPC commands', async () => {
    const invoke = ipc({ state: idle({ phase: 'unknown' }) })
    const input = { ...profile }
    const promise = startCachedProxy(input, 19234, invoke)
    input.sha256 = 'changed-after-click'
    await promise
    expect(invoke.mock.calls).toEqual([
      ['relayLocalProxyState'],
      ['changeCurrentProfile', { id: profile.id, sha256: profile.sha256 }],
      ['getProfileConfig'],
      [
        'relayLocalProxyPrepare',
        {
          profile: { id: profile.id, sha256: profile.sha256 },
          httpPort: 19234,
          resolverMode: 'profile',
          lifetime: 'main'
        }
      ],
      ['relayLocalProxyAction', { action: 'start', evidenceId: preparation.evidenceId }]
    ])
  })

  it.each(['info', 'silent'] as const)(
    'preserves explicit %s logging and startup settings from core settings',
    async (logLevel) => {
      const invoke = ipc()
      await startCachedProxy(profile, 18191, invoke, {
        resolverMode: 'off',
        lifetime: 'main',
        logLevel
      })
      expect(invoke).toHaveBeenCalledWith('relayLocalProxyPrepare', {
        profile: { id: profile.id, sha256: profile.sha256 },
        httpPort: 18191,
        resolverMode: 'off',
        lifetime: 'main',
        logLevel
      })
    }
  )

  it.each([0, 1023, 65536, NaN, 1.5])(
    'rejects invalid port %s before invoking IPC',
    async (port) => {
      const invoke = ipc()
      await expect(startCachedProxy(profile, port, invoke)).rejects.toThrow('端口')
      expect(invoke).not.toHaveBeenCalled()
    }
  )

  it.each([
    { http: 18191, mixed: 19234, socks: 19235, redir: 19236 },
    { http: 0, mixed: 18191, socks: 19235, redir: 0 }
  ])('passes all enabled ordinary listeners to explicit preparation %j', async (ports) => {
    const invoke = ipc()
    const dedicated = { httpPort: 18193, socksPort: 18190, route: 'fixed' }
    await startCachedProxy(profile, 18191, invoke, { ports, dedicated })
    expect(invoke).toHaveBeenCalledWith('relayLocalProxyPrepare', {
      profile: { id: profile.id, sha256: profile.sha256 },
      httpPort: 18191,
      resolverMode: 'profile',
      lifetime: 'main',
      ports,
      dedicated
    })
  })

  it.each([
    { http: 0, mixed: 0, socks: 19235, redir: 0 },
    { http: 18191, mixed: 18191, socks: 0, redir: 0 },
    { http: 0, mixed: 19234, socks: 0, redir: 0 }
  ])('rejects invalid or inconsistent ordinary ports before any IPC %j', async (ports) => {
    const invoke = ipc()
    await expect(startCachedProxy(profile, 18191, invoke, { ports })).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('starts a fresh service and returns only the read-back running selected profile', async () => {
    const invoke = ipc({ state: idle({ phase: 'unknown' }) })
    expect(await activateCachedProfile(profile, 18191, invoke)).toEqual(running())
    expect(invoke.mock.calls.at(-1)).toEqual(['relayLocalProxyState'])
  })

  it('uses native profile selection for a running service without preparing, starting or stopping it', async () => {
    const invoke = ipc({ state: running({ profileId: 'old-profile' }) })
    expect(
      await activateCachedProfile(profile, 18191, invoke, {
        ports: { http: 0, mixed: 19234, socks: 19235, redir: 0 }
      })
    ).toEqual(running())
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayLocalProxyState',
      'changeCurrentProfile',
      'getProfileConfig',
      'relayLocalProxyState'
    ])
  })

  it('accepts the same running profile only after native readback', async () => {
    const invoke = ipc({ state: running() })
    expect(await activateCachedProfile(profile, 18191, invoke)).toEqual(running())
    expect(invoke.mock.calls.at(-1)).toEqual(['relayLocalProxyState'])
  })

  it('does not report cancelled startup as using the profile', async () => {
    const invoke = ipc({ cancelled: true })
    await expect(activateCachedProfile(profile, 18191, invoke)).rejects.toThrow('已取消')
  })

  it.each([
    running({ profileId: 'wrong-profile' }),
    running({ pending: true }),
    running({ uncertain: true }),
    running({ traffic: 'unconfirmed' }),
    idle()
  ])('rejects unconfirmed runtime readback %j', async (after) => {
    const invoke = ipc({ after })
    await expect(activateCachedProfile(profile, 18191, invoke)).rejects.toThrow('尚未确认运行')
  })

  it('never labels missing or merely saved state as running', () => {
    expect(relayProxyRunning()).toBe(false)
    expect(relayProxyRunning(idle({ phase: 'unknown' }))).toBe(false)
    expect(relayProxyRunning(running({ owned: false }))).toBe(false)
    expect(relayProxyCanPrepare()).toBe(false)
  })

  it('shows the explicitly browsed profile cache until that same profile is running', () => {
    const state = running({ profileId: 'A' })
    expect(relayProxyMatchesProfile(state, 'B')).toBe(false)
    expect(relayProxyMatchesProfile(state, 'A')).toBe(true)
    expect(relayProxyMatchesProfile(state, null)).toBe(true)
    expect(relayProxyMatchesProfile(running({ profileId: 'B' }), 'B')).toBe(true)
    expect(state.profileId).toBe('A')
  })
})
