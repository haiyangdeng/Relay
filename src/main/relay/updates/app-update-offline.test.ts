import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginResponse, requestOnce } from '../../resolve/plugin/http-client'
import { appReleaseConfiguration, type AppReleaseConfiguration } from './app/configuration'
import { AppInstallationJournal } from './app/journal'
import { AppInstallerAlreadyRunning, MacAppUpdatePlatform } from './app/macos'
import { parseAppRelease, publicAppRelease } from './app/release'
import { createAppUpdateService } from './app/service'
import { AppUpdateCandidateStore } from './app/store'

const mocks = vi.hoisted(() => ({
  release: null as AppReleaseConfiguration | null,
  request: vi.fn<typeof requestOnce>(),
  execFile: vi.fn(() => {
    throw new Error('OS commands are forbidden in this fixture')
  })
}))

vi.mock('../../resolve/plugin/http-client', () => ({ requestOnce: mocks.request }))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))
vi.mock('./app/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./app/configuration')>()
  return {
    ...actual,
    get relayAppReleaseConfiguration() {
      return mocks.release ?? actual.relayAppReleaseConfiguration
    }
  }
})

const releaseConfig = {
  feedURLs: {
    arm64: 'https://relay-fixture.invalid/arm64/latest-mac.yml',
    x64: 'https://relay-fixture.invalid/x64/latest-mac.yml'
  },
  downloadOrigins: ['https://relay-fixture.invalid'],
  applicationIdentifier: 'local.relay.network.preview',
  applicationBundleName: 'Relay.app',
  packageIdentifier: 'local.relay.fixture.pkg',
  publisherTeamID: 'FIXTURE123',
  approvedInstallerScriptSHA256: [],
  maximumPackageBytes: 1024 * 1024
} satisfies AppReleaseConfiguration
const payload = Buffer.from('xar!synthetic fixture bytes')
const metadata = Buffer.from(
  JSON.stringify({
    version: '2.0.1',
    releaseDate: '2026-11-08T00:00:00.000Z',
    files: [
      {
        url: 'Relay-fixture.pkg',
        sha512: createHash('sha512').update(payload).digest('base64'),
        size: payload.length
      }
    ]
  })
)
const response = (bytes: Buffer): PluginResponse => ({ status: 200, headers: {}, body: '', bytes })

function fixture(configured = true) {
  if (configured) mocks.release = releaseConfig
  const context = {
    home: '/fixture/home',
    stateRoot: '/fixture/home/Library/Application Support/Relay-Preview'
  }
  const trusted = appReleaseConfiguration(releaseConfig)
  const release = parseAppRelease(metadata, trusted.value, trusted.revision, 'arm64', '2.0.0')
  if (!release) throw new Error('Expected a newer fixture release')
  const candidate = {
    ...publicAppRelease(release),
    id: 'd474716b-3349-474b-b888-dd9c94975592',
    sha256: createHash('sha256').update(payload).digest('hex'),
    stagedAt: 1
  }
  const stored = { release, candidate, path: '/fixture/Relay-fixture.pkg' }

  // Constructors retain paths only. All storage methods used by the service are replaced.
  const store = new AppUpdateCandidateStore(context)
  const stage = vi.spyOn(store, 'stage').mockResolvedValue(candidate)
  const resolve = vi.spyOn(store, 'resolve').mockResolvedValue(stored)
  vi.spyOn(store, 'list').mockResolvedValue({ candidates: [], incomplete: 0 })
  const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined)
  const journal = new AppInstallationJournal(context)
  let journalState: Awaited<ReturnType<AppInstallationJournal['read']>> = {
    value: null,
    revision: '',
    exists: false
  }
  const read = vi
    .spyOn(journal, 'read')
    .mockImplementation(async () => structuredClone(journalState))
  const write = vi.spyOn(journal, 'write').mockImplementation(async (revision, value, current) => {
    current()
    expect(revision).toBe(journalState.revision)
    journalState = {
      value: structuredClone(value),
      revision: `rev-${write.mock.calls.length}`,
      exists: true
    }
    return structuredClone(journalState)
  })

  const platform = new MacAppUpdatePlatform(store)
  const installerRunning = vi.spyOn(platform, 'installerRunning').mockResolvedValue(false)
  const installed = (version: string, receiptVersion: string | null = version) => ({
    application: {
      version,
      identifier: releaseConfig.applicationIdentifier,
      team: releaseConfig.publisherTeamID,
      signatureVerified: true as const
    },
    receiptVersion
  })
  const inspectInstalled = vi
    .spyOn(platform, 'inspectInstalled')
    .mockResolvedValue(installed('2.0.0'))
  const verifyPackage = vi.spyOn(platform, 'verifyPackage').mockResolvedValue({
    sha256: candidate.sha256,
    version: release.version,
    packageIdentifier: releaseConfig.packageIdentifier,
    applicationIdentifier: releaseConfig.applicationIdentifier,
    team: releaseConfig.publisherTeamID,
    architecture: release.architecture,
    gatekeeperAccepted: true,
    notarizationAssessed: true
  })
  const openInstaller = vi.spyOn(platform, 'openInstaller').mockResolvedValue(undefined)
  const proxy = { instanceId: 'fixture', configurationRevision: 'fixture', pid: 123, port: 17890 }
  const network = { acquire: vi.fn(async () => proxy), assertCurrent: vi.fn(async () => {}) }
  const releaseHandoff = vi.fn()
  const handoff = vi.fn(async (assertCurrent: () => void) => ({
    assertCurrent: async () => assertCurrent(),
    release: releaseHandoff
  }))
  const confirmDownload = vi.fn(async () => true)
  const confirmInstall = vi.fn(async () => true)
  const create = (running = '2.0.0') =>
    createAppUpdateService({
      store,
      journal,
      platform,
      network,
      handoff,
      assertIdle: vi.fn(),
      runningVersion: () => running,
      architecture: 'arm64',
      confirmDownload,
      confirmInstall,
      confirmRecovery: vi.fn(async () => true),
      confirmRemove: vi.fn(async () => true)
    })
  return {
    create,
    candidate,
    stored,
    proxy,
    stage,
    resolve,
    remove,
    read,
    write,
    network,
    handoff,
    releaseHandoff,
    installed,
    installerRunning,
    inspectInstalled,
    verifyPackage,
    openInstaller,
    confirmDownload,
    confirmInstall
  }
}

beforeEach(() => {
  mocks.release = null
  mocks.request.mockReset().mockRejectedValue(new Error('Unexpected fixture transport call'))
})

afterEach(() => {
  expect(mocks.execFile).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

describe('Relay App updater offline boundaries', () => {
  it('keeps the actual unconfigured release gate closed without network or installer activity', async () => {
    const f = fixture(false),
      service = f.create()
    expect(service.isBlocking()).toBe(true)
    await service.initialize()
    expect(await service.state()).toMatchObject({
      configured: false,
      latest: null,
      installation: null
    })
    await expect(service.check({ url: releaseConfig.feedURLs.arm64 })).rejects.toThrow('不接受URL')
    await expect(service.check()).rejects.toThrow('尚未配置')
    await expect(service.prepareInstall({ id: f.candidate.id })).rejects.toThrow('尚未配置')
    expect(f.network.acquire).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.verifyPackage).not.toHaveBeenCalled()
    expect(f.openInstaller).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('keeps the current install confirmation when an older prepare or stale evidence arrives', async () => {
    const f = fixture(),
      service = f.create()
    await service.initialize()
    const late = Promise.withResolvers<typeof f.stored>()
    f.resolve.mockImplementationOnce(() => late.promise)
    const superseded = service.prepareInstall({ id: f.candidate.id })
    const current = await service.prepareInstall({ id: f.candidate.id })
    late.resolve(f.stored)
    await expect(superseded).rejects.toThrow('准备已失效')
    await expect(
      service.install({ evidenceId: 'f3de8910-b644-4bbc-ac65-3cb5b8895875' })
    ).rejects.toThrow('重新准备')
    await expect(service.download({ evidenceId: current.evidenceId })).rejects.toThrow('重新准备')
    f.confirmInstall.mockResolvedValueOnce(false)
    await expect(service.install({ evidenceId: current.evidenceId })).resolves.toEqual({
      status: 'cancelled'
    })
    await expect(service.install({ evidenceId: current.evidenceId })).rejects.toThrow('重新准备')
    expect(f.confirmInstall).toHaveBeenCalledOnce()
    expect(f.openInstaller).not.toHaveBeenCalled()
  })

  it('lets a newer download preparation supersede an unresolved install preparation', async () => {
    const f = fixture(),
      service = f.create()
    await service.initialize()
    mocks.request.mockResolvedValueOnce(response(metadata))
    await service.check()
    const late = Promise.withResolvers<typeof f.stored>()
    f.resolve.mockImplementationOnce(() => late.promise)
    const superseded = service.prepareInstall({ id: f.candidate.id })
    const current = service.prepareDownload()
    late.resolve(f.stored)
    await expect(superseded).rejects.toThrow('准备已失效')
    f.confirmDownload.mockResolvedValueOnce(false)
    await expect(service.download({ evidenceId: current.evidenceId })).resolves.toEqual({
      status: 'cancelled'
    })
    expect(f.confirmInstall).not.toHaveBeenCalled()
    expect(f.openInstaller).not.toHaveBeenCalled()
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('discards late bytes after cancellation and consumes the download evidence', async () => {
    const f = fixture(),
      service = f.create()
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const late = Promise.withResolvers<PluginResponse>()
    mocks.request
      .mockResolvedValueOnce(response(metadata))
      .mockImplementationOnce((_url, options) => {
        entered.resolve(options.signal)
        return late.promise
      })
    await service.initialize()
    await service.check()
    const plan = service.prepareDownload()
    const pending = service.download({ evidenceId: plan.evidenceId })
    const signal = await entered.promise
    expect(signal?.aborted).toBe(false)
    expect(service.isBusy()).toBe(true)
    service.cancel()
    expect(signal?.aborted).toBe(true)
    late.resolve(response(payload))
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    await service.whenIdle()
    expect(service.isBusy()).toBe(false)
    expect(f.stage).not.toHaveBeenCalled()
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.request).toHaveBeenLastCalledWith(
      'https://relay-fixture.invalid/arm64/Relay-fixture.pkg',
      expect.objectContaining({ proxy: { host: '127.0.0.1', port: f.proxy.port } })
    )
    await expect(service.download({ evidenceId: plan.evidenceId })).rejects.toThrow('重新准备')
  })

  it('rejects a same-size package with the wrong SHA-512 before staging', async () => {
    const f = fixture(),
      service = f.create()
    const tampered = Buffer.from(payload)
    tampered[4] ^= 1
    mocks.request
      .mockResolvedValueOnce(response(metadata))
      .mockResolvedValueOnce(response(tampered))
    await service.initialize()
    await service.check()
    const plan = service.prepareDownload()
    await expect(service.download({ evidenceId: plan.evidenceId })).rejects.toThrow(
      '完整性校验失败'
    )
    expect(f.stage).not.toHaveBeenCalled()
    expect(f.openInstaller).not.toHaveBeenCalled()
    expect(service.isBlocking()).toBe(false)
  })

  it('checks trust only after separate install consent and never opens a rejected package', async () => {
    const f = fixture(),
      service = f.create()
    f.confirmInstall.mockResolvedValueOnce(false)
    f.verifyPackage.mockRejectedValueOnce(new Error('fixture publisher rejected'))
    await service.initialize()
    const cancelled = await service.prepareInstall({ id: f.candidate.id })
    expect(f.verifyPackage).not.toHaveBeenCalled()
    await expect(service.install({ evidenceId: cancelled.evidenceId })).resolves.toEqual({
      status: 'cancelled'
    })
    expect(f.handoff).not.toHaveBeenCalled()
    const approved = await service.prepareInstall({ id: f.candidate.id })
    await expect(service.install({ evidenceId: approved.evidenceId })).rejects.toThrow(
      'fixture publisher rejected'
    )
    expect(f.confirmInstall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mayContactAppleTrustServices: true,
        opensSystemInstaller: true,
        serviceQuitsOrRestarts: false
      })
    )
    expect(f.verifyPackage).toHaveBeenCalledOnce()
    expect(f.releaseHandoff).toHaveBeenCalledOnce()
    expect(f.openInstaller).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
    expect(service.isBlocking()).toBe(false)
  })

  it('keeps installer handoff pending across restart until all version evidence matches', async () => {
    const f = fixture(),
      service = f.create()
    f.openInstaller.mockImplementationOnce(async (_path, current) => {
      current()
      expect((await f.read()).value?.phase).toBe('handoff-intent')
    })
    await service.initialize()
    const plan = await service.prepareInstall({ id: f.candidate.id })
    await expect(service.install({ evidenceId: plan.evidenceId })).resolves.toEqual({
      status: 'installer-opened'
    })
    const opened = (await service.state()).installation
    expect(opened).toMatchObject({ phase: 'installer-opened', candidateId: f.candidate.id })
    expect(service.isBlocking()).toBe(true)
    expect(f.openInstaller).toHaveBeenCalledOnce()
    expect(f.releaseHandoff).toHaveBeenCalledOnce()

    const restarted = f.create('2.0.1')
    await restarted.initialize()
    expect(restarted.isBlocking()).toBe(true)
    await expect(restarted.remove({ id: f.candidate.id })).rejects.toThrow('候选必须保留')
    expect(f.remove).not.toHaveBeenCalled()
    f.inspectInstalled.mockResolvedValueOnce(f.installed('2.0.1', null))
    await restarted.recover()
    expect((await restarted.state()).installation).toMatchObject({ phase: 'uncertain' })
    expect(restarted.isBlocking()).toBe(true)
    f.inspectInstalled.mockResolvedValueOnce(f.installed('2.0.1'))
    await restarted.recover()
    expect((await restarted.state()).installation).toMatchObject({ phase: 'installed' })
    expect(restarted.isBlocking()).toBe(false)
    expect(f.openInstaller).toHaveBeenCalledOnce()
    expect(f.write.mock.calls.map(([, value]) => value.phase)).toEqual([
      'handoff-intent',
      'installer-opened',
      'uncertain',
      'installed'
    ])
  })

  it.each([
    ['installed', '2.0.1', false],
    ['dismissed', '2.0.0', true]
  ])(
    'releases a confirmed recovery after the %s write acknowledgement is lost',
    async (phase, version, dismiss) => {
      const f = fixture(),
        service = f.create()
      await service.initialize()
      const plan = await service.prepareInstall({ id: f.candidate.id })
      await service.install({ evidenceId: plan.evidenceId })

      const restarted = f.create(version)
      await restarted.initialize()
      f.inspectInstalled.mockResolvedValueOnce(f.installed(version))
      const write = f.write.getMockImplementation()
      if (!write) throw new Error('missing fixture journal implementation')
      f.write.mockImplementationOnce(async (...args) => {
        await write(...args)
        throw new Error('fixture recovery acknowledgement lost')
      })
      await expect(restarted.recover(dismiss)).resolves.toBeUndefined()
      expect((await restarted.state()).installation).toMatchObject({ phase })
      expect(restarted.isBlocking()).toBe(false)
      expect(f.openInstaller).toHaveBeenCalledOnce()
    }
  )

  it('keeps recovery pending when the closing journal write did not commit', async () => {
    const f = fixture(),
      service = f.create()
    await service.initialize()
    const plan = await service.prepareInstall({ id: f.candidate.id })
    await service.install({ evidenceId: plan.evidenceId })
    f.write.mockRejectedValueOnce(new Error('fixture recovery did not commit'))
    await expect(service.recover(true)).rejects.toThrow('fixture recovery did not commit')
    expect((await service.state()).installation).toMatchObject({ phase: 'installer-opened' })
    expect(service.isBlocking()).toBe(true)
    expect(f.openInstaller).toHaveBeenCalledOnce()
  })

  it('releases the install barrier when intent writing fails and a local readback confirms no pending intent', async () => {
    const f = fixture(),
      service = f.create()
    await service.initialize()
    const plan = await service.prepareInstall({ id: f.candidate.id })
    f.write.mockRejectedValueOnce(new Error('fixture intent was not persisted'))
    await expect(service.install({ evidenceId: plan.evidenceId })).rejects.toThrow(
      'fixture intent was not persisted'
    )
    expect(f.openInstaller).not.toHaveBeenCalled()
    expect(f.releaseHandoff).toHaveBeenCalledOnce()
    expect(service.isBlocking()).toBe(false)
    expect((await service.state()).installation).toBeNull()
  })

  it('retains a durable pending intent when the write completes without a confirmed receipt', async () => {
    const f = fixture(),
      service = f.create()
    await service.initialize()
    const plan = await service.prepareInstall({ id: f.candidate.id })
    const commit = f.write.getMockImplementation()
    if (!commit) throw new Error('missing fixture journal implementation')
    f.write.mockImplementationOnce(async (...args) => {
      await commit(...args)
      throw new Error('fixture intent receipt lost')
    })
    await expect(service.install({ evidenceId: plan.evidenceId })).rejects.toThrow(
      '交接或回执未确认'
    )
    expect(f.openInstaller).not.toHaveBeenCalled()
    expect(service.isBlocking()).toBe(true)
    expect((await service.state()).installation).toMatchObject({ phase: 'handoff-intent' })
  })

  it('retains the uncertain journal when the final owned-file handoff check rejects', async () => {
    const f = fixture(),
      service = f.create()
    await service.initialize()
    const plan = await service.prepareInstall({ id: f.candidate.id })
    f.openInstaller.mockImplementationOnce(async (stored, assertCurrent, assertLeaseCurrent) => {
      expect(stored.candidate).toEqual(f.candidate)
      expect((await f.read()).value?.phase).toBe('handoff-intent')
      await assertLeaseCurrent()
      assertCurrent()
      throw new Error('fixture handoff bytes changed')
    })
    await expect(service.install({ evidenceId: plan.evidenceId })).rejects.toThrow(
      '交接或回执未确认'
    )
    expect(service.isBlocking()).toBe(true)
    expect((await service.state()).installation).toMatchObject({ phase: 'uncertain' })
    expect(f.write.mock.calls.map(([, value]) => value.phase)).toEqual([
      'handoff-intent',
      'uncertain'
    ])
  })

  it('closes the recorded intent when the final process check refuses to open Installer', async () => {
    const f = fixture(),
      service = f.create()
    await service.initialize()
    const plan = await service.prepareInstall({ id: f.candidate.id })
    const captured = Promise.withResolvers<Awaited<ReturnType<typeof f.read>>>()
    const delayed = Promise.withResolvers<Awaited<ReturnType<typeof f.read>>>()
    const status = Promise.withResolvers<Awaited<ReturnType<typeof service.state>>>()
    f.openInstaller.mockImplementationOnce(async () => {
      captured.resolve(await f.read())
      f.read.mockReturnValueOnce(delayed.promise)
      status.resolve(service.state())
      throw new AppInstallerAlreadyRunning()
    })
    await expect(service.install({ evidenceId: plan.evidenceId })).rejects.toThrow(
      AppInstallerAlreadyRunning
    )
    delayed.resolve(await captured.promise)
    expect((await status.promise).installation?.phase).toBe('handoff-intent')
    expect(f.releaseHandoff).toHaveBeenCalledOnce()
    expect(service.isBlocking()).toBe(false)
    expect((await service.state()).installation).toMatchObject({ phase: 'dismissed' })
    expect(f.write.mock.calls.map(([, value]) => value.phase)).toEqual([
      'handoff-intent',
      'dismissed'
    ])
  })

  it('accepts the exact saved refusal after its write acknowledgement is lost', async () => {
    const f = fixture(),
      service = f.create()
    await service.initialize()
    const plan = await service.prepareInstall({ id: f.candidate.id })
    f.openInstaller.mockRejectedValueOnce(new AppInstallerAlreadyRunning())
    const write = f.write.getMockImplementation()
    if (!write) throw new Error('missing fixture journal implementation')
    f.write.mockImplementation(async (...args) => {
      const saved = await write(...args)
      if (args[1].phase === 'dismissed') throw new Error('fixture closure acknowledgement lost')
      return saved
    })
    await expect(service.install({ evidenceId: plan.evidenceId })).rejects.toThrow(
      AppInstallerAlreadyRunning
    )
    expect(service.isBlocking()).toBe(false)
    expect((await service.state()).installation).toMatchObject({ phase: 'dismissed' })
  })

  it('retains the pending barrier when the refusal cannot be recorded or confirmed', async () => {
    const f = fixture(),
      service = f.create()
    await service.initialize()
    const plan = await service.prepareInstall({ id: f.candidate.id })
    f.openInstaller.mockRejectedValueOnce(new AppInstallerAlreadyRunning())
    const write = f.write.getMockImplementation()
    if (!write) throw new Error('missing fixture journal implementation')
    f.write.mockImplementation(async (...args) => {
      if (args[1].phase === 'dismissed') throw new Error('fixture closure did not commit')
      return write(...args)
    })
    await expect(service.install({ evidenceId: plan.evidenceId })).rejects.toThrow(
      '交接或回执未确认'
    )
    expect(service.isBlocking()).toBe(true)
    expect((await service.state()).installation).toMatchObject({ phase: 'uncertain' })
    expect(f.write.mock.calls.map(([, value]) => value.phase)).toEqual([
      'handoff-intent',
      'dismissed',
      'uncertain'
    ])
  })
})
