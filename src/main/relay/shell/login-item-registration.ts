import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../../utils/safeFile'

export const relayLoginItemName = 'local.relay.network.login.plist'
export const relayLoginItemContents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>local.relay.network.login</string>
<key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>/Applications/Relay.app</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`

// A user LaunchAgent can be removed after the app is gone, including after
// immediate Trash emptying. SMAppService.mainApp registration needs the bundle.
// No launchctl bootstrap is needed: launchd reads this at the next user login.
export function createLoginItemRegistration(options: {
  platform: NodeJS.Platform
  packaged: boolean
  home: string
  legacy: { read(): { openAtLogin: boolean }; write(enabled: boolean): void }
}): { migrate(): void; read(): { openAtLogin: boolean }; write(enabled: boolean): void } {
  if (options.platform !== 'darwin' || !options.packaged)
    return { ...options.legacy, migrate: () => {} }
  const path = join(options.home, 'Library', 'LaunchAgents', relayLoginItemName)
  const uid = process.getuid?.()
  let migrated = false
  const missing = (error: unknown): boolean =>
    error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  const directories = (create: boolean): boolean => {
    if (realpathSync(options.home) !== options.home) throw new Error('Relay 登录项目录已变化。')
    for (const directory of [
      options.home,
      join(options.home, 'Library'),
      join(options.home, 'Library', 'LaunchAgents')
    ]) {
      try {
        const info = lstatSync(directory)
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.uid !== uid ||
          (info.mode & 0o022) !== 0
        )
          throw new Error('Relay 登录项目录归属未确认。')
      } catch (error) {
        if (!missing(error)) throw error
        if (!create) return false
        mkdirSync(directory, { mode: 0o700 })
      }
    }
    return true
  }
  const present = (): boolean => {
    if (!directories(false)) return false
    try {
      const info = lstatSync(path)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== uid ||
        info.nlink !== 1 ||
        (info.mode & 0o7777) !== 0o600 ||
        info.size !== Buffer.byteLength(relayLoginItemContents) ||
        readFileSync(path, 'utf8') !== relayLoginItemContents
      )
        throw new Error('Relay 登录项已被外部修改，保留原文件。')
      return true
    } catch (error) {
      if (missing(error)) return false
      throw error
    }
  }
  const writeOwned = (enabled: boolean): void => {
    const existing = present()
    if (existing === enabled) return
    if (enabled) {
      directories(true)
      atomicWriteFileSync(path, relayLoginItemContents, { mode: 0o600 })
    } else unlinkSync(path)
    if (present() !== enabled) throw new Error('Relay 登录项写入尚未确认。')
  }
  const migrate = (): void => {
    if (migrated) return
    const existing = present(),
      previous = options.legacy.read().openAtLogin
    if (typeof previous !== 'boolean') throw new Error('原 Relay 登录项状态未确认。')
    // Publish the replacement before unregistering, so a failed file write or
    // interrupted migration cannot silently lose an enabled startup preference.
    if (previous && !existing) writeOwned(true)
    try {
      let writeError: unknown
      try {
        options.legacy.write(false)
      } catch (error) {
        writeError = error
      }
      if (options.legacy.read().openAtLogin !== false)
        throw writeError ?? new Error('原 Relay 登录项注销尚未确认。')
      migrated = true
    } catch (error) {
      // Keep the old enabled registration if Service Management refuses it.
      // Only roll back a new file created by this attempt; preserve prior files.
      if (previous && !existing && options.legacy.read().openAtLogin === true) writeOwned(false)
      throw error
    }
  }
  return {
    migrate,
    read: () => {
      migrate()
      return { openAtLogin: present() }
    },
    write: (enabled) => {
      migrate()
      writeOwned(enabled)
    }
  }
}
