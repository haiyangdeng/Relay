import { randomBytes } from 'crypto'
import { constants } from 'fs'
import { chmod, lstat, mkdir, open, realpath } from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import { join, relative } from 'path'
import { atomicWriteFile } from '../utils/safeFile'
import {
  validateBrowserBinding,
  type RelayBrowserBinding
} from '../../shared/relay/browser-binding'
import type { RelayStateContext } from './context'

// This locator is discovery only. Native authenticates the live socket peer as
// the Main executable in its own app bundle before trusting any reply.
export function createBrowserBindingChannel(
  context: RelayStateContext,
  readBinding: () => Promise<RelayBrowserBinding>
) {
  const directory = join(context.stateRoot, 'Browser')
  const endpoint = `b-${randomBytes(8).toString('hex')}.sock`
  const path = join(directory, endpoint),
    locator = join(directory, 'active.json')
  const locatorBytes = JSON.stringify({ version: 1, endpoint })
  let server: Server | undefined,
    disposed = false,
    attempted = false
  const clients = new Set<Socket>()
  const readLocator = async (): Promise<string> => {
    const file = await open(
      locator,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 ||
        info.size > 256
      )
        throw new Error()
      return await file.readFile('utf8')
    } finally {
      await file.close()
    }
  }
  const current = async (): Promise<boolean> => !disposed && (await readLocator()) === locatorBytes
  async function directories(): Promise<void> {
    if (
      context.stateRoot !== join(context.home, 'Library/Application Support/Relay-Preview') ||
      Buffer.byteLength(path) > 103
    )
      throw new Error()
    let cursor = context.home
    for (const part of ['', ...relative(context.home, directory).split('/').filter(Boolean)]) {
      if (part) cursor = join(cursor, part)
      try {
        await mkdir(cursor, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const info = await lstat(cursor)
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o022 ||
        (await realpath(cursor)) !== cursor
      )
        throw new Error()
    }
  }
  return {
    async start(): Promise<boolean> {
      if (attempted || disposed) return false
      attempted = true
      try {
        await directories()
        if (disposed) throw new Error()
        server = createServer((client) => {
          if (disposed || clients.size >= 8) {
            client.destroy()
            return
          }
          clients.add(client)
          client.setTimeout(3000, () => client.destroy())
          client.on('error', () => client.destroy())
          client.once('close', () => clients.delete(client))
          let buffer = '',
            handled = false
          client.on('data', (data) => {
            if (handled) {
              client.destroy()
              return
            }
            buffer += data.toString('utf8')
            if (Buffer.byteLength(buffer) > 256) {
              client.destroy()
              return
            }
            if (!buffer.endsWith('\n')) return
            handled = true
            void (async () => {
              const request: unknown = JSON.parse(buffer)
              if (!request || typeof request !== 'object' || Array.isArray(request))
                throw new Error()
              const value = request as Record<string, unknown>
              if (
                Object.keys(value).sort().join(',') !== 'action,nonce,version' ||
                value.version !== 1 ||
                value.action !== 'binding' ||
                typeof value.nonce !== 'string' ||
                !/^[a-f0-9]{64}$/u.test(value.nonce) ||
                !(await current())
              )
                throw new Error()
              const binding = validateBrowserBinding(await readBinding())
              if (!(await current()) || client.destroyed) throw new Error()
              client.end(JSON.stringify({ version: 1, nonce: value.nonce, binding }) + '\n')
            })().catch(() => client.destroy())
          })
        })
        const listening = server
        await new Promise<void>((resolve, reject) => {
          listening.once('error', reject)
          listening.listen(path, () => {
            listening.removeListener('error', reject)
            listening.on('error', () => {
              for (const client of clients) client.destroy()
            })
            resolve()
          })
        })
        if (disposed) throw new Error()
        await chmod(path, 0o600)
        if (disposed) throw new Error()
        await atomicWriteFile(locator, locatorBytes, { mode: 0o600 })
        if (disposed) throw new Error()
        return true
      } catch {
        await this.dispose()
        return false
      }
    },
    async dispose(): Promise<void> {
      disposed = true
      for (const client of clients) client.destroy()
      const listening = server
      server = undefined
      if (listening?.listening)
        await new Promise<void>((resolve) => listening.close(() => resolve()))
      // Keep discovery bytes: read-then-unlink could remove a successor's
      // locator. A stopped socket cannot authenticate, and the next start
      // atomically replaces this non-authoritative locator.
      server = undefined
    }
  }
}
