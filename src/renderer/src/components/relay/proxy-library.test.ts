import { createElement, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayProfileGroups, RelayStoredProfile } from '../../../../shared/relay/profiles'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import { RelayProxyLibrary } from './proxy-library'

const context = vi.hoisted(() => ({
  search: 'panel=proxies&profile=b',
  effects: [] as (() => unknown)[],
  nodes: new Map<string, { disabled?: boolean; onClick(): void; 'aria-pressed'?: boolean }>(),
  selectedKeys: [] as string[],
  locked: false,
  runtimeChange: vi.fn(),
  revalidateSelection: vi.fn(),
  readLibrary: undefined as undefined | (() => Promise<unknown>),
  current: 'a',
  swr: new Map<string, Record<string, unknown>>(),
  selection: undefined as undefined | ((keys: Set<string>) => void),
  setParams: vi.fn(),
  invoke: vi.fn(),
  mutate: vi.fn()
}))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => unknown) => {
    context.effects.push(effect)
  }
}))
// Capture the actual member button handlers while rendering the real group.
vi.mock('./cached-proxy-group', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cached-proxy-group')>()
  const { Children, isValidElement } = await import('react')
  function collect(node: ReactNode): void {
    if (!isValidElement<ComponentProps<'button'>>(node)) return
    if (node.type === 'button' && node.props.title && node.props.onClick) {
      const { title, disabled, 'aria-pressed': pressed, onClick } = node.props
      if (typeof pressed === 'boolean') {
        context.nodes.set(title, {
          disabled,
          'aria-pressed': pressed,
          onClick: () => Reflect.apply(onClick, undefined, [])
        })
      }
    }
    Children.forEach(node.props.children, collect)
  }
  return {
    RelayCachedProxyGroup: (props: ComponentProps<typeof actual.RelayCachedProxyGroup>) => {
      const tree = actual.RelayCachedProxyGroup(props)
      collect(tree)
      return tree
    }
  }
})
vi.mock('swr', () => ({
  default: (key: string | string[] | null, fetch: () => Promise<unknown>) => {
    if (key === 'relayProxyLibrary') context.readLibrary = fetch
    return {
      mutate: context.mutate,
      isLoading: false,
      ...context.swr.get(Array.isArray(key) ? key[0] : (key ?? ''))
    }
  }
}))
vi.mock('@renderer/hooks/use-profile-config', () => ({
  useProfileConfig: () => ({
    profileConfig: { current: context.current },
    mutateProfileConfig: context.revalidateSelection
  })
}))
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(context.search), context.setParams],
  Link: ({ children }: { children: ReactNode }) => createElement('a', null, children)
}))
vi.mock('@heroui/react', async () => {
  const { createElement: element } = await import('react')
  type Props = {
    children?: ReactNode
    isDisabled?: boolean
    label?: string
    selectedKeys?: string[]
    onSelectionChange?: (keys: Set<string>) => void
  }
  return {
    Button: ({ children, isDisabled }: Props) =>
      element('button', { disabled: isDisabled }, children),
    Chip: ({ children }: Props) => element('span', null, children),
    Input: ({ label }: Props) => element('input', { 'aria-label': label }),
    Select: ({ children, label, selectedKeys, isDisabled, onSelectionChange }: Props) => {
      context.selectedKeys = selectedKeys ?? []
      context.locked = !!isDisabled
      context.selection = onSelectionChange
      return element('div', { 'aria-label': label }, children)
    },
    SelectItem: ({ children }: Props) => element('span', null, children),
    Spinner: ({ label }: Props) => element('span', null, label)
  }
})
const profile = (id: string): RelayStoredProfile => ({
  id,
  name: `Profile ${id}`,
  sha256: id.repeat(64),
  createdAt: '',
  summary: { proxies: 1, groups: 1, rules: 0, proxyProviders: 0, ruleProviders: 0 }
})
const a = profile('a'),
  b = profile('b')
const snapshot: RelayProfileGroups = {
  profile: b,
  groups: [{ name: 'B GROUP', type: 'select', proxies: ['B NODE', 'SECOND NODE', 'MISSING NODE'] }],
  targets: ['B NODE', 'SECOND NODE'],
  savedSelectors: [['B GROUP', 'B NODE']],
  providers: []
}
const state: LocalProxyState = {
  phase: 'unknown',
  owned: false,
  pending: false,
  uncertain: false,
  hasRecord: false,
  traffic: 'inactive',
  groups: [],
  warnings: [],
  systemProxyChanged: false,
  liveGuardEnabled: false
}
const render = (props: Partial<ComponentProps<typeof RelayProxyLibrary>> = {}): string => {
  const html = renderToStaticMarkup(
    createElement(RelayProxyLibrary, { state, onRuntimeChange: context.runtimeChange, ...props })
  )
  for (const effect of context.effects.splice(0)) effect()
  return html
}
const pinned = { id: b.id, sha256: b.sha256 }
const selectionCalls = [['changeCurrentProfile', pinned], ['getProfileConfig']]
function selectB(): void {
  if (!context.selection) throw new Error('Missing profile selector')
  context.selection(new Set(['b']))
}
async function settled(): Promise<void> {
  await vi.waitFor(() => expect(context.runtimeChange).toHaveBeenCalledOnce())
}
function node(name: string) {
  const member = context.nodes.get(name)
  if (!member) throw new Error('Missing node button: ' + name)
  return member
}

beforeEach(() => {
  context.search = 'panel=proxies&profile=b'
  context.effects.length = 0
  context.nodes.clear()
  context.readLibrary = undefined
  context.revalidateSelection.mockReset()
  context.runtimeChange.mockReset().mockResolvedValue(undefined)
  context.current = 'a'
  context.selection = undefined
  context.setParams.mockClear()
  context.invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'getProfileConfig') return { current: 'b' }
  })
  context.mutate.mockClear()
  context.swr.clear()
  context.swr.set('relayProxyLibrary', {
    data: {
      inventory: { profiles: [a, b], incomplete: 0, activeId: null, warnings: [] },
      sources: { sources: [], incomplete: 0, warnings: [] }
    }
  })
  context.swr.set('relayCachedGroups', { data: snapshot })
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke: context.invoke } } })
})

describe('cached proxy library presentation', () => {
  it('previews a deep link without changing the active profile on mount', () => {
    const html = render()
    expect(html).toContain('B GROUP')
    expect(html).toContain('B NODE')
    expect(html).toContain('Profile b')
    expect(html).not.toContain('使用此配置')
    expect(context.selectedKeys).toEqual(['a'])
    expect(context.invoke).not.toHaveBeenCalled()
    expect(context.setParams).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'a'],
    ['a', 'b']
  ])(
    'rereads the restored disk choice when the library opens (%s → %s)',
    async (cached, restored) => {
      context.current = cached
      context.search = 'panel=proxies'
      context.invoke.mockImplementation(async (channel: string, refresh?: boolean) => {
        if (channel === 'getProfileConfig') return { current: refresh ? restored : cached }
      })
      context.revalidateSelection.mockImplementation(
        async (fetch: () => Promise<{ current: string }>) => {
          context.current = (await fetch()).current
        }
      )
      render()
      expect(context.selectedKeys).toEqual(cached ? [cached] : [])
      if (!context.readLibrary) throw new Error('Missing inventory fetcher')
      await context.readLibrary()
      render()
      expect(context.revalidateSelection).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
        revalidate: false
      })
      expect(context.selectedKeys).toEqual([restored])
      expect(context.invoke.mock.calls).toEqual([
        ['relayProfileList'],
        ['relaySourceList'],
        ['getProfileConfig', true]
      ])
      expect(context.setParams).not.toHaveBeenCalled()
    }
  )

  it('selects the pinned offline profile once, confirms it and clears only the deep link', async () => {
    render()
    expect(context.locked).toBe(false)
    selectB()
    selectB()
    await settled()
    expect(context.invoke.mock.calls).toEqual(selectionCalls)
    expect(context.setParams).toHaveBeenCalledOnce()
    const [next, options] = context.setParams.mock.calls[0]
    expect([...next.entries()]).toEqual([['panel', 'proxies']])
    expect(options).toEqual({ replace: true })
  })

  it.each([true, false])(
    'does not advance after a rejected or unconfirmed switch (%s)',
    async (rejected) => {
      context.invoke.mockImplementation(async (channel: string) => {
        if (channel === 'changeCurrentProfile' && rejected) throw new Error('cancelled')
        return { current: 'a' }
      })
      render()
      node('SECOND NODE').onClick()
      await settled()
      expect(context.invoke.mock.calls).toEqual(
        rejected ? selectionCalls.slice(0, 1) : selectionCalls
      )
      expect(context.setParams).not.toHaveBeenCalled()
    }
  )

  it('renders saved and locked members and applies an explicit member after profile confirmation', async () => {
    render()
    expect(node('B NODE')).toMatchObject({ 'aria-pressed': true, disabled: false })
    expect(node('SECOND NODE')).toMatchObject({ 'aria-pressed': false, disabled: false })
    expect(node('MISSING NODE').disabled).toBe(true)
    node('SECOND NODE').onClick()
    await settled()
    expect(context.invoke.mock.calls).toEqual([
      ...selectionCalls,
      ['relayProxyPageOwner'],
      ['relayProfileGroupSelect', { profile: pinned, group: 'B GROUP', member: 'SECOND NODE' }]
    ])
  })

  it('saves an explicit preview member before handing the live TUN to that profile', async () => {
    const owner = {
      kind: 'tun-managed' as const,
      instanceId: 'old',
      configurationRevision: 'rev',
      profileId: 'a',
      mode: 'rule' as const
    }
    const nextOwner = { ...owner, instanceId: 'new', profileId: 'b' }
    context.invoke.mockImplementation(async (channel: string) =>
      channel === 'relayProxyPageOwner' ? nextOwner : undefined
    )
    render({ owner })
    node('SECOND NODE').onClick()
    await settled()
    expect(context.invoke.mock.calls).toEqual([
      [
        'relayProfileGroupSelect',
        { profile: pinned, group: 'B GROUP', member: 'SECOND NODE', owner }
      ],
      ['relayTunProfileSwitch', { profile: pinned, owner }],
      ['relayProxyPageOwner'],
      ['mihomoChangeProxy', 'B GROUP', 'SECOND NODE', nextOwner]
    ])
  })

  it.each([true, false])(
    'hands a TUN profile switch to the owning session and advances only on success (%s)',
    async (success) => {
      const owner = {
        kind: 'tun-managed' as const,
        instanceId: 'tun',
        configurationRevision: 'rev',
        profileId: 'a',
        mode: 'rule' as const
      }
      context.invoke.mockImplementation(async (channel: string) => {
        if (channel === 'relayTunProfileSwitch' && !success) throw new Error('原会话已保留')
        if (channel === 'getProfileConfig') return { current: success ? 'b' : 'a' }
        if (channel === 'relayProxyPageOwner') return { ...owner, profileId: success ? 'b' : 'a' }
      })
      render({ owner, cached: false })
      expect(context.selectedKeys).toEqual(['a'])
      expect(context.locked).toBe(false)
      selectB()
      selectB()
      await settled()
      expect(
        context.invoke.mock.calls.filter(
          ([channel]) => channel !== 'getProfileConfig' && channel !== 'relayProxyPageOwner'
        )
      ).toEqual([['relayTunProfileSwitch', { profile: pinned, owner }]])
      expect(context.setParams).toHaveBeenCalledTimes(success ? 1 : 0)
    }
  )

  it.each([{ profile: a }, { profile: { ...b, sha256: 'old' } }])(
    'never renders a snapshot from another profile or digest %j',
    (patch) => {
      context.swr.set('relayCachedGroups', { data: { ...snapshot, ...patch } })
      const html = render()
      expect(html).not.toContain('B GROUP')
      expect(context.nodes.size).toBe(0)
      expect(context.invoke).not.toHaveBeenCalled()
    }
  )

  it.each(['relayCachedGroups', 'relayProxyLibrary'])(
    'hides stale data when %s failed to refresh',
    (key) => {
      context.swr.set(key, { ...context.swr.get(key), error: new Error('read failed') })
      const html = render()
      expect(html).not.toContain('B GROUP')
      expect(html).toContain('读取失败')
      expect(context.nodes.size).toBe(0)
    }
  )

  it.each([{ state: undefined }, { runtimeError: true }])(
    'shows read-only cached nodes while runtime is unavailable %j',
    (props) => {
      const html = render(props)
      expect(html).toContain('B GROUP')
      expect(context.locked).toBe(true)
      expect(node('B NODE').disabled).toBe(true)
      selectB()
      expect(context.invoke).not.toHaveBeenCalled()
    }
  )

  it.each(['relayCachedGroups', 'relayProxyLibrary'])(
    'waits for %s revalidation before exposing cached choices',
    (key) => {
      context.swr.set(key, { ...context.swr.get(key), isValidating: true })
      const html = render()
      expect(html).toContain('data-relay-cache-read-state="loading"')
      expect(html).toContain('data-relay-cache-refresh-generation="0"')
      expect(html).not.toContain('B GROUP')
      expect(context.nodes.size).toBe(0)
    }
  )
})
