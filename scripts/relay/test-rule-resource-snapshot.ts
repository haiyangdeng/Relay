import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { ResourceStore } from '../../src/main/relay/resources/store'
import { createProfileService } from '../../src/main/relay/profiles/service'
import {
  localProxyConfiguration,
  startLocalProxyCore
} from '../../src/main/relay/core/local-proxy-runtime'
import { profileHash } from '../../src/main/relay/profiles/source'
import { probeLocalPort } from '../../src/main/relay/core/port'
import { convertRuleMRS } from '../../src/main/relay/resources/mrs-convert'
import { resourceHash } from '../../src/main/relay/resources/source'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'
import { mrsFixture } from './fixtures/mrs'

const home = await realpath(await mkdtemp('/private/tmp/relay-rule-snapshot-'))
const mrs = process.env.RELAY_RULE_SNAPSHOT_FORMAT === 'mrs',
  coreRoot = resolve('extra/relay/core')
const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
const profiles = new ProfileStore(context),
  resources = new ResourceStore(context)
const network = await createLocalNetworkFixture(),
  port = await freeFixturePort(),
  checks: string[] = []
let confirmed = false,
  cleanupOwn: (() => Promise<void>) | undefined
const service = createProfileService({
  pick: async () => undefined,
  list: () => profiles.list(),
  read: (selection) => profiles.read(selection),
  readRuleResource: (selection) => resources.read(selection, 2 * 1024 * 1024),
  convertRuleMRS: (job) => convertRuleMRS(coreRoot, job),
  save: (name, text) => profiles.save(name, text),
  confirm: async () => confirmed
})
try {
  const source = JSON.stringify({
    ...JSON.parse(network.source),
    'rule-providers': {
      CachedRules: {
        type: 'http',
        behavior: 'ipcidr',
        url: 'https://PRIVATE-never-requested.invalid/rules',
        path: join(home, 'PRIVATE-never-read.yaml'),
        interval: 1,
        header: { Authorization: ['PRIVATE-token'] }
      }
    },
    rules: [`RULE-SET,CachedRules,${network.group},no-resolve`, 'MATCH,REJECT']
  })
  assert.throws(() => localProxyConfiguration(source, port))
  const original = await profiles.save('External rule source', source),
    selection = { id: original.id, sha256: original.sha256 }
  const first = await resources.save(
    {
      name: mrs ? 'MRS rules' : 'YAML rules',
      kind: mrs ? 'rule-mrs' : 'rule-yaml',
      behavior: 'ipcidr',
      selector: ''
    },
    mrs ? await mrsFixture(coreRoot, 'ipcidr') : Buffer.from('payload:\n  - 127.0.0.0/8\n')
  )
  const request = {
    profile: selection,
    provider: 'CachedRules',
    resource: { id: first.id, sha256: first.sha256 }
  }
  const prepared = await service.prepareRuleSnapshot(request)
  assert.ok(!JSON.stringify(prepared).includes('PRIVATE'))
  assert.deepEqual(prepared.ruleSnapshot, {
    provider: 'CachedRules',
    resourceSHA256: first.sha256,
    behavior: 'ipcidr',
    rules: mrs ? 2 : 1
  })
  assert.equal((await profiles.list()).profiles.length, 1)
  checks.push(
    'the external definition cannot run directly and cache preparation returns only bound transformation metadata'
  )
  assert.equal((await service.save({ evidenceId: prepared.evidenceId })).status, 'cancelled')
  assert.equal((await profiles.list()).profiles.length, 1)
  checks.push('native cancellation creates no snapshot or source mutation')
  const approved = await service.prepareRuleSnapshot(request)
  confirmed = true
  const saved = await service.save({ evidenceId: approved.evidenceId })
  if (!saved.profile) throw new Error('snapshot publication missing')
  const frozen = await profiles.read({ id: saved.profile.id, sha256: saved.profile.sha256 })
  assert.deepEqual(JSON.parse(frozen.text)['rule-providers'].CachedRules, {
    type: 'inline',
    behavior: 'ipcidr',
    payload: mrs ? ['127.0.0.0/8', '::1/128'] : ['127.0.0.0/8']
  })
  assert.equal((await profiles.read(selection)).text, source)
  checks.push(
    `confirmed ${mrs ? 'sandbox-converted MRS' : 'YAML'} freezing saves an independent inline definition and preserves original acquisition options only in the original profile`
  )
  await rm(join(resources.directory, first.id), { recursive: true })
  const built = localProxyConfiguration(frozen.text, port)
  const core = await startLocalProxyCore(coreRoot, frozen.text, port, (stop) => {
    cleanupOwn = stop
  })
  const pid = core.pid
  assert.ok(
    (await network.request(port, 'from-frozen-cache')).includes('origin:/from-frozen-cache')
  )
  assert.equal(network.stats().originRequests, 1)
  checks.push(
    'after deleting the owned test cache the saved inline copy still routes real HTTP through its declared loopback fixture proxy'
  )
  const second = await resources.save(
    { name: 'Text rules', kind: 'rule-text', behavior: 'ipcidr', selector: '' },
    Buffer.from('# fixture\n192.0.2.0/24\n')
  )
  const nextPrepared = await service.prepareRuleSnapshot({
    ...request,
    resource: { id: second.id, sha256: second.sha256 }
  })
  const nextSaved = await service.save({ evidenceId: nextPrepared.evidenceId })
  if (!nextSaved.profile) throw new Error('text snapshot missing')
  const nextSource = await profiles.read({
    id: nextSaved.profile.id,
    sha256: nextSaved.profile.sha256
  })
  assert.ok((await network.request(port, 'not-auto-applied')).includes('origin:/not-auto-applied'))
  assert.equal(network.stats().originRequests, 2)
  checks.push(
    'publishing a different text cache does not automatically apply it to the active owned instance'
  )
  const next = localProxyConfiguration(nextSource.text, port)
  if (!core.reload) throw new Error('reload unavailable')
  await core.reload(next.configuration, profileHash(built.configuration))
  assert.equal(core.pid, pid)
  let blocked = false
  try {
    blocked = !(await network.request(port, 'must-not-arrive')).includes('200 OK')
  } catch {
    blocked = true
  }
  assert.equal(blocked, true)
  assert.equal(network.stats().originRequests, 2)
  checks.push('only explicit same-PID reload changes routing to the new cache-derived payload')
  await core.reload(built.configuration, profileHash(next.configuration))
  assert.ok((await network.request(port, 'restored-inline')).includes('origin:/restored-inline'))
  assert.equal(network.stats().originRequests, 3)
  checks.push(
    'the retained independent snapshot restores the route without its original cache file'
  )
  const directory = core.directory
  await core.stop()
  assert.equal(core.state(), 'stopped')
  await assert.rejects(lstat(directory), { code: 'ENOENT' })
  assert.ok(await probeLocalPort(port))
  checks.push('only the new child is stopped and its private directory and listener are released')
  if (mrs) {
    const bytes = await mrsFixture(coreRoot, 'domain')
    const converted = await convertRuleMRS(coreRoot, {
      descriptor: {
        name: 'Domain MRS fixture',
        kind: 'rule-mrs',
        behavior: 'domain',
        selector: ''
      },
      bytes,
      sha256: resourceHash(bytes)
    })
    assert.ok(converted.entries.includes('fixture.invalid'))
    const domainSource = JSON.stringify({
      ...JSON.parse(network.source),
      'rule-providers': {
        DomainFixture: { type: 'inline', behavior: 'domain', payload: converted.entries }
      },
      rules: ['RULE-SET,DomainFixture,REJECT', 'MATCH,REJECT']
    })
    const domainCore = await startLocalProxyCore(coreRoot, domainSource, port, (stop) => {
      cleanupOwn = stop
    })
    const providers = await domainCore.read('providers/rules')
    const domainProvider = (providers.providers as Record<string, { ruleCount: number }>)
      .DomainFixture
    assert.ok(domainProvider.ruleCount > 0)
    await domainCore.stop()
    assert.ok(await probeLocalPort(port))
    assert.equal(network.stats().originRequests, 3)
    checks.push(
      'the fixed converter also dumps domain MRS and its inline output initializes in a new isolated core without external domain traffic'
    )
  }
  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: 'real-private-rule-cache-freezing-and-owned-ARM-loopback-runtime',
    checks,
    passed: checks.length,
    snapshotFormatsVerified: [mrs ? 'mrs' : 'yaml', 'text'],
    sourcePreserved: true,
    cachedResourceRemovableAfterPublication: true,
    nativeElectronWindowAccepted: false,
    originalResourceUrlOrPathRead: false,
    systemNetworkChanged: false,
    currentClashOrMihomoStopped: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    mrs
      ? '../evidence/rule-mrs-snapshot-verification.json'
      : '../evidence/rule-resource-snapshot-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await cleanupOwn?.()
  await network.close()
  await rm(home, { recursive: true, force: true })
}
