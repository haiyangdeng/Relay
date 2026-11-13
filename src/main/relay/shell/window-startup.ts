import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { maxDisplayBytes, maxShellBytes, readShellSnapshot } from './store'

export const defaultWindowStartup = Object.freeze({
  useWindowFrame: true,
  disableHardwareAcceleration: false
})
export type RelayWindowStartup = { useWindowFrame: boolean; disableHardwareAcceleration: boolean }

function readOwnedFile(path: string, maximum: number, privateMode = false): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      (before.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
      before.size > maximum
    )
      throw new Error('启动窗口偏好文件归属未确认。')
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    for (const check of [fstatSync(fd), lstatSync(path)]) {
      if (
        check.dev !== before.dev ||
        check.ino !== before.ino ||
        check.size !== before.size ||
        check.mtimeMs !== before.mtimeMs ||
        check.ctimeMs !== before.ctimeMs
      )
        throw new Error('启动窗口偏好读取期间已变化。')
    }
    if (length !== before.size) throw new Error('启动窗口偏好大小未确认。')
    return buffer.subarray(0, length)
  } finally {
    closeSync(fd)
  }
}

// Called synchronously before Electron becomes ready. Only the fixed normal
// Relay data root is read, and absent or unconfirmed data keeps the defaults.
export function readWindowStartup(home: string, stateRoot: string): RelayWindowStartup {
  const support = join(home, 'Library/Application Support'),
    ui = join(stateRoot, 'UI')
  if (
    !isAbsolute(home) ||
    resolve(home) !== home ||
    home.includes('\0') ||
    stateRoot !== join(support, 'Relay-Preview')
  )
    return defaultWindowStartup
  const directories = [home, join(home, 'Library'), support, stateRoot, ui]
  const identities = (): string[] =>
    directories.map((path) => {
      const directory = lstatSync(path)
      if (
        !directory.isDirectory() ||
        directory.uid !== process.getuid?.() ||
        (directory.mode & 0o022) !== 0 ||
        realpathSync(path) !== path
      )
        throw new Error('启动窗口偏好目录归属未确认。')
      return `${directory.dev}:${directory.ino}`
    })
  try {
    const before = identities()
    const base = readOwnedFile(join(ui, 'shell.json'), maxShellBytes)
    const startup = readOwnedFile(join(ui, 'shell-startup.json'), maxDisplayBytes, true)
    if (identities().some((identity, index) => identity !== before[index]))
      return defaultWindowStartup
    const { settings } = readShellSnapshot(base, undefined, startup).record
    return {
      useWindowFrame: settings.useWindowFrame !== false,
      disableHardwareAcceleration: settings.disableHardwareAcceleration === true
    }
  } catch {
    return defaultWindowStartup
  }
}
