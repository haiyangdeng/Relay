import { createServer as httpServer, type Server } from 'http'
import { createConnection, createServer } from 'net'
import type { Duplex } from 'stream'

export async function fixturePort(
  server: Server | ReturnType<typeof createServer>,
  port = 0
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  return address.port
}
export async function closeFixture(
  server: Server | ReturnType<typeof createServer>
): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
export async function freeFixturePort(): Promise<number> {
  const server = createServer((socket) => socket.destroy()),
    port = await fixturePort(server)
  await closeFixture(server)
  return port
}
// All outbound connections are hard-wired to this fixture's loopback origin.
// A proxy CONNECT for any other destination is rejected before opening a socket.
export async function createLocalNetworkFixture() {
  const sockets = new Set<Duplex>()
  const track = (socket: Duplex): void => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  }
  let originRequests = 0,
    usedA = 0,
    usedB = 0
  const origin = httpServer((req, res) => {
    ++originRequests
    res.setHeader('Connection', req.url === '/hold-open' ? 'keep-alive' : 'close')
    // Give health probes a measurable loopback RTT (the core rejects 0ms).
    if (req.url === '/hold-open') {
      res.setHeader('Content-Length', '1')
      res.end('x')
    } else if (req.url === '/health') setTimeout(() => res.end('origin:' + req.url), 5)
    else res.end('origin:' + req.url)
  })
  origin.on('connection', track)
  const originPort = await fixturePort(origin)
  const proxy = (used: () => void): Server => {
    const server = httpServer((_req, res) => {
      res.writeHead(405)
      res.end()
    })
    server.on('connection', track)
    server.on('connect', (req, socket, head) => {
      track(socket)
      if (req.url !== `127.0.0.1:${originPort}`) {
        socket.destroy()
        return
      }
      used()
      const upstream = createConnection({ host: '127.0.0.1', port: originPort })
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
    return server
  }
  const a = proxy(() => ++usedA),
    b = proxy(() => ++usedB)
  const portA = await fixturePort(a),
    portB = await fixturePort(b),
    group = 'Select / 测试'
  const source = JSON.stringify({
    dns: { enable: true, nameserver: ['10.0.0.53'] },
    tun: { enable: true },
    proxies: [
      { name: 'NodeA', type: 'http', server: '127.0.0.1', port: portA },
      { name: 'NodeB', type: 'http', server: '127.0.0.1', port: portB }
    ],
    'proxy-groups': [{ name: group, type: 'select', proxies: ['NodeA', 'NodeB'] }],
    rules: ['MATCH,' + group]
  })
  return {
    source,
    group,
    healthURL: `http://127.0.0.1:${originPort}/health`,
    stats: () => ({ originRequests, usedA, usedB }),
    stopB: () => closeFixture(b),
    request: async (port: number, label: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port })
        track(socket)
        const chunks: Buffer[] = []
        let length = 0
        socket.setTimeout(5000, () => socket.destroy(new Error('fixture timeout')))
        socket.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > 65536) socket.destroy(new Error('fixture response limit'))
          else chunks.push(chunk)
        })
        socket.once('error', reject)
        socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        socket.once('connect', () =>
          socket.write(
            `GET http://127.0.0.1:${originPort}/${label} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`
          )
        )
      }),
    close: async (): Promise<void> => {
      sockets.forEach((socket) => socket.destroy())
      await Promise.all([closeFixture(a), closeFixture(b), closeFixture(origin)])
    }
  }
}
