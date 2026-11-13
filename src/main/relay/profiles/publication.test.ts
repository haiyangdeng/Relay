import { describe, expect, it, vi } from 'vitest'
import type { RelayProfilePreparation, RelayStoredProfile } from '../../../shared/relay/profiles'
import { createProfileService } from './service'
import { ProfileWriteUncertain } from './store'
import { profileHash, type ProfileSource } from './source'

function fixture() {
  let live = true,
    time = 1000
  const trace: string[] = []
  const source: ProfileSource = Object.freeze({
    name: 'Copy.yaml',
    text: 'proxies: []\n',
    assertCurrent: async () => {
      trace.push('assert')
      if (!live) throw new Error('synthetic-private')
    },
    readAgain: async () => {
      trace.push('readAgain')
      return 'proxies: []\n'
    }
  })
  const profile: RelayStoredProfile = {
    id: '11111111-1111-4111-8111-111111111111',
    name: source.name,
    sha256: profileHash(source.text),
    createdAt: '2026-11-04T00:00:00.000Z',
    summary: { proxies: 0, groups: 0, rules: 0, proxyProviders: 0, ruleProviders: 0 }
  }
  const adapters = {
    pick: async () => source,
    confirm: vi.fn(async (_report: RelayProfilePreparation, _purpose?: 'simple-publication') => {
      trace.push('confirm')
      return true
    }),
    save: vi.fn(async (_name: string, _text: string) => {
      trace.push('save')
      return profile
    }),
    list: vi.fn(async () => ({ profiles: [profile], activeId: null, incomplete: 0, warnings: [] })),
    now: () => time
  }
  const service = createProfileService(adapters)
  return {
    source,
    service,
    adapters,
    trace,
    profile,
    retire: () => {
      live = false
    },
    advance: () => {
      time = 61001
    }
  }
}
describe('Main-only Profile publication purpose and old copy specialization', () => {
  it('keeps ordinary generated copy on its original one-argument confirmation and result', async () => {
    const f = fixture(),
      report = await f.service.prepareGenerated(f.source)
    expect((await f.service.save({ evidenceId: report.evidenceId })).status).toBe('saved')
    expect(f.adapters.confirm.mock.calls[0]).toHaveLength(1)
    expect(f.adapters.save).toHaveBeenCalledWith(f.source.name, f.source.text)
    await expect(f.service.save({ evidenceId: report.evidenceId })).rejects.toThrow('重新选择')
  })
  it('public save cannot consume the publication report and the exact private token still works once', async () => {
    const f = fixture(),
      prepared = await f.service.preparePublication(f.source),
      hook = vi.fn(async () => {
        f.trace.push('hook')
      })
    await expect(f.service.save({ evidenceId: prepared.report.evidenceId })).rejects.toThrow(
      '重新选择'
    )
    expect(f.adapters.confirm).not.toHaveBeenCalled()
    expect(f.adapters.save).not.toHaveBeenCalled()
    f.trace.splice(0)
    expect((await f.service.savePublication(prepared.token, hook)).status).toBe('saved')
    expect(f.trace).toEqual(['assert', 'confirm', 'assert', 'readAgain', 'hook', 'assert', 'save'])
    expect(f.adapters.confirm.mock.calls[0][1]).toBe('simple-publication')
    expect(hook).toHaveBeenCalledOnce()
    await expect(f.service.savePublication(prepared.token, hook)).rejects.toThrow('发布凭据')
  })
  it('rejects forged and foreign-service tokens without consuming the true proof', async () => {
    const f = fixture(),
      other = fixture(),
      held = await f.service.preparePublication(f.source),
      foreign = await other.service.preparePublication(other.source)
    await expect(
      f.service.savePublication({ purpose: 'simple-publication' }, async () => {})
    ).rejects.toThrow('发布凭据')
    await expect(f.service.savePublication(foreign.token, async () => {})).rejects.toThrow(
      '发布凭据'
    )
    expect((await f.service.savePublication(held.token, async () => {})).status).toBe('saved')
    expect(f.adapters.save).toHaveBeenCalledOnce()
  })
  it.each(['clear', 'expired', 'source', 'throw'] as const)(
    'refuses Profile admission when beforePersist %s occurs',
    async (kind) => {
      const f = fixture(),
        held = await f.service.preparePublication(f.source)
      const result = await f.service.savePublication(held.token, async () => {
        expect(f.trace.at(-1)).toBe('readAgain')
        if (kind === 'clear') f.service.clear()
        if (kind === 'expired') f.advance()
        if (kind === 'source') f.retire()
        if (kind === 'throw') throw new Error('synthetic-private-hook-error')
      })
      expect(result.status).toBe('failed')
      expect(f.adapters.save).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain('synthetic-private')
      await expect(f.service.savePublication(held.token, async () => {})).rejects.toThrow(
        '发布凭据'
      )
    }
  )
  it('retains the real uncertain result with no guessed profile or automatic list/retry', async () => {
    const f = fixture(),
      held = await f.service.preparePublication(f.source)
    f.adapters.save.mockRejectedValueOnce(new ProfileWriteUncertain())
    const result = await f.service.savePublication(held.token, async () => {})
    expect(result.status).toBe('uncertain')
    expect(result.profile).toBeUndefined()
    expect(f.adapters.list).not.toHaveBeenCalled()
    await expect(f.service.savePublication(held.token, async () => {})).rejects.toThrow('发布凭据')
    expect(f.adapters.save).toHaveBeenCalledOnce()
  })
  it('does not claim rollback if clear occurs inside an already admitted Profile save', async () => {
    const f = fixture(),
      held = await f.service.preparePublication(f.source)
    f.adapters.save.mockImplementationOnce(async () => {
      f.service.clear()
      return f.profile
    })
    expect((await f.service.savePublication(held.token, async () => {})).status).toBe('saved')
    expect(f.adapters.save).toHaveBeenCalledOnce()
  })
})
