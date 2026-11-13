import assert from 'node:assert/strict'
import { lstat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  localProxyConfiguration,
  startLocalProxyCore
} from '../../src/main/relay/core/local-proxy-runtime'
import { ownsHttpListener, probeLocalPort } from '../../src/main/relay/core/port'
import { profileHash } from '../../src/main/relay/profiles/source'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'

const checks: string[] = []
const behavior = process.env.RELAY_INLINE_RULE_BEHAVIOR ?? 'ipcidr'
if (!['ipcidr', 'classical'].includes(behavior))
  throw new Error('unsupported inline fixture behavior')
const classicalPayload = [
  'DOMAIN,blocked.invalid',
  'DOMAIN-SUFFIX,blocked.invalid',
  'DOMAIN-KEYWORD,blocked',
  'IP-CIDR,127.0.0.0/8,no-resolve',
  'IP-CIDR6,::1/128,no-resolve'
]
const network = await createLocalNetworkFixture(),
  port = await freeFixturePort()
const source = JSON.stringify({
  ...JSON.parse(network.source),
  'rule-providers': {
    Domains: { type: 'inline', behavior: 'domain', payload: ['+.blocked.invalid'] },
    Loopback: {
      type: 'inline',
      behavior,
      payload: behavior === 'classical' ? classicalPayload : ['127.0.0.0/8']
    }
  },
  rules: [
    'RULE-SET,Domains,REJECT',
    `RULE-SET,Loopback,${network.group},no-resolve`,
    'MATCH,REJECT'
  ]
})
let core: Awaited<ReturnType<typeof startLocalProxyCore>> | undefined,
  cleanupOwn: (() => Promise<void>) | undefined
try {
  for (const definition of [
    { type: 'file', behavior: 'domain', path: '/private/not-read' },
    { type: 'http', behavior: 'domain', url: 'https://never-requested.invalid' },
    { type: 'inline', behavior: 'classical', payload: ['GEOIP,CN'] }
  ])
    assert.throws(() =>
      localProxyConfiguration(
        JSON.stringify({ 'rule-providers': { Refused: definition }, rules: ['MATCH,REJECT'] }),
        port
      )
    )
  checks.push(
    'external and geodata-dependent sets are refused before any child or resource request'
  )
  const built = localProxyConfiguration(source, port),
    configuration = JSON.parse(built.configuration)
  assert.equal(configuration.dns.enable, false)
  assert.equal(configuration.tun.enable, false)
  assert.equal(configuration['mixed-port'], 0)
  assert.equal(configuration['socks-port'], 0)
  assert.equal(configuration['geo-auto-update'], false)
  checks.push('only the owned loopback HTTP port is enabled with DNS/TUN/geodata updates disabled')
  core = await startLocalProxyCore(resolve('extra/relay/core'), source, port, (stop) => {
    cleanupOwn = stop
  })
  assert.ok(await ownsHttpListener(core.pid, port))
  const pid = core.pid,
    providers = (await core.read('providers/rules')).providers
  assert.ok(providers && typeof providers === 'object')
  const values = providers as Record<string, Record<string, unknown>>
  assert.equal(values.Domains.ruleCount, 1)
  assert.equal(values.Loopback.ruleCount, behavior === 'classical' ? 5 : 1)
  checks.push(
    `the actual verified ARM core loads in-memory domain and ${behavior} providers with the full expected entry count`
  )
  const response = await network.request(port, 'inline-cidr-route')
  assert.ok(response.includes('200 OK') && response.includes('origin:/inline-cidr-route'))
  assert.deepEqual(network.stats(), { originRequests: 1, usedA: 1, usedB: 0 })
  checks.push(
    'the CIDR rule routes real HTTP through the declared owned fixture proxy to its loopback origin'
  )
  const changed = JSON.parse(source)
  changed['rule-providers'].Loopback.payload =
    behavior === 'classical'
      ? classicalPayload.map((line) =>
          line.startsWith('IP-CIDR,') ? 'IP-CIDR,192.0.2.0/24,no-resolve' : line
        )
      : ['192.0.2.0/24']
  const next = localProxyConfiguration(JSON.stringify(changed), port)
  if (!core.reload) throw new Error('controlled reload unavailable')
  // The reload guard binds the current instance bytes, not the candidate hash.
  await core.reload(next.configuration, profileHash(built.configuration))
  assert.equal(core.pid, pid)
  assert.equal(core.state(), 'running')
  checks.push(
    'changed inline payload reloads in the same owned PID and keeps the same HTTP listener'
  )
  let blocked = false
  try {
    blocked = !(await network.request(port, 'must-be-rejected')).includes('200 OK')
  } catch {
    blocked = true
  }
  assert.equal(blocked, true)
  assert.equal(network.stats().originRequests, 1)
  checks.push(
    'after payload replacement the unmatched request is rejected without reaching the origin or falling back DIRECT'
  )
  await core.reload(built.configuration, profileHash(next.configuration))
  assert.ok((await network.request(port, 'inline-restored')).includes('origin:/inline-restored'))
  assert.equal(network.stats().originRequests, 2)
  checks.push(
    'explicit restoration of the original payload restores the rule route without restarting'
  )
  const directory = core.directory
  await core.stop()
  assert.equal(core.state(), 'stopped')
  await assert.rejects(lstat(directory), { code: 'ENOENT' })
  assert.ok(await probeLocalPort(port))
  checks.push(
    'only the newly owned child is stopped and its private runtime directory and HTTP port are released'
  )
  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: `actual-owned-arm-core-inline-domain-and-${behavior}-loopback-routing`,
    contractTests: behavior === 'classical' ? 59 : 45,
    checks,
    passed: checks.length,
    samePidReloadVerified: true,
    domainProviderLoaded: true,
    domainInternetTrafficTested: false,
    basicClassicalTypesParsed: behavior === 'classical',
    ipv6TrafficExercised: false,
    externalRuleResourceRead: false,
    actualSystemConfigurationChanged: false,
    currentClashOrMihomoStopped: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    behavior === 'classical'
      ? '../evidence/classical-inline-rule-runtime-verification.json'
      : '../evidence/inline-rule-runtime-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await cleanupOwn?.()
  await network.close()
}
