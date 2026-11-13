export interface SimpleScopeEnvironment {
  isVisible(): boolean
  onInvalidated(listener: () => void): () => void
  onRestored(listener: () => void): () => void
  onVisibilityChanged(listener: () => void): () => void
}

// Subscribe to existing no-body notifications. A new visible editing request
// must always be explicit; reconnecting or becoming visible never reads a body.
export function createSimpleEditorScope(environment: SimpleScopeEnvironment) {
  const listeners = new Set<() => void>()
  let connected = false
  const unsubscribe: (() => void)[] = []
  const notify = (): void => listeners.forEach((listener) => listener())
  const visible = (): boolean => {
    try {
      return environment.isVisible()
    } catch {
      return false
    }
  }
  return {
    isCurrent: (): boolean => connected && visible(),
    subscribeInvalidation(listener: () => void): () => void {
      listeners.add(listener)
      if (!connected) {
        connected = true
        try {
          unsubscribe.push(environment.onInvalidated(notify))
          unsubscribe.push(environment.onRestored(notify))
          unsubscribe.push(
            environment.onVisibilityChanged(() => {
              if (!visible()) notify()
            })
          )
        } catch {
          connected = false
          unsubscribe.splice(0).forEach((remove) => remove())
          notify()
        }
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          connected = false
          unsubscribe.splice(0).forEach((remove) => remove())
        }
      }
    }
  }
}
