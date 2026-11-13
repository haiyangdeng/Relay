import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  defaultPacScript,
  defaultSystemBypass,
  systemProxyReport,
  systemProxySettings,
  type SystemProxyReport,
  type SystemProxySettings,
  type NativeSystemProxySettings
} from '../../../shared/relay/system-proxy'
import { createSystemProxyService } from './service'

const settings: SystemProxySettings = {
  mode: 'pac',
  host: '127.0.0.1',
  port: 18191,
  socks: false,
  bypass: [...defaultSystemBypass],
  excludeSimple: true,
  serviceIDs: ['Wi-Fi'],
  pacScript: defaultPacScript
}
function fixture() {
  let current: SystemProxyReport = {
    status: 'inactive',
    revision: 'a'.repeat(64),
    location: 'Location-A',
    services: [
      {
        id: 'Wi-Fi',
        name: 'Wi-Fi',
        enabled: true,
        http: false,
        https: false,
        socks: false,
        pac: false
      }
    ],
    canApply: false,
    canRestore: false,
    currentPacURLHashes: [],
    currentProxyPorts: [],
    warnings: []
  }
  const close = vi.fn(async () => {}),
    pac = { url: 'http://127.0.0.1:18192/00000000-0000-0000-0000-000000000001.pac', close },
    adapters = {
      native: vi.fn(
        async (
          action: 'inspect' | 'prepare' | 'apply' | 'prepareRestore' | 'restore',
          _settings?: NativeSystemProxySettings,
          _revision?: string
        ): Promise<SystemProxyReport> => {
          if (action === 'prepare')
            return {
              ...structuredClone(current),
              canApply: ['inactive', 'active', 'applied'].includes(current.status)
            }
          if (action === 'apply')
            current = {
              ...current,
              status: 'applied',
              revision: 'b'.repeat(64),
              recordID: '00000000-0000-0000-0000-000000000001',
              canApply: false,
              canRestore: true
            }
          if (action === 'restore')
            current = {
              ...current,
              status: 'restored',
              revision: 'c'.repeat(64),
              recordID: undefined,
              canApply: false,
              canRestore: false
            }
          return structuredClone(current)
        }
      ),
      pac: vi.fn(async () => pac),
      confirm: vi.fn(async () => false),
      verifyTarget: vi.fn(async () => {}),
      notify: vi.fn(),
      now: vi.fn(() => 1)
    },
    service = createSystemProxyService(adapters)
  return {
    service,
    adapters,
    close,
    pac,
    set: (next: Partial<SystemProxyReport>) => {
      current = { ...current, ...next }
    },
    current: () => structuredClone(current)
  }
}
describe('Confirmed system proxy lifecycle with retained PAC and restoration evidence', () => {
  it('does not treat readable ports as proof that an uncertain transaction is settled', async () => {
    const f = fixture()
    f.set({
      status: 'uncertain',
      recordID: '00000000-0000-0000-0000-000000000001',
      canRestore: false,
      currentProxyPorts: [7890]
    })
    expect(await f.service.requestClose([18191])).toBe(false)
    expect(await f.service.verifyExternalProxyForQuit([18191])).toBe(false)
  })
  it('keeps a manually configured owned endpoint alive even without a transaction record', async () => {
    const f = fixture()
    f.set({ currentProxyPorts: [18191] })
    expect(await f.service.requestClose([18191])).toBe(false)
    expect(await f.service.verifyExternalProxyForQuit([18191])).toBe(false)
    f.set({ currentProxyPorts: [7890] })
    expect(await f.service.requestClose([18191])).toBe(true)
    f.set({ currentProxyPorts: [18191] })
    expect(await f.service.verifyExternalProxyForQuit([18191])).toBe(false)
  })
  it('does not infer safe shutdown from missing endpoint evidence or a no-op restoration', async () => {
    const f = fixture()
    f.set({ currentProxyPorts: undefined })
    expect(await f.service.requestClose([18191])).toBe(false)
    f.adapters.confirm.mockResolvedValue(true)
    const plan = await f.service.prepare({ ...settings, mode: 'manual' })
    await f.service.execute({ evidenceId: plan.evidenceId })
    f.set({ currentProxyPorts: [18191] })
    expect(await f.service.requestClose([18191])).toBe(false)
    expect(f.service.state().report?.recordID).toBeUndefined()
    f.set({ currentProxyPorts: [] })
    expect(await f.service.requestClose([18191])).toBe(true)
  })

  it.each(['copied', 'alias', 'unreadable'] as const)(
    'retains a %s PAC dependency after restoring its selected service, then permits a fresh retry',
    async (dependency) => {
      const f = fixture()
      f.adapters.confirm.mockResolvedValue(true)
      const plan = await f.service.prepare(settings)
      expect((await f.service.execute({ evidenceId: plan.evidenceId })).status).toBe('applied')
      f.set({
        currentProxyPorts: dependency === 'alias' ? [18192] : [],
        currentPacURLHashes:
          dependency === 'copied'
            ? [createHash('sha256').update(f.pac.url).digest('hex')]
            : dependency === 'alias'
              ? [
                  createHash('sha256')
                    .update(f.pac.url.replace('127.0.0.1', 'localhost'))
                    .digest('hex')
                ]
              : undefined
      })
      const restore = await f.service.prepareRestore()
      expect((await f.service.execute({ evidenceId: restore.evidenceId })).status).toBe('uncertain')
      expect(f.close).not.toHaveBeenCalled()
      expect(f.service.state().pacServersRetained).toBe(1)
      expect(await f.service.requestClose([18191])).toBe(false)
      await expect(f.service.inspect()).rejects.toThrow('系统代理状态未确认')
      expect(f.close).not.toHaveBeenCalled()
      // External settings now remove the copied reference. A later explicit
      // quit can release the very same server without an obsolete record.
      f.set({ currentPacURLHashes: [], currentProxyPorts: [] })
      expect(await f.service.requestClose([18191])).toBe(true)
      expect(f.close).toHaveBeenCalledOnce()
      expect(f.service.isBlocking()).toBe(false)
    }
  )
  it('does not block a manual listener on an unrelated third-party PAC URL', async () => {
    const f = fixture()
    f.set({ currentProxyPorts: [], currentPacURLHashes: ['d'.repeat(64)] })
    expect(await f.service.requestClose([18191])).toBe(true)
    expect(await f.service.verifyExternalProxyForQuit([18191])).toBe(true)
  })
  it('rejects malformed or duplicated PAC dependency digests', () => {
    const f = fixture()
    for (const hashes of [['url'], ['a'.repeat(64), 'a'.repeat(64)], [1234]])
      expect(() => systemProxyReport({ ...f.current(), currentPacURLHashes: hashes })).toThrow()
  })

  it('does no constructor IO, rejects injected native paths/settings, and cancels without submission', async () => {
    const f = fixture()
    expect(f.adapters.native).not.toHaveBeenCalled()
    await expect(
      f.service.prepare({ ...settings, pacURL: 'http://remote.invalid' })
    ).rejects.toThrow('参数')
    const plan = await f.service.prepare(settings)
    expect(f.adapters.native).toHaveBeenCalledWith(
      'prepare',
      expect.objectContaining({ pacURL: f.pac.url })
    )
    expect(f.adapters.native.mock.calls[0]?.[1]).not.toHaveProperty('pacScript')
    expect((await f.service.execute({ evidenceId: plan.evidenceId })).status).toBe('cancelled')
    expect(f.adapters.native.mock.calls.map((call) => call[0])).toEqual(['prepare'])
    expect(f.close).toHaveBeenCalledOnce()
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('重新准备')
  })
  it('rechecks target and revision after consent and retains the live PAC until confirmed original restoration', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    const plan = await f.service.prepare(settings)
    expect((await f.service.execute({ evidenceId: plan.evidenceId })).status).toBe('applied')
    expect(f.adapters.verifyTarget).toHaveBeenCalledTimes(2)
    expect(f.adapters.native).toHaveBeenLastCalledWith(
      'apply',
      expect.objectContaining({ pacURL: f.pac.url }),
      'a'.repeat(64)
    )
    expect(f.close).not.toHaveBeenCalled()
    expect(f.service.isBlocking()).toBe(true)
    f.adapters.confirm.mockResolvedValue(false)
    expect(await f.service.requestClose()).toBe(false)
    expect(f.close).not.toHaveBeenCalled()
    f.adapters.confirm.mockResolvedValue(true)
    expect(await f.service.requestClose()).toBe(true)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.service.isBlocking()).toBe(false)
  })
  it.each(['manual', 'pac'] as const)(
    'keeps the old active PAC after a %s candidate rolls back',
    async (mode) => {
      const f = fixture()
      f.adapters.confirm.mockResolvedValue(true)
      const original = await f.service.prepare(settings)
      await f.service.execute({ evidenceId: original.evidenceId })
      f.set({
        currentPacURLHashes: [createHash('sha256').update(f.pac.url).digest('hex')],
        currentProxyPorts: [18192]
      })
      const candidate = {
        url: f.pac.url.replace(':18192/', ':18193/'),
        close: vi.fn(async () => {})
      }
      f.adapters.pac.mockResolvedValue(candidate)
      const native = f.adapters.native.getMockImplementation()
      if (!native) throw new Error('Missing native fixture')
      f.adapters.native.mockImplementation(async (...args) =>
        args[0] === 'apply' ? { ...f.current(), status: 'rolledBack' } : native(...args)
      )
      const plan = await f.service.prepare({ ...settings, mode })
      expect((await f.service.execute({ evidenceId: plan.evidenceId })).status).toBe('rolledBack')
      expect(f.close).not.toHaveBeenCalled()
      expect(candidate.close).toHaveBeenCalledTimes(mode === 'pac' ? 1 : 0)
      expect(f.service.state().pacServersRetained).toBe(1)
    }
  )
  it('does not overwrite changed state or submit a proof invalidated by sleep during confirmation', async () => {
    for (const change of ['revision', 'sleep'] as const) {
      const f = fixture(),
        plan = await f.service.prepare(settings)
      f.adapters.confirm.mockImplementation(async () => {
        if (change === 'revision') f.set({ revision: 'd'.repeat(64) })
        else f.service.clear()
        return true
      })
      expect((await f.service.execute({ evidenceId: plan.evidenceId })).status).toBe('failed')
      expect(f.adapters.native.mock.calls.some((call) => call[0] === 'apply')).toBe(false)
      expect(f.close).toHaveBeenCalledOnce()
    }
  })
  it('keeps the PAC, quit barrier and record uncertainty after a lost apply acknowledgement, without replay', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    const realNative = f.adapters.native.getMockImplementation()
    if (!realNative) throw new Error('Missing fixture native adapter')
    f.adapters.native.mockImplementation(async (...args) => {
      const result = await realNative(...args)
      if (args[0] === 'apply') throw new Error('lost ack')
      return result
    })
    const plan = await f.service.prepare(settings)
    expect((await f.service.execute({ evidenceId: plan.evidenceId })).status).toBe('uncertain')
    expect(f.service.state().pacServersRetained).toBe(1)
    expect(f.close).not.toHaveBeenCalled()
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow()
    expect(await f.service.requestClose()).toBe(true)
    expect(f.adapters.native.mock.calls.filter((call) => call[0] === 'apply')).toHaveLength(1)
  })
  it('preserves an externally modified proxy and refuses quit rather than destroying its potentially referenced PAC', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    const plan = await f.service.prepare(settings)
    await f.service.execute({ evidenceId: plan.evidenceId })
    f.set({ status: 'conflict', revision: 'e'.repeat(64), canRestore: false })
    expect(await f.service.requestClose()).toBe(false)
    expect(f.close).not.toHaveBeenCalled()
    expect(f.adapters.native.mock.calls.some((call) => call[0] === 'restore')).toBe(false)
  })
  it('lets an idle Relay quit after proving an external proxy without restoring the saved record', async () => {
    const f = fixture()
    f.set({
      status: 'conflict',
      recordID: '00000000-0000-0000-0000-000000000001',
      quitProxyPorts: [7890]
    })
    const before = f.current()
    expect(await f.service.requestClose()).toBe(false)
    expect(await f.service.requestClose([7890])).toBe(false)
    expect(await f.service.requestClose([18191])).toBe(true)
    expect(f.service.isBlocking()).toBe(true)
    expect(f.current()).toEqual(before)
    expect(f.adapters.native.mock.calls.map(([action]) => action)).toEqual([
      'inspect',
      'inspect',
      'inspect'
    ])
    expect(f.adapters.confirm).not.toHaveBeenCalled()
  })
  it('keeps the quit gate when an external proxy is unverified or Relay retains a PAC', async () => {
    const f = fixture()
    f.set({
      status: 'conflict',
      recordID: '00000000-0000-0000-0000-000000000001'
    })
    expect(await f.service.requestClose([])).toBe(false)
    const withPAC = fixture()
    withPAC.adapters.confirm.mockResolvedValue(true)
    const plan = await withPAC.service.prepare(settings)
    expect((await withPAC.service.execute({ evidenceId: plan.evidenceId })).status).toBe('applied')
    withPAC.set({ status: 'conflict', canRestore: false, quitProxyPorts: [7890] })
    expect(await withPAC.service.requestClose([])).toBe(false)
    expect(withPAC.close).not.toHaveBeenCalled()
    expect(withPAC.adapters.native.mock.calls.some(([action]) => action === 'restore')).toBe(false)
  })
  it('keeps a native operation dispatched before sleep uncertain until a fresh read, without discarding the live PAC', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    const realNative = f.adapters.native.getMockImplementation()
    if (!realNative) throw new Error('Missing fixture native adapter')
    f.adapters.native.mockImplementation(async (...args) => {
      const result = await realNative(...args)
      if (args[0] === 'apply') f.service.clear()
      return result
    })
    const plan = await f.service.prepare(settings)
    expect((await f.service.execute({ evidenceId: plan.evidenceId })).status).toBe('uncertain')
    expect(f.service.state().report?.status).toBe('uncertain')
    expect(f.close).not.toHaveBeenCalled()
    expect((await f.service.inspect()).status).toBe('applied')
    expect(f.close).not.toHaveBeenCalled()
  })
  it('expires single-use plans and ignores stale cancel messages for a newer plan', async () => {
    const f = fixture(),
      old = await f.service.prepare(settings),
      next = await f.service.prepare({ ...settings, mode: 'manual' })
    f.service.cancel({ evidenceId: old.evidenceId })
    f.adapters.now.mockReturnValue(60002)
    await expect(f.service.execute({ evidenceId: next.evidenceId })).rejects.toThrow('重新准备')
    expect(f.adapters.confirm).not.toHaveBeenCalled()
    f.service.cancel({ evidenceId: next.evidenceId })
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('does not destroy the PAC or unblock quit when a previously held restoration record disappears', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    const plan = await f.service.prepare(settings)
    await f.service.execute({ evidenceId: plan.evidenceId })
    f.set({ status: 'inactive', recordID: undefined, canRestore: false })
    await expect(f.service.inspect()).rejects.toThrow('未确认')
    expect(await f.service.requestClose()).toBe(false)
    expect(f.close).not.toHaveBeenCalled()
    expect(f.service.isBlocking()).toBe(true)
  })
  it('serializes submissions and waits for pending work before the quit recheck', async () => {
    const f = fixture(),
      plan = await f.service.prepare(settings)
    let answer: ((value: boolean) => void) | undefined
    f.adapters.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const applying = f.service.execute({ evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(f.adapters.confirm).toHaveBeenCalledOnce())
    const quitting = f.service.requestClose()
    await expect(f.service.inspect()).rejects.toThrow('结束')
    answer?.(false)
    expect((await applying).status).toBe('cancelled')
    expect(await quitting).toBe(true)
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('rejects malformed native reports and impossible restore status', () => {
    const f = fixture()
    for (const raw of [
      { ...f.current(), canRestore: true },
      { ...f.current(), canRetireDetached: true },
      { ...f.current(), quitProxyPorts: [7890] },
      { ...f.current(), path: '/private' },
      { ...f.current(), services: [{ id: 'A' }] }
    ])
      expect(() => systemProxyReport(raw)).toThrow()
    expect(
      systemProxyReport({
        ...f.current(),
        status: 'active',
        recordID: '00000000-0000-0000-0000-000000000001',
        canRestore: true,
        canRetireDetached: true
      })
    ).toMatchObject({ canRetireDetached: true })
    expect(systemProxySettings({ ...settings, host: '::1' }).host).toBe('::1')
    expect(() => systemProxySettings({ ...settings, host: '127.0.0.1;command' })).toThrow()
  })
})
