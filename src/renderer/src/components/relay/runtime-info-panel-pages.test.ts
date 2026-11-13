import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeObservation } from './runtime-info'
import { RelayRuntimeInfoPanel } from './runtime-info-panel'

vi.mock('@renderer/hooks/use-app-config', () => ({
  useAppConfig: () => ({ appConfig: {}, patchAppConfig: vi.fn() })
}))

const fixture = vi.hoisted(() => ({ seedNextState: true, snapshot: undefined as unknown }))
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return {
    ...actual,
    useState<T>(initial?: T | (() => T)) {
      if (fixture.seedNextState) {
        fixture.seedNextState = false
        return actual.useState(fixture.snapshot as T)
      }
      return actual.useState(initial)
    }
  }
})

const snapshot = {
  state: {
    phase: 'running',
    pending: false,
    owned: true,
    hasRecord: true,
    uncertain: false,
    instanceId: '00000000-0000-0000-0000-000000000032',
    configurationRevision: 'a'.repeat(64),
    pid: 123,
    httpPort: 18191,
    mode: 'rule',
    traffic: 'listening',
    groups: [],
    systemProxyChanged: false,
    liveGuardEnabled: false,
    warnings: []
  },
  info: {
    process: { phase: 'running' },
    interfaces: [{ name: 'interface-fixture', addresses: [] }],
    traffic: { download: 1024, upload: 512 },
    externalIpLookupWired: false,
    remoteLatencyProbeWired: false,
    warnings: []
  },
  connections: {
    connections: [{ id: 'one', metadata: { host: 'route.example' } }],
    download: 1024,
    upload: 512
  },
  logs: { sequence: 1, lines: [{ sequence: 1, text: 'LOG-FIXTURE' }] },
  sampledAt: 1000
} satisfies RuntimeObservation

beforeEach(() => {
  fixture.seedNextState = true
  fixture.snapshot = undefined
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null },
    electron: { ipcRenderer: { invoke: vi.fn() } }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('Runtime module pages', () => {
  it('does not invent a zero-traffic topology when the owned core has no connection snapshot', () => {
    fixture.snapshot = {
      ...snapshot,
      connections: undefined,
      connectionRates: new Map(),
      closedConnections: []
    }
    const html = renderToStaticMarkup(
      createElement(RelayRuntimeInfoPanel, { busy: false, onBusy: vi.fn(), view: 'network' })
    )
    expect(html).not.toContain('0 B')
    expect(html).toContain('interface-fixture')
    expect(window.electron.ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it.each(['connections', 'logs', 'network'] as const)(
    'shows only the %s controls before the first read',
    (view) => {
      const onBusy = vi.fn()
      const html = renderToStaticMarkup(
        createElement(RelayRuntimeInfoPanel, { busy: false, onBusy, view, logsFirst: true })
      )
      expect(html).toContain('暂停刷新')
      expect(html).toContain('正在读取')
      expect(html.includes('关闭本次实例全部连接')).toBe(view === 'connections')
      expect(html.includes('筛选日志文本')).toBe(view === 'logs')
      expect(html.includes('<div hidden=""><section class="relay-probes"')).toBe(view !== 'network')
      expect(onBusy).not.toHaveBeenCalled()
      expect(window.electron.ipcRenderer.invoke).not.toHaveBeenCalled()
    }
  )

  it.each(['connections', 'logs', 'network'] as const)(
    'does not mix other module results into the %s snapshot',
    (view) => {
      fixture.snapshot = { ...snapshot, connectionRates: new Map(), closedConnections: [] }
      const html = renderToStaticMarkup(
        createElement(RelayRuntimeInfoPanel, { busy: false, onBusy: vi.fn(), view })
      )
      expect(html).toContain('核心状态：running')
      expect(html.includes('route.example')).toBe(view === 'connections')
      expect(html.includes('筛选目标、进程或代理链')).toBe(view === 'connections')
      expect(html.includes('LOG-FIXTURE')).toBe(view === 'logs')
      expect(html.includes('interface-fixture')).toBe(view === 'network')
      expect(html.includes('此页只统计经过 Relay 的连接')).toBe(view === 'network')
      if (view === 'network') expect(html).toContain('Relay 代理端口：18191')
      expect(html.includes('关闭本次实例全部连接')).toBe(view === 'connections')
      expect(window.electron.ipcRenderer.invoke).not.toHaveBeenCalled()
    }
  )
})
