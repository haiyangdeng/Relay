import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { GuardManagementSnapshot } from '../../../shared/relay/guard-management'
import { createGuardManagementService } from './management-service'
import {
  createGuardNativeBridge,
  GuardNativeUnavailable,
  type GuardNativeBridge
} from './native-addon'

const active: GuardManagementSnapshot = {
  phase: 'configurationEnabled',
  pending: false,
  systemOperationAttempted: false,
  protectionVerified: false,
  runtimeEnforcement: 'notVerified',
  configuration: { exists: true, owned: true, enabled: true, revision: 'enabled' },
  policy: {
    phase: 'ready',
    instanceID: 'fixture',
    configurationSHA256: 'a'.repeat(64)
  }
}
const disabled: GuardManagementSnapshot = {
  ...active,
  phase: 'configurationDisabled',
  configuration: { exists: true, owned: true, enabled: false, revision: 'disabled' },
  policy: { phase: 'unbound' }
}

function fixture() {
  const request = vi.fn<GuardNativeBridge['request']>().mockResolvedValue(active)
  const bridge: GuardNativeBridge = {
    request,
    bind: vi.fn(async () => active),
    verifyScoped: vi.fn(async () => active),
    revokeScoped: vi.fn(async () => disabled),
    invalidateIntents: vi.fn(),
    pending: () => false
  }
  const service = createGuardManagementService({
    bridge,
    assertIdle: vi.fn(),
    capture: async () => ({ status: 'unavailable' }),
    owned: () => ({})
  })
  return { service, request }
}

describe('guard management disable with a native substitute', () => {
  it('leaves the current lease intact while confirmation is open and after cancellation', async () => {
    const { service, request } = fixture()
    await service.action('status')
    let reply: (value: GuardManagementSnapshot) => void = () => {}
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
    const operation = service.action('disable')
    const actionsBeforeConfirmation = request.mock.calls.map(([action]) => action)
    reply({ ...active, phase: 'blocked', configuration: undefined, reason: 'userCancelled' })
    // Always settle the substitute, even if the request went to the wrong
    // native action. A second native call would then use the default fixture.
    const state = await operation
    expect(actionsBeforeConfirmation).toEqual(['status', 'disable'])
    expect(request.mock.calls.map(([action]) => action)).toEqual(['status', 'disable'])
    expect(state.policy?.phase).toBe('ready')
    expect(await service.requestClose()).toBe(false)
  })

  it('accepts the owned disabled readback and its cleared lease without a separate revoke', async () => {
    const { service, request } = fixture()
    await service.action('status')
    request.mockResolvedValueOnce(disabled)
    expect(await service.action('disable')).toEqual(disabled)
    expect(await service.requestClose()).toBe(true)
    expect(request.mock.calls.map(([action]) => action)).toEqual(['status', 'disable'])
  })

  it('retains the quit barrier when the system write has no confirmed readback', async () => {
    const { service, request } = fixture()
    await service.action('status')
    request.mockResolvedValueOnce({
      phase: 'uncertain',
      pending: false,
      systemOperationAttempted: true,
      protectionVerified: false,
      runtimeEnforcement: 'notVerified',
      policy: { phase: 'unconfirmed' }
    })
    expect((await service.action('disable')).phase).toBe('uncertain')
    expect(await service.requestClose()).toBe(false)
    expect(request.mock.calls.map(([action]) => action)).toEqual(['status', 'disable'])
  })

  it('refuses quit if the revoke reply reveals an enabled configuration after the enable reply was cancelled', async () => {
    const { service, request } = fixture()
    request.mockRejectedValueOnce(new Error('fixture renderer authorization expired'))
    await expect(service.action('enable')).rejects.toThrow('renderer authorization expired')
    request.mockResolvedValueOnce({ ...active, phase: 'uncertain', policy: { phase: 'unbound' } })
    expect(await service.requestClose()).toBe(false)
    expect(service.state()).toMatchObject({ phase: 'uncertain', configuration: { enabled: true } })
    expect(request.mock.calls.map(([action]) => action)).toEqual(['enable', 'revoke'])
  })

  it('keeps the runtime mutation barrier while native revoke still reports a separate uncertainty', async () => {
    const { service, request } = fixture()
    await service.action('status')
    request.mockResolvedValueOnce({ ...active, phase: 'uncertain', policy: { phase: 'unbound' } })
    await expect(service.beforeRuntimeMutation()).rejects.toThrow('撤销未确认')
    expect(service.isBlocking()).toBe(true)
  })

  it('keeps unresolved system state after an unavailable probe until a positive readback', async () => {
    const { service, request } = fixture()
    request.mockRejectedValueOnce(new Error('fixture late enable reply lost'))
    await expect(service.action('enable')).rejects.toThrow('late enable reply lost')
    request.mockRejectedValueOnce(new GuardNativeUnavailable())
    await expect(service.inspectActivity()).resolves.toBe('unknown')
    expect(service.isBlocking()).toBe(true)
    expect(service.state().phase).toBe('uncertain')
    request.mockResolvedValueOnce(disabled)
    await expect(service.action('status')).resolves.toEqual(disabled)
    expect(service.isBlocking()).toBe(false)
  })

  it('retains the exit and Core mutation barriers after a blocked configuration reread', async () => {
    const { service, request } = fixture()
    request.mockRejectedValueOnce(new Error('fixture late enable reply lost'))
    await expect(service.action('enable')).rejects.toThrow('late enable reply lost')
    request.mockResolvedValueOnce({
      ...disabled,
      phase: 'blocked',
      configuration: undefined,
      reason: 'packageIdentityUnconfirmed'
    })
    await expect(service.action('status')).resolves.toMatchObject({ phase: 'uncertain' })
    expect(service.isBlocking()).toBe(true)
    await expect(service.requestClose()).resolves.toBe(false)
    await expect(service.beforeRuntimeMutation()).rejects.toThrow('撤销未确认')
    expect(request.mock.calls.map(([action]) => action)).toEqual(['enable', 'status'])

    request.mockResolvedValueOnce(disabled)
    await expect(service.inspectActivity()).resolves.toBe('inactive')
    expect(service.isBlocking()).toBe(false)
    await expect(service.requestClose()).resolves.toBe(true)
  })

  it('does not use cached configuration in an explicit revoke as a fresh readback', async () => {
    const { service, request } = fixture()
    await service.action('status')
    request.mockResolvedValueOnce({
      ...active,
      phase: 'uncertain',
      configuration: undefined,
      systemOperationAttempted: true,
      policy: { phase: 'unconfirmed' }
    })
    await service.action('disable')
    request.mockResolvedValueOnce(disabled)
    await expect(service.action('revoke')).resolves.toMatchObject({
      phase: 'uncertain',
      policy: { phase: 'unbound' }
    })
    expect(service.isBlocking()).toBe(true)
    await expect(service.requestClose()).resolves.toBe(false)

    request.mockResolvedValueOnce(disabled)
    await expect(service.action('status')).resolves.toEqual(disabled)
    await expect(service.requestClose()).resolves.toBe(true)
  })
})

it('allows only already loaded native-host revocation after its on-disk identity is unavailable', async () => {
  const inspect = vi.fn(async () => ({
    path: '/fixture/RelayGuard.node',
    trusted: true as const,
    resourceSHA256: 'a'.repeat(64)
  }))
  const request = vi.fn(async (text: string) => {
    const { version, id, action } = JSON.parse(text) as {
      version: number
      id: string
      action: string
    }
    return JSON.stringify({ version, id, action, ...disabled, configuration: undefined })
  })
  const load = vi.fn(() => ({ request, invalidateIntents: vi.fn() }))
  const bridge = createGuardNativeBridge({ inspect, require: load })
  await bridge.request('status')
  inspect.mockRejectedValue(new Error('fixture release resources unavailable'))
  await expect(bridge.request('revoke')).resolves.toMatchObject({ policy: { phase: 'unbound' } })
  await expect(bridge.request('disable')).rejects.toBeInstanceOf(GuardNativeUnavailable)
  expect(load).toHaveBeenCalledOnce()
  expect(
    request.mock.calls.map(([text]) => (JSON.parse(text) as { action: string }).action)
  ).toEqual(['status', 'revoke'])
})

it('reads registered extension states without granting runtime protection', async () => {
  const extensions = { lineage: 'awaitingUserApproval', filter: 'enabled' }
  const request = vi.fn(async (text: string) => {
    const envelope = JSON.parse(text) as { version: number; id: string; action: string }
    return JSON.stringify({ ...envelope, ...disabled, configuration: undefined, extensions })
  })
  const bridge = createGuardNativeBridge({
    inspect: async () => ({
      path: '/fixture/RelayGuard.node',
      trusted: true,
      resourceSHA256: 'a'.repeat(64)
    }),
    require: () => ({ request, invalidateIntents: vi.fn() })
  })
  await expect(bridge.request('status')).resolves.toMatchObject({
    extensions,
    protectionVerified: false,
    runtimeEnforcement: 'notVerified'
  })
  extensions.filter = 'verified'
  await expect(bridge.request('status')).rejects.toThrow('系统扩展状态未确认')
})

function bindingFixture() {
  const instanceID = 'aabbccdd-aabb-ccdd-aabb-ccddeeff0011'
  const configuration = '{}'
  let bound = false
  const reply = (
    request: { version: number; action: string; id: string },
    overrides: Partial<GuardManagementSnapshot> = {}
  ) =>
    JSON.stringify({
      ...request,
      phase: 'idle',
      pending: false,
      systemOperationAttempted: false,
      protectionVerified: false,
      runtimeEnforcement: 'notVerified',
      policy: bound
        ? {
            phase: 'preparedLocally',
            instanceID,
            configurationSHA256: createHash('sha256').update(configuration).digest('hex')
          }
        : { phase: 'unbound' },
      ...overrides
    })
  const exchange = vi.fn(async (request: { version: number; action: string; id: string }) => {
    if (request.action === 'bind') bound = true
    if (request.action === 'revoke') bound = false
    return reply(request)
  })
  const bridge = createGuardNativeBridge({
    inspect: async () => ({
      path: '/fixture/RelayGuard.node',
      trusted: true,
      resourceSHA256: 'a'.repeat(64)
    }),
    require: () => ({
      invalidateIntents: vi.fn(),
      request: (text: string) => {
        const { version, id, action } = JSON.parse(text)
        return exchange({ version, id, action })
      }
    })
  })
  const capture = {
    snapshot: { instanceId: instanceID, revision: 'fixture', configuration, proxyPort: 1234 },
    capturedAt: 1,
    isCurrent: () => true,
    isOwnerLive: () => true,
    assertOwner: vi.fn(async () => {})
  }
  const service = createGuardManagementService({
    bridge,
    assertIdle: vi.fn(),
    capture: async () => ({ status: 'captured', capture }),
    owned: () => ({ instanceId: instanceID, pid: 1234 })
  })
  return { service, capture, exchange, reply, bind: () => (bound = true), bound: () => bound }
}

describe('guard management prepare cleanup through the native bridge', () => {
  it.each([
    ['unconfirmed provider bind', { phase: 'blocked', policy: { phase: 'unconfirmed' } }],
    ['pending bind', { phase: 'blocked', pending: true }],
    ['uncertain management report', { phase: 'uncertain' }]
  ] satisfies [string, Partial<GuardManagementSnapshot>][])(
    'clears the submitted bind when the valid reply reports %s',
    async (_description, overrides) => {
      const { service, exchange, reply, bind, bound } = bindingFixture()
      exchange.mockImplementationOnce(async (request) => {
        bind()
        return reply(request, overrides)
      })
      await expect(service.action('prepare')).rejects.toThrow('绑定未确认')
      expect(exchange.mock.calls.map(([request]) => request.action)).toEqual(['bind', 'revoke'])
      expect(bound()).toBe(false)
      expect(service.isBlocking()).toBe(false)
    }
  )

  it('retains a known blocked reply without revoking an existing different proof', async () => {
    const { service, exchange, reply, bind, bound } = bindingFixture()
    let stale = false
    exchange.mockImplementationOnce(async (request) => {
      bind()
      stale = true
      return reply(request, {
        phase: 'blocked',
        reason: 'packageIdentityUnconfirmed',
        policy: {
          phase: 'ready',
          instanceID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          configurationSHA256: 'a'.repeat(64)
        }
      })
    })
    await expect(
      service.action('prepare', () => {
        if (stale) throw new Error('fixture renderer scope ended')
      })
    ).rejects.toThrow('renderer scope ended')
    expect(exchange.mock.calls.map(([request]) => request.action)).toEqual(['bind'])
    expect(bound()).toBe(true)
  })

  it('does not revoke a known blocked reply with no proof', async () => {
    const { service, exchange, reply } = bindingFixture()
    exchange.mockImplementationOnce(async (request) => reply(request, { phase: 'blocked' }))
    await expect(service.action('prepare')).resolves.toMatchObject({
      phase: 'blocked',
      policy: { phase: 'unbound' }
    })
    expect(exchange.mock.calls.map(([request]) => request.action)).toEqual(['bind'])
  })

  it('clears a supposedly admitted bind whose proof has a different configuration digest', async () => {
    const { service, capture, exchange, reply, bind, bound } = bindingFixture()
    exchange.mockImplementationOnce(async (request) => {
      bind()
      return reply(request, {
        policy: {
          phase: 'preparedLocally',
          instanceID: capture.snapshot.instanceId,
          configurationSHA256: 'a'.repeat(64)
        }
      })
    })
    await expect(service.action('prepare')).rejects.toThrow('绑定未确认')
    expect(exchange.mock.calls.map(([request]) => request.action)).toEqual(['bind', 'revoke'])
    expect(bound()).toBe(false)
  })

  it.each(['invalid-receipt', 'expired-native-reply', 'expired-owner-check'] as const)(
    'clears the submitted native bind after %s',
    async (reason) => {
      const { service, capture, exchange, reply, bind, bound } = bindingFixture()
      let expired = false
      if (reason === 'expired-owner-check')
        capture.assertOwner
          .mockImplementationOnce(async () => {})
          .mockImplementationOnce(async () => {
            expired = true
          })
      else
        exchange.mockImplementationOnce(async (request) => {
          bind()
          if (reason === 'expired-native-reply') expired = true
          return reply(reason === 'invalid-receipt' ? { ...request, id: 'bad' } : request)
        })
      await expect(
        service.action('prepare', () => {
          if (expired) throw new Error('fixture renderer scope ended')
        })
      ).rejects.toThrow(reason === 'invalid-receipt' ? '不属于本次请求' : 'renderer scope ended')
      expect(exchange.mock.calls.map(([request]) => request.action)).toEqual(['bind', 'revoke'])
      expect(bound()).toBe(false)
      expect(service.state()).toMatchObject({ phase: 'idle', policy: { phase: 'unbound' } })
      expect(service.isBlocking()).toBe(false)
    }
  )

  it('keeps the previous lease if the next renderer intent expires before native submission', async () => {
    const { service, exchange, bound } = bindingFixture()
    await service.action('prepare')
    let checks = 0
    await expect(
      service.action('prepare', () => {
        if (++checks === 3) {
          service.invalidateIntent()
          throw new Error('fixture renderer scope ended')
        }
      })
    ).rejects.toThrow('renderer scope ended')
    expect(exchange.mock.calls.map(([request]) => request.action)).toEqual(['bind'])
    expect(bound()).toBe(true)
    expect(service.state()).toMatchObject({ phase: 'uncertain' })
    expect(service.state().policy).toBeUndefined()
  })

  it('retains the barrier during cleanup and until an unbound result is confirmed', async () => {
    const { service, exchange, reply, bind, bound } = bindingFixture()
    const entered = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    exchange
      .mockImplementationOnce(async (request) => {
        bind()
        return reply({ ...request, id: 'bad' })
      })
      .mockImplementationOnce(async (request) => {
        entered.resolve()
        await complete.promise
        return reply(request, { pending: true, policy: { phase: 'unbound' } })
      })
    const rejected = expect(service.action('prepare')).rejects.toThrow('撤销未确认')
    await entered.promise
    try {
      await expect(service.action('prepare')).rejects.toThrow('事务尚未结束')
      await expect(service.requestClose()).resolves.toBe(false)
      await expect(service.beforeRuntimeMutation()).rejects.toThrow('事务未结束')
    } finally {
      complete.resolve()
    }
    await rejected
    expect(bound()).toBe(true)
    expect(service.state().phase).toBe('uncertain')
    expect(service.isBlocking()).toBe(true)
    await expect(service.action('revoke')).resolves.toMatchObject({ policy: { phase: 'unbound' } })
    expect(bound()).toBe(false)
    expect(service.isBlocking()).toBe(false)
    expect(exchange.mock.calls.map(([request]) => request.action)).toEqual([
      'bind',
      'revoke',
      'revoke'
    ])
  })
})
