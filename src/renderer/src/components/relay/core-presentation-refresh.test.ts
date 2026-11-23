import { afterEach, expect, it, vi } from 'vitest'
import { corePresentationKey } from './core-presentation'
import { useSidebarStatus } from './use-sidebar-status'

const fixture = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  publish: vi.fn()
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (value: unknown) => value,
  useEffect: (effect: () => void | (() => void)) => fixture.effects.push(effect)
}))
vi.mock('swr', () => ({ mutate: fixture.publish }))

afterEach(() => vi.unstubAllGlobals())

it('publishes both owners at startup and rereads them on TUN changes even off the TUN page', async () => {
  const events = new Map<string, () => void>()
  const local = { owned: false, phase: 'idle', pending: false, uncertain: false }
  let tun: {
    session: { owned: boolean; phase: string; traffic: string; sessionId?: string }
    httpPort?: number
  } = {
    session: { owned: false, phase: 'idle', traffic: 'inactive' },
    httpPort: undefined as number | undefined
  }
  const owner = {
    kind: 'tun-managed',
    instanceId: 'tun-session',
    profileId: 'p',
    mode: 'rule',
    configurationRevision: 'rev'
  }
  const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
    if (channel === 'relayLocalProxyState') return local
    if (channel === 'relayTunStatus') return tun
    if (channel === 'relayProxyPageOwner') return owner
    if (channel === 'mihomoGroups') return ['group']
    return undefined
  })
  vi.stubGlobal('window', {
    electron: {
      ipcRenderer: {
        invoke,
        on: (event: string, listener: () => void) => {
          events.set(event, listener)
          return () => events.delete(event)
        }
      }
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  useSidebarStatus()
  const cleanups = fixture.effects.map((effect) => effect())
  try {
    await vi.waitFor(() =>
      expect(fixture.publish).toHaveBeenLastCalledWith(
        corePresentationKey,
        { local, tun },
        { revalidate: false }
      )
    )
    const previousReads = invoke.mock.calls.filter(
      ([channel]) => channel === 'relayTunStatus'
    ).length
    tun = {
      session: { owned: true, phase: 'active', traffic: 'forwarding', sessionId: 'tun-session' },
      httpPort: 19234
    }
    const notify = events.get('relayTunUpdated')
    expect(notify).toBeTypeOf('function')
    notify?.()
    await vi.waitFor(() =>
      expect(fixture.publish).toHaveBeenLastCalledWith(
        corePresentationKey,
        { local, tun },
        { revalidate: false }
      )
    )
    expect(invoke).toHaveBeenCalledWith('mihomoGroups', false, owner)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'relayTunStatus')).toHaveLength(
      previousReads + 1
    )
  } finally {
    for (const cleanup of cleanups) if (cleanup) cleanup()
  }
})
