import { randomUUID } from 'crypto'
import { link, open, realpath, rm } from 'fs/promises'
import { basename, dirname, isAbsolute, join } from 'path'

// Publish a complete private identity without replacing an existing file or link.
export async function writeBackupKeyFile(path: string, bytes: Buffer): Promise<void> {
  if (
    !isAbsolute(path) ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('Invalid key destination')
  const parent = await realpath(dirname(path))
  const destination = join(parent, basename(path))
  const temporary = join(parent, `.relay-age-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    await link(temporary, destination)
  } finally {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true })
  }
}
