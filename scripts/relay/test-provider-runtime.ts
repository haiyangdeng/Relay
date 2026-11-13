import { mkdtemp, realpath, readFile, writeFile, rm, lstat } from 'fs/promises'
import { join, resolve } from 'path'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { createProviderService } from '../../src/main/relay/providers/service'
import { analyzeProfile } from '../../src/main/relay/profiles/inspect'
import { pickProfileSource } from '../../src/main/relay/profiles/source'
import { downloadSubscription } from '../../src/main/relay/subscriptions/transfer'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import type { RelayProfileSelection } from '../../src/shared/relay/runtime'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'
import { createLocalSubscriptionFixture } from './fixtures/local-subscription'

const home = await realpath(await mkdtemp('/private/tmp/relay-provider-contract-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  profiles = new ProfileStore(context),
  cache = new ProfileStore(context, 'ProviderResources'),
  network = await createLocalNetworkFixture()
const nodes = JSON.parse(network.source).proxies as Record<string, unknown>[],
  inline = { ...nodes[0], name: 'Inline A' },
  local = { ...nodes[1], name: 'Local B' },
  remote = { ...nodes[0], name: 'Remote A' },
  resource = JSON.stringify({ proxies: [remote] }),
  fixture = await createLocalSubscriptionFixture(resource),
  localPath = join(home, 'selected-provider.yaml'),
  forbiddenPath = join(home, 'original-path-must-not-be-read.yaml'),
  group = 'Providers / 测试'
const source = JSON.stringify({
  dns: { enable: true, nameserver: ['10.0.0.53'] },
  tun: { enable: true },
  'proxy-providers': {
    I: { type: 'inline', payload: [inline] },
    F: { type: 'file', path: forbiddenPath },
    H: {
      type: 'http',
      url: fixture.url(),
      path: forbiddenPath,
      proxy: 'DIRECT',
      interval: 1,
      header: { Authorization: ['Bearer PRIVATE'] },
      'health-check': { enable: false, url: network.healthURL, interval: 1 },
      payload: [{ ...remote, name: 'Fallback must not be used' }]
    }
  },
  'proxy-groups': [{ name: group, type: 'select', use: ['I', 'F', 'H'] }],
  rules: ['MATCH,' + group]
})
const rows: { name: string; passed: boolean }[] = [],
  check = (name: string, passed: boolean): void => {
    rows.push({ name, passed })
  }
let confirmAcquire = false,
  confirmSnapshot = false,
  downloads = 0,
  picks = 0,
  cleanupOwn: (() => Promise<void>) | undefined
const service = createProviderService({
  read: (selection) => profiles.read(selection),
  cache,
  save: (name, text) => profiles.save(name, text),
  pick: async () => {
    ++picks
    return pickProfileSource(localPath)
  },
  download: (url, port, signal, headers, limit) => {
    ++downloads
    return downloadSubscription(url, port, signal, headers, limit)
  },
  confirmAcquire: async () => confirmAcquire,
  confirmSnapshot: async () => confirmSnapshot
})
try {
  check('construction is inert', !service.state().pending && downloads === 0 && picks === 0)
  await writeFile(localPath, JSON.stringify({ proxies: [local] }), { mode: 0o600 })
  const original = await profiles.save('Three provider fixture', source),
    selection = { id: original.id, sha256: original.sha256 },
    choices: Record<string, RelayProfileSelection> = {},
    plan = (provider: string) =>
      service.prepare({ profile: selection, provider, proxyPort: fixture.proxyPort })
  const initial = await service.inspect(selection)
  check(
    'three kinds are inspected without credentials or original paths in public reports',
    initial.providers.length === 3 &&
      !JSON.stringify(initial).includes('PRIVATE') &&
      !JSON.stringify(initial).includes(forbiddenPath)
  )
  const cancelled = await plan('H')
  check(
    'default cancel performs no resource request or write',
    (await service.acquire({ evidenceId: cancelled.evidenceId })).status === 'cancelled' &&
      downloads === 0 &&
      (await cache.list()).profiles.length === 0
  )
  confirmAcquire = true
  for (const name of ['I', 'F', 'H']) {
    const prepared = await plan(name),
      result = await service.acquire({ evidenceId: prepared.evidenceId })
    check(
      name + ' resource saved through its registered acquisition path',
      result.status === 'cached' && !!result.resource
    )
    if (!result.resource) throw new Error('provider fixture cache absent')
    choices[name] = { id: result.resource.id, sha256: result.resource.sha256 }
  }
  check(
    'only HTTP resource goes through the explicit proxy with its private header',
    downloads === 1 &&
      fixture.stats().forwarded === 1 &&
      fixture.stats().origins === 1 &&
      fixture.stats().authorizedRequests === 1
  )
  check('file resource is explicitly picked exactly once', picks === 1)
  let forbiddenMissing = false
  try {
    await lstat(forbiddenPath)
  } catch (error) {
    forbiddenMissing = (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  check('source path was neither read as a required file nor created', forbiddenMissing)
  check(
    'provider namespace does not appear in configuration listing',
    (await profiles.list()).profiles.length === 1 && (await cache.list()).profiles.length === 3
  )
  const remoteDirectory = join(cache.directory, choices.H.id)
  check(
    'private cache preserves exact HTTP response bytes and permissions',
    (await readFile(join(remoteDirectory, 'profile.yaml'), 'utf8')) === resource &&
      ((await lstat(remoteDirectory)).mode & 0o777) === 0o700 &&
      ((await lstat(join(remoteDirectory, 'profile.yaml'))).mode & 0o777) === 0o600 &&
      ((await lstat(join(remoteDirectory, 'metadata.json'))).mode & 0o777) === 0o600
  )
  const metadataPath = join(profiles.directory, original.id, 'metadata.json'),
    metadata = await readFile(metadataPath, 'utf8')
  await writeFile(
    metadataPath,
    JSON.stringify({ ...JSON.parse(metadata), name: 'Changed fixture' })
  )
  check(
    'cache binding changes when source metadata revision changes',
    (await service.inspect(selection)).providers.every((p) => p.resources.length === 0)
  )
  await writeFile(metadataPath, metadata)
  const snapshot = () => service.prepareSnapshot({ profile: selection, resources: choices })
  let prepared = await snapshot()
  check(
    'static save defaults to cancellation without another configuration',
    (await service.saveSnapshot({ evidenceId: prepared.evidenceId })).status === 'cancelled' &&
      (await profiles.list()).profiles.length === 1
  )
  prepared = await snapshot()
  await writeFile(join(remoteDirectory, 'profile.yaml'), resource + '# changed')
  confirmSnapshot = true
  check(
    'changed cache blocks save and preserves all source records',
    (await service.saveSnapshot({ evidenceId: prepared.evidenceId })).status === 'failed' &&
      (await profiles.list()).profiles.length === 1
  )
  await writeFile(join(remoteDirectory, 'profile.yaml'), resource)
  prepared = await snapshot()
  const saved = await service.saveSnapshot({ evidenceId: prepared.evidenceId })
  check(
    'selected caches produce a new immutable configuration',
    saved.status === 'saved' && !!saved.profile && (await profiles.list()).profiles.length === 2
  )
  if (!saved.profile) throw new Error('snapshot absent')
  const stored = await profiles.read({ id: saved.profile.id, sha256: saved.profile.sha256 }),
    parsed = analyzeProfile(stored.text).data
  check(
    'snapshot retains ordered inline provider boundaries and original DNS data',
    !!parsed &&
      JSON.stringify(parsed.dns) === JSON.stringify(JSON.parse(source).dns) &&
      JSON.stringify((parsed['proxy-groups'] as { use: string[] }[])[0].use) ===
        JSON.stringify(['I', 'F', 'H']) &&
      saved.profile.summary.proxyProviders === 3 &&
      Object.values(parsed['proxy-providers'] as Record<string, { type: string }>).every(
        (p) => p.type === 'inline'
      )
  )
  check(
    'snapshot records provenance with cache hashes instead of private URLs',
    stored.text.includes('# source-profile: ' + original.id) &&
      stored.text.includes('# provider-cache: ' + choices.H.id) &&
      !stored.text.includes('PRIVATE')
  )
  check('original source bytes remain exact', (await profiles.read(selection)).text === source)
  const httpPort = await freeFixturePort(),
    core = await startLocalProxyCore(resolve('extra/relay/core'), stored.text, httpPort, (stop) => {
      cleanupOwn = stop
    })
  const first = await network.request(httpPort, 'inline-provider')
  check(
    'pinned actual core sends the first request through the materialized inline node',
    first.includes('origin:/inline-provider') &&
      network.stats().usedA === 1 &&
      network.stats().usedB === 0
  )
  await core.select(group, 'Local B')
  const second = await network.request(httpPort, 'local-provider')
  check(
    'actual group selection reaches the materialized local resource node',
    second.includes('origin:/local-provider') &&
      (await core.group(group)).now === 'Local B' &&
      network.stats().usedB === 1
  )
  await core.select(group, 'Remote A')
  const third = await network.request(httpPort, 'http-provider')
  check(
    'actual group selection reaches the materialized HTTP resource node',
    third.includes('origin:/http-provider') && network.stats().usedA === 2
  )
  check(
    'core does not refetch resources or run disabled source health checks',
    fixture.stats().origins === 1 && fixture.stats().forwarded === 1
  )
  await core.stop()
  check('owned test core stops without affecting other instances', core.state() === 'stopped')
  await fixture.closeProxy()
  const failed = await plan('H'),
    result = await service.acquire({ evidenceId: failed.evidenceId })
  check(
    'failed explicit proxy does not fall back direct or use source payload',
    result.status === 'failed' &&
      fixture.originListening() &&
      fixture.stats().origins === 1 &&
      (await cache.list()).profiles.length === 3
  )
  check(
    'failed update retains prior static fork and original source',
    (await profiles.list()).profiles.length === 2 &&
      (await profiles.read(selection)).text === source
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
  scope: 'fake HOME, owned loopback HTTP provider and fixed actual core only',
  architectureExecuted: process.arch,
  actualHTTPFileInlineResourcesVerified: true,
  actualStaticForkTrafficVerified: true,
  liveDynamicProvidersVerified: false,
  realInternetOrClaudeTrafficVerified: false,
  actualSystemProxyDNSOrTUNChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  actualUserClientConfigurationChanged: false,
  appOrBrowserLaunched: false,
  intelRuntimeVerified: process.arch === 'x64',
  liveNoDirectGuardVerified: false
}
await writeFile(
  '../evidence/provider-runtime-contract.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Provider resource contract failed')
