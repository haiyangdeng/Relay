import { describe, expect, it, vi } from 'vitest'
import type { IsolatedProbeRequest } from '../../../../shared/relay/isolated-probes'
import { executeIsolatedProbe } from './isolated-probe-action'

const request: IsolatedProbeRequest = {
  profile: { id: '00000000-0000-0000-0000-000000000012', sha256: 'a'.repeat(64) },
  target: 'Saved node',
  kind: 'ip',
  provider: 'ip.sb'
}
const plan = {
  evidenceId: '00000000-0000-0000-0000-000000000034',
  kind: 'ip',
  sourceSHA256: request.profile.sha256,
  name: 'Saved',
  nodes: ['Saved node'],
  origins: [],
  configurationSHA256: 'b'.repeat(64)
}
describe('Single-action isolated probe', () => {
  it('uses the pinned preparation and existing native-confirmed run, without retries or extra IPC', async () => {
    const result = {
      status: 'completed',
      kind: 'ip',
      isolated: true,
      ip: { ip: '192.0.2.1' },
      measurements: []
    }
    const invoke = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce(result)
    const prepared = vi.fn()
    expect(
      await executeIsolatedProbe(request, invoke, { prepared, cancelled: () => false })
    ).toEqual(result)
    expect(invoke.mock.calls).toEqual([
      ['relayIsolatedProbePrepare', request],
      ['relayIsolatedProbeRun', { evidenceId: plan.evidenceId }]
    ])
    expect(prepared).toHaveBeenCalledWith(plan)
  })
  it('cancels preparation without running when cancellation arrives before native confirmation', async () => {
    const invoke = vi.fn().mockResolvedValue(plan)
    let cancel = false
    expect(
      (
        await executeIsolatedProbe(request, invoke, {
          cancelled: () => cancel,
          prepared: () => {
            cancel = true
          }
        })
      ).status
    ).toBe('cancelled')
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayIsolatedProbePrepare',
      'relayIsolatedProbeCancel'
    ])
  })
  it('never runs a stale profile or different probe kind', async () => {
    for (const invalid of [
      { ...plan, sourceSHA256: 'c'.repeat(64) },
      { ...plan, kind: 'latency' }
    ]) {
      const invoke = vi.fn().mockResolvedValue(invalid)
      await expect(
        executeIsolatedProbe(request, invoke, { cancelled: () => false, prepared: vi.fn() })
      ).rejects.toThrow('探测配置已变化')
      expect(invoke).toHaveBeenCalledOnce()
    }
  })
  it('preserves native cancellation and does not automatically retry errors', async () => {
    const cancelled = { status: 'cancelled', kind: 'ip', isolated: true, measurements: [] }
    const invoke = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce(cancelled)
    expect(
      await executeIsolatedProbe(request, invoke, { cancelled: () => false, prepared: vi.fn() })
    ).toEqual(cancelled)
    const failure = vi.fn().mockRejectedValue(new Error('Preparation failed'))
    await expect(
      executeIsolatedProbe(request, failure, { cancelled: () => false, prepared: vi.fn() })
    ).rejects.toThrow('Preparation failed')
    expect(failure).toHaveBeenCalledOnce()
  })
})
