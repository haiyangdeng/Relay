import { randomUUID } from 'crypto'
import { createServer, type Server, type IncomingMessage } from 'http'
import { extname, join } from 'path'
import { lstat, mkdir, rm } from 'fs/promises'
import { atomicWriteFile } from '../../utils/safeFile'
import { requestOnce, type PluginRequestOptions } from '../../resolve/plugin/http-client'
import type { SubStoreResources } from './resources'
import type { SubStoreRuntime } from './runtime'
import type { SubStoreEgress } from './isolated-egress'
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
}
function allowedPath(value: string): boolean {
  return (
    value.length <= 4096 &&
    /^\/(?:api\/[a-zA-Z0-9_%?=&+.,~/-]+|download\/[a-zA-Z0-9_%?=&+.,~/-]+)$/u.test(value) &&
    !/%(?:2e|2f|5c|00)/iu.test(value) &&
    !value.includes('..') &&
    !value.includes('//')
  )
}
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
async function body(message: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) throw new Error('自定义后端请求已取消。')
  const chunks: Buffer[] = []
  let count = 0
  const aborted = (): void => {
    message.destroy(new Error('自定义后端请求预算已结束。'))
  }
  signal.addEventListener('abort', aborted, { once: true })
  try {
    for await (const value of message) {
      if (signal.aborted) throw new Error('自定义后端请求已取消。')
      const chunk = Buffer.from(value)
      count += chunk.length
      if (count > 2 * 1024 * 1024) throw new Error('自定义后端请求超限。')
      chunks.push(chunk)
    }
    if (signal.aborted) throw new Error('自定义后端请求已取消。')
    return Buffer.concat(chunks)
  } finally {
    signal.removeEventListener('abort', aborted)
  }
}
// Reuses the pinned local frontend and its no-preload window unchanged. Remote
// backend bytes are data responses behind this loopback-only facade, never new
// renderer resource origins or a SystemProxy connection.
export async function startRemoteSubStore(input: {
  resources: SubStoreResources
  backendURL: string
  egress: SubStoreEgress
  signal: AbortSignal
  registerCleanup(stop: () => Promise<void>): void
}): Promise<SubStoreRuntime> {
  const loaded = await input.resources.load(),
    base = new URL(input.backendURL),
    nonce = randomUUID().replaceAll('-', ''),
    prefix = '/relay-' + nonce
  const lease = input.resources.sessionDirectory
  await mkdir(lease, { mode: 0o700 }).catch(() => {
    throw new Error('Sub-Store已有运行或待恢复记录。')
  })
  const identity = await lstat(lease)
  let server: Server | undefined,
    stopped = false,
    stopping: Promise<void> | undefined
  const abort = new AbortController(),
    controllers = new Set<AbortController>()
  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (stopping) return stopping
    stopping = Promise.resolve()
      .then(async () => {
        abort.abort()
        for (const controller of controllers) controller.abort()
        if (server) {
          const owned = server
          owned.closeAllConnections()
          if (owned.listening)
            await new Promise<void>((resolve, reject) =>
              owned.close((error) => (error ? reject(error) : resolve()))
            )
          server = undefined
        }
        // Keep the lease while the only owned egress child may still exist.
        await input.egress.stop()
        const current = await lstat(lease)
        if (
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          current.isSymbolicLink()
        )
          throw new Error('Sub-Store远端会话记录改变。')
        await rm(lease, { recursive: true })
        stopped = true
      })
      .finally(() => {
        stopping = undefined
      })
    return stopping
  }
  input.registerCleanup(stop)
  const transfer = async (
    path: string,
    method: PluginRequestOptions['method'],
    payload: Buffer | undefined,
    headers: Record<string, string>,
    signal: AbortSignal
  ) => {
    if (stopped || abort.signal.aborted || !allowedPath(path) || !methods.has(method))
      throw new Error('自定义后端固定路径无效。')
    await input.egress.assertCurrent()
    const response = await requestOnce(base.href.replace(/\/$/u, '') + path, {
      method,
      body: payload,
      headers,
      signal: AbortSignal.any([abort.signal, signal]),
      proxy: { host: '127.0.0.1', port: input.egress.port },
      timeout: 15000,
      maxBytes: 2 * 1024 * 1024
    })
    await input.egress.assertCurrent()
    if (response.status >= 300 && response.status < 400) throw new Error('自定义后端不跟随重定向。')
    return response
  }
  await atomicWriteFile(
    join(lease, 'owner.json'),
    JSON.stringify({ version: 1, nonce, pid: input.egress.pid, createdAt: Date.now() }),
    { mode: 0o600 }
  )
  const ready = await transfer('/api/utils/env', 'GET', undefined, {}, input.signal)
  if (ready.status !== 200) throw new Error('自定义后端未返回预期环境。')
  const service = createServer((request, response) => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.origin !== 'http://127.0.0.1') throw new Error()
    } catch {
      response.writeHead(400).end()
      return
    }
    const path = url.pathname
    if (path.startsWith(prefix + '/')) {
      if (!methods.has(request.method ?? '') || controllers.size >= 8) {
        response.writeHead(405).end()
        return
      }
      const controller = new AbortController(),
        signal = AbortSignal.any([abort.signal, controller.signal, AbortSignal.timeout(30000)])
      controllers.add(controller)
      const disconnect = (): void => controller.abort()
      response.once('close', disconnect)
      void (async () => {
        const payload = await body(request, signal),
          headers: Record<string, string> = { 'accept-encoding': 'identity' }
        if (
          typeof request.headers['content-type'] === 'string' &&
          request.headers['content-type'].length <= 256
        )
          headers['content-type'] = request.headers['content-type']
        const remote = await transfer(
          path.slice(prefix.length) + url.search,
          request.method as PluginRequestOptions['method'],
          payload.length ? payload : undefined,
          headers,
          signal
        )
        response.writeHead(remote.status, {
          'content-type': String(remote.headers['content-type'] ?? 'application/json'),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
        })
        response.end(remote.body)
      })()
        .catch(() => {
          if (!response.headersSent) response.writeHead(502)
          response.end()
        })
        .finally(() => {
          controllers.delete(controller)
          response.removeListener('close', disconnect)
        })
      return
    }
    if (
      !['GET', 'HEAD'].includes(request.method ?? '') ||
      path.includes('..') ||
      path.includes('\\') ||
      path.includes('\0') ||
      /%(?:2e|2f|5c|00)/iu.test(path)
    ) {
      response.writeHead(400).end()
      return
    }
    const name = loaded.files.has(path) ? path : extname(path) ? path : '/index.html',
      bytes = loaded.files.get(name)
    if (!bytes) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'content-type': mime[extname(name)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'"
    })
    response.end(request.method === 'HEAD' ? undefined : bytes)
  })
  server = service
  await new Promise<void>((resolve, reject) => {
    service.once('error', reject)
    service.listen(0, '127.0.0.1', resolve)
  })
  const address = service.address()
  if (!address || typeof address !== 'object' || input.signal.aborted || abort.signal.aborted)
    throw new Error('自定义后端本机入口未确认。')
  await input.egress.assertCurrent()
  const origin = `http://127.0.0.1:${address.port}`
  return {
    pid: input.egress.pid,
    frontendURL: `${origin}/?api=${encodeURIComponent(origin + prefix)}`,
    origins: [origin],
    alive: () => !stopped && !abort.signal.aborted && input.egress.alive(),
    request: async (path, signal) => {
      if (!/^\/(?:api\/(?:subs|collections|utils\/env)|download\/[^\r\n]+)$/u.test(path))
        throw new Error('自定义后端读取范围无效。')
      const response = await transfer(path, 'GET', undefined, {}, signal)
      if (response.status !== 200) throw new Error('自定义后端读取未完成。')
      return response.body
    },
    stop
  }
}
