import { mkdtemp, realpath, readFile, writeFile, rm, lstat } from 'fs/promises'
import { join, resolve } from 'path'
import { setTimeout as delay } from 'timers/promises'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { SubscriptionSourceStore } from '../../src/main/relay/subscriptions/source-store'
import { createSubscriptionSourceService } from '../../src/main/relay/subscriptions/source-service'
import { downloadSubscription } from '../../src/main/relay/subscriptions/transfer'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import type {
  SubscriptionSourceInfo,
  SubscriptionSourcePlan
} from '../../src/shared/relay/subscription-sources'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'
import { createLocalSubscriptionFixture } from './fixtures/local-subscription'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture result')
  return value
}
const home = await realpath(await mkdtemp('/private/tmp/relay-sources-contract-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  profiles = new ProfileStore(context),
  journal = new SubscriptionSourceStore(context),
  network = await createLocalNetworkFixture(),
  source = '\ufeff# first original\n' + network.source,
  next = JSON.parse(network.source)
next['proxy-groups'][0].proxies.reverse()
const source2 = '# second original\n' + JSON.stringify(next),
  fixture = await createLocalSubscriptionFixture(source)
let allow = false,
  cleanupOwn: (() => Promise<void>) | undefined
const adapter = {
    store: journal,
    profiles,
    download: downloadSubscription,
    confirm: async (_p: SubscriptionSourcePlan) => allow
  },
  service = createSubscriptionSourceService(adapter),
  rows: { name: string; passed: boolean }[] = [],
  check = (name: string, passed: boolean): void => {
    rows.push({ name, passed })
  },
  select = (s: SubscriptionSourceInfo) => ({ id: s.id, revision: s.revision }),
  until = async (predicate: () => boolean): Promise<boolean> => {
    for (let n = 0; n < 100; n++) {
      if (predicate()) return true
      await delay(20)
    }
    return false
  }
const register = async (name: string, path = '/snapshot'): Promise<SubscriptionSourceInfo> => {
  const p = service.prepareRegistration({
      name,
      url: fixture.url(path),
      proxyPort: fixture.proxyPort
    }),
    r = await service.execute({ evidenceId: p.evidenceId })
  if (!r.source) throw new Error('fixture source not registered')
  return r.source
}
const download = async (s: SubscriptionSourceInfo) => {
  const p = await service.prepareUpdate(select(s))
  return service.execute({ evidenceId: p.evidenceId })
}
try {
  check(
    'construction and empty listing make no request or directory',
    (await service.list()).sources.length === 0 && fixture.stats().origins === 0
  )
  let absent = false
  try {
    await lstat(journal.directory)
  } catch (error) {
    absent = (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  check('empty source directory remains absent', absent)
  const cancelled = service.prepareRegistration({
    name: 'Subscription fixture',
    url: fixture.url(),
    proxyPort: fixture.proxyPort
  })
  check(
    'registration defaults to cancellation without persistent secrets',
    (await service.execute({ evidenceId: cancelled.evidenceId })).status === 'cancelled' &&
      (await journal.list()).sources.length === 0
  )
  allow = true
  let current = await register('Subscription fixture')
  const sourcePath = join(journal.directory, current.id, 'source.json'),
    sourceBytes = await readFile(sourcePath, 'utf8')
  check(
    'saved origin is private while public list excludes token and path',
    (await lstat(sourcePath)).mode % 512 === 0o600 &&
      !JSON.stringify(await service.list()).includes('PRIVATE') &&
      sourceBytes.includes('PRIVATE')
  )
  check(
    'source persistence survives a new store instance without requesting the URL',
    (await new SubscriptionSourceStore(context).read(select(current))).request.url ===
      fixture.url() && fixture.stats().origins === 0
  )
  allow = false
  let p = await service.prepareUpdate(select(current))
  check(
    'update defaults to cancellation before request',
    (await service.execute({ evidenceId: p.evidenceId })).status === 'cancelled' &&
      fixture.stats().origins === 0
  )
  allow = true
  let staged = await download(current)
  check(
    'real HTTP download is staged through the stored local proxy only',
    staged.status === 'staged' &&
      !!staged.plan &&
      fixture.stats().forwarded === 1 &&
      fixture.stats().origins === 1
  )
  check(
    'download does not write or advance versions',
    (await profiles.list()).profiles.length === 0 &&
      (await journal.read(select(current))).info.versions.length === 0
  )
  allow = false
  check(
    'separate save cancellation preserves version head',
    (await service.execute({ evidenceId: required(staged.plan).evidenceId })).status ===
      'cancelled' && (await profiles.list()).profiles.length === 0
  )
  allow = true
  staged = await download(current)
  let saved = await service.execute({ evidenceId: required(staged.plan).evidenceId })
  check(
    'confirmed commit publishes one immutable version',
    saved.status === 'saved' && saved.source?.versions.length === 1
  )
  if (!saved.source) throw new Error('fixture commit absent')
  current = saved.source
  const first = current.versions[0],
    firstText = await profiles.read(first.profile)
  check('first version preserves exact source bytes including BOM', firstText.text === source)
  check(
    'a new service reconstructs the persisted public version inventory',
    (
      await createSubscriptionSourceService({
        ...adapter,
        store: new SubscriptionSourceStore(context)
      }).list()
    ).sources[0]?.versions[0].profile.id === first.profile.id
  )
  const beforeIdentical = fixture.stats().origins
  check(
    'same body performs one request but adds no duplicate profile',
    (await download(current)).status === 'unchanged' &&
      fixture.stats().origins === beforeIdentical + 1 &&
      (await profiles.list()).profiles.length === 1
  )
  p = await service.prepareUpdate(select(current))
  await writeFile(
    sourcePath,
    JSON.stringify({ ...JSON.parse(sourceBytes), name: 'Changed fixture' })
  )
  const beforeChanged = fixture.stats().origins
  check(
    'changed stored origin invalidates proof before any request',
    (await service.execute({ evidenceId: p.evidenceId })).status === 'failed' &&
      fixture.stats().origins === beforeChanged
  )
  await writeFile(sourcePath, sourceBytes)
  fixture.setSource(source2)
  staged = await download(current)
  saved = await service.execute({ evidenceId: required(staged.plan).evidenceId })
  if (!saved.source) throw new Error('second fixture commit absent')
  current = saved.source
  const second = required(current.versions.at(-1))
  check(
    'new body appends a second profile and leaves prior bytes exact',
    current.versions.length === 2 &&
      (await profiles.list()).profiles.length === 2 &&
      (await profiles.read(first.profile)).text === source &&
      (await profiles.read(second.profile)).text === source2
  )
  p = await service.prepareRestore({ source: select(current), versionId: first.id })
  allow = false
  check(
    'historical selection defaults to cancellation',
    (await service.execute({ evidenceId: p.evidenceId })).status === 'cancelled' &&
      (await journal.read(select(current))).info.versions.length === 2
  )
  allow = true
  p = await service.prepareRestore({ source: select(current), versionId: first.id })
  saved = await service.execute({ evidenceId: p.evidenceId })
  if (!saved.source) throw new Error('restore fixture commit absent')
  current = saved.source
  check(
    'restore appends a linked selection and creates no replacement profile',
    current.versions.length === 3 &&
      current.versions[2].restoredFrom === first.id &&
      current.versions[2].profile.id === first.profile.id &&
      (await profiles.list()).profiles.length === 2
  )
  for (const [label, version, node] of [
    ['new', second, 'B'],
    ['restored', current.versions[2], 'A']
  ] as const) {
    const text = (await profiles.read(version.profile)).text,
      port = await freeFixturePort(),
      before = network.stats(),
      core = await startLocalProxyCore(resolve('extra/relay/core'), text, port, (stop) => {
        cleanupOwn = stop
      }),
      reply = await network.request(port, 'source-' + label),
      after = network.stats()
    check(
      label + ' version produces actual pinned-core traffic through its chosen node',
      reply.includes('origin:/source-' + label) &&
        (node === 'B' ? after.usedB === before.usedB + 1 : after.usedA === before.usedA + 1)
    )
    await core.stop()
    check(label + ' test core stops only its owned child', core.state() === 'stopped')
  }
  const slow = await register('Slow fixture', '/slow')
  p = await service.prepareUpdate(select(slow))
  const pending = service.execute({ evidenceId: p.evidenceId })
  check(
    'slow update starts through the selected proxy',
    await until(() => fixture.stats().slowStarted === 1)
  )
  check(
    'cancellation only targets the current source request',
    service.cancel({ evidenceId: p.evidenceId }).status === 'requested'
  )
  check(
    'actual request abort closes its socket without committing',
    (await pending).status === 'cancelled' &&
      (await until(() => fixture.stats().slowClosed === 1)) &&
      (await journal.read(select(slow))).info.versions.length === 0
  )
  await fixture.closeProxy()
  const beforeFailure = fixture.stats().origins,
    result = await download(current)
  check(
    'chosen proxy failure never contacts the still-running origin directly',
    result.status === 'failed' &&
      fixture.originListening() &&
      fixture.stats().origins === beforeFailure
  )
  check(
    'failed update leaves the current version and all prior profiles intact',
    (await journal.read(select(current))).info.versions.length === 3 &&
      (await profiles.list()).profiles.length === 2 &&
      (await profiles.read(first.profile)).text === source
  )
  check(
    'source URL bytes remain unchanged and tests never activate a user configuration',
    (await readFile(sourcePath, 'utf8')) === sourceBytes &&
      (await profiles.list()).activeId === null
  )
} finally {
  await service.requestClose()
  service.clear()
  await cleanupOwn?.()
  await fixture.close()
  await network.close()
  await rm(home, { recursive: true, force: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  scope:
    'fake HOME, owned loopback HTTP subscription, private origin/version journal and pinned ARM core traffic',
  architectureExecuted: process.arch,
  intelRuntimeVerified: process.arch === 'x64',
  actualStoredSourceManualUpdateAndRestoreVerified: true,
  actualPublicInternetOrGUIVerified: false,
  actualSystemProxyDNSOrTUNChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  actualUserClientConfigurationChanged: false,
  appOrBrowserLaunched: false,
  liveNoDirectGuardVerified: false
}
await writeFile(
  '../evidence/source-update-runtime-contract.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Subscription source contract failed')
