import { describe, expect, it, vi } from 'vitest'
import type { RelayDesktopResponse } from '../../shared/relay/desktop'
import { createDesktopService } from './desktop'
import { desktopResponse } from './__fixtures__/desktop-session'

function fixture() {
  let gone = false,
    lost: () => void = () => {}
  const request = vi.fn(async (action: string) =>
    desktopResponse(2, action === 'start' ? 'active' : 'idle', action === 'close')
  )
  const worker = { ready: Promise.resolve(desktopResponse()), request, gone: () => gone }
  const confirm = vi.fn(async () => true)
  const open = vi.fn((callback: () => void) => {
    lost = callback
    return worker
  })
  return {
    service: createDesktopService({ open, confirm }),
    request,
    open,
    confirm,
    worker,
    lose: () => {
      gone = true
      lost()
    }
  }
}
describe('Desktop session service', () => {
  it('does not create a worker on read, normal quit or cancelled confirmation', async () => {
    const f = fixture()
    f.confirm.mockResolvedValue(false)
    expect(f.service.state().host).toBe('absent')
    expect(await f.service.requestClose()).toBe(true)
    expect((await f.service.action({ action: 'start' })).status).toBe('cancelled')
    expect(f.open).not.toHaveBeenCalled()
    expect(f.service.isBlocking()).toBe(false)
  })
  it('starts once, blocks duplicate actions, and finishes through restore then close', async () => {
    const f = fixture()
    expect((await f.service.action({ action: 'start' })).state.snapshot?.phase).toBe('active')
    expect(f.service.isBlocking()).toBe(true)
    await expect(f.service.action({ action: 'start' })).rejects.toThrow('先完成')
    const result = await f.service.action({ action: 'finish' })
    expect(result.state.host).toBe('absent')
    expect(f.request.mock.calls.map(([action]) => action)).toEqual(['start', 'restore', 'close'])
    expect(f.confirm).toHaveBeenCalledTimes(1)
  })
  it('requires separate confirmation for discovered records, including after attempted close', async () => {
    const f = fixture(),
      pending = desktopResponse(2, 'recoveryNeeded')
    pending.snapshot.requiresRecoveryConsent = true
    f.request.mockResolvedValueOnce(pending)
    await f.service.action({ action: 'start' })
    expect(await f.service.requestClose()).toBe(false)
    await expect(f.service.action({ action: 'cancel' })).rejects.toThrow('单独确认')
    f.confirm.mockResolvedValue(false)
    expect((await f.service.action({ action: 'restore' })).status).toBe('cancelled')
    expect(f.request).toHaveBeenCalledTimes(1)
    f.confirm.mockResolvedValue(true)
    expect((await f.service.action({ action: 'restore' })).state.host).toBe('absent')
    expect(f.confirm.mock.calls).toEqual([['start'], ['restore'], ['restore']])
  })
  it('aborts confirmation on quit without spawning or changing defaults', async () => {
    const f = fixture()
    let answer!: (value: boolean) => void
    f.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const start = f.service.action({ action: 'start' }),
      close = f.service.requestClose()
    answer(true)
    expect((await start).status).toBe('cancelled')
    expect(await close).toBe(true)
    expect(f.open).not.toHaveBeenCalled()
  })
  it('keeps failed close blocking and allows an explicitly confirmed retry', async () => {
    const f = fixture()
    await f.service.action({ action: 'start' })
    f.request.mockResolvedValueOnce(desktopResponse(3, 'recoveryNeeded'))
    expect(await f.service.requestClose()).toBe(false)
    expect(f.service.isBlocking()).toBe(true)
    expect((await f.service.action({ action: 'restore' })).state.host).toBe('absent')
  })
  it('marks an exited worker unknown, never restarts start automatically, and recovers only on confirmation', async () => {
    const f = fixture()
    await f.service.action({ action: 'start' })
    f.lose()
    expect(f.service.state().uncertain).toBe(true)
    await expect(f.service.action({ action: 'start' })).rejects.toThrow()
    f.confirm.mockResolvedValue(false)
    await f.service.action({ action: 'restore' })
    expect(f.open).toHaveBeenCalledTimes(1)
    f.confirm.mockResolvedValue(true)
    expect((await f.service.action({ action: 'restore' })).status).toBe('completed')
    expect(f.open).toHaveBeenCalledTimes(2)
  })
  it('does not let an older pending action overwrite a successful close acknowledgment', async () => {
    const f = fixture()
    let resolve!: (value: RelayDesktopResponse) => void
    f.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const start = f.service.action({ action: 'start' })
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('start'))
    expect(await f.service.requestClose()).toBe(true)
    resolve(desktopResponse(2, 'active'))
    await start
    expect(f.service.state().host).toBe('absent')
    expect(f.service.state().snapshot?.phase).toBe('idle')
    expect(f.service.isBlocking()).toBe(false)
  })
  it('does not send start after quit closes a worker whose initialization was pending', async () => {
    const f = fixture()
    let ready!: (value: RelayDesktopResponse) => void
    f.worker.ready = new Promise((resolve) => {
      ready = resolve
    })
    const start = f.service.action({ action: 'start' })
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(1))
    expect(await f.service.requestClose()).toBe(true)
    ready(desktopResponse())
    expect((await start).status).toBe('cancelled')
    expect(f.request.mock.calls.map(([action]) => action)).toEqual(['close'])
  })
  it('does not dispatch start while quit is waiting for the initialized worker to close', async () => {
    const f = fixture(),
      initialized = Promise.withResolvers<RelayDesktopResponse>(),
      closing = Promise.withResolvers<RelayDesktopResponse>()
    f.worker.ready = initialized.promise
    f.request.mockImplementation((action) =>
      action === 'close' ? closing.promise : Promise.resolve(desktopResponse(3, 'active'))
    )
    const start = f.service.action({ action: 'start' })
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(1))
    const close = f.service.requestClose()
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('close'))
    initialized.resolve(desktopResponse())
    expect(await start).toMatchObject({ status: 'cancelled', state: { pending: true } })
    expect(f.request.mock.calls.map(([action]) => action)).toEqual(['close'])
    expect(f.service.isBlocking()).toBe(true)
    closing.resolve(desktopResponse(2, 'idle', true))
    expect(await close).toBe(true)
    expect(f.service.isBlocking()).toBe(false)
  })
})
