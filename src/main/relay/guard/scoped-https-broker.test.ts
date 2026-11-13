import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type ClientRequest,
  type IncomingMessage,
  type RequestListener,
  type RequestOptions
} from 'node:http'
import { createServer as createHTTPSServer, request } from 'node:https'
import type { Socket, TcpNetConnectOpts } from 'node:net'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { connect as connectTLS } from 'node:tls'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import type { LocalRuntimeCapture } from '../core/local-proxy-service'
import { createScopedHTTPSBroker } from './scoped-https-broker'
import { mintScopedTLS } from './vendor/tls-material.mjs'

const fixtureCore = vi.hoisted(() => ({ port: 0 }))
const run = promisify(execFile)
const git = '/Library/Developer/CommandLineTools/usr/bin/git'
const npm = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
// The broker must dial its fixed owned-Core endpoint. The test remaps that
// dial to a private ephemeral listener and never probes the product port.
vi.mock('net', async (importOriginal) => {
  const net = await importOriginal<typeof import('node:net')>()
  return {
    ...net,
    connect: (options: TcpNetConnectOpts) => {
      if (options.host !== '127.0.0.1' || options.port !== 17891 || fixtureCore.port === 0)
        throw new Error('unexpected Core endpoint')
      return net.connect({ host: '127.0.0.1', port: fixtureCore.port })
    }
  }
})

vi.mock('http', async (importOriginal) => {
  const http = await importOriginal<typeof import('node:http')>()
  return {
    ...http,
    request: (
      options: RequestOptions,
      callback: (response: IncomingMessage) => void
    ): ClientRequest => {
      if (options.host !== '127.0.0.1' || options.port !== 17891 || fixtureCore.port === 0)
        throw new Error('unexpected Core endpoint')
      return http.request({ ...options, port: fixtureCore.port }, callback)
    }
  }
})

function proof(instanceId = 'fixture') {
  const assertOwner = vi.fn<LocalRuntimeCapture['assertOwner']>().mockResolvedValue(undefined)
  return {
    snapshot: { instanceId, revision: instanceId, configuration: '{}', proxyPort: 12345 },
    capturedAt: 0,
    isCurrent: () => true,
    isOwnerLive: () => true,
    assertOwner
  }
}

async function fixture(
  serve: RequestListener = (_, reply) => {
    reply.writeHead(404).end()
  },
  target?: { authority: string; accept(socket: Duplex): void }
) {
  const core = createServer(serve)
  const sockets = new Set<Duplex>()
  core.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const connectRequests: string[] = []
  const tunneled = createServer(serve)
  core.on('connect', (incoming, socket, head) => {
    connectRequests.push(incoming.url ?? '')
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    // Node's HTTP proxy client also uses CONNECT for this plain HTTP target.
    // Feed only the designated fixture request to an unbound local HTTP parser.
    if (target && incoming.url === target.authority) {
      if (head.length) socket.unshift(head)
      target.accept(socket)
      socket.resume()
    } else if (incoming.url === 'mcp-fixture.invalid:80') {
      if (head.length) socket.unshift(head)
      tunneled.emit('connection', socket)
      socket.resume()
    }
  })
  core.listen(0, '127.0.0.1')
  await once(core, 'listening')
  const address = core.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
  fixtureCore.port = address.port
  let closing: Promise<void> | undefined
  return {
    connectRequests,
    async close() {
      if (!closing) {
        if (fixtureCore.port === address.port) fixtureCore.port = 0
        for (const socket of sockets) socket.destroy()
        closing = new Promise<void>((resolve) => core.close(() => resolve()))
      }
      await closing
    }
  }
}

type Broker = Awaited<ReturnType<typeof createScopedHTTPSBroker>>
async function tunnel(
  broker: Broker,
  credentials: string | null = broker.proxyURL,
  authority = 'tool-fixture.invalid:443'
): Promise<{ status?: number; socket: Socket }> {
  const url = credentials ? new URL(credentials) : null
  return new Promise((resolve, reject) => {
    const requestHandle = request({
      host: '127.0.0.1',
      port: broker.port,
      method: 'CONNECT',
      path: authority,
      ca: broker.ca,
      agent: false,
      headers: url
        ? {
            'proxy-authorization':
              'Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64')
          }
        : {}
    })
    requestHandle.on('error', reject)
    requestHandle.on('connect', (reply, socket) => resolve({ status: reply.statusCode, socket }))
    requestHandle.setTimeout(2500, () =>
      requestHandle.destroy(new Error('fixture CONNECT timed out'))
    )
    requestHandle.end()
  })
}

async function readTargetTLS(broker: Broker, authority: string, ca: string): Promise<string> {
  const upstream = await tunnel(broker, broker.proxyURL, authority)
  if (upstream.status !== 200) {
    upstream.socket.destroy()
    throw new Error('fixture TLS tunnel was refused')
  }
  const client = connectTLS({
    socket: upstream.socket,
    host: '127.0.0.1',
    ca,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2'
  })
  client.setTimeout(2500, () => client.destroy(new Error('fixture target TLS timed out')))
  try {
    await once(client, 'secureConnect')
    client.write('GET /fixture HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    const received: Buffer[] = []
    for await (const chunk of client) received.push(chunk)
    return Buffer.concat(received).toString('utf8')
  } finally {
    client.destroy()
    upstream.socket.destroy()
  }
}

describe('scoped HTTPS broker with private loopback substitutes', () => {
  it('rejects an unauthenticated tunnel before it contacts the Core', async () => {
    const core = await fixture()
    let broker: Broker | undefined
    try {
      broker = await createScopedHTTPSBroker(proof())
      const denied = await tunnel(broker, null)
      denied.socket.destroy()
      expect(denied.status).toBe(407)
      expect(core.connectRequests).toEqual([])
    } finally {
      await broker?.close()
      await core.close()
    }
  })

  it('closes an established tunnel when owner checks hang, and ignores a late successful check', async () => {
    const core = await fixture()
    const capture = proof()
    let broker: Broker | undefined
    let signal: AbortSignal | undefined
    let lateProof: () => void = () => {}
    try {
      broker = await createScopedHTTPSBroker(capture)
      const connected = await tunnel(broker)
      expect(connected.status).toBe(200)
      connected.socket.resume()
      expect(core.connectRequests).toEqual(['tool-fixture.invalid:443'])
      capture.assertOwner.mockImplementation((active) => {
        signal = active
        return new Promise((resolve) => {
          lateProof = resolve
        })
      })
      await vi.waitFor(() => expect(connected.socket.destroyed).toBe(true), { timeout: 7000 })
      expect(signal?.aborted).toBe(true)
      expect(broker.isAlive()).toBe(false)
      lateProof()
      await expect(tunnel(broker)).rejects.toThrow()
    } finally {
      lateProof()
      await broker?.close()
      await core.close()
    }
  }, 10000)

  it('retires the failed Core tunnel and requires new credentials for an independent recovery', async () => {
    const failedCore = await fixture(),
      capture = proof()
    let broker: Broker | undefined
    let previousCredentials: string
    try {
      broker = await createScopedHTTPSBroker(capture)
      previousCredentials = broker.proxyURL
      const connected = await tunnel(broker)
      expect(connected.status).toBe(200)
      connected.socket.resume()
      await failedCore.close()
      capture.assertOwner.mockRejectedValue(new Error('fixture Core exited'))
      await vi.waitFor(() => {
        expect(connected.socket.destroyed).toBe(true)
        expect(broker?.isAlive()).toBe(false)
      })
      await expect(tunnel(broker)).rejects.toThrow()
    } finally {
      await broker?.close()
      await failedCore.close()
    }

    const recoveredCore = await fixture()
    let replacement: Broker | undefined
    try {
      replacement = await createScopedHTTPSBroker(proof('recovered-fixture'))
      const stale = await tunnel(replacement, previousCredentials)
      stale.socket.destroy()
      expect(stale.status).toBe(407)
      expect(recoveredCore.connectRequests).toEqual([])
      const fresh = await tunnel(replacement)
      fresh.socket.destroy()
      expect(fresh.status).toBe(200)
      expect(recoveredCore.connectRequests).toEqual(['tool-fixture.invalid:443'])
    } finally {
      await replacement?.close()
      await recoveredCore.close()
    }
  })

  it('passes target TLS through CONNECT without trusting the broker CA for the target', async () => {
    const material = await mintScopedTLS(),
      received = vi.fn()
    const https = createHTTPSServer({ key: material.key, cert: material.cert }, (req, reply) => {
      received(req.url)
      reply.end('fixture-https-ok')
    })
    https.on('tlsClientError', () => {})
    const authority = '127.0.0.1:443'
    const core = await fixture(undefined, {
      authority,
      accept: (socket) => https.emit('connection', socket)
    })
    let broker: Broker | undefined
    try {
      broker = await createScopedHTTPSBroker(proof())
      await expect(readTargetTLS(broker, authority, broker.ca)).rejects.toThrow(/certificat/i)
      expect(received).not.toHaveBeenCalled()
      expect(await readTargetTLS(broker, authority, material.ca)).toContain('fixture-https-ok')
      expect(received).toHaveBeenCalledExactlyOnceWith('/fixture')
      expect(core.connectRequests).toEqual([authority, authority])
    } finally {
      await broker?.close()
      await core.close()
      material.key.fill(0)
    }
  }, 10000)

  it.runIf(
    process.env.RELAY_BROKER_TOOL_FIXTURE === '1' &&
      process.platform === 'darwin' &&
      process.allowedNodeEnvironmentFlags.has('--use-env-proxy') &&
      existsSync(git) &&
      existsSync(npm)
  )(
    'routes Git, npm and an MCP-shaped Node request through the broker with normal TLS',
    async () => {
      const hash = 'a'.repeat(40)
      const seen: string[] = []
      const core = await fixture((incoming, reply) => {
        const target = new URL(
          incoming.url ?? '/',
          'http://' + (incoming.headers.host ?? 'unmatched-fixture.invalid')
        )
        seen.push(target.hostname)
        if (
          target.hostname === 'git-fixture.invalid' &&
          target.pathname === '/repo.git/info/refs'
        ) {
          reply.writeHead(200, { 'content-type': 'text/plain' }).end(hash + '\trefs/heads/main\n')
        } else if (
          target.hostname === 'npm-fixture.invalid' &&
          target.pathname === '/relay-fixture'
        ) {
          reply.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              name: 'relay-fixture',
              'dist-tags': { latest: '1.2.3' },
              versions: { '1.2.3': { name: 'relay-fixture', version: '1.2.3' } }
            })
          )
        } else if (target.hostname === 'mcp-fixture.invalid' && incoming.method === 'POST') {
          const chunks: Buffer[] = []
          incoming.on('data', (data: Buffer) => chunks.push(data))
          incoming.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (body.method !== 'tools/list') return reply.writeHead(400).end()
            reply.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: { tools: [{ name: 'fixture-tool' }] }
              })
            )
          })
        } else reply.writeHead(404).end()
      })
      const home = await mkdtemp(join(tmpdir(), 'relay-tools-fixture-'))
      let broker: Broker | undefined
      try {
        broker = await createScopedHTTPSBroker(proof())
        const ca = join(home, 'proxy.pem')
        await writeFile(ca, broker.ca, { mode: 0o600 })
        const env = {
          PATH: '/usr/bin:/bin',
          HOME: home,
          TMPDIR: home,
          HTTP_PROXY: broker.proxyURL,
          HTTPS_PROXY: broker.proxyURL,
          http_proxy: broker.proxyURL,
          https_proxy: broker.proxyURL,
          NO_PROXY: '',
          no_proxy: '',
          NODE_EXTRA_CA_CERTS: ca,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'http.proxy',
          GIT_CONFIG_VALUE_0: broker.proxyURL,
          GIT_CONFIG_KEY_1: 'http.proxySSLCAInfo',
          GIT_CONFIG_VALUE_1: ca,
          GIT_TERMINAL_PROMPT: '0',
          npm_config_userconfig: join(home, 'user.npmrc'),
          npm_config_globalconfig: join(home, 'global.npmrc'),
          npm_config_cache: join(home, 'npm-cache'),
          npm_config_update_notifier: 'false',
          npm_config_fetch_retries: '0'
        }
        const profile = [
          '(version 1)',
          '(allow default)',
          '(deny network-outbound (remote ip "*:*"))',
          `(allow network-outbound (remote tcp4 "localhost:${broker.port}"))`
        ].join('\n')
        const tool = (executable: string, args: string[]) =>
          run('/usr/bin/sandbox-exec', ['-p', profile, executable, ...args], {
            cwd: home,
            env,
            timeout: 5000
          })
        expect(
          (await tool(git, ['ls-remote', 'http://git-fixture.invalid/repo.git'])).stdout
        ).toContain(hash)
        expect(
          (
            await tool(process.execPath, [
              npm,
              'view',
              'relay-fixture',
              'version',
              '--registry',
              'http://npm-fixture.invalid/'
            ])
          ).stdout.trim()
        ).toBe('1.2.3')
        const script = [
          "const response = await fetch('http://mcp-fixture.invalid/rpc', {",
          "method: 'POST', headers: { 'content-type': 'application/json' },",
          "body: JSON.stringify({jsonrpc:'2.0', id: 1, method:'tools/list'}) })",
          'const data = await response.json()',
          'console.log(data.result.tools[0].name)'
        ].join('\n')
        expect(
          (
            await tool(process.execPath, ['--use-env-proxy', '--input-type=module', '-e', script])
          ).stdout.trim()
        ).toBe('fixture-tool')
        expect(new Set(seen)).toEqual(
          new Set(['git-fixture.invalid', 'npm-fixture.invalid', 'mcp-fixture.invalid'])
        )
      } finally {
        await broker?.close()
        await core.close()
        await rm(home, { recursive: true, force: true })
      }
    },
    18000
  )
})
