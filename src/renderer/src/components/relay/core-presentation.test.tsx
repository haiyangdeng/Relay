import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import type { TunStatus } from '../../../../shared/relay/tun'
import {
  corePresentationKey,
  readCorePresentation,
  RelayCoreStatus,
  type CorePresentationSnapshot
} from './core-presentation'
import { RelayOverviewPanel } from './overview-panel'

const idle: LocalProxyState = {
  phase: 'idle',
  pending: false,
  owned: false,
  hasRecord: false,
  uncertain: false,
  traffic: 'inactive',
  groups: [],
  warnings: [],
  systemProxyChanged: false,
  liveGuardEnabled: false
}
const ordinary: LocalProxyState = {
  ...idle,
  owned: true,
  phase: 'running',
  traffic: 'listening',
  httpPort: 17800
}
const stoppedTun: TunStatus = {
  helper: 'ready',
  warnings: [],
  session: {
    owned: false,
    pending: false,
    phase: 'idle',
    traffic: 'inactive',
    restorationVerified: false,
    protectionVerified: false,
    warnings: []
  }
}
const managed: TunStatus = {
  ...stoppedTun,
  session: {
    ...stoppedTun.session,
    owned: true,
    phase: 'active',
    traffic: 'forwarding',
    sessionId: 'b9ee3e5f-191b-4bf9-8618-1ef392478ee9'
  }
}
function renderPresentation(snapshot: CorePresentationSnapshot) {
  const overview = renderToStaticMarkup(
    <SWRConfig value={{ provider: () => new Map(), fallback: { [corePresentationKey]: snapshot } }}>
      <MemoryRouter>
        <RelayOverviewPanel active />
      </MemoryRouter>
    </SWRConfig>
  )
  const sidebar = renderToStaticMarkup(
    <RelayCoreStatus {...snapshot} sidebar version="test-version" />
  )
  return { overview, sidebar }
}

afterEach(() => vi.unstubAllGlobals())

describe('core owner presentation', () => {
  it('shows the current managed handoff endpoint in both places', () => {
    const views = renderPresentation({ local: idle, tun: { ...managed, httpPort: 19234 } })
    for (const html of Object.values(views)) {
      expect(html).toContain('TUN 托管 · 127.0.0.1:19234')
      expect(html).not.toContain('尚未运行')
    }
    expect(views.sidebar).not.toContain('test-version')
  })
  it('shows a forwarding managed session without claiming an unobserved port', () => {
    for (const html of Object.values(
      renderPresentation({ local: { ...idle, httpPort: 17800 }, tun: managed })
    )) {
      expect(html).toContain('TUN 托管')
      expect(html).not.toContain('127.0.0.1:')
    }
  })
  it('retains the ordinary running endpoint and sidebar version after TUN stops', () => {
    const { overview, sidebar } = renderPresentation({ local: ordinary, tun: stoppedTun })
    expect(overview).toContain('运行中 · 127.0.0.1:17800')
    expect(sidebar).toContain('test-version')
    expect(overview).not.toContain('TUN 托管')
  })
  it('keeps unobserved, transitional, conflicting and idle snapshots distinct', () => {
    const uncertain: TunStatus = {
      ...managed,
      session: { ...managed.session, phase: 'uncertain', traffic: 'unconfirmed' }
    }
    const pending: TunStatus = { ...managed, session: { ...managed.session, pending: true } }
    const cases: [CorePresentationSnapshot, string][] = [
      [{ local: idle }, '待读取运行状态'],
      [{ local: idle, tun: uncertain }, '运行状态待核对'],
      [{ local: ordinary, tun: managed }, '运行状态待核对'],
      [{ local: idle, tun: { ...managed, helper: 'unconfirmed' } }, '运行状态待核对'],
      [{ local: idle, tun: pending }, '操作进行中'],
      [{ local: idle, tun: stoppedTun }, '尚未运行']
    ]
    for (const [snapshot, expected] of cases)
      for (const html of Object.values(renderPresentation(snapshot)))
        expect(html).toContain(expected)
  })
  it('can enter the overview before the first sidebar sample and drops unreadable TUN observations', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce(managed)
      .mockResolvedValueOnce(idle)
      .mockRejectedValueOnce(new Error('unavailable'))
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    expect(await readCorePresentation()).toEqual({ local: idle, tun: managed })
    expect(await readCorePresentation()).toEqual({ local: idle, tun: undefined })
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayLocalProxyState',
      'relayTunStatus',
      'relayLocalProxyState',
      'relayTunStatus'
    ])
  })
})
