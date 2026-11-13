import { randomUUID } from 'crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultShellSettings,
  shellSettings,
  type RelayShellSettings,
  type RelayShellTheme
} from '../../../shared/relay/shell'
import { readShellSnapshot, RelayShellStore } from '../shell/store'
import { backupHash, backupSnapshotSHA256, readBackupArchive, type BackupSnapshot } from './archive'
import { convertLegacyClashArchive } from './legacy-clash'
import { recoveryFixtureAdapters } from './recovery.test-fixture'
import { RelayBackupStore } from './store'

afterEach(() => vi.restoreAllMocks())

function theme(name: string, css = 'x'): RelayShellTheme {
  return { id: randomUUID(), name, css }
}
function legacy(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip()
  zip.addFile('profile.yaml', Buffer.from('items: []'))
  zip.addFile('config.yaml', Buffer.from('customTheme: imported.css\nsilentStart: true'))
  for (const [path, content] of Object.entries(files)) zip.addFile(path, Buffer.from(content))
  return zip.toBuffer()
}
function candidateSettings(bytes: Buffer | undefined): RelayShellSettings {
  if (!bytes) throw new Error('Missing theme-only candidate')
  const entries = readBackupArchive(bytes).snapshot.entries
  const entry = entries.find((e) => e.path === 'UI/shell.json')
  if (!entry) throw new Error('Missing private shell settings')
  return readShellSnapshot(
    entry.bytes,
    entries.find((e) => e.path === 'UI/shell-display.json')?.bytes,
    entries.find((e) => e.path === 'UI/shell-startup.json')?.bytes
  ).record.settings
}
async function fixture(
  settings: RelayShellSettings | undefined,
  run: (input: {
    context: { home: string; stateRoot: string }
    temporaryHome: string
    store: RelayBackupStore
    baseline: BackupSnapshot
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-legacy-themes-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
  try {
    await mkdir(context.stateRoot, { recursive: true, mode: 0o700 })
    if (settings) {
      await new RelayShellStore(context).save(settings, '')
      await writeFile(join(context.stateRoot, 'UI/retained-notes.json'), 'PRESERVE-UI-SIBLING', {
        mode: 0o600
      })
    }
    await writeFile(join(context.stateRoot, 'preferences.json'), 'PRESERVE-PREFERENCES', {
      mode: 0o600
    })
    const temporaryHome = join(home, 'conversion')
    await mkdir(temporaryHome, { mode: 0o700 })
    const store = new RelayBackupStore(context, recoveryFixtureAdapters(context))
    await run({ context, temporaryHome, store, baseline: await store.snapshot() })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('Legacy CSS theme library migration without activation', () => {
  it('creates a theme-only additive candidate, preserves active settings, and restores/rolls back through actual Native', async () => {
    const settings = shellSettings({
      ...defaultShellSettings(),
      operationMode: 'simple',
      appTheme: 'dark',
      closeToTray: true,
      alwaysOnTop: true,
      showDockIcon: false,
      floatingWindowCompatMode: false,
      trayTrafficTextColor: 'white',
      useWindowFrame: false,
      disableHardwareAcceleration: true,
      customCSS: 'body { --active: unchanged }',
      themes: [theme('Existing', 'body { --saved: unchanged }')],
      shortcuts: { ...defaultShellSettings().shortcuts, showWindow: 'Control+Shift+R' }
    })
    await fixture(settings, async ({ context, temporaryHome, baseline, store }) => {
      const css =
          '/* Imported */\nbody { --saved: new; background:url(https://invalid.example/x) }',
        bytes = legacy({ 'themes/imported.css': css }),
        originalSHA = backupHash(bytes),
        output = await convertLegacyClashArchive({
          bytes,
          baseline,
          temporaryHome,
          signal: new AbortController().signal
        }),
        candidate = candidateSettings(output.archiveBytes)
      expect(output.report.counts).toMatchObject({ profiles: 0, applied: 1 })
      expect(output.report.files.find((f) => f.path === 'themes/imported.css')).toMatchObject({
        disposition: 'applied',
        sha256: backupHash(Buffer.from(css)),
        reason: 'theme-added-to-library-not-enabled'
      })
      expect(candidate).toEqual({
        ...settings,
        themes: [...settings.themes, { id: expect.any(String), name: 'Imported', css }]
      })
      expect(candidate.themes[1].id).not.toBe(settings.themes[0].id)
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
      expect((await new RelayShellStore(context).read()).settings).toEqual(settings)
      expect(backupHash(bytes)).toBe(originalSHA)
      if (!output.archiveBytes) throw new Error('Missing archive')
      const merged = readBackupArchive(output.archiveBytes).snapshot
      for (const entry of baseline.entries)
        if (
          !['UI/shell.json', 'UI/shell-display.json', 'UI/shell-startup.json'].includes(entry.path)
        )
          expect(merged.entries.find((e) => e.path === entry.path)).toEqual(entry)
      const plain = merged.entries.find((e) => e.path === 'UI/shell.json')?.bytes.toString('utf8')
      expect(plain).not.toContain('floatingWindowCompatMode')
      expect(plain).not.toContain('trayTrafficTextColor')
      expect(plain).not.toContain('useWindowFrame')
      expect(plain).not.toContain('disableHardwareAcceleration')
      expect(merged.entries.map((e) => e.path).sort()).toEqual(
        baseline.entries.map((e) => e.path).sort()
      )
      const plan = await store.stageRestore(output.archiveBytes, output.expectedBaselineSHA256)
      expect(plan.removedFiles).toBe(0)
      expect(await store.commitRestore(plan.id, plan.baselineSHA256, () => {})).toBe('restored')
      expect((await new RelayShellStore(context).read()).settings).toEqual(candidate)
      const reopened = new RelayBackupStore(context, recoveryFixtureAdapters(context)),
        rollback = await reopened.prepareRecovery({ id: plan.id, action: 'rollback' })
      expect(await reopened.commitRecovery(rollback.evidenceId, () => {})).toBe('rolled-back')
      expect(backupSnapshotSHA256(await reopened.snapshot())).toBe(backupSnapshotSHA256(baseline))
      expect((await new RelayShellStore(context).read()).settings).toEqual(settings)
    })
  }, 20000)

  it('keeps conflicting names and non-theme assets intact while importing a distinct library item', async () => {
    const settings = { ...defaultShellSettings(), themes: [theme('Existing')] }
    await fixture(settings, async ({ baseline, temporaryHome, store }) => {
      const files = {
          'themes/existing.css': '/* EXISTING */\na',
          'themes/duplicate-a.css': '/* Repeated */\nb',
          'themes/duplicate-b.css': '/* repeated */\nc',
          'themes/valid.css': 'valid-css',
          'themes/nested/asset.css': 'nested-asset',
          'themes/notes.txt': 'PRIVATE-original'
        },
        bytes = legacy(files),
        output = await convertLegacyClashArchive({
          bytes,
          baseline,
          temporaryHome,
          signal: new AbortController().signal
        })
      expect(candidateSettings(output.archiveBytes).themes).toEqual([
        ...settings.themes,
        { id: expect.any(String), name: 'valid.css', css: files['themes/valid.css'] }
      ])
      for (const path of Object.keys(files)) {
        const row = output.report.files.find((f) => f.path === path)
        expect(row?.sha256).toBe(backupHash(Buffer.from(files[path])))
        if (path.includes('existing') || path.includes('duplicate'))
          expect(row).toMatchObject({
            disposition: 'decision-required',
            reason: 'theme-name-conflict-original-preserved'
          })
        else if (path !== 'themes/valid.css') expect(row?.disposition).toBe('retained')
      }
      expect(JSON.stringify(output.report)).not.toContain('PRIVATE-original')
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
    })
  })

  it.each([
    { name: '16 items', themes: Array.from({ length: 16 }, (_, i) => theme('Existing ' + i)) },
    {
      name: '32KiB total',
      themes: Array.from({ length: 4 }, (_, i) => theme('Large ' + i, 'x'.repeat(8192)))
    }
  ])(
    'preserves the full existing $name library instead of truncating or replacing it',
    async ({ themes }) => {
      const settings = { ...defaultShellSettings(), themes }
      await fixture(settings, async ({ baseline, temporaryHome, store }) => {
        const output = await convertLegacyClashArchive({
          bytes: legacy({ 'themes/extra.css': 'x' }),
          baseline,
          temporaryHome,
          signal: new AbortController().signal
        })
        expect(output.archiveBytes).toBeUndefined()
        expect(output.report.files.find((f) => f.path === 'themes/extra.css')).toMatchObject({
          disposition: 'decision-required',
          reason: 'theme-library-capacity-exceeded-original-preserved'
        })
        expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
      })
    }
  )

  it.each([
    {
      name: '16 items',
      themes: Array.from({ length: 15 }, (_, i) => theme('Existing ' + i)),
      fittingCSS: 'x'
    },
    {
      name: '32KiB total',
      themes: Array.from({ length: 4 }, (_, i) => theme('Large ' + i, 'x'.repeat(8191))),
      fittingCSS: 'abcd'
    }
  ])('fills exactly $name and retains the next complete item', async ({ themes, fittingCSS }) => {
    await fixture({ ...defaultShellSettings(), themes }, async ({ baseline, temporaryHome }) => {
      const output = await convertLegacyClashArchive({
        bytes: legacy({ 'themes/a-fit.css': fittingCSS, 'themes/z-over.css': 'x' }),
        baseline,
        temporaryHome,
        signal: new AbortController().signal
      })
      expect(candidateSettings(output.archiveBytes).themes).toEqual([
        ...themes,
        { id: expect.any(String), name: 'a-fit.css', css: fittingCSS }
      ])
      expect(output.report.files.find((f) => f.path === 'themes/z-over.css')).toMatchObject({
        disposition: 'decision-required',
        bytes: 1,
        sha256: backupHash(Buffer.from('x')),
        reason: 'theme-library-capacity-exceeded-original-preserved'
      })
    })
  })

  it('accepts exactly 8KiB, keeps invalid UTF-8/NUL/oversize/name records whole, and does not activate the fresh library', async () => {
    await fixture(undefined, async ({ baseline, temporaryHome, store }) => {
      const css = 'é'.repeat(4096),
        invalid = {
          'themes/invalid-utf8.css': Buffer.from([0xc3, 0x28]),
          'themes/nul.css': Buffer.from('a\0b'),
          'themes/oversize.css': Buffer.from(css + 'x'),
          'themes/long-name.css': Buffer.from('/* ' + 'a'.repeat(81) + ' */\na')
        },
        output = await convertLegacyClashArchive({
          bytes: legacy({
            ...invalid,
            'themes/exact.css': css,
            'themes/bom.css': '\uFEFF/* Original first bytes */\nbody{}'
          }),
          baseline,
          temporaryHome,
          signal: new AbortController().signal
        }),
        settings = candidateSettings(output.archiveBytes)
      expect(settings).toEqual({
        ...defaultShellSettings(),
        themes: [
          {
            id: expect.any(String),
            name: 'bom.css',
            css: '\uFEFF/* Original first bytes */\nbody{}'
          },
          { id: expect.any(String), name: 'exact.css', css }
        ]
      })
      for (const [path, content] of Object.entries(invalid))
        expect(output.report.files.find((f) => f.path === path)).toMatchObject({
          bytes: content.length,
          sha256: backupHash(content),
          disposition: 'decision-required',
          reason: 'theme-name-or-css-invalid-original-preserved'
        })
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
    })
  })

  it('cancels after the isolated shell write without returning a candidate or mutating the baseline', async () => {
    const settings = defaultShellSettings()
    await fixture(settings, async ({ context, baseline, temporaryHome, store }) => {
      const controller = new AbortController(),
        save = RelayShellStore.prototype.save
      vi.spyOn(RelayShellStore.prototype, 'save').mockImplementation(async function (
        this: RelayShellStore,
        value,
        revision
      ) {
        const saved = await save.call(this, value, revision)
        controller.abort()
        return saved
      })
      await expect(
        convertLegacyClashArchive({
          bytes: legacy({ 'themes/saved.css': 'body{}' }),
          baseline,
          temporaryHome,
          signal: controller.signal
        })
      ).rejects.toThrow('取消')
      expect(JSON.parse(await readFile(join(context.stateRoot, 'UI/shell.json'), 'utf8'))).toEqual(
        settings
      )
      expect(backupSnapshotSHA256(await store.snapshot())).toBe(backupSnapshotSHA256(baseline))
    })
  })
})
