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
import {
  snifferDocument,
  snifferDraft
} from '../../src/renderer/src/hooks/use-relay-sniffer-config'

// One private persistence/CAS/merge workflow, independent of the injected UI
// runner. No Core, Native, Electron, network, or user data is used here.
const root = await realpath(await mkdtemp('/private/tmp/relay-structured-sniffer-')),
  stateRoot = join(root, 'Relay'),
  primary = new ConfigurationEditStore({ stateRoot }),
  reopened = new ConfigurationEditStore({ stateRoot }),
  profileId = '11111111-1111-4111-8111-111111111111',
  otherId = '22222222-2222-4222-8222-222222222222',
  sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex'),
  source =
    'proxies: []\nproxy-groups: []\nrules: [MATCH,REJECT]\nsniffer: {enable: true, parse-pure-ip: true, force-dns-mapping: true, override-destination: true}\n',
  document = configurationEditDocument({
    ...defaultEditDocument(),
    globalOverrides: [{ id: 'global', kind: 'yaml', content: 'tcp-concurrent: true\n' }],
    profileId,
    profileOverrides: [{ id: 'legacy', kind: 'yaml', content: 'udp: false\n' }],
    profileOverrideSets: [
      {
        profileId: otherId,
        overrides: [{ id: 'other', kind: 'yaml', content: 'keep-alive-interval: 30\n' }]
      }
    ],
    profileRulePatchSets: [{ profileId: otherId, rulePatch: { append: ['MATCH,REJECT'] } }],
    overrideLibraryOrder: [profileId],
    rulePatch: { prepend: ['DOMAIN,private-fixture.invalid,REJECT'] },
    controlDns: false,
    controlSniff: false,
    useNameserverPolicy: false,
    disableDnsOverrideGuard: false,
    confirmedDnsFingerprint: 'a'.repeat(64),
    controlled: {
      dns: { enable: false, ipv6: false, 'nameserver-policy': { 'fixture.invalid': '127.0.0.1' } },
      hosts: { 'fixture.invalid': '127.0.0.1' },
      ipv6: false,
      sniffer: {
        enable: true,
        'parse-pure-ip': true,
        'force-dns-mapping': true,
        'override-destination': true,
        sniffing: ['tls'],
        'port-whitelist': ['443'],
        sniff: {
          HTTP: { ports: ['8080-8090'], 'override-destination': false },
          TLS: { 'override-destination': false },
          QUIC: { ports: [], 'override-destination': false }
        }
      }
    }
  }),
  rows: string[] = []

const initial = await primary.read()
assert.equal(initial.exists, false)
assert.equal(initial.revision, '')
const first = await primary.save(document, initial.revision),
  draft = snifferDraft(first.document)
draft.values.enable = false
draft.values.parsePureIP = false
draft.values.forceDNSMapping = false
draft.values.overrideDestination = false
const next = snifferDocument(first.document, draft, true, false, false),
  sniffer = next.controlled.sniffer as Record<string, unknown>,
  unchanged = structuredClone(next)
unchanged.controlled.sniffer = structuredClone(first.document.controlled.sniffer)
assert.deepEqual(unchanged, first.document)
assert.deepEqual(
  sniffer.sniff,
  document.controlled.sniffer && (document.controlled.sniffer as Record<string, unknown>).sniff
)
assert.equal(Object.hasOwn(sniffer, 'force-domain'), false)
assert.equal(Object.hasOwn(sniffer, 'skip-src-address'), false)
for (const field of ['enable', 'parse-pure-ip', 'force-dns-mapping', 'override-destination'])
  assert.equal(sniffer[field], false)
rows.push(
  'Form projection retains all unrelated scopes and optional protocol ports while persisting four explicit false values'
)

const saved = await primary.save(next, first.revision),
  actual = await reopened.read()
assert.deepEqual(actual, saved)
const path = join(stateRoot, 'Configuration/configuration-edit.json'),
  beforeStale = sha(await readFile(path))
await assert.rejects(reopened.save(document, first.revision), /版本已变化/u)
assert.equal(sha(await readFile(path)), beforeStale)
assert.deepEqual(await primary.read(), saved)
assert.equal((await lstat(path)).mode & 0o777, 0o600)
rows.push(
  'Two actual Store instances round-trip the exact form document; stale CAS rejects without changing private file bytes'
)

const compose = (value: typeof document) =>
  composeRuntimeConfiguration({
    ...value,
    profileId,
    source,
    profileOverrides: profileOverridesFor(value, profileId),
    profileRulePatch: profileRulePatchFor(value, profileId)
  })
const ignored = await compose(saved.document),
  sourceSniffer = ignored.configuration.sniffer as Record<string, unknown>
assert.equal(sourceSniffer.enable, true)
assert.equal(sourceSniffer['parse-pure-ip'], true)
rows.push(
  'controlSniff=false ignores controlled Sniffer while preserving the source enabled configuration'
)

const enabled = snifferDocument(saved.document, snifferDraft(saved.document), false, true, true)
assert.deepEqual(enabled.controlled, saved.document.controlled)
const enabledRecord = await reopened.save(enabled, saved.revision),
  merged = await compose(enabledRecord.document),
  effective = merged.configuration.sniffer as Record<string, unknown>
for (const field of ['enable', 'parse-pure-ip', 'force-dns-mapping', 'override-destination'])
  assert.equal(effective[field], false)
assert.deepEqual(effective.sniff, sniffer.sniff)
assert.deepEqual(effective.sniffing, ['tls'])
assert.deepEqual(effective['port-whitelist'], ['443'])
rows.push(
  'Explicit control-only save preserves the exact body; existing compose applies false fields and hidden protocol settings'
)

const defaults = defaultEditDocument(),
  defaultsBody = snifferDocument(defaults, snifferDraft(defaults), true, true, false),
  protocols = (defaultsBody.controlled.sniffer as Record<string, unknown>).sniff as Record<
    string,
    { ports?: unknown[] }
  >
assert.deepEqual(protocols.HTTP.ports, ['80', '443'])
assert.deepEqual(protocols.TLS.ports, ['443'])
assert.equal(Object.hasOwn(protocols, 'QUIC'), false)
assert.deepEqual(snifferDocument(defaults, snifferDraft(defaults), false, false, true), {
  ...defaults,
  controlSniff: false
})
rows.push(
  'Numeric upstream defaults convert to strings only for explicit body saves; control-only save never materializes a default body'
)

const inputs = [
    'src/renderer/src/hooks/use-relay-sniffer-config.tsx',
    'src/shared/relay/configuration-edit.ts',
    'src/main/relay/configuration/edit-store.ts',
    'src/main/relay/configuration/merge.ts',
    'scripts/relay/test-sniffer-structured.ts'
  ],
  sourceHashes = Object.fromEntries(
    await Promise.all(inputs.map(async (path) => [path, sha(await readFile(path))]))
  ),
  output = resolve('../evidence/sniffer-structured-persistence-root-verification-20261101.json')
await writeFile(
  output,
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      passed: rows.length,
      failed: 0,
      sourceHashes,
      rows,
      privateFixture: root,
      fixtureRetained: true,
      finalRevision: enabledRecord.revision,
      finalFileSHA256: sha(await readFile(path)),
      scope:
        'Actual private Store/CAS plus existing in-process compose, using the production form serializer. No Core parser/traffic or native App acceptance claim.',
      networkUsed: false,
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
console.warn(JSON.stringify({ passed: rows.length, failed: 0, evidence: output }))
