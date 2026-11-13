import { createSocket } from 'dgram'
import { createServer } from 'http'
import { createConnection, createServer as tcpServer } from 'net'
import type { Duplex } from 'stream'
import { fixturePort, closeFixture } from './local-network'

function answer(packet: Buffer): { name: string; response: Buffer } {
  if (packet.length < 17 || packet.length > 4096 || packet.readUInt16BE(4) !== 1)
    throw new Error('invalid fixture DNS question')
  let at = 12
  const labels: string[] = []
  while (packet[at]) {
    const size = packet[at++]
    if (size > 63 || at + size >= packet.length) throw new Error('invalid fixture label')
    labels.push(packet.subarray(at, at + size).toString('ascii'))
    at += size
  }
  ++at
  if (at + 4 > packet.length) throw new Error('missing fixture DNS type')
  const isA = packet.readUInt16BE(at) === 1,
    end = at + 4
  const header = Buffer.alloc(12)
  packet.copy(header, 0, 0, 2)
  header.writeUInt16BE(0x8180, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(isA ? 1 : 0, 6)
  // Zero TTL: each fresh test name has independent observable resolution.
  const record = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 127, 0, 0, 1])
  return {
    name: labels.join('.').toLowerCase(),
    response: Buffer.concat([header, packet.subarray(12, end), ...(isA ? [record] : [])])
  }
}
export async function createLocalDNSFixture() {
  const sockets = new Set<Duplex>(),
    dohSockets = new Set<Duplex>()
  const track = (socket: Duplex): void => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  }
  const mainQueries: string[] = [],
    nodeQueries: string[] = [],
    policyQueries: string[] = []
  const udp = async (queries: string[]) => {
    const server = createSocket('udp4')
    server.on('error', () => {})
    server.on('message', (packet, remote) => {
      try {
        const value = answer(packet)
        queries.push(value.name)
        server.send(value.response, remote.port, remote.address)
      } catch {
        /* Reject malformed test traffic. */
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.bind(0, '127.0.0.1', resolve)
    })
    return server
  }
  const main = await udp(mainQueries),
    node = await udp(nodeQueries)
  let origins = 0,
    proxyDNS = 0
  const origin = createServer((req, res) => {
    ++origins
    res.setHeader('Connection', 'close')
    res.end('origin:' + req.url)
  })
  origin.on('connection', track)
  const originPort = await fixturePort(origin)
  const doh = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const respond = (packet: Buffer): void => {
      try {
        const value = answer(packet)
        policyQueries.push(value.name)
        res.setHeader('Content-Type', 'application/dns-message')
        res.end(value.response)
      } catch {
        res.writeHead(400).end()
      }
    }
    if (req.method === 'GET' && url.pathname === '/dns-query' && url.searchParams.has('dns')) {
      respond(Buffer.from(url.searchParams.get('dns') ?? '', 'base64url'))
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/dns-query') {
      res.writeHead(400).end()
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4096) req.destroy()
      else chunks.push(chunk)
    })
    req.on('end', () => {
      respond(Buffer.concat(chunks))
    })
  })
  doh.on('connection', (socket) => {
    track(socket)
    dohSockets.add(socket)
    socket.once('close', () => dohSockets.delete(socket))
  })
  const dohPort = await fixturePort(doh)
  const proxy = createServer((_req, res) => res.writeHead(405).end())
  proxy.on('connection', track)
  proxy.on('connect', (req, socket, head) => {
    if (req.url !== `127.0.0.1:${dohPort}`) {
      socket.destroy()
      return
    }
    ++proxyDNS
    track(socket)
    const upstream = createConnection({ host: '127.0.0.1', port: dohPort })
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
  // This occupied port stands in for the user's original DNS listener. The
  // materialized instance must start without binding it or touching its owner.
  const listener = tcpServer((socket) => socket.destroy()),
    listenerPort = await fixturePort(listener)
  const group = 'DNS / 测试'
  const source = JSON.stringify({
    dns: {
      enable: true,
      listen: `127.0.0.1:${listenerPort}`,
      'use-hosts': true,
      'use-system-hosts': false,
      nameserver: [`udp://127.0.0.1:${main.address().port}`],
      'default-nameserver': [`udp://127.0.0.1:${main.address().port}`],
      'proxy-server-nameserver': [`udp://127.0.0.1:${node.address().port}`],
      'nameserver-policy': {
        '+.policy.relay.test': `http://127.0.0.1:${dohPort}/dns-query#${group}`
      }
    },
    hosts: { 'static.relay.test': '127.0.0.1' },
    proxies: [{ name: 'DNSNode', type: 'http', server: 'relay-node.test', port: proxyPort }],
    'proxy-groups': [{ name: group, type: 'select', proxies: ['DNSNode'] }],
    rules: ['MATCH,DIRECT'],
    tun: { enable: true }
  })
  let dohClosed = false
  const closeDoh = async (): Promise<void> => {
    if (dohClosed) return
    dohClosed = true
    dohSockets.forEach((socket) => socket.destroy())
    await closeFixture(doh)
  }
  return {
    source,
    listener,
    mainQueries,
    nodeQueries,
    policyQueries,
    stats: () => ({ origins, proxyDNS }),
    closeDoh,
    request: async (httpPort: number, host: string, label: string): Promise<string> =>
      new Promise((resolve, reject) => {
        if (!/^[a-z0-9.-]+\.relay\.test$/u.test(host)) {
          reject(new Error('unknown test host'))
          return
        }
        const socket = createConnection({ host: '127.0.0.1', port: httpPort })
        track(socket)
        socket.setTimeout(7000, () => socket.destroy(new Error('fixture HTTP timeout')))
        const chunks: Buffer[] = []
        let length = 0
        socket.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > 65536) socket.destroy(new Error('fixture response limit'))
          else chunks.push(chunk)
        })
        socket.once('error', reject)
        socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        socket.once('connect', () =>
          socket.write(
            `GET http://${host}:${originPort}/${label} HTTP/1.1\r\nHost: ${host}:${originPort}\r\nConnection: close\r\n\r\n`
          )
        )
      }),
    close: async (): Promise<void> => {
      sockets.forEach((socket) => socket.destroy())
      await closeDoh()
      await Promise.all([
        closeFixture(origin),
        closeFixture(proxy),
        closeFixture(listener),
        ...[main, node].map((server) => new Promise<void>((resolve) => server.close(resolve)))
      ])
    }
  }
}
