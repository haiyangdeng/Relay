import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import type { LocalRuntimeCapture } from '../core/local-proxy-service'
import type { GuardManagementSnapshot } from '../../../shared/relay/guard-management'
import { createTerminalCLIService, type TerminalLeaseChannel } from './terminal-cli-service'
import { createGuardNativeBridge } from './native-addon'

type Event = Awaited<ReturnType<TerminalLeaseChannel['next']>>
const id = '71cbc2e2-d972-4d44-b929-d4fab60a6947'
const otherID = '393b6a18-fccd-4b82-a37b-0d8c2451f887'
const instanceID = '9844d805-3802-4db3-b4cc-fd1314b17773'
const configuration = '{}'
const digest = createHash('sha256').update(configuration).digest('hex')
const snapshot: GuardManagementSnapshot = {
  phase: 'idle',
  pending: false,
  systemOperationAttempted: false,
  protectionVerified: false,
  runtimeEnforcement: 'notVerified',
  scopedPolicy: { phase: 'prepared', instanceID, configurationSHA256: digest }
}
const cleared: GuardManagementSnapshot = { ...snapshot, scopedPolicy: { phase: 'unbound' } }

function fixture() {
  let deliver: ((event: Event) => void) | undefined
  const pending: Event[] = []
  const push = (event: Event): void => {
    if (!deliver) {
      pending.push(event)
      return
    }
    const receive = deliver
    deliver = undefined
    receive(event)
  }
  const order: string[] = []
  const channel = {
    start: vi.fn(async () => true),
    next: vi.fn(
      () =>
        new Promise<Event>((resolve) => {
          if (pending.length) resolve(pending.shift() ?? null)
          else deliver = resolve
        })
    ),
    respond: vi.fn<TerminalLeaseChannel['respond']>(async () => true),
    confirm: vi.fn<TerminalLeaseChannel['confirm']>(async () => true),
    close: vi.fn(async () => {
      order.push('control')
    }),
    stop: vi.fn(async () => {})
  }
  let current = true
  const capture: LocalRuntimeCapture = {
    snapshot: { instanceId: instanceID, configuration, revision: 'fixture', proxyPort: 12345 },
    capturedAt: 0,
    isCurrent: () => current,
    isOwnerLive: () => current,
    assertOwner: vi.fn(async () => {
      if (!current) throw new Error('lost owner')
    })
  }
  const bridge = {
    verifyScoped: vi.fn(async () => snapshot),
    revokeScoped: vi.fn(async () => {
      order.push('native')
      return cleared
    })
  }
  const broker = {
    port: 23456,
    proxyURL: 'https://relay:fixture@127.0.0.1:23456',
    ca: 'fixture-ca',
    isAlive: () => current,
    close: vi.fn(async () => {
      order.push('broker')
    })
  }
  const makeBroker = vi.fn(async () => broker)
  const assertIdle = vi.fn()
  const service = createTerminalCLIService({
    channel,
    bridge,
    owned: () => ({ instanceId: instanceID, pid: 9999 }),
    assertIdle,
    capture: async () => ({ status: 'captured', capture }),
    broker: makeBroker
  })
  return {
    service,
    channel,
    bridge,
    push,
    order,
    broker,
    makeBroker,
    assertIdle,
    loseOwner: () => {
      current = false
    }
  }
}

describe('Terminal CLI lease orchestration with offline substitutes', () => {
  it('leaves the transport idle when its release gate is closed', async () => {
    const f = fixture()
    f.channel.start.mockResolvedValueOnce(false)
    await f.service.start()
    expect(f.channel.next).not.toHaveBeenCalled()
    expect(f.bridge.verifyScoped).not.toHaveBeenCalled()
  })

  it('rechecks the Core for commit and revokes the broker before closing the lease', async () => {
    const f = fixture()
    const loop = f.service.start()
    f.push({ kind: 'request', id })
    await vi.waitFor(() =>
      expect(f.channel.respond).toHaveBeenCalledWith(id, {
        proxyURL: f.broker.proxyURL,
        caPEM: f.broker.ca
      })
    )
    expect(f.service.isBlocking()).toBe(true)
    expect(f.channel.confirm).not.toHaveBeenCalled()
    f.push({ kind: 'commit', id })
    await vi.waitFor(() => expect(f.channel.confirm).toHaveBeenCalledWith(id, true))
    expect(f.bridge.verifyScoped.mock.calls).toHaveLength(2)
    f.push({ kind: 'closed', id: otherID })
    f.push({ kind: 'closed', id })
    await vi.waitFor(() => expect(f.service.isBlocking()).toBe(false))
    expect(f.channel.close).toHaveBeenCalledTimes(1)
    expect(f.order[0]).toBe('broker')
    expect(f.order.indexOf('control')).toBeLessThan(f.order.indexOf('native'))
    f.push(null)
    await loop
  })

  it('denies startup while an existing app operation owns the slot', async () => {
    const f = fixture()
    f.assertIdle.mockImplementation(() => {
      throw new Error('busy')
    })
    const loop = f.service.start()
    f.push({ kind: 'request', id })
    await vi.waitFor(() => expect(f.channel.respond).toHaveBeenCalledWith(id, null))
    expect(f.makeBroker).not.toHaveBeenCalled()
    expect(f.service.isBlocking()).toBe(false)
    f.push(null)
    await loop
  })

  it('retires a late native proof after EOF without offering a proxy', async () => {
    const f = fixture()
    let resolveProof: (value: GuardManagementSnapshot) => void = () => {}
    f.bridge.verifyScoped.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProof = resolve
        })
    )
    const loop = f.service.start()
    f.push({ kind: 'request', id })
    await vi.waitFor(() => expect(f.bridge.verifyScoped).toHaveBeenCalledTimes(1))
    f.push({ kind: 'closed', id })
    await vi.waitFor(() => expect(f.channel.close).toHaveBeenCalledTimes(1))
    resolveProof(snapshot)
    await vi.waitFor(() => expect(f.service.isBlocking()).toBe(false))
    expect(f.channel.respond).not.toHaveBeenCalled()
    expect(f.bridge.revokeScoped).toHaveBeenCalledTimes(1)
    f.push(null)
    await loop
  })

  it('does not confirm a start after Core ownership is lost', async () => {
    const f = fixture()
    const loop = f.service.start()
    f.push({ kind: 'request', id })
    await vi.waitFor(() => expect(f.channel.respond).toHaveBeenCalledTimes(1))
    f.loseOwner()
    f.push({ kind: 'commit', id })
    await vi.waitFor(() => expect(f.service.isBlocking()).toBe(false))
    expect(f.channel.confirm).not.toHaveBeenCalled()
    expect(f.order[0]).toBe('broker')
    f.push(null)
    await loop
  })

  it('retains ownership until the native proof is confirmed cleared', async () => {
    const f = fixture()
    f.bridge.revokeScoped.mockResolvedValueOnce(snapshot)
    const loop = f.service.start()
    f.push({ kind: 'request', id })
    await vi.waitFor(() => expect(f.channel.respond).toHaveBeenCalledTimes(1))
    expect(await f.service.requestClose()).toBe(false)
    expect(f.service.isBlocking()).toBe(true)
    expect(await f.service.requestClose()).toBe(true)
    expect(f.service.isBlocking()).toBe(false)
    f.push(null)
    await loop
  })

  it('can close an already verified native host after its on-disk resource becomes unavailable', async () => {
    const terminalLease = vi.fn(async () => '{}')
    const request = vi.fn(async (json: string) => {
      const { id, action } = JSON.parse(json)
      return JSON.stringify({ version: 1, id, action, ...cleared })
    })
    const inspect = vi.fn(async () => ({
      path: '/fixture/RelayGuard.node',
      trusted: true as const,
      resourceSHA256: 'a'.repeat(64)
    }))
    const bridge = createGuardNativeBridge({
      inspect,
      require: () => ({ terminalLease, request, invalidateIntents: () => {} })
    })
    await bridge.terminalLease('{"version":1,"action":"start"}')
    inspect.mockRejectedValue(new Error('changed resource'))
    await expect(bridge.terminalLease('{"version":1,"action":"confirm"}')).rejects.toThrow()
    await bridge.terminalLease('{"version":1,"action":"close"}')
    await bridge.terminalLease('{"version":1,"action":"stop"}')
    await expect(bridge.revokeScoped()).resolves.toEqual(cleared)
    expect(terminalLease).toHaveBeenCalledTimes(3)
  })
})
