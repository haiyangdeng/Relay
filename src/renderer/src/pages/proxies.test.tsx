import { createElement, isValidElement, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayProxyPageOwner } from '../../../shared/relay/local-proxy'
import type ProxyItem from '../components/proxies/proxy-item'
import type { RuntimeGroupMeasurements } from '../components/relay/runtime-group-probe'
import type {
  executeRuntimeGroupProbe,
  executeRuntimeNodeProbe
} from '../components/relay/runtime-group-probe'
import Proxies from './proxies'

const f = vi.hoisted(() => ({
  owner: undefined as RelayProxyPageOwner | null | undefined,
  groupError: undefined as Error | undefined,
  groups: [
    {
      name: 'Group',
      now: 'A',
      all: [
        { name: 'A', history: [] },
        { name: 'B', history: [] }
      ]
    }
  ],
  buttons: new Map<string, { onPress(): void; isLoading: boolean }>(),
  hooks: [] as unknown[],
  cursor: 0,
  interactive: false,
  results: undefined as RuntimeGroupMeasurements | undefined,
  groupProbe: vi.fn<typeof executeRuntimeGroupProbe>(),
  nodeProbe: vi.fn<typeof executeRuntimeNodeProbe>(),
  read: vi.fn(),
  change: vi.fn(),
  close: vi.fn(),
  member: vi.fn<(props: ComponentProps<typeof ProxyItem>) => void>()
}))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState<T>(initial?: T | (() => T)) {
      if (!f.interactive) return react.useState(initial)
      const slot = f.cursor++
      if (slot >= f.hooks.length)
        f.hooks[slot] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [
        f.hooks[slot],
        (next: T | ((prior: T) => T)) => {
          f.hooks[slot] =
            typeof next === 'function' ? (next as (prior: T) => T)(f.hooks[slot] as T) : next
        }
      ]
    },
    useRef<T>(initial: T) {
      if (!f.interactive) return react.useRef(initial)
      const slot = f.cursor++
      if (slot >= f.hooks.length) f.hooks[slot] = { current: initial }
      return f.hooks[slot]
    }
  }
})
vi.mock('@renderer/components/relay/runtime-group-probe', async (original) => ({
  ...(await original<typeof import('../components/relay/runtime-group-probe')>()),
  executeRuntimeGroupProbe: f.groupProbe,
  executeRuntimeNodeProbe: f.nodeProbe
}))
vi.mock('@renderer/utils/ipc', () => ({
  relayProxyPageOwner: vi.fn(),
  mihomoGroups: f.read,
  mihomoChangeProxy: f.change,
  mihomoCloseAllConnections: f.close,
  getSimpleConfig: vi.fn()
}))
vi.mock('@renderer/components/relay/preview-controls', () => ({ RELAY_PREVIEW_ONLY: true }))
vi.mock('@renderer/components/relay/proxy-library', () => ({
  RelayProxyLibrary: ({ cached = true }: { cached?: boolean }) =>
    cached ? 'cached-library' : 'live-selection'
}))
vi.mock('@renderer/components/base/base-page', () => ({
  default: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@renderer/components/proxies/proxy-item', () => ({
  default: (props: ComponentProps<typeof ProxyItem>) => {
    f.member(props)
    return props.proxy.name
  }
}))
vi.mock('@renderer/hooks/use-app-config', () => ({
  useAppConfig: () => ({ appConfig: { autoCloseConnection: true } })
}))
vi.mock('@renderer/hooks/use-groups', () => ({
  useGroups: () => ({ showHidden: false, mutate: vi.fn() })
}))
vi.mock('@renderer/hooks/use-controled-mihomo-config', () => ({
  useControledMihomoConfig: () => ({})
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('react-virtuoso', () => ({
  GroupedVirtuoso: ({
    itemContent,
    groupContent,
    groupCounts
  }: {
    itemContent: (i: number, g: number) => ReactNode
    groupContent: (g: number) => ReactNode
    groupCounts: number[]
  }) => {
    const visit = (node: ReactNode): void => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (
        !isValidElement<{
          children?: ReactNode
          'aria-label'?: string
          onPress?(): void
          isLoading?: boolean
        }>(node)
      )
        return
      const label = node.props['aria-label']
      if (label && node.props.onPress)
        f.buttons.set(label, { onPress: node.props.onPress, isLoading: !!node.props.isLoading })
      visit(node.props.children)
    }
    return groupCounts.flatMap((_, index) => {
      visit(groupContent(index))
      const start = groupCounts.slice(0, index).reduce((a, b) => a + b, 0)
      return f.groups[index].all.map((_, row) =>
        createElement('div', { key: index + '-' + row }, itemContent(start + row, index))
      )
    })
  }
}))
vi.mock('swr', () => ({
  default: (key: unknown, load?: (key: unknown) => unknown) => {
    const mutate = vi.fn()
    if (key === 'relayProxyPageOwner') return { data: f.owner, mutate }
    if (Array.isArray(key) && key[0] === 'relayIsolatedDelays')
      return {
        data: f.results,
        mutate: async (
          update: (previous?: RuntimeGroupMeasurements) => RuntimeGroupMeasurements
        ) => {
          f.results = update(f.results)
        }
      }

    if (Array.isArray(key) && key[0] === 'relayLiveGroups') {
      load?.(key)
      return {
        data: f.groups,
        error: f.groupError,
        mutate
      }
    }
    return { mutate }
  }
}))

const owner: RelayProxyPageOwner = {
  kind: 'tun-managed',
  instanceId: 'tun-A',
  profileId: 'p',
  configurationRevision: 'rev-A',
  mode: 'rule'
}
function render(path = '/proxies') {
  f.cursor = 0
  f.member.mockClear()
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: [path] }, createElement(Proxies))
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', { getItem: () => null })
  f.owner = owner
  f.groups = [
    {
      name: 'Group',
      now: 'A',
      all: [
        { name: 'A', history: [] },
        { name: 'B', history: [] }
      ]
    }
  ]
  f.interactive = false
  f.hooks = []
  f.results = undefined
  f.buttons.clear()
  f.groupError = undefined
})
afterEach(() => vi.unstubAllGlobals())
describe('Relay live proxy page', () => {
  it('reads the active TUN, selects against the same owner, and uses only supported actions', async () => {
    expect(render('/proxies?profile=p')).toContain('A')
    expect(f.read).toHaveBeenCalledWith(false, owner)
    const item = f.member.mock.calls[0][0]
    expect(item.testDisabled).toBe(true)
    expect(item.relayOwner).toBe(owner)
    await item.onSelect('Group', 'B')
    expect(f.change).toHaveBeenCalledWith('Group', 'B', owner)
    expect(f.close).not.toHaveBeenCalled()
  })
  it('a click measures the direct members of this card and leaves a shared node on other cards idle', async () => {
    f.owner = { ...owner, kind: 'ordinary', instanceId: 'ordinary-A' }
    f.interactive = true
    f.groups = [
      {
        name: 'Group',
        now: 'A',
        all: [
          { name: 'A', history: [] },
          { name: 'Child', history: [] }
        ]
      },
      {
        name: 'Child',
        now: 'A',
        all: [
          { name: 'A', history: [] },
          { name: 'Elsewhere', history: [] }
        ]
      }
    ]
    const invoke = vi.fn(async (channel: string) => {
      if (channel !== 'relayIsolatedProbeState') throw new Error('unexpected action')
      return { pending: false, uncertain: false }
    })
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    const waiting = Promise.withResolvers<Awaited<ReturnType<typeof executeRuntimeGroupProbe>>>()
    f.groupProbe.mockReturnValueOnce(waiting.promise)
    const member = (group: string, name: string) =>
      f.member.mock.calls
        .map(([props]) => props)
        .find((props) => props.group.name === group && props.proxy.name === name)!
    render()
    f.buttons.get('测速 Group')!.onPress()
    await vi.waitFor(() => expect(f.groupProbe).toHaveBeenCalledOnce())
    const [profile, group, params] = f.groupProbe.mock.calls[0]
    expect([profile, group, params.delay?.members]).toEqual(['p', 'Group', ['A', 'Child']])
    render()
    expect(member('Group', 'A').isGroupTesting).toBe(true)
    expect(member('Child', 'A').isGroupTesting).toBe(false)
    expect(f.buttons.get('测速 Group')?.isLoading).toBe(true)
    expect(f.buttons.get('测速 Child')?.isLoading).toBe(false)
    waiting.resolve({
      status: 'completed',
      kind: 'groupDelay',
      isolated: true,
      measurements: [
        { name: 'A', milliseconds: 23 },
        { name: 'Child', milliseconds: 31 },
        { name: 'Elsewhere', milliseconds: 404 }
      ]
    })
    await vi.waitFor(() => expect(f.results?.get('Group')?.get('A')).toBe(23))
    render()
    expect(member('Group', 'A').delayOverride).toBe(23)
    expect(member('Child', 'A').delayOverride).toBeUndefined()
    expect(member('Child', 'Elsewhere').delayOverride).toBeUndefined()
    expect(f.results?.get('Group')?.has('Elsewhere')).toBe(false)
    expect(f.nodeProbe).not.toHaveBeenCalled()
    f.nodeProbe.mockResolvedValueOnce({
      status: 'completed',
      kind: 'nodeDelay',
      isolated: true,
      measurements: [{ name: 'A', milliseconds: 71 }]
    })
    const child = member('Child', 'A')
    await child.onProxyDelay(child.proxy, child.group)
    render()
    expect(member('Child', 'A').delayOverride).toBe(71)
    expect(member('Group', 'A').delayOverride).toBe(23)
  })
  it('shows a live read failure without offering to start a second core', () => {
    f.groupError = new Error('readback failed')
    const page = render()
    expect(page).toContain('readback failed')
    expect(page).toContain('live-selection')
    expect(page).not.toContain('cached-library')
    expect(f.member).not.toHaveBeenCalled()
  })
  it('retains offline and other-profile browsing while pinning ordinary core requests', async () => {
    f.owner = null
    expect(render()).toContain('cached-library')
    f.owner = { ...owner, kind: 'ordinary', instanceId: 'local-A' }
    expect(render('/proxies?profile=other')).toContain('cached-library')
    expect(f.read).not.toHaveBeenCalled()
    render()
    const item = f.member.mock.calls[0][0]
    expect(item.testDisabled).toBe(false)
    await item.onSelect('Group', 'B')
    expect(f.change).toHaveBeenCalledWith('Group', 'B', f.owner)
  })
})
