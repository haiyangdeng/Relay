// Isolated stores and child parsers only. No account, listener or live data.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import { RelayBackupStore } from '../../src/main/relay/backup/store'
import { recoveryFixtureAdapters } from '../../src/main/relay/backup/recovery.test-fixture'
import { prepareLegacyMigrationRecord } from '../../src/main/relay/backup/legacy-record'
import { backupHash, backupSnapshotSHA256 } from '../../src/main/relay/backup/archive'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { ResourceStore } from '../../src/main/relay/resources/store'
import { SubscriptionSourceStore } from '../../src/main/relay/subscriptions/source-store'
import { ConfigurationEditStore } from '../../src/main/relay/configuration/edit-store'
import { createConfigurationEditService } from '../../src/main/relay/configuration/edit-service'
import { createCompleteConfigurationService } from '../../src/main/relay/configuration/service'
import { runConfigurationScript } from '../../src/main/relay/configuration/script'
import { checkCompleteConfiguration } from '../../src/main/relay/configuration/checker'
import { defaultEditDocument } from '../../src/shared/relay/configuration-edit'
import { backupFileNative } from '../../src/main/relay/native'

const home = await realpath(await mkdtemp('/private/tmp/relay-legacy-runtime-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
  native = process.env.RELAY_BACKUP_MOVE_EXECUTABLE ?? resolve('extra/relay/RelayNative'),
  checks: string[] = []
try {
  const profiles = new ProfileStore(context),
    edits = new ConfigurationEditStore(context),
    original = await profiles.save('Existing source', 'rules: ["MATCH,REJECT"]')
  await edits.save({
    ...defaultEditDocument(),
    globalOverrides: [{ id: 'existing-global', kind: 'yaml', content: 'ipv6: false' }]
  })
  await writeFile(join(context.stateRoot, 'preferences.json'), '{"preserve":"existing"}', {
    mode: 0o600
  })
  const store = new RelayBackupStore(context, recoveryFixtureAdapters(context)),
    baseline = await store.snapshot(),
    baselineSHA256 = backupSnapshotSHA256(baseline),
    zip = new AdmZip()
  const script = `function main(config) {
    if (config.rules[0] !== 'DOMAIN,source.fixture.test,G' || !config['tcp-concurrent'])
      throw new Error('merge priority changed');
    config.rules.unshift('DOMAIN,smart.fixture.test,G');
    return config;
  }`
  for (const [path, text] of Object.entries({
    'profile.yaml': JSON.stringify({
      current: 'old',
      items: [
        {
          id: 'old',
          type: 'remote',
          name: 'Migrated source',
          url: 'https://subscription.invalid/private',
          authToken: 'fixture-private-token',
          autoUpdate: true,
          override: ['smart-core-override']
        }
      ]
    }),
    'profiles/old.yaml':
      'proxies: [{name: N, type: http, server: 127.0.0.1, port: 1}]\nproxy-groups: [{name: G, type: select, proxies: [N]}]\nrules: ["MATCH,G"]\n',
    'override.yaml': JSON.stringify({
      items: [
        { id: 'global', name: 'Global', type: 'local', ext: 'yaml', global: true },
        { id: 'smart-core-override', name: 'Smart', type: 'local', ext: 'js' }
      ]
    }),
    'override/global.yaml': 'tcp-concurrent: true\n+rules: ["DOMAIN,global.fixture.test,G"]\n',
    'override/smart-core-override.js': script,
    'rules/old.yaml': 'prepend: ["DOMAIN,source.fixture.test,G"]',
    'config.yaml': 'autoLaunch: true\n',
    'mihomo.yaml': 'mixed-port: 7890\ntun: {enable: true}\n',
    'themes/preserved.css': 'body {color:red}',
    'substore/preserved.json': '{"version":"unknown"}'
  }))
    zip.addFile(path, Buffer.from(text))
  const bytes = zip.toBuffer(),
    prepared = await prepareLegacyMigrationRecord(
      context,
      bytes,
      baseline,
      17891,
      new AbortController().signal,
      (request) => backupFileNative(native, context, request)
    )
  assert.ok(prepared.archiveBytes)
  assert.equal(backupSnapshotSHA256(await store.snapshot()), baselineSHA256)
  assert.equal(
    backupHash(
      await readFile(join(context.stateRoot, 'Migrations', prepared.migrationId, 'original.zip'))
    ),
    backupHash(bytes)
  )
  assert.equal(JSON.stringify(prepared.report).includes('fixture-private-token'), false)
  checks.push('legacy preparation retains exact original privately and does not publish live data')
  const plan = await store.stageRestore(prepared.archiveBytes, prepared.expectedBaselineSHA256)
  await prepared.recordPlan(plan)
  assert.equal(await store.commitRestore(plan.id, plan.baselineSHA256, () => {}), 'restored')
  assert.equal((await profiles.list()).profiles.length, 2)
  assert.equal(
    (await profiles.read({ id: original.id, sha256: original.sha256 })).text,
    'rules: ["MATCH,REJECT"]'
  )
  assert.equal(
    await readFile(join(context.stateRoot, 'preferences.json'), 'utf8'),
    '{"preserve":"existing"}'
  )
  checks.push(
    'real native exclusive moves publish the additive candidate and preserve existing source/preferences'
  )
  const migrated = prepared.report.profiles[0]
  assert.ok(migrated.profileId && migrated.sourceId)
  const source = await new SubscriptionSourceStore(context).readId(migrated.sourceId)
  assert.equal(source.options.headers.authorization, 'fixture-private-token')
  assert.equal(source.options.schedule.kind, 'manual')
  assert.equal(source.options.useServerInterval, false)
  checks.push('migrated remote definition keeps credentials but grants no automatic scheduling')
  const complete = createCompleteConfigurationService({
      profiles,
      providers: new ProfileStore(context, 'ProviderResources'),
      resources: new ResourceStore(context),
      script: (code, configuration, signal) =>
        runConfigurationScript(resolve('extra/relay/RelayNative'), code, configuration, signal),
      check: (source, assets, signal) =>
        checkCompleteConfiguration(resolve('extra/relay/core'), source, assets, signal)
    }),
    editor = createConfigurationEditService({
      store: edits,
      profiles,
      prepare: (request, recheck) => complete.prepare(request, recheck)
    }),
    selected = (await profiles.list()).profiles.find((p) => p.id === migrated.profileId)
  assert.ok(selected)
  const editRecord = await editor.read(),
    candidate = await editor.prepare({
      profile: { id: selected.id, sha256: selected.sha256 },
      revision: editRecord.revision,
      bindings: []
    })
  assert.equal((await complete.check({ evidenceId: candidate.evidenceId })).status, 'passed')
  const checked = await complete.takeChecked({ evidenceId: candidate.evidenceId }),
    configuration = JSON.parse(checked.configuration)
  assert.deepEqual(configuration.rules, [
    'DOMAIN,smart.fixture.test,G',
    'DOMAIN,source.fixture.test,G',
    'DOMAIN,global.fixture.test,G',
    'MATCH,G'
  ])
  assert.equal(configuration['tcp-concurrent'], true)
  assert.equal(configuration.ipv6, false)
  await checked.recheck()
  checks.push(
    'actual JS worker and fixed deny-network Mihomo parser verify migrated override/rule priority'
  )
  complete.clear()
  const restarted = new RelayBackupStore(context, recoveryFixtureAdapters(context)),
    rollback = await restarted.prepareRecovery({ id: plan.id, action: 'rollback' })
  assert.equal(await restarted.commitRecovery(rollback.evidenceId, () => {}), 'rolled-back')
  assert.equal(backupSnapshotSHA256(await restarted.snapshot()), baselineSHA256)
  assert.equal((await profiles.list()).profiles.length, 1)
  assert.equal((await restarted.unresolved()).length, 0)
  checks.push(
    'fresh store verifies recovery history and real native rollback restores the exact baseline'
  )
  const evidence = {
    verifiedAt: new Date().toISOString(),
    scope: 'legacy ZIP to native restore to actual script/parser to fresh-store rollback',
    architecture: process.arch,
    checks,
    actualUserDataTouched: false,
    coreParserExecuted: true,
    listenersStarted: false,
    systemNetworkChanged: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    '../evidence/backup-legacy-runtime-verification.json',
    JSON.stringify(evidence, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
} finally {
  await rm(home, { recursive: true, force: true })
}
