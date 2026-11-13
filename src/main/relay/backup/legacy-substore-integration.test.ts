import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import { defaultShellSettings } from '../../../shared/relay/shell'
import { RelayShellStore } from '../shell/store'
import { backupHash, backupSnapshotSHA256, readBackupArchive } from './archive'
import { convertLegacyClashArchive, parseLegacyClashArchive } from './legacy-clash'
import { recoveryFixtureAdapters } from './recovery.test-fixture'
import { RelayBackupStore } from './store'

const basic = {
  schemaVersion: '2.0',
  subs: [
    { name: 'Local', source: 'local', content: 'http://u:p@127.0.0.1:1234#Fixture' },
    { name: 'Remote', source: 'remote', url: 'https://remote.invalid/sub?token=PRIVATE-URL' },
    {
      name: 'Scripted',
      source: 'local',
      content: 'PRIVATE-script-content',
      process: [{ type: 'Script Operator', args: { content: 'throw Error("PRIVATE-JS")' } }]
    }
  ],
  collections: [{ name: 'Combined', subscriptions: ['Local', 'Remote'] }],
  artifacts: [{ name: 'old-job', source: 'Remote', sync: true, cron: '* * * * * *' }],
  settings: { token: 'PRIVATE-old-token' }
}
function legacy(data: unknown = basic, extra: Record<string, string> = {}): Buffer {
  const zip = new AdmZip()
  for (const [path, content] of Object.entries({
    'profile.yaml': 'items: []',
    'substore/sub-store.json': typeof data === 'string' ? data : JSON.stringify(data),
    'substore/root.json': '{"cacheSecret":"PRIVATE-root"}',
    'substore/.env': 'SUB_STORE_BACKUP_CRON=* * * * * *\nPRIVATE=old-environment',
    ...extra
  }))
    zip.addFile(path, Buffer.from(content))
  return zip.toBuffer()
}
async function fixture(
  run: (f: {
    context: { home: string; stateRoot: string }
    temporaryHome: string
    store: RelayBackupStore
    data: string
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-legacy-substore-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
    data = join(context.stateRoot, 'SubStore/Data'),
    temporaryHome = join(home, 'conversion')
  try {
    await mkdir(data, { recursive: true, mode: 0o700 })
    await mkdir(temporaryHome, { mode: 0o700 })
    await new RelayShellStore(context).save(
      { ...defaultShellSettings(), customCSS: 'body { --active: preserve }' },
      ''
    )
    await writeFile(join(data, 'root.json'), 'BASELINE-ROOT-CACHE', { mode: 0o600 })
    await writeFile(join(data, 'other.json'), 'BASELINE-OTHER-DATA', { mode: 0o600 })
    await run({
      context,
      temporaryHome,
      store: new RelayBackupStore(context, recoveryFixtureAdapters(context)),
      data
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('Legacy Sub-Store ZIP integration through the existing private restore transaction', () => {
  it('merges eligible definitions only, preserves baseline sections, then restores and rolls back with actual Native', async () => {
    await fixture(async ({ context, temporaryHome, store, data }) => {
      const existing = {
        schemaVersion: '2.0',
        subs: [{ name: 'Existing', source: 'local', content: 'EXISTING' }],
        collections: [],
        settings: { custom: 'BASELINE-SETTING' },
        artifacts: [{ name: 'existing-manual-artifact', source: 'Existing', sync: false }],
        tokens: [{ name: 'existing-token', token: 'BASELINE-TOKEN' }],
        future: { enabled: false, maximum: 123 }
      }
      await writeFile(join(data, 'sub-store.json'), JSON.stringify(existing), { mode: 0o600 })
      const baseline = await store.snapshot(),
        bytes = legacy(),
        original = Buffer.from(bytes),
        output = await convertLegacyClashArchive({
          bytes,
          baseline,
          temporaryHome,
          signal: new AbortController().signal
        })
      expect(output.report.substore).toMatchObject({ subscriptions: 2, collections: 1 })
      expect(
        output.report.substore?.items.find((item) => item.oldName === 'Scripted')
      ).toMatchObject({
        disposition: 'retained'
      })
      expect(JSON.stringify(output.report)).not.toContain('PRIVATE')
      expect(bytes).toEqual(original)
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
      if (!output.archiveBytes) throw new Error('Missing Sub-Store-only candidate')
      const target = readBackupArchive(output.archiveBytes).snapshot,
        saved = JSON.parse(
          target.entries
            .find((entry) => entry.path === 'SubStore/Data/sub-store.json')
            ?.bytes.toString() ?? 'null'
        )
      expect(saved.subs[0]).toEqual(existing.subs[0])
      expect(saved.subs.slice(1)).toEqual([
        expect.objectContaining({ displayName: 'Local', source: 'local', noFlow: true }),
        expect.objectContaining({ displayName: 'Remote', source: 'remote', noFlow: true })
      ])
      expect(saved.collections[0].subscriptions).toEqual(
        saved.subs.slice(1).map((s: { name: string }) => s.name)
      )
      for (const key of ['settings', 'artifacts', 'tokens', 'future'] as const)
        expect(saved[key]).toEqual(existing[key])
      for (const entry of baseline.entries)
        if (entry.path !== 'SubStore/Data/sub-store.json')
          expect(target.entries.find((next) => next.path === entry.path)).toEqual(entry)
      expect(target.entries.some((entry) => entry.path.endsWith('/.env'))).toBe(false)
      const plan = await store.stageRestore(output.archiveBytes, output.expectedBaselineSHA256)
      expect(plan.removedFiles).toBe(0)
      expect(await store.commitRestore(plan.id, plan.baselineSHA256, () => {})).toBe('restored')
      expect(JSON.parse(await readFile(join(data, 'sub-store.json'), 'utf8'))).toEqual(saved)
      const restarted = new RelayBackupStore(context, recoveryFixtureAdapters(context)),
        rollback = await restarted.prepareRecovery({ id: plan.id, action: 'rollback' })
      expect(await restarted.commitRecovery(rollback.evidenceId, () => {})).toBe('rolled-back')
      expect(backupSnapshotSHA256(await restarted.snapshot())).toBe(backupSnapshotSHA256(baseline))
    })
  }, 20000)

  it.each([
    { name: 'future source schema', data: { ...basic, schemaVersion: '99.0' } },
    { name: 'malformed source JSON', data: 'not JSON or Base64' }
  ])('retains $name while still preparing an independent valid theme', async ({ data: input }) => {
    await fixture(async ({ temporaryHome, store }) => {
      const baseline = await store.snapshot(),
        output = await convertLegacyClashArchive({
          bytes: legacy(input, { 'themes/retained-data.css': '/* Valid theme */\nbody{}' }),
          baseline,
          temporaryHome,
          signal: new AbortController().signal
        })
      expect(
        output.report.files.find((entry) => entry.path === 'substore/sub-store.json')
      ).toMatchObject({
        disposition: 'decision-required'
      })
      expect(output.report.substore).toBeUndefined()
      expect(output.archiveBytes).toBeDefined()
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
    })
  })

  it('retains an unknown baseline schema instead of replacing it with the imported library', async () => {
    await fixture(async ({ data, temporaryHome, store }) => {
      await writeFile(join(data, 'sub-store.json'), '{"schemaVersion":"99.0","PRIVATE":"keep"}', {
        mode: 0o600
      })
      const baseline = await store.snapshot(),
        output = await convertLegacyClashArchive({
          bytes: legacy(),
          baseline,
          temporaryHome,
          signal: new AbortController().signal
        })
      expect(output.archiveBytes).toBeUndefined()
      expect(
        output.report.files.find((entry) => entry.path === 'substore/sub-store.json')?.disposition
      ).toBe('decision-required')
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
      expect(JSON.stringify(output.report)).not.toContain('PRIVATE')
    })
  })

  it('accepts only the exact regular dotenv entry for original retention and keeps other hidden paths refused', () => {
    const bytes = legacy(),
      environment = parseLegacyClashArchive(bytes).files.get('substore/.env')
    expect(environment?.toString()).toContain('PRIVATE=old-environment')
    expect(backupHash(bytes)).toMatch(/^[a-f0-9]{64}$/u)
    for (const path of ['substore/.unknown', 'substore/nested/.env', 'substore/.env/nested'])
      expect(() => parseLegacyClashArchive(legacy(basic, { [path]: 'PRIVATE' }))).toThrow()
    const linked = new AdmZip(bytes)
    const entry = linked.getEntry('substore/.env')
    if (!entry) throw new Error('Missing dotenv fixture')
    entry.attr = (0o120777 << 16) >>> 0
    expect(() => parseLegacyClashArchive(linked.toBuffer())).toThrow()
  })
})
