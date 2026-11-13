import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import {
  backupHash,
  backupPath,
  backupSnapshotSHA256,
  createBackupArchive,
  readBackupArchive,
  type BackupSnapshot
} from './archive'

const snapshot = (): BackupSnapshot => ({
  directories: ['Configuration', 'Configurations', 'Configurations/源配置'],
  entries: [
    {
      path: 'Configuration/configuration-edit.json',
      bytes: Buffer.from('{"token":"fixture-secret"}'),
      mode: 0o600
    },
    {
      path: 'Configurations/源配置/profile.yaml',
      bytes: Buffer.from('rules: [MATCH,REJECT]'),
      mode: 0o600
    }
  ]
})

describe('Relay backup archive integrity and scope', () => {
  it('round-trips private bytes, empty directories and metadata with an explicit secrets label', () => {
    const source = snapshot()
    const result = readBackupArchive(createBackupArchive(source))
    expect(result.snapshot).toEqual(source)
    expect(result.manifest.containsSecrets).toBe(true)
    expect(result.manifest.files[0].sha256).toBe(backupHash(source.entries[0].bytes))
    expect(backupSnapshotSHA256(result.snapshot)).toBe(backupSnapshotSHA256(source))
  })
  it('rejects corrupt payload, unexpected members, unknown versions and unsafe paths', () => {
    const bytes = createBackupArchive(snapshot())
    const corrupt = new AdmZip(bytes)
    corrupt.updateFile('files/Configuration/configuration-edit.json', Buffer.from('tampered'))
    expect(() => readBackupArchive(corrupt.toBuffer())).toThrow('完整性')
    const extra = new AdmZip(bytes)
    extra.addFile('files/../escape', Buffer.from('x'))
    expect(() => readBackupArchive(extra.toBuffer())).toThrow('完整性')
    const version = new AdmZip(bytes)
    const manifest = JSON.parse(version.readAsText('manifest.json'))
    version.updateFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, version: 2 })))
    expect(() => readBackupArchive(version.toBuffer())).toThrow('完整性')
    for (const path of [
      '../outside',
      '/tmp/outside',
      'Core/session.json',
      'NativeRuntime/worker',
      'Backups/loop.zip',
      'Configurations/.write-lock',
      'Configurations/a/../../outside',
      'Configurations\\target'
    ])
      expect(() => backupPath(path)).toThrow()
  })
  it('rejects duplicate entries, file-directory collisions and omitted directory parents', () => {
    const source = snapshot()
    expect(() =>
      createBackupArchive({ ...source, entries: [...source.entries, source.entries[0]] })
    ).toThrow()
    expect(() =>
      createBackupArchive({
        ...source,
        entries: [
          ...source.entries,
          { path: 'Configurations/源配置', bytes: Buffer.from('x'), mode: 0o600 }
        ]
      })
    ).toThrow()
    expect(() => createBackupArchive({ directories: [], entries: source.entries })).toThrow('缺少')
  })
  it('binds file additions, content changes, removals and empty directory changes to the snapshot digest', () => {
    const source = snapshot()
    const digest = backupSnapshotSHA256(source)
    expect(backupSnapshotSHA256({ ...source, entries: source.entries.slice(1) })).not.toBe(digest)
    expect(
      backupSnapshotSHA256({
        ...source,
        directories: source.directories.filter((path) => path !== 'Configurations/源配置'),
        entries: source.entries.slice(0, 1)
      })
    ).not.toBe(digest)
    expect(
      backupSnapshotSHA256({
        ...source,
        entries: source.entries.map((entry) => ({ ...entry, bytes: Buffer.from('changed') }))
      })
    ).not.toBe(digest)
  })
})

describe('Sub-Store persistent data boundary', () => {
  it('backs up Data while refusing downloaded resources and executable runtime slots', () => {
    const data: BackupSnapshot = {
      directories: ['SubStore/Data'],
      entries: [{ path: 'SubStore/Data/subs.json', mode: 0o600, bytes: Buffer.from('{}') }]
    }
    expect(readBackupArchive(createBackupArchive(data)).snapshot).toEqual(data)
    for (const path of [
      'SubStore/Resources/server.js',
      'SubStore/Runtime/runner.cjs',
      'SubStore/cache.js'
    ])
      expect(() => backupPath(path)).toThrow()
  })
})

describe('Plugin encrypted credential backup', () => {
  it('preserves ciphertext as private data without extracting or re-enrolling credentials', () => {
    const source: BackupSnapshot = {
      directories: ['Plugins', 'Plugins/record'],
      entries: [
        {
          path: 'Plugins/record/record.json',
          mode: 0o600,
          bytes: Buffer.from('{"encryptedCredential":"Y2lwaGVydGV4dA=="}')
        }
      ]
    }
    const result = readBackupArchive(createBackupArchive(source))
    expect(result.snapshot).toEqual(source)
    expect(result.manifest.containsSecrets).toBe(true)
  })
})
