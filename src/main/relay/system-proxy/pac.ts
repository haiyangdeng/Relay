import { createServer } from 'http'
import { randomUUID } from 'crypto'
import { Script } from 'vm'
import type { SystemProxySettings } from '../../../shared/relay/system-proxy'

export interface OwnedPacServer {
  readonly url: string
  close(): Promise<void>
}
export async function startPacServer(settings: SystemProxySettings): Promise<OwnedPacServer> {
  const path = `/${randomUUID()}.pac`,
    script = settings.pacScript
      .replaceAll('%mixed-port%', String(settings.port))
      .replaceAll(
        '%proxy-host%',
        settings.host.includes(':') ? `[${settings.host}]` : settings.host
      )
  if (Buffer.byteLength(script) > 131072) throw new Error('PAC脚本过长。')
  // Parse only; arbitrary PAC code never executes in the main process.
  new Script(script, { filename: 'relay-private.pac' })
  const server = createServer((req, res) => {
    if (req.url !== path || !['GET', 'HEAD'].includes(req.method ?? '')) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
      'Content-Length': Buffer.byteLength(script),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    })
    res.end(req.method === 'HEAD' ? undefined : script)
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.keepAliveTimeout = 1000
  server.maxConnections = 32
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', () => {})
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('PAC回环监听未确认。')
  }
  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }).catch((error) => {
        closing = undefined
        throw error
      }))
  }
}
