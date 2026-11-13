import { describe, expect, it, vi } from 'vitest'
import {
  defaultShellSettings,
  type RelayShellRecord,
  type RelayShellSettings
} from '../../../shared/relay/shell'
import { createRelayShellService, type RelayShellHost } from './service'

function fixture() {
  let record: RelayShellRecord = {
    settings: defaultShellSettings(),
    revision: 'initial',
    exists: true
  }
  record.settings.shortcuts.showWindow = 'Command+R'
  const callbacks = new Map<string, () => void>()
  const host: RelayShellHost = {
    ensureTray: vi.fn(),
    registerShortcut: vi.fn((accelerator, callback) => {
      callbacks.set(accelerator, callback)
      return true
    }),
    unregisterShortcut: vi.fn((accelerator) => {
      callbacks.delete(accelerator)
    }),
    apply: vi.fn(async () => {}),
    perform: vi.fn(async () => {}),
    showWindow: vi.fn(),
    dispose: vi.fn()
  }
  const store = {
    read: vi.fn(async (): Promise<RelayShellRecord> => structuredClone(record)),
    save: vi.fn(async (settings: RelayShellSettings): Promise<RelayShellRecord> => {
      record = { settings: structuredClone(settings), revision: 'saved', exists: true }
      return structuredClone(record)
    })
  }
  const pickCSS = vi.fn(async (): Promise<string | undefined> => undefined)
  const service = createRelayShellService({ store, host, pickCSS })
  return { service, store, host, callbacks, pickCSS }
}

describe('Independent desktop workflow transactions', () => {
  it('does no startup work until initialized and preserves startup intent separately from live apply', async () => {
    const f = fixture()
    expect(f.host.ensureTray).not.toHaveBeenCalled()
    expect(f.store.read).not.toHaveBeenCalled()
    const state = await f.service.initialize(true)
    expect(f.host.apply).toHaveBeenCalledWith(state.settings, true)
    expect(state.initialized).toBe(true)
    expect(state.pending).toBe(false)
    expect(f.store.save).not.toHaveBeenCalled()
  })
  it('retains the original shortcut when the new shortcut is occupied', async () => {
    const f = fixture()
    await f.service.initialize()
    vi.mocked(f.host.registerShortcut).mockReturnValueOnce(false)
    const next = {
      ...f.service.state().settings,
      shortcuts: { ...f.service.state().settings.shortcuts, showWindow: 'Command+N' }
    }
    await expect(f.service.save(next, 'initial')).rejects.toThrow('占用')
    expect(f.callbacks.has('Command+R')).toBe(true)
    expect(f.host.unregisterShortcut).not.toHaveBeenCalledWith('Command+R')
    expect(f.store.save).not.toHaveBeenCalled()
  })
  it('reuses an accelerator when reassigned without unregistering another action prematurely', async () => {
    const f = fixture()
    await f.service.initialize()
    const next = f.service.state().settings
    next.shortcuts.showWindow = ''
    next.shortcuts.showFloatingWindow = 'Command+R'
    expect((await f.service.save(next, 'initial')).pending).toBe(false)
    f.callbacks.get('Command+R')?.()
    await vi.waitFor(() => expect(f.host.perform).toHaveBeenCalledWith('showFloatingWindow'))
    expect(f.host.registerShortcut).toHaveBeenCalledTimes(1)
    expect(f.host.unregisterShortcut).not.toHaveBeenCalled()
  })
  it('restores live settings and added bindings when host application fails', async () => {
    const f = fixture()
    await f.service.initialize()
    const next = f.service.state().settings
    next.appTheme = 'dark'
    next.shortcuts.showWindow = 'Command+N'
    vi.mocked(f.host.apply).mockRejectedValueOnce(new Error('window failed'))
    await expect(f.service.save(next, 'initial')).rejects.toThrow('window failed')
    expect(f.callbacks.has('Command+R')).toBe(true)
    expect(f.callbacks.has('Command+N')).toBe(false)
    expect(f.service.state().settings.appTheme).toBe('system')
    expect(f.service.state().uncertain).toBe(false)
    expect(f.store.save).not.toHaveBeenCalled()
  })
  it('rereads a lost save acknowledgement and confirms the committed preferences', async () => {
    const f = fixture()
    await f.service.initialize()
    const next = { ...f.service.state().settings, appTheme: 'dark' as const }
    f.store.save.mockImplementationOnce(async (settings) => {
      f.store.read.mockResolvedValue({
        settings: structuredClone(settings),
        revision: 'committed',
        exists: true
      })
      throw new Error('lost acknowledgement')
    })
    expect((await f.service.save(next, 'initial')).revision).toBe('committed')
    expect(f.service.state().settings.appTheme).toBe('dark')
    expect(f.service.state().uncertain).toBe(false)
  })
  it('keeps a visible recovery entry and blocks actions after rollback cannot be confirmed', async () => {
    const f = fixture()
    await f.service.initialize()
    f.store.save.mockRejectedValueOnce(new Error('write failed'))
    vi.mocked(f.host.apply)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('rollback failed'))
    await expect(
      f.service.save({ ...f.service.state().settings, appTheme: 'dark' }, 'initial')
    ).rejects.toThrow('write failed')
    expect(f.service.state().uncertain).toBe(true)
    expect(f.host.showWindow).toHaveBeenCalled()
    await expect(f.service.perform('showFloatingWindow')).rejects.toThrow('未就绪')
  })
  it('blocks concurrent updates and disposal while settings are being applied', async () => {
    const f = fixture()
    await f.service.initialize()
    let finish: (() => void) | undefined
    vi.mocked(f.host.apply).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const saving = f.service.save({ ...f.service.state().settings, appTheme: 'dark' }, 'initial')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    let idle = false
    const waiting = f.service.whenIdle().then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)
    await expect(f.service.save(defaultShellSettings(), 'initial')).rejects.toThrow()
    expect(() => f.service.dispose()).toThrow('等待')
    finish?.()
    await saving
    await waiting
    expect(idle).toBe(true)
    f.service.dispose()
    expect(f.host.unregisterShortcut).toHaveBeenCalledExactlyOnceWith('Command+R')
    expect(f.host.dispose).toHaveBeenCalledOnce()
  })
})

describe('CSS selection remains a draft and participates in close waiting', () => {
  it('keeps OS selection lazy and neither applies nor saves an imported stylesheet', async () => {
    const f = fixture()
    expect(f.pickCSS).not.toHaveBeenCalled()
    expect(await f.service.importCSS()).toBeUndefined()
    f.pickCSS.mockResolvedValueOnce('body{color:red}')
    expect(await f.service.importCSS()).toBe('body{color:red}')
    expect(f.store.save).not.toHaveBeenCalled()
    expect(f.host.apply).not.toHaveBeenCalled()
    f.pickCSS.mockResolvedValueOnce('a'.repeat(8193))
    await expect(f.service.importCSS()).rejects.toThrow('8KiB')
    expect(f.service.isBusy()).toBe(false)
  })
  it('holds the window settings mutex and releases waiters if file selection fails', async () => {
    const f = fixture()
    let reject!: (error: Error) => void
    f.pickCSS.mockImplementationOnce(
      () =>
        new Promise((_resolve, failed) => {
          reject = failed
        })
    )
    const selecting = f.service.importCSS(),
      failed = expect(selecting).rejects.toThrow('IO')
    const idle = vi.fn()
    void f.service.whenIdle().then(idle)
    await expect(f.service.initialize()).rejects.toThrow('尚未结束')
    expect(idle).not.toHaveBeenCalled()
    reject(new Error('IO'))
    await failed
    await f.service.whenIdle()
    expect(idle).toHaveBeenCalledOnce()
    expect(f.store.save).not.toHaveBeenCalled()
  })
})

describe('Shell actions hold the same close and settings wait gate', () => {
  it('holds whenIdle through a pending network confirmation and rejects overlapping writes/actions', async () => {
    const f = fixture()
    await f.service.initialize()
    let release!: () => void
    vi.mocked(f.host.perform).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const performing = f.service.perform('triggerTun')
    const idle = vi.fn()
    const waiting = f.service.whenIdle().then(idle)
    expect(f.service.isBusy()).toBe(true)
    expect(idle).not.toHaveBeenCalled()
    await expect(f.service.perform('directMode')).rejects.toThrow('未就绪')
    await expect(f.service.save(f.service.state().settings, 'initial')).rejects.toThrow()
    expect(() => f.service.dispose()).toThrow('等待')
    release()
    await performing
    await waiting
    expect(idle).toHaveBeenCalledOnce()
    expect(f.service.isBusy()).toBe(false)
    expect(f.host.perform).toHaveBeenCalledExactlyOnceWith('triggerTun')
  })
  it('releases close waiters on an action failure without making the settings uncertain', async () => {
    const f = fixture()
    await f.service.initialize()
    vi.mocked(f.host.perform).mockRejectedValueOnce(new Error('unconfirmed'))
    await expect(f.service.perform('triggerSysProxy')).rejects.toThrow('unconfirmed')
    await f.service.whenIdle()
    expect(f.service.isBusy()).toBe(false)
    expect(f.service.state().uncertain).toBe(false)
    await expect(f.service.perform('showWindow')).resolves.toBeUndefined()
  })
})
