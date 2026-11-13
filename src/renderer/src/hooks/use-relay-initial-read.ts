import { useEffect, useRef } from 'react'

// Open a settings page with its saved values. Keep drafts on return and never
// turn a failed read into an automatic retry or a write.
export function useRelayInitialRead(
  active: boolean,
  ready: boolean,
  blocked: boolean,
  read: () => Promise<void>,
  identity = 'page'
): void {
  const attempted = useRef(false)
  const previous = useRef(identity)
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    if (previous.current !== identity) {
      previous.current = identity
      attempted.current = false
    }
    if (!active) {
      attempted.current = false
      return
    }
    if (ready || blocked || attempted.current) return
    attempted.current = true
    void readRef.current().catch(() => {
      // Each reader owns its error state; navigation must not retry mutations.
    })
  }, [active, ready, blocked, identity])
}
