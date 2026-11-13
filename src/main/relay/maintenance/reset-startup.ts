import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface OwnedResetStartup {
  mode: 'normal' | 'maintenance'
  targetRoot: string
  profileRoot: string
  controlRoot: string
}
// This early fixed-path probe does not authorize a reset. Presence or malformed
// content selects the isolated profile; the signed native coordinator owns the
// real journal parser, exclusive process lease, confirmation and mutations.
export function ownedResetStartup(home: string): OwnedResetStartup {
  if (!isAbsolute(home) || resolve(home) !== home || home.includes('\0'))
    throw new Error('维护启动主目录未确认。')
  const support = join(home, 'Library/Application Support'),
    control = join(support, 'Relay-Maintenance'),
    targetRoot = join(support, 'Relay-Preview'),
    marker = join(control, 'owned-reset.json')
  const check = (path: string, create = false): boolean => {
    let current = home
    for (const segment of ['', ...relative(home, path).split('/').filter(Boolean)]) {
      if (segment) current = join(current, segment)
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!create) return false
        mkdirSync(current, { mode: 0o700 })
        stat = lstatSync(current)
      }
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o022) !== 0 ||
        realpathSync(current) !== current
      )
        throw new Error('维护启动目录归属未确认。')
    }
    return true
  }
  const normal: OwnedResetStartup = {
    mode: 'normal',
    targetRoot,
    profileRoot: targetRoot,
    controlRoot: control
  }
  if (!check(control)) return normal
  let present = false
  try {
    lstatSync(marker)
    present = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!present) return normal
  // Do not ignore an unsafe/malformed active marker and launch normal actors.
  // Even an invalid file chooses isolation; native inspect will refuse mutation.
  const profileRoot = join(control, 'Bootstrap')
  check(profileRoot, true)
  if (
    (lstatSync(control).mode & 0o7777) !== 0o700 ||
    (lstatSync(profileRoot).mode & 0o7777) !== 0o700
  )
    throw new Error('维护控制及启动目录必须为当前用户私有目录。')
  return { mode: 'maintenance', targetRoot, profileRoot, controlRoot: control }
}
