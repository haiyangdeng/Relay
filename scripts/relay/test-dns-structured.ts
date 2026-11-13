import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  configurationEditDocument,
  defaultEditDocument,
  profileOverridesFor,
  profileRulePatchFor
} from '../../src/shared/relay/configuration-edit'
import { ConfigurationEditStore } from '../../src/main/relay/configuration/edit-store'
import { composeRuntimeConfiguration } from '../../src/main/relay/configuration/merge'
import { relayDnsDocument, relayDnsDraft } from '../../src/renderer/src/utils/relay-dns-config'

// Actual private persistence and existing merge/guard, without DNS queries,
// hosts-file access, Core, Native, Electron, or user data.
const root = await realpath(await mkdtemp('/private/tmp/relay-structured-dns-')),
  stateRoot = join(root, 'Relay'),
  primary = new ConfigurationEditStore({ stateRoot }),
  reopened = new ConfigurationEditStore({ stateRoot }),
  profileId = '11111111-1111-4111-8111-111111111111',
  otherId = '22222222-2222-4222-8222-222222222222',
  sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex'),
  source =
    'proxies: []\nproxy-groups: []\nrules: [MATCH,REJECT]\ndns: {enable: true, nameserver: [127.0.0.1], nameserver-policy: {source.invalid: [127.0.0.9]}}\n',
  original = configurationEditDocument({
    ...defaultEditDocument(),
    globalOverrides: [{ id: 'global', kind: 'yaml', content: 'tcp-concurrent: true\n' }],
    profileId,
    profileOverrides: [{ id: 'legacy', kind: 'yaml', content: 'udp: false\n' }],
    profileOverrideSets: [
      { profileId: otherId, overrides: [{ id: 'other', kind: 'yaml', content: 'ipv6: false\n' }] }
    ],
    profileRulePatchSets: [{ profileId: otherId, rulePatch: { append: ['MATCH,REJECT'] } }],
    overrideLibraryOrder: [profileId],
    rulePatch: { prepend: ['DOMAIN,private-fixture.invalid,REJECT'] },
    controlDns: true,
    controlSniff: false,
    useNameserverPolicy: false,
    disableDnsOverrideGuard: false,
    confirmedDnsFingerprint: 'a'.repeat(64),
    controlled: {
      ipv6: false,
      sniffer: { enable: false },
      dns: {
        enable: true,
        ipv6: false,
        'use-hosts': false,
        'use-system-hosts': false,
        'respect-rules': false,
        nameserver: ['127.0.0.2'],
        listen: '127.0.0.1:0',
        'prefer-h3': false,
        'direct-nameserver-follow-policy': false,
        'ipv6-timeout': 200,
        'fallback-filter': { geoip: true, geosite: ['fixture-only'] },
        'nameserver-policy': {
          'scalar.invalid': 'https://resolver.invalid/query?private=a,b',
          'array.invalid': ['127.0.0.3']
        }
      },
      hosts: { 'scalar.invalid': '127.0.0.4', 'array.invalid': ['127.0.0.5'] }
    }
  }),
  rows: string[] = []

const initial = await primary.read(),
  first = await primary.save(original, initial.revision),
  draft = relayDnsDraft(first.document)
draft.enable = false
draft.ipv6 = true
draft.fallbackGeoip = false
const projected = relayDnsDocument(first.document, draft, { dns: true, hosts: true }),
  dns = projected.controlled.dns as Record<string, unknown>,
  restoredTargets = structuredClone(projected)
restoredTargets.controlled.dns = structuredClone(original.controlled.dns)
restoredTargets.controlled.hosts = structuredClone(original.controlled.hosts)
assert.deepEqual(restoredTargets, original)
assert.equal(projected.controlled.ipv6, false)
assert.equal(dns.ipv6, true)
assert.equal(dns.enable, false)
assert.deepEqual(
  dns['nameserver-policy'],
  (original.controlled.dns as Record<string, unknown>)['nameserver-policy']
)
assert.deepEqual(projected.controlled.hosts, original.controlled.hosts)
assert.equal((dns['fallback-filter'] as Record<string, unknown>).geoip, false)
assert.deepEqual((dns['fallback-filter'] as Record<string, unknown>).geosite, ['fixture-only'])
assert.equal(dns.listen, '127.0.0.1:0')
assert.equal(dns['prefer-h3'], false)
assert.equal(dns['direct-nameserver-follow-policy'], false)
rows.push(
  'Form serialization preserves inactive policy and hosts value shapes, hidden DNS/filter fields, source scopes and fingerprint; DNS IPv6 does not change top-level IPv6'
)

const saved = await primary.save(projected, first.revision)
assert.deepEqual(await reopened.read(), saved)
assert.equal(saved.document.useNameserverPolicy, false)
assert.equal(
  (await lstat(join(stateRoot, 'Configuration/configuration-edit.json'))).mode & 0o777,
  0o600
)
rows.push('Actual private Store reopen retains disabled policy/hosts and explicit false values')

const compose = (document: typeof original, inputSource = source, inputId = profileId) =>
    composeRuntimeConfiguration({
      ...document,
      profileId: inputId,
      source: inputSource,
      profileOverrides: profileOverridesFor(document, inputId),
      profileRulePatch: profileRulePatchFor(document, inputId)
    }),
  blocked = await compose(saved.document)
assert.equal(blocked.dns.requested, true)
assert.equal(blocked.dns.effective, false)
assert.equal(blocked.dns.autoDisabled, true)
assert.equal((blocked.configuration.dns as Record<string, unknown>).enable, true)
assert.match(blocked.dns.fingerprint ?? '', /^[a-f0-9]{64}$/u)
rows.push(
  'Requested DNS control plus a stale unrelated fingerprint cannot bypass the source-specific guard'
)

// This copies only the actual existing preview/merge result into a new CAS;
// it proves storage/guard semantics, not that an Electron user consent occurred.
const confirmed = configurationEditDocument({
    ...saved.document,
    confirmedDnsFingerprint: blocked.dns.fingerprint
  }),
  confirmedRecord = await reopened.save(confirmed, saved.revision),
  accepted = await compose(confirmedRecord.document)
assert.equal(accepted.dns.effective, true)
assert.equal(accepted.dns.autoDisabled, false)
assert.equal((accepted.configuration.dns as Record<string, unknown>).enable, false)
assert.deepEqual((accepted.configuration.dns as Record<string, unknown>)['nameserver-policy'], {
  'source.invalid': ['127.0.0.9']
})
assert.deepEqual(confirmedRecord.document.controlled.dns, saved.document.controlled.dns)
assert.deepEqual(await primary.read(), confirmedRecord)
rows.push(
  'The actual returned source fingerprint enables the existing guarded merge after CAS; disabled controlled policy remains stored while source policy remains effective'
)

for (const result of [
  await compose(confirmedRecord.document, source.replace('127.0.0.9', '127.0.0.8')),
  await compose(confirmedRecord.document, source, otherId)
]) {
  assert.equal(result.dns.effective, false)
  assert.equal(result.dns.autoDisabled, true)
}
const path = join(stateRoot, 'Configuration/configuration-edit.json'),
  before = sha(await readFile(path))
await assert.rejects(primary.save(original, saved.revision), /版本已变化/u)
assert.equal(sha(await readFile(path)), before)
rows.push(
  'Changed source policy or source identity invalidates prior confirmation; a stale Store CAS changes zero file bytes'
)

const flagsDraft = relayDnsDraft(defaultEditDocument())
flagsDraft.controlDns = true
flagsDraft.useNameserverPolicy = true
flagsDraft.disableDnsOverrideGuard = true
const flagsOnly = relayDnsDocument(defaultEditDocument(), flagsDraft, {
  controlDns: true,
  useNameserverPolicy: true,
  disableDnsOverrideGuard: true
})
assert.deepEqual(flagsOnly.controlled, {})
assert.equal(flagsOnly.confirmedDnsFingerprint, undefined)
rows.push('Flag-only projection creates no DNS/hosts body and never invents a source fingerprint')

const inputs = [
    'src/renderer/src/utils/relay-dns-config.ts',
    'src/shared/relay/configuration-edit.ts',
    'src/main/relay/configuration/edit-store.ts',
    'src/main/relay/configuration/merge.ts',
    'scripts/relay/test-dns-structured.ts'
  ],
  sourceHashes = Object.fromEntries(
    await Promise.all(inputs.map(async (path) => [path, sha(await readFile(path))]))
  ),
  evidence = resolve('../evidence/dns-structured-persistence-root-verification-20261101.json')
await writeFile(
  evidence,
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      passed: rows.length,
      failed: 0,
      sourceHashes,
      rows,
      privateFixture: root,
      fixtureRetained: true,
      finalFileSHA256: sha(await readFile(path)),
      scope:
        'Actual private Store and in-process compose with the production DNS form serializer. Fingerprint round-trip is synthetic internal dataflow, not real UI consent. No DNS resolver, traffic or Core parser acceptance claim.',
      networkUsed: false,
      systemHostsRead: false,
      appOrNativeOrCoreExecuted: false,
      systemNetworkChanged: false,
      currentClashOrMihomoStopped: false,
      productAcceptance: 'pending'
    },
    null,
    2
  ) + '\n',
  { mode: 0o600 }
)
console.warn(JSON.stringify({ passed: rows.length, failed: 0, evidence }))
