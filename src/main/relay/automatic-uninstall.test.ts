import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  automaticUninstallNative,
  automaticUninstallRequested,
  prepareAutomaticUninstall,
  startAutomaticUninstallMonitor
} from './automatic-uninstall'

const fixture = vi.hoisted(() => ({ stat: vi.fn(), exec: vi.fn(), end: vi.fn() }))
vi.mock('fs/promises', () => ({ lstat: fixture.stat }))
vi.mock('child_process', () => ({ execFile: fixture.exec }))

beforeEach(() => {
  vi.useFakeTimers()
  fixture.end.mockReset()
  fixture.stat.mockReset().mockImplementation(async (path: string) => ({
    uid: 0,
    mode: path === automaticUninstallNative ? 0o100755 : 0o40755,
    nlink: 1,
    isDirectory: () => path !== automaticUninstallNative,
    isFile: () => path === automaticUninstallNative,
    isSymbolicLink: () => false
  }))
  fixture.exec.mockReset().mockImplementation((_path, _args, _options, done) => {
    done(null, JSON.stringify({ requested: true, nativeExecutable: automaticUninstallNative }))
    return { stdin: { end: fixture.end } }
  })
})
afterEach(() => vi.useRealTimers())

describe('authenticated automatic uninstall probe', () => {
  it('runs only the fixed installed native with no request body and bounded output/time', async () => {
    expect(await automaticUninstallRequested()).toBe(true)
    expect(fixture.exec).toHaveBeenCalledWith(
      automaticUninstallNative,
      ['--automatic-uninstall-status'],
      { timeout: 3000, maxBuffer: 4096, encoding: 'utf8' },
      expect.any(Function)
    )
    expect(fixture.end).toHaveBeenCalledWith()
  })
  it.each([
    { uid: 501 },
    { mode: 0o40777 },
    { isSymbolicLink: () => true },
    { isDirectory: () => false }
  ])('does not execute through an untrusted installation parent: %j', async (override) => {
    fixture.stat.mockResolvedValueOnce({
      uid: 0,
      mode: 0o40755,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      ...override
    })
    expect(await automaticUninstallRequested()).toBe(false)
    expect(fixture.exec).not.toHaveBeenCalled()
  })
  it('treats a missing installation as no request', async () => {
    fixture.stat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect(await automaticUninstallRequested()).toBe(false)
    expect(fixture.exec).not.toHaveBeenCalled()
  })
  it.each([
    '{"requested":false}',
    '{"requested":true}',
    '{"requested":true,"nativeExecutable":"/tmp/RelayNative"}',
    '[]',
    'invalid'
  ])('rejects an absent, invalid or redirected intent: %s', async (output) => {
    fixture.exec.mockImplementationOnce((_path, _args, _options, done) => {
      done(null, output)
      return { stdin: { end: fixture.end } }
    })
    expect(await automaticUninstallRequested()).toBe(false)
  })
})

describe('automatic uninstall monitor', () => {
  it.each([
    { platform: 'darwin' as const, packaged: false },
    { platform: 'linux' as const, packaged: true }
  ])('does nothing outside packaged macOS: %j', (context) => {
    const probe = vi.fn(),
      watchIntent = vi.fn(),
      onRequested = vi.fn()
    startAutomaticUninstallMonitor({ ...context, probe, watchIntent, onRequested }).stop()
    expect(probe).not.toHaveBeenCalled()
    expect(watchIntent).not.toHaveBeenCalled()
  })
  it('detects an intent event and retries an incomplete drain without a new user action', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      onRequested = vi.fn().mockRejectedValueOnce(new Error('cleanup pending')),
      close = vi.fn()
    let changed: (() => void) | undefined
    const monitor = startAutomaticUninstallMonitor({
      platform: 'darwin',
      packaged: true,
      probe,
      onRequested,
      watchIntent: (callback) => {
        changed = callback
        return { close }
      }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(onRequested).not.toHaveBeenCalled()
    changed?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(onRequested).toHaveBeenCalledWith(automaticUninstallNative)
    await vi.advanceTimersByTimeAsync(2000)
    expect(onRequested).toHaveBeenCalledTimes(2)
    monitor.stop()
    await vi.advanceTimersByTimeAsync(6000)
    expect(onRequested).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
  })
  it('polls when watching is unavailable and never overlaps checks or cleanup', async () => {
    let resolveProbe: ((value: boolean) => void) | undefined
    const probe = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveProbe = resolve
          })
      ),
      onRequested = vi.fn(),
      watchIntent = vi.fn(() => {
        throw new Error('absent')
      })
    const monitor = startAutomaticUninstallMonitor({
      platform: 'darwin',
      packaged: true,
      probe,
      watchIntent,
      onRequested
    })
    await vi.advanceTimersByTimeAsync(6000)
    expect(probe).toHaveBeenCalledOnce()
    resolveProbe?.(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(probe).toHaveBeenCalledTimes(2)
    monitor.stop()
    resolveProbe?.(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(onRequested).not.toHaveBeenCalled()
  })
})

describe('automatic uninstall preparation', () => {
  const fixture = () => ({
    platform: 'darwin' as NodeJS.Platform,
    packaged: true,
    uid: 501,
    args: ['--relay-uninstall-prepare'],
    probe: vi.fn(async () => true),
    disableLoginItem: vi.fn(),
    loginItemEnabled: vi.fn(() => false)
  })
  it('only unregisters its old login item after authenticated intent and verifies the result', async () => {
    const options = fixture()
    options.disableLoginItem.mockImplementation(() => expect(options.probe).toHaveBeenCalledOnce())
    expect(await prepareAutomaticUninstall(options)).toBe(true)
    expect(options.disableLoginItem).toHaveBeenCalledOnce()
    expect(options.loginItemEnabled).toHaveBeenCalledOnce()
  })
  it.each([
    { platform: 'linux' as NodeJS.Platform },
    { packaged: false },
    { uid: 0 },
    { uid: -1 },
    { args: ['--relay-uninstall-prepare', '/foreign'] },
    { args: [] }
  ])('does not probe or unregister an invalid launch: %j', async (override) => {
    const options = { ...fixture(), ...override }
    expect(await prepareAutomaticUninstall(options)).toBe(false)
    expect(options.probe).not.toHaveBeenCalled()
    expect(options.disableLoginItem).not.toHaveBeenCalled()
  })
  it('rejects unauthenticated requests and unconfirmed login-item writes', async () => {
    const options = fixture()
    options.probe.mockResolvedValueOnce(false)
    expect(await prepareAutomaticUninstall(options)).toBe(false)
    expect(options.disableLoginItem).not.toHaveBeenCalled()
    options.loginItemEnabled.mockReturnValue(true)
    expect(await prepareAutomaticUninstall(options)).toBe(false)
    options.disableLoginItem.mockImplementationOnce(() => {
      throw new Error('refused')
    })
    expect(await prepareAutomaticUninstall(options)).toBe(false)
  })
})
