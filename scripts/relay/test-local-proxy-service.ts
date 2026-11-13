import { createServer } from 'net'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { CoreStore } from '../../src/main/relay/core/store'
import { createLocalProxyService } from '../../src/main/relay/core/local-proxy-service'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { probeLocalPort } from '../../src/main/relay/core/port'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import {
  createLocalNetworkFixture,
  freeFixturePort,
  fixturePort,
  closeFixture
} from './fixtures/local-network'

const home = await realpath(await mkdtemp('/private/tmp/relay-proxy-service-')),
  root = resolve('extra/relay/core')
const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
const profiles = new ProfileStore(context),
  core = new CoreStore(context),
  network = await createLocalNetworkFixture()
const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
let startConfirmed = false,
  stopConfirmed = false,
  started = 0
const service = createLocalProxyService({
  read: (value) => profiles.read(value),
  inspect: () => core.inspect(),
  resources: () => verifyCoreResource(root),
  portAvailable: probeLocalPort,
  acquire: (runtime, revision) => core.acquire('rule', revision, runtime),
  start: (source, port, register) => {
    ++started
    return startLocalProxyCore(root, source, port, register)
  },
  confirmStart: async () => startConfirmed,
  confirmStop: async () => stopConfirmed
})
const blocker = createServer((socket) => socket.destroy())
try {
  const saved = await profiles.save('Loopback fixture', network.source)
  const selection = { id: saved.id, sha256: saved.sha256 },
    port = await freeFixturePort()
  const sourcePath = join(profiles.directory, saved.id, 'profile.yaml'),
    beforeSource = await readFile(sourcePath)
  const plan = await service.prepare({ profile: selection, httpPort: port })
  check(
    'preparation probes an unused port but does not start',
    plan.canStart && started === 0 && (await probeLocalPort(port))
  )
  let missing = false
  try {
    await lstat(core.directory)
  } catch (error) {
    missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  check('preparation does not create a Core journal', missing)
  check(
    'default cancellation does not acquire a core or start traffic',
    (await service.action({ action: 'start', evidenceId: plan.evidenceId })).status ===
      'cancelled' && started === 0
  )
  startConfirmed = true
  const running = await service.action({ action: 'start', evidenceId: plan.evidenceId })
  check(
    'real owned service reaches a loopback listening state',
    running.status === 'started' && running.state.traffic === 'listening' && running.state.owned
  )
  const id = running.state.instanceId
  if (!id) throw new Error('owned instance missing')
  const record = JSON.parse(await readFile(join(core.directory, '.session/owner.json'), 'utf8'))
  check(
    'durable record identifies only this runtime/profile/port',
    record.phase === 'running' &&
      record.runtime.kind === 'localProxy' &&
      record.runtime.httpPort === port &&
      record.runtime.profileId === saved.id &&
      record.runtime.sourceSHA256 === saved.sha256
  )
  check(
    'real group state confirms declared members',
    running.state.groups[0].name === network.group &&
      running.state.groups[0].now === 'NodeA' &&
      running.state.groups[0].confirmed
  )
  const a = await network.request(port, 'service-A')
  check(
    'actual manual HTTP request uses proxy A',
    a.includes('origin:/service-A') && network.stats().usedA === 1 && network.stats().usedB === 0
  )
  const switched = await service.action({
    action: 'select',
    instanceId: id,
    group: network.group,
    member: 'NodeB'
  })
  check(
    'encoded Unicode/slash group switch is confirmed',
    switched.status === 'selected' && switched.state.groups[0].now === 'NodeB'
  )
  const b = await network.request(port, 'service-B')
  check(
    'new connection follows confirmed proxy B choice',
    b.includes('origin:/service-B') && network.stats().usedB === 1
  )
  let staleBlocked = false
  try {
    await service.action({ action: 'stop', instanceId: '00000000-0000-0000-0000-000000000001' })
  } catch {
    staleBlocked = true
  }
  check(
    'stale instance cannot stop this live core',
    staleBlocked && service.state().traffic === 'listening'
  )
  const cancelled = await service.action({ action: 'stop', instanceId: id })
  check(
    'cancelled stop keeps the core running and serving requests',
    cancelled.status === 'cancelled' &&
      (await network.request(port, 'after-cancel')).includes('origin:/after-cancel')
  )
  check(
    'cancelled quit preserves this active proxy',
    (await service.requestClose()) === 'cancelled' &&
      service.state().owned &&
      service.state().traffic === 'listening'
  )
  const invalid = await service.action({
    action: 'select',
    instanceId: id,
    group: network.group,
    member: 'DIRECT'
  })
  const refreshed = await service.action({ action: 'refresh', instanceId: id })
  check(
    'unlisted member is not selected and refresh confirms real state',
    invalid.status === 'unconfirmed' && refreshed.state.groups[0].now === 'NodeB'
  )
  check(
    'source bytes and original DNS settings remain unchanged',
    (await readFile(sourcePath)).equals(beforeSource)
  )
  stopConfirmed = true
  check(
    'confirmed owned stop releases process, port and journal',
    (await service.action({ action: 'stop', instanceId: id })).status === 'stopped' &&
      (await core.inspect()).lease === 'missing' &&
      (await probeLocalPort(port))
  )
  check(
    'repeated stopped-instance request is harmless',
    (await service.action({ action: 'stop', instanceId: id })).status === 'stopped'
  )
  const racePort = await freeFixturePort(),
    racePlan = await service.prepare({ profile: selection, httpPort: racePort })
  await fixturePort(blocker, racePort)
  const failed = await service.action({ action: 'start', evidenceId: racePlan.evidenceId })
  check(
    'port taken after preparation is never stolen or treated as this core',
    failed.status === 'failed' &&
      !failed.state.owned &&
      blocker.listening &&
      (await core.inspect()).lease === 'missing'
  )
  const occupied = await service.prepare({ profile: selection, httpPort: racePort })
  check('occupied-port preparation blocks further start', !occupied.canStart && blocker.listening)
  check(
    'all successful owned stops permit normal close',
    (await service.requestClose()) === 'closed'
  )
} finally {
  stopConfirmed = true
  await cleanup()
}
async function cleanup(): Promise<void> {
  if ((await service.requestClose()) !== 'closed')
    throw new Error('Owned local test cleanup unconfirmed; fixture preserved.')
  await closeFixture(blocker)
  await network.close()
  await rm(home, { recursive: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  fakeHomeOnly: true,
  loopbackOriginAndProxyFixturesOnly: true,
  actualOwnedHTTPForwardingVerified: true,
  actualGroupSelectionVerified: true,
  coreJournalAndSourcePreservationVerified: true,
  actualSystemProxyDNSOrTUNChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  actualUserClientConfigurationChanged: false,
  appOrBrowserLaunched: false,
  fullSourceDNSApplied: false,
  realInternetOrClaudeTrafficVerified: false,
  liveNoDirectGuardVerified: false,
  architectureExecuted: process.arch,
  intelRuntimeVerified: process.arch === 'x64'
}
await writeFile(
  '../evidence/local-proxy-service-contract.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Local proxy service contract failed.')
