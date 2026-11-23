import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createLoginItemRegistration,
  relayLoginItemContents,
  relayLoginItemName
} from './login-item-registration'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'relay-login-test-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
const path = (): string => join(home, 'Library', 'LaunchAgents', relayLoginItemName)
function fixture(enabled = false) {
  let openAtLogin = enabled
  const legacy = {
    read: vi.fn(() => ({ openAtLogin })),
    write: vi.fn((value: boolean) => {
      openAtLogin = value
    })
  }
  const approval = vi.fn(async () => 'requiresApproval' as const)
  const registration = createLoginItemRegistration({
    platform: 'darwin',
    packaged: true,
    home,
    legacy,
    approval
  })
  return { registration, legacy, approval }
}
describe('removable Relay login item registration', () => {
  it('observes only the current plist and never migrates or registers anything on a state read', async () => {
    const { registration, legacy, approval } = fixture(true)
    await expect(registration.state()).resolves.toEqual({
      configured: false,
      approval: 'notRegistered'
    })
    expect(approval).not.toHaveBeenCalled()
    expect(legacy.read).not.toHaveBeenCalled()
    expect(legacy.write).not.toHaveBeenCalled()
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 })
    writeFileSync(path(), relayLoginItemContents, { mode: 0o600 })
    await expect(registration.state()).resolves.toEqual({
      configured: true,
      approval: 'requiresApproval'
    })
    expect(approval).toHaveBeenCalledExactlyOnceWith(path(), process.getuid?.())
    expect(legacy.write).not.toHaveBeenCalled()
    approval.mockImplementationOnce(async () => {
      rmSync(path())
      return 'requiresApproval'
    })
    await expect(registration.state()).resolves.toEqual({
      configured: false,
      approval: 'notRegistered'
    })
  })
  it('preserves enabled preference before unregistering the legacy main app', () => {
    const { registration, legacy } = fixture(true)
    legacy.write.mockImplementationOnce(() => {
      expect(readFileSync(path(), 'utf8')).toBe(relayLoginItemContents)
      legacy.read.mockReturnValue({ openAtLogin: false })
    })
    registration.migrate()
    expect(legacy.write).toHaveBeenCalledExactlyOnceWith(false)
    expect(registration.read()).toEqual({ openAtLogin: true })
    expect(lstatSync(path()).mode & 0o777).toBe(0o600)
    registration.migrate()
    expect(legacy.write).toHaveBeenCalledOnce()
  })
  it('writes and removes only the fixed LaunchAgent without loading a service', () => {
    const { registration } = fixture()
    expect(registration.read()).toEqual({ openAtLogin: false })
    registration.write(true)
    expect(readFileSync(path(), 'utf8')).toContain('<string>/Applications/Relay.app</string>')
    registration.write(false)
    expect(registration.read()).toEqual({ openAtLogin: false })
  })
  it('preserves an existing new registration when the legacy preference is disabled', () => {
    const first = fixture().registration
    first.write(true)
    const second = fixture().registration
    second.migrate()
    expect(second.read()).toEqual({ openAtLogin: true })
  })
  it('keeps the enabled legacy item if unregistering fails', () => {
    const { registration, legacy } = fixture(true)
    legacy.write.mockImplementation(() => {
      throw new Error('refused')
    })
    expect(() => registration.migrate()).toThrow('refused')
    expect(legacy.read().openAtLogin).toBe(true)
    expect(() => lstatSync(path())).toThrow()
  })
  it('accepts a lost setter reply only when a fresh read proves the old item is disabled', () => {
    const { registration, legacy } = fixture(true)
    legacy.write.mockImplementationOnce(() => {
      legacy.read.mockReturnValue({ openAtLogin: false })
      throw new Error('lost reply')
    })
    registration.migrate()
    expect(registration.read().openAtLogin).toBe(true)
  })
  it.each(['symlink directory', 'symlink file', 'modified file', 'writable directory'])(
    'preserves the legacy setting and foreign content on %s',
    (kind) => {
      mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 })
      if (kind === 'symlink directory') {
        rmSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
        symlinkSync(home, join(home, 'Library', 'LaunchAgents'))
      } else if (kind === 'symlink file') {
        writeFileSync(join(home, 'foreign'), 'foreign')
        symlinkSync(join(home, 'foreign'), path())
      } else if (kind === 'modified file') writeFileSync(path(), 'foreign', { mode: 0o600 })
      else chmodSync(join(home, 'Library', 'LaunchAgents'), 0o777)
      const { registration, legacy } = fixture(true)
      expect(() => registration.migrate()).toThrow()
      expect(legacy.write).not.toHaveBeenCalled()
      if (kind === 'symlink file')
        expect(readFileSync(join(home, 'foreign'), 'utf8')).toBe('foreign')
      if (kind === 'modified file') expect(readFileSync(path(), 'utf8')).toBe('foreign')
    }
  )
  it.each([
    { platform: 'darwin' as const, packaged: false },
    { platform: 'linux' as const, packaged: true }
  ])('does not migrate outside packaged macOS: %j', (context) => {
    const legacy = { read: vi.fn(() => ({ openAtLogin: true })), write: vi.fn() }
    createLoginItemRegistration({ ...context, home, legacy }).migrate()
    expect(legacy.read).not.toHaveBeenCalled()
    expect(legacy.write).not.toHaveBeenCalled()
    expect(() => lstatSync(join(home, 'Library'))).toThrow()
  })
})
