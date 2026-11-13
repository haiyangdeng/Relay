import { describe, expect, it, vi } from 'vitest'
import type { RelayRuntimeCheckResult } from '../../../shared/relay/runtime'
import { profileRuntimeSource } from '../__fixtures__/profile-runtime'
import { createProfileRuntimeService } from './runtime-service'
import { compileProfileRuntime } from './runtime'
import { profileHash } from './source'
import { inspectProfile } from './inspect'

function fixture() {
  const summary = inspectProfile(profileRuntimeSource).summary
  if (!summary) throw new Error('fixture summary missing')
  const selection = {
    id: '00000000-0000-0000-0000-000000000001',
    sha256: profileHash(profileRuntimeSource)
  }
  const stored = {
    profile: { ...selection, name: 'Local', createdAt: '2026-10-24T00:00:00.000Z', summary },
    text: profileRuntimeSource,
    revision: 'a'.repeat(64)
  }
  const config = compileProfileRuntime(profileRuntimeSource).configuration
  if (!config) throw new Error('fixture config missing')
  const checked: RelayRuntimeCheckResult = {
    status: 'passed',
    scope: 'isolated-projection',
    fullSourceVerified: false,
    active: false,
    runtimeSHA256: profileHash(config),
    version: 'v1.19.33',
    warnings: ['not the full source']
  }
  const adapters = {
    read: vi.fn(async () => structuredClone(stored)),
    check: vi.fn(async () => checked)
  }
  return { adapters, stored, selection, checked, service: createProfileRuntimeService(adapters) }
}
describe('Saved profile runtime inspection and proof lifecycle', () => {
  it('has no startup IO, rejects injected paths and prepares without invoking any core', async () => {
    const f = fixture()
    expect(f.service.isBusy()).toBe(false)
    expect(f.adapters.read).not.toHaveBeenCalled()
    await expect(f.service.prepare({ ...f.selection, path: '/PRIVATE' })).rejects.toThrow('只接受')
    const plan = await f.service.prepare(f.selection)
    expect(plan).toMatchObject({
      canValidate: true,
      scope: 'isolated-projection',
      fullSourceVerified: false,
      active: false
    })
    expect(JSON.stringify(plan)).not.toContain('PRIVATE')
    expect(f.adapters.check).not.toHaveBeenCalled()
  })
  it('consumes a proof once, verifies source/metadata revision and never accepts renderer config bytes', async () => {
    const f = fixture(),
      plan = await f.service.prepare(f.selection)
    plan.runtimeSHA256 = '0'.repeat(64)
    expect(await f.service.check({ evidenceId: plan.evidenceId })).toEqual(f.checked)
    expect(f.adapters.check).toHaveBeenCalledWith(profileRuntimeSource)
    await expect(f.service.check({ evidenceId: plan.evidenceId })).rejects.toThrow('重新查看')
    await expect(
      f.service.check({ evidenceId: plan.evidenceId, configuration: 'PRIVATE' })
    ).rejects.toThrow('不接受')
  })
  it('rejects source/metadata changes and expiry after the reread without starting a core', async () => {
    for (const reason of ['revision', 'time']) {
      let now = 0
      const f = fixture(),
        service = createProfileRuntimeService({ ...f.adapters, now: () => now })
      const plan = await service.prepare(f.selection)
      f.adapters.read.mockImplementationOnce(async () => {
        if (reason === 'time') now = 60001
        return { ...f.stored, revision: reason === 'revision' ? 'b'.repeat(64) : f.stored.revision }
      })
      expect((await service.check({ evidenceId: plan.evidenceId })).status).toBe('unavailable')
      expect(f.adapters.check).not.toHaveBeenCalled()
    }
  })
  it('blocks unsupported profiles while preserving the redacted catalogue', async () => {
    const f = fixture()
    f.adapters.read.mockResolvedValue({
      ...f.stored,
      text: 'proxies: [{name: Node, type: unknown-protocol}]'
    })
    const plan = await f.service.prepare(f.selection)
    expect(plan.canValidate).toBe(false)
    expect(plan.catalogue.nodes[0].type).toBe('unknown-protocol')
    await expect(f.service.check({ evidenceId: plan.evidenceId })).rejects.toThrow('重新查看')
    expect(f.adapters.check).not.toHaveBeenCalled()
  })
  it('excludes competing requests and holds quit until the bounded checker finishes', async () => {
    const f = fixture()
    let finish!: (value: RelayRuntimeCheckResult) => void
    f.adapters.check.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const plan = await f.service.prepare(f.selection),
      pending = f.service.check({ evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(f.adapters.check).toHaveBeenCalled())
    const idle = vi.fn(),
      closing = f.service.whenIdle().then(idle)
    await expect(f.service.prepare(f.selection)).rejects.toThrow('等待')
    expect(idle).not.toHaveBeenCalled()
    finish(f.checked)
    expect((await pending).status).toBe('passed')
    await closing
    expect(idle).toHaveBeenCalledTimes(1)
  })
  it('does not convert mismatched results or raw errors into a success or disclose raw credentials', async () => {
    const f = fixture()
    f.adapters.check.mockResolvedValueOnce({ ...f.checked, runtimeSHA256: '0'.repeat(64) })
    let plan = await f.service.prepare(f.selection)
    expect((await f.service.check({ evidenceId: plan.evidenceId })).status).toBe('unavailable')
    plan = await f.service.prepare(f.selection)
    f.adapters.check.mockRejectedValueOnce(new Error('PRIVATE /raw/credentials'))
    expect(JSON.stringify(await f.service.check({ evidenceId: plan.evidenceId }))).not.toContain(
      'PRIVATE'
    )
  })
})
