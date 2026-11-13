import { mkdtemp, realpath, readFile, writeFile, mkdir, lstat, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { setTimeout as delay } from 'timers/promises'
import type { ResourceDescriptor, ResourceInfo } from '../../src/shared/relay/resources'
import { ResourceStore } from '../../src/main/relay/resources/store'
import { createResourceService } from '../../src/main/relay/resources/service'
import {
  readBinaryResource,
  resourceHash,
  downloadBinaryResource
} from '../../src/main/relay/resources/source'
import { checkResourceWithCore } from '../../src/main/relay/resources/checker'
import { createLocalSubscriptionFixture } from './fixtures/local-subscription'
import { geositeFixture, geoipFixture } from './fixtures/rule-resources'
import { mrsFixture } from './fixtures/mrs'
import assetManifest from './fixtures/assets/manifest.json'

const home = await realpath(await mkdtemp('/private/tmp/relay-rule-resources-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  cache = new ResourceStore(context),
  coreRoot = resolve('extra/relay/core'),
  mrs = await mrsFixture(coreRoot, 'domain'),
  fixture = await createLocalSubscriptionFixture(mrs),
  selectedPath = join(home, 'selected-resource.bin'),
  sentinelPath = join(home, '.claude/settings.json'),
  sentinel = '{"PRIVATE":"keep"}',
  rows: { name: string; passed: boolean }[] = [],
  check = (name: string, passed: boolean): void => {
    rows.push({ name, passed })
  }
let allow = false,
  checkStarted = false,
  changeSelected = false,
  downloads = 0,
  picks = 0,
  checks = 0
const service = createResourceService({
  cache,
  pick: async () => {
    ++picks
    const bytes = await readBinaryResource(selectedPath)
    if (changeSelected) await writeFile(selectedPath, 'changed by fixture')
    return { bytes, readAgain: () => readBinaryResource(selectedPath) }
  },
  download: (url, port, signal, headers) => {
    ++downloads
    return downloadBinaryResource(url, port, signal, headers)
  },
  confirm: async () => allow,
  check: async (job) => {
    ++checks
    checkStarted = true
    return checkResourceWithCore(coreRoot, job)
  }
})
const descriptor: ResourceDescriptor = {
    name: 'HTTP MRS fixture',
    kind: 'rule-mrs',
    behavior: 'domain',
    selector: ''
  },
  request = (path = '/snapshot', expectedSHA256 = resourceHash(mrs)) =>
    service.prepare({
      descriptor,
      source: {
        kind: 'http',
        url: fixture.url(path),
        proxyPort: fixture.proxyPort,
        headers: { Authorization: 'Bearer PRIVATE' }
      },
      expectedSHA256
    }),
  selected = (r: ResourceInfo) => ({ id: r.id, sha256: r.sha256 }),
  until = async (predicate: () => boolean): Promise<boolean> => {
    for (let n = 0; n < 200; n++) {
      if (predicate()) return true
      await delay(10)
    }
    return false
  }
try {
  await mkdir(join(home, '.claude'), { mode: 0o700 })
  await writeFile(sentinelPath, sentinel, { mode: 0o600 })
  check(
    'construction and metadata listing start no acquisition or core',
    (await service.list()).resources.length === 0 &&
      downloads === 0 &&
      checks === 0 &&
      fixture.stats().origins === 0
  )
  let p = request()
  check(
    'public preparation omits URL token, headers and file paths',
    !JSON.stringify(p).includes('PRIVATE') && !JSON.stringify(p).includes(selectedPath)
  )
  check(
    'default cancel prevents acquisition and cache creation',
    (await service.acquire({ evidenceId: p.evidenceId })).status === 'cancelled' &&
      downloads === 0 &&
      (await cache.list()).resources.length === 0
  )
  allow = true
  p = request()
  const first = await service.acquire({ evidenceId: p.evidenceId })
  check(
    'real binary HTTP resource uses the selected proxy and private header',
    first.status === 'cached' &&
      fixture.stats().forwarded === 1 &&
      fixture.stats().authorizedRequests === 1
  )
  if (!first.resource) throw new Error('HTTP resource absent')
  const info = first.resource,
    root = join(cache.directory, info.id),
    read = await cache.read(selected(info))
  check(
    'MRS binary survives HTTP and private storage byte for byte',
    read.bytes.equals(mrs) && read.info.sha256 === resourceHash(mrs)
  )
  check(
    'cache directory, data and metadata use private permissions',
    (await lstat(root)).mode % 512 === 0o700 &&
      (await lstat(join(root, 'resource.bin'))).mode % 512 === 0o600 &&
      (await lstat(join(root, 'metadata.json'))).mode % 512 === 0o600
  )
  check(
    'metadata list does not claim body or core integrity',
    (await cache.list()).resources[0].integrity === 'notChecked'
  )
  const accepted = await service.check(selected(info))
  check(
    'actual fixed core initializes MRS provider and reports both rules',
    accepted.check?.status === 'passed' && accepted.check.ruleCount === 2
  )
  check('fixed-core checking never refetches the resource', fixture.stats().origins === 1)
  p = request('/snapshot', '0'.repeat(64))
  check(
    'expected SHA mismatch prevents a new cache record',
    (await service.acquire({ evidenceId: p.evidenceId })).status === 'failed' &&
      (await cache.list()).resources.length === 1
  )
  const cases: { descriptor: ResourceDescriptor; bytes: Buffer; count?: number }[] = [
    {
      descriptor: { name: 'YAML domain', kind: 'rule-yaml', behavior: 'domain', selector: '' },
      bytes: Buffer.from('payload:\n  - fixture.invalid\n  - +.example.invalid\n'),
      count: 2
    },
    {
      descriptor: {
        name: 'YAML classical',
        kind: 'rule-yaml',
        behavior: 'classical',
        selector: ''
      },
      bytes: Buffer.from(
        'rules:\n  - DOMAIN,fixture.invalid\n  - IP-CIDR,127.0.0.0/8,no-resolve\n'
      ),
      count: 2
    },
    {
      descriptor: { name: 'Text IPCIDR', kind: 'rule-text', behavior: 'ipcidr', selector: '' },
      bytes: Buffer.from('# fixture\n127.0.0.0/8\n::1/128\n'),
      count: 2
    },
    {
      descriptor: { name: 'MRS IPCIDR', kind: 'rule-mrs', behavior: 'ipcidr', selector: '' },
      bytes: await mrsFixture(coreRoot, 'ipcidr'),
      count: 2
    },
    {
      descriptor: {
        name: 'Artificial GeoIP',
        kind: 'geoip-dat',
        behavior: null,
        selector: 'RELAY'
      },
      bytes: geoipFixture()
    },
    {
      descriptor: {
        name: 'Artificial GeoSite',
        kind: 'geosite-dat',
        behavior: null,
        selector: 'RELAY'
      },
      bytes: geositeFixture()
    }
  ]
  for (const [kind, file, selector] of [
    ['country-mmdb', 'GeoIP2-Country-Test.mmdb', 'GB'],
    ['asn-mmdb', 'GeoLite2-ASN-Test.mmdb', '64512']
  ] as const) {
    const path = 'scripts/relay/fixtures/assets/' + file,
      asset = assetManifest.files.find((row) => row.path === path),
      bytes = await readFile(path)
    if (!asset || asset.size !== bytes.length || asset.sha256 !== resourceHash(bytes))
      throw new Error('official fixture pin mismatch')
    cases.push({ descriptor: { name: 'Official ' + kind, kind, behavior: null, selector }, bytes })
  }
  for (const item of cases) {
    await writeFile(selectedPath, item.bytes, { mode: 0o600 })
    const prepared = service.prepare({
        descriptor: item.descriptor,
        source: { kind: 'file' },
        expectedSHA256: resourceHash(item.bytes)
      }),
      saved = await service.acquire({ evidenceId: prepared.evidenceId })
    check(
      item.descriptor.kind +
        '/' +
        item.descriptor.behavior +
        ' local snapshot preserves its selected source',
      saved.status === 'cached' && (await readBinaryResource(selectedPath)).equals(item.bytes)
    )
    if (!saved.resource) throw new Error('selected fixture absent')
    const result = await service.check(selected(saved.resource))
    check(
      item.descriptor.kind +
        '/' +
        item.descriptor.behavior +
        ' actual core parser accepts the selected resource',
      result.check?.status === 'passed' &&
        (item.count === undefined || result.check.ruleCount === item.count)
    )
  }
  p = service.prepare({
    descriptor: { name: 'Inline YAML', kind: 'rule-yaml', behavior: 'domain', selector: '' },
    source: { kind: 'inline', payload: ['fixture.invalid', '+.example.invalid'] },
    expectedSHA256: ''
  })
  const inline = await service.acquire({ evidenceId: p.evidenceId })
  if (!inline.resource) throw new Error('inline fixture absent')
  check(
    'inline YAML becomes a usable private rule resource',
    (await service.check(selected(inline.resource))).check?.ruleCount === 2
  )
  const invalidBytes = Buffer.from('fixture.invalid\nhttps://must-not-fetch.invalid\n'),
    invalid = await cache.save(
      { name: 'Partly invalid', kind: 'rule-text', behavior: 'domain', selector: '' },
      invalidBytes
    )
  check(
    'core silently skipped rows never become a false full-resource pass',
    (await service.check(selected(invalid))).check?.status === 'notVerified'
  )
  const dependencies = await cache.save(
      { name: 'Needs GEO', kind: 'rule-text', behavior: 'classical', selector: '' },
      Buffer.from('GEOSITE,CN\n')
    ),
    dependencyResult = await service.check(selected(dependencies))
  check(
    'unlinked geographical dependencies are explicit and not downloaded',
    dependencyResult.check?.status === 'requiresResources' &&
      dependencyResult.check.coreVersion === undefined
  )
  const priorCount = (await cache.list()).resources.length,
    priorChecks = checks
  await writeFile(join(root, 'resource.bin'), Buffer.alloc(mrs.length))
  check(
    'same-size cache tamper blocks the checker before native execution',
    (await service.check(selected(info))).status === 'failed' && checks === priorChecks
  )
  await writeFile(join(root, 'resource.bin'), mrs)
  changeSelected = true
  await writeFile(selectedPath, mrs)
  p = service.prepare({ descriptor, source: { kind: 'file' }, expectedSHA256: resourceHash(mrs) })
  check(
    'changing selected file is rejected without another cache record',
    (await service.acquire({ evidenceId: p.evidenceId })).status === 'failed' &&
      (await cache.list()).resources.length === priorCount
  )
  changeSelected = false
  check('local resource reads only follow the explicit picker flow', picks === cases.length + 1)
  p = request('/slow', '')
  const pending = service.acquire({ evidenceId: p.evidenceId })
  check(
    'slow binary request starts only through its owned fixture proxy',
    await until(() => fixture.stats().slowStarted === 1)
  )
  check(
    'cancel addresses only the current acquisition',
    service.cancel({ evidenceId: p.evidenceId }).status === 'requested'
  )
  check(
    'real cancellation closes the request socket without caching',
    (await pending).status === 'cancelled' &&
      (await until(() => fixture.stats().slowClosed === 1)) &&
      (await cache.list()).resources.length === priorCount
  )
  checkStarted = false
  const checking = service.check(selected(info))
  await until(() => checkStarted)
  const closing = service.requestClose()
  check(
    'closing during an owned core check waits for cleanup and discards the result',
    (await checking).status === 'cancelled'
  )
  await closing
  await fixture.closeProxy()
  const origins = fixture.stats().origins
  p = request()
  check(
    'selected proxy failure does not contact the live origin directly',
    (await service.acquire({ evidenceId: p.evidenceId })).status === 'failed' &&
      fixture.originListening() &&
      fixture.stats().origins === origins
  )
  check(
    'resource work preserves the client sentinel and all earlier resources',
    (await readFile(sentinelPath, 'utf8')) === sentinel &&
      (await cache.list()).resources.length === priorCount
  )
  check(
    'resource work does not create a traffic configuration directory',
    await lstat(join(context.stateRoot, 'Configurations')).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
    )
  )
} finally {
  await service.requestClose()
  service.clear()
  await fixture.close()
  await rm(home, { recursive: true, force: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  scope:
    'fake HOME, owned loopback binary HTTP, pinned native parser/controller and fixed artificial Geo/MMDB fixtures',
  architectureExecuted: process.arch,
  intelRuntimeVerified: process.arch === 'x64',
  allSevenResourceKindsActualParserVerified: rows.every((row) => row.passed),
  realPublicGeolocationAccuracyVerified: false,
  actualSystemProxyDNSOrTUNChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  actualUserClientConfigurationChanged: false,
  productionResourcesActivated: false,
  appOrBrowserLaunched: false,
  liveNoDirectGuardVerified: false
}
await writeFile(
  '../evidence/rule-resource-runtime-contract.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Rule resource contract failed')
