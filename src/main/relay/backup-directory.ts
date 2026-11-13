import { lstat, realpath } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'
import { validateBackupSource, type RelayBackupDirectoryResult } from '../../shared/relay/protocol'
import type { RelayStateContext } from './context'

// Only existing, main-owned backup roots may be opened. Do not create a folder,
// accept a renderer path, or send files/URLs to a default application.
export async function openBackupDirectory(
  context: RelayStateContext,
  raw: unknown,
  openPath: (path: string) => Promise<string>
): Promise<RelayBackupDirectoryResult> {
  const { source } = validateBackupSource(raw)
  const home = context.home
  const allowedRoots = ['Relay', 'Relay-Preview'].map((name) =>
    join(home, 'Library/Application Support', name)
  )
  if (!isAbsolute(home) || !allowedRoots.includes(context.stateRoot))
    throw new Error('备份目录上下文无效。')
  const target = join(
    source === 'relay'
      ? context.stateRoot
      : join(home, 'Library/Application Support/AI Network Assistant'),
    'Backups'
  )
  try {
    if ((await realpath(home)) !== home) throw new Error()
    const segments = relative(home, target).split(sep)
    let current = home
    for (const segment of ['', ...segments]) {
      current = segment ? join(current, segment) : current
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
        throw new Error()
      if ((await realpath(current)) !== current) throw new Error()
    }
  } catch {
    throw new Error('备份目录不存在、不可读取或路径不安全；没有创建或打开目录。')
  }
  // Electron resolves with an error string on failure. Never fall back to a
  // parent folder, shell command or another opener.
  try {
    if (await openPath(target)) throw new Error()
  } catch {
    throw new Error('Finder 打开请求未确认，请在本机检查目录；没有自动重试。')
  }
  return { status: 'requested', source }
}
