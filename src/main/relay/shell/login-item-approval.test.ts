import { describe, expect, it, vi } from 'vitest'
import { readLoginItemApproval } from './login-item-approval'

const path = '/Users/Test User/Library/LaunchAgents/local.relay.network.login.plist'
const own = 'local.relay.network.login'
const list = (...entries: string[]) => ['disabled services = {', ...entries, '}'].join('\n')
const run = () => vi.fn<(exe: string, args: string[]) => Promise<string>>()

describe('Relay login item OS approval', () => {
  it.each([
    ['0', 'notRegistered'],
    ['2', 'requiresApproval'],
    ['3', 'notFound'],
    ['4', 'unknown'],
    ['constructor', 'unknown']
  ])('maps service status %s and avoids any write or second probe', async (value, expected) => {
    const command = run().mockResolvedValueOnce(value)
    expect(await readLoginItemApproval(path, 501, command)).toBe(expected)
    expect(command).toHaveBeenCalledExactlyOnceWith('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      expect.stringContaining('$.SMAppService.statusForLegacyURL'),
      path
    ])
  })
  it.each([
    [list(), 'enabled'],
    [list('"another.job" => disabled', `"${own}" => enabled`), 'enabled'],
    [list(`"${own}" => disabled`), 'unknown'],
    [list(`"${own}" => new-format`), 'unknown'],
    ['unexpected reply', 'unknown']
  ])('requires an allowed job in the observed user domain', async (overrides, expected) => {
    const command = run().mockResolvedValueOnce('1').mockResolvedValueOnce(overrides)
    expect(await readLoginItemApproval(path, 501, command)).toBe(expected)
    expect(command).toHaveBeenNthCalledWith(2, '/bin/launchctl', ['print-disabled', 'gui/501'])
    expect(command).toHaveBeenCalledTimes(2)
  })
  it('does not infer approval from failed system commands', async () => {
    const serviceFailed = run().mockRejectedValue(new Error('timeout'))
    const overridesFailed = run()
      .mockResolvedValueOnce('1')
      .mockRejectedValue(new Error('unavailable'))
    expect(await readLoginItemApproval(path, 501, serviceFailed)).toBe('unknown')
    expect(await readLoginItemApproval(path, 501, overridesFailed)).toBe('unknown')
  })
})
