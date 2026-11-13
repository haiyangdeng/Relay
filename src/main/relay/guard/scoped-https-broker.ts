import { createServer } from 'https'
import { request as proxyRequest } from 'http'
import { connect, type Socket } from 'net'
import { randomBytes, timingSafeEqual } from 'crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { Duplex } from 'stream'
import type { LocalRuntimeCapture } from '../core/local-proxy-service'
import { mintScopedTLS } from './vendor/tls-material.mjs'

// HTTPS is the connection to our broker, never interception of the target TLS.
// The private signing key stays in Main memory. Only the public session CA is
// supplied to normal TLS-validating clients in their read-only support tree.
// Threat model excludes deliberate TLS-disable/raw-socket collusion with an
// unrelated malicious same-UID broker; such commands are not claimed protected.
export async function createScopedHTTPSBroker(capture: LocalRuntimeCapture) {
  const lifetime = new AbortController()
  const assertOwner = async (): Promise<void> => {
    const attempt = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, attempt.signal])
    const expiresAt = performance.now() + 5000
    try {
      await Promise.race([
        capture.assertOwner(signal),
        delay(5000, undefined, { signal, ref: false }).then(() => {
          throw new Error('本次代理归属复核超时。')
        })
      ])
      if (performance.now() >= expiresAt) throw new Error('本次代理归属复核超时。')
    } finally {
      attempt.abort()
    }
  }
  await assertOwner()
  if (!capture.isCurrent()) throw new Error('专用代理归属未确认。')
  const material = await mintScopedTLS(),
    secret = randomBytes(32)
  const authorization = Buffer.from(
    'Basic ' + Buffer.from('relay:' + secret.toString('hex')).toString('base64')
  )
  const streams = new Set<Duplex>()
  let live = true,
    checking = false
  const server = createServer({
    key: material.key,
    cert: material.cert,
    minVersion: 'TLSv1.2',
    maxHeaderSize: 8192
  })
  server.on('connection', (socket) => {
    try {
      track(socket)
    } catch {
      socket.destroy()
    }
  })
  server.maxConnections = 64
  server.headersTimeout = 10000
  server.requestTimeout = 30000
  let ownerCheck: Promise<void> | undefined
  const own = async (): Promise<void> => {
    try {
      if (!live || !capture.isCurrent()) throw new Error('本次代理租约已失效。')
      ownerCheck ??= assertOwner().finally(() => {
        ownerCheck = undefined
      })
      await ownerCheck
      if (!live || !capture.isCurrent()) throw new Error('本次代理租约已失效。')
    } catch (error) {
      void close()
      throw error
    }
  }
  const track = <T extends Duplex>(stream: T): T => {
    if (!live || streams.size >= 128) {
      stream.destroy()
      throw new Error('本次代理通道不可用。')
    }
    streams.add(stream)
    stream.once('close', () => streams.delete(stream))
    stream.on('error', () => {}) // Never log requests, credentials or stream bytes.
    return stream
  }
  const authenticated = (raw: string | string[] | undefined): boolean => {
    if (typeof raw !== 'string') return false
    const value = Buffer.from(raw)
    return value.length === authorization.length && timingSafeEqual(value, authorization)
  }
  const coreTunnel = (authority: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      // Adapted from Anthropic SRT 27fce0d parent-proxy openConnectTunnel.
      // Only the captured dedicated HTTP port is dialled; no target DNS/direct.
      const socket = track(connect({ host: '127.0.0.1', port: 17891 }))
      let settled = false,
        bytes = Buffer.alloc(0)
      const fail = (): void => {
        if (!settled) {
          settled = true
          clearTimeout(deadline)
          socket.destroy()
          reject(new Error('专用代理隧道未确认。'))
        }
      }
      const expiresAt = performance.now() + 5000
      const deadline = setTimeout(fail, 5000)
      deadline.unref()
      socket.once('error', fail)
      socket.once('close', fail)
      socket.once('connect', () =>
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
      )
      const data = (part: Buffer): void => {
        if (performance.now() >= expiresAt || bytes.length + part.length > 16384) {
          fail()
          return
        }
        bytes = Buffer.concat([bytes, part])
        const end = bytes.indexOf('\r\n\r\n')
        if (end < 0) return
        socket.pause()
        socket.removeListener('data', data)
        if (
          !/^HTTP\/1\.[01] 2\d\d(?:\s|$)/u.test(
            bytes.subarray(0, bytes.indexOf('\r\n')).toString('latin1')
          )
        ) {
          fail()
          return
        }
        if (bytes.length > end + 4) socket.unshift(bytes.subarray(end + 4))
        settled = true
        clearTimeout(deadline)
        socket.removeListener('error', fail)
        socket.removeListener('close', fail)
        resolve(socket)
      }
      socket.on('data', data)
    })
  server.on('connect', (request, client, head) => {
    client.pause()
    let remote: Socket | undefined
    void (async () => {
      if (!authenticated(request.headers['proxy-authorization'])) {
        client.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Relay scoped session"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
        )
        return
      }
      if (
        head.length > 8192 ||
        !request.url ||
        !/^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\]):[0-9]{1,5}$/u.test(request.url)
      )
        throw new Error()
      const target = new URL('http://' + request.url)
      if (
        target.username ||
        target.password ||
        Number(target.port || 80) < 1 ||
        Number(target.port || 80) > 65535
      )
        throw new Error()
      track(client)
      await own()
      remote = await coreTunnel(request.url)
      await own()
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) remote.write(head)
      client.pipe(remote)
      remote.pipe(client)
      client.once('close', () => remote?.destroy())
      remote.once('close', () => client.destroy())
      client.resume()
      remote.resume()
    })().catch(() => {
      remote?.destroy()
      client.destroy()
    })
  })
  server.on('request', (request, response) => {
    request.pause()
    void (async () => {
      if (!authenticated(request.headers['proxy-authorization'])) {
        response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Relay scoped session"' })
        response.end()
        return
      }
      if (!request.url) throw new Error()
      const target = new URL(request.url)
      if (target.protocol !== 'http:' || target.username || target.password || target.hash)
        throw new Error()
      await own()
      const headers = { ...request.headers }
      const nominated = String(request.headers.connection ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
      for (const key of [
        'proxy-authorization',
        'proxy-connection',
        'connection',
        'upgrade',
        'keep-alive',
        'te',
        'trailer',
        ...nominated
      ])
        delete headers[key]
      const outgoing = proxyRequest(
        {
          host: '127.0.0.1',
          port: 17891,
          method: request.method,
          path: target.href,
          headers,
          agent: false
        },
        (incoming) => {
          void own()
            .then(() => {
              response.writeHead(incoming.statusCode ?? 502, incoming.headers)
              incoming.pipe(response)
            })
            .catch(() => {
              incoming.destroy()
              response.destroy()
            })
        }
      )
      outgoing.setTimeout(30000, () => outgoing.destroy())
      outgoing.on('socket', (socket) => {
        try {
          track(socket)
        } catch {
          outgoing.destroy()
        }
      })
      outgoing.on('error', () => response.destroy())
      request.once('aborted', () => outgoing.destroy())
      response.once('close', () => outgoing.destroy())
      request.pipe(outgoing)
      request.resume()
    })().catch(() => {
      response.writeHead(502)
      response.end()
    })
  })
  server.on('tlsClientError', () => {})
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    live = false
    lifetime.abort()
    clearInterval(watch)
    for (const stream of streams) stream.destroy()
    streams.clear()
    secret.fill(0)
    authorization.fill(0)
    material.key.fill(0)
    closing = new Promise<void>((resolve) => server.close(() => resolve()))
    return closing
  }
  const watch = setInterval(() => {
    if (checking || !live) return
    checking = true
    void own()
      .catch(() => {})
      .finally(() => {
        checking = false
      })
  }, 500)
  watch.unref()
  server.on('error', () => {
    void close()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    await own()
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error()
    return {
      port: address.port,
      proxyURL: `https://relay:${secret.toString('hex')}@127.0.0.1:${address.port}`,
      ca: material.ca,
      close,
      isAlive: () => live && capture.isCurrent()
    }
  } catch {
    await close()
    throw new Error('本次受限 CLI 代理未建立。')
  }
}
