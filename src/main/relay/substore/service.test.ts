import { createHash } from 'crypto'
import { mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import { SubStoreResources, type SubStoreManifest } from './resources'
import { createSubStoreService } from './service'
import type { SubStoreRuntime } from './runtime'

const roots: string[] = []
async function fixture(overrides: Partial<Parameters<typeof createSubStoreService>[0]> = {}) {
  const root = await realpath(await mkdtemp('/private/tmp/relay-substore-service-'))
  roots.push(root)
  const backend = Buffer.from('/* fixture: not executed */'),
    zip = new AdmZip()
  zip.addFile('dist/index.html', Buffer.from('<html>fixture</html>'))
  const frontend = zip.toBuffer()
  const pin = (bytes: Buffer) => ({
    version: 'fixture',
    url: 'https://github.com/fixture',
    releaseURL: 'https://github.com/fixture',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length
  })
  const resources = new SubStoreResources(root, {
    schemaVersion: 1,
    backend: pin(backend),
    frontend: pin(frontend)
  })
  await resources.install(backend, frontend, new AbortController().signal)
  let alive = true
  const runtime: SubStoreRuntime = {
    pid: 12345,
    frontendURL: 'http://127.0.0.1:12345/',
    origins: ['http://127.0.0.1:12345'],
    alive: () => alive,
    stop: vi.fn(async () => {
      alive = false
    }),
    request: vi.fn(async (path) =>
      path.startsWith('/api/')
        ? JSON.stringify({ data: [{ name: 'A', url: 'PRIVATE' }] })
        : 'proxies:\n - {name: A, type: http, server: 127.0.0.1, port: 18190}\n'
    )
  }
  const save = vi.fn(async () => ({ id: 'saved' })),
    confirmAcquire = vi.fn(async () => true),
    confirmStart = vi.fn(async () => true),
    confirmSave = vi.fn(async () => true)
  const start = vi.fn(async (input: { registerCleanup(stop: () => Promise<void>): void }) => {
    input.registerCleanup(runtime.stop)
    return runtime
  })
  const service = createSubStoreService({
    resources,
    start,
    save,
    confirmAcquire,
    confirmStart,
    confirmSave,
    ...overrides
  })
  return {
    service,
    runtime,
    save,
    start,
    confirmAcquire,
    confirmStart,
    confirmSave,
    resources,
    backend,
    frontend
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('Sub-Store lifecycle and separate conversion commit', () => {
  it('installs separately confirmed candidate bytes only while idle and never starts a child', async () => {
    const f = await fixture()
    expect(
      (await f.service.installCandidates(f.backend, f.frontend, new AbortController().signal))
        .resourcesReady
    ).toBe(true)
    expect(f.start).not.toHaveBeenCalled()
    expect(f.confirmAcquire).not.toHaveBeenCalled()
    await f.service.start({ proxyPort: 7890 })
    await expect(
      f.service.installCandidates(f.backend, f.frontend, new AbortController().signal)
    ).rejects.toThrow('先结束')
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await f.service.stop()
  })
  it('propagates parent cancellation into the candidate copy without stopping a process', async () => {
    const f = await fixture(),
      controller = new AbortController()
    const install = vi.spyOn(f.resources, 'install')
    controller.abort()
    await expect(
      f.service.installCandidates(f.backend, f.frontend, controller.signal)
    ).rejects.toThrow()
    expect(install.mock.calls[0][2].aborted).toBe(true)
    expect(f.runtime.stop).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
  })
  it.each([false, true])(
    'reports actual retained resource readiness after a failed reacquisition, corrupt=%s',
    async (corrupt) => {
      const download = vi.fn(async (): Promise<Buffer> => {
        throw new Error('Fixture download failure.')
      })
      const f = await fixture({ download })
      expect((await f.service.inspect()).resourcesReady).toBe(true)
      if (corrupt) await writeFile(join(f.resources.directory, 'backend.cjs'), 'tampered')
      await expect(f.service.acquire({ proxyPort: 7890 })).rejects.toThrow()
      expect(f.service.state()).toMatchObject({ phase: 'failed', resourcesReady: !corrupt })
      expect(download).toHaveBeenCalledTimes(1)
      expect(f.start).not.toHaveBeenCalled()
    }
  )
  it('does no startup IO on construction and refuses conversion until explicitly started', async () => {
    const f = await fixture()
    expect(f.start).not.toHaveBeenCalled()
    await expect(f.service.prepareConversion({ kind: 'subscription', name: 'A' })).rejects.toThrow(
      '启动'
    )
    expect(f.save).not.toHaveBeenCalled()
  })
  it('returns metadata without subscription secrets and consumes a save credential only once', async () => {
    const f = await fixture()
    expect(await f.service.start({ proxyPort: 7890 })).toMatchObject({
      phase: 'running',
      pending: false
    })
    expect(await f.service.list()).toEqual({
      subscriptions: [{ name: 'A' }],
      collections: [{ name: 'A' }]
    })
    const plan = await f.service.prepareConversion({ kind: 'subscription', name: 'A' })
    expect(plan).not.toHaveProperty('text')
    expect(f.save).not.toHaveBeenCalled()
    await f.service.saveConversion({ evidenceId: plan.evidenceId })
    expect(f.save).toHaveBeenCalledTimes(1)
    await expect(f.service.saveConversion({ evidenceId: plan.evidenceId })).rejects.toThrow(
      '重新准备'
    )
    await f.service.stop()
    expect(f.runtime.stop).toHaveBeenCalledTimes(1)
  })
  it('preserves the owned handle when stop acknowledgement fails and blocks duplicate starts', async () => {
    const f = await fixture()
    await f.service.start({ proxyPort: 7890 })
    vi.mocked(f.runtime.stop).mockRejectedValueOnce(new Error('lost acknowledgement'))
    expect(await f.service.requestClose()).toBe(false)
    expect(f.service.state().phase).toBe('uncertain')
    await expect(f.service.start({ proxyPort: 7890 })).rejects.toThrow('未确认退出')
    expect(await f.service.requestClose()).toBe(true)
  })
  it('keeps cancellation and close pending until an in-flight start returns and cleanup finishes', async () => {
    const f = await fixture()
    let release: (runtime: SubStoreRuntime) => void = () => {
      throw new Error('missing resolver')
    }
    f.start.mockImplementationOnce(async (input) => {
      input.registerCleanup(f.runtime.stop)
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const pending = f.service.start({ proxyPort: 7890 })
    while (!f.start.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 1))
    await expect(f.service.list()).rejects.toThrow('等待')
    const close = f.service.requestClose()
    release(f.runtime)
    await expect(pending).rejects.toThrow()
    expect(await close).toBe(true)
    expect(f.runtime.stop).toHaveBeenCalled()
    expect(f.service.isBlocking()).toBe(false)
  })
  it('aborts a resource download on close, retains verified old resources and does not retry', async () => {
    const download = vi.fn(
      async (
        _pin: SubStoreManifest['backend'],
        _proxyPort: number,
        signal: AbortSignal
      ): Promise<Buffer> =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
    )
    const f = await fixture({ download })
    const pending = f.service.acquire({ proxyPort: 7890 })
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    const close = f.service.requestClose()
    await expect(pending).rejects.toThrow('未完成')
    expect(await close).toBe(true)
    expect(download).toHaveBeenCalledTimes(1)
    await expect(f.resources.load()).resolves.toHaveProperty('backendPath')
  })
  it('refuses save authorization that expires while confirmation is open and clears cancelled plans', async () => {
    let now = 1000
    const f = await fixture({
      now: () => now,
      confirmSave: async () => {
        now += 60001
        return true
      }
    })
    await f.service.start({ proxyPort: 7890 })
    const first = await f.service.prepareConversion({ kind: 'subscription', name: 'A' })
    await expect(f.service.saveConversion({ evidenceId: first.evidenceId })).rejects.toThrow('过期')
    expect(f.save).not.toHaveBeenCalled()
    const second = await f.service.prepareConversion({ kind: 'subscription', name: 'A' })
    f.service.cancel()
    await expect(f.service.saveConversion({ evidenceId: second.evidenceId })).rejects.toThrow(
      '重新准备'
    )
  })
  it('keeps the full source selector but bounds the outgoing private profile label', async () => {
    const f = await fixture(),
      name = '长'.repeat(128)
    vi.mocked(f.runtime.request).mockImplementation(async (path) =>
      path.startsWith('/api/')
        ? JSON.stringify({ data: [{ name }] })
        : 'proxies: [{name: A, type: http, server: 127.0.0.1, port: 18190}]'
    )
    await f.service.start({ proxyPort: 7890 })
    const plan = await f.service.prepareConversion({ kind: 'subscription', name })
    expect(plan.name.length).toBeLessThanOrEqual(120)
    await f.service.saveConversion({ evidenceId: plan.evidenceId })
    expect(f.save).toHaveBeenCalledWith(plan.name, expect.stringContaining('proxies:'))
  })
})
