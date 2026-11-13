import { mkdtemp, realpath, readFile, writeFile, rm, lstat } from 'fs/promises'
import { join, resolve } from 'path'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { CoreStore } from '../../src/main/relay/core/store'
import { createLocalProxyService } from '../../src/main/relay/core/local-proxy-service'
import {
  localProxyConfiguration,
  startLocalProxyCore
} from '../../src/main/relay/core/local-proxy-runtime'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { probeLocalPort } from '../../src/main/relay/core/port'
import { freeFixturePort } from './fixtures/local-network'
import { createLocalDNSFixture } from './fixtures/local-dns'

const root = resolve('extra/relay/core'),
  home = await realpath(await mkdtemp('/private/tmp/relay-dns-contract-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  profiles = new ProfileStore(context),
  store = new CoreStore(context),
  fixture = await createLocalDNSFixture()
const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
let confirmed = false,
  starts = 0,
  cleanupConfirmed = false
const service = createLocalProxyService({
  read: (selection) => profiles.read(selection),
  inspect: () => store.inspect(),
  resources: () => verifyCoreResource(root),
  portAvailable: probeLocalPort,
  acquire: (runtime, revision) => store.acquire('rule', revision, runtime),
  start: (source, port, register, mode) => {
    ++starts
    return startLocalProxyCore(root, source, port, register, mode)
  },
  confirmStart: async () => confirmed,
  confirmStop: async () => confirmed
})
try {
  const profile = await profiles.save('DNS fixture', fixture.source),
    selection = { id: profile.id, sha256: profile.sha256 },
    port = await freeFixturePort(),
    sourceFile = join(profiles.directory, profile.id, 'profile.yaml'),
    sourceBefore = await readFile(sourceFile)
  const disabled = JSON.parse(localProxyConfiguration(fixture.source, port).configuration)
  check(
    'existing manual proxy mode keeps profile DNS disabled by default',
    disabled.dns.enable === false && Object.keys(disabled.hosts).length === 0
  )
  const built = localProxyConfiguration(fixture.source, port, 'profile'),
    generated = JSON.parse(built.configuration),
    original = JSON.parse(fixture.source)
  check(
    'original resolver addresses and domain policies remain unchanged in generated config',
    JSON.stringify(generated.dns.nameserver) === JSON.stringify(original.dns.nameserver) &&
      JSON.stringify(generated.dns['nameserver-policy']) ===
        JSON.stringify(original.dns['nameserver-policy']) &&
      JSON.stringify(generated.dns['proxy-server-nameserver']) ===
        JSON.stringify(original.dns['proxy-server-nameserver'])
  )
  check(
    'only the owned HTTP port is opened and original DNS listen is suppressed',
    generated.dns.listen === '' && !generated.tun.enable && built.resolution.listenerSuppressed
  )
  const prepare = () =>
    service.prepare({ profile: selection, httpPort: port, resolverMode: 'profile' })
  let plan = await prepare()
  check(
    'explicit DNS preparation is ready without starting or querying any resolver',
    plan.canStart &&
      plan.resolution?.enabled === true &&
      starts === 0 &&
      fixture.mainQueries.length === 0 &&
      fixture.nodeQueries.length === 0 &&
      fixture.policyQueries.length === 0
  )
  check(
    'default cancellation does not start or persist an owned instance',
    (await service.action({ action: 'start', evidenceId: plan.evidenceId })).status ===
      'cancelled' &&
      starts === 0 &&
      (await store.inspect()).lease === 'missing'
  )
  plan = await prepare()
  confirmed = true
  const started = await service.action({ action: 'start', evidenceId: plan.evidenceId })
  check(
    'owned core actually starts with the explicit profile resolver mode',
    started.status === 'started' &&
      started.state.traffic === 'listening' &&
      started.state.resolution?.enabled === true
  )
  if (started.status !== 'started' || !started.state.instanceId)
    throw new Error('fixture DNS start failed')
  const record = JSON.parse(await readFile(join(store.directory, '.session/owner.json'), 'utf8'))
  check(
    'private session record binds the resolver mode and source',
    record.runtime.resolverMode === 'profile' &&
      record.runtime.sourceSHA256 === profile.sha256 &&
      ((await lstat(join(store.directory, '.session/owner.json'))).mode & 0o7777) === 0o600
  )
  const main = await fixture.request(port, 'one.main.relay.test', 'main')
  check(
    'unmatched hostname is really resolved by the configured main DNS fixture',
    main.includes('origin:/main') &&
      fixture.mainQueries.includes('one.main.relay.test') &&
      fixture.policyQueries.length === 0
  )
  const policy = await fixture.request(port, 'one.policy.relay.test', 'policy')
  check(
    'matching hostname is really resolved by the configured DoH policy',
    policy.includes('origin:/policy') && fixture.policyQueries.includes('one.policy.relay.test')
  )
  check('DoH query really traverses its declared proxy group', fixture.stats().proxyDNS >= 1)
  check(
    'domain-based proxy node uses its independent node resolver',
    fixture.nodeQueries.includes('relay-node.test') &&
      !fixture.mainQueries.includes('relay-node.test')
  )
  check(
    'policy hostname is not queried through the main resolver',
    !fixture.mainQueries.includes('one.policy.relay.test')
  )
  const beforeHosts =
    fixture.mainQueries.length + fixture.nodeQueries.length + fixture.policyQueries.length
  const hosts = await fixture.request(port, 'static.relay.test', 'hosts')
  check(
    'hosts mapping reaches the fixture origin without a DNS query',
    hosts.includes('origin:/hosts') &&
      beforeHosts ===
        fixture.mainQueries.length + fixture.nodeQueries.length + fixture.policyQueries.length
  )
  check(
    'original occupied DNS-listen fixture remains running and is not taken over',
    fixture.listener.listening
  )
  confirmed = false
  check(
    'cancelled close keeps the DNS-configured proxy instance',
    (await service.requestClose()) === 'cancelled' && service.state().traffic === 'listening'
  )
  const afterCancel = await fixture.request(port, 'two.policy.relay.test', 'after-cancel')
  check(
    'DNS policy still serves fresh names after cancelled close',
    afterCancel.includes('origin:/after-cancel') &&
      fixture.policyQueries.includes('two.policy.relay.test')
  )
  await fixture.closeDoh()
  const beforeFailure = fixture.stats().origins
  let failed = false
  try {
    failed = !(await fixture.request(port, 'unavailable.policy.relay.test', 'must-fail')).includes(
      'origin:/must-fail'
    )
  } catch {
    failed = true
  }
  check(
    'failed policy endpoint does not fall back to main DNS or reach the origin',
    failed &&
      fixture.stats().origins === beforeFailure &&
      !fixture.mainQueries.includes('unavailable.policy.relay.test')
  )
  check(
    'saved source including its custom DNS is byte-identical after actual queries',
    sourceBefore.equals(await readFile(sourceFile))
  )
  confirmed = true
  check(
    'explicit confirmed stop closes the owned instance',
    (await service.action({ action: 'stop', instanceId: started.state.instanceId })).status ===
      'stopped'
  )
  check(
    'owned journal and HTTP listener are released without taking the original listener',
    (await store.inspect()).lease === 'missing' &&
      (await probeLocalPort(port)) &&
      fixture.listener.listening
  )
} finally {
  confirmed = true
  const closed = await service.requestClose()
  await fixture.close()
  cleanupConfirmed = closed === 'closed'
  if (cleanupConfirmed) await rm(home, { recursive: true })
}
if (!cleanupConfirmed)
  throw new Error('owned DNS fixture core cleanup unconfirmed; retained test HOME')
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  actualOwnedCoreDNSAndHostsVerifiedOnLoopback: true,
  actualDNSPolicyProxyGroupAndIndependentNodeResolutionVerified: true,
  actualSystemDNSProxyOrTUNChanged: false,
  currentClashStoppedReloadedOrRestarted: false,
  actualUserConfigurationChanged: false,
  internetOrClaudeTrafficVerified: false,
  liveNoDirectGuardVerified: false,
  architectureExecuted: process.arch,
  intelRuntimeVerified: process.arch === 'x64',
  appOrBrowserLaunched: false
}
await writeFile(
  '../evidence/local-dns-runtime-contract.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.passed !== report.checks) throw new Error('Local DNS runtime contract failed')
