import { describe, expect, it, vi } from 'vitest'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'
import {
  validateCoreSelectionSnapshot,
  type CoreSelectionSnapshot
} from '../../../shared/relay/lifecycle'
import { createCoreSelectionService } from './selection'

const selected: RelayProfileSelection = {
  id: '00000000-0000-0000-0000-000000000001',
  sha256: 'a'.repeat(64)
}
function fixture() {
  const adapters = {
    profiles: { read: vi.fn(async () => ({ revision: 'c'.repeat(64) })) },
    read: vi.fn(async (): Promise<CoreSelectionSnapshot> => ({
      selection: selected,
      revision: 'b'.repeat(64)
    })),
    defaults: vi.fn(async () => [selected]),
    save: vi.fn(async () => ({ selection: selected, revision: 'd'.repeat(64) }))
  }
  // Only the revision is consumed by this service; the real store validates the body.
  const service = createCoreSelectionService({
    ...adapters,
    profiles: {
      read: async () => ({
        ...(await adapters.profiles.read()),
        profile: {
          ...selected,
          name: 'A',
          createdAt: '',
          summary: { proxies: 0, groups: 0, rules: 0, proxyProviders: 0, ruleProviders: 0 }
        },
        text: ''
      })
    }
  })
  return { adapters, service }
}
describe('Startup selection preserves validated source identity without activation', () => {
  it('does no constructor IO and verifies the immutable source before returning a selection', async () => {
    const f = fixture()
    expect(f.adapters.read).not.toHaveBeenCalled()
    expect(await f.service.read()).toEqual(selected)
    expect(f.adapters.profiles.read).toHaveBeenCalledOnce()
    f.adapters.profiles.read.mockRejectedValueOnce(new Error('digest changed'))
    await expect(f.service.read()).rejects.toThrow('digest changed')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('uses the latest preference revision, rechecks source metadata after writing and does not retry uncertainty', async () => {
    const f = fixture()
    f.adapters.profiles.read
      .mockResolvedValueOnce({ revision: 'c'.repeat(64) })
      .mockResolvedValueOnce({ revision: 'e'.repeat(64) })
    await expect(f.service.remember(selected)).rejects.toThrow('不回滚或重启')
    expect(f.adapters.save).toHaveBeenCalledExactlyOnceWith(selected, 'b'.repeat(64))
  })
  it('rejects overlapping writes while retaining the first operation until it settles', async () => {
    const f = fixture()
    let finish: (() => void) | undefined
    f.adapters.save.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { selection: selected, revision: 'd'.repeat(64) }
    })
    const saving = f.service.remember(selected)
    await vi.waitFor(() => expect(f.adapters.save).toHaveBeenCalledOnce())
    await expect(f.service.remember(selected)).rejects.toThrow('正在保存')
    finish?.()
    await saving
    expect(f.adapters.profiles.read).toHaveBeenCalledTimes(2)
  })
  it('rejects unknown native response fields and injected paths before using them', () => {
    for (const raw of [
      { revision: 'a'.repeat(64), path: '/private' },
      { revision: 'a'.repeat(64), selection: { ...selected, path: '/private' } },
      { revision: 'x', selection: selected }
    ])
      expect(() => validateCoreSelectionSnapshot(raw)).toThrow()
  })
  it('keeps a valid remembered choice without reading defaults or writing preferences', async () => {
    const f = fixture()
    expect(await f.service.resolveStartup(() => {})).toEqual(selected)
    expect(f.adapters.defaults).not.toHaveBeenCalled()
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('exposes the same verified fallback read-only, then remembers it against the original revision for startup', async () => {
    const f = fixture()
    f.adapters.read.mockResolvedValue({ revision: 'b'.repeat(64) })
    expect(await f.service.readPreferred()).toEqual(selected)
    expect(f.adapters.save).not.toHaveBeenCalled()
    expect(await f.service.resolveStartup(() => {})).toEqual(selected)
    expect(f.adapters.save).toHaveBeenCalledExactlyOnceWith(selected, 'b'.repeat(64))
  })
  it('skips an unavailable saved source and an unreadable first candidate, without retrying either', async () => {
    const f = fixture(),
      next = { ...selected, id: '00000000-0000-0000-0000-000000000002' }
    f.adapters.defaults.mockResolvedValue([selected, next])
    f.adapters.profiles.read
      .mockRejectedValueOnce(Error('removed'))
      .mockRejectedValueOnce(Error('invalid'))
    f.adapters.save.mockResolvedValue({ selection: next, revision: 'd'.repeat(64) })
    expect(await f.service.resolveStartup(() => {})).toEqual(next)
    expect(f.adapters.save).toHaveBeenCalledExactlyOnceWith(next, 'b'.repeat(64))
  })
  it('does not turn native preference errors, empty inventory or a superseded default into a startup', async () => {
    const f = fixture()
    f.adapters.read.mockRejectedValueOnce(Error('unsafe preference file'))
    await expect(f.service.resolveStartup(() => {})).rejects.toThrow('unsafe preference')
    expect(f.adapters.defaults).not.toHaveBeenCalled()
    f.adapters.read.mockResolvedValue({ revision: 'b'.repeat(64) })
    f.adapters.defaults.mockResolvedValueOnce([])
    expect(await f.service.resolveStartup(() => {})).toBeUndefined()
    let current = true
    f.adapters.defaults.mockImplementationOnce(async () => {
      current = false
      return [selected]
    })
    await expect(
      f.service.resolveStartup(() => {
        if (!current) throw Error('superseded')
      })
    ).rejects.toThrow('superseded')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('does not overwrite a competing preference revision or retry a rejected fallback save', async () => {
    const f = fixture()
    f.adapters.read.mockResolvedValue({ revision: 'b'.repeat(64) })
    f.adapters.save.mockRejectedValueOnce(Error('revision changed'))
    await expect(f.service.resolveStartup(() => {})).rejects.toThrow('revision changed')
    expect(f.adapters.save).toHaveBeenCalledExactlyOnceWith(selected, 'b'.repeat(64))
  })
})
