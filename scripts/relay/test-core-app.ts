import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { CoreStore } from '../../src/main/relay/core/store'
import { createCoreService } from '../../src/main/relay/core/service'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { startIsolatedCore } from '../../src/main/relay/core/isolated-runtime'

// Real core + real private files, but never the main App, real HOME or traffic.
// All instances retain ports=0 and DNS/TUN/NTP disabled, including Direct mode.
const home = await realpath(await mkdtemp('/private/tmp/relay-core-app-'))
const root = resolve('extra/relay/core'),
  run = promisify(execFile)
const store = new CoreStore({
  home,
  stateRoot: join(home, 'Library/Application Support/Relay-Preview')
})
let confirmed = false,
  started = 0,
  lastDirectory: string | undefined
const service = createCoreService({
  inspect: () => store.inspect(),
  resources: () => verifyCoreResource(root),
  acquire: (mode, revision) => store.acquire(mode, revision),
  start: async (mode, register) => {
    ++started
    const child = await startIsolatedCore(root, mode, register)
    lastDirectory = child.directory
    const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-i'], {
      timeout: 3000
    }).catch((error) => {
      const result = error as { code?: number; stdout?: string; stderr?: string }
      if (result.code === 1 && !result.stdout?.trim() && !result.stderr?.trim())
        return { stdout: '' }
      throw error
    })
    check(`no Internet socket on owned ${mode} instance`, !stdout.trim())
    return child
  },
  confirm: async () => confirmed
})
const rows: { name: string; passed: boolean }[] = []
function check(name: string, passed: boolean): void {
  rows.push({ name, passed })
}
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}
try {
  check('creation and cached state do not create Core files', await absent(store.directory))
  const cancelled = await service.prepare({ mode: 'global' })
  check('prepare only validates pinned resource and reads own state', await absent(store.directory))
  check(
    'cancelled confirmation does not start',
    (await service.action({ action: 'start', evidenceId: cancelled.evidenceId })).status ===
      'cancelled' && started === 0
  )
  check('cancelled confirmation does not persist', await absent(store.directory))
  confirmed = true
  for (const mode of ['global', 'direct', 'rule'] as const) {
    const proof = await service.prepare({ mode })
    const result = await service.action({ action: 'start', evidenceId: proof.evidenceId })
    check(
      `${mode} runs with main-service ownership and no traffic claim`,
      result.status === 'started' && result.state.owned && !result.state.trafficEnabled
    )
    const record = JSON.parse(
      await readFile(join(store.directory, '.session/owner.json'), 'utf8')
    ) as { phase: string; mode: string; pid?: number }
    check(
      `${mode} running record published before result`,
      record.phase === 'running' && record.mode === mode && !!record.pid
    )
    let excluded = false
    try {
      await store.acquire(mode, (await store.inspect()).revision)
    } catch {
      excluded = true
    }
    check(
      `${mode} excludes a second owner without stopping this one`,
      excluded && service.state().phase === 'running'
    )
    const ended =
      mode === 'rule'
        ? await service.requestClose()
        : (await service.action({ action: 'stop' })).status === 'stopped'
    check(
      `${mode} stop/quit waits for cleanup`,
      ended &&
        !service.state().owned &&
        lastDirectory !== undefined &&
        (await absent(lastDirectory))
    )
    check(
      `${mode} preference survives and session record is removed`,
      (await store.inspect()).mode === mode && (await store.inspect()).lease === 'missing'
    )
  }
  const lease = await store.acquire('direct', (await store.inspect()).revision)
  try {
    await lease.update('running', 99999) // Informational fixture PID; never signaled/adopted.
    const other = createCoreService({
      inspect: () => store.inspect(),
      resources: () => verifyCoreResource(root),
      acquire: () => {
        throw new Error('must not acquire')
      },
      start: () => {
        throw new Error('must not start')
      },
      confirm: async () => true
    })
    const proof = await other.prepare({ mode: 'rule' })
    check(
      'another App session sees saved mode but cannot adopt old record',
      other.state().mode === 'direct' && !proof.canStart
    )
    let rejected = false
    try {
      await other.action({ action: 'stop' })
    } catch {
      rejected = true
    }
    check(
      'record-only session refuses PID-based stop and may close untouched',
      rejected && (await other.requestClose())
    )
    check(
      'foreign record contents remain intact',
      JSON.parse(await readFile(join(store.directory, '.session/owner.json'), 'utf8')).pid === 99999
    )
  } finally {
    await lease.release()
  }
  const prefs = join(store.directory, 'preferences.json'),
    previous = await readFile(prefs, 'utf8')
  await writeFile(prefs, '{"version":2,"PRIVATE":"preserve"}', { mode: 0o600 })
  let blocked = false
  try {
    await service.prepare({ mode: 'rule' })
  } catch {
    blocked = true
  }
  check(
    'unknown preference version blocks start without overwrite',
    blocked && (await readFile(prefs, 'utf8')) === '{"version":2,"PRIVATE":"preserve"}'
  )
  await writeFile(prefs, previous, { mode: 0o600 })
} finally {
  await cleanupFixture()
}
async function cleanupFixture(): Promise<void> {
  const closed = await service.requestClose()
  if (!closed || service.isBlocking())
    throw new Error('Owned isolated cleanup remains unconfirmed; fixture preserved.')
  await rm(home, { recursive: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  ownIsolatedCoreExecuted: true,
  architectureExecuted: process.arch,
  intelRuntimeVerified: process.arch === 'x64',
  fakeHomeOnly: true,
  mainAppOrBrowserLaunched: false,
  actualUserStateWritten: false,
  actualClashStoppedOrRestarted: false,
  actualSystemProxyDNSOrTUNChanged: false,
  ownTrafficBackendEnabled: false,
  noDirectProtectionVerified: false
}
await writeFile('../evidence/core-app-contract.json', JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.passed !== report.checks) throw new Error('Core App control contract failed.')
