import { beforeEach, describe, expect, it, vi } from 'vitest'
import { closePrivateBrowserForUninstall } from './private-browser-uninstall'

const fixture = vi.hoisted(() => ({ trusted: vi.fn(), exec: vi.fn(), end: vi.fn() }))
vi.mock('./automatic-uninstall', () => ({
  automaticUninstallExecutableTrusted: fixture.trusted,
  automaticUninstallSupervisor:
    '/Library/Application Support/Relay/Uninstall/RelayUninstallSupervisor'
}))
vi.mock('child_process', () => ({ execFile: fixture.exec }))
beforeEach(() => {
  fixture.trusted.mockReset().mockResolvedValue(true)
  fixture.end.mockReset()
  fixture.exec.mockReset().mockImplementation((_path, _args, _options, done) => {
    done(null)
    return { stdin: { end: fixture.end } }
  })
})
describe('owned private-browser uninstall entry', () => {
  it('delegates only to the trusted fixed supervisor without process or profile input', async () => {
    await closePrivateBrowserForUninstall()
    const executable = '/Library/Application Support/Relay/Uninstall/RelayUninstallSupervisor'
    expect(fixture.trusted).toHaveBeenCalledExactlyOnceWith(executable)
    expect(fixture.exec).toHaveBeenCalledWith(
      executable,
      ['--user-stop-browser'],
      {
        timeout: 20000,
        maxBuffer: 4096,
        encoding: 'utf8'
      },
      expect.any(Function)
    )
    expect(fixture.end).toHaveBeenCalledWith()
  })
  it('does not execute a missing or unsafe supervisor', async () => {
    fixture.trusted.mockResolvedValueOnce(false)
    await expect(closePrivateBrowserForUninstall()).rejects.toThrow('入口未确认')
    expect(fixture.exec).not.toHaveBeenCalled()
  })
  it('propagates an unconfirmed graceful close without trying another command or a force quit', async () => {
    fixture.exec.mockImplementationOnce((_path, _args, _options, done) => {
      done(new Error('browser still running'))
      return { stdin: { end: fixture.end } }
    })
    await expect(closePrivateBrowserForUninstall()).rejects.toThrow('browser still running')
    expect(fixture.exec).toHaveBeenCalledOnce()
  })
})
