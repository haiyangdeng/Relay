import { mkdtemp, realpath, lstat, readFile, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { setTimeout as delay } from 'timers/promises'
import { generateAgeKeyPair, encryptAgeContent } from '../../src/main/utils/age'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { SubscriptionSourceStore } from '../../src/main/relay/subscriptions/source-store'
import { createSubscriptionSourceService } from '../../src/main/relay/subscriptions/source-service'
import { createSourceScheduler } from '../../src/main/relay/subscriptions/source-scheduler'
import { sourceOptions } from '../../src/main/relay/subscriptions/source-options'
import { transferSubscriptionSource } from '../../src/main/relay/subscriptions/source-transfer'
import { downloadSubscription } from '../../src/main/relay/subscriptions/transfer'
import type { SubscriptionSourceInfo } from '../../src/shared/relay/subscription-sources'
import { createLocalNetworkFixture } from './fixtures/local-network'
import { createLocalSubscriptionFixture } from './fixtures/local-subscription'

const home = await realpath(await mkdtemp('/private/tmp/relay-subscription-compat-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  profiles = new ProfileStore(context),
  store = new SubscriptionSourceStore(context),
  network = await createLocalNetworkFixture(),
  source = '\ufeff# original yaml\n' + network.source,
  fixture = await createLocalSubscriptionFixture(source),
  keys = await generateAgeKeyPair()
const rows: { name: string; passed: boolean }[] = [],
  check = (name: string, passed: boolean): void => {
    rows.push({ name, passed })
  },
  selected = (s: SubscriptionSourceInfo) => ({ id: s.id, revision: s.revision })
let allow = true,
  manualConfirmations = 0
const service = createSubscriptionSourceService({
    store,
    profiles,
    download: downloadSubscription,
    transfer: transferSubscriptionSource,
    confirm: async () => {
      ++manualConfirmations
      return allow
    }
  }),
  scheduler = createSourceScheduler({
    store,
    canRun: () => !service.isBusy(),
    run: (id, revision) => service.runScheduled(id, revision),
    requestStop: () => service.requestClose(),
    confirm: async () => true
  })
const update = async (s: SubscriptionSourceInfo) => {
  const p = await service.prepareUpdate(selected(s)),
    staged = await service.execute({ evidenceId: p.evidenceId })
  if (!staged.plan) throw new Error('fixture update not staged')
  return service.execute({ evidenceId: staged.plan.evidenceId })
}
try {
  fixture.setHeaders({
    etag: '"v1"',
    'subscription-userinfo': 'upload=10; download=20; total=1000; expire=1900000000',
    'profile-update-interval': '0.1',
    'content-disposition': 'attachment; filename=fixture.yaml',
    'profile-web-page-url': 'https://billing.invalid/PRIVATE'
  })
  const options = {
      ...sourceOptions(undefined),
      headers: { authorization: 'Bearer PRIVATE', 'user-agent': 'Relay fixture' },
      ageSecretKey: keys.secretKey,
      redirects: 'same-origin' as const,
      schedule: { kind: 'interval' as const, minutes: 1 }
    },
    p = service.prepareRegistration({
      name: 'Compatibility fixture',
      url: fixture.url('/redirect-local'),
      proxyPort: fixture.proxyPort,
      options
    }),
    registered = await service.execute({ evidenceId: p.evidenceId })
  if (!registered.source) throw new Error('source fixture absent')
  let current = registered.source
  check(
    'saved advanced credentials remain in private source storage only',
    (await lstat(join(store.directory, current.id, 'source.json'))).mode % 512 === 0o600 &&
      (await readFile(join(store.directory, current.id, 'source.json'), 'utf8')).includes(
        keys.secretKey
      ) &&
      !JSON.stringify(current).includes(keys.secretKey) &&
      !JSON.stringify(current).includes('Bearer PRIVATE')
  )
  check(
    'neither source creation nor scheduler construction starts a request',
    fixture.stats().origins === 0 && scheduler.state().entries.length === 0
  )
  let result = await update(current)
  if (!result.source) throw new Error('first fixture update absent')
  current = result.source
  check(
    'real same-origin redirect keeps the chosen local proxy for every hop',
    fixture.stats().origins === 2 &&
      fixture.stats().forwarded === 2 &&
      fixture.stats().authorizedRequests === 2
  )
  check(
    'whitelisted quota, interval and file metadata are persisted',
    current.observation?.quota?.total === 1000 &&
      current.observation.intervalMinutes === 6 &&
      current.observation.filename === 'fixture.yaml' &&
      current.observation.homeOrigin === 'https://billing.invalid'
  )
  check(
    'first immutable plaintext copy preserves BOM exactly',
    (await profiles.read(current.versions[0].profile)).text === source
  )
  check(
    'full homepage URL is retained privately while the public record exposes only its origin',
    (await store.read(selected(current))).cache?.metadata.homeURL ===
      'https://billing.invalid/PRIVATE' && !JSON.stringify(current).includes('/PRIVATE')
  )
  result = await update(current)
  if (!result.source) throw new Error('conditional fixture observation absent')
  current = result.source
  check(
    'actual conditional request gets 304 from the bound final resource',
    fixture.stats().conditionalRequests === 1 && current.observation?.status === 304
  )
  check(
    '304 observation appends metadata without duplicating configuration',
    (await store.read(selected(current))).recordCount === 2 &&
      current.versions.length === 1 &&
      (await profiles.list()).profiles.length === 1
  )
  const source2 = source + '\n# AGE decrypted revision'
  fixture.setSource(await encryptAgeContent(source2, keys.recipient))
  fixture.setHeaders({ etag: '"v2"', 'subscription-userinfo': 'total=2000' })
  result = await update(current)
  if (!result.source) throw new Error('AGE fixture update absent')
  current = result.source
  check(
    'actual encrypted subscription is decrypted into a private usable configuration',
    current.versions.length === 2 &&
      (await profiles.read(current.versions[1].profile)).text === source2
  )
  check(
    'new response replaces stale optional metadata instead of inventing old quota fields',
    current.observation?.quota?.total === 2000 && current.observation.intervalMinutes === undefined
  )
  check(
    'public source inventory never includes AGE identity, authorization or validators',
    !JSON.stringify(await service.list()).includes(keys.secretKey) &&
      !JSON.stringify(await service.list()).includes('Bearer PRIVATE') &&
      !JSON.stringify(await service.list()).includes('"v2"')
  )
  const beforeTimer = fixture.stats().origins,
    confirmations = manualConfirmations,
    armed = await scheduler.arm(selected(current)),
    source3 = source2 + '\n# scheduled version'
  check(
    'explicit schedule arm does not immediately request the source',
    armed.status === 'armed' && fixture.stats().origins === beforeTimer
  )
  fixture.setSource(source3)
  fixture.setHeaders({ etag: '"v3"' })
  allow = false
  process.stdout.write(
    JSON.stringify({
      stage: 'owned loopback scheduler armed',
      waitSeconds: 60,
      actualSystemConfigurationChanged: false
    }) + '\n'
  )
  const deadline = Date.now() + 70000
  while (Date.now() < deadline && scheduler.state().entries[0]?.lastStatus !== 'saved')
    await delay(100)
  check(
    'real one-minute timer performs an authorized update through the proxy',
    scheduler.state().entries[0]?.lastStatus === 'saved' &&
      fixture.stats().origins === beforeTimer + 2 &&
      fixture.stats().forwarded === fixture.stats().origins
  )
  check(
    'scheduled update needs no new native prompt under its explicit session grant',
    manualConfirmations === confirmations
  )
  current = (await store.readId(current.id)).info
  check(
    'scheduled commit appends one immutable version and retains earlier copies',
    current.versions.length === 3 &&
      (await profiles.list()).profiles.length === 3 &&
      (await profiles.read(current.versions[0].profile)).text === source &&
      (await profiles.read(current.versions[2].profile)).text === source3
  )
  await scheduler.disarm({ id: current.id })
  check(
    'disarm clears the next real timer without touching proxy or core state',
    scheduler.state().entries[0].enabled === false &&
      scheduler.state().entries[0].nextAt === undefined
  )
  const fresh = createSourceScheduler({
    store,
    canRun: () => false,
    run: async () => ({ status: 'cancelled', warnings: [] }),
    requestStop: async () => {},
    confirm: async () => false
  })
  check(
    'new scheduler instance does not restore a previous session grant',
    fresh.state().entries.length === 0
  )
  await fresh.requestClose()
  allow = true
  await fixture.closeProxy()
  const prepare = await service.prepareUpdate(selected(current)),
    beforeFailure = fixture.stats().origins,
    failed = await service.execute({ evidenceId: prepare.evidenceId })
  check(
    'failed selected proxy never falls back direct during compatibility fetch',
    failed.status === 'failed' &&
      fixture.originListening() &&
      fixture.stats().origins === beforeFailure
  )
  check(
    'failed compatibility fetch retains all source versions',
    (await store.read(selected(current))).info.versions.length === 3 &&
      (await profiles.list()).profiles.length === 3
  )
} finally {
  await scheduler.requestClose()
  await service.requestClose()
  service.clear()
  await fixture.close()
  await network.close()
  await rm(home, { recursive: true, force: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  scope: 'fake HOME, owned loopback redirects/304/AGE and a real 60-second local-only scheduler',
  architectureExecuted: process.arch,
  intelRuntimeVerified: process.arch === 'x64',
  actualConditional304AGEAndRealTimerVerified: true,
  actualCrossOriginHTTPSVerified: false,
  actualPublicInternetOrGUIVerified: false,
  actualSystemProxyDNSOrTUNChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  actualUserClientConfigurationChanged: false,
  appOrBrowserLaunched: false,
  productionSubscriptionScheduleEnabled: false,
  liveNoDirectGuardVerified: false
}
await writeFile(
  '../evidence/subscription-compat-runtime-contract.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Subscription compatibility contract failed')
