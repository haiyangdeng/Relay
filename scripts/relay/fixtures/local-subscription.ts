import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, realpath, readFile, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { createServer, request } from 'http'
import { createServer as httpsServer } from 'https'
import { createConnection } from 'net'
import type { Duplex } from 'stream'
import { gzipSync } from 'zlib'
import { fixturePort, closeFixture } from './local-network'

const exec = promisify(execFile)
export async function createLocalSubscriptionFixture(source: string | Buffer) {
  const directory = await realpath(await mkdtemp('/private/tmp/relay-subscription-tls-'))
  const key = join(directory, 'key.pem'),
    certificate = join(directory, 'cert.pem'),
    config = join(directory, 'request.cnf')
  await writeFile(
    config,
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n',
    { mode: 0o600 }
  )
  await exec(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-days',
      '1',
      '-config',
      config
    ],
    { timeout: 10000, maxBuffer: 65536 }
  )
  const sockets = new Set<Duplex>(),
    proxySockets = new Set<Duplex>()
  const track = (socket: Duplex): void => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  }
  let origins = 0,
    forwarded = 0,
    tunnels = 0,
    slowStarted = 0,
    slowClosed = 0,
    tlsRequests = 0,
    authorizedRequests = 0,
    conditionalRequests = 0
  let responseHeaders: Record<string, string> = {}
  const origin = createServer((req, res) => {
    ++origins
    if (req.headers.authorization === 'Bearer PRIVATE') ++authorizedRequests
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    for (const [key, value] of Object.entries(responseHeaders)) res.setHeader(key, value)
    if (path === '/redirect-local') {
      res.writeHead(302, { location: '/snapshot?token=PRIVATE' }).end()
      return
    }
    if (responseHeaders.etag && req.headers['if-none-match'] === responseHeaders.etag) {
      ++conditionalRequests
      res.writeHead(304).end()
      return
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: 'http://must-not-fetch.invalid/PRIVATE' }).end()
      return
    }
    if (path === '/unauthorized') {
      res.writeHead(401).end('PRIVATE')
      return
    }
    if (path === '/oversize') {
      res.end(Buffer.alloc(2097153, 'x'))
      return
    }
    if (path === '/gzip') {
      res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync(source))
      return
    }
    if (path === '/invalid') {
      res.end(Buffer.from([0xc3, 0x28]))
      return
    }
    if (path === '/html') {
      res.end('<html>PRIVATE</html>')
      return
    }
    if (path === '/provider') {
      res.end('proxy-providers: {P: {type: http, url: "https://must-not-fetch.invalid/PRIVATE"}}')
      return
    }
    if (path === '/slow') {
      ++slowStarted
      res.writeHead(200)
      res.write('# waiting\n')
      res.once('close', () => ++slowClosed)
      return
    }
    res.setHeader('Connection', 'close')
    res.end(source)
  })
  origin.on('connection', track)
  const originPort = await fixturePort(origin)
  const secure = httpsServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (_req, res) => {
      ++tlsRequests
      res.setHeader('Connection', 'close')
      res.end(source)
    }
  )
  secure.on('connection', track)
  secure.on('tlsClientError', () => {})
  const tlsPort = await fixturePort(secure)
  const proxy = createServer((req, res) => {
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (
      target.protocol !== 'http:' ||
      target.hostname !== '127.0.0.1' ||
      Number(target.port) !== originPort
    ) {
      res.writeHead(403).end()
      return
    }
    ++forwarded
    const upstream = request(
      {
        host: '127.0.0.1',
        port: originPort,
        path: target.pathname + target.search,
        method: 'GET',
        headers: req.headers,
        agent: false
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 500, reply.headers)
        reply.pipe(res)
      }
    )
    upstream.on('socket', track)
    upstream.once('error', () => res.destroy())
    req.once('aborted', () => upstream.destroy())
    res.once('close', () => upstream.destroy())
    upstream.end()
  })
  proxy.on('connection', (socket) => {
    track(socket)
    proxySockets.add(socket)
    socket.once('close', () => proxySockets.delete(socket))
  })
  proxy.on('connect', (req, socket, head) => {
    if (req.url !== `localhost:${tlsPort}`) {
      socket.destroy()
      return
    }
    ++tunnels
    track(socket)
    const upstream = createConnection({ host: '127.0.0.1', port: tlsPort })
    track(upstream)
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    socket.once('close', () => upstream.destroy())
    upstream.once('error', () => socket.destroy())
  })
  const proxyPort = await fixturePort(proxy)
  let proxyClosed = false
  const closeProxy = async (): Promise<void> => {
    if (proxyClosed) return
    proxyClosed = true
    proxySockets.forEach((socket) => socket.destroy())
    await closeFixture(proxy)
  }
  return {
    setHeaders: (headers: Record<string, string>): void => {
      responseHeaders = { ...headers }
    },
    setSource: (text: string | Buffer): void => {
      source = text
    },
    proxyPort,
    certificate,
    secureURL: `https://localhost:${tlsPort}/snapshot?token=PRIVATE`,
    url: (path = '/snapshot') => `http://127.0.0.1:${originPort}${path}?token=PRIVATE`,
    stats: () => ({
      origins,
      forwarded,
      tunnels,
      slowStarted,
      slowClosed,
      tlsRequests,
      authorizedRequests,
      conditionalRequests
    }),
    originListening: () => origin.listening,
    closeProxy,
    close: async (): Promise<void> => {
      sockets.forEach((socket) => socket.destroy())
      await closeProxy()
      await Promise.all([closeFixture(origin), closeFixture(secure)])
      await rm(directory, { recursive: true })
    }
  }
}
