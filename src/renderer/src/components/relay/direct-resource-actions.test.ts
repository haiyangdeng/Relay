import { isValidElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayStoredProfile } from '../../../../shared/relay/profiles'
import { RelaySubscriptionSourcesPanel } from './subscription-sources-panel'
import { RelayProvidersPanel } from './providers-panel'
import { RelayResourcesPanel } from './resources-panel'
import { RelayVariantsPanel } from './variants-panel'
import { RelayProfileNodeEditor } from './profile-node-editor'

vi.mock('./library-controls', () => ({ RelayLibraryControls: () => null }))
vi.mock('./rule-resource-preview-modal', () => ({ RuleResourcePreviewModal: () => null }))
vi.mock('./active-rule-providers-panel', () => ({ RelayActiveRuleProvidersPanel: () => null }))
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>()
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState<T>(initial?: T | (() => T)) {
    const at = hooks.cursor++
    if (at >= hooks.slots.length)
      hooks.slots[at] = typeof initial === 'function' ? (initial as () => T)() : initial
    return [
      hooks.slots[at] as T,
      (next: T | ((old: T) => T)) => {
        hooks.slots[at] =
          typeof next === 'function' ? (next as (old: T) => T)(hooks.slots[at] as T) : next
      }
    ]
  },
  useRef<T>(initial: T) {
    const at = hooks.cursor++
    if (at >= hooks.slots.length) hooks.slots[at] = { current: initial }
    return hooks.slots[at] as { current: T }
  },
  useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
    const at = hooks.cursor++,
      prior = hooks.slots[at] as readonly unknown[] | undefined
    if (!prior || deps.some((item, index) => !Object.is(item, prior[index])))
      hooks.effects.push(() => {
        hooks.cleanups.get(at)?.()
        const cleanup = effect()
        if (cleanup) hooks.cleanups.set(at, cleanup)
        else hooks.cleanups.delete(at)
      })
    hooks.slots[at] = deps
  }
}))
function elements(node: ReactNode): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function content(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(content).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return content(node.props.children)
  return ''
}
function unmount(): void {
  for (const cleanup of hooks.cleanups.values()) cleanup()
  hooks.cleanups.clear()
}
beforeEach(() => {
  hooks.slots = []
  hooks.cursor = 0
  hooks.effects = []
  hooks.cleanups.clear()
})
afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
})
const id = '00000000-0000-4000-8000-000000000001',
  evidenceId = '00000000-0000-4000-8000-000000000002'
const profile: RelayStoredProfile = {
  id,
  sha256: 'a'.repeat(64),
  name: 'Fixture',
  createdAt: '2026-11-10T00:00:00Z',
  summary: { proxies: 1, groups: 0, rules: 0, proxyProviders: 1, ruleProviders: 0 }
}
const plan = {
  evidenceId,
  inspection: { structure: 'passed' },
  canSave: true,
  issues: [],
  profile,
  provider: { name: 'Provider', kind: 'http' }
}
const variant = {
  kind: 'core',
  architecture: 'arm64',
  version: 'v1',
  sha256: 'b'.repeat(64),
  size: 100
}
type Kind = 'provider' | 'batch' | 'snapshot' | 'resource' | 'variant' | 'nodes' | 'groups'
function fixture(kind: Kind) {
  let current = { ...profile }
  const prepare = {
    provider: 'relayProviderPrepare',
    batch: 'relayProviderBatchPrepare',
    snapshot: 'relayProviderSnapshotPrepare',
    resource: 'relayResourcePrepare',
    variant: 'relayVariantPrepare',
    nodes: 'relayProfileNodesPrepare',
    groups: 'relayProfileGroupsPrepare'
  }[kind]
  const execute = {
    provider: 'relayProviderAcquire',
    batch: 'relayProviderBatchAcquire',
    snapshot: 'relayProviderSnapshotSave',
    resource: 'relayResourceAcquire',
    variant: 'relayVariantExecute',
    nodes: 'relayProfileSave',
    groups: 'relayProfileSave'
  }[kind]
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === prepare) return plan
      if (channel === execute) return { status: 'saved', warnings: [], items: [] }
      if (channel === 'relayProvidersInspect')
        return {
          profile: current,
          providers: [
            {
              name: 'Provider',
              kind: 'http',
              canAcquire: true,
              resources: [{ id, sha256: 'b'.repeat(64), nodes: 1 }],
              issues: []
            }
          ],
          warnings: []
        }
      if (channel === 'relayVariantState')
        return {
          pending: false,
          trustedCoreVersion: 'v1',
          hostArchitecture: 'arm64',
          trustedCoreImports: [variant],
          trustedSmartImports: [],
          records: []
        }
      if (channel === 'relayProfileNodesRead')
        return { profile: current, nodes: [{ name: 'A', type: 'ss' }] }
      if (channel === 'relayProfileGroupsRead')
        return {
          profile: current,
          groups: [{ name: 'A', type: 'select', proxies: ['DIRECT'] }],
          targets: ['DIRECT'],
          providers: []
        }
      return { phase: 'idle', pending: false, resources: [] }
    }),
    onBusy = vi.fn(),
    onSaved = vi.fn(async () => {})
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  const render = () => {
    hooks.cursor = 0
    const tree = ['provider', 'batch', 'snapshot'].includes(kind)
      ? RelayProvidersPanel({ profiles: [current], busy: false, onBusy, onSaved })
      : kind === 'resource'
        ? RelayResourcesPanel({ busy: false, onBusy })
        : kind === 'variant'
          ? RelayVariantsPanel({ busy: false, onBusy })
          : RelayProfileNodeEditor({
              profile: current,
              busy: false,
              onBusy,
              collection: kind === 'groups' ? 'groups' : 'nodes'
            })
    for (const effect of hooks.effects.splice(0)) effect()
    return tree
  }
  const find = (type: string, label = '') => {
    const item = elements(render()).find(
      (node) =>
        node.type === type && (!label || content(node.props.children as ReactNode).includes(label))
    )
    if (!item) throw new Error(`missing ${type} ${label}`)
    return item.props
  }
  const change = (props: Record<string, unknown>, value: string) =>
    (props.onChange as (e: { target: { value: string } }) => void)({ target: { value } })
  const click = (label: string) => (find('button', label).onClick as () => void)()
  const settle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const initialize = async () => {
    render()
    if (['provider', 'batch', 'snapshot'].includes(kind)) {
      change(find('select'), id)
      render()
      click('读取提供者')
      await settle()
      if (kind === 'snapshot') {
        const selection = elements(render()).find(
          (node) => node.type === 'select' && node.props['aria-label'] === 'Provider缓存选择'
        )
        if (!selection) throw new Error('cache selection missing')
        change(selection.props, id)
      }
    } else if (kind === 'variant') {
      click('读取资源')
      await settle()
    } else if (kind === 'nodes' || kind === 'groups') {
      click('读取')
      await settle()
    }
  }
  const action = {
    provider: '获取并缓存此资源',
    batch: '刷新全部提供者',
    snapshot: '保存缓存配置副本',
    resource: '获取并缓存资源',
    variant: '导入资源文件',
    nodes: '保存节点到配置副本',
    groups: '保存代理组到配置副本'
  }[kind]
  return {
    invoke,
    onBusy,
    onSaved,
    render,
    find,
    change,
    click,
    settle,
    initialize,
    prepare,
    execute,
    action,
    swap: () => {
      current = { ...current, sha256: 'c'.repeat(64) }
      render()
    }
  }
}

describe('One-click resource actions with injected hooks and IPC', () => {
  it.each<Kind>(['provider', 'batch', 'snapshot', 'resource', 'variant', 'nodes', 'groups'])(
    '%s consumes the prepared result once from one click',
    async (kind) => {
      const f = fixture(kind)
      await f.initialize()
      const gate = Promise.withResolvers<unknown>()
      f.invoke.mockImplementationOnce(() => gate.promise)
      f.click(f.action)
      f.click(f.action)
      expect(f.invoke.mock.calls.filter(([channel]) => channel === f.prepare)).toHaveLength(1)
      expect(f.invoke.mock.calls.some(([channel]) => channel === f.execute)).toBe(false)
      gate.resolve(plan)
      await f.settle()
      expect(f.invoke.mock.calls.filter(([channel]) => channel === f.execute)).toHaveLength(1)
      if (kind !== 'variant') expect(f.invoke).toHaveBeenCalledWith(f.execute, { evidenceId })
      expect(f.onBusy).toHaveBeenLastCalledWith(false)
    }
  )
  it.each<Kind>(['provider', 'batch', 'snapshot', 'resource', 'variant', 'nodes', 'groups'])(
    '%s never executes a preparation that returns after unmount',
    async (kind) => {
      const f = fixture(kind)
      await f.initialize()
      const gate = Promise.withResolvers<unknown>()
      f.invoke.mockImplementationOnce(() => gate.promise)
      f.click(f.action)
      unmount()
      gate.resolve(plan)
      await f.settle()
      expect(f.invoke.mock.calls.some(([channel]) => channel === f.execute)).toBe(false)
      expect(f.onSaved).not.toHaveBeenCalled()
      expect(f.onBusy).toHaveBeenLastCalledWith(false)
    }
  )
  it.each<Kind>(['provider', 'batch', 'snapshot', 'nodes', 'groups'])(
    '%s refuses a changed source SHA before committing',
    async (kind) => {
      const f = fixture(kind)
      await f.initialize()
      const gate = Promise.withResolvers<unknown>()
      f.invoke.mockImplementationOnce(() => gate.promise)
      f.click(f.action)
      f.swap()
      gate.resolve(plan)
      await f.settle()
      expect(f.invoke.mock.calls.some(([channel]) => channel === f.execute)).toBe(false)
    }
  )
  it.each<Kind>(['provider', 'batch', 'snapshot', 'resource'])(
    '%s cancels while prepare is still waiting without starting execution',
    async (kind) => {
      const f = fixture(kind)
      await f.initialize()
      const gate = Promise.withResolvers<unknown>()
      f.invoke.mockImplementationOnce(() => gate.promise)
      f.click(f.action)
      const cancel = f.find('button', kind === 'resource' ? '取消本次资源操作' : '取消本次操作')
      expect(cancel.disabled).toBe(false)
      ;(cancel.onClick as () => void)()
      gate.resolve(plan)
      await f.settle()
      expect(f.invoke.mock.calls.some(([channel]) => channel === f.execute)).toBe(false)
      expect(f.invoke).toHaveBeenCalledWith(
        kind === 'resource' ? 'relayResourceCancel' : 'relayProviderCancel',
        { evidenceId }
      )
    }
  )
  it.each<Kind>(['nodes', 'groups'])(
    '%s does not save a structurally invalid preparation',
    async (kind) => {
      const f = fixture(kind)
      await f.initialize()
      f.invoke.mockResolvedValueOnce({ ...plan, inspection: { structure: 'failed' } })
      f.click(f.action)
      await f.settle()
      expect(f.invoke.mock.calls.some(([channel]) => channel === f.execute)).toBe(false)
    }
  )
})

function sourcesFixture(kind: 'register' | 'update' | 'restore') {
  const source = {
    id,
    revision: 'a'.repeat(64),
    name: 'Fixture',
    origin: 'https://fixture.invalid',
    locked: false,
    versions: [{ id: evidenceId, createdAt: '2026-11-10T00:00:00Z', action: 'download', profile }]
  }
  const prepare = {
    register: 'relaySourceRegisterPrepare',
    update: 'relaySourceUpdatePrepare',
    restore: 'relaySourceRestorePrepare'
  }[kind]
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === prepare) return { ...plan, kind }
      if (channel === 'relaySourceExecute') return { status: 'saved', warnings: [] }
      if (channel === 'relaySourceList') return { sources: [source], warnings: [] }
      if (channel === 'relaySourceScheduleState') return { entries: [], pending: false }
      return { phase: 'idle', pending: false }
    }),
    onBusy = vi.fn(),
    onSaved = vi.fn(async () => {})
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  const render = () => {
    hooks.cursor = 0
    const tree = RelaySubscriptionSourcesPanel({ busy: false, onBusy, onSaved })
    for (const effect of hooks.effects.splice(0)) effect()
    return tree
  }
  const find = (type: string, label = '') => {
    const item = elements(render()).find(
      (node) =>
        node.type === type && (!label || content(node.props.children as ReactNode).includes(label))
    )
    if (!item) throw new Error(`missing source ${type} ${label}`)
    return item.props
  }
  const click = (label: string) => (find('button', label).onClick as () => void)()
  const select = (index: number, value: string) => {
    const item = elements(render()).filter((node) => node.type === 'select')[index]
    ;(item.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } })
  }
  const settle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const initialize = async () => {
    render()
    if (kind !== 'register') {
      click('读取来源与版本')
      await settle()
      select(0, id)
      if (kind === 'restore') select(1, evidenceId)
    } else {
      const item = elements(render()).find(
        (node) => node.type === 'input' && node.props.type === 'password'
      )
      if (!item) throw new Error('missing URL')
      ;(item.props.onChange as (e: { target: { value: string } }) => void)({
        target: { value: 'https://fixture.invalid/sub' }
      })
    }
  }
  return {
    invoke,
    onBusy,
    onSaved,
    render,
    find,
    click,
    select,
    settle,
    initialize,
    prepare,
    action: { register: '保存订阅来源', update: '手动更新', restore: '使用历史版本' }[kind]
  }
}
describe('One-click subscription source lifecycle', () => {
  it.each(['register', 'update', 'restore'] as const)(
    '%s consumes only the returned preparation once',
    async (kind) => {
      const f = sourcesFixture(kind)
      await f.initialize()
      const gate = Promise.withResolvers<unknown>()
      f.invoke.mockImplementationOnce(() => gate.promise)
      f.click(f.action)
      f.click(f.action)
      expect(f.invoke.mock.calls.filter(([channel]) => channel === f.prepare)).toHaveLength(1)
      expect(f.invoke.mock.calls.some(([channel]) => channel === 'relaySourceExecute')).toBe(false)
      gate.resolve(plan)
      await f.settle()
      expect(
        f.invoke.mock.calls.filter(([channel]) => channel === 'relaySourceExecute')
      ).toHaveLength(1)
      expect(f.invoke).toHaveBeenCalledWith('relaySourceExecute', { evidenceId })
      expect(f.onSaved).toHaveBeenCalledOnce()
    }
  )
  it.each(['register', 'update', 'restore'] as const)(
    '%s cannot execute a late preparation after unmount',
    async (kind) => {
      const f = sourcesFixture(kind)
      await f.initialize()
      const gate = Promise.withResolvers<unknown>()
      f.invoke.mockImplementationOnce(() => gate.promise)
      f.click(f.action)
      unmount()
      gate.resolve(plan)
      await f.settle()
      expect(f.invoke.mock.calls.some(([channel]) => channel === 'relaySourceExecute')).toBe(false)
      expect(f.invoke).toHaveBeenCalledWith('relaySourceCancel', { evidenceId })
      expect(f.onSaved).not.toHaveBeenCalled()
      expect(f.onBusy).toHaveBeenLastCalledWith(false)
    }
  )
  it('permits cancellation before preparation returns and never executes the late proof', async () => {
    const f = sourcesFixture('register')
    await f.initialize()
    const gate = Promise.withResolvers<unknown>()
    f.invoke.mockImplementationOnce(() => gate.promise)
    f.click(f.action)
    expect(f.find('button', '取消本次来源操作').disabled).toBe(false)
    f.click('取消本次来源操作')
    gate.resolve(plan)
    await f.settle()
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'relaySourceExecute')).toBe(false)
    expect(f.invoke).toHaveBeenCalledWith('relaySourceCancel', { evidenceId })
  })
  it('saves the exact staged-download proof from the same update click', async () => {
    const f = sourcesFixture('update')
    await f.initialize()
    const stageId = '00000000-0000-4000-8000-000000000003',
      prior = f.invoke.getMockImplementation()
    if (!prior) throw new Error('missing source fixture')
    let executes = 0
    f.invoke.mockImplementation(async (channel) =>
      channel === 'relaySourceExecute' && ++executes === 1
        ? { status: 'staged', plan: { ...plan, evidenceId: stageId }, warnings: [] }
        : prior(channel)
    )
    f.click(f.action)
    await f.settle()
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'relaySourceExecute')).toEqual([
      ['relaySourceExecute', { evidenceId }],
      ['relaySourceExecute', { evidenceId: stageId }]
    ])
    expect(f.onSaved).toHaveBeenCalledOnce()
  })
  it.each(['cancel', 'unmount', 'selection'] as const)(
    'does not save staged download after %s while the download is waiting',
    async (reason) => {
      const f = sourcesFixture('update')
      await f.initialize()
      const download = Promise.withResolvers<unknown>(),
        prior = f.invoke.getMockImplementation()
      if (!prior) throw new Error('missing source fixture')
      f.invoke.mockImplementation(async (channel) =>
        channel === 'relaySourceExecute' ? download.promise : prior(channel)
      )
      f.click(f.action)
      await f.settle()
      if (reason === 'cancel') f.click('取消本次来源操作')
      else if (reason === 'unmount') unmount()
      else f.select(0, '')
      const stageId = '00000000-0000-4000-8000-000000000003'
      download.resolve({ status: 'staged', plan: { ...plan, evidenceId: stageId }, warnings: [] })
      await f.settle()
      expect(
        f.invoke.mock.calls.filter(([channel]) => channel === 'relaySourceExecute')
      ).toHaveLength(1)
      expect(f.invoke).toHaveBeenCalledWith('relaySourceCancel', { evidenceId: stageId })
      expect(f.onSaved).not.toHaveBeenCalled()
    }
  )
})
