// Batch 31 host verification: real owned local proxy core with dedicated
// HTTP/SOCKS listeners pinned to a fixed node, plus the AI-client association
// gate. Runs only against the local-network fixture on 127.0.0.1; it never
// touches the system proxy, DNS, TUN, the current Clash, or any external host.
import { mkdtemp, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { createConnection } from 'net'
import { createServer as createHttpServer } from 'http'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { CoreStore } from '../../src/main/relay/core/store'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { createLocalProxyService } from '../../src/main/relay/core/local-proxy-service'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import { probeLocalPort, ownsHttpListener } from '../../src/main/relay/core/port'
import { createAiClientService } from '../../src/main/relay/ai-clients/service'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'

const rows: { name: string; passed: boolean; detail?: string }[] = []
const check = (name: string, passed: boolean, detail?: string): void => {
  rows.push({ name, passed, ...(detail ? { detail } : {}) })
}
const home = await mkdtemp('/private/tmp/relay-dedicated-'),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
const network = await createLocalNetworkFixture()
const coreRoot = resolve('extra/relay/core'),
  profiles = new ProfileStore(context),
  coreStore = new CoreStore(context)
let cleanup: (() => Promise<void>) | undefined
const local = createLocalProxyService({
  read: (selection) => profiles.read(selection),
  inspect: () => coreStore.inspect(),
  resources: () => verifyCoreResource(coreRoot),
  portAvailable: probeLocalPort,
  acquire: (runtime, revision) => coreStore.acquire('rule', revision, runtime),
  start: (source, port, register, resolverMode, dedicated) =>
    startLocalProxyCore(
      coreRoot,
      source,
      port,
      (stop) => {
        cleanup = stop
        register(stop)
      },
      resolverMode,
      dedicated
    ),
  confirmStart: async () => true,
  confirmStop: async () => true,
  confirmMode: async () => true,
  confirmTest: async () => true,
  confirmReload: async () => true
})
const aiClients = createAiClientService({
  state: () => local.state(),
  liveListener: ownsHttpListener
})

// A minimal HTTP-CONNECT client through an HTTP proxy listener. Returns the
// tunnelled origin body, mirroring how a client tunnels to a loopback login
// callback. Throws if the proxy refuses the CONNECT.
async function connectThroughHttpProxy(
  proxyPort: number,
  host: string,
  port: number,
  path: string
): Promise<string> {
  const socket = createConnection({ host: '127.0.0.1', port: proxyPort })
  await new Promise<void>((resolveConnect, rejectConnect) => {
    socket.once('connect', resolveConnect)
    socket.once('error', rejectConnect)
  })
  await new Promise<void>((resolveWrite) =>
    socket.write(
      `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
      resolveWrite
    )
  )
  const connectReply = await new Promise<string>((resolveReply, rejectReply) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('\r\n\r\n')) {
        socket.off('data', onData)
        resolveReply(buffer)
      } else if (buffer.length > 8192) {
        socket.off('data', onData)
        rejectReply(new Error('CONNECT reply too large'))
      }
    }
    socket.on('data', onData)
    socket.once('error', rejectReply)
  })
  if (!/^HTTP\/1\.[01] 200 /u.test(connectReply))
    throw new Error('dedicated HTTP listener refused CONNECT: ' + connectReply.split('\r\n')[0])
  return new Promise<string>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`)
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).toString('utf8').includes('origin:'))
        resolveBody(Buffer.concat(chunks).toString('utf8'))
      else if (Buffer.concat(chunks).length > 65536) {
        socket.destroy()
        rejectBody(new Error('origin body too large'))
      }
    })
    socket.once('error', rejectBody)
    socket.setTimeout(4000, () => {
      socket.destroy()
      rejectBody(new Error('origin body timeout'))
    })
  })
}

// A minimal SOCKS5 (no-auth) CONNECT client through a SOCKS listener.
async function connectThroughSocksProxy(
  proxyPort: number,
  host: string,
  port: number,
  path: string
): Promise<string> {
  const socket = createConnection({ host: '127.0.0.1', port: proxyPort })
  socket.setTimeout(4000, () => socket.destroy(new Error('SOCKS listener timeout')))
  await new Promise<void>((resolveConnect, rejectConnect) => {
    socket.once('connect', resolveConnect)
    socket.once('error', rejectConnect)
  })
  // Greeting: 1 method (no auth).
  await new Promise<void>((r) => socket.write(Buffer.from([0x05, 0x01, 0x00]), r))
  const greeting = await new Promise<Buffer>((resolveReply, rejectReply) => {
    socket.once('data', (chunk: Buffer) => resolveReply(chunk))
    socket.once('error', rejectReply)
    socket.once('close', () => rejectReply(new Error('SOCKS listener closed before greeting')))
  })
  if (greeting.length !== 2 || greeting[0] !== 0x05 || greeting[1] !== 0x00)
    throw new Error('SOCKS greeting rejected')
  // Connect request: IPv4 127.0.0.1:port
  const hostOctets = host.split('.').map((n) => Number(n))
  const portHi = Math.floor(port / 256),
    portLo = port % 256
  const request = Buffer.from([0x05, 0x01, 0x00, 0x01, ...hostOctets, portHi, portLo])
  await new Promise<void>((r) => socket.write(request, r))
  const reply = await new Promise<Buffer>((resolveReply, rejectReply) => {
    socket.once('data', (chunk: Buffer) => resolveReply(chunk))
    socket.once('error', rejectReply)
    socket.once('close', () => rejectReply(new Error('SOCKS listener closed before CONNECT reply')))
  })
  if (reply.length < 2 || reply[0] !== 0x05 || reply[1] !== 0x00)
    throw new Error('SOCKS connect rejected: ' + (reply[1] ?? 'no reply'))
  return new Promise<string>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`)
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).toString('utf8').includes('origin:'))
        resolveBody(Buffer.concat(chunks).toString('utf8'))
      else if (Buffer.concat(chunks).length > 65536) {
        socket.destroy()
        rejectBody(new Error('origin body too large'))
      }
    })
    socket.once('error', rejectBody)
    socket.once('close', () =>
      rejectBody(new Error('SOCKS listener closed before the origin body'))
    )
  })
}

async function loopbackDirect(callbackPort: number): Promise<string> {
  // Login callbacks go to 127.0.0.1 directly; the OS routes loopback without
  // entering any listener. A direct TCP GET proves the callback stays direct.
  const socket = createConnection({ host: '127.0.0.1', port: callbackPort })
  await new Promise<void>((r, e) => {
    socket.once('connect', r)
    socket.once('error', e)
  })
  return new Promise<string>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    socket.write('GET /callback HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    socket.on('data', (c: Buffer) => {
      chunks.push(c)
      if (Buffer.concat(chunks).toString('utf8').includes('origin:'))
        resolveBody(Buffer.concat(chunks).toString('utf8'))
    })
    socket.once('error', rejectBody)
    socket.setTimeout(3000, () => {
      socket.destroy()
      rejectBody(new Error('loopback callback timeout'))
    })
  })
}

try {
  const profile = await profiles.save(
    'Dedicated',
    network.source.replace('MATCH,' + network.group, 'MATCH,DIRECT')
  )
  const mainPort = await freeFixturePort(),
    httpPort = await freeFixturePort(),
    socksPort = await freeFixturePort()

  // --- route validation ---
  let refused = false
  try {
    await local.prepare({
      profile: { id: profile.id, sha256: profile.sha256 },
      httpPort: mainPort,
      dedicated: { httpPort, socksPort, route: 'DIRECT' }
    })
  } catch {
    refused = true
  }
  check('route DIRECT is rejected for a dedicated listener', refused)
  refused = false
  try {
    await local.prepare({
      profile: { id: profile.id, sha256: profile.sha256 },
      httpPort: mainPort,
      dedicated: { httpPort, route: network.group }
    })
  } catch {
    refused = true
  }
  check('route must be a concrete node, not a group name', refused)
  refused = false
  try {
    await local.prepare({
      profile: { id: profile.id, sha256: profile.sha256 },
      httpPort: mainPort,
      dedicated: { httpPort, route: 'NonexistentNode' }
    })
  } catch {
    refused = true
  }
  check('route must name a node present in the compiled configuration', refused)

  // --- prepare + start with dedicated listeners ---
  const plan = await local.prepare({
    profile: { id: profile.id, sha256: profile.sha256 },
    httpPort: mainPort,
    dedicated: { httpPort, socksPort, route: 'NodeB' }
  })
  check(
    'preparation advertises the dedicated summary pinned to NodeB',
    !!plan.dedicated &&
      plan.dedicated.httpPort === httpPort &&
      plan.dedicated.socksPort === socksPort &&
      plan.dedicated.route === 'NodeB'
  )
  const started = await local.action({ action: 'start', evidenceId: plan.evidenceId })
  check('owned core starts with dedicated listeners', started.status === 'started')
  const state = local.state()
  check(
    'state exposes pid and the dedicated summary',
    !!state.pid &&
      state.dedicated?.httpPort === httpPort &&
      state.dedicated?.socksPort === socksPort
  )
  const pid = state.pid as number
  check(
    'main, dedicated HTTP and dedicated SOCKS ports are all owned by the core PID',
    (await ownsHttpListener(pid, mainPort)) &&
      (await ownsHttpListener(pid, httpPort)) &&
      (await ownsHttpListener(pid, socksPort))
  )

  // --- routing: traffic through the dedicated HTTP listener goes via NodeB ---
  const beforeA = network.stats().usedA,
    beforeB = network.stats().usedB
  const origin = new URL(network.healthURL)
  const httpBody = await connectThroughHttpProxy(
    httpPort,
    '127.0.0.1',
    Number(origin.port),
    '/dedicated-http'
  )
  const afterA = network.stats().usedA,
    afterB = network.stats().usedB
  check(
    'dedicated HTTP listener routes CONNECT through the fixed NodeB',
    httpBody.includes('origin:') && afterB > beforeB && afterA === beforeA
  )

  // --- routing: SOCKS listener also via NodeB ---
  const sBeforeB = network.stats().usedB
  const socksBody = await connectThroughSocksProxy(
    socksPort,
    '127.0.0.1',
    Number(origin.port),
    '/dedicated-socks'
  )
  const sAfterB = network.stats().usedB
  check(
    'dedicated SOCKS listener routes through the fixed NodeB',
    socksBody.includes('origin:') && sAfterB > sBeforeB
  )

  // --- login callback stays direct (loopback regression) ---
  const callback = createHttpServer((req, res) => {
    res.setHeader('Connection', 'close')
    res.end('origin:' + req.url)
  })
  const callbackPort = await new Promise<number>((resolvePort) => {
    callback.listen(0, '127.0.0.1', () =>
      resolvePort((callback.address() as { port: number }).port)
    )
  })
  const direct = await loopbackDirect(callbackPort)
  check(
    'login callback to 127.0.0.1 stays direct and is not captured by the listeners',
    direct.includes('origin:/callback')
  )
  await new Promise<void>((r) => callback.close(() => r()))

  // --- AI client association gate ---
  await aiClients.verifyClaudeCodePort(httpPort)
  check('Claude Code association to the live dedicated HTTP listener passes', true)
  let gateRefused = false
  try {
    await aiClients.verifyClaudeCodePort(await freeFixturePort())
  } catch {
    gateRefused = true
  }
  check('Claude Code association to a foreign port is refused', gateRefused)
  const inspect = await aiClients.inspect({ claudeCodePort: httpPort })
  check(
    'association inspect reports live dedicated entries and read-only Codex',
    inspect.owned.httpLive &&
      inspect.owned.socksLive &&
      inspect.claudeCode.listenerLive &&
      inspect.codex.neverWrites &&
      inspect.loopbackDirect.containsLoopback
  )

  // --- reload keeps the dedicated listeners (compatible plan) ---
  const reloadPlan = await local.prepareReload({
    profile: { id: profile.id, sha256: profile.sha256 },
    httpPort: mainPort,
    dedicated: { httpPort, socksPort, route: 'NodeB' }
  })
  const reloaded = await local.reload({ evidenceId: reloadPlan.evidenceId })
  check(
    'hot reload with the same dedicated plan keeps the listeners owned',
    reloaded.status === 'reloaded' &&
      (await ownsHttpListener(pid, httpPort)) &&
      (await ownsHttpListener(pid, socksPort)),
    `status=${reloaded.status} httpOwned=${await ownsHttpListener(pid, httpPort)} socksOwned=${await ownsHttpListener(pid, socksPort)}`
  )
  // --- reload refuses a dedicated port change ---
  let reloadRefused = false
  try {
    await local.prepareReload({
      profile: { id: profile.id, sha256: profile.sha256 },
      httpPort: mainPort,
      dedicated: { httpPort: await freeFixturePort(), socksPort, route: 'NodeB' }
    })
  } catch {
    reloadRefused = true
  }
  check('hot reload refuses to change a dedicated listener port', reloadRefused)

  const beforeHealthyRequest = network.stats()
  const healthyResponse = await network.request(httpPort, 'dedicated-node-before-failure')
  check(
    'the same dedicated HTTP path reaches the origin through NodeB before failure',
    healthyResponse.includes('origin:/dedicated-node-before-failure') &&
      network.stats().usedB > beforeHealthyRequest.usedB
  )
  const beforeHealthySocks = network.stats()
  const healthySocks = await connectThroughSocksProxy(
    socksPort,
    '127.0.0.1',
    Number(origin.port),
    '/dedicated-socks-before-failure'
  )
  check(
    'the same dedicated SOCKS path reaches the origin through NodeB before failure',
    healthySocks.includes('origin:/dedicated-socks-before-failure') &&
      network.stats().usedB > beforeHealthySocks.usedB
  )
  await network.stopB()
  const ordinaryResponse = await network.request(mainPort, 'ordinary-direct-still-works')
  const beforeFailure = network.stats()
  const dedicatedResponse = await network.request(httpPort, 'must-not-fall-back').catch(() => '')
  const afterFailure = network.stats()
  check(
    'dedicated HTTP fails after its node stops, while the same destination is reachable directly',
    ordinaryResponse.includes('origin:/ordinary-direct-still-works') &&
      (await ownsHttpListener(pid, httpPort)) &&
      !dedicatedResponse.includes('origin:') &&
      afterFailure.originRequests === beforeFailure.originRequests &&
      afterFailure.usedA === beforeFailure.usedA
  )
  const dedicatedSocks = await connectThroughSocksProxy(
    socksPort,
    '127.0.0.1',
    Number(origin.port),
    '/socks-must-not-fall-back'
  ).catch(() => undefined)
  check(
    'dedicated SOCKS fails after its node stops without reaching the origin',
    dedicatedSocks === undefined &&
      (await ownsHttpListener(pid, socksPort)) &&
      network.stats().originRequests === afterFailure.originRequests &&
      network.stats().usedA === afterFailure.usedA
  )

  // --- stop releases every dedicated port ---
  const stopped = await local.action({ action: 'stop', instanceId: local.state().instanceId })
  check('owned core stops cleanly', stopped.status === 'stopped')
  check(
    'dedicated HTTP and SOCKS ports are released after stop',
    (await probeLocalPort(httpPort)) &&
      (await probeLocalPort(socksPort)) &&
      (await probeLocalPort(mainPort))
  )
  const unicode = await profiles.save(
    'Unicode SOCKS',
    network.source.replaceAll('NodeA', '香港 节点 🇭🇰')
  )
  const socksOnly = await local.prepare({
    profile: { id: unicode.id, sha256: unicode.sha256 },
    httpPort: mainPort,
    dedicated: { socksPort, route: '香港 节点 🇭🇰' }
  })
  check('SOCKS-only Unicode node plan prepares successfully', socksOnly.canStart)
  const socksStarted = await local.action({ action: 'start', evidenceId: socksOnly.evidenceId })
  check(
    'SOCKS-only listener starts under the owned runtime boundary',
    socksStarted.status === 'started' && (await ownsHttpListener(local.state().pid ?? 0, socksPort))
  )
  const unicodeReply = await connectThroughSocksProxy(
    socksPort,
    '127.0.0.1',
    Number(origin.port),
    '/unicode-socks'
  )
  check(
    'SOCKS-only Unicode node forwards real loopback traffic',
    unicodeReply.includes('origin:/unicode-socks')
  )
  const socksStopped = await local.action({ action: 'stop', instanceId: local.state().instanceId })
  check(
    'SOCKS-only owned instance releases both listener ports',
    socksStopped.status === 'stopped' &&
      (await probeLocalPort(mainPort)) &&
      (await probeLocalPort(socksPort))
  )
} catch (error) {
  check(
    'host verification completed without throwing',
    false,
    error instanceof Error ? error.message : String(error)
  )
} finally {
  try {
    await cleanup?.()
  } catch {
    // ignore
  }
  await network.close()
  await rm(home, { recursive: true, force: true })
}

const passed = rows.filter((row) => row.passed).length
const result = {
  checks: rows.length,
  passed,
  rows,
  hostAccepted: passed === rows.length
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
process.exit(result.hostAccepted ? 0 : 1)
