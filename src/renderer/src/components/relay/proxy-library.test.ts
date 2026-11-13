import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayProfileGroups, RelayStoredProfile } from '../../../../shared/relay/profiles'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import { RelayProxyLibrary } from './proxy-library'

const context = vi.hoisted(() => ({
  query: 'b',
  current: 'a',
  swr: new Map<string, Record<string, unknown>>(),
  selection: undefined as undefined | ((keys: Set<string>) => void),
  setParams: vi.fn(),
  invoke: vi.fn(),
  mutate: vi.fn()
}))
vi.mock('swr', () => ({
  default: (key: string | string[] | null) => ({
    mutate: context.mutate,
    isLoading: false,
    ...context.swr.get(Array.isArray(key) ? key[0] : (key ?? ''))
  })
}))
vi.mock('@renderer/hooks/use-profile-config', () => ({
  useProfileConfig: () => ({
    profileConfig: { current: context.current },
    mutateProfileConfig: context.mutate
  })
}))
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams({ profile: context.query }), context.setParams],
  Link: ({ children }: { children: ReactNode }) => createElement('a', null, children)
}))
vi.mock('@heroui/react', async () => {
  const { createElement: element } = await import('react')
  type Props = {
    children?: ReactNode
    isDisabled?: boolean
    label?: string
    onSelectionChange?: (keys: Set<string>) => void
  }
  return {
    Button: ({ children, isDisabled }: Props) =>
      element('button', { disabled: isDisabled }, children),
    Chip: ({ children }: Props) => element('span', null, children),
    Input: ({ label }: Props) => element('input', { 'aria-label': label }),
    Select: ({ children, label, onSelectionChange }: Props) => {
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
  groups: [{ name: 'B GROUP', type: 'select', proxies: ['B NODE'] }],
  targets: ['B NODE'],
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
const render = (runtimeError = false): string =>
  renderToStaticMarkup(
    createElement(RelayProxyLibrary, { state, runtimeError, onRuntimeChange: async () => {} })
  )

beforeEach(() => {
  context.query = 'b'
  context.current = 'a'
  context.selection = undefined
  context.setParams.mockClear()
  context.invoke.mockClear()
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
  it('browses query and dropdown choices without selecting or starting a profile', () => {
    const html = render()
    expect(html).toContain('B GROUP')
    expect(html).toContain('B NODE')
    expect(html).toContain('浏览配置')
    expect(html).toContain('使用此配置')
    expect(html).not.toContain('选用此配置')
    context.selection?.(new Set(['a']))
    expect(context.setParams).toHaveBeenCalledWith({ profile: 'a' })
    expect(context.current).toBe('a')
    expect(context.invoke).not.toHaveBeenCalled()
  })

  it.each([{ profile: a }, { profile: { ...b, sha256: 'old' } }])(
    'never renders a snapshot from another profile or digest %j',
    (patch) => {
      context.swr.set('relayCachedGroups', { data: { ...snapshot, ...patch } })
      const html = render()
      expect(html).not.toContain('B GROUP')
      expect(html).not.toContain('B NODE')
      expect(html).toContain('<button disabled="">使用此配置</button>')
    }
  )

  it.each(['relayCachedGroups', 'relayProxyLibrary'])(
    'hides stale data when %s failed to refresh',
    (key) => {
      context.swr.set(key, { ...context.swr.get(key), error: new Error('read failed') })
      const html = render()
      expect(html).not.toContain('B GROUP')
      expect(html).toContain('读取失败')
      expect(html).toContain('<button disabled="">使用此配置</button>')
    }
  )

  it('keeps the cache visible but blocks activation when runtime state failed to refresh', () => {
    const html = render(true)
    expect(html).toContain('B GROUP')
    expect(html).toContain('运行状态读取失败')
    expect(html).toContain('<button disabled="">使用此配置</button>')
    expect(html).not.toContain('运行中')
  })

  it.each(['relayCachedGroups', 'relayProxyLibrary'])(
    'waits for %s revalidation instead of reporting its warm cache as ready',
    (key) => {
      context.swr.set(key, { ...context.swr.get(key), isValidating: true })
      const html = render()
      expect(html).toContain('data-relay-cache-read-state="loading"')
      expect(html).toContain('data-relay-cache-refresh-generation="0"')
      expect(html).not.toContain('B GROUP')
      expect(html).toContain('<button disabled="">使用此配置</button>')
    }
  )
})
