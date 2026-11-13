import { describe, expect, it, vi } from 'vitest'
import type {
  RelayProfileGroups,
  RelayProfileInventory,
  RelayStoredProfile
} from '../../../../shared/relay/profiles'
import {
  executeRuntimeGroupProbe,
  executeRuntimeNodeProbe,
  runtimeProbeMembers,
  runtimeProbeDisplayStatus,
  runtimeProbeTestAvailable
} from './runtime-group-probe'

const profile: RelayStoredProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Saved',
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-10T00:00:00Z',
  summary: { proxies: 1, groups: 1, rules: 1, proxyProviders: 0, ruleProviders: 0 }
}
const plan = {
  evidenceId: '22222222-2222-4222-8222-222222222222',
  kind: 'groupDelay',
  sourceSHA256: profile.sha256
}
function fixture() {
  const readProfiles = vi.fn(async (): Promise<RelayProfileInventory> => ({
    profiles: [profile],
    activeId: null,
    incomplete: 0,
    warnings: []
  }))
  const readGroups = vi.fn(async (): Promise<RelayProfileGroups> => ({
    profile,
    groups: [{ name: 'PROXY', proxies: ['A', 'DIRECT'] }],
    targets: ['A', 'DIRECT'],
    providers: []
  }))
  const invoke = vi.fn(async (channel: string, _input?: unknown): Promise<unknown> => {
    if (channel === 'relayIsolatedProbeTargets')
      return { groups: ['PROXY', 'GLOBAL'], nodes: ['A'] }
    if (channel === 'relayIsolatedProbePrepare') return plan
    if (channel === 'relayIsolatedProbeRun')
      return {
        status: 'completed',
        kind: 'groupDelay',
        measurements: [{ name: 'A', milliseconds: 20 }],
        isolated: true
      }
    if (channel === 'relayIsolatedProbeCancel') return undefined
    throw Error('Unexpected write or active health call')
  })
  return {
    readProfiles,
    readGroups,
    invoke,
    current: vi.fn(() => true),
    cancelled: vi.fn(() => false),
    prepared: vi.fn()
  }
}
describe('runtime toolbar isolated group test', () => {
  it('pins the actual runtime source and calls one isolated run, never active health', async () => {
    const f = fixture()
    const result = await executeRuntimeGroupProbe(profile.id, 'PROXY', f)
    expect(f.readGroups).toHaveBeenCalledWith({ id: profile.id, sha256: profile.sha256 })
    expect(f.invoke.mock.calls).toEqual([
      ['relayIsolatedProbeTargets', { id: profile.id, sha256: profile.sha256 }],
      [
        'relayIsolatedProbePrepare',
        {
          profile: { id: profile.id, sha256: profile.sha256 },
          target: 'PROXY',
          kind: 'groupDelay',
          provider: 'ip.sb'
        }
      ],
      ['relayIsolatedProbeRun', { evidenceId: plan.evidenceId }]
    ])
    expect(result.measurements).toEqual([{ name: 'A', milliseconds: 20 }])
  })
  it('allows synthetic GLOBAL against the same pinned source without a saved namesake', async () => {
    const f = fixture()
    const result = await executeRuntimeGroupProbe(profile.id, 'GLOBAL', f)
    expect(result.measurements).toEqual([{ name: 'A', milliseconds: 20 }])
    expect(f.invoke).toHaveBeenCalledWith('relayIsolatedProbePrepare', {
      profile: { id: profile.id, sha256: profile.sha256 },
      target: 'GLOBAL',
      kind: 'groupDelay',
      provider: 'ip.sb'
    })
  })
  it('pins the displayed selections and configured URL/timeout to the isolated request', async () => {
    const f = fixture()
    const delay = {
      url: 'http://example.com/generate_204',
      timeout: 7000,
      selections: { PROXY: 'A', GLOBAL: 'PROXY' }
    }
    await executeRuntimeGroupProbe(profile.id, 'GLOBAL', { ...f, delay })
    expect(f.invoke).toHaveBeenCalledWith('relayIsolatedProbePrepare', {
      profile: { id: profile.id, sha256: profile.sha256 },
      target: 'GLOBAL',
      kind: 'groupDelay',
      provider: 'ip.sb',
      delay
    })
  })
  it('still rejects an unknown runtime group and stale source before preparing a probe', async () => {
    const f = fixture()
    await expect(executeRuntimeGroupProbe(profile.id, 'missing', f)).rejects.toThrow(
      '不支持独立测速'
    )
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('relayIsolatedProbeTargets', {
      id: profile.id,
      sha256: profile.sha256
    })
    const stale = fixture()
    stale.readGroups.mockResolvedValue({
      profile: { ...profile, sha256: 'b'.repeat(64) },
      groups: [{ name: 'PROXY' }],
      targets: [],
      providers: []
    })
    await expect(executeRuntimeGroupProbe(profile.id, 'PROXY', stale)).rejects.toThrow('来源已变化')
    expect(stale.invoke).not.toHaveBeenCalled()
  })
  it('accepts a group added by effective overrides even when absent from the saved raw source', async () => {
    const f = fixture()
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayIsolatedProbeTargets')
        return { groups: ['PROXY', 'Override group', 'GLOBAL'], nodes: ['A'] }
      if (channel === 'relayIsolatedProbePrepare') return plan
      if (channel === 'relayIsolatedProbeRun')
        return {
          status: 'completed',
          kind: 'groupDelay',
          measurements: [{ name: 'A', milliseconds: 20 }],
          isolated: true
        }
      throw Error('Unexpected write')
    })
    const result = await executeRuntimeGroupProbe(profile.id, 'Override group', f)
    expect(f.invoke).toHaveBeenCalledWith('relayIsolatedProbePrepare', {
      profile: { id: profile.id, sha256: profile.sha256 },
      target: 'Override group',
      kind: 'groupDelay',
      provider: 'ip.sb'
    })
    expect(result.measurements).toEqual([{ name: 'A', milliseconds: 20 }])
  })
  it('does not continue queued reads after runtime identity changes', async () => {
    const f = fixture()
    f.readProfiles.mockImplementation(async () => {
      f.current.mockReturnValue(false)
      return { profiles: [profile], activeId: null, incomplete: 0, warnings: [] }
    })
    await expect(executeRuntimeGroupProbe(profile.id, 'PROXY', f)).rejects.toThrow('运行配置已变化')
    expect(f.readGroups).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalled()
  })
  it('cancels a prepared test before native run if context changes or the user cancels', async () => {
    for (const changeContext of [false, true]) {
      const f = fixture()
      f.prepared.mockImplementation(() => {
        if (changeContext) f.current.mockReturnValue(false)
        else f.cancelled.mockReturnValue(true)
      })
      expect((await executeRuntimeGroupProbe(profile.id, 'PROXY', f)).status).toBe('cancelled')
      expect(f.invoke).toHaveBeenLastCalledWith('relayIsolatedProbeCancel', {
        evidenceId: plan.evidenceId
      })
      expect(f.invoke.mock.calls.some(([channel]) => channel === 'relayIsolatedProbeRun')).toBe(
        false
      )
    }
  })
  it('preserves native cancellation and rejects unsupported source groups without retry', async () => {
    const f = fixture()
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayIsolatedProbeTargets') return { groups: ['PROXY'], nodes: ['A'] }
      if (channel === 'relayIsolatedProbePrepare') return plan
      return { status: 'cancelled', kind: 'groupDelay', measurements: [], isolated: true }
    })
    expect((await executeRuntimeGroupProbe(profile.id, 'PROXY', f)).status).toBe('cancelled')
    const unsupported = fixture()
    unsupported.invoke.mockResolvedValue({ groups: [], nodes: [] })
    await expect(executeRuntimeGroupProbe(profile.id, 'PROXY', unsupported)).rejects.toThrow(
      '不支持独立测速'
    )
    expect(unsupported.invoke).toHaveBeenCalledTimes(1)
  })
})

describe('whole runtime group refresh feedback', () => {
  const groups = [
    { name: 'PROXY', all: [{ name: 'A' }, { name: 'DIRECT' }] },
    {
      name: 'GLOBAL',
      all: [{ name: 'DIRECT' }, { name: 'REJECT' }, { name: 'A' }, { name: 'PROXY' }]
    }
  ] as IMihomoMixedGroup[]
  it('refreshes every member and nested leaf once, including same-name cards in other groups', () => {
    expect(runtimeProbeMembers('PROXY', groups)).toEqual(['PROXY', 'A', 'DIRECT'])
    expect(runtimeProbeMembers('GLOBAL', groups)).toEqual([
      'GLOBAL',
      'DIRECT',
      'REJECT',
      'A',
      'PROXY'
    ])
  })
  it('leaves missing outcomes as errors instead of manufacturing delays or timeouts', () => {
    for (const name of ['DIRECT', 'REJECT', 'COMPATIBLE', 'PROXY', 'GLOBAL', 'A']) {
      expect(runtimeProbeTestAvailable(name)).toBe(true)
      expect(runtimeProbeDisplayStatus(name)).toEqual({
        error: '未收到本次测速结果，请重试。'
      })
    }
    expect(runtimeProbeDisplayStatus('A', 'source changed')).toEqual({
      error: 'source changed'
    })
  })
  it.each(['PASS', 'PASS-RULE', 'REJECT-DROP'])('keeps rule control %s unavailable', (name) => {
    expect(runtimeProbeTestAvailable(name)).toBe(false)
    expect(runtimeProbeDisplayStatus(name)).toEqual({
      label: '不可测',
      detail: '规则控制项没有独立网络出口。'
    })
  })
})

describe('runtime node direct test', () => {
  it('tests only a saved node with one isolated run and no active health writes', async () => {
    const f = fixture()
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayIsolatedProbeTargets') return { groups: ['PROXY'], nodes: ['A'] }
      if (channel === 'relayIsolatedProbePrepare') return { ...plan, kind: 'nodeDelay' }
      if (channel === 'relayIsolatedProbeRun')
        return {
          status: 'completed',
          kind: 'nodeDelay',
          isolated: true,
          measurements: [{ name: 'A', milliseconds: 20 }]
        }
      throw Error('Unexpected write')
    })
    const result = await executeRuntimeNodeProbe(profile.id, 'A', f)
    expect(result.kind).toBe('nodeDelay')
    expect(f.invoke).toHaveBeenCalledWith('relayIsolatedProbePrepare', {
      profile: { id: profile.id, sha256: profile.sha256 },
      target: 'A',
      kind: 'nodeDelay',
      provider: 'ip.sb'
    })
    expect(f.invoke.mock.calls.filter(([name]) => name === 'relayIsolatedProbeRun')).toHaveLength(1)
  })
  it.each(['DIRECT', 'REJECT', 'COMPATIBLE', 'PROXY', 'GLOBAL'])(
    'tests %s as one isolated selected outbound, without expanding the group',
    async (name) => {
      const f = fixture()
      f.invoke.mockImplementation(async (channel) => {
        if (channel === 'relayIsolatedProbeTargets')
          return { groups: ['PROXY', 'GLOBAL'], nodes: ['A'] }
        if (channel === 'relayIsolatedProbePrepare') return { ...plan, kind: 'nodeDelay' }
        if (channel === 'relayIsolatedProbeRun')
          return {
            status: 'completed',
            kind: 'nodeDelay',
            isolated: true,
            measurements: [{ name, milliseconds: name === 'REJECT' ? null : 20 }]
          }
        throw Error('Unexpected write')
      })
      const delay = {
        url: 'https://example.com/generate_204',
        timeout: 5000,
        selections: { PROXY: 'A', GLOBAL: 'PROXY' }
      }
      const result = await executeRuntimeNodeProbe(profile.id, name, { ...f, delay })
      expect(f.invoke).toHaveBeenCalledWith('relayIsolatedProbePrepare', {
        profile: { id: profile.id, sha256: profile.sha256 },
        target: name,
        kind: 'nodeDelay',
        provider: 'ip.sb',
        delay
      })
      expect(result.measurements).toEqual([{ name, milliseconds: name === 'REJECT' ? null : 20 }])
      expect(
        f.invoke.mock.calls.filter(([channel]) => channel === 'relayIsolatedProbeRun')
      ).toHaveLength(1)
    }
  )
  it.each(['PASS', 'PASS-RULE', 'REJECT-DROP', 'missing'])(
    'rejects unsupported %s before preparing or running',
    async (name) => {
      const f = fixture()
      await expect(executeRuntimeNodeProbe(profile.id, name, f)).rejects.toThrow('不支持独立测速')
      expect(f.invoke).toHaveBeenCalledTimes(1)
    }
  )
})
