import { describe, expect, it, vi } from 'vitest'
import { createRestartCoordinator, type RestartAdapters } from './restart-coordinator'
import type { RestartDrainPass } from './restart-intent'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup() {
  const startDrain = vi.fn<RestartAdapters['startDrain']>(),
    assertAvailable = vi.fn(),
    showWindow = vi.fn(),
    confirm = vi.fn(async () => true),
    relaunch = vi.fn(() => {
      expect(coordinator.state().phase).toBe('consumed')
    }),
    quit = vi.fn(() => {
      expect(coordinator.beforeQuit()).toBe('restart-final')
    })
  const coordinator = createRestartCoordinator({
    startDrain,
    assertAvailable,
    showWindow,
    confirm,
    quit,
    relaunch
  })
  const pass = (): RestartDrainPass => {
    const value = startDrain.mock.calls.at(-1)?.[0]
    if (!value) throw new Error('Fixture drain was not requested')
    return value
  }
  return { coordinator, startDrain, assertAvailable, showWindow, confirm, quit, relaunch, pass }
}
async function ready() {
  const f = setup()
  expect(await f.coordinator.request()).toBe('requested')
  const pass = f.pass()
  expect(f.coordinator.settleDrain(pass, 'confirmed')).toBe(true)
  return { ...f, readyPass: pass }
}

describe('Private Main restart coordinator with no lifecycle execution', () => {
  it('does not restart ordinary final quits or unarmed exits', () => {
    const f = setup()
    expect(f.coordinator.beforeQuit()).toBe('ordinary')
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    expect(f.relaunch).not.toHaveBeenCalled()
  })
  it('shows the current workspace before confirmation and clears a declined request', async () => {
    const f = setup()
    f.confirm.mockResolvedValue(false)
    expect(await f.coordinator.request()).toBe('cancelled')
    expect(f.showWindow.mock.invocationCallOrder[0]).toBeLessThan(
      f.confirm.mock.invocationCallOrder[0]
    )
    expect(f.coordinator.state().phase).toBe('idle')
    expect(f.startDrain).not.toHaveBeenCalled()
    expect(f.quit).not.toHaveBeenCalled()
    expect(f.relaunch).not.toHaveBeenCalled()
  })
  it('starts the full guarded drain even when Main has no active Core or dirty geometry', async () => {
    const f = setup()
    expect(await f.coordinator.request()).toBe('requested')
    expect(f.startDrain).toHaveBeenCalledOnce()
    expect(f.coordinator.state().phase).toBe('draining')
    expect(f.quit).not.toHaveBeenCalled()
    expect(f.relaunch).not.toHaveBeenCalled()
  })
  it('returns the shell action before a drain waits for that same shell operation to become idle', async () => {
    const f = setup(),
      shellIdle = deferred<void>()
    let drain: Promise<void> | undefined
    f.startDrain.mockImplementation((pass) => {
      drain = (async () => {
        await shellIdle.promise
        f.coordinator.settleDrain(pass, 'confirmed')
        f.coordinator.quitAfterDrain(pass)
      })()
    })
    // Models shellWorkflow.perform being pending until the adapter returns.
    expect(await f.coordinator.request()).toBe('requested')
    expect(f.quit).not.toHaveBeenCalled()
    shellIdle.resolve()
    await drain
    expect(f.quit).toHaveBeenCalledOnce()
    expect(f.relaunch).not.toHaveBeenCalled()
    expect(f.coordinator.onFinalQuit(0)).toBe('scheduled')
  })
  it('admits one confirmation and one drain across duplicate calls', async () => {
    const f = setup(),
      consent = deferred<boolean>()
    f.confirm.mockReturnValueOnce(consent.promise)
    const first = f.coordinator.request()
    expect(await f.coordinator.request()).toBe('busy')
    consent.resolve(true)
    expect(await first).toBe('requested')
    expect(await f.coordinator.request()).toBe('busy')
    f.coordinator.settleDrain(f.pass(), 'confirmed')
    expect(await f.coordinator.request()).toBe('busy')
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.startDrain).toHaveBeenCalledOnce()
  })
  it('rejects late approval after an ordinary external quit', async () => {
    const f = setup(),
      consent = deferred<boolean>()
    f.confirm.mockReturnValueOnce(consent.promise)
    const first = f.coordinator.request()
    expect(f.coordinator.beforeQuit()).toBe('ordinary')
    consent.resolve(true)
    expect(await first).toBe('cancelled')
    expect(f.startDrain).not.toHaveBeenCalled()
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
  })
  it('does not let an old rejected confirmation revoke a newer request', async () => {
    const f = setup(),
      consent = deferred<boolean>()
    f.confirm.mockReturnValueOnce(consent.promise)
    const first = f.coordinator.request()
    f.coordinator.ordinaryQuit()
    expect(await f.coordinator.request()).toBe('requested')
    const current = f.pass()
    consent.reject(new Error('old dialog failed'))
    await expect(first).rejects.toThrow('old dialog failed')
    expect(f.coordinator.settleDrain(current, 'confirmed')).toBe(true)
    expect(f.coordinator.quitAfterDrain(current)).toBe(true)
    expect(f.coordinator.onFinalQuit(0)).toBe('scheduled')
  })
  it('rechecks availability after consent before entering cleanup', async () => {
    const f = setup()
    f.assertAvailable
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('owner changed')
      })
    await expect(f.coordinator.request()).rejects.toThrow('owner changed')
    expect(f.startDrain).not.toHaveBeenCalled()
    expect(f.coordinator.state().phase).toBe('idle')
  })
  it('clears failed confirmation or drain dispatch without scheduling', async () => {
    for (const stage of ['confirm', 'startDrain'] as const) {
      const f = setup()
      if (stage === 'confirm') f.confirm.mockRejectedValueOnce(new Error(stage))
      else
        f.startDrain.mockImplementationOnce(() => {
          throw new Error(stage)
        })
      await expect(f.coordinator.request()).rejects.toThrow(stage)
      expect(f.coordinator.state().phase).toBe('idle')
      expect(f.relaunch).not.toHaveBeenCalled()
    }
  })
  it.each(['cancelled', 'failed'] as const)('clears a %s restoration pass', async (result) => {
    const f = setup()
    await f.coordinator.request()
    const pass = f.pass()
    expect(f.coordinator.settleDrain(pass, result)).toBe(true)
    expect(f.coordinator.settleDrain(pass, 'confirmed')).toBe(false)
    expect(f.coordinator.quitAfterDrain(pass)).toBe(false)
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    expect(f.relaunch).not.toHaveBeenCalled()
  })
  it('uses only the latest real drain pass and ignores stale success and failure', async () => {
    const f = await ready(),
      next = f.coordinator.beginDrain()
    if (!next) throw new Error('Missing later pass')
    expect(f.coordinator.settleDrain(f.readyPass, 'confirmed')).toBe(false)
    expect(f.coordinator.settleDrain(f.readyPass, 'failed')).toBe(false)
    expect(f.coordinator.quitAfterDrain(f.readyPass)).toBe(false)
    expect(f.coordinator.settleDrain(next, 'confirmed')).toBe(true)
    expect(f.coordinator.quitAfterDrain(next)).toBe(true)
    expect(f.coordinator.onFinalQuit(0)).toBe('scheduled')
  })
  it('does not consume ready intent without its own guarded final quit transition', async () => {
    const f = await ready()
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    expect(f.relaunch).not.toHaveBeenCalled()
  })
  it('schedules only at actual final quit, exactly once, after consuming intent', async () => {
    const f = await ready()
    expect(f.coordinator.quitAfterDrain(f.readyPass)).toBe(true)
    expect(f.coordinator.isFinalQuitInProgress()).toBe(true)
    expect(f.relaunch).not.toHaveBeenCalled()
    expect(f.coordinator.onFinalQuit(0)).toBe('scheduled')
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    expect(f.relaunch).toHaveBeenCalledOnce()
    expect(await f.coordinator.request()).toBe('busy')
  })
  it('revokes when app.quit has no synchronous before-quit callback', async () => {
    const f = await ready()
    f.quit.mockImplementationOnce(() => {})
    expect(f.coordinator.quitAfterDrain(f.readyPass)).toBe(false)
    expect(f.coordinator.state().phase).toBe('idle')
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
  })
  it('reports an observed transition even if final quit synchronously consumes intent', async () => {
    const f = await ready()
    f.quit.mockImplementationOnce(() => {
      expect(f.coordinator.beforeQuit()).toBe('restart-final')
      expect(f.coordinator.onFinalQuit(0)).toBe('scheduled')
    })
    expect(f.coordinator.quitAfterDrain(f.readyPass)).toBe(true)
    expect(f.coordinator.state().phase).toBe('consumed')
    expect(f.coordinator.quitAfterDrain(f.readyPass)).toBe(false)
    expect(f.quit).toHaveBeenCalledOnce()
    expect(f.relaunch).toHaveBeenCalledOnce()
  })
  it('reports an observed transition separately from later cancellation', async () => {
    const f = await ready()
    f.quit.mockImplementationOnce(() => {
      expect(f.coordinator.beforeQuit()).toBe('restart-final')
      f.coordinator.quitCancelled()
    })
    expect(f.coordinator.quitAfterDrain(f.readyPass)).toBe(true)
    expect(f.coordinator.state().phase).toBe('idle')
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    expect(f.relaunch).not.toHaveBeenCalled()
  })
  it('does not issue duplicate final quits for a pass before or after its native callback', async () => {
    const f = await ready()
    f.quit.mockImplementationOnce(() => {
      expect(f.coordinator.quitAfterDrain(f.readyPass)).toBe(false)
      expect(f.coordinator.beforeQuit()).toBe('restart-final')
      expect(f.coordinator.quitAfterDrain(f.readyPass)).toBe(false)
    })
    expect(f.coordinator.quitAfterDrain(f.readyPass)).toBe(true)
    expect(f.coordinator.quitAfterDrain(f.readyPass)).toBe(false)
    expect(f.quit).toHaveBeenCalledOnce()
    expect(f.coordinator.onFinalQuit(0)).toBe('scheduled')
    expect(f.relaunch).toHaveBeenCalledOnce()
  })
  it('retains only the current drain and ignores cancellation from an older generation', async () => {
    const f = setup()
    await f.coordinator.request()
    const oldPass = f.pass(),
      oldGeneration = f.coordinator.state().generation
    expect(f.coordinator.ownsDrain(oldPass)).toBe(true)
    f.coordinator.ordinaryQuit()
    expect(f.coordinator.ownsDrain(oldPass)).toBe(false)
    await f.coordinator.request()
    const currentPass = f.pass()
    f.coordinator.quitCancelled(oldGeneration)
    expect(f.coordinator.ownsDrain(currentPass)).toBe(true)
    expect(f.coordinator.settleDrain(oldPass, 'confirmed')).toBe(false)
    expect(f.coordinator.settleDrain(currentPass, 'confirmed')).toBe(true)
    expect(f.coordinator.ownsDrain(currentPass)).toBe(false)
    expect(f.coordinator.quitAfterDrain(currentPass)).toBe(true)
    expect(f.coordinator.onFinalQuit(0)).toBe('scheduled')
  })
  it('revokes if the final quit request itself throws', async () => {
    const f = await ready()
    f.quit.mockImplementationOnce(() => {
      throw new Error('quit failed')
    })
    expect(() => f.coordinator.quitAfterDrain(f.readyPass)).toThrow('quit failed')
    expect(f.coordinator.state().phase).toBe('idle')
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
  })
  it('invalidates readiness if the final quit needs another geometry or cleanup pass', async () => {
    const f = await ready()
    f.quit.mockImplementationOnce(() => {
      expect(f.coordinator.beforeQuit()).toBe('restart-final')
      expect(f.coordinator.beginDrain()).toBeDefined()
    })
    f.coordinator.quitAfterDrain(f.readyPass)
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    expect(f.relaunch).not.toHaveBeenCalled()
  })
  it.each(['confirming', 'draining', 'ready'] as const)(
    'background choice clears %s intent and ignores its old callbacks',
    async (phase) => {
      const f = setup(),
        consent = deferred<boolean>()
      if (phase === 'confirming') f.confirm.mockReturnValueOnce(consent.promise)
      const requested = f.coordinator.request()
      if (phase !== 'confirming') await requested
      if (phase === 'ready') f.coordinator.settleDrain(f.pass(), 'confirmed')
      f.coordinator.backgroundChosen()
      if (phase === 'confirming') {
        consent.resolve(true)
        expect(await requested).toBe('cancelled')
      }
      expect(f.coordinator.state().phase).toBe('idle')
      expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    }
  )
  it('external ordinary before-quit overrides a final restart already in progress', async () => {
    const f = await ready()
    f.coordinator.quitAfterDrain(f.readyPass)
    expect(f.coordinator.beforeQuit()).toBe('ordinary')
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    expect(f.relaunch).not.toHaveBeenCalled()
  })
  it('clears ready intent when a controlled Main hook reports final cancellation', async () => {
    const f = await ready()
    f.coordinator.quitAfterDrain(f.readyPass)
    f.coordinator.quitCancelled()
    expect(f.coordinator.state().phase).toBe('idle')
    expect(f.coordinator.isFinalQuitInProgress()).toBe(false)
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    expect(f.relaunch).not.toHaveBeenCalled()
  })
  it.each([1, -1, NaN])('does not schedule an abnormal final exit %s', async (code) => {
    const f = await ready()
    f.coordinator.quitAfterDrain(f.readyPass)
    expect(f.coordinator.onFinalQuit(code)).toBe('not-requested')
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    expect(f.relaunch).not.toHaveBeenCalled()
  })
  it('reports one failed scheduling attempt without retrying or resuming an old request', async () => {
    const f = await ready()
    f.relaunch.mockImplementationOnce(() => {
      throw new Error('helper launch failed')
    })
    f.coordinator.quitAfterDrain(f.readyPass)
    expect(f.coordinator.onFinalQuit(0)).toBe('schedule-failed')
    expect(f.coordinator.onFinalQuit(0)).toBe('not-requested')
    expect(f.relaunch).toHaveBeenCalledOnce()
    expect(await f.coordinator.request()).toBe('busy')
  })
})
