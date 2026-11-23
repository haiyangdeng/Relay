import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalProxyState, RelayProxyPageOwner } from '../../../shared/relay/local-proxy'
import type { TunSessionResult, TunSessionState } from '../../../shared/relay/tun'
import { createTunProfileSwitch } from './profile-switch'

const a = { id: 'a', sha256: 'a'.repeat(64) },
  b = { id: 'b', sha256: 'b'.repeat(64) }
const original: RelayProxyPageOwner = {
  kind: 'tun-managed',
  profileId: a.id,
  configurationRevision: 'a-tun',
  instanceId: 'session-a',
  mode: 'rule'
}
const initial: TunSessionState = {
  phase: 'active',
  owned: true,
  pending: false,
  traffic: 'forwarding',
  sessionId: original.instanceId,
  protectionVerified: false,
  restorationVerified: false,
  warnings: []
}
type Adapters = Parameters<typeof createTunProfileSwitch>[0]

function fixture(ordinary = true) {
  let selected = a,
    owner: RelayProxyPageOwner | undefined = original
  let state = { ...initial }
  let local: LocalProxyState = {
    phase: 'idle',
    traffic: 'inactive',
    pending: false,
    uncertain: false,
    hasRecord: false,
    owned: false,
    warnings: [],
    groups: [],
    liveGuardEnabled: false,
    systemProxyChanged: false
  }
  const calls: string[] = []
  const released = (): void => {
    state = {
      ...initial,
      phase: 'restored',
      restorationVerified: true,
      owned: false,
      traffic: 'inactive',
      sessionId: undefined
    }
    owner = undefined
    if (ordinary)
      local = {
        ...local,
        phase: 'running',
        owned: true,
        traffic: 'listening',
        instanceId: 'ordinary',
        profileId: selected.id
      }
  }
  const select = (profile: typeof a): void => {
    selected = profile
    if (local.owned) local = { ...local, profileId: selected.id }
  }
  const activate = (): void => {
    owner = {
      ...original,
      profileId: selected.id,
      instanceId: 'session-new-' + selected.id,
      configurationRevision: selected.sha256
    }
    state = { ...initial, sessionId: owner.instanceId }
  }
  const result = (status: TunSessionResult['status']): TunSessionResult => ({
    status,
    state: { ...state }
  })
  const adapters = {
    owner: () => owner,
    state: () => state,
    local: () => local,
    ordinaryRecovery: vi.fn<Adapters['ordinaryRecovery']>(),
    readSelection: async () => selected,
    readProfile: vi.fn<Adapters['readProfile']>(async () => undefined),
    choose: vi.fn<Adapters['choose']>(async (profile) => {
      calls.push('choose-' + profile.id)
      select(profile)
    }),
    stop: vi.fn<Adapters['stop']>(async () => {
      calls.push('stop')
      released()
      return result('restored')
    }),
    prepare: vi.fn<Adapters['prepare']>(async (profile) => {
      expect(profile).toEqual(selected)
      calls.push('prepare-' + profile.id)
      state = { ...state, phase: 'prepared' }
      return { evidenceId: 'evidence-' + profile.id, readyForConfirmation: true }
    }),
    start: vi.fn<Adapters['start']>(async (input) => {
      expect(input.evidenceId).toBe('evidence-' + selected.id)
      calls.push('start-' + selected.id)
      activate()
      return result('started')
    }),
    cancel: vi.fn<Adapters['cancel']>(() => {
      state = { ...state, phase: 'idle' }
    })
  }
  return {
    calls,
    adapters,
    released,
    activate,
    select,
    result,
    service: createTunProfileSwitch(adapters)
  }
}

describe('switch a running managed TUN to another full profile', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([true, false])(
    'reuses verified stop, selection, check and start (ordinary local = %s)',
    async (ordinary) => {
      const { service, adapters, calls } = fixture(ordinary)
      await service.run(b, original)
      expect(calls).toEqual(['stop', 'choose-b', 'prepare-b', 'start-b'])
      expect(adapters.owner()?.profileId).toBe(b.id)
      expect(adapters.stop).toHaveBeenCalledExactlyOnceWith({ sessionId: original.instanceId })
      expect(adapters.readProfile.mock.calls).toEqual([[a], [b]])
    }
  )

  it('rejects a stale session and a changed source before disrupting the current TUN', async () => {
    const { service, adapters } = fixture()
    await expect(service.run(b, { ...original, configurationRevision: 'stale' })).rejects.toThrow(
      '已变化'
    )
    adapters.readProfile.mockRejectedValueOnce(new Error('profile missing'))
    await expect(service.run(b, original)).rejects.toThrow('profile missing')
    await service.run(a, original)
    expect(adapters.stop).not.toHaveBeenCalled()
  })

  it('rechecks the requesting window after reading the target and before stopping the active tunnel', async () => {
    const { service, adapters } = fixture()
    let authorized = true
    adapters.readProfile.mockImplementation(async (profile) => {
      if (profile.id === b.id) authorized = false
    })
    await expect(
      service.run(b, original, () => {
        if (!authorized) throw new Error('requesting window changed')
      })
    ).rejects.toThrow('requesting window changed')
    expect(adapters.stop).not.toHaveBeenCalled()
    expect(adapters.choose).not.toHaveBeenCalled()
    expect(adapters.owner()).toEqual(original)
  })

  it('rejects concurrent selection even before the asynchronous preflight finishes', async () => {
    const { service, adapters } = fixture()
    const first = service.run(b, original)
    await expect(service.run(b, original)).rejects.toThrow('正在切换')
    await first
    expect(adapters.stop).toHaveBeenCalledOnce()
    expect(service.isBusy()).toBe(false)
  })

  it.each(['failed', 'uncertain', 'rejected'] as const)(
    'preserves the stop recovery state on %s',
    async (failure) => {
      const { service, adapters, released, result } = fixture()
      adapters.stop.mockImplementation(async () => {
        released()
        if (failure === 'rejected') throw new Error('lost reply')
        return {
          ...result(failure),
          ordinaryRecovery: { phase: 'failed', reason: 'source', sessionId: 'old' }
        }
      })
      await expect(service.run(b, original)).rejects.toThrow('普通代理恢复')
      expect(adapters.choose).not.toHaveBeenCalled()
      expect(adapters.start).not.toHaveBeenCalled()
    }
  )

  it('restores the original profile and tunnel once after the target configuration fails its check', async () => {
    const { service, adapters, calls } = fixture()
    adapters.prepare.mockRejectedValueOnce(new Error('parser rejected'))
    await expect(service.run(b, original)).rejects.toThrow('已恢复原配置及虚拟网卡')
    expect(calls).toEqual(['stop', 'choose-b', 'choose-a', 'prepare-a', 'start-a'])
    expect(adapters.owner()?.profileId).toBe('a')
  })

  it('clears an unusable target preparation before restoring the original tunnel', async () => {
    const { service, adapters } = fixture()
    adapters.prepare.mockResolvedValueOnce({ evidenceId: 'blocked', readyForConfirmation: false })
    await expect(service.run(b, original)).rejects.toThrow('已恢复原配置及虚拟网卡')
    expect(adapters.cancel).toHaveBeenCalledExactlyOnceWith({ evidenceId: 'blocked' })
    expect(adapters.start).toHaveBeenCalledExactlyOnceWith({ evidenceId: 'evidence-a' })
  })

  it('recovers after a definite, released target start failure', async () => {
    const { service, adapters, released, result } = fixture()
    adapters.start.mockImplementationOnce(async () => {
      released()
      return result('failed')
    })
    await expect(service.run(b, original)).rejects.toThrow('已恢复原配置及虚拟网卡')
    expect(adapters.start).toHaveBeenCalledTimes(2)
    expect(adapters.owner()?.profileId).toBe('a')
  })

  it('recovers after a thrown target start with affirmative platform release evidence', async () => {
    const { service, adapters, released } = fixture()
    adapters.start.mockImplementationOnce(async () => {
      released()
      throw new Error('failed after native restoration')
    })
    await expect(service.run(b, original)).rejects.toThrow('已恢复原配置及虚拟网卡')
    expect(adapters.start.mock.calls).toEqual([
      [{ evidenceId: 'evidence-b' }],
      [{ evidenceId: 'evidence-a' }]
    ])
  })

  it('does not retry an ambiguous start or overwrite a concurrently selected profile', async () => {
    const { service, adapters } = fixture()
    adapters.start.mockRejectedValueOnce(new Error('lost'))
    await expect(service.run(b, original)).rejects.toThrow('启动结果待核对')
    expect(adapters.start).toHaveBeenCalledOnce()
    expect(adapters.choose).toHaveBeenCalledExactlyOnceWith(b)
    const other = fixture()
    other.adapters.choose.mockImplementationOnce(async () => {
      other.select({ id: 'c', sha256: 'c'.repeat(64) })
      throw new Error('stale')
    })
    await expect(other.service.run(b, original)).rejects.toThrow('网络状态待核对')
    expect(other.adapters.start).not.toHaveBeenCalled()
  })

  it('accepts a lost start reply only when the new owned tunnel and selection are confirmed', async () => {
    const { service, adapters, activate } = fixture()
    adapters.start.mockImplementationOnce(async () => {
      activate()
      throw new Error('lost')
    })
    await service.run(b, original)
    expect(adapters.start).toHaveBeenCalledOnce()
  })
})
