import { isValidElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSystemProxyDraft } from '../../../../shared/relay/system-proxy-draft'
import { RelaySystemProxyPanel } from './system-proxy-panel'

// Run the real panel's callbacks/effects with the same small injected-hook
// harness used by direct-backup-update-actions; no browser or native IPC.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  dirty: false,
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[]
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
        const value =
          typeof next === 'function' ? (next as (old: T) => T)(hooks.slots[at] as T) : next
        if (!Object.is(value, hooks.slots[at])) hooks.dirty = true
        hooks.slots[at] = value
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
    if (!prior || deps.some((value, index) => !Object.is(value, prior[index])))
      hooks.effects.push(effect)
    hooks.slots[at] = deps
  }
}))
vi.mock('@heroui/react', () => ({
  Button: 'relay-button',
  Chip: 'relay-chip',
  Switch: 'relay-switch',
  Tab: 'relay-tab',
  Tabs: 'relay-tabs'
}))
vi.mock('@renderer/components/base/base-setting-card', () => ({ default: 'relay-card' }))

function elements(node: ReactNode): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : ''
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  hooks.slots = []
  hooks.cursor = 0
  hooks.dirty = false
  hooks.effects = []
  hooks.cleanups = []
})
afterEach(() => {
  for (const cleanup of hooks.cleanups.splice(0)) cleanup()
  vi.unstubAllGlobals()
})
function fixture(ports?: { http: number; mixed: number }) {
  let tree: ReactNode,
    panelBusy = false
  const state = {
    busy: false,
    active: true,
    draft: { document: defaultSystemProxyDraft(), exists: true, revision: 'a'.repeat(64) },
    report: {
      status: 'inactive',
      canRestore: false,
      canApply: false,
      services: [{ id: 'wifi', name: 'Wi-Fi', enabled: true }],
      warnings: []
    }
  }
  const events = new Map<string, () => void>(),
    domEvents = new Map<string, () => void>()
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
    if (channel === 'relaySystemProxyDraftRead') return structuredClone(state.draft)
    if (channel === 'relaySystemProxyInspect') return structuredClone(state.report)
    if (channel === 'relayEnsureSystemProxyListener') return { httpPort: 18191 }
    throw new Error(`Unexpected IPC: ${channel}`)
  })
  vi.stubGlobal('window', {
    electron: {
      ipcRenderer: {
        invoke,
        on: (name: string, callback: () => void) => {
          events.set(name, callback)
          return () => {
            events.delete(name)
          }
        }
      }
    },
    addEventListener: (name: string, callback: () => void) => {
      domEvents.set(name, callback)
    },
    removeEventListener: (name: string) => {
      domEvents.delete(name)
    }
  })
  function render() {
    hooks.dirty = false
    hooks.cursor = 0
    tree = RelaySystemProxyPanel({
      defaultSettings: ports && { port: ports.http },
      mixedPort: ports?.mixed,
      busy: state.busy || panelBusy,
      active: state.active,
      onBusy: (value) => {
        panelBusy = value
        hooks.dirty = true
      }
    })
    for (const effect of hooks.effects.splice(0)) {
      const cleanup = effect()
      if (cleanup) hooks.cleanups.push(cleanup)
    }
  }
  async function flush() {
    for (let index = 0; index < 20; index++) {
      render()
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!hooks.dirty) return
    }
    throw new Error('Panel did not settle')
  }
  function find(label: string) {
    const found =
      elements(tree).find((item) => item.props['aria-label'] === label) ??
      elements(tree).find(
        (item) => item.type === 'relay-button' && text(item.props.children as ReactNode) === label
      )
    if (!found) throw new Error(`Missing control: ${label}`)
    return found.props
  }
  function emit(name: string) {
    events.get(name)?.()
  }
  function calls(channel: string) {
    return invoke.mock.calls.filter(([name]) => name === channel).length
  }
  function onlyReads() {
    expect(
      invoke.mock.calls.every(([channel]) =>
        ['relaySystemProxyDraftRead', 'relaySystemProxyInspect'].includes(channel)
      )
    ).toBe(true)
  }
  return { state, invoke, events, domEvents, flush, find, emit, calls, onlyReads }
}

describe('System proxy panel visibility lifecycle (injected hooks/IPC)', () => {
  it('displays the configured mixed port for SOCKS and the HTTP port for HTTP alone or PAC', async () => {
    const f = fixture({ http: 7892, mixed: 7890 })
    f.state.draft.document.socks = true
    await f.flush()
    expect(f.find('代理端口').value).toBe(7890)
    ;(f.find('代理模式').onSelectionChange as (key: string) => void)('pac')
    await f.flush()
    expect(f.find('代理端口').value).toBe(7892)
    ;(f.find('代理模式').onSelectionChange as (key: string) => void)('manual')
    await f.flush()
    ;(f.find('同时启用 SOCKS').onChange as (event: unknown) => void)({ target: { checked: false } })
    await f.flush()
    expect(f.find('代理端口').value).toBe(7892)
    f.onlyReads()
  })
  it('recovers the unchanged active panel after hide/show with one read and no writes', async () => {
    const f = fixture()
    await f.flush()
    expect(f.find('Relay 系统代理').isDisabled).toBe(false)
    f.emit('relayBackupPreparationsInvalidated')
    await f.flush()
    expect(f.find('Relay 系统代理').isDisabled).toBe(true)
    expect(f.calls('relaySystemProxyInspect')).toBe(1)
    f.emit('relayWorkspaceVisible')
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(2)
    expect(f.find('Relay 系统代理').isDisabled).toBe(false)
    f.emit('relayWorkspaceVisible')
    f.emit('relayWorkspaceVisible')
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(2)
    f.onlyReads()
  })
  it('queues one visibility read while busy and waits until the parent operation finishes', async () => {
    const f = fixture()
    await f.flush()
    f.state.busy = true
    f.emit('relayBackupPreparationsInvalidated')
    f.emit('relayWorkspaceVisible')
    f.emit('relayWorkspaceVisible')
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(1)
    f.state.busy = false
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(2)
    expect(f.find('Relay 系统代理').isDisabled).toBe(false)
    f.onlyReads()
  })
  it('preserves a dirty draft and invalid revision until the explicit discard/read action', async () => {
    const f = fixture()
    await f.flush()
    ;(f.find('代理主机').onChange as (event: unknown) => void)({ target: { value: 'localhost' } })
    await f.flush()
    f.state.draft = {
      document: { ...defaultSystemProxyDraft(), socks: true },
      exists: true,
      revision: 'b'.repeat(64)
    }
    f.emit('relayBackupPreparationsInvalidated')
    f.emit('relayWorkspaceVisible')
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(2)
    expect(f.calls('relaySystemProxyDraftRead')).toBe(1)
    expect(f.find('代理主机').value).toBe('localhost')
    expect(f.find('同时启用 SOCKS').checked).toBe(false)
    expect(f.find('保存设置').isDisabled).toBe(true)
    expect(f.find('应用设置').isDisabled).toBe(true)
    ;(f.find('放弃修改并重读设置').onPress as () => void)()
    await f.flush()
    expect(f.find('代理主机').value).toBe('127.0.0.1')
    expect(f.find('同时启用 SOCKS').checked).toBe(true)
    expect(f.find('应用设置').isDisabled).toBe(false)
    f.onlyReads()
  })
  it('waits for an invalidated in-flight read before reading the newly visible state', async () => {
    const f = fixture(),
      held = deferred<unknown>()
    f.invoke.mockImplementationOnce(async () => held.promise)
    await f.flush()
    f.emit('relayBackupPreparationsInvalidated')
    f.emit('relayWorkspaceVisible')
    await f.flush()
    expect(f.calls('relaySystemProxyDraftRead')).toBe(1)
    expect(f.calls('relaySystemProxyInspect')).toBe(0)
    held.resolve({ ...f.state.draft, document: { ...f.state.draft.document, socks: true } })
    await f.flush()
    expect(f.calls('relaySystemProxyDraftRead')).toBe(2)
    expect(f.calls('relaySystemProxyInspect')).toBe(1)
    expect(f.find('同时启用 SOCKS').checked).toBe(false)
    expect(f.find('Relay 系统代理').isDisabled).toBe(false)
    f.onlyReads()
  })
  it('updates the switch on a main-process change without rereading or writing system settings', async () => {
    const f = fixture()
    await f.flush()
    expect(f.find('Relay 系统代理').isSelected).toBe(false)
    f.invoke.mockImplementation(async (channel) => {
      if (channel !== 'relaySystemProxyState') throw new Error('Unexpected ' + channel)
      return {
        pending: false,
        observed: true,
        report: { ...f.state.report, status: 'active', recordID: 'record', canRestore: true }
      }
    })
    f.emit('controledMihomoConfigUpdated')
    await f.flush()
    expect(f.find('Relay 系统代理').isSelected).toBe(true)
    expect(f.find('Relay 系统代理').isDisabled).toBe(false)
    expect(f.calls('relaySystemProxyInspect')).toBe(1)
    expect(f.calls('relaySystemProxyExecute')).toBe(0)
  })
  it('applies system proxy through active TUN without starting an ordinary core', async () => {
    const f = fixture()
    await f.flush()
    const read = f.invoke.getMockImplementation()
    if (!read) throw new Error('Missing fixture')
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayEnsureSystemProxyListener') return { httpPort: 7892 }
      if (channel === 'relaySystemProxyPrepare')
        return {
          action: 'apply',
          evidenceId: 'plan',
          report: { ...f.state.report, canApply: true }
        }
      if (channel === 'relaySystemProxyExecute')
        return {
          status: 'applied',
          report: { ...f.state.report, status: 'applied', recordID: 'record' },
          warnings: []
        }
      if (channel === 'relaySystemProxyCancel') return undefined
      return read(channel)
    })
    ;(f.find('应用设置').onPress as () => void)()
    await f.flush()
    expect(f.calls('relaySystemProxyExecute')).toBe(1)
    expect(f.calls('relayLocalProxyState')).toBe(0)
    expect(f.invoke).toHaveBeenCalledWith(
      'relaySystemProxyPrepare',
      expect.objectContaining({ port: 7892 })
    )
  })

  it('accepts the first click during its initial read and applies once after settings arrive', async () => {
    const f = fixture(),
      nativeRead = deferred<unknown>()
    const read = f.invoke.getMockImplementation()
    if (!read) throw new Error('Missing fixture')
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relaySystemProxyInspect') return nativeRead.promise
      if (channel === 'relayEnsureSystemProxyListener') return { httpPort: 7892 }
      if (channel === 'relaySystemProxyPrepare')
        return {
          action: 'apply',
          evidenceId: 'proof',
          report: { ...f.state.report, canApply: true }
        }
      if (channel === 'relaySystemProxyExecute')
        return {
          status: 'applied',
          report: { ...f.state.report, status: 'applied', recordID: 'r', canRestore: true },
          warnings: []
        }
      return read(channel)
    })
    await f.flush()
    expect(f.find('Relay 系统代理').isDisabled).toBe(false)
    const enable = f.find('Relay 系统代理').onValueChange as (value: boolean) => void
    enable(true)
    enable(true)
    await f.flush()
    expect(f.find('Relay 系统代理').isDisabled).toBe(true)
    expect(f.calls('relaySystemProxyPrepare')).toBe(0)
    nativeRead.resolve(f.state.report)
    await f.flush()
    expect(f.find('Relay 系统代理').isSelected).toBe(true)
    expect(
      f.invoke.mock.calls.filter(([channel]) => channel === 'relayEnsureSystemProxyListener')
    ).toEqual([['relayEnsureSystemProxyListener']])
    expect(f.calls('relaySystemProxyExecute')).toBe(1)
  })

  it('allows one click while opening a listener and can retry directly after a startup error', async () => {
    const f = fixture(),
      waiting = deferred<unknown>()
    await f.flush()
    const read = f.invoke.getMockImplementation()
    if (!read) throw new Error('Missing fixture')
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relayEnsureSystemProxyListener') return waiting.promise
      return read(channel)
    })
    const enable = f.find('Relay 系统代理').onValueChange as (value: boolean) => void
    enable(true)
    enable(true)
    await f.flush()
    expect(f.find('Relay 系统代理').isDisabled).toBe(true)
    expect(f.calls('relayEnsureSystemProxyListener')).toBe(1)
    waiting.resolve(undefined)
    await f.flush()
    expect(f.find('Relay 系统代理').isDisabled).toBe(false)
    expect(f.calls('relaySystemProxyExecute')).toBe(0)
  })
  it('does not replay a cancelled apply when visibility returns during confirmation', async () => {
    const f = fixture(),
      execution = deferred<unknown>()
    await f.flush()
    const read = f.invoke.getMockImplementation()
    if (!read) throw new Error('Missing read fixture')
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relaySystemProxyPrepare')
        return {
          action: 'apply',
          evidenceId: 'plan',
          report: { ...f.state.report, canApply: true }
        }
      if (channel === 'relaySystemProxyExecute') return execution.promise
      return read(channel)
    })
    ;(f.find('应用设置').onPress as () => void)()
    await f.flush()
    expect(f.calls('relaySystemProxyExecute')).toBe(1)
    f.emit('relayBackupPreparationsInvalidated')
    f.emit('relayWorkspaceVisible')
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(1)
    const callsBeforeResume = f.invoke.mock.calls.length
    execution.resolve({ status: 'cancelled', warnings: [] })
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(2)
    const settledCalls = f.invoke.mock.calls.length
    f.emit('relayWorkspaceVisible')
    await f.flush()
    expect(f.invoke.mock.calls).toHaveLength(settledCalls)
    expect(f.calls('relaySystemProxyPrepare')).toBe(1)
    expect(f.calls('relaySystemProxyExecute')).toBe(1)
    expect(
      f.invoke.mock.calls
        .slice(callsBeforeResume)
        .every(([channel]) =>
          ['relaySystemProxyDraftRead', 'relaySystemProxyInspect'].includes(channel)
        )
    ).toBe(true)
    expect(f.find('Relay 系统代理').isDisabled).toBe(false)
  })
  it('leaves a failed visibility read explicit instead of retrying on repeated show events', async () => {
    const f = fixture()
    await f.flush()
    const read = f.invoke.getMockImplementation()
    if (!read) throw new Error('Missing read fixture')
    f.invoke.mockImplementation(async (channel) => {
      if (channel === 'relaySystemProxyInspect') throw new Error('Inspection unavailable')
      return read(channel)
    })
    f.emit('relayBackupPreparationsInvalidated')
    f.emit('relayWorkspaceVisible')
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(2)
    expect(f.find('Relay 系统代理').isDisabled).toBe(true)
    f.emit('relayWorkspaceVisible')
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(2)
    f.onlyReads()
  })
  it('does not read an inactive panel and removes all subscriptions when unmounted', async () => {
    const f = fixture()
    await f.flush()
    f.state.active = false
    f.emit('relayBackupPreparationsInvalidated')
    f.emit('relayWorkspaceVisible')
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(1)
    f.state.active = true
    await f.flush()
    expect(f.calls('relaySystemProxyInspect')).toBe(2)
    expect(f.events.has('relayWorkspaceVisible')).toBe(true)
    for (const cleanup of hooks.cleanups.splice(0)) cleanup()
    expect(f.events.size).toBe(0)
    expect(f.domEvents.size).toBe(0)
    f.emit('relayWorkspaceVisible')
    expect(f.calls('relaySystemProxyInspect')).toBe(2)
    f.onlyReads()
  })
})
