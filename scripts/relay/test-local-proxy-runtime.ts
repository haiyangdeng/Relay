import { createServer } from 'net'
import { lstat, writeFile } from 'fs/promises'
import { resolve } from 'path'
import {
  startLocalProxyCore,
  localProxyConfiguration
} from '../../src/main/relay/core/local-proxy-runtime'
import { ownsHttpListener, probeLocalPort } from '../../src/main/relay/core/port'
import { createLocalNetworkFixture, fixturePort, closeFixture } from './fixtures/local-network'

const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
const network = await createLocalNetworkFixture(),
  reserved = createServer((socket) => socket.destroy())
const httpPort = await fixturePort(reserved)
check(
  'occupied port is reported without stopping its listener',
  !(await probeLocalPort(httpPort)) && reserved.listening
)
await closeFixture(reserved)
let core: Awaited<ReturnType<typeof startLocalProxyCore>> | undefined,
  cleanupOwn: (() => Promise<void>) | undefined
try {
  const generated = localProxyConfiguration(network.source, httpPort)
  const config = JSON.parse(generated.configuration)
  check(
    'only explicit loopback HTTP port is enabled',
    config.port === httpPort &&
      config['mixed-port'] === 0 &&
      config['socks-port'] === 0 &&
      config['bind-address'] === '127.0.0.1' &&
      !config['allow-lan']
  )
  check(
    'system DNS/TUN integration remains disabled in this first slice',
    !config.dns.enable && !config.tun.enable
  )
  core = await startLocalProxyCore(
    resolve('extra/relay/core'),
    network.source,
    httpPort,
    (stop) => {
      cleanupOwn = stop
    }
  )
  check('listener belongs to this newly spawned core', await ownsHttpListener(core.pid, httpPort))
  check(
    'real controller confirms first declared group member',
    (await core.group(network.group)).now === 'NodeA'
  )
  const responseA = await network.request(httpPort, 'via-A')
  check(
    'actual HTTP request passes through owned core and proxy A to origin',
    responseA.includes('200 OK') &&
      responseA.includes('origin:/via-A') &&
      network.stats().usedA === 1 &&
      network.stats().usedB === 0 &&
      network.stats().originRequests === 1
  )
  await core.select(network.group, 'NodeB')
  check(
    'PUT group selection is confirmed by a new GET',
    (await core.group(network.group)).now === 'NodeB'
  )
  const responseB = await network.request(httpPort, 'via-B')
  check(
    'next new connection uses proxy B',
    responseB.includes('200 OK') &&
      responseB.includes('origin:/via-B') &&
      network.stats().usedA === 1 &&
      network.stats().usedB === 1 &&
      network.stats().originRequests === 2
  )
  await network.stopB()
  let rejected = false
  try {
    const failed = await network.request(httpPort, 'must-fail')
    rejected = !failed.includes('200 OK') && !failed.includes('origin:/must-fail')
  } catch {
    rejected = true
  }
  check(
    'failed selected fixture does not silently route the explicit proxy request DIRECT',
    rejected && network.stats().originRequests === 2
  )
  const live = await core.read('configs')
  check(
    'actual controller config matches the owned HTTP port and disabled TUN',
    live.port === httpPort &&
      live['mixed-port'] === 0 &&
      !!live.tun &&
      typeof live.tun === 'object' &&
      (live.tun as Record<string, unknown>).enable === false
  )
  const directory = core.directory
  await core.stop()
  check('owned core exits and cleanup is confirmed', core.state() === 'stopped')
  let missing = false
  try {
    await lstat(directory)
  } catch (error) {
    missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  check('only its temporary runtime directory is removed', missing)
  check('released HTTP port becomes available', await probeLocalPort(httpPort))
  let closedRead = false
  try {
    await core.read('version')
  } catch {
    closedRead = true
  }
  check('closed controller refuses reads without an automatic restart', closedRead)
} finally {
  await cleanupOwn?.()
  await network.close()
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  actualOwnedHTTPProxyTrafficVerified: true,
  actualGroupSwitchVerified: true,
  localLoopbackFixturesOnly: true,
  realInternetOrClaudeTrafficVerified: false,
  fullSourceDNSConfigurationApplied: false,
  actualSystemProxyDNSOrTUNChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  actualUserClientConfigurationChanged: false,
  liveNoDirectGuardVerified: false,
  appOrBrowserLaunched: false,
  architectureExecuted: process.arch,
  intelRuntimeVerified: process.arch === 'x64'
}
await writeFile(
  '../evidence/local-proxy-runtime-contract.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Local proxy runtime contract failed.')
