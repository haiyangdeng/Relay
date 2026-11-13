import { mkdtemp, realpath, readFile, readdir, lstat, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { createConnection } from 'net'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { CoreStore } from '../../src/main/relay/core/store'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import { createLocalProxyService } from '../../src/main/relay/core/local-proxy-service'
import type { RelayOwnedCore } from '../../src/main/relay/core/owned-runtime'
import { probeLocalPort } from '../../src/main/relay/core/port'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'

const home = await realpath(await mkdtemp('/private/tmp/relay-owned-reload-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  profiles = new ProfileStore(context),
  store = new CoreStore(context),
  root = resolve('extra/relay/core'),
  network = await createLocalNetworkFixture()
const rows: { name: string; passed: boolean; status?: string }[] = []
const check = (name: string, passed: boolean, status?: string): void => {
  rows.push({ name, passed, ...(status ? { status } : {}) })
}
let allow = false,
  launches = 0,
  confirmations = 0,
  session: RelayOwnedCore | undefined,
  cleanup: (() => Promise<void>) | undefined
let held: ReturnType<typeof createConnection> | undefined
async function exchange(
  socket: ReturnType<typeof createConnection>,
  message: string,
  complete: (data: string) => boolean
): Promise<void> {
  if (socket.destroyed) throw new Error('fixture stream closed')
  await new Promise<void>((resolve, reject) => {
    let data = ''
    const finish = (error?: Error): void => {
      socket.off('data', receive)
      socket.off('error', failed)
      error ? reject(error) : resolve()
    }
    const failed = (error: Error): void => finish(error)
    const receive = (chunk: Buffer): void => {
      data += chunk.toString('utf8')
      if (data.length > 8192) finish(new Error('fixture response budget'))
      else if (complete(data)) finish()
    }
    socket.on('data', receive)
    socket.once('error', failed)
    socket.write(message)
  })
}
const local = createLocalProxyService({
  read: (selection) => profiles.read(selection),
  inspect: () => store.inspect(),
  resources: () => verifyCoreResource(root),
  portAvailable: probeLocalPort,
  acquire: (runtime, revision) => store.acquire('rule', revision, runtime),
  start: async (source, port, register, mode) => {
    ++launches
    session = await startLocalProxyCore(
      root,
      source,
      port,
      (stop) => {
        cleanup = stop
        register(stop)
      },
      mode
    )
    return session
  },
  confirmStart: async () => true,
  confirmStop: async () => true,
  confirmReload: async () => {
    ++confirmations
    return allow
  }
})
try {
  const a = await profiles.save('A', network.source),
    second = JSON.parse(network.source)
  second['proxy-groups'][0]['default-selected'] = 'NodeB'
  const b = await profiles.save('B', JSON.stringify(second)),
    port = await freeFixturePort()
  const plan = await local.prepare({ profile: { id: a.id, sha256: a.sha256 }, httpPort: port })
  const started = await local.action({ action: 'start', evidenceId: plan.evidenceId })
  check(
    'owned proxy starts with explicit source and one child',
    started.status === 'started' && launches === 1
  )
  if (!session) throw new Error('Missing owned session')
  const child = session as RelayOwnedCore,
    pid = child.pid,
    socket = child.socket,
    directory = child.directory,
    instanceId = local.state().instanceId
  await network.request(port, 'before')
  check('original source sends new traffic through A', network.stats().usedA === 1)
  const origin = new URL(network.healthURL)
  held = createConnection({ host: '127.0.0.1', port })
  held.on('error', () => {})
  held.setTimeout(10000, () => held?.destroy(new Error('fixture stream timeout')))
  await exchange(
    held,
    `CONNECT ${origin.host} HTTP/1.1\r\nHost: ${origin.host}\r\n\r\n`,
    (data) => /^HTTP\/1\.[01] 200 /u.test(data) && data.includes('\r\n\r\n')
  )
  await exchange(
    held,
    `GET /hold-open HTTP/1.1\r\nHost: ${origin.host}\r\nConnection: keep-alive\r\n\r\n`,
    (data) => data.includes('\r\n\r\nx')
  )
  check(
    'old CONNECT is warmed through A before configuration replacement',
    network.stats().usedA === 2
  )
  const prepare = () =>
    local.prepareReload({ profile: { id: b.id, sha256: b.sha256 }, httpPort: port })
  const cancelled = await prepare(),
    before = network.stats()
  const refused = await local.reload({ evidenceId: cancelled.evidenceId })
  check(
    'default-cancel native confirmation changes no core or traffic',
    refused.status === 'cancelled' &&
      local.state().profileId === a.id &&
      JSON.stringify(before) === JSON.stringify(network.stats()) &&
      launches === 1
  )
  allow = true
  const ready = await prepare(),
    loaded = await local.reload({ evidenceId: ready.evidenceId })
  check(
    'real owned core applies same-port candidate without restart',
    loaded.status === 'reloaded' &&
      launches === 1 &&
      child.pid === pid &&
      child.socket === socket &&
      local.state().instanceId === instanceId,
    loaded.status
  )
  check(
    'source identity and actual group selection are published after confirmation',
    local.state().profileId === b.id && local.state().groups[0]?.now === 'NodeB'
  )
  await network.request(port, 'after')
  check('new request uses B after reload', network.stats().usedB === 1)
  await exchange(
    held,
    `GET /hold-open HTTP/1.1\r\nHost: ${origin.host}\r\nConnection: keep-alive\r\n\r\n`,
    (data) => data.includes('\r\n\r\nx')
  )
  check(
    'established A stream survives while new connections use the reloaded B source',
    network.stats().usedA === 2 && network.stats().usedB === 1 && !held.destroyed
  )
  held.destroy()
  held = undefined
  const owner = JSON.parse(await readFile(join(store.directory, '.session/owner.json'), 'utf8'))
  check(
    'nonce-owned running lease persists the newly applied source identity',
    owner.runtime.profileId === b.id && owner.runtime.sourceSHA256 === b.sha256 && owner.pid === pid
  )
  const records = (await readdir(directory)).filter((name) =>
    /^reload-[a-f0-9-]+\.json$/u.test(name)
  )
  const record =
    records.length === 1
      ? JSON.parse(await readFile(join(directory, records[0]), 'utf8'))
      : undefined
  check(
    'private durable evidence keeps previous and exact candidate bytes with their digests',
    records.length === 1 &&
      (await lstat(join(directory, records[0]))).mode % 512 === 0o600 &&
      record?.previousSHA256 === ready.previousSHA256 &&
      record?.runtimeSHA256 === ready.runtimeSHA256 &&
      typeof record.previous === 'string' &&
      typeof record.candidate === 'string'
  )
  let replay = false
  try {
    await local.reload({ evidenceId: ready.evidenceId })
  } catch {
    replay = true
  }
  check('reload proof cannot be replayed', replay)
  let wrongPort = false
  try {
    await local.prepareReload({
      profile: { id: a.id, sha256: a.sha256 },
      httpPort: await freeFixturePort()
    })
  } catch {
    wrongPort = true
  }
  check(
    'port change is rejected before any confirmation or core operation',
    wrongPort && confirmations === 2
  )
  check(
    'immutable source copies remain unchanged after hot reload',
    (await profiles.read({ id: a.id, sha256: a.sha256 })).text === network.source &&
      (await profiles.read({ id: b.id, sha256: b.sha256 })).text === JSON.stringify(second)
  )
  const invalidSource = JSON.parse(network.source)
  invalidSource.proxies = [
    {
      name: 'Broken',
      type: 'ss',
      server: '127.0.0.1',
      port: port,
      cipher: 'not-a-core-cipher',
      password: 'PRIVATE'
    }
  ]
  invalidSource['proxy-groups'][0].proxies = ['Broken']
  const invalid = await profiles.save('Invalid candidate', JSON.stringify(invalidSource))
  const invalidPlan = await local.prepareReload({
    profile: { id: invalid.id, sha256: invalid.sha256 },
    httpPort: port
  })
  const rejection = await local.reload({ evidenceId: invalidPlan.evidenceId })
  check(
    'real core parse rejection preserves the original live process and marks acknowledgement uncertain',
    rejection.status === 'uncertain' &&
      child.state() === 'running' &&
      child.pid === pid &&
      launches === 1 &&
      local.state().profileId === undefined
  )
  await network.request(port, 'after-rejection')
  check(
    'old running configuration still serves B after rejected candidate, with evidence retained and no restart',
    network.stats().usedB === 2 &&
      (await readdir(directory)).filter((name) => name.startsWith('reload-')).length === 2
  )
  const stopped = await local.action({ action: 'stop', instanceId })
  check(
    'only the test-owned child and lease are cleaned up on explicit fixture stop',
    stopped.status === 'stopped' && (await store.inspect()).lease === 'missing'
  )
} finally {
  held?.destroy()
  await cleanup?.()
  await network.close()
  await rm(home, { recursive: true, force: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  architectureExecuted: process.arch,
  intelRuntimeVerified: false,
  scope: 'controlled-local-projection',
  actualUserNetworkOrSystemConfigurationChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  productionNodesOrClaudeTrafficUsed: false
}
await writeFile(
  '../evidence/owned-reload-verification.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Owned reload contract failed.')
