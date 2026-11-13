import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { legacyClashMigrationRequest } from '../../../shared/relay/legacy-clash'
import { defaultEditDocument } from '../../../shared/relay/configuration-edit'
import { encryptAgeContent, generateAgeKeyPair } from '../../utils/age'
import { ProfileStore } from '../profiles/store'
import { ConfigurationEditStore } from '../configuration/edit-store'
import { SubscriptionSourceStore } from '../subscriptions/source-store'
import { backupHash, backupSnapshotSHA256, readBackupArchive } from './archive'
import { RelayBackupStore } from './store'
import { recoveryFixtureAdapters } from './recovery.test-fixture'
import { convertLegacyClashArchive, parseLegacyClashArchive } from './legacy-clash'

afterEach(() => vi.restoreAllMocks())
const config =
  'proxies: [{name: Node, type: http, server: 127.0.0.1, port: 1234}]\nproxy-groups: [{name: G, type: select, proxies: [Node]}]\nrules: ["MATCH,G"]\n'
const script = 'function main(config) { throw new Error("JS_MUST_NOT_RUN"); }'
function legacy(overrides: Record<string, string | undefined> = {}): Buffer {
  const files: Record<string, string | undefined> = {
    'config.yaml': 'githubToken: PRIVATE-GITHUB\nuserAgent: PRIVATE-UA\n',
    'mihomo.yaml': 'mixed-port: 7890\ntun: {enable: true}\n',
    'profile.yaml': JSON.stringify({
      current: 'remote',
      items: [
        {
          id: 'remote',
          type: 'remote',
          name: 'Imported remote',
          url: 'https://subscriptions.example/private?token=PRIVATE-URL',
          authToken: 'PRIVATE-AUTH',
          autoUpdate: true,
          override: ['local', 'global', 'smart-core-override']
        },
        { id: 'local', type: 'local', name: 'Imported local', override: [] }
      ]
    }),
    'override.yaml': JSON.stringify({
      items: [
        { id: 'global', type: 'local', ext: 'yaml', name: 'Global', global: true, updated: 1 },
        { id: 'local', type: 'local', ext: 'yaml', name: 'Local', global: false, updated: 1 },
        {
          id: 'smart-core-override',
          type: 'local',
          ext: 'js',
          name: 'Smart',
          global: false,
          updated: 1
        }
      ]
    }),
    'profiles/remote.yaml': config,
    'profiles/local.yaml': config,
    'override/global.yaml': 'ipv6: false\n',
    'override/local.yaml': 'tcp-concurrent: true\n',
    'override/smart-core-override.js': script,
    'override/smart-core-override.log': 'PRIVATE-diagnostic-content',
    'rules/remote.yaml': 'prepend: ["DOMAIN,legacy.test,G"]\nappend: []\ndelete: []\n',
    'themes/custom.css': 'body { color: red }',
    'substore/sub-store.json': '{"PRIVATE":"unverified-data-version"}',
    ...overrides
  }
  const zip = new AdmZip()
  for (const [path, value] of Object.entries(files))
    if (value !== undefined) zip.addFile(path, Buffer.from(value))
  return zip.toBuffer()
}
async function fixture(
  run: (input: {
    home: string
    context: { home: string; stateRoot: string }
    store: RelayBackupStore
    baseline: Awaited<ReturnType<RelayBackupStore['snapshot']>>
    temporaryHome: string
    originalId: string
    originalEdits: Awaited<ReturnType<ConfigurationEditStore['read']>>['document']
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-legacy-clash-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
  try {
    const original = await new ProfileStore(context).save('Existing', config),
      edits = new ConfigurationEditStore(context),
      originalEdits = (
        await edits.save({
          ...defaultEditDocument(),
          globalOverrides: [{ id: 'existing-global', kind: 'yaml', content: 'ipv6: true' }],
          profileRulePatchSets: [
            { profileId: original.id, rulePatch: { prepend: ['DOMAIN,existing.test,G'] } }
          ]
        })
      ).document
    await mkdir(join(context.stateRoot, 'Core'), { mode: 0o700 })
    await writeFile(join(context.stateRoot, 'Core/selection.json'), 'PRIVATE-original-selection', {
      mode: 0o600
    })
    await writeFile(join(context.stateRoot, 'preferences.json'), 'PRIVATE-original-preferences', {
      mode: 0o600
    })
    const temporaryHome = join(home, 'migration-temporary-home')
    await mkdir(temporaryHome, { mode: 0o700 })
    const store = new RelayBackupStore(context, recoveryFixtureAdapters(context))
    await run({
      home,
      context,
      store,
      baseline: await store.snapshot(),
      temporaryHome,
      originalId: original.id,
      originalEdits
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
describe('Fixed Clash Party ZIP conversion into an additive Relay candidate', () => {
  it('limits the public request to an optional proxy port and recognizes the fixed index layout', () => {
    expect(legacyClashMigrationRequest(undefined)).toEqual({})
    expect(legacyClashMigrationRequest({ proxyPort: 17891 })).toEqual({ proxyPort: 17891 })
    for (const input of [
      { path: '/PRIVATE' },
      { bytes: 'PRIVATE' },
      { proxyPort: 0 },
      { proxyPort: 65536 }
    ])
      expect(() => legacyClashMigrationRequest(input)).toThrow()
    const parsed = parseLegacyClashArchive(legacy())
    expect(parsed.profiles.map((p) => p.id)).toEqual(['remote', 'local'])
    expect(parsed.overrides.map((p) => p.id)).toEqual(['global', 'local', 'smart-core-override'])
  })
  it('retains Finder metadata included by the upstream addLocalFolder backup without applying it', async () => {
    const folder = await realpath(await mkdtemp('/private/tmp/relay-legacy-finder-')),
      metadata = Buffer.from('PRIVATE-Finder-metadata'),
      zip = new AdmZip(legacy()),
      roots = ['profiles', 'override', 'rules', 'themes', 'substore']
    try {
      await writeFile(join(folder, '.DS_Store'), metadata, { mode: 0o600 })
      for (const root of roots) zip.addLocalFolder(folder, root)
      const bytes = zip.toBuffer(),
        parsed = parseLegacyClashArchive(bytes)
      for (const root of roots) expect(parsed.files.get(root + '/.DS_Store')).toEqual(metadata)
      await fixture(async ({ baseline, temporaryHome }) => {
        const converted = await convertLegacyClashArchive({
          bytes,
          baseline,
          temporaryHome,
          signal: new AbortController().signal
        })
        expect(converted.report.profiles).toHaveLength(2)
        for (const root of roots)
          expect(
            converted.report.files.find((item) => item.path === root + '/.DS_Store')
          ).toMatchObject({
            disposition: 'retained',
            sha256: backupHash(metadata)
          })
        expect(JSON.stringify(converted.report)).not.toContain(metadata.toString())
        if (!converted.archiveBytes) throw new Error('No merged candidate')
        expect(
          readBackupArchive(converted.archiveBytes).snapshot.entries.some((entry) =>
            entry.path.endsWith('/.DS_Store')
          )
        ).toBe(false)
      })
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
  it('uses real isolated stores, preserves all baseline files, scopes rules/overrides to new IDs and never runs scripts', async () => {
    await fixture(
      async ({ store, baseline, temporaryHome, context, originalEdits, originalId }) => {
        const convert = await convertLegacyClashArchive({
          bytes: legacy(),
          baseline,
          temporaryHome,
          proxyPort: 17891,
          signal: new AbortController().signal
        })
        expect(convert.expectedBaselineSHA256).toBe(backupSnapshotSHA256(baseline))
        expect(convert.report.counts).toMatchObject({
          profiles: 2,
          sources: 1,
          overrides: 4,
          rulePatches: 1
        })
        expect(JSON.stringify(convert.report)).not.toContain('PRIVATE')
        expect(JSON.stringify(convert.report)).not.toContain('subscriptions.example')
        expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
        expect((await new ProfileStore(context).list()).profiles.map((p) => p.id)).toEqual([
          originalId
        ])
        if (!convert.archiveBytes) throw new Error('No merged candidate')
        const merged = readBackupArchive(convert.archiveBytes).snapshot
        for (const before of baseline.entries) {
          const after = merged.entries.find((e) => e.path === before.path)
          expect(after?.mode).toBe(before.mode)
          if (before.path !== 'Configuration/configuration-edit.json')
            expect(after?.bytes).toEqual(before.bytes)
        }
        const document = JSON.parse(
          merged.entries
            .find((e) => e.path === 'Configuration/configuration-edit.json')
            ?.bytes.toString() ?? 'null'
        )
        expect(document.globalOverrides).toEqual(originalEdits.globalOverrides)
        expect(document.profileRulePatchSets[0]).toEqual(originalEdits.profileRulePatchSets?.[0])
        const remote = convert.report.profiles.find((p) => p.legacyId === 'remote')
        expect(remote?.profileId).not.toBe('remote')
        const selected = document.profileOverrideSets.find(
          (s: { profileId: string }) => s.profileId === remote?.profileId
        )
        expect(selected.overrides.map((o: { kind: string }) => o.kind)).toEqual([
          'yaml',
          'yaml',
          'js'
        ])
        expect(selected.overrides[2]).toMatchObject({ content: script, role: 'smart' })
        expect(document.profileRulePatchSets[1]).toEqual({
          profileId: remote?.profileId,
          rulePatch: { prepend: ['DOMAIN,legacy.test,G'], append: [], delete: [] }
        })
        const shell = JSON.parse(
          merged.entries.find((entry) => entry.path === 'UI/shell.json')?.bytes.toString() ?? 'null'
        )
        expect(shell.customCSS).toBe('')
        expect(shell.themes).toEqual([
          { id: expect.any(String), name: 'custom.css', css: 'body { color: red }' }
        ])
        const source = await new SubscriptionSourceStore({
          home: temporaryHome,
          stateRoot: join(temporaryHome, 'Library/Application Support/Relay')
        }).readId(remote?.sourceId ?? '')
        expect(source.options).toMatchObject({
          headers: { authorization: 'PRIVATE-AUTH', 'user-agent': 'PRIVATE-UA' },
          schedule: { kind: 'manual' },
          redirects: 'none',
          useServerInterval: false
        })
        expect(source.info.versions.at(-1)?.profile.id).toBe(remote?.profileId)
        const retained = convert.report.files
          .filter((f) => f.disposition === 'retained')
          .map((f) => f.path)
        expect(retained).toEqual(
          expect.arrayContaining(['config.yaml', 'mihomo.yaml', 'override/smart-core-override.log'])
        )
        expect(
          convert.report.files.find((entry) => entry.path === 'substore/sub-store.json')
            ?.disposition
        ).toBe('decision-required')
        // Compatibility with the real staged transaction is checked here.
        // Actual publication requires the separately verified native exclusive
        // move capability; this converter never substitutes ordinary rename.
        const plan = await store.stageRestore(convert.archiveBytes, convert.expectedBaselineSHA256)
        expect(plan.baselineSHA256).toBe(convert.expectedBaselineSHA256)
        expect(plan.removedFiles).toBe(0)
        expect((await new ProfileStore(context).list()).profiles).toHaveLength(1)
        expect(await readFile(join(context.stateRoot, 'Core/selection.json'), 'utf8')).toBe(
          'PRIVATE-original-selection'
        )
        expect(await readFile(join(context.stateRoot, 'preferences.json'), 'utf8')).toBe(
          'PRIVATE-original-preferences'
        )
      }
    )
  })
  it('imports only cached profiles without a proxy port and reports remote definitions as retained', async () => {
    await fixture(async ({ baseline, temporaryHome }) => {
      const output = await convertLegacyClashArchive({
        bytes: legacy(),
        baseline,
        temporaryHome,
        signal: new AbortController().signal
      })
      expect(output.report.counts.sources).toBe(0)
      expect(output.report.profiles.find((p) => p.legacyId === 'remote')).toMatchObject({
        disposition: 'applied',
        reason: 'cache-copied-remote-definition-retained'
      })
      expect(output.report.profiles.every((p) => p.sourceId === undefined)).toBe(true)
    })
  })
  it('decrypts known AGE profile/override bytes using the indexed identity while keeping secrets out of the report', async () => {
    const keys = await generateAgeKeyPair(),
      bytes = legacy({
        'profile.yaml': JSON.stringify({
          items: [
            {
              id: 'remote',
              type: 'remote',
              name: 'Encrypted',
              url: 'https://example.invalid/sub',
              ageSecretKey: keys.secretKey,
              override: ['global']
            }
          ]
        }),
        'profiles/remote.yaml': await encryptAgeContent(config, keys.recipient),
        'override/global.yaml': await encryptAgeContent('ipv6: false', keys.recipient)
      })
    await fixture(async ({ baseline, temporaryHome }) => {
      const output = await convertLegacyClashArchive({
        bytes,
        baseline,
        temporaryHome,
        proxyPort: 17891,
        signal: new AbortController().signal
      })
      expect(output.report.counts.profiles).toBe(1)
      expect(output.report.counts.sources).toBe(1)
      expect(JSON.stringify(output.report)).not.toContain(keys.secretKey)
      const imported = (
        await new ProfileStore({
          home: temporaryHome,
          stateRoot: join(temporaryHome, 'Library/Application Support/Relay')
        }).list()
      ).profiles[0]
      expect(
        (
          await new ProfileStore({
            home: temporaryHome,
            stateRoot: join(temporaryHome, 'Library/Application Support/Relay')
          }).read({ id: imported.id, sha256: imported.sha256 })
        ).text
      ).toBe(config)
    })
  })
  it('reports missing cache, missing keys and missing references instead of publishing an empty profile or script', async () => {
    const keys = await generateAgeKeyPair()
    for (const change of ['cache', 'key', 'reference'] as const)
      await fixture(async ({ baseline, temporaryHome, store }) => {
        const bytes = legacy({
          'profile.yaml': JSON.stringify({
            items: [
              {
                id: 'remote',
                type: 'local',
                name: 'Missing',
                override: change === 'reference' ? ['absent'] : []
              }
            ]
          }),
          'override.yaml': JSON.stringify({ items: [] }),
          'profiles/remote.yaml':
            change === 'cache'
              ? undefined
              : change === 'key'
                ? await encryptAgeContent(config, keys.recipient)
                : config,
          'themes/custom.css': undefined
        })
        const output = await convertLegacyClashArchive({
          bytes,
          baseline,
          temporaryHome,
          signal: new AbortController().signal
        })
        expect(output.archiveBytes).toBeUndefined()
        expect(output.report.counts.profiles).toBe(0)
        expect(output.report.counts['decision-required']).toBeGreaterThan(0)
        expect(output.report.profiles[0].disposition).toBe('decision-required')
        expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
      })
  })
  it('does not turn a no-profile archive into a destructive full restore', async () => {
    await fixture(async ({ baseline, temporaryHome }) => {
      const output = await convertLegacyClashArchive({
        bytes: legacy({ 'profile.yaml': 'items: []', 'themes/custom.css': undefined }),
        baseline,
        temporaryHome,
        signal: new AbortController().signal
      })
      expect(output.archiveBytes).toBeUndefined()
      expect(output.report.files).toHaveLength(
        parseLegacyClashArchive(
          legacy({ 'profile.yaml': 'items: []', 'themes/custom.css': undefined })
        ).files.size
      )
      expect(
        output.report.files
          .filter((f) => f.path !== 'substore/sub-store.json')
          .every((f) => f.disposition === 'retained')
      ).toBe(true)
      expect(
        output.report.files.find((f) => f.path === 'substore/sub-store.json')?.disposition
      ).toBe('decision-required')
    })
  })
  it('rejects unknown roots, Relay-manifest fallback, case collisions, malformed indices and invalid UTF-8 before conversion', () => {
    const variants = [
      legacy({ 'manifest.json': '{}' }),
      legacy({ 'work/mihomo': 'ELF' }),
      legacy({ 'profiles/REMOTE.yaml': config }),
      legacy({ 'profile.yaml': 'items: []\nunknown: true' }),
      legacy({ themes: 'not a directory' }),
      legacy({ '.DS_Store': 'unknown root' }),
      legacy({ 'profiles/.ds_store': 'not Finder metadata' }),
      legacy({ 'profiles/.private/.DS_Store': 'hidden ancestor' }),
      legacy({ 'profiles/.DS_Store/child': 'metadata is not a directory' }),
      legacy({ 'themes/custom.css/child': 'conflicting parent file' }),
      legacy({
        'profile.yaml':
          'items: [{id: duplicate, type: local, name: A}, {id: duplicate, type: local, name: B}]'
      })
    ]
    const bad = new AdmZip()
    bad.addFile('profile.yaml', Buffer.from([0xff]))
    variants.push(bad.toBuffer())
    const linked = new AdmZip(legacy({ 'profiles/.DS_Store': 'untrusted-link-target' }))
    const linkedEntry = linked.getEntry('profiles/.DS_Store')
    if (!linkedEntry) throw new Error('Missing metadata entry')
    linkedEntry.attr = (0o120777 << 16) >>> 0
    variants.push(linked.toBuffer())
    for (const bytes of variants) expect(() => parseLegacyClashArchive(bytes)).toThrow('未通过')
  })
  it('refuses a nonempty staging home and honors cancellation without touching the production baseline', async () => {
    await fixture(async ({ baseline, temporaryHome, store }) => {
      await writeFile(join(temporaryHome, 'foreign'), 'keep', { mode: 0o600 })
      await expect(
        convertLegacyClashArchive({
          bytes: legacy(),
          baseline,
          temporaryHome,
          signal: new AbortController().signal
        })
      ).rejects.toThrow('独占')
      expect(await readFile(join(temporaryHome, 'foreign'), 'utf8')).toBe('keep')
      await rm(join(temporaryHome, 'foreign'))
      const abort = new AbortController(),
        save = ProfileStore.prototype.save
      vi.spyOn(ProfileStore.prototype, 'save').mockImplementationOnce(async function (
        this: ProfileStore,
        name,
        body
      ) {
        const result = await save.call(this, name, body)
        abort.abort()
        return result
      })
      await expect(
        convertLegacyClashArchive({
          bytes: legacy(),
          baseline,
          temporaryHome,
          signal: abort.signal
        })
      ).rejects.toThrow('已取消')
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
    })
  })
})
