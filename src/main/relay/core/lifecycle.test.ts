import { describe, expect, it, vi } from 'vitest'
import type { OwnedCoreObservation } from '../../../shared/relay/lifecycle'
import { createCoreLifecycle } from './lifecycle'

function fixture() {
  const adapters = {
    invalidate: vi.fn(),
    pauseScheduling: vi.fn(async () => {}),
    resumeScheduling: vi.fn(),
    observeCore: vi.fn(async (): Promise<OwnedCoreObservation> => 'none'),
    observeProxy: vi.fn(async (): Promise<OwnedCoreObservation> => 'running'),
    notify: vi.fn()
  }
  return { adapters, manager: createCoreLifecycle(adapters) }
}
describe('Owned power lifecycle with observation-only resume', () => {
  it('pauses live scheduling before a manual failed recheck instead of merely reporting it paused', async () => {
    const f = fixture()
    f.adapters.observeProxy.mockImplementationOnce(async () => {
      expect(f.adapters.pauseScheduling).toHaveBeenCalledOnce()
      return 'unexpectedExit'
    })
    await f.manager.recheck()
    expect(f.manager.state().phase).toBe('attention')
    expect(f.adapters.resumeScheduling).not.toHaveBeenCalled()
  })
  it('allows an explicit fresh recheck after attention without replaying or restarting a core', async () => {
    const f = fixture()
    f.adapters.observeProxy.mockResolvedValueOnce('unconfirmed')
    await f.manager.suspend()
    await f.manager.resume()
    expect(f.manager.state().phase).toBe('attention')
    expect(f.adapters.resumeScheduling).not.toHaveBeenCalled()
    await f.manager.recheck()
    expect(f.manager.state()).toMatchObject({
      phase: 'awake',
      observed: true,
      localProxy: 'running',
      automaticRestartEnabled: false
    })
    expect(f.adapters.resumeScheduling).toHaveBeenCalledOnce()
  })
  it('performs no startup IO and resumes only after paused scheduling and private observations complete', async () => {
    const f = fixture()
    expect(f.adapters.observeCore).not.toHaveBeenCalled()
    expect(f.adapters.pauseScheduling).not.toHaveBeenCalled()
    await f.manager.suspend()
    expect(f.adapters.invalidate).toHaveBeenCalledOnce()
    expect(f.manager.state().phase).toBe('asleep')
    await f.manager.resume()
    expect(f.manager.state()).toMatchObject({
      phase: 'awake',
      localProxy: 'running',
      core: 'none',
      automaticRestartEnabled: false
    })
    expect(f.adapters.observeCore).toHaveBeenCalledOnce()
    expect(f.adapters.observeProxy).toHaveBeenCalledOnce()
    expect(f.adapters.resumeScheduling).toHaveBeenCalledOnce()
  })
  it.each(['unexpectedExit', 'unconfirmed'] as const)(
    'keeps scheduling paused for %s without changing core ownership or restarting',
    async (status) => {
      const f = fixture()
      f.adapters.observeProxy.mockResolvedValue(status)
      await f.manager.suspend()
      await f.manager.resume()
      expect(f.manager.state()).toMatchObject({
        phase: 'attention',
        localProxy: status,
        automaticRestartEnabled: false
      })
      expect(f.adapters.resumeScheduling).not.toHaveBeenCalled()
    }
  )
  it('drops a previous wake observation after a newer sleep and does not restart scheduling', async () => {
    const f = fixture()
    let observed: (value: OwnedCoreObservation) => void = () => {}
    f.adapters.observeProxy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          observed = resolve
        })
    )
    await f.manager.suspend()
    const waking = f.manager.resume()
    await vi.waitFor(() => expect(f.adapters.observeProxy).toHaveBeenCalledOnce())
    const sleeping = f.manager.suspend()
    observed('running')
    await waking
    await sleeping
    expect(f.manager.state().phase).toBe('asleep')
    expect(f.adapters.resumeScheduling).not.toHaveBeenCalled()
    await f.manager.resume()
    expect(f.manager.state().phase).toBe('awake')
    expect(f.adapters.resumeScheduling).toHaveBeenCalledOnce()
  })
  it('serializes duplicate notifications, handles failed private reads, and cannot revive work after close', async () => {
    const f = fixture()
    f.adapters.observeCore.mockRejectedValue(new Error('private API unavailable'))
    await f.manager.suspend()
    await Promise.all([f.manager.resume(), f.manager.resume()])
    expect(f.adapters.observeProxy).toHaveBeenCalledOnce()
    expect(f.manager.state().core).toBe('unconfirmed')
    await f.manager.close()
    await f.manager.suspend()
    await f.manager.resume()
    expect(f.adapters.observeCore).toHaveBeenCalledOnce()
    expect(f.adapters.resumeScheduling).not.toHaveBeenCalled()
  })
})

describe('Cancelled final quit resumes observation without renewing scheduling', () => {
  it('allows a fresh explicit recheck after close without auto observing, restarting or scheduling', async () => {
    const f = fixture()
    await f.manager.recheck()
    await f.manager.close()
    f.adapters.observeCore.mockClear()
    f.adapters.observeProxy.mockClear()
    f.adapters.resumeScheduling.mockClear()
    f.manager.cancelClose()
    expect(f.manager.state().observed).toBe(false)
    expect(f.adapters.observeCore).not.toHaveBeenCalled()
    expect(f.adapters.resumeScheduling).not.toHaveBeenCalled()
    await f.manager.recheck()
    expect(f.adapters.observeCore).toHaveBeenCalledOnce()
    expect(f.adapters.observeProxy).toHaveBeenCalledOnce()
    expect(f.manager.state().observed).toBe(true)
  })
})

it('does not leave a cancelled close stuck in the checking state', async () => {
  const f = fixture()
  let finish: (value: OwnedCoreObservation) => void = () => {
    throw new Error('barrier not started')
  }
  f.adapters.observeCore.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const checking = f.manager.recheck()
  await vi.waitFor(() => expect(f.adapters.observeCore).toHaveBeenCalledOnce())
  const closing = f.manager.close()
  finish('none')
  await Promise.all([checking, closing])
  f.manager.cancelClose()
  expect(f.manager.state()).toMatchObject({ phase: 'attention', observed: false })
  await f.manager.recheck()
  expect(f.manager.state()).toMatchObject({ phase: 'awake', observed: true })
})
