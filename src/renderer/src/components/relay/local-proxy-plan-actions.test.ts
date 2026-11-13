import { describe, expect, it, vi } from 'vitest'
import type { LocalProxyPlan } from '../../../../shared/relay/local-proxy-plan'
import { dedicatedNodeOptions, saveLocalProxyPlan } from './local-proxy-plan-actions'
import { ensureSelectedProxy } from './proxy-library-actions'

const document: LocalProxyPlan = {
  httpPort: 19231,
  resolverMode: 'profile' as const,
  dedicated: { httpPort: 18193, socksPort: 18190, route: 'fixed' }
}
const record = { document, revision: 'a'.repeat(64), exists: true }

describe('Renderer persisted local proxy plan actions', () => {
  it('saves exact settings through CAS and never falls back when read/save fails', async () => {
    const invoke = vi.fn(async () => record)
    expect(await saveLocalProxyPlan(record, document, invoke, () => true)).toEqual(record)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('relayLocalProxyPlanSave', {
      document,
      expectedRevision: record.revision
    })
    invoke.mockClear()
    await expect(saveLocalProxyPlan(undefined, document, invoke, () => true)).rejects.toThrow(
      '尚未读取'
    )
    expect(invoke).not.toHaveBeenCalled()
    invoke.mockRejectedValue(new Error('stale CAS'))
    await expect(saveLocalProxyPlan(record, document, invoke, () => true)).rejects.toThrow(
      'stale CAS'
    )
  })
  it('rejects a cancelled context and mismatched save result', async () => {
    let active = true
    const invoke = vi.fn(async () => {
      active = false
      return record
    })
    await expect(saveLocalProxyPlan(record, document, invoke, () => active)).rejects.toThrow(
      '页面已变化'
    )
    await expect(
      saveLocalProxyPlan(
        record,
        document,
        async () => ({ ...record, document: { ...document, httpPort: 19232 } }),
        () => true
      )
    ).rejects.toThrow('未确认')
  })
  it('offers only actual concrete nodes and omits direct/reject/forwarding adapters', () => {
    expect(
      dedicatedNodeOptions([
        { name: 'fixed', type: 'ss' },
        { name: 'DIRECT', type: 'ss' },
        { name: 'disguised', type: 'direct' },
        { name: 'rejected', type: 'reject' },
        { name: 'via', type: 'ss', dialer_proxy: 'DIRECT' },
        { name: 'second', type: 'http', 'dialer-proxy': '' }
      ])
    ).toEqual(['fixed', 'second'])
  })
  it.each([
    document,
    { ...document, ports: { http: 0, mixed: 19231, socks: 19232, redir: 19233 } }
  ])(
    'uses the same saved plan for an explicit system-proxy cold start %j',
    async (savedDocument) => {
      let running = false
      const state = () => ({
        phase: running ? 'running' : 'idle',
        owned: running,
        pending: false,
        uncertain: false,
        hasRecord: running,
        traffic: running ? 'listening' : 'inactive',
        profileId: 'profile',
        httpPort: 19231,
        ports: savedDocument.ports
      })
      const invoke = vi.fn(async (channel: string, ..._args: unknown[]): Promise<unknown> => {
        if (channel === 'relayLocalProxyState') return state()
        if (channel === 'getProfileConfig') return { current: 'profile' }
        if (channel === 'relayProfileList')
          return { profiles: [{ id: 'profile', sha256: 'source' }] }
        if (channel === 'relayLocalProxyPlanRead') return { ...record, document: savedDocument }
        if (channel === 'changeCurrentProfile') return
        if (channel === 'relayLocalProxyPrepare') return { canStart: true, evidenceId: 'proof' }
        if (channel === 'relayLocalProxyAction') {
          running = true
          return { status: 'started', state: state() }
        }
        throw new Error(channel)
      })
      await ensureSelectedProxy(invoke, () => true)
      expect(invoke).toHaveBeenCalledWith('relayLocalProxyPrepare', {
        profile: { id: 'profile', sha256: 'source' },
        ...savedDocument,
        lifetime: 'main'
      })
      expect(invoke.mock.calls.some(([channel]) => channel === 'relayLocalProxyPlanSave')).toBe(
        false
      )
    }
  )
  it('does not report a mixed-port startup as ready if runtime lost the configured listeners', async () => {
    let running = false
    const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === 'relayLocalProxyState')
        return {
          phase: running ? 'running' : 'idle',
          owned: running,
          pending: false,
          uncertain: false,
          hasRecord: running,
          traffic: running ? 'listening' : 'inactive',
          profileId: 'profile',
          httpPort: 19231
        }
      if (channel === 'getProfileConfig') return { current: 'profile' }
      if (channel === 'relayProfileList') return { profiles: [{ id: 'profile', sha256: 'source' }] }
      if (channel === 'relayLocalProxyPlanRead')
        return {
          ...record,
          document: { ...document, ports: { http: 0, mixed: 19231, socks: 19232, redir: 0 } }
        }
      if (channel === 'changeCurrentProfile') return
      if (channel === 'relayLocalProxyPrepare') return { canStart: true, evidenceId: 'proof' }
      if (channel === 'relayLocalProxyAction') {
        running = true
        return { status: 'started' }
      }
      throw new Error(channel)
    })
    await expect(ensureSelectedProxy(invoke, () => true)).rejects.toThrow('运行状态未确认')
  })
  it('does not start any core when the stored plan is corrupt', async () => {
    const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === 'relayLocalProxyState')
        return {
          phase: 'idle',
          owned: false,
          pending: false,
          uncertain: false,
          hasRecord: false,
          traffic: 'inactive'
        }
      if (channel === 'getProfileConfig') return { current: 'profile' }
      if (channel === 'relayProfileList') return { profiles: [{ id: 'profile', sha256: 'source' }] }
      if (channel === 'relayLocalProxyPlanRead')
        return { ...record, document: { ...document, httpPort: 'invalid' } }
      throw new Error(channel)
    })
    await expect(ensureSelectedProxy(invoke, () => true)).rejects.toThrow()
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === 'relayLocalProxyPrepare' || channel === 'changeCurrentProfile'
      )
    ).toBe(false)
  })
})
