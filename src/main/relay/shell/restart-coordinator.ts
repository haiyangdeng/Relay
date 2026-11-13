import {
  createRestartIntentPrototype,
  type RestartDrainPass,
  type RestartRequest
} from './restart-intent'

export interface RestartAdapters {
  assertAvailable(): void
  showWindow(): void
  confirm(): Promise<boolean>
  // Notification only. Main starts its existing guarded cleanup and returns;
  // awaiting that cleanup here would deadlock shellWorkflow.whenIdle().
  startDrain(pass: RestartDrainPass): void
  quit(): void
  relaunch(): void
}
export type RestartRequestOutcome = 'requested' | 'cancelled' | 'busy'
export type FinalRestartOutcome = 'not-requested' | 'scheduled' | 'schedule-failed'

// Main adapter. A pass establishes callback freshness only;
// Main must supply actual successful restoration/closure before marking ready.
// This module never imports Electron, invokes callbacks asynchronously at quit,
// accepts launch arguments, or controls a Core/system setting.
export function createRestartCoordinator(adapters: RestartAdapters) {
  const intent = createRestartIntentPrototype()
  let request: RestartRequest | undefined,
    latestPass: RestartDrainPass | undefined,
    expectedFinalQuit: { pass: RestartDrainPass; observed: boolean } | undefined,
    finalQuitInProgress = false
  const cancel = (expected?: RestartRequest): boolean => {
    if (expected && request !== expected) return false
    if (request) intent.cancel(request)
    else intent.ordinaryQuit()
    request = undefined
    latestPass = undefined
    expectedFinalQuit = undefined
    finalQuitInProgress = false
    return true
  }
  const beginDrain = (): RestartDrainPass | undefined => {
    if (!request) return undefined
    const pass = intent.beginDrain(request)
    if (pass) {
      latestPass = pass
      expectedFinalQuit = undefined
      finalQuitInProgress = false
    }
    return pass
  }
  return {
    state: () => intent.state(),
    isFinalQuitInProgress: (): boolean => finalQuitInProgress,
    async request(): Promise<RestartRequestOutcome> {
      if (intent.state().phase !== 'idle') return 'busy'
      adapters.assertAvailable()
      const token = intent.requestRestart()
      if (!token) return 'busy'
      request = token
      try {
        adapters.showWindow()
        const accepted = await adapters.confirm()
        if (request !== token) return 'cancelled'
        adapters.assertAvailable()
        if (!intent.confirm(token, accepted)) {
          cancel(token)
          return 'cancelled'
        }
        const pass = beginDrain()
        if (!pass) {
          cancel(token)
          return 'cancelled'
        }
        adapters.startDrain(pass)
        return 'requested'
      } catch (error) {
        cancel(token)
        throw error
      }
    },
    beginDrain,
    ownsDrain: (pass: RestartDrainPass): boolean =>
      request === pass.request && latestPass === pass && intent.state().phase === 'draining',
    settleDrain(pass: RestartDrainPass, result: 'confirmed' | 'cancelled' | 'failed'): boolean {
      const accepted = intent.settleDrain(pass, result)
      if (accepted && result !== 'confirmed') cancel(pass.request)
      return accepted
    },
    // This wrapper may be used only after the exact pass has been marked ready.
    // Electron 43.8.0 app.quit emits before-quit synchronously. If no such event
    // occurs (e.g. another native quit is already in progress), revoke safely.
    quitAfterDrain(pass: RestartDrainPass): boolean {
      if (
        request !== pass.request ||
        latestPass !== pass ||
        intent.state().phase !== 'ready' ||
        expectedFinalQuit ||
        finalQuitInProgress
      )
        return false
      const transition = { pass, observed: false }
      expectedFinalQuit = transition
      try {
        adapters.quit()
      } catch (error) {
        cancel(pass.request)
        throw error
      } finally {
        if (!transition.observed) cancel(pass.request)
      }
      return transition.observed
    },
    // Call first in Main's existing before-quit listener. All external ordinary
    // quit entries revoke restart; only the one guarded final call preserves it.
    beforeQuit(): 'restart-final' | 'ordinary' {
      if (
        expectedFinalQuit &&
        expectedFinalQuit.pass === latestPass &&
        request === expectedFinalQuit.pass.request &&
        intent.state().phase === 'ready'
      ) {
        expectedFinalQuit.observed = true
        expectedFinalQuit = undefined
        finalQuitInProgress = true
        return 'restart-final'
      }
      cancel()
      return 'ordinary'
    },
    ordinaryQuit(): void {
      cancel()
    },
    backgroundChosen(): void {
      cancel()
    },
    quitCancelled(generation?: number): void {
      if (generation !== undefined && intent.state().generation !== generation) return
      cancel()
    },
    // Synchronous Main app 'quit' observer only, never before-/will-quit.
    // Consume before scheduling. A failed irreversible schedule is not retried.
    onFinalQuit(exitCode: number): FinalRestartOutcome {
      const ready = finalQuitInProgress && intent.takeAtFinalQuit(exitCode)
      if (!ready) {
        cancel()
        return 'not-requested'
      }
      request = undefined
      latestPass = undefined
      expectedFinalQuit = undefined
      finalQuitInProgress = false
      try {
        adapters.relaunch()
        return 'scheduled'
      } catch {
        return 'schedule-failed'
      }
    }
  }
}
