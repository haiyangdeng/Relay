// Pure callback-freshness tokens, with no Core/process/network authority;
// they are not Core/process/network authority or evidence of real restoration.
export interface RestartRequest {
  readonly generation: number
}
export interface RestartDrainPass {
  readonly request: RestartRequest
  readonly sequence: number
}
type Phase = 'idle' | 'confirming' | 'draining' | 'ready' | 'consumed'

export function createRestartIntentPrototype() {
  let phase: Phase = 'idle',
    generation = 0,
    sequence = 0
  let current: RestartRequest | undefined, drain: RestartDrainPass | undefined
  const clear = (): void => {
    ++generation
    current = undefined
    drain = undefined
    phase = 'idle'
  }
  return {
    state: (): Readonly<{ phase: Phase; generation: number }> =>
      Object.freeze({ phase, generation }),
    requestRestart(): RestartRequest | undefined {
      if (phase !== 'idle') return undefined
      current = Object.freeze({ generation: ++generation })
      phase = 'confirming'
      return current
    },
    confirm(request: RestartRequest, accepted: boolean): boolean {
      if (phase !== 'confirming' || current !== request) return false
      if (accepted !== true) {
        clear()
        return false
      }
      phase = 'draining'
      return true
    },
    beginDrain(request: RestartRequest): RestartDrainPass | undefined {
      if (current !== request || (phase !== 'draining' && phase !== 'ready')) return undefined
      // A new real recovery pass must invalidate an older completion callback.
      drain = Object.freeze({ request, sequence: ++sequence })
      phase = 'draining'
      return drain
    },
    settleDrain(pass: RestartDrainPass, result: 'confirmed' | 'cancelled' | 'failed'): boolean {
      if (phase !== 'draining' || current !== pass.request || drain !== pass) return false
      if (result === 'confirmed') phase = 'ready'
      else clear()
      return true
    },
    cancel(request: RestartRequest): boolean {
      if (current !== request || phase === 'consumed') return false
      clear()
      return true
    },
    ordinaryQuit(): void {
      if (phase !== 'consumed') clear()
    },
    backgroundChosen(): void {
      if (phase !== 'consumed') clear()
    },
    // Future integration calls this only from the non-cancellable app 'quit'
    // event after the existing real cleanup/restoration pipeline has succeeded.
    // It returns an inert intent, never calls Electron or schedules a process.
    takeAtFinalQuit(exitCode: number): boolean {
      if (phase === 'consumed') return false
      if (phase !== 'ready' || !current || !drain || exitCode !== 0) {
        clear()
        return false
      }
      // Consume before the caller's synchronous, irreversible schedule attempt.
      current = undefined
      drain = undefined
      phase = 'consumed'
      return true
    }
  }
}
