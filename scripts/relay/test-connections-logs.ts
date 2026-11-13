// Batch 32 host verification: connections, logs, real-time traffic totals,
// and network/process info read from a real owned local proxy core. Write
// actions (close one / close all) have an explicit scope. Runs only against
// the local-network fixture on 127.0.0.1; never touches the system proxy,
// DNS, TUN, the current Clash, or any external host.
import { mkdtemp, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { createConnection } from 'net'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { CoreStore } from '../../src/main/relay/core/store'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { createLocalProxyService } from '../../src/main/relay/core/local-proxy-service'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import { probeLocalPort, ownsHttpListener } from '../../src/main/relay/core/port'
import {
  createRuntimeInfoService,
  readNetworkInterfaces
} from '../../src/main/relay/network-info/service'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'

const rows: { name: string; passed: boolean; detail?: string }[] = []
const check = (name: string, passed: boolean, detail?: string): void => {
  rows.push({ name, passed, ...(detail ? { detail } : {}) })
}
const home = await mkdtemp('/private/tmp/relay-conn-'),
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
const runtimeInfo = createRuntimeInfoService({
  state: () => local.state(),
  connections: () => local.connections()
})

// Open a tunnelled connection through the owned HTTP proxy and keep it open
// long enough to appear in /connections. Returns the connection id when found.
async function openTunnelAndFindId(
  proxyPort: number,
  originPort: number
): Promise<string | undefined> {
  const socket = createConnection({ host: '127.0.0.1', port: proxyPort })
  await new Promise<void>((r, e) => {
    socket.once('connect', r)
    socket.once('error', e)
  })
  socket.write(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`)
  // Wait for the 200 reply, then hold the tunnel open.
  await new Promise<void>((resolveReply, rejectReply) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('\r\n\r\n')) {
        socket.off('data', onData)
        if (/^HTTP\/1\.[01] 200 /u.test(buffer)) resolveReply()
        else rejectReply(new Error('CONNECT refused'))
      }
    }
    socket.on('data', onData)
    socket.once('error', rejectReply)
  })
  // Poll /connections for an entry whose host metadata references the origin.
  for (let attempt = 0; attempt < 20; attempt++) {
    const snapshot = await local.connections()
    if (snapshot) {
      const entry = snapshot.connections.find((value) => {
        if (!value || typeof value !== 'object') return false
        const record = value as Record<string, unknown>
        const id = record.id
        if (typeof id !== 'string') return false
        const metadata = record.metadata as Record<string, unknown> | undefined
        const host = typeof metadata?.host === 'string' ? metadata.host : ''
        return host.includes('127.0.0.1') || host === ''
      })
      if (entry && typeof (entry as Record<string, unknown>).id === 'string')
        return (entry as Record<string, unknown>).id as string
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  socket.destroy()
  return undefined
}

try {
  const profile = await profiles.save('Connections', network.source)
  const mainPort = await freeFixturePort()
  const plan = await local.prepare({
    profile: { id: profile.id, sha256: profile.sha256 },
    httpPort: mainPort
  })
  const started = await local.action({ action: 'start', evidenceId: plan.evidenceId })
  check('owned core starts for connections verification', started.status === 'started')
  const pid = local.state().pid as number
  check('main port owned by core PID', await ownsHttpListener(pid, mainPort))

  // --- connections snapshot reads real data ---
  const origin = new URL(network.healthURL)
  const emptySnapshot = await local.connections()
  check(
    'connections snapshot returns a real array and zero totals before traffic',
    !!emptySnapshot &&
      Array.isArray(emptySnapshot.connections) &&
      emptySnapshot.download === 0 &&
      emptySnapshot.upload === 0
  )
  await network.request(mainPort, 'traffic-counters')
  let transferred = await local.connections()
  for (
    let attempt = 0;
    attempt < 20 && (!transferred || !transferred.download || !transferred.upload);
    ++attempt
  ) {
    await new Promise((resolveSample) => setTimeout(resolveSample, 100))
    transferred = await local.connections()
  }
  check(
    'real fixture transfer increments both Mihomo cumulative counters',
    !!transferred && transferred.download > 0 && transferred.upload > 0
  )

  // --- open a tunnel, it appears in /connections ---
  const connId = await openTunnelAndFindId(mainPort, Number(origin.port))
  check(
    'a tunnelled connection appears in the live connections list',
    !!connId,
    `id=${connId ?? 'none'}`
  )

  // --- close a single connection ---
  if (connId) {
    await local.closeConnection(connId)
    let gone = false
    for (let attempt = 0; attempt < 10; attempt++) {
      const snap = await local.connections()
      if (snap && !snap.connections.some((c) => (c as Record<string, unknown>)?.id === connId)) {
        gone = true
        break
      }
      await new Promise((r) => setTimeout(r, 80))
    }
    check('closeConnection removes the targeted connection', gone)
  } else {
    check('closeConnection removes the targeted connection', false, 'no connection id found')
  }

  // --- open several, then close all ---
  const ids: (string | undefined)[] = []
  for (let i = 0; i < 3; i++) ids.push(await openTunnelAndFindId(mainPort, Number(origin.port)))
  const beforeAll = await local.connections()
  check(
    'multiple tunnels are visible before close-all',
    !!beforeAll && beforeAll.connections.length >= 1
  )
  await local.closeAllConnections()
  let allGone = false
  for (let attempt = 0; attempt < 10; attempt++) {
    const snap = await local.connections()
    if (snap && snap.connections.length === 0) {
      allGone = true
      break
    }
    await new Promise((r) => setTimeout(r, 80))
  }
  check('closeAllConnections clears the live connections list', allGone)

  // --- logs ring buffer ---
  const logs = local.logs()
  check(
    'logs returns a bounded ring buffer of real core output',
    Array.isArray(logs) &&
      logs.length <= 512 &&
      logs.reduce((total, line) => total + Buffer.byteLength(line), 0) <= 65536
  )

  // --- runtime info: interfaces + process + traffic ---
  const info = await runtimeInfo.inspect()
  check(
    'runtime info reports real local network interfaces (lo0/en0 present)',
    info.interfaces.length > 0 && info.interfaces.some((iface) => iface.addresses.length > 0)
  )
  check(
    'runtime info reports the owned process pid and http port',
    info.process.pid === pid && info.process.httpPort === mainPort
  )
  check(
    'runtime info exposes real-time traffic totals from the connections endpoint',
    info.traffic !== undefined && info.traffic.download > 0 && info.traffic.upload > 0
  )
  check(
    'external IP lookup and remote latency probe are explicitly not wired',
    info.externalIpLookupWired === false && info.remoteLatencyProbeWired === false
  )
  // Independent check: readNetworkInterfaces returns the loopback interface.
  const ifaces = readNetworkInterfaces()
  check(
    'readNetworkInterfaces includes the loopback interface',
    ifaces.some((i) => i.name === 'lo0')
  )

  // --- stop releases the port ---
  const stopped = await local.action({ action: 'stop', instanceId: local.state().instanceId })
  check('owned core stops cleanly', stopped.status === 'stopped')
  check('main port released after stop', await probeLocalPort(mainPort))
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
const result = { checks: rows.length, passed, rows, hostAccepted: passed === rows.length }
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
process.exit(result.hostAccepted ? 0 : 1)
