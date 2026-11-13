import { createHash } from 'crypto'
import { constants } from 'fs'
import { lstat, open, realpath } from 'fs/promises'
import { basename, isAbsolute } from 'path'
import { stripProfileControls } from '../../../shared/relay/profiles'
import { PROFILE_BYTE_LIMIT } from './inspect'

export const profileHash = (text: string): string => createHash('sha256').update(text).digest('hex')
export interface ProfileSource {
  name: string
  text: string
  // Main-only generated sources may revoke before any confirmation or write.
  assertCurrent?(): Promise<void>
  readAgain(): Promise<string>
}
// Caller path must come from the native picker, never renderer input. No file
// type is executed; the bound read rejects links and a changing source.
export async function readProfileFile(path: string, privateCopy = false): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0') || (await realpath(path)) !== path)
    throw new Error('配置文件路径需要核对。')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > PROFILE_BYTE_LIMIT ||
      (privateCopy &&
        (before.uid !== process.getuid?.() ||
          before.nlink !== 1 ||
          (before.mode & 0o7777) !== 0o600))
    )
      throw new Error('配置文件类型、大小或权限不符。')
    const buffer = Buffer.alloc(before.size + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const part = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!part.bytesRead) break
      bytesRead += part.bytesRead
    }
    const after = await file.stat(),
      linked = await lstat(path)
    if (
      bytesRead !== before.size ||
      [after, linked].some(
        (value) =>
          value.dev !== before.dev ||
          value.ino !== before.ino ||
          value.size !== before.size ||
          value.mtimeMs !== before.mtimeMs ||
          value.ctimeMs !== before.ctimeMs ||
          value.mode !== before.mode ||
          value.uid !== before.uid ||
          value.nlink !== before.nlink
      )
    )
      throw new Error('配置读取期间发生改变。')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, bytesRead)
    )
  } finally {
    await file.close()
  }
}
export async function pickProfileSource(path: string): Promise<ProfileSource> {
  const text = await readProfileFile(path)
  let name = ''
  for (const character of stripProfileControls(basename(path))) {
    if (name.length + character.length > 120) break
    name += character
  }
  name ||= 'Local profile'
  return { name, text, readAgain: () => readProfileFile(path) }
}
