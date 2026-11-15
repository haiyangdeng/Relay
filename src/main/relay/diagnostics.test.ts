import { describe, expect, it, vi } from 'vitest'
import { validateEdgeProfileOutput, validateReadOnlyReport } from '../../shared/relay/protocol'
import { createDiagnosticService } from './diagnostics'
import { readOnlyFixture } from './__fixtures__/read-only'

const settings = { httpPort: 7890, node: 'fixture-node', internalExceptions: '' }
function fixture() {
  let now = 1000
  const adapters = {
    observe: vi.fn(async () => readOnlyFixture()),
    guardPlan: vi.fn(async () => ({ plan: 'fixture plan', warnings: ['not applied'] })),
    now: () => now
  }
  return {
    adapters,
    service: createDiagnosticService(adapters),
    setNow: (value: number) => {
      now = value
    }
  }
}

describe('Read-only observation and verified node evidence', () => {
  it('uses an owned observation without asking the legacy reader or accepting renderer settings', async () => {
    const f = fixture()
    const ownedObserve = vi.fn(async () => ({
      parameters: settings,
      report: readOnlyFixture(),
      owned: {
        ports: {
          systemHTTPPort: null,
          systemSOCKSPort: null,
          codeHTTPPort: null,
          dedicatedSOCKSPort: null
        },
        running: false,
        external: { status: 'missing' as const, bindingMatches: false, browserMatches: [] }
      }
    }))
    const service = createDiagnosticService({ ...f.adapters, ownedObserve })
    expect((await service.observe(undefined)).source).toBe('relay-owned')
    expect(f.adapters.observe).not.toHaveBeenCalled()
    await expect(service.observe(settings)).rejects.toThrow('不接受')
  })
  it('returns configuration evidence with runtime checks pending and no protection claim', async () => {
    const { service, adapters } = fixture()
    const observation = await service.observe(settings)
    expect(adapters.observe).toHaveBeenCalledWith(settings)
    expect(observation.source).toBe('legacy-readonly')
    expect(observation.report.guardEnabled).toBe(false)
    expect(observation.report.checks.slice(5).every((check) => check.state === 'pending')).toBe(
      true
    )
    expect(adapters.guardPlan).not.toHaveBeenCalled()
  })
  it('uses a cached core type map rather than renderer-supplied types', async () => {
    const { service, adapters } = fixture()
    const observation = await service.observe(settings)
    observation.report.snapshot.proxyTypes['fixture-node'] = 'Direct'
    observation.report.snapshot.nodeNames.push('invented')
    await service.guardPlan('fixture-node', observation.evidenceId)
    expect(adapters.guardPlan).toHaveBeenCalledWith('fixture-node', {
      'fixture-node': 'Shadowsocks',
      group: 'Selector'
    })
    await expect(service.guardPlan('group', observation.evidenceId)).rejects.toThrow('具体节点')
    await expect(service.guardPlan('invented', observation.evidenceId)).rejects.toThrow('具体节点')
  })
  it('refuses missing, foreign, stale and future-clock evidence', async () => {
    const { service, setNow, adapters } = fixture()
    await expect(service.guardPlan('fixture-node', 'missing')).rejects.toThrow('证据缺失')
    const observation = await service.observe(settings)
    await expect(service.guardPlan('fixture-node', 'other')).rejects.toThrow('证据缺失')
    setNow(61001)
    await expect(service.guardPlan('fixture-node', observation.evidenceId)).rejects.toThrow('60秒')
    setNow(999)
    await expect(service.guardPlan('fixture-node', observation.evidenceId)).rejects.toThrow(
      '证据缺失'
    )
    expect(adapters.guardPlan).not.toHaveBeenCalled()
  })
  it('does not accept file-only evidence or the previous snapshot after refresh failure', async () => {
    const { service, adapters } = fixture()
    const observed = readOnlyFixture()
    observed.snapshot.controllerConnected = false
    adapters.observe.mockResolvedValueOnce(observed)
    let observation = await service.observe(settings)
    await expect(service.guardPlan('fixture-node', observation.evidenceId)).rejects.toThrow(
      '核心尚未确认'
    )
    observation = await service.observe(settings)
    adapters.observe.mockRejectedValueOnce(new Error('fixture read failed'))
    await expect(service.observe(settings)).rejects.toThrow()
    await expect(service.guardPlan('fixture-node', observation.evidenceId)).rejects.toThrow(
      '证据缺失'
    )
    expect(adapters.guardPlan).not.toHaveBeenCalled()
  })
  it('never lets an older concurrent response replace the latest evidence', async () => {
    const { service, adapters } = fixture()
    let finish!: (value: ReturnType<typeof readOnlyFixture>) => void
    adapters.observe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const first = expect(service.observe(settings)).rejects.toThrow('检测结果已过期')
    const latest = await service.observe(settings)
    finish(readOnlyFixture())
    await first
    await service.guardPlan('fixture-node', latest.evidenceId)
    service.clear()
    await expect(service.guardPlan('fixture-node', latest.evidenceId)).rejects.toThrow('证据缺失')
  })
  it('counts freshness from request start rather than renewing old evidence after a slow read', async () => {
    const { service, adapters, setNow } = fixture()
    adapters.observe.mockImplementationOnce(async () => {
      setNow(62000)
      return readOnlyFixture()
    })
    const observation = await service.observe(settings)
    await expect(service.guardPlan('fixture-node', observation.evidenceId)).rejects.toThrow('60秒')
    expect(adapters.guardPlan).not.toHaveBeenCalled()
  })
  it.each(['refresh', 'clear', 'expire', 'clock rollback'] as const)(
    'rejects a native deployment plan that outlives its evidence after %s',
    async (reason) => {
      const { service, adapters, setNow } = fixture()
      let finish!: (value: { plan: string; warnings: string[] }) => void
      adapters.guardPlan.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const observation = await service.observe(settings)
      const result = expect(
        service.guardPlan('fixture-node', observation.evidenceId)
      ).rejects.toThrow('证据缺失或已超过60秒')
      if (reason === 'refresh') await service.observe(settings)
      if (reason === 'clear') service.clear()
      if (reason === 'expire') setNow(61001)
      if (reason === 'clock rollback') setNow(999)
      finish({ plan: 'late plan', warnings: [] })
      await result
    }
  )
  it('rejects path/command injection before calling the observer', async () => {
    const { service, adapters } = fixture()
    for (const raw of [
      { ...settings, context: { home: '/other' } },
      { ...settings, executable: '/bin/sh' },
      { ...settings, httpPort: 17890 }
    ])
      await expect(service.observe(raw)).rejects.toThrow()
    expect(adapters.observe).not.toHaveBeenCalled()
  })
})

describe('Read-only native result validation', () => {
  it('rejects false runtime certification, duplicates and inconsistent forced policy evidence', () => {
    expect(validateReadOnlyReport(readOnlyFixture())).toEqual(readOnlyFixture())
    expect(() => validateReadOnlyReport({ ...readOnlyFixture(), guardEnabled: true })).toThrow()
    for (const mutate of [
      (report: ReturnType<typeof readOnlyFixture>) => {
        report.checks[10].state = 'verifiedConfiguration'
      },
      (report: ReturnType<typeof readOnlyFixture>) => {
        report.checks[1].id = report.checks[0].id
      },
      (report: ReturnType<typeof readOnlyFixture>) => {
        report.edgePolicies[0].forced = false
      },
      (report: ReturnType<typeof readOnlyFixture>) => {
        report.snapshot.edgePolicyCount = 3
      },
      (report: ReturnType<typeof readOnlyFixture>) => {
        report.edgePolicies[1].key = report.edgePolicies[0].key
      }
    ]) {
      const report = readOnlyFixture()
      mutate(report)
      expect(() => validateReadOnlyReport(report)).toThrow()
    }
  })
  it('accepts only generated XML with an explicitly uninstalled state', () => {
    const profile = {
      profileXML: '<?xml version="1.0"?><plist/>',
      installed: false,
      warnings: ['not installed']
    }
    expect(validateEdgeProfileOutput(profile)).toEqual(profile)
    expect(() => validateEdgeProfileOutput({ ...profile, installed: true })).toThrow()
    expect(() => validateEdgeProfileOutput({ ...profile, profileXML: {} })).toThrow()
  })
})
