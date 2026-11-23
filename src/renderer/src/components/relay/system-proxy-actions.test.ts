import { describe, expect, it, vi } from 'vitest'
import {
  defaultPacScript,
  defaultSystemBypass,
  type SystemProxyReport,
  type SystemProxySettings
} from '../../../../shared/relay/system-proxy'
import {
  submitSystemProxy,
  canPrepareSystemProxy,
  systemProxyPortFromCore,
  systemProxyListenerPort,
  selectedSystemProxyServices
} from './system-proxy-actions'

const settings: SystemProxySettings = {
  mode: 'manual',
  host: '127.0.0.1',
  port: 18191,
  socks: false,
  bypass: defaultSystemBypass,
  excludeSimple: true,
  serviceIDs: ['wifi'],
  pacScript: defaultPacScript
}
const evidenceId = '11111111-1111-4111-8111-111111111111'
const preparation = (action: 'apply' | 'restore', allowed = true) => ({
  evidenceId,
  action,
  report: { canApply: allowed, canRestore: allowed }
})

describe('one-action system proxy workflow', () => {
  it('separates inspect readiness from the later prepared submission permission', () => {
    const observed: SystemProxyReport = {
      status: 'inactive',
      revision: 'r',
      location: 'l',
      canApply: false,
      canRestore: false,
      warnings: [],
      services: []
    }
    expect(canPrepareSystemProxy()).toBe(false)
    for (const status of ['inactive', 'restored', 'rolledBack'] as const)
      expect(canPrepareSystemProxy({ ...observed, status })).toBe(true)
    for (const status of ['active', 'applied', 'rolledBack'] as const) {
      expect(
        canPrepareSystemProxy({ ...observed, status, recordID: evidenceId, canRestore: true })
      ).toBe(true)
      expect(canPrepareSystemProxy({ ...observed, status, recordID: evidenceId })).toBe(false)
    }
    for (const status of ['active', 'applied'] as const)
      expect(canPrepareSystemProxy({ ...observed, status, canRestore: true })).toBe(false)
    for (const status of ['inactive', 'restored'] as const)
      expect(canPrepareSystemProxy({ ...observed, status, recordID: evidenceId })).toBe(false)
    for (const status of ['pending', 'conflict', 'uncertain'] as const)
      for (const canApply of [false, true])
        expect(
          canPrepareSystemProxy({
            ...observed,
            status,
            canApply,
            recordID: evidenceId,
            canRestore: true
          })
        ).toBe(false)
  })

  it('uses enabled services only for an untouched choice and preserves explicit selections or none', () => {
    const report: SystemProxyReport = {
      status: 'inactive',
      revision: 'r',
      location: 'l',
      canApply: false,
      canRestore: false,
      warnings: [],
      services: [
        {
          id: 'wifi',
          name: 'Wi-Fi',
          enabled: true,
          http: false,
          https: false,
          socks: false,
          pac: false
        },
        {
          id: 'vpn',
          name: 'VPN',
          enabled: true,
          http: false,
          https: false,
          socks: false,
          pac: false
        },
        {
          id: 'old',
          name: 'Old',
          enabled: false,
          http: false,
          https: false,
          socks: false,
          pac: false
        }
      ]
    }
    expect(selectedSystemProxyServices(report)).toEqual(['wifi', 'vpn'])
    expect(selectedSystemProxyServices(report, ['wifi', 'old'])).toEqual(['wifi'])
    expect(selectedSystemProxyServices(report, [])).toEqual([])
  })

  it.each(['pending', 'conflict'] as const)(
    'allows explicit re-enabling from a confirmed detached %s record',
    async (status) => {
      const report: SystemProxyReport = {
        status,
        revision: 'r',
        location: 'l',
        recordID: evidenceId,
        canApply: false,
        canRestore: false,
        canRetireDetached: true,
        services: [],
        warnings: []
      }
      expect(canPrepareSystemProxy(report)).toBe(true)
      expect(canPrepareSystemProxy({ ...report, recordID: undefined })).toBe(false)
      expect(canPrepareSystemProxy({ ...report, canRetireDetached: false })).toBe(false)
      expect(canPrepareSystemProxy({ ...report, status: 'uncertain' })).toBe(false)

      const plan = { evidenceId, action: 'apply', report }
      const result = { status: 'applied', warnings: [] }
      const invoke = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce(result)
      expect(await submitSystemProxy('apply', settings, invoke, () => {})).toBe(result)
      expect(invoke.mock.calls).toEqual([
        ['relaySystemProxyPrepare', settings],
        ['relaySystemProxyExecute', { evidenceId }]
      ])

      const restore = vi
        .fn()
        .mockResolvedValueOnce({ ...plan, action: 'restore' })
        .mockResolvedValueOnce(undefined)
      await expect(submitSystemProxy('restore', settings, restore, () => {})).rejects.toThrow()
      expect(restore.mock.calls.at(-1)).toEqual(['relaySystemProxyCancel', { evidenceId }])
    }
  )

  it('treats an already completed startup restore as enabled but still lets Apply Settings update it', async () => {
    const report = {
      status: 'active',
      recordID: evidenceId,
      canRestore: true,
      canApply: true,
      warnings: []
    }
    const plan = { ...preparation('apply'), alreadyApplied: true, report }
    const invoke = vi.fn(async (channel: string) =>
      channel === 'relaySystemProxyPrepare' ? plan : undefined
    )
    await expect(submitSystemProxy('enable', settings, invoke, () => {})).resolves.toMatchObject({
      status: 'applied',
      report
    })
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      'relaySystemProxyPrepare',
      'relaySystemProxyCancel'
    ])
    invoke.mockClear()
    await submitSystemProxy('apply', settings, invoke, () => {})
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      'relaySystemProxyPrepare',
      'relaySystemProxyExecute'
    ])
  })
  it('preserves a manually edited HTTP target and rejects the HTTP-only port for SOCKS', async () => {
    const invoke = vi.fn(async () => ({ httpPort: 7892, mixedPort: 7890 }))
    expect(
      await systemProxyListenerPort(invoke, () => true, { mode: 'manual', socks: false }, 19000)
    ).toBe(19000)
    await expect(
      systemProxyListenerPort(invoke, () => true, { mode: 'manual', socks: true }, 7892)
    ).rejects.toThrow('不支持 SOCKS')
  })
  it('follows a later core port until the user edits it, without adopting an unavailable endpoint', () => {
    expect(systemProxyPortFromCore(18191, false, 18192)).toBe(18192)
    expect(systemProxyPortFromCore(7890, true, 18192)).toBe(7890)
    expect(systemProxyPortFromCore(7890, false, 18192)).toBe(18192)
    for (const missing of [undefined, NaN, 0, 70000, 18191.5])
      expect(systemProxyPortFromCore(18191, false, missing)).toBe(18191)
  })
  it.each(['apply', 'restore'] as const)(
    'passes %s through preparation and native confirmation once',
    async (action) => {
      const plan = preparation(action),
        result = { status: 'cancelled', warnings: [] }
      const invoke = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce(result)
      const observed = vi.fn()
      expect(await submitSystemProxy(action, settings, invoke, observed)).toBe(result)
      expect(invoke.mock.calls).toEqual([
        [
          action === 'apply' ? 'relaySystemProxyPrepare' : 'relaySystemProxyRestorePrepare',
          action === 'apply' ? settings : undefined
        ],
        ['relaySystemProxyExecute', { evidenceId }]
      ])
      expect(observed).toHaveBeenCalledWith(plan)
    }
  )
  it.each(['apply', 'restore'] as const)(
    'retires a blocked %s plan without submitting it',
    async (action) => {
      const invoke = vi
        .fn()
        .mockResolvedValueOnce(preparation(action, false))
        .mockResolvedValueOnce(undefined)
      await expect(submitSystemProxy(action, settings, invoke, () => {})).rejects.toThrow(
        '状态需要核对'
      )
      expect(invoke.mock.calls.at(-1)).toEqual(['relaySystemProxyCancel', { evidenceId }])
      expect(invoke.mock.calls.some(([channel]) => channel === 'relaySystemProxyExecute')).toBe(
        false
      )
    }
  )
  it('rejects a mismatched plan and never retries failed writes', async () => {
    const mismatch = vi
      .fn()
      .mockResolvedValueOnce(preparation('restore'))
      .mockResolvedValueOnce(undefined)
    await expect(submitSystemProxy('apply', settings, mismatch, () => {})).rejects.toThrow()
    expect(mismatch.mock.calls.at(-1)?.[0]).toBe('relaySystemProxyCancel')
    const failed = vi
      .fn()
      .mockResolvedValueOnce(preparation('apply'))
      .mockRejectedValueOnce(new Error('reply lost'))
    await expect(submitSystemProxy('apply', settings, failed, () => {})).rejects.toThrow(
      'reply lost'
    )
    expect(failed).toHaveBeenCalledTimes(2)
  })
})
