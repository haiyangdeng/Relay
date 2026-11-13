import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { localProxyHTTPPort, type LocalProxyPorts } from '../../src/shared/relay/local-proxy-ports'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import type { RelayOwnedCore } from '../../src/main/relay/core/owned-runtime'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import {
  ownsHttpListener,
  ownsUdpListener,
  probeLocalPort,
  probeLocalUdpPort
} from '../../src/main/relay/core/port'
import { closeFixture, createLocalNetworkFixture, fixturePort } from './fixtures/local-network'

// Runs only newly created cores and loopback fixtures. No user profile, system
// proxy, route, DNS, Claude process, external destination or existing core is used.
const run = promisify(execFile)
const root = resolve(process.argv[2] ?? 'extra/relay/core')
const resource = await verifyCoreResource(root)
const rows: { name: string; passed: boolean }[] = []
const failures: string[] = []
const scenarios: { name: string; pid?: number; ports: LocalProxyPorts }[] = []
function check(name: string, passed: boolean): void {
  rows.push({ name, passed })
  assert.ok(passed, name)
}

async function scenario(mixedOnly: boolean): Promise<void> {
  const name = mixedOnly ? 'mixed-only' : 'all-four'
  const fixture = await createLocalNetworkFixture()
  const reserved: ReturnType<typeof createServer>[] = []
  let core: RelayOwnedCore | undefined
  let cleanup: (() => Promise<void>) | undefined
  let ports: LocalProxyPorts | undefined
  let directory: string | undefined
  try {
    const allocated: number[] = []
    for (let index = 0; index < 4; index++) {
      const server = createServer((socket) => socket.destroy())
      reserved.push(server)
      allocated.push(await fixturePort(server))
    }
    ports = {
      http: mixedOnly ? 0 : allocated[0],
      socks: mixedOnly ? 0 : allocated[1],
      mixed: allocated[2],
      redir: mixedOnly ? 0 : allocated[3]
    }
    const record = { name, ports, pid: undefined as number | undefined }
    scenarios.push(record)
    for (const port of [ports.socks, ports.mixed].filter(Boolean))
      check(`${name}: UDP ${port} initially available`, await probeLocalUdpPort(port))
    await Promise.all(reserved.map(closeFixture))
    core = await startLocalProxyCore(
      root,
      fixture.source,
      localProxyHTTPPort(ports),
      (stop) => {
        cleanup = stop
      },
      'off',
      undefined,
      undefined,
      undefined,
      [],
      ports
    )
    directory = core.directory
    record.pid = core.pid
    const config = await core.read('configs')
    check(
      `${name}: controller reports all four configured ports`,
      config.port === ports.http &&
        config['socks-port'] === ports.socks &&
        config['mixed-port'] === ports.mixed &&
        config['redir-port'] === ports.redir
    )
    check(
      `${name}: TUN and DNS integration remain off`,
      (config.tun as Record<string, unknown>).enable === false
    )
    for (const port of Object.values(ports).filter(Boolean))
      check(
        `${name}: TCP ${port} belongs to exact new child`,
        await ownsHttpListener(core.pid, port)
      )
    for (const port of [ports.socks, ports.mixed].filter(Boolean))
      check(
        `${name}: UDP ${port} belongs to exact new child`,
        await ownsUdpListener(core.pid, port)
      )
    for (const port of [ports.http, ports.mixed].filter(Boolean)) {
      const reply = await fixture.request(port, `http-${port}`)
      check(
        `${name}: HTTP protocol on ${port} reaches loopback origin`,
        reply.includes('200 OK') && reply.includes(`origin:/http-${port}`)
      )
    }
    for (const port of [ports.socks, ports.mixed].filter(Boolean)) {
      const result = await run(
        '/usr/bin/curl',
        [
          '--silent',
          '--show-error',
          '--fail',
          '--max-time',
          '5',
          '--noproxy',
          '',
          '--proxy',
          `socks5h://127.0.0.1:${port}`,
          fixture.healthURL
        ],
        { timeout: 7000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin' } }
      )
      check(
        `${name}: SOCKS5 protocol on ${port} reaches loopback origin`,
        result.stdout === 'origin:/health'
      )
    }
    const before = fixture.stats().originRequests
    const source = JSON.stringify({ proxies: [], 'proxy-groups': [], rules: ['MATCH,REJECT'] })
    // No outbound fallback is used here: test a dedicated blocking rule against
    // the loopback target after an in-place reload that preserves all listeners.
    const { localProxyConfiguration } =
      await import('../../src/main/relay/core/local-proxy-runtime')
    const { profileHash } = await import('../../src/main/relay/profiles/source')
    const current = localProxyConfiguration(
      fixture.source,
      localProxyHTTPPort(ports),
      'off',
      undefined,
      undefined,
      [],
      ports
    )
    const rejected = localProxyConfiguration(
      source,
      localProxyHTTPPort(ports),
      'off',
      undefined,
      undefined,
      [],
      ports
    )
    await core.reload?.(rejected.configuration, profileHash(current.configuration))
    let rejectedReply = ''
    try {
      rejectedReply = await fixture.request(localProxyHTTPPort(ports), 'reject-only')
    } catch {
      /* Expected refused/closed proxy stream. */
    }
    check(
      `${name}: REJECT cannot reach the loopback origin`,
      !rejectedReply.includes('origin:/reject-only') && fixture.stats().originRequests === before
    )
  } finally {
    const cleanupResults = await Promise.allSettled([
      Promise.resolve().then(() => cleanup?.()),
      fixture.close(),
      ...reserved.filter((server) => server.listening).map(closeFixture)
    ])
    for (const item of cleanupResults)
      if (item.status === 'rejected') failures.push(`${name} cleanup: ${String(item.reason)}`)
    if (core) check(`${name}: only held test child stopped`, core.state() === 'stopped')
    if (directory) {
      let missing = false
      try {
        await lstat(directory)
      } catch (error) {
        missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      }
      check(`${name}: owned temporary directory removed`, missing)
    }
    if (ports) {
      for (const port of Object.values(ports).filter(Boolean))
        check(`${name}: TCP ${port} released`, await probeLocalPort(port))
      for (const port of [ports.socks, ports.mixed].filter(Boolean))
        check(`${name}: UDP ${port} released`, await probeLocalUdpPort(port))
    }
  }
}
for (const mixedOnly of [false, true]) {
  try {
    await scenario(mixedOnly)
  } catch (error) {
    failures.push(String(error))
  }
}
const report = {
  recordedAt: new Date().toISOString(),
  resource,
  scenarios,
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  failures,
  architectureExecuted: process.arch,
  localLoopbackFixturesOnly: true,
  existingRelayOrClashTouched: false,
  userConfigurationChanged: false,
  systemProxyDNSRoutesOrTUNChanged: false,
  realClaudeExecuted: false,
  internetTrafficGenerated: false,
  redirTransparentRoutingTested: false
}
const reportPath = resolve(
  process.argv[3] ?? '../evidence/ordinary-multiport-runtime-20261112.json'
)
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
process.stdout.write(
  JSON.stringify({ checks: report.checks, passed: report.passed, failures }) + '\n'
)
if (failures.length || report.passed !== report.checks)
  throw new Error('Ordinary multiport integration failed')
