import { constants } from 'fs'
import { lstat, mkdir, open, realpath } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import type { RelayStateContext } from '../context'

// Restricted storage primitives for the append-only source journal. They never
// repair permissions, follow links, overwrite existing files or use a user path.
export class SubscriptionFiles {
  constructor(readonly context: RelayStateContext) {
    if (
      !isAbsolute(context.home) ||
      resolve(context.home) !== context.home ||
      context.home.includes('\0') ||
      !['Relay', 'Relay-Preview']
        .map((name) => join(context.home, 'Library/Application Support', name))
        .includes(context.stateRoot)
    )
      throw new Error('订阅目录上下文无效。')
  }
  async sync(path: string): Promise<void> {
    const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await file.sync()
    } finally {
      await file.close()
    }
  }
  async directory(path: string, create = false): Promise<boolean> {
    if (path !== this.context.home && !path.startsWith(this.context.home + '/'))
      throw new Error('订阅路径无效。')
    let current = this.context.home
    for (const segment of ['', ...relative(current, path).split('/').filter(Boolean)]) {
      if (segment) current = join(current, segment)
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await lstat(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || current === this.context.home)
          throw error
        if (!create) return false
        try {
          await mkdir(current, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        info = await lstat(current)
        await this.sync(dirname(current))
      }
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o022 ||
        (await realpath(current)) !== current
      )
        throw new Error('订阅目录权限或归属不安全。')
    }
    return true
  }
  async write(path: string, raw: string): Promise<void> {
    const file = await open(path, 'wx', 0o600)
    try {
      await file.writeFile(raw, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
  }
}
