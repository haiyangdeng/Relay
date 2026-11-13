import { describe, expect, it, vi } from 'vitest'
import { createLoginItemService } from './login-item'

function fixture() {
  let enabled = false
  const adapters = {
    identity: vi.fn(() => ({
      supported: true,
      executable: '/Applications/Relay.app/Contents/MacOS/Relay'
    })),
    read: vi.fn(() => ({ openAtLogin: enabled })),
    write: vi.fn((next: boolean) => {
      enabled = next
    }),
    confirm: vi.fn(async () => false),
    assertIdle: vi.fn(),
    now: vi.fn(() => 1000)
  }
  return { adapters, service: createLoginItemService(adapters) }
}

describe('Current-app macOS login item', () => {
  it('is inert until explicitly read and does not treat silent-start preferences as login permission', () => {
    const { adapters, service } = fixture()
    expect(adapters.read).not.toHaveBeenCalled()
    expect(adapters.write).not.toHaveBeenCalled()
    expect(service.read()).toBe(false)
    expect(adapters.write).not.toHaveBeenCalled()
  })
  it('refuses development and unsupported hosts without touching the OS', async () => {
    const { adapters, service } = fixture()
    adapters.identity.mockReturnValue({ supported: false, executable: '/Electron' })
    expect(() => service.read()).toThrow('已打包')
    await expect(service.set(true)).rejects.toThrow('已打包')
    expect(adapters.read).not.toHaveBeenCalled()
    expect(adapters.write).not.toHaveBeenCalled()
  })
  it('preserves the observed setting when native confirmation is cancelled', async () => {
    const { adapters, service } = fixture()
    expect(await service.set(true)).toMatchObject({ status: 'cancelled', openAtLogin: false })
    expect(adapters.write).not.toHaveBeenCalled()
  })
  it('confirms enable and disable separately, verifies each write and avoids no-op confirmations', async () => {
    const { adapters, service } = fixture()
    adapters.confirm.mockResolvedValue(true)
    expect(await service.set(true)).toMatchObject({ status: 'applied', openAtLogin: true })
    expect(await service.set(true)).toMatchObject({ status: 'unchanged' })
    expect(await service.set(false)).toMatchObject({ status: 'applied', openAtLogin: false })
    expect(adapters.confirm.mock.calls).toEqual([[true], [false]])
    expect(adapters.write.mock.calls).toEqual([[true], [false]])
  })
  it('rejects external changes during confirmation rather than overwriting them', async () => {
    const { adapters, service } = fixture()
    adapters.confirm.mockImplementationOnce(async () => {
      adapters.read.mockReturnValue({ openAtLogin: true })
      return true
    })
    await expect(service.set(true)).rejects.toThrow('其他操作')
    expect(adapters.write).not.toHaveBeenCalled()
    expect(service.isBusy()).toBe(false)
  })
  it.each(['identity', 'expired', 'clock', 'quitting'] as const)(
    'rechecks %s after native confirmation',
    async (reason) => {
      const { adapters, service } = fixture()
      adapters.confirm.mockImplementationOnce(async () => {
        if (reason === 'identity')
          adapters.identity.mockReturnValue({ supported: true, executable: '/Other.app' })
        if (reason === 'expired') adapters.now.mockReturnValue(61001)
        if (reason === 'clock') adapters.now.mockReturnValue(999)
        if (reason === 'quitting')
          adapters.assertIdle.mockImplementation(() => {
            throw new Error('quitting')
          })
        return true
      })
      await expect(service.set(true)).rejects.toThrow()
      expect(adapters.write).not.toHaveBeenCalled()
    }
  )
  it('reports OS approval or unchanged readback as uncertain and never retries', async () => {
    const { adapters, service } = fixture()
    adapters.confirm.mockResolvedValue(true)
    adapters.write.mockImplementation(() => undefined)
    expect(await service.set(true)).toMatchObject({ status: 'uncertain', openAtLogin: false })
    expect(adapters.write).toHaveBeenCalledOnce()
  })
  it('confirms a lost setter acknowledgement only through readback', async () => {
    const { adapters, service } = fixture()
    adapters.confirm.mockResolvedValue(true)
    adapters.write.mockImplementation(() => {
      adapters.read.mockReturnValue({ openAtLogin: true })
      throw new Error('lost acknowledgement')
    })
    expect(await service.set(true)).toMatchObject({ status: 'applied', openAtLogin: true })
    expect(adapters.write).toHaveBeenCalledOnce()
  })
  it('preserves unknown readback instead of claiming success or false', async () => {
    const { adapters, service } = fixture()
    adapters.confirm.mockResolvedValue(true)
    adapters.write.mockImplementation(() => {
      adapters.read.mockImplementation(() => {
        throw new Error('unavailable')
      })
    })
    const result = await service.set(true)
    expect(result.status).toBe('uncertain')
    expect(result.openAtLogin).toBeUndefined()
  })
  it('serializes confirmation and releases exit waiters on rejection', async () => {
    const { adapters, service } = fixture()
    let reject!: (error: Error) => void
    adapters.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, failure) => {
          reject = failure
        })
    )
    const operation = service.set(true),
      caught = expect(operation).rejects.toThrow('dialog')
    const idle = vi.fn()
    void service.whenIdle().then(idle)
    await expect(service.set(false)).rejects.toThrow('尚未结束')
    expect(() => service.read()).toThrow('尚未结束')
    expect(idle).not.toHaveBeenCalled()
    reject(new Error('dialog'))
    await caught
    await service.whenIdle()
    expect(idle).toHaveBeenCalledOnce()
    expect(service.isBusy()).toBe(false)
  })
})
