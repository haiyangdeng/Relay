import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, realpath, readFile, rm, writeFile, lstat, readdir } from 'fs/promises'
import { join, resolve } from 'path'
import { setTimeout as delay } from 'timers/promises'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { createSubscriptionService } from '../../src/main/relay/subscriptions/service'
import {
  downloadSubscription,
  SubscriptionTransferError
} from '../../src/main/relay/subscriptions/transfer'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import { compileProfileRuntime } from '../../src/main/relay/profiles/runtime'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'
import { createLocalSubscriptionFixture } from './fixtures/local-subscription'

const exec = promisify(execFile),
  home = await realpath(await mkdtemp('/private/tmp/relay-subscription-contract-'))
const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  profiles = new ProfileStore(context),
  network = await createLocalNetworkFixture()
const source = '\ufeff# PRIVATE fixture\n' + network.source,
  fixture = await createLocalSubscriptionFixture(source)
const rows: { name: string; passed: boolean }[] = [],
  check = (name: string, passed: boolean): void => {
    rows.push({ name, passed })
  }
let confirmDownload = false,
  confirmSave = false,
  downloads = 0,
  saves = 0
const service = createSubscriptionService({
  download: (url, port, signal) => {
    ++downloads
    return downloadSubscription(url, port, signal)
  },
  confirmDownload: async () => confirmDownload,
  confirmSave: async () => confirmSave,
  save: (name, text) => {
    ++saves
    return profiles.save(name, text)
  }
})
const plan = (path = '/snapshot') =>
  service.prepare({
    name: 'Fixture snapshot',
    url: fixture.url(path),
    proxyPort: fixture.proxyPort
  })
const until = async (predicate: () => boolean): Promise<boolean> => {
  const deadline = performance.now() + 3000
  while (!predicate() && performance.now() < deadline) await delay(10)
  return predicate()
}
let cleanupCore: (() => Promise<void>) | undefined
try {
  let prep = plan()
  check(
    'preparation redacts URL credentials and performs no network or filesystem write',
    !JSON.stringify(prep).includes('PRIVATE') &&
      downloads === 0 &&
      saves === 0 &&
      fixture.stats().origins === 0
  )
  check(
    'default cancellation sends no request',
    (await service.download({ evidenceId: prep.evidenceId })).status === 'cancelled' &&
      downloads === 0
  )
  confirmDownload = true
  prep = plan()
  const downloaded = await service.download({ evidenceId: prep.evidenceId })
  check(
    'actual HTTP subscription request goes through the explicit fixture proxy',
    downloaded.status === 'downloaded' &&
      fixture.stats().forwarded === 1 &&
      fixture.stats().origins === 1
  )
  if (!downloaded.profile) throw new Error('fixture snapshot report missing')
  check(
    'downloaded public result contains only inspection, size and digest',
    !JSON.stringify(downloaded).includes('PRIVATE') &&
      downloaded.profile.bytes === Buffer.byteLength(source) &&
      saves === 0
  )
  check(
    'save cancellation does not persist the downloaded snapshot',
    (await service.save({ evidenceId: downloaded.profile.evidenceId })).status === 'cancelled' &&
      (await profiles.list()).profiles.length === 0
  )
  confirmSave = true
  const saved = await service.save({ evidenceId: downloaded.profile.evidenceId })
  check(
    'explicit second confirmation saves one private inactive snapshot',
    saved.status === 'saved' && saves === 1 && (await profiles.list()).activeId === null
  )
  if (!saved.profile) throw new Error('fixture snapshot save missing')
  const directory = join(profiles.directory, saved.profile.id),
    file = join(directory, 'profile.yaml'),
    metadata = await readFile(join(directory, 'metadata.json'), 'utf8')
  check(
    'accepted source bytes including BOM and custom DNS are preserved exactly',
    (await readFile(file)).equals(Buffer.from(source))
  )
  check(
    'source and metadata remain private and URL is not persisted',
    ((await lstat(file)).mode & 0o7777) === 0o600 &&
      ((await lstat(join(directory, 'metadata.json'))).mode & 0o7777) === 0o600 &&
      ((await lstat(directory)).mode & 0o7777) === 0o700 &&
      !metadata.includes(fixture.url()) &&
      !metadata.includes('PRIVATE') &&
      (await readdir(directory)).sort().join(',') === 'metadata.json,profile.yaml'
  )
  let repeated = false
  try {
    await service.save({ evidenceId: downloaded.profile.evidenceId })
  } catch {
    repeated = true
  }
  check(
    'saved proof cannot replay another write or request',
    repeated && saves === 1 && downloads === 1
  )
  // End-to-end: the imported snapshot can be explicitly compiled and run by
  // this product's owned core. No client/system proxy is changed.
  const port = await freeFixturePort(),
    core = await startLocalProxyCore(resolve('extra/relay/core'), source, port, (stop) => {
      cleanupCore = stop
    })
  const response = await network.request(port, 'imported-snapshot')
  check(
    'imported snapshot works through an explicitly started owned core and its declared node',
    response.includes('origin:/imported-snapshot') && network.stats().usedA === 1
  )
  await core.stop()
  for (const [path, expected] of [
    ['/redirect', 'failed'],
    ['/unauthorized', 'failed'],
    ['/oversize', 'failed'],
    ['/gzip', 'failed'],
    ['/invalid', 'failed'],
    ['/html', 'rejected']
  ]) {
    const before = fixture.stats().forwarded,
      p = plan(path),
      result = await service.download({ evidenceId: p.evidenceId })
    check(
      path + ' is refused with exactly one proxy request and no save',
      result.status === expected &&
        fixture.stats().forwarded === before + 1 &&
        !service.state().stagedId &&
        saves === 1 &&
        !JSON.stringify(result).includes('PRIVATE')
    )
  }
  const provider = plan('/provider'),
    providerResult = await service.download({ evidenceId: provider.evidenceId })
  check(
    'provider declarations are inspected without fetching nested provider URLs',
    providerResult.profile?.inspection.summary?.proxyProviders === 1 &&
      compileProfileRuntime(
        'proxy-providers: {P: {type: http, url: "https://must-not-fetch.invalid/PRIVATE"}}'
      ).configuration === undefined
  )
  const slow = plan('/slow'),
    slowResult = service.download({ evidenceId: slow.evidenceId })
  check(
    'fixture receives the explicitly started pending request',
    await until(() => fixture.stats().slowStarted === 1)
  )
  check(
    'explicit cancel targets only that pending request',
    service.cancel({ evidenceId: slow.evidenceId }).status === 'requested'
  )
  check(
    'cancelled transfer closes the fixture connection and does not save',
    (await slowResult).status === 'cancelled' &&
      (await until(() => fixture.stats().slowClosed === 1)) &&
      saves === 1
  )
  let certificateRejected = false
  try {
    await downloadSubscription(fixture.secureURL, fixture.proxyPort, new AbortController().signal)
  } catch (error) {
    certificateRejected = error instanceof SubscriptionTransferError && error.reason === 'transport'
  }
  check(
    'untrusted HTTPS certificate is actually rejected after a proxy CONNECT',
    certificateRejected && fixture.stats().tunnels >= 1 && fixture.stats().tlsRequests === 0
  )
  const tunnelsBefore = fixture.stats().tunnels
  const child = await exec(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/relay/subscription-tls-client.ts',
      String(fixture.proxyPort),
      fixture.secureURL
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: fixture.certificate,
        NODE_TLS_REJECT_UNAUTHORIZED: '1'
      },
      timeout: 20000,
      maxBuffer: 8192
    }
  )
  check(
    'HTTPS succeeds through CONNECT when only an isolated child trusts the fixture CA',
    JSON.parse(child.stdout).accepted === true &&
      fixture.stats().tlsRequests === 1 &&
      fixture.stats().tunnels === tunnelsBefore + 1
  )
  const before = fixture.stats().origins
  await fixture.closeProxy()
  let failed = false
  try {
    await downloadSubscription(fixture.url(), fixture.proxyPort, new AbortController().signal)
  } catch {
    failed = true
  }
  check(
    'unavailable chosen proxy fails without a direct request to the still-running origin',
    failed && fixture.originListening() && fixture.stats().origins === before
  )
  check(
    'only the saved immutable snapshot exists after failed and cancelled transfers',
    (await profiles.list()).profiles.length === 1
  )
} finally {
  await service.requestClose()
  service.clear()
  await cleanupCore?.()
  await Promise.all([fixture.close(), network.close()])
  await rm(home, { recursive: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  actualHTTPProxyTransferAndPrivateSnapshotVerified: true,
  importedSnapshotOwnedCoreTrafficVerified: true,
  actualUntrustedCertificateRejectionAndIsolatedCAChildSuccessVerified: true,
  actualProxyFailureWithoutDirectFallbackObserved: true,
  realExternalSubscriptionOrProviderFetched: false,
  currentSystemProxyDNSOrTUNChanged: false,
  currentClashStoppedReloadedOrRestarted: false,
  realUserConfigurationChanged: false,
  globalOrSystemCertificateTrustChanged: false,
  appOrBrowserLaunched: false,
  intelRuntimeVerified: false,
  architectureExecuted: process.arch
}
await writeFile(
  '../evidence/subscription-runtime-contract.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Subscription runtime contract failed')
