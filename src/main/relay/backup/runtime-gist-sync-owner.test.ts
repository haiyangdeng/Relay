import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayCoreMode } from '../../../shared/relay/core'
import { RUNTIME_GIST_FILENAME } from '../../../shared/relay/runtime-gist'
import { profileRuntimeSource } from '../__fixtures__/profile-runtime'
import { createLocalProxyService } from '../core/local-proxy-service'
import { localProxyConfiguration } from '../core/local-proxy-runtime'
import type { RelayOwnedCore } from '../core/owned-runtime'
import { inspectProfile } from '../profiles/inspect'
import { profileHash } from '../profiles/source'
import type { RelayBackupAccountsStore } from './accounts-store'
import { backupAccountsFixture, gistAccount } from './accounts.test-fixture'
import { createRuntimeGistSyncService } from './runtime-gist-sync'

const gistId = 'abcdef0123456789',
  services: ReturnType<typeof createRuntimeGistSyncService>[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
  vi.useRealTimers()
})

// Real local-proxy capture closures and account storage, with injected core
// receipts, listener ownership, crypto and HTTP. No native core or network runs.
async function fixture(accounts: RelayBackupAccountsStore) {
  let mode: RelayCoreMode = 'rule',
    child: ReturnType<RelayOwnedCore['state']> = 'running',
    remote = 'previous remote body',
    firstGet: (() => void) | undefined,
    firstWrite: (() => void) | undefined,
    beforeMode: (() => Promise<void>) | undefined,
    notifySync = (): void => {}
  const port = 18191,
    summary = inspectProfile(profileRuntimeSource).summary
  if (!summary) throw new Error('Missing fixture summary')
  const selection = {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: profileHash(profileRuntimeSource)
    },
    methods: string[] = [],
    uploads: Array<{ mode: string; at: number }> = []
  const stop = async (): Promise<void> => {
    child = 'stopped'
  }
  const session: RelayOwnedCore = {
    pid: 1234,
    directory: '/fixture',
    socket: '/fixture/api.sock',
    version: 'v1.19.33',
    state: () => child,
    read: async (endpoint) =>
      endpoint === 'configs'
        ? { ...JSON.parse(localProxyConfiguration(profileRuntimeSource, port).configuration), mode }
        : endpoint === 'version'
          ? { version: 'v1.19.33' }
          : { proxies: { Group: { type: 'Selector', now: 'Node', all: ['Node', 'DIRECT'] } } },
    group: async () => ({ now: 'Node' }),
    select: async () => {},
    patchMode: async (next) => {
      await beforeMode?.()
      mode = next
    },
    stop
  }
  const core = createLocalProxyService({
    read: async () => ({
      profile: { ...selection, name: 'Fixture', createdAt: '2026-11-01', summary },
      text: profileRuntimeSource,
      revision: 'b'.repeat(64)
    }),
    inspect: async () => ({ mode: 'rule', revision: 'a'.repeat(64), lease: 'missing' }),
    resources: async () => ({
      executable: '/fixture/core',
      version: 'v1.19.33',
      architecture: 'arm64',
      sha256: 'c'.repeat(64)
    }),
    portAvailable: async () => true,
    acquire: async () => ({ update: async () => {}, release: async () => {} }),
    start: async (_source, _port, register) => {
      register(stop)
      return session
    },
    confirmStart: async () => true,
    confirmStop: async () => true,
    confirmMode: async () => true,
    ownsHttpListener: async () => true,
    onRuntimeChanged: () => notifySync()
  })
  const plan = await core.prepare({ profile: selection, httpPort: port }),
    started = await core.action({ action: 'start', evidenceId: plan.evidenceId }),
    instanceId = started.state.instanceId
  if (!instanceId) throw new Error('Missing fixture owner')
  const account = await accounts.save({ ...gistAccount, proxyPort: port })
  const sync = createRuntimeGistSyncService({
    accounts,
    captureRuntime: (signal) => core.captureRuntime(signal),
    canRun: () => !core.state().pending,
    authorize: async (permission) => {
      let revoked = false
      return {
        permission: structuredClone(permission),
        isLive: () => !revoked,
        credential: async () => accounts.credential({ id: account.id, revision: account.revision }),
        revoke: () => {
          revoked = true
        }
      }
    },
    request: async (_url, options) => {
      methods.push(options.method)
      if (options.method === 'GET' && firstGet) {
        const callback = firstGet
        firstGet = undefined
        callback()
      }
      if (options.method === 'PATCH') {
        remote = JSON.parse(String(options.body)).files[RUNTIME_GIST_FILENAME].content
        uploads.push({ mode: JSON.parse(remote).mode, at: Date.now() })
        const callback = firstWrite
        firstWrite = undefined
        callback?.()
      }
      const bytes = Buffer.from(
        JSON.stringify({
          id: gistId,
          public: false,
          files: {
            [RUNTIME_GIST_FILENAME]: {
              filename: RUNTIME_GIST_FILENAME,
              content: remote,
              size: Buffer.byteLength(remote),
              truncated: false
            }
          }
        })
      )
      return { status: 200, headers: {}, body: '', bytes }
    }
  })
  notifySync = () => sync.changed()
  services.push(sync)
  return {
    core,
    sync,
    account,
    instanceId,
    methods,
    uploads,
    externalMode: (next: RelayCoreMode) => {
      mode = next
    },
    beforeMode: (callback: () => Promise<void>) => {
      beforeMode = callback
    },
    firstGet: (callback: () => void) => {
      firstGet = callback
    },
    firstWrite: (callback: () => void) => {
      firstWrite = callback
    },
    arm: () => sync.arm({ id: account.id, revision: account.revision, gistId })
  }
}

describe('Runtime Gist with actual owned-runtime capture receipts', () => {
  it('coalesces an observed mode change before PATCH using this attempt’s capture receipt', async () => {
    vi.useFakeTimers({ now: 10000 })
    await backupAccountsFixture(async ({ store }) => {
      const f = await fixture(store)
      try {
        f.firstGet(() => f.externalMode('global'))
        await f.arm()
        await vi.advanceTimersByTimeAsync(350)
        await f.sync.whenIdle()
        expect(f.methods).toEqual(['GET'])
        expect(f.sync.state()).toMatchObject({
          enabled: true,
          dirty: true,
          lastResult: 'superseded'
        })
        await vi.advanceTimersByTimeAsync(350)
        await f.sync.whenIdle()
        expect(f.uploads.map((upload) => upload.mode)).toEqual(['global'])
        expect(f.sync.state()).toMatchObject({
          enabled: true,
          dirty: false,
          lastResult: 'uploaded'
        })
      } finally {
        await f.sync.stop()
      }
    })
  })
  it('finishes R1 readback while a genuine same-owner mode action is pending, then uploads R2', async () => {
    vi.useFakeTimers({ now: 10000 })
    await backupAccountsFixture(async ({ store }) => {
      const f = await fixture(store)
      let release!: () => void, modeAction: ReturnType<typeof f.core.action> | undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        f.beforeMode(() => held)
        f.firstWrite(() => {
          modeAction = f.core.action({ action: 'mode', instanceId: f.instanceId, mode: 'global' })
        })
        await f.arm()
        await vi.advanceTimersByTimeAsync(350)
        await f.sync.whenIdle()
        expect(f.core.state().pending).toBe(true)
        expect(f.uploads.map((upload) => upload.mode)).toEqual(['rule'])
        expect(f.sync.state()).toMatchObject({ enabled: true, dirty: true, lastResult: 'uploaded' })
        release()
        expect((await modeAction)?.status).toBe('modeChanged')
        await vi.advanceTimersByTimeAsync(1100)
        await f.sync.whenIdle()
        expect(f.uploads.map((upload) => upload.mode)).toEqual(['rule', 'global'])
        expect(f.uploads[1].at - f.uploads[0].at).toBeGreaterThanOrEqual(1000)
        expect(f.sync.state()).toMatchObject({
          enabled: true,
          dirty: false,
          lastResult: 'uploaded'
        })
      } finally {
        release()
        await modeAction
        await f.sync.stop()
      }
    })
  })
})
