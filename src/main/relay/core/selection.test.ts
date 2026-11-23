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
  it('fills only an empty selection when a first TUN click races another choice', async () => {
    const f = fixture()
    await expect(
      f.service.remember({ ...selected, sha256: 'c'.repeat(64) }, () => {})
    ).rejects.toThrow()
    expect(f.adapters.save).not.toHaveBeenCalled()
    await f.service.remember(selected, () => {})
    expect(f.adapters.save).not.toHaveBeenCalled()
    f.adapters.read.mockResolvedValue({ revision: 'b'.repeat(64) })
    await f.service.remember(selected, () => {})
    expect(f.adapters.save).toHaveBeenCalledExactlyOnceWith(selected, 'b'.repeat(64))
  })
  it('offers only a still available saved selection without writing a preference', async () => {
    const f = fixture()
    expect(await f.service.readPreferred()).toEqual(selected)
    f.adapters.profiles.read.mockRejectedValueOnce(Error('removed'))
    expect(await f.service.readPreferred()).toBeUndefined()
    f.adapters.read.mockResolvedValue({ revision: 'b'.repeat(64) })
    expect(await f.service.readPreferred()).toBeUndefined()
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('preserves errors reading the native preference', async () => {
    const f = fixture()
    f.adapters.read.mockRejectedValueOnce(Error('unsafe preference'))
    await expect(f.service.readPreferred()).rejects.toThrow('unsafe preference')
  })
})
