import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { requestOnce } from '../../resolve/plugin/http-client'
import { generateAgeKeyPair } from '../../utils/age'
import type { RelayRuntimeGistSyncScope } from '../../../shared/relay/runtime-gist-sync'
import { createRuntimeGistWriter } from './runtime-gist-writer'
import { backupAccountsFixture, gistAccount } from './accounts.test-fixture'
import {
  createRuntimeGistSyncService,
  type RuntimeGistSyncCapture,
  type RuntimeGistSyncCaptureResult,
  type RuntimeGistSyncPermit
} from './runtime-gist-sync'

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const gist = (content: string) => ({
  status: 200,
  body: '',
  headers: {},
  bytes: Buffer.from(
    JSON.stringify({
      id: 'abcde',
      public: false,
      truncated: false,
      files: {
        'clash-party.yaml': {
          filename: 'clash-party.yaml',
          truncated: false,
          size: Buffer.byteLength(content),
          content
        }
      }
    })
  )
})
type BaseFixture = Parameters<Parameters<typeof backupAccountsFixture>[0]>[0]
async function fixture(
  run: (f: BaseFixture & Awaited<ReturnType<typeof setup>>) => Promise<void>,
  recipient?: string
): Promise<void> {
  await backupAccountsFixture(async (f) => {
    const api = await setup(f, recipient)
    try {
      await run({ ...f, ...api })
    } finally {
      await api.service.stop()
    }
  })
}
async function setup(f: BaseFixture, recipient?: string) {
  const account = await f.store.save({ ...gistAccount, ...(recipient ? { recipient } : {}) })
  let version = 1,
    mode = 'rule',
    actualMode = 'rule',
    owner = 1,
    port = 17891,
    alive = true,
    coreBusy = false,
    foreground = true,
    serverContent = 'original-dedicated-runtime'
  const captures: RuntimeGistSyncCapture[] = [],
    permits: RuntimeGistSyncPermit[] = [],
    writes: Array<{ body: string; at: number }> = []
  const sourceBody = (): string =>
    JSON.stringify({
      configuration: version,
      mode: actualMode,
      private: 'PRIVATE-RUNTIME-FIXTURE'
    }) + '\n'
  const captureRuntime = vi.fn(
      async (
        signal: AbortSignal,
        _source?: import('../../../shared/relay/runtime-gist').RelayRuntimeGistSource,
        _port?: number
      ): Promise<RuntimeGistSyncCaptureResult> => {
        if (signal.aborted) throw new Error('aborted')
        if (!alive) return { status: 'unavailable' }
        if (coreBusy) return { status: 'busy' }
        const ownVersion = version,
          ownOwner = owner,
          ownPort = port,
          ownMode = actualMode
        mode = actualMode
        let lastReadMode = ownMode
        const isOwnerLive = (): boolean => alive && owner === ownOwner && port === ownPort
        const capture: RuntimeGistSyncCapture = {
          snapshot: Object.freeze({
            instanceId: 'owned-' + ownOwner,
            proxyPort: ownPort,
            revision: sha(String(ownVersion)),
            configuration: sourceBody()
          }),
          capturedAt: Date.now(),
          isOwnerLive: vi.fn(isOwnerLive),
          isCurrent: vi.fn(
            () =>
              isOwnerLive() &&
              !coreBusy &&
              version === ownVersion &&
              mode === ownMode &&
              lastReadMode === ownMode
          ),
          assertOwner: vi.fn(async (activeSignal) => {
            if (activeSignal.aborted || !isOwnerLive()) throw new Error('owner lost')
            lastReadMode = actualMode
          })
        }
        captures.push(capture)
        return { status: 'captured', capture }
      }
    ),
    authorize = vi.fn(
      async (permission: RelayRuntimeGistSyncScope): Promise<RuntimeGistSyncPermit | undefined> => {
        let valid = true
        const permit: RuntimeGistSyncPermit = {
          permission: structuredClone(permission),
          isLive: vi.fn(() => valid),
          revoke: vi.fn(() => {
            valid = false
          }),
          credential: vi.fn(async (signal) => {
            if (signal.aborted || !valid) throw new Error('revoked')
            return f.store.credential({ id: permission.id, revision: permission.revision })
          })
        }
        permits.push(permit)
        return permit
      }
    ),
    request = vi.fn<typeof requestOnce>(async (_url, options) => {
      if (options.method === 'PATCH') {
        serverContent = JSON.parse(String(options.body)).files['clash-party.yaml'].content
        writes.push({ body: serverContent, at: Date.now() })
      } else if (options.method !== 'GET') throw new Error('only GET and PATCH allowed')
      return gist(serverContent)
    }),
    service = createRuntimeGistSyncService({
      accounts: f.store,
      captureRuntime,
      authorize,
      request,
      canRun: () => foreground && !coreBusy
    })
  const commit = (next: number, nextMode = mode, hint = true): void => {
    version = next
    mode = nextMode
    actualMode = nextMode
    if (hint) service.changed()
  }
  return {
    account,
    service,
    captureRuntime,
    authorize,
    request,
    captures,
    permits,
    writes,
    sourceBody,
    arm: () => service.arm({ id: account.id, revision: account.revision, gistId: 'abcde' }),
    commit,
    modeChange: (value: string, hint = true) => {
      mode = value
      actualMode = value
      if (hint) service.changed()
    },
    externalMode: (value: string) => {
      actualMode = value
    },
    setBusy: (value: boolean) => {
      coreBusy = value
      if (!value) service.changed()
    },
    setForeground: (value: boolean) => {
      foreground = value
    },
    loseOwner: () => {
      alive = false
    },
    replaceOwner: () => {
      ++owner
    },
    changePort: () => {
      ++port
    },
    editRemote: (content: string) => {
      serverContent = content
    },
    serverContent: () => serverContent
  }
}
async function tick(
  service: ReturnType<typeof createRuntimeGistSyncService>,
  ms = 300
): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await service.whenIdle()
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('Session authorized automatic runtime Gist, real writer with injected HTTP only', () => {
  const tunSource = {
    kind: 'tun-managed' as const,
    sessionId: '11111111-1111-4111-8111-111111111111'
  }
  it('routes every automatic capture through the explicitly selected TUN session and fixed account port', async () => {
    await fixture(async (f) => {
      const capture = f.captureRuntime.getMockImplementation()
      if (!capture) throw new Error('fixture capture missing')
      f.captureRuntime.mockImplementation(async (signal) => {
        const result = await capture(signal)
        if (result.status === 'captured')
          result.capture.snapshot = {
            ...result.capture.snapshot,
            source: tunSource,
            instanceId: tunSource.sessionId
          }
        return result
      })
      await f.service.arm({
        id: f.account.id,
        revision: f.account.revision,
        gistId: 'abcde',
        source: tunSource
      })
      expect(f.permits[0].permission.source).toEqual(tunSource)
      expect(f.service.state().owner).toMatchObject({
        source: tunSource,
        instanceId: tunSource.sessionId
      })
      await tick(f.service)
      expect(f.service.state().lastResult).toBe('uploaded')
      for (const call of f.captureRuntime.mock.calls)
        expect(call.slice(1)).toEqual([tunSource, f.account.proxyPort])
      f.commit(2)
      await tick(f.service, 1000)
      expect(f.writes).toHaveLength(2)
      expect(f.service.state().lastResult).toBe('uploaded')
    })
  })
  it('rejects local fallback and unsupported TUN capture without authorizing, decrypting or sending', async () => {
    for (const unsupported of [false, true])
      await fixture(async (f) => {
        f.crypto.decrypt.mockClear()
        if (unsupported) f.captureRuntime.mockResolvedValue({ status: 'unsupported' })
        await expect(
          f.service.arm({
            id: f.account.id,
            revision: f.account.revision,
            gistId: 'abcde',
            source: tunSource
          })
        ).rejects.toThrow('授权未通过')
        expect(f.authorize).not.toHaveBeenCalled()
        expect(f.crypto.decrypt).not.toHaveBeenCalled()
        expect(f.request).not.toHaveBeenCalled()
      })
  })
  it('stops an explicit TUN grant when a later capture silently substitutes a local source', async () => {
    await fixture(async (f) => {
      const capture = f.captureRuntime.getMockImplementation()
      if (!capture) throw new Error('fixture capture missing')
      let changed = false
      f.captureRuntime.mockImplementation(async (signal) => {
        const result = await capture(signal)
        if (result.status === 'captured')
          result.capture.snapshot = {
            ...result.capture.snapshot,
            ...(changed ? {} : { source: tunSource }),
            instanceId: tunSource.sessionId
          }
        return result
      })
      await f.service.arm({
        id: f.account.id,
        revision: f.account.revision,
        gistId: 'abcde',
        source: tunSource
      })
      changed = true
      await tick(f.service)
      expect(f.service.state()).toMatchObject({ enabled: false, stopReason: 'ownerChanged' })
      expect(f.request).not.toHaveBeenCalled()
    })
  })

  it('starts inert, proposes a complete explicit overwrite scope, and never decrypts before the first authorized change cycle', async () => {
    await fixture(async (f) => {
      f.crypto.decrypt.mockClear()
      expect(f.service.state()).toMatchObject({ enabled: false, pending: false, dirty: false })
      expect(f.captureRuntime).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
      const result = await f.arm()
      expect(result).toMatchObject({
        status: 'armed',
        state: { enabled: true, pending: false, dirty: true }
      })
      expect(f.authorize.mock.calls[0][0]).toMatchObject({
        id: f.account.id,
        revision: f.account.revision,
        gistId: 'abcde',
        filename: 'clash-party.yaml',
        instanceId: 'owned-1',
        proxyPort: 17891,
        containsSecrets: true,
        sessionOnly: true,
        overwriteDedicatedFile: true,
        atomicRemoteUpdate: false
      })
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
      expect(JSON.stringify(f.service.state())).not.toMatch(/PRIVATE-RUNTIME|github-test-secret/u)
      await tick(f.service, 299)
      expect(f.request).not.toHaveBeenCalled()
      await tick(f.service, 1)
      expect(f.request.mock.calls.map(([, options]) => options.method)).toEqual([
        'GET',
        'PATCH',
        'GET'
      ])
      expect(f.service.state()).toMatchObject({
        enabled: true,
        dirty: false,
        lastResult: 'uploaded'
      })
    })
  })
  it('cancels native consent, rejects an implicit create, and installs no hidden grant', async () => {
    await fixture(async (f) => {
      await expect(
        f.service.arm({ id: f.account.id, revision: f.account.revision })
      ).rejects.toThrow('现有专用')
      f.authorize.mockResolvedValueOnce(undefined)
      expect(await f.arm()).toMatchObject({
        status: 'cancelled',
        state: { enabled: false, pending: false }
      })
      f.service.changed()
      await tick(f.service, 10000)
      expect(f.request).not.toHaveBeenCalled()
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
    })
  })
  it('coalesces event bursts and suppresses unchanged plaintext without issuing even a target GET', async () => {
    await fixture(async (f) => {
      await f.arm()
      for (let i = 0; i < 10; ++i) {
        f.service.changed()
        await vi.advanceTimersByTimeAsync(20)
      }
      expect(f.request).not.toHaveBeenCalled()
      await tick(f.service, 300)
      expect(f.writes).toHaveLength(1)
      const uploaded = f.service.state().lastUploaded
      for (let i = 0; i < 10; ++i) f.service.changed()
      await tick(f.service, 1000)
      expect(f.request).toHaveBeenCalledTimes(3)
      expect(f.service.state()).toMatchObject({
        enabled: true,
        dirty: false,
        lastResult: 'unchanged',
        lastUploaded: uploaded
      })
    })
  })
  it('uses plaintext deduplication with actual AGE so unchanged data does not re-encrypt into a new write', async () => {
    const pair = await generateAgeKeyPair()
    await fixture(async (f) => {
      await f.arm()
      await tick(f.service)
      expect(f.writes[0].body).toContain('BEGIN AGE ENCRYPTED FILE')
      expect(f.authorize.mock.calls[0][0]).toMatchObject({
        encrypted: true,
        recipient: pair.recipient
      })
      f.service.changed()
      await tick(f.service, 1000)
      expect(f.writes).toHaveLength(1)
      expect(f.service.state().lastResult).toBe('unchanged')
    }, pair.recipient)
  })
  it('merges a superseded preflight into the latest real capture without sending an outdated PATCH or revoking the session', async () => {
    await fixture(async (f) => {
      const entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>(),
        normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request')
      f.request.mockImplementationOnce(async (url, options) => {
        entered.resolve()
        await gate.promise
        return normal(url, options)
      })
      await f.arm()
      await vi.advanceTimersByTimeAsync(300)
      await entered.promise
      f.commit(2)
      gate.resolve()
      await f.service.whenIdle()
      expect(f.writes).toHaveLength(0)
      expect(f.service.state()).toMatchObject({
        enabled: true,
        dirty: true,
        lastResult: 'superseded'
      })
      await tick(f.service, 300)
      expect(f.writes).toHaveLength(1)
      expect(f.writes[0].body).toBe(f.sourceBody())
    })
  })
  it('finishes immutable R1 readback while same-owner R2/R3 commit and then uploads only the latest R3 at least one second later', async () => {
    await fixture(async (f) => {
      const entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>(),
        normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request')
      f.request.mockImplementation(async (url, options) => {
        const result = await normal(url, options)
        if (options.method === 'PATCH' && f.writes.length === 1) {
          entered.resolve()
          await gate.promise
        }
        return result
      })
      await f.arm()
      await vi.advanceTimersByTimeAsync(300)
      await entered.promise
      const r1 = f.writes[0].body
      f.commit(2)
      f.commit(3)
      expect(f.service.state()).toMatchObject({
        enabled: true,
        dirty: true,
        uploading: { submitted: true }
      })
      expect(f.service.state().latestCaptured?.configurationSHA256).toBe(sha(r1))
      gate.resolve()
      await f.service.whenIdle()
      expect(f.service.state()).toMatchObject({
        enabled: true,
        dirty: true,
        lastResult: 'uploaded'
      })
      expect(f.service.state().lastUploaded?.source.configurationSHA256).toBe(sha(r1))
      await tick(f.service, 1000)
      expect(f.writes.map((write) => write.body)).toEqual([r1, f.sourceBody()])
      expect(f.writes[1].at - f.writes[0].at).toBeGreaterThanOrEqual(1000)
      expect(f.service.state()).toMatchObject({
        enabled: true,
        dirty: false,
        lastResult: 'uploaded'
      })
    })
  })
  it('does not confuse ordinary same-owner reload busy after submission with owner loss or block readback behind it', async () => {
    await fixture(async (f) => {
      const entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>(),
        normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request')
      f.request.mockImplementation(async (url, options) => {
        const result = await normal(url, options)
        if (options.method === 'PATCH' && f.writes.length === 1) {
          entered.resolve()
          await gate.promise
        }
        return result
      })
      await f.arm()
      await vi.advanceTimersByTimeAsync(300)
      await entered.promise
      f.setBusy(true)
      f.commit(2)
      gate.resolve()
      await f.service.whenIdle()
      expect(f.request.mock.calls.map(([, options]) => options.method)).toEqual([
        'GET',
        'PATCH',
        'GET'
      ])
      expect(f.service.state()).toMatchObject({
        enabled: true,
        dirty: true,
        lastResult: 'uploaded'
      })
      await tick(f.service, 1000)
      expect(f.writes).toHaveLength(1)
      f.setBusy(false)
      await tick(f.service, 300)
      expect(f.writes).toHaveLength(2)
      expect(f.service.state().dirty).toBe(false)
    })
  })
  it('deduplicates by real body including mode even when the saved runtime revision is unchanged', async () => {
    await fixture(async (f) => {
      await f.arm()
      await tick(f.service)
      const previous = f.service.state().lastUploaded?.source
      f.modeChange('global')
      await tick(f.service, 1000)
      const latest = f.service.state().lastUploaded?.source
      expect(latest?.revision).toBe(previous?.revision)
      expect(latest?.configurationSHA256).not.toBe(previous?.configurationSHA256)
      expect(f.writes).toHaveLength(2)
    })
  })
  it('rechecks the actual per-job receipt rather than the initial receipt when target GET observes an external mode change', async () => {
    await fixture(async (f) => {
      const normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request')
      f.request.mockImplementationOnce(async (url, options) => {
        const result = await normal(url, options)
        f.externalMode('global')
        return result
      })
      await f.arm()
      await tick(f.service)
      expect(f.request.mock.calls.map(([, options]) => options.method)).toEqual(['GET'])
      expect(f.captures[1].isCurrent()).toBe(false)
      expect(f.service.state()).toMatchObject({
        enabled: true,
        dirty: true,
        lastResult: 'superseded'
      })
      await tick(f.service, 300)
      expect(f.writes).toHaveLength(1)
      expect(f.writes[0].body).toContain('global')
    })
  })
  it('does not clear dirty via unchanged deduplication when a genuine returned capture has already been superseded', async () => {
    await fixture(async (f) => {
      await f.arm()
      await tick(f.service)
      const capture = f.captureRuntime.getMockImplementation()
      if (!capture) throw new Error('missing capture')
      f.captureRuntime.mockImplementationOnce(async (signal) => {
        const receipt = await capture(signal)
        f.commit(2, 'global', false)
        return receipt
      })
      f.crypto.decrypt.mockClear()
      f.service.changed()
      await tick(f.service, 1000)
      expect(f.service.state()).toMatchObject({
        enabled: true,
        dirty: true,
        lastResult: 'superseded'
      })
      expect(f.request).toHaveBeenCalledTimes(3)
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      await tick(f.service, 300)
      expect(f.writes).toHaveLength(2)
      expect(f.writes[1].body).toBe(f.sourceBody())
    })
  })
  it('detects an observed remote preimage edit and stops without PATCH, while making no atomic-CAS claim', async () => {
    await fixture(async (f) => {
      await f.arm()
      await tick(f.service)
      f.editRemote('EXTERNAL-EDITOR')
      f.commit(2)
      await tick(f.service, 1000)
      expect(f.writes).toHaveLength(1)
      expect(f.service.state()).toMatchObject({
        enabled: false,
        lastResult: 'conflict',
        stopReason: 'conflict'
      })
      expect(f.serverContent()).toBe('EXTERNAL-EDITOR')
      await tick(f.service, 10000)
      expect(f.writes).toHaveLength(1)
      expect(
        f.request.mock.calls.every(
          ([, options]) => !Object.hasOwn(options.headers ?? {}, 'If-Match')
        )
      ).toBe(true)
    })
  })
  it('records real submitted wire uncertainty and never retries even after newer local changes', async () => {
    await fixture(async (f) => {
      const normal = f.request.getMockImplementation()
      if (!normal) throw new Error('missing request')
      f.request.mockImplementation(async (url, options) => {
        const result = await normal(url, options)
        if (options.method === 'PATCH') throw new Error('PRIVATE-wire-error')
        return result
      })
      await f.arm()
      await tick(f.service)
      expect(f.service.state()).toMatchObject({
        enabled: false,
        lastResult: 'uncertain',
        lastAttempt: { submitted: true, result: 'uncertain' }
      })
      f.commit(2)
      await tick(f.service, 10000)
      expect(f.writes).toHaveLength(1)
      expect(JSON.stringify(f.service.state())).not.toContain('PRIVATE-wire-error')
    })
  })
  it.each(['owner', 'port', 'account'] as const)(
    'revokes %s loss after submission, retains uncertainty and sends no readback',
    async (loss) => {
      await fixture(async (f) => {
        const entered = Promise.withResolvers<void>(),
          gate = Promise.withResolvers<void>(),
          normal = f.request.getMockImplementation()
        if (!normal) throw new Error('missing request')
        f.request.mockImplementation(async (url, options) => {
          const result = await normal(url, options)
          if (options.method === 'PATCH') {
            entered.resolve()
            await gate.promise
          }
          return result
        })
        await f.arm()
        await vi.advanceTimersByTimeAsync(300)
        await entered.promise
        if (loss === 'owner') f.loseOwner()
        else if (loss === 'port') f.changePort()
        else
          await f.store.save({
            id: f.account.id,
            revision: f.account.revision,
            name: 'Changed Gist',
            provider: 'gist',
            proxyPort: 17891
          })
        f.service.state()
        gate.resolve()
        await f.service.whenIdle()
        expect(f.service.state()).toMatchObject({
          enabled: false,
          lastResult: 'uncertain',
          lastAttempt: { submitted: true, result: 'uncertain' }
        })
        expect(f.request.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'PATCH'])
        await tick(f.service, 10000)
        expect(f.writes).toHaveLength(1)
      })
    }
  )
  it('revokes a late credential result on hide without writing, and stop waits for that in-flight work', async () => {
    await fixture(async (f) => {
      await f.arm()
      const pair = await f.store.credential({ id: f.account.id, revision: f.account.revision }),
        entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<typeof pair>()
      vi.mocked(f.permits[0].credential).mockImplementationOnce(async () => {
        entered.resolve()
        return gate.promise
      })
      await vi.advanceTimersByTimeAsync(300)
      await entered.promise
      let ended = false
      const stopping = f.service.stop('hidden').then(() => {
        ended = true
      })
      expect(ended).toBe(false)
      gate.resolve(pair)
      await stopping
      expect(f.service.state()).toMatchObject({
        enabled: false,
        pending: false,
        lastResult: 'cancelled',
        stopReason: 'hidden'
      })
      expect(f.request).not.toHaveBeenCalled()
      f.commit(2)
      await tick(f.service, 10000)
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('does not install a late permit returned after suspend or expired native consent', async () => {
    for (const reason of ['suspended', 'expired'] as const)
      await fixture(async (f) => {
        const entered = Promise.withResolvers<void>(),
          gate = Promise.withResolvers<void>(),
          normal = f.authorize.getMockImplementation()
        if (!normal) throw new Error('missing authorize')
        f.authorize.mockImplementationOnce(async (scope) => {
          entered.resolve()
          await gate.promise
          return normal(scope)
        })
        const arming = f.arm()
        await entered.promise
        const stopping = reason === 'suspended' ? f.service.stop('suspended') : undefined
        if (reason === 'expired') await vi.advanceTimersByTimeAsync(60000)
        gate.resolve()
        expect((await arming).status).toBe('cancelled')
        await stopping
        expect(f.permits[0].revoke).toHaveBeenCalled()
        expect(f.service.state().enabled).toBe(false)
        await tick(f.service, 10000)
        expect(f.request).not.toHaveBeenCalled()
      })
  })
  it.each(['permit', 'owner'] as const)(
    'treats thrown %s liveness as lost authority in timer sweep and keeps state/stop usable',
    async (kind) => {
      await fixture(async (f) => {
        await f.arm()
        if (kind === 'permit')
          vi.mocked(f.permits[0].isLive).mockImplementation(() => {
            throw new Error('PRIVATE-destroyed-frame')
          })
        else
          vi.mocked(f.captures[0].isOwnerLive).mockImplementation(() => {
            throw new Error('PRIVATE-destroyed-owner')
          })
        await tick(f.service)
        expect(() => f.service.state()).not.toThrow()
        expect(f.service.state().enabled).toBe(false)
        await f.service.stop()
        expect(f.request).not.toHaveBeenCalled()
        expect(JSON.stringify(f.service.state())).not.toContain('PRIVATE-destroyed')
      })
    }
  )
  it('defers foreground/capture work without decryption and new instances never inherit session grants', async () => {
    await fixture(async (f) => {
      await f.arm()
      f.setForeground(false)
      f.crypto.decrypt.mockClear()
      await tick(f.service)
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
      expect(f.service.state().enabled).toBe(true)
      f.setForeground(true)
      await tick(f.service, 1000)
      expect(f.writes).toHaveLength(1)
      await f.service.stop('restored')
      const fresh = createRuntimeGistSyncService({
        accounts: f.store,
        captureRuntime: f.captureRuntime,
        authorize: f.authorize,
        request: f.request,
        canRun: () => true
      })
      expect(fresh.state()).toMatchObject({ enabled: false, pending: false, dirty: false })
      await tick(fresh, 10000)
      expect(f.writes).toHaveLength(1)
      await fresh.stop()
    })
  })
})

describe('runtime Gist synchronous dispatch callbacks', () => {
  it('rechecks authority after beforeWrite callbacks and sends no revoked mutation', async () => {
    let live = true
    const request = vi.fn<typeof requestOnce>(async () => gist('old')),
      submitted = vi.fn(),
      check = (): void => {
        if (!live) throw new Error('revoked')
      }
    await expect(
      createRuntimeGistWriter(request).write(
        {
          request: { token: 'fixture-token', proxyPort: 17891, gistId: 'abcde' },
          payload: Buffer.from('new')
        },
        new AbortController().signal,
        {
          beforeSend: async () => check(),
          beforeWrite: () => {
            live = false
          },
          beforeDispatch: check,
          submitted
        }
      )
    ).rejects.toThrow('写入前复核')
    expect(request.mock.calls.map(([, options]) => options.method)).toEqual(['GET'])
    expect(submitted).not.toHaveBeenCalled()
  })
  it('waits for a dispatched request even if its submission observer throws, then reports uncertain without readback', async () => {
    const response = Promise.withResolvers<ReturnType<typeof gist>>(),
      entered = Promise.withResolvers<void>()
    const request = vi.fn<typeof requestOnce>(async (_url, options) => {
      if (options.method === 'PATCH') {
        entered.resolve()
        return response.promise
      }
      return gist('old')
    })
    let settled = false
    const result = createRuntimeGistWriter(request)
      .write(
        {
          request: { token: 'fixture-token', proxyPort: 17891, gistId: 'abcde' },
          payload: Buffer.from('new')
        },
        new AbortController().signal,
        {
          beforeSend: async () => {},
          beforeDispatch: () => {},
          submitted: () => {
            expect(request.mock.calls.at(-1)?.[1].method).toBe('PATCH')
            throw new Error('observer failure')
          }
        }
      )
      .then((value) => {
        settled = true
        return value
      })
    await entered.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    response.resolve(gist('new'))
    expect(await result).toMatchObject({ status: 'uncertain' })
    expect(request.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'PATCH'])
  })
})
