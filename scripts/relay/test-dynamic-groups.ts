import { writeFile } from 'fs/promises'
import { resolve } from 'path'
import { setTimeout as wait } from 'timers/promises'
import {
  localProxyConfiguration,
  startLocalProxyCore
} from '../../src/main/relay/core/local-proxy-runtime'
import { materializeProviders } from '../../src/main/relay/providers/materialize'
import { createLocalProxyService } from '../../src/main/relay/core/local-proxy-service'
import { inspectProfile } from '../../src/main/relay/profiles/inspect'
import { profileHash } from '../../src/main/relay/profiles/source'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'

const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
const network = await createLocalNetworkFixture()
const port = await freeFixturePort()
let cleanup: (() => Promise<void>) | undefined
try {
  const original = JSON.parse(network.source)
  const target = network.healthURL
  const health = { url: target, interval: 600, timeout: 500, lazy: false, 'expected-status': '200' }
  const groups: ({ name: string; type: string } & Record<string, unknown>)[] = [
    {
      name: 'Select / Provider',
      type: 'select',
      use: ['Fixture / P'],
      url: target,
      filter: 'Node[AB]'
    },
    { name: 'Auto / URL', type: 'url-test', use: ['Fixture / P'], ...health, tolerance: 0 },
    { name: 'Fallback / A', type: 'fallback', use: ['Fixture / P'], ...health },
    {
      name: 'Balance / RR',
      type: 'load-balance',
      use: ['Fixture / P'],
      ...health,
      strategy: 'round-robin'
    },
    {
      name: 'Balance / Hash',
      type: 'load-balance',
      use: ['Fixture / P'],
      ...health,
      strategy: 'consistent-hashing',
      'hash-key': 'in-user'
    },
    {
      name: 'Balance / Sticky',
      type: 'load-balance',
      use: ['Fixture / P'],
      ...health,
      strategy: 'sticky-sessions'
    },
    { name: 'Only / B', type: 'select', use: ['Fixture / P'], url: target, filter: 'NodeB' },
    {
      name: 'Exclude / A',
      type: 'select',
      use: ['Fixture / P'],
      url: target,
      'exclude-filter': 'NodeA'
    },
    {
      name: 'Empty / Reject',
      type: 'select',
      use: ['Fixture / P'],
      'exclude-type': 'http',
      'empty-fallback': 'REJECT'
    },
    { name: 'Empty / Default', type: 'select', use: ['Fixture / P'], 'exclude-filter': '.*' }
  ]
  groups.push({
    name: 'All / Nodes',
    type: 'select',
    'include-all-proxies': true,
    filter: 'TopA'
  })
  groups.push({
    name: 'All / Providers',
    type: 'select',
    'include-all-providers': true,
    filter: 'NodeB'
  })
  groups.push({
    name: 'Ordered / Filters',
    type: 'select',
    use: ['Fixture / P'],
    filter: 'NodeB`NodeA'
  })
  groups.push({
    name: 'Inherited / URL',
    type: 'url-test',
    use: ['Fixture / P']
  })
  const routing = { name: 'Route', type: 'select', proxies: groups.map((g) => g.name) }
  const source = JSON.stringify({
    proxies: [{ ...original.proxies[0], name: 'TopA' }],
    'proxy-providers': {
      'Fixture / P': {
        type: 'http',
        url: 'https://not-fetched.invalid/PRIVATE',
        filter: 'Node[AB]',
        'health-check': { enable: true, ...health }
      }
    },
    'proxy-groups': [...groups, routing],
    rules: ['MATCH,Route']
  })
  const copy = materializeProviders(source, {
    'Fixture / P': JSON.stringify({ proxies: original.proxies })
  })
  check(
    'snapshot retains inline provider boundaries and strips external acquisition paths',
    !copy.text.includes('PRIVATE') &&
      JSON.parse(copy.text)['proxy-providers']['Fixture / P'].type === 'inline'
  )
  const built = localProxyConfiguration(copy.text, port)
  check(
    'all four supported group types reach the controlled compiler',
    new Set(built.groups.map((g) => g.type)).size === 4
  )
  const core = await startLocalProxyCore(resolve('extra/relay/core'), copy.text, port, (stop) => {
    cleanup = stop
  })
  check(
    'pinned real core starts with controlled loopback HTTP and private controller',
    core.version === 'v1.19.33'
  )
  await wait(150)
  for (const group of groups) {
    const current = await core.group(group.name)
    check(
      'core group type ' + group.name,
      current.type ===
        (
          {
            select: 'Selector',
            'url-test': 'URLTest',
            fallback: 'Fallback',
            'load-balance': 'LoadBalance'
          } as Record<string, string>
        )[group.type]
    )
  }
  check(
    'provider filter and include order preserved',
    JSON.stringify((await core.group('Select / Provider')).all) ===
      JSON.stringify(['NodeA', 'NodeB'])
  )
  check(
    'group filter runs against provider nodes in fixed core',
    JSON.stringify((await core.group('Only / B')).all) === JSON.stringify(['NodeB'])
  )
  check(
    'exclude-filter preserves only B',
    JSON.stringify((await core.group('Exclude / A')).all) === JSON.stringify(['NodeB'])
  )
  check(
    'explicit empty fallback remains REJECT',
    JSON.stringify((await core.group('Empty / Reject')).all) === JSON.stringify(['REJECT'])
  )
  check(
    'default empty fallback is honestly COMPATIBLE',
    JSON.stringify((await core.group('Empty / Default')).all) === JSON.stringify(['COMPATIBLE'])
  )
  check(
    'include-all-proxies selects top-level nodes with core filter',
    JSON.stringify((await core.group('All / Nodes')).all) === JSON.stringify(['TopA'])
  )
  check(
    'include-all-providers preserves provider filtering',
    JSON.stringify((await core.group('All / Providers')).all) === JSON.stringify(['NodeB'])
  )
  check(
    'backtick filter ordering is performed by fixed core',
    JSON.stringify((await core.group('Ordered / Filters')).all) ===
      JSON.stringify(['NodeB', 'NodeA'])
  )
  check(
    'automatic group inherits only explicitly declared provider health URL',
    (await core.group('Inherited / URL')).testUrl === target
  )
  const provider = (await core.read('providers/proxies')).providers as Record<
    string,
    { proxies: { name: string; history: unknown[] }[] }
  >
  check(
    'automatic health checks have real history for provider nodes',
    provider['Fixture / P'].proxies.every((n) => n.history.length > 0) &&
      network.stats().usedA > 0 &&
      network.stats().usedB > 0
  )
  for (const node of ['NodeA', 'NodeB']) {
    const delay = await core.testDelay?.(node, target, 1000)
    check('real provider-node delay ' + node, typeof delay === 'number' && delay > 0)
  }
  for (const name of [
    'Auto / URL',
    'Fallback / A',
    'Balance / RR',
    'Balance / Hash',
    'Balance / Sticky'
  ]) {
    await core.select('Route', name)
    const previous = network.stats()
    const a = await network.request(port, 'group-one')
    const b = await network.request(port, 'group-two')
    const current = network.stats()
    check(
      'real traffic through ' + name,
      a.includes('origin:/group-one') &&
        b.includes('origin:/group-two') &&
        current.originRequests === previous.originRequests + 2
    )
    if (name === 'Balance / RR')
      check(
        'round-robin distributes the two real connections',
        current.usedA === previous.usedA + 1 && current.usedB === previous.usedB + 1
      )
  }
  await core.select('Route', 'Select / Provider')
  await core.select('Select / Provider', 'NodeB')
  check(
    'provider group selected state confirmed by fresh read',
    (await core.group('Select / Provider')).now === 'NodeB'
  )
  const beforeB = network.stats().usedB
  check(
    'selected provider B carries real traffic',
    (await network.request(port, 'dynamic-B')).includes('origin:/dynamic-B') &&
      network.stats().usedB === beforeB + 1
  )
  for (const name of ['Auto / URL', 'Fallback / A']) {
    await core.select(name, 'NodeB')
    check('automatic group can be fixed ' + name, (await core.group(name)).fixed === 'NodeB')
    await core.automatic?.(name)
    check('automatic selection restored ' + name, (await core.group(name)).fixed === '')
  }
  let refused = false
  try {
    await core.select('Balance / RR', 'NodeB')
  } catch {
    refused = true
  }
  check('load-balance rejects fake fixed selection', refused)
  const count = network.stats().originRequests
  await network.stopB()
  let delayFailed = false
  try {
    await core.testDelay?.('NodeB', target, 500)
  } catch {
    delayFailed = true
  }
  check(
    'failed provider-node delay does not retry direct',
    delayFailed && network.stats().originRequests === count
  )
  const after = (await core.read('providers/proxies')).providers as typeof provider
  const b = after['Fixture / P'].proxies.find((n) => n.name === 'NodeB') as
    { history: { delay: number }[]; alive?: boolean } | undefined
  check(
    'failed health history records unavailable rather than green',
    b?.history.at(-1)?.delay === 0
  )
  const response = await network.request(port, 'no-direct')
  check(
    'failed manually selected fixture never bypasses proxy',
    !response.includes('origin:/no-direct') && network.stats().originRequests === count
  )
  await core.stop()
  check('only new owned core is stopped', core.state() === 'stopped')
} finally {
  await cleanup?.()
  await network.close()
}
// Exercise the App's actual service with a newly owned core, not a mocked
// controller. Both read-side state and operations go through the same service
// used by the trusted IPC. Source/lease adapters stay in memory for this test.
const host = await createLocalNetworkFixture()
let hostCleanup: (() => Promise<void>) | undefined
try {
  const config = JSON.parse(host.source)
  config['proxy-providers'] = {
    P: {
      type: 'inline',
      payload: config.proxies,
      'health-check': { enable: true, url: host.healthURL, interval: 600 }
    }
  }
  config.proxies = []
  config['proxy-groups'] = [
    { name: 'Auto', type: 'url-test', use: ['P'], url: host.healthURL, interval: 600 }
  ]
  config.rules = ['MATCH,Auto']
  const text = JSON.stringify(config),
    sha256 = profileHash(text),
    summary = inspectProfile(text).summary
  if (!summary) throw new Error('fixture summary missing')
  const selection = { id: '00000000-0000-0000-0000-000000000023', sha256 }
  let allowTest = false
  const service = createLocalProxyService({
    read: async () => ({
      text,
      revision: sha256,
      profile: { ...selection, name: 'Fixture', createdAt: '2026-10-25', summary }
    }),
    inspect: async () => ({ mode: 'rule', revision: 'a'.repeat(64), lease: 'missing' }),
    resources: () => verifyCoreResource(resolve('extra/relay/core')),
    portAvailable: async () => true,
    acquire: async () => ({ update: async () => {}, release: async () => {} }),
    start: (source, port, register, mode) =>
      startLocalProxyCore(
        resolve('extra/relay/core'),
        source,
        port,
        (stop) => {
          hostCleanup = stop
          register(stop)
        },
        mode
      ),
    confirmStart: async () => true,
    confirmStop: async () => true,
    confirmTest: async () => allowTest
  })
  const prepared = await service.prepare({ profile: selection, httpPort: await freeFixturePort() })
  const started = await service.action({ action: 'start', evidenceId: prepared.evidenceId }),
    id = started.state.instanceId
  check(
    'App service starts and confirms actual provider membership',
    started.status === 'started' &&
      JSON.stringify(started.state.groups[0].members) === JSON.stringify(['NodeA', 'NodeB'])
  )
  if (!id) throw new Error('service instance missing')
  await wait(100)
  await service.action({ action: 'refresh', instanceId: id })
  check(
    'App service reads per-URL health from real provider endpoint',
    service
      .state()
      .groups[0].health?.every((h) => !!h.at && typeof h.delay === 'number' && h.delay > 0) === true
  )
  const before = host.stats().originRequests
  check(
    'native test confirmation cancellation sends no probe',
    (await service.action({ action: 'delay', instanceId: id, group: 'Auto', member: 'NodeB' }))
      .status === 'cancelled' && host.stats().originRequests === before
  )
  allowTest = true
  check(
    'App service manual provider test works',
    (await service.action({ action: 'delay', instanceId: id, group: 'Auto', member: 'NodeB' }))
      .status === 'tested'
  )
  check(
    'App service fixes automatic group using fresh GET',
    (await service.action({ action: 'select', instanceId: id, group: 'Auto', member: 'NodeB' }))
      .state.groups[0].fixed === 'NodeB'
  )
  check(
    'App service restores automatic policy with fresh GET',
    (await service.action({ action: 'automatic', instanceId: id, group: 'Auto' })).state.groups[0]
      .fixed === ''
  )
  check(
    'App service quits only its owned core',
    (await service.requestClose()) === 'closed' && !service.state().owned
  )
} finally {
  await hostCleanup?.()
  await host.close()
}
const report = {
  checks: rows.length,
  passed: rows.filter((r) => r.passed).length,
  rows,
  localLoopbackFixturesOnly: true,
  actualUserNetworkOrSystemConfigurationChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  productionNodesOrClaudeTrafficUsed: false,
  liveNoDirectGuardVerified: false,
  architectureExecuted: process.arch
}
await writeFile(
  '../evidence/dynamic-group-verification.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Dynamic groups contract failed.')
