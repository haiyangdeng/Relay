import { describe, expect, it, vi } from 'vitest'
import type { RelayStoredProfile } from '../../../../shared/relay/profiles'
import type {
  SubscriptionSourceInfo,
  SubscriptionSourcePlan
} from '../../../../shared/relay/subscription-sources'
import {
  importDashboardSubscription,
  subscriptionDashboardEntries,
  updateDashboardSubscription
} from './subscriptions-dashboard-model'

const first: RelayStoredProfile = {
  id: 'profile-one',
  name: '订阅一',
  createdAt: '2026-11-09T00:00:00Z',
  sha256: 'a'.repeat(64),
  summary: { proxies: 18, groups: 8, rules: 20, proxyProviders: 0, ruleProviders: 0 }
}
const current: RelayStoredProfile = { ...first, id: 'profile-two', sha256: 'b'.repeat(64) }
const source: SubscriptionSourceInfo = {
  id: 'source-one',
  revision: 'c'.repeat(64),
  name: '订阅一',
  origin: 'https://subscription.example',
  proxyPort: 7890,
  createdAt: first.createdAt,
  locked: false,
  versions: [first, current].map((p, index) => ({
    id: 'version-' + index,
    createdAt: p.createdAt,
    action: 'update',
    profile: { id: p.id, sha256: p.sha256 }
  }))
}
const update: SubscriptionSourcePlan = {
  evidenceId: 'download-proof',
  kind: 'update',
  name: source.name,
  origin: source.origin,
  proxyPort: 7890,
  source: { id: source.id, revision: source.revision }
}
const commit: SubscriptionSourcePlan = { ...update, kind: 'commit', evidenceId: 'save-proof' }
const register: SubscriptionSourcePlan = {
  ...update,
  kind: 'register',
  source: undefined,
  evidenceId: 'register-proof'
}
const request = {
  name: '订阅一',
  url: 'https://subscription.example/clash?token=fixture',
  proxyPort: 7890
}

describe('subscription dashboard inventory', () => {
  it('uses the latest exact profile identity and keeps historical subscription versions out of local cards', () => {
    const local = { ...first, id: 'local' }
    const entries = subscriptionDashboardEntries([first, current, local], [source])
    expect(entries.subscriptions).toEqual([{ source, profile: current }])
    expect(entries.localProfiles).toEqual([local])
  })
  it('does not enable a card from an id whose digest differs, or from a missing latest profile', () => {
    for (const profiles of [[first], [{ ...current, sha256: 'd'.repeat(64) }]]) {
      const entries = subscriptionDashboardEntries(profiles, [source])
      expect(entries.subscriptions[0].profile).toBeUndefined()
      expect(entries.localProfiles).toEqual([])
    }
  })
  it('keeps a newly registered subscription visible before its first download', () => {
    const empty = { ...source, versions: [] }
    expect(subscriptionDashboardEntries([], [empty]).subscriptions).toEqual([
      { source: empty, profile: undefined }
    ])
  })
})

describe('subscription dashboard action handoff', () => {
  it('runs registration, download and commit through their existing confirmation entrypoints once', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(register)
      .mockResolvedValueOnce({ status: 'saved', source, warnings: [] })
      .mockResolvedValueOnce(update)
      .mockResolvedValueOnce({ status: 'staged', plan: commit, warnings: [] })
      .mockResolvedValueOnce({ status: 'saved', source, warnings: [] })
    const onPlan = vi.fn()
    expect(await importDashboardSubscription({ invoke, onPlan }, request)).toEqual({
      registered: true,
      result: { status: 'saved', source, warnings: [] }
    })
    expect(invoke.mock.calls).toEqual([
      ['relaySourceRegisterPrepare', request],
      ['relaySourceExecute', { evidenceId: 'register-proof' }],
      ['relaySourceUpdatePrepare', { id: source.id, revision: source.revision }],
      ['relaySourceExecute', { evidenceId: 'download-proof' }],
      ['relaySourceExecute', { evidenceId: 'save-proof' }]
    ])
    expect(onPlan.mock.calls.map(([plan]) => plan.evidenceId)).toEqual([
      'register-proof',
      'download-proof',
      'save-proof'
    ])
  })
  it.each(['cancelled', 'failed', 'uncertain'] as const)(
    'does not download after registration %s',
    async (status) => {
      const invoke = vi
        .fn()
        .mockResolvedValueOnce(register)
        .mockResolvedValueOnce({ status, warnings: [] })
      expect(await importDashboardSubscription({ invoke }, request)).toEqual({
        registered: false,
        result: { status, warnings: [] }
      })
      expect(invoke).toHaveBeenCalledTimes(2)
    }
  )
  it.each(['cancelled', 'failed', 'uncertain', 'unchanged'] as const)(
    'does not commit or retry a download returned as %s',
    async (status) => {
      const invoke = vi
        .fn()
        .mockResolvedValueOnce(update)
        .mockResolvedValueOnce({ status, warnings: [] })
      expect(await updateDashboardSubscription({ invoke }, source)).toEqual({
        status,
        warnings: []
      })
      expect(invoke).toHaveBeenCalledTimes(2)
    }
  )
  it('keeps the saved registration and stops the next stage when cancellation arrives between stages', async () => {
    let cancelled = false
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(register)
      .mockImplementationOnce(async () => {
        cancelled = true
        return { status: 'saved', source, warnings: [] }
      })
    const outcome = await importDashboardSubscription(
      { invoke, cancelled: () => cancelled },
      request
    )
    expect(outcome.registered).toBe(true)
    expect(outcome.result.status).toBe('cancelled')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('retains the successful registration when a later invocation fails', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(register)
      .mockResolvedValueOnce({ status: 'saved', source, warnings: [] })
      .mockRejectedValueOnce(new Error('download prepare failed'))
    const outcome = await importDashboardSubscription({ invoke }, request)
    expect(outcome.registered).toBe(true)
    expect(outcome.result).toMatchObject({ status: 'failed', source })
    expect(invoke).toHaveBeenCalledTimes(3)
  })
  it('cancels only its own prepared commit when cancellation arrives after download', async () => {
    let cancelled = false
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(update)
      .mockImplementationOnce(async () => {
        cancelled = true
        return { status: 'staged', plan: commit, warnings: [] }
      })
      .mockResolvedValueOnce({ status: 'cancelled' })
    expect(
      (await updateDashboardSubscription({ invoke, cancelled: () => cancelled }, source)).status
    ).toBe('cancelled')
    expect(invoke.mock.calls.at(-1)).toEqual(['relaySourceCancel', { evidenceId: 'save-proof' }])
  })
  it('rejects a staged result for another source instead of confirming it', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(update)
      .mockResolvedValueOnce({
        status: 'staged',
        plan: { ...commit, source: { id: 'other', revision: source.revision } }
      })
    await expect(updateDashboardSubscription({ invoke }, source)).rejects.toThrow('当前来源')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('does not silently advance after an invocation error', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(update)
      .mockRejectedValueOnce(new Error('native rejected'))
    await expect(updateDashboardSubscription({ invoke }, source)).rejects.toThrow('native rejected')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
