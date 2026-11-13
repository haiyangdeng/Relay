import { describe, expect, it, vi } from 'vitest'
import { createCoreService } from './service'
import { isolatedCoreConfiguration, type RelayIsolatedCore } from './isolated-runtime'
import type { CoreStoreSnapshot } from './store'

function fixture() {
  let mode: 'rule' | 'global' | 'direct' = 'rule'
  const stop = vi.fn(async () => {}),
    update = vi.fn(async () => {}),
    release = vi.fn(async () => {})
  const session: RelayIsolatedCore = {
    pid: 1234,
    version: 'v1.19.33',
    directory: '/fixture/temporary',
    socket: '/fixture/api.sock',
    state: () => 'running',
    stop,
    read: async () => isolatedCoreConfiguration(mode)
  }
  const adapters = {
    inspect: vi.fn(async (): Promise<CoreStoreSnapshot> => ({
      mode: 'rule',
      revision: 'a'.repeat(64),
      lease: 'missing'
    })),
    resources: vi.fn(async () => ({
      executable: '/fixture/mihomo',
      version: 'v1.19.33',
      architecture: 'arm64' as const,
      sha256: 'b'.repeat(64)
    })),
    acquire: vi.fn(async () => ({ update, release })),
    start: vi.fn(async (selected: typeof mode, register: (stop: () => Promise<void>) => void) => {
      mode = selected
      register(stop)
      return session
    }),
    confirm: vi.fn(async () => false)
  }
  return { adapters, service: createCoreService(adapters), stop, update, release, session }
}
describe('Core control preparation, lifecycle and quit handshake', () => {
  it('does no startup IO and cancellation does not persist or start anything', async () => {
    const f = fixture()
    expect(f.service.state()).toMatchObject({
      phase: 'unknown',
      owned: false,
      trafficEnabled: false
    })
    expect(f.adapters.inspect).not.toHaveBeenCalled()
    const proof = await f.service.prepare({ mode: 'global' })
    expect((await f.service.action({ action: 'start', evidenceId: proof.evidenceId })).status).toBe(
      'cancelled'
    )
    expect(f.adapters.acquire).not.toHaveBeenCalled()
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
  it('starts only a prepared mode and waits for cleanup before releasing the record', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    const proof = await f.service.prepare({ mode: 'global' })
    expect(
      (await f.service.action({ action: 'start', evidenceId: proof.evidenceId })).state
    ).toMatchObject({ phase: 'running', owned: true, mode: 'global', pending: false })
    expect(f.adapters.acquire).toHaveBeenCalledWith('global', 'a'.repeat(64))
    expect(f.update).toHaveBeenCalledWith('running', 1234)
    const stopped = await f.service.action({ action: 'stop' })
    expect(stopped.state).toMatchObject({ phase: 'idle', owned: false, hasRecord: false })
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.release).toHaveBeenCalledTimes(1)
    await expect(
      f.service.action({ action: 'start', evidenceId: proof.evidenceId })
    ).rejects.toThrow('重新准备')
  })
  it('retains ownership after an uncertain cleanup and allows a safe retry', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    const proof = await f.service.prepare({ mode: 'rule' })
    await f.service.action({ action: 'start', evidenceId: proof.evidenceId })
    f.stop.mockRejectedValueOnce(new Error('PRIVATE cleanup error'))
    expect((await f.service.action({ action: 'stop' })).state).toMatchObject({
      owned: true,
      uncertain: true,
      phase: 'failed'
    })
    expect(f.release).not.toHaveBeenCalled()
    expect(await f.service.requestClose()).toBe(true)
    expect(f.stop).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(f.service.state())).not.toContain('PRIVATE')
  })
  it('does not release records before an in-flight start completes during quit', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    let ready!: (value: RelayIsolatedCore) => void
    f.adapters.start.mockImplementation((_mode, register) => {
      register(f.stop)
      return new Promise((resolve) => {
        ready = resolve
      })
    })
    const proof = await f.service.prepare({ mode: 'rule' }),
      starting = f.service.action({ action: 'start', evidenceId: proof.evidenceId })
    await vi.waitFor(() => expect(f.adapters.start).toHaveBeenCalled())
    const closing = f.service.requestClose()
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
    ready(f.session)
    await starting
    expect(await closing).toBe(true)
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.service.state().owned).toBe(false)
  })
  it('rejects injection, stale proofs and prepared data changed during confirmation', async () => {
    let now = 0
    const f = fixture(),
      service = createCoreService({ ...f.adapters, now: () => now })
    for (const raw of [{ mode: 'rule', path: '/injected' }, { mode: 'bad' }])
      await expect(service.prepare(raw)).rejects.toThrow()
    const proof = await service.prepare({ mode: 'rule' })
    await expect(
      service.action({ action: 'start', evidenceId: proof.evidenceId, pid: 1234 })
    ).rejects.toThrow()
    now = 60001
    await expect(service.action({ action: 'start', evidenceId: proof.evidenceId })).rejects.toThrow(
      '重新准备'
    )
    expect(f.adapters.confirm).not.toHaveBeenCalled()
  })
  it('blocks old disk records and never stops a process using their contents', async () => {
    const f = fixture()
    f.adapters.inspect.mockResolvedValue({
      mode: 'rule',
      revision: 'a'.repeat(64),
      lease: 'present'
    })
    const proof = await f.service.prepare({ mode: 'rule' })
    expect(proof.canStart).toBe(false)
    await expect(
      f.service.action({ action: 'start', evidenceId: proof.evidenceId })
    ).rejects.toThrow()
    await expect(f.service.action({ action: 'stop' })).rejects.toThrow('所有权')
    expect(await f.service.requestClose()).toBe(true)
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.adapters.acquire).not.toHaveBeenCalled()
  })
  it('rechecks proof expiry after confirmation before persisting or starting', async () => {
    let now = 0
    const f = fixture(),
      service = createCoreService({ ...f.adapters, now: () => now })
    f.adapters.confirm.mockImplementation(async () => {
      now = 60001
      return true
    })
    const proof = await service.prepare({ mode: 'rule' })
    expect((await service.action({ action: 'start', evidenceId: proof.evidenceId })).status).toBe(
      'failed'
    )
    expect(f.adapters.acquire).not.toHaveBeenCalled()
    expect(f.adapters.start).not.toHaveBeenCalled()
  })
  it('cancels an open confirmation during quit without acquiring a record', async () => {
    const f = fixture()
    let answer!: (value: boolean) => void
    f.adapters.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const proof = await f.service.prepare({ mode: 'rule' })
    const starting = f.service.action({ action: 'start', evidenceId: proof.evidenceId })
    const closing = f.service.requestClose()
    answer(true)
    expect((await starting).status).toBe('cancelled')
    expect(await closing).toBe(true)
    expect(f.adapters.acquire).not.toHaveBeenCalled()
  })
  it('cleans up an unhealthy start and retains a failed record release for retry', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    f.session.read = async () => ({ ...isolatedCoreConfiguration('rule'), port: 7890 })
    f.release.mockRejectedValueOnce(new Error('PRIVATE record'))
    const proof = await f.service.prepare({ mode: 'rule' })
    expect(
      (await f.service.action({ action: 'start', evidenceId: proof.evidenceId })).state
    ).toMatchObject({ owned: true, uncertain: true })
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(await f.service.requestClose()).toBe(true)
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.release).toHaveBeenCalledTimes(2)
  })
  it('waits for startup failure cleanup rather than losing the process handle', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(true)
    f.adapters.start.mockImplementation(async (_mode, register) => {
      register(f.stop)
      throw new Error('PRIVATE failed after spawn')
    })
    const proof = await f.service.prepare({ mode: 'rule' })
    expect((await f.service.action({ action: 'start', evidenceId: proof.evidenceId })).status).toBe(
      'failed'
    )
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.service.state().owned).toBe(false)
  })
})
