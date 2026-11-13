import { spawn } from 'child_process'
import { mkdtemp, realpath, readFile, writeFile, lstat, readdir, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { CoreStore } from '../../src/main/relay/core/store'
import { coreRecordRecoveryNative } from '../../src/main/relay/native'

const home = await realpath(await mkdtemp('/private/tmp/relay-core-recovery-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  store = new CoreStore(context),
  native = resolve(process.argv[2] ?? 'extra/relay/RelayNative')
const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
const inspect = () => coreRecordRecoveryNative(native, context, 'inspect')
const refused = async (operation: () => Promise<unknown>): Promise<boolean> => {
  try {
    await operation()
    return false
  } catch {
    return true
  }
}
try {
  const empty = await inspect()
  check(
    'first read reports no record and creates no core directory or lock',
    empty.status === 'clear' && (await refused(() => lstat(store.directory)))
  )
  const lease = await store.acquire('global', (await store.inspect()).revision)
  await lease.update('running', process.pid)
  const ownerPath = join(store.directory, '.session/owner.json'),
    original = await readFile(ownerPath, 'utf8'),
    live = await inspect()
  check(
    'current or reused PID is live/unknown and cannot be adopted or archived',
    live.status === 'liveOrUnknown' &&
      !live.canArchive &&
      (await refused(() => coreRecordRecoveryNative(native, context, 'archive', live.revision)))
  )
  check(
    'refused recovery does not signal the process or change record bytes',
    (await readFile(ownerPath, 'utf8')) === original && process.pid > 0
  )
  const runtime = {
    kind: 'localProxy',
    httpPort: 18191,
    profileId: '63f90396-1cd2-4f63-b7ba-8e8f3dba1444',
    sourceSHA256: 'a'.repeat(64),
    resolverMode: 'profile'
  }
  const portRecords: { name: string; runtime: unknown; valid: boolean }[] = [
    { name: 'legacy HTTP-only runtime without ports', runtime, valid: true },
    {
      name: 'four ordinary listeners with HTTP entry',
      runtime: { ...runtime, ports: { http: 18191, socks: 18192, mixed: 18194, redir: 18195 } },
      valid: true
    },
    {
      name: 'mixed-only HTTP-capable entry',
      runtime: {
        ...runtime,
        httpPort: 18194,
        ports: { http: 0, socks: 18192, mixed: 18194, redir: 0 }
      },
      valid: true
    },
    {
      name: 'duplicate active ordinary ports',
      runtime: { ...runtime, ports: { http: 18191, socks: 18191, mixed: 0, redir: 0 } },
      valid: false
    },
    {
      name: 'HTTP alias disagrees with mixed entry',
      runtime: { ...runtime, ports: { http: 0, socks: 18192, mixed: 18194, redir: 0 } },
      valid: false
    },
    {
      name: 'no HTTP-capable ordinary listener',
      runtime: { ...runtime, ports: { http: 0, socks: 18192, mixed: 0, redir: 18195 } },
      valid: false
    },
    {
      name: 'non-numeric disabled listener',
      runtime: { ...runtime, ports: { http: 18191, socks: '0', mixed: 0, redir: 0 } },
      valid: false
    },
    {
      name: 'boolean disabled listener',
      runtime: { ...runtime, ports: { http: 18191, socks: false, mixed: 0, redir: 0 } },
      valid: false
    },
    {
      name: 'fractional listener',
      runtime: { ...runtime, ports: { http: 18191, socks: 18192.5, mixed: 0, redir: 0 } },
      valid: false
    },
    {
      name: 'privileged listener',
      runtime: { ...runtime, ports: { http: 18191, socks: 443, mixed: 0, redir: 0 } },
      valid: false
    },
    {
      name: 'listener exceeding the valid port range',
      runtime: { ...runtime, ports: { http: 18191, socks: 65536, mixed: 0, redir: 0 } },
      valid: false
    },
    {
      name: 'missing ordinary listener field',
      runtime: { ...runtime, ports: { http: 18191, socks: 0, mixed: 0 } },
      valid: false
    },
    {
      name: 'unknown ordinary listener field',
      runtime: { ...runtime, ports: { http: 18191, socks: 0, mixed: 0, redir: 0, extra: 0 } },
      valid: false
    }
  ]
  try {
    for (const fixture of portRecords) {
      const bytes = JSON.stringify({ ...JSON.parse(original), runtime: fixture.runtime })
      await writeFile(ownerPath, bytes, { mode: 0o600 })
      const accepted = fixture.valid
        ? await inspect().then((report) => report.status === 'liveOrUnknown' && !report.canArchive)
        : await refused(inspect)
      check(
        `${fixture.valid ? 'accepts' : 'rejects'} ${fixture.name} without changing its record`,
        accepted && (await readFile(ownerPath, 'utf8')) === bytes
      )
    }
  } finally {
    await writeFile(ownerPath, original, { mode: 0o600 })
  }
  const child = spawn('/usr/bin/true', [], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise<void>((yes, no) => {
    child.once('error', no)
    child.once('close', () => yes())
  })
  if (!pid) throw new Error('fixture child PID absent')
  await lease.update('stopping', pid)
  const stale = await inspect(),
    prior = await readFile(ownerPath, 'utf8'),
    preference = await readFile(join(store.directory, 'preferences.json'), 'utf8')
  check(
    'an exited test-owned child yields a stale-record candidate without starting a core',
    stale.status === 'stale' && stale.canArchive && !!stale.revision
  )
  await writeFile(
    ownerPath,
    JSON.stringify({ ...JSON.parse(prior), createdAt: '2026-10-25T00:00:00.000Z' }),
    { mode: 0o600 }
  )
  check(
    'revision changed after preparation is refused before a move',
    (await refused(() => coreRecordRecoveryNative(native, context, 'archive', stale.revision))) &&
      (await lstat(join(store.directory, '.session'))).isDirectory()
  )
  await writeFile(ownerPath, prior, { mode: 0o600 })
  const archived = await coreRecordRecoveryNative(native, context, 'archive', stale.revision)
  check(
    'confirmed stale record is archived under a fresh identifier',
    archived.status === 'archived' && !!archived.archiveID && !archived.canArchive
  )
  if (!archived.archiveID) throw new Error('Archive identifier missing')
  const root = join(store.directory, 'AbandonedSessions', archived.archiveID)
  check(
    'archive preserves exact owner bytes and private permissions',
    (await readFile(join(root, 'owner.json'), 'utf8')) === prior &&
      ((await lstat(root)).mode & 0o7777) === 0o700 &&
      ((await lstat(join(root, 'owner.json'))).mode & 0o7777) === 0o600
  )
  check(
    'preferences are preserved and the active slot becomes missing',
    (await readFile(join(store.directory, 'preferences.json'), 'utf8')) === preference &&
      (await store.inspect()).lease === 'missing'
  )
  check(
    'archive evidence cannot be replayed into a second destructive action',
    (await refused(() => coreRecordRecoveryNative(native, context, 'archive', stale.revision))) &&
      (await readdir(join(store.directory, 'AbandonedSessions'))).length === 1
  )
  const next = await store.acquire('global', (await store.inspect()).revision)
  check(
    'new acquire remains an explicit separate operation, not native auto-start',
    (await store.inspect()).lease === 'present' && (await inspect()).status === 'liveOrUnknown'
  )
  const unknown = join(store.directory, '.session/unknown.txt')
  await writeFile(unknown, 'keep')
  check(
    'unknown session contents are preserved and block recovery inspection',
    (await refused(inspect)) && (await readFile(unknown, 'utf8')) === 'keep'
  )
  await rm(unknown)
  await next.release()
  check(
    'an unrelated native context path is rejected',
    await refused(() =>
      coreRecordRecoveryNative(
        native,
        { ...context, stateRoot: join(home, 'Library/Application Support/Other') },
        'inspect'
      )
    )
  )
} finally {
  await rm(home, { recursive: true, force: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  architectureExecuted: process.arch,
  intelRuntimeVerified: false,
  actualUserNetworkOrSystemConfigurationChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  processAdoptedOrTerminated: false,
  onlyProcessProbeUsed: 'signal zero; exited owned /usr/bin/true fixture',
  actualAppGuiVerified: false
}
await writeFile(
  '../evidence/core-record-recovery-verification.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Core record recovery contract failed.')
