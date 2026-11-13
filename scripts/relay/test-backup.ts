// Local fixture only: no user directory, external service or live runtime.
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { RelayBackupStore } from '../../src/main/relay/backup/store'
import { createBackupService } from '../../src/main/relay/backup/service'
import { readBackupArchive } from '../../src/main/relay/backup/archive'
import { recoveryFixtureAdapters } from '../../src/main/relay/backup/recovery.test-fixture'

const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
const home = await realpath(await mkdtemp('/private/tmp/relay-backup-contract-'))
const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
let exported: Buffer | undefined
let allowExport = false
let refreshed = 0
try {
  await mkdir(join(context.stateRoot, 'Configuration'), { recursive: true, mode: 0o700 })
  await mkdir(join(context.stateRoot, 'Core'), { mode: 0o700 })
  const target = join(context.stateRoot, 'Configuration/configuration-edit.json')
  await writeFile(target, 'backup-version', { mode: 0o600 })
  await writeFile(join(context.stateRoot, 'Core/session.json'), 'active-session-not-restored', {
    mode: 0o600
  })
  const store = new RelayBackupStore(context, recoveryFixtureAdapters(context))
  const service = createBackupService({
    store,
    pickImport: async () => exported,
    writeExport: async (bytes) => {
      await writeFile(join(home, 'export.zip'), bytes, { flag: 'wx', mode: 0o600 })
      exported = Buffer.from(bytes)
      return true
    },
    confirmExport: async () => allowExport,
    confirmRestore: async () => true,
    assertIdle: () => {},
    afterRestore: () => {
      refreshed++
    }
  })
  check(
    'export requires explicit consent for credential-containing bytes',
    (await service.export()).status === 'cancelled' && exported === undefined
  )
  allowExport = true
  check(
    'confirmed local export creates a private archive',
    (await service.export()).status === 'exported'
  )
  if (!exported) throw new Error('missing fixture archive')
  const manifest = readBackupArchive(exported).manifest
  check(
    'archive lists owned persistent files and labels credentials',
    manifest.containsSecrets &&
      manifest.files.length === 1 &&
      manifest.files[0].path === 'Configuration/configuration-edit.json'
  )
  await writeFile(target, 'current-version', { mode: 0o600 })
  const prepared = (await service.prepareImport()).plan
  check(
    'import preparation does not replace current files',
    prepared !== undefined && (await readFile(target, 'utf8')) === 'current-version'
  )
  check(
    'confirmed restore replaces only managed private files',
    (await service.restore({ id: prepared?.id })).status === 'restored' &&
      (await readFile(target, 'utf8')) === 'backup-version'
  )
  check('restored-state callback invalidates caches once', refreshed === 1)
  check(
    'runtime session and PID data are preserved',
    (await readFile(join(context.stateRoot, 'Core/session.json'), 'utf8')) ===
      'active-session-not-restored'
  )
  check(
    'old managed data is preserved in the recovery record',
    (await readFile(
      join(
        context.stateRoot,
        'ApplicationBackups/restore-' + prepared?.id,
        'original/Configuration/configuration-edit.json'
      ),
      'utf8'
    )) === 'current-version'
  )
  const next = (await service.prepareImport()).plan
  await writeFile(target, 'external-version', { mode: 0o600 })
  let refused = false
  try {
    await service.restore({ id: next?.id })
  } catch {
    refused = true
  }
  check(
    'unknown changes after preparation refuse restore and remain intact',
    refused && (await readFile(target, 'utf8')) === 'external-version'
  )
  check(
    'exported file is the exact checked archive',
    (await readFile(join(home, 'export.zip'))).equals(exported)
  )
} catch {
  check('fixture contract completes', false)
} finally {
  await rm(home, { recursive: true, force: true })
}
const passed = rows.filter((row) => row.passed).length
process.stdout.write(
  JSON.stringify(
    { checks: rows.length, passed, rows, fixtureAccepted: passed === rows.length },
    null,
    2
  ) + '\n'
)
process.exitCode = passed === rows.length ? 0 : 1
