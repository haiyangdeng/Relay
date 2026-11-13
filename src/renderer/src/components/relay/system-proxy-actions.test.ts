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
