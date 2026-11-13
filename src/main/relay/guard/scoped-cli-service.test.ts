import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { GuardManagementSnapshot } from '../../../shared/relay/guard-management'
import type { LocalRuntimeCapture } from '../core/local-proxy-service'
import { createGuardNativeBridge } from './native-addon'
import { createScopedCLIService } from './scoped-cli-service'

const instanceID = '9844d805-3802-4db3-b4cc-fd1314b17773'
const configuration = '{}'
const prepared = {
  phase: 'prepared',
  instanceID,
  configurationSHA256: createHash('sha256').update(configuration).digest('hex')
} as const
const input = { prompt: 'Unused fixture prompt', apiKey: 'fixture-unused' }

function fixture() {
  let nativeProof = false
  let confirmRevoke = true
  let beforeVerifyReply: Promise<void> | undefined
  const actions: string[] = []
  const addon = {
    request: vi.fn(async (json: string) => {
      const { version, id, action } = JSON.parse(json)
      actions.push(action)
      if (action === 'verifyScopedCore') {
        nativeProof = true
        await beforeVerifyReply
      } else if (action === 'revokeScopedCore') {
        if (confirmRevoke) nativeProof = false
      } else throw new Error('Unexpected fixture action')
      const state: GuardManagementSnapshot = {
        phase: 'idle',
        pending: false,
        systemOperationAttempted: false,
        protectionVerified: false,
        runtimeEnforcement: 'notVerified',
        scopedPolicy: nativeProof ? prepared : { phase: 'unbound' }
      }
      // The native side has already issued a proof. The real JS bridge must
      // reject this response because the receipt belongs to a different call.
      return JSON.stringify({
        version,
        id: action === 'verifyScopedCore' ? 'wrong' : id,
        action,
        ...state
      })
    }),
    invalidateIntents: vi.fn()
  }
  const inspect = vi.fn(async () => ({
    path: '/fixture/RelayGuard.node',
    trusted: true as const,
    resourceSHA256: 'a'.repeat(64)
  }))
  const requireAddon = vi.fn(() => addon)
  const bridge = createGuardNativeBridge({ inspect, require: requireAddon })
  const assertOwner = vi.fn<LocalRuntimeCapture['assertOwner']>(async () => {})
  const capture: LocalRuntimeCapture = {
    snapshot: { instanceId: instanceID, configuration, revision: 'fixture', proxyPort: 12345 },
    capturedAt: 0,
    isCurrent: () => true,
    isOwnerLive: () => true,
    assertOwner
  }
  const confirmStart = vi.fn(async () => {
    throw new Error('Fixture must not reach launch consent')
  })
  const service = createScopedCLIService({
    context: { home: '/fixture/home', stateRoot: '/fixture/state' },
    resourceRoot: '/fixture/resources',
    bridge,
    storage: {
      isBusy: () => false,
      invalidate: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      close: vi.fn()
    },
    capture: async () => ({ status: 'captured', capture }),
    owned: () => ({ instanceId: instanceID, pid: 9999 }),
    assertIdle: vi.fn(),
    assertStorageIdle: vi.fn(),
    confirmStart,
    confirmStop: vi.fn(async () => false)
  })
  return {
    service,
    inspect,
    requireAddon,
    actions,
    assertOwner,
    confirmStart,
    hasProof: () => nativeProof,
    allowRevoke: (allow: boolean) => {
      confirmRevoke = allow
    },
    pauseVerifyReply: (pending: Promise<void>) => {
      beforeVerifyReply = pending
    }
  }
}

describe('Scoped CLI ownership cleanup before launching any process', () => {
  it('revokes a native proof even when its ownership receipt is rejected', async () => {
    const f = fixture()
    await expect(f.service.launch(input)).rejects.toThrow('启动未完成')
    expect(f.confirmStart).not.toHaveBeenCalled()
    expect(f.actions).toEqual(['verifyScopedCore', 'revokeScopedCore'])
    expect(f.hasProof()).toBe(false)
    expect(f.service.isBlocking()).toBe(false)
  })

  it('retains the barrier until an explicit retry confirms the uncertain revoke', async () => {
    const f = fixture()
    f.allowRevoke(false)
    await expect(f.service.launch(input)).rejects.toThrow('启动未完成')
    expect(f.hasProof()).toBe(true)
    expect(f.service.state()).toMatchObject({ phase: 'uncertain', pending: false })
    expect(f.service.isBlocking()).toBe(true)
    await expect(f.service.launch(input)).rejects.toThrow('请先结束')
    expect(f.actions).toEqual(['verifyScopedCore', 'revokeScopedCore'])
    f.allowRevoke(true)
    await expect(f.service.requestClose()).resolves.toBe(true)
    expect(f.hasProof()).toBe(false)
    expect(f.service.isBlocking()).toBe(false)
    expect(f.actions).toEqual(['verifyScopedCore', 'revokeScopedCore', 'revokeScopedCore'])
  })

  it('does not create a false cleanup barrier if resource inspection refuses before submission', async () => {
    const f = fixture()
    f.inspect.mockRejectedValueOnce(new Error('Resource unavailable'))
    await expect(f.service.launch(input)).rejects.toThrow('启动未完成')
    expect(f.requireAddon).not.toHaveBeenCalled()
    expect(f.actions).toEqual([])
    expect(f.service.state()).toMatchObject({ phase: 'blocked', pending: false })
    expect(f.service.isBlocking()).toBe(false)
  })

  it('does not attempt a revoke when addon loading itself fails before submission', async () => {
    const f = fixture()
    f.requireAddon.mockImplementation(() => {
      throw new Error('Could not load addon')
    })
    await expect(f.service.launch(input)).rejects.toThrow('启动未完成')
    expect(f.requireAddon).toHaveBeenCalledOnce()
    expect(f.actions).toEqual([])
    expect(f.service.state()).toMatchObject({ phase: 'blocked', pending: false })
    expect(f.service.isBlocking()).toBe(false)
  })

  it('stops a late owner probe from submitting a native verification after cancellation', async () => {
    const f = fixture()
    let complete = () => {}
    f.assertOwner.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        })
    )
    const launch = expect(f.service.launch(input)).rejects.toThrow('启动未完成')
    await vi.waitFor(() => expect(f.assertOwner).toHaveBeenCalledOnce())
    await expect(f.service.requestClose()).resolves.toBe(false)
    complete()
    await launch
    expect(f.actions).toEqual([])
    expect(f.hasProof()).toBe(false)
    expect(f.service.isBlocking()).toBe(false)
  })

  it('cleans up after cancellation if verification had already reached the native bridge', async () => {
    const f = fixture()
    let complete = () => {}
    f.pauseVerifyReply(
      new Promise<void>((resolve) => {
        complete = resolve
      })
    )
    const launch = expect(f.service.launch(input)).rejects.toThrow('启动未完成')
    await vi.waitFor(() => expect(f.hasProof()).toBe(true))
    await expect(f.service.requestClose()).resolves.toBe(false)
    expect(f.service.isBlocking()).toBe(true)
    expect(f.actions).toEqual(['verifyScopedCore'])
    complete()
    await launch
    expect(f.actions).toEqual(['verifyScopedCore', 'revokeScopedCore'])
    expect(f.hasProof()).toBe(false)
    expect(f.service.isBlocking()).toBe(false)
  })
})
