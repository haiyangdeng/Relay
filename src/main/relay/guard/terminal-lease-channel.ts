import { join } from 'path'
import { readBinaryResource } from '../resources/source'
import type { TerminalCLIGrant, TerminalLeaseChannel } from './terminal-cli-service'

type Request =
  | { action: 'start' | 'next' | 'stop' }
  | { action: 'close'; id: string }
  | { action: 'respond'; id: string; grant: TerminalCLIGrant | null }
  | { action: 'confirm'; id: string; allow: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function createTerminalLeaseChannel(
  packaged: boolean,
  resourceRoot: string,
  transact: (json: string) => Promise<string>
): TerminalLeaseChannel {
  let attempted = false
  const send = async (request: Request) => {
    const text = await transact(JSON.stringify({ version: 1, ...request }))
    if (typeof text !== 'string' || Buffer.byteLength(text) > 8192) throw new Error()
    const reply: unknown = JSON.parse(text)
    if (
      !isRecord(reply) ||
      reply.version !== 1 ||
      reply.action !== request.action ||
      typeof reply.ok !== 'boolean'
    )
      throw new Error('终端租约回执无效。')
    return reply
  }
  return {
    async start() {
      if (!packaged) return false
      let manifest: unknown
      try {
        const bytes = await readBinaryResource(
          join(resourceRoot, 'guard-terminal/manifest.json'),
          false,
          8192
        )
        manifest = JSON.parse(bytes.toString('utf8'))
      } catch {
        return false
      }
      if (
        !isRecord(manifest) ||
        manifest.schemaVersion !== 1 ||
        manifest.contractRevision !== 'relay-guard-terminal-v1' ||
        manifest.runtimeReady !== true
      )
        return false
      attempted = true
      return (await send({ action: 'start' })).ok === true
    },
    async next() {
      const { ok, event } = await send({ action: 'next' })
      if (!ok) return null
      if (
        !isRecord(event) ||
        (event.kind !== 'request' && event.kind !== 'commit' && event.kind !== 'closed') ||
        typeof event.id !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(event.id)
      )
        throw new Error('终端租约事件无效。')
      return { kind: event.kind, id: event.id }
    },
    async respond(id, grant) {
      return (await send({ action: 'respond', id, grant })).ok === true
    },
    async confirm(id, allow) {
      return (await send({ action: 'confirm', id, allow })).ok === true
    },
    async close(id) {
      if (!(await send({ action: 'close', id })).ok) throw new Error('终端租约尚未关闭。')
    },
    async stop() {
      if (attempted && !(await send({ action: 'stop' })).ok)
        throw new Error('终端租约监听尚未关闭。')
    }
  }
}
