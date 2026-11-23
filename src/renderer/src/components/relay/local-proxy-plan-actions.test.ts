import { describe, expect, it, vi } from 'vitest'
import type { LocalProxyPlan } from '../../../../shared/relay/local-proxy-plan'
import { dedicatedNodeOptions, saveLocalProxyPlan } from './local-proxy-plan-actions'

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
})
