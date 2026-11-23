import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTunRendererApi } from '../renderer/src/components/relay/tun-api'
import { createTunPanelController } from '../renderer/src/components/relay/tun-controller'
import type { TunSessionPreparation, TunSessionState } from '../shared/relay/tun'

const transport = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  expose: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: transport.expose },
  ipcRenderer: transport,
  webUtils: {}
}))
const completeId = '11111111-1111-4111-8111-111111111111',
  preparedId = '22222222-2222-4222-8222-222222222222',
  sessionId = '33333333-3333-4333-8333-333333333333'
const state: TunSessionState = {
  phase: 'idle',
  owned: false,
  pending: false,
  traffic: 'inactive',
  restorationVerified: false,
  protectionVerified: false,
  warnings: []
}
const plan: TunSessionPreparation = {
  version: 1,
  evidenceId: preparedId,
  configurationSHA256: 'a'.repeat(64),
  bundleSHA256: 'b'.repeat(64),
  tunSHA256: 'c'.repeat(64),
  assetsSHA256: 'd'.repeat(64),
  helperRevision: 'e'.repeat(64),
  networkRevision: 'f'.repeat(64),
  evidenceSHA256: '1'.repeat(64),
  createdAt: 1000,
  expiresAt: 61000,
  readyForConfirmation: true,
  canApply: false,
  active: false,
  runtimeVerified: false,
  protectionVerified: false,
  effects: { device: 'utun', autoRoute: true, dnsHijack: false },
  issues: []
}
let bridge: {
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>
    on(channel: string, listener: () => void): () => void
  }
}
beforeAll(async () => {
  const world: { electron?: typeof bridge } = {}
  vi.stubGlobal('window', world)
  await import('./index')
  bridge = transport.expose.mock.calls.find(([name]) => name === 'electron')?.[1] ?? world.electron
  if (!bridge) throw new Error('actual preload bridge missing')
})
afterAll(() => vi.unstubAllGlobals())
describe('TUN real preload and renderer dispatch with an injected main transport', () => {
  it('forwards the saved-profile TUN preparation intent through the real preload allowlist', async () => {
    const selection = { id: completeId, sha256: 'a'.repeat(64) }
    transport.invoke.mockReset().mockResolvedValue({ evidenceId: completeId })
    await expect(
      bridge.ipcRenderer.invoke('relayTunConfigurationPrepare', selection)
    ).resolves.toEqual({ evidenceId: completeId })
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
      'relayTunConfigurationPrepare',
      selection
    )
  })
  it('carries checked proof through prepare/start/inspect/stop and renders recovery facts without privileged inputs', async () => {
    transport.invoke.mockReset().mockImplementation(async (channel: string) => {
      if (channel === 'relayTunStatus') return { session: state, helper: 'ready', warnings: [] }
      if (channel === 'relayTunPrepare') return plan
      if (channel === 'relayTunStart')
        return {
          status: 'started',
          state: { ...state, phase: 'active', owned: true, sessionId, traffic: 'forwarding' }
        }
      if (channel === 'relayTunInspect')
        return { ...state, phase: 'uncertain', owned: true, sessionId, traffic: 'unconfirmed' }
      if (channel === 'relayTunStop')
        return {
          status: 'restored',
          state: { ...state, phase: 'restored', restorationVerified: true }
        }
      return undefined
    })
    const api = createTunRendererApi((channel, ...args) =>
        bridge.ipcRenderer.invoke(channel, ...args)
      ),
      control = createTunPanelController({
        api,
        evidence: () => completeId,
        busy: () => false,
        onBusy: () => {},
        now: () => 1000
      })
    await control.run('status')
    await control.run('prepare')
    await control.run('start')
    expect(control.snapshot().status?.session.traffic).toBe('forwarding')
    await control.run('inspect')
    expect(control.snapshot().status?.session.traffic).toBe('unconfirmed')
    await control.run('stop')
    expect(control.snapshot().status?.session.restorationVerified).toBe(true)
    await api.relayTunCancel({ evidenceId: preparedId })
    expect(transport.invoke.mock.calls).toEqual([
      ['relayTunStatus'],
      ['relayTunPrepare', { evidenceId: completeId }],
      ['relayTunStart', { evidenceId: preparedId }],
      ['relayTunInspect'],
      ['relayTunStop', { sessionId }],
      ['relayTunCancel', { evidenceId: preparedId }]
    ])
  })
  it('passes explicit ordinary recovery through the real allowlist with just its opaque session identity', async () => {
    const ordinaryRecovery = { sessionId, phase: 'failed', reason: 'listener' }
    const failed = { status: 'failed', state: { ...state, phase: 'released' }, ordinaryRecovery }
    transport.invoke.mockReset().mockResolvedValue(failed)
    const api = createTunRendererApi((channel, ...args) =>
      bridge.ipcRenderer.invoke(channel, ...args)
    )
    expect(await api.relayTunRecoverOrdinary({ sessionId })).toEqual(failed)
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('relayTunRecoverOrdinary', {
      sessionId
    })
  })
  it('allows only the dedicated TUN update event and rejects invented privilege operations', async () => {
    const unsubscribe = bridge.ipcRenderer.on('relayTunUpdated', () => {})
    expect(transport.on).toHaveBeenCalledWith('relayTunUpdated', expect.any(Function))
    unsubscribe()
    expect(transport.removeListener).toHaveBeenCalledWith('relayTunUpdated', expect.any(Function))
    await expect(bridge.ipcRenderer.invoke('relayTunInstallAsRoot')).rejects.toThrow(
      'Invalid invoke channel'
    )
    await expect(bridge.ipcRenderer.invoke('relayTunRestartClash')).rejects.toThrow(
      'Invalid invoke channel'
    )
  })
  it('carries only the dedicated rules selections without exposing Native pipe operations', async () => {
    transport.invoke.mockReset().mockResolvedValue({ status: 'unsupported', sessionId })
    const read = { sessionId },
      change = {
        sessionId,
        configurationRevision: 'a'.repeat(64),
        rulesSHA256: 'b'.repeat(64),
        index: 0,
        disabled: false
      }
    await bridge.ipcRenderer.invoke('relayTunRulesRead', read)
    await bridge.ipcRenderer.invoke('relayTunRuleChange', change)
    expect(transport.invoke.mock.calls).toEqual([
      ['relayTunRulesRead', read],
      ['relayTunRuleChange', change]
    ])
    for (const channel of ['relayTunRulesPrepare', 'relayTunRulesCommit', 'relayTunRulesWrite'])
      await expect(bridge.ipcRenderer.invoke(channel, change)).rejects.toThrow(
        'Invalid invoke channel'
      )
    expect(transport.invoke).toHaveBeenCalledTimes(2)
  })
})
