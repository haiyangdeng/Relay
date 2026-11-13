import { spawn } from 'child_process'
import { mkdtemp, realpath, readFile, writeFile, lstat, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { readCoreSelectionNative, saveCoreSelectionNative } from '../../src/main/relay/native'
import { createCoreSelectionService } from '../../src/main/relay/core/selection'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { createClashBackend } from '../../src/main/relay/clash-backend'
import { createLocalProxyService } from '../../src/main/relay/core/local-proxy-service'
import { CoreStore } from '../../src/main/relay/core/store'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { probeLocalPort } from '../../src/main/relay/core/port'

const home = await realpath(await mkdtemp('/private/tmp/relay-core-selection-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  native = resolve('extra/relay/RelayNative'),
  profiles = new ProfileStore(context),
  store = new CoreStore(context)
const rows: { name: string; passed: boolean }[] = [],
  check = (name: string, passed: boolean): void => {
    rows.push({ name, passed })
  }
const selection = (v: { id: string; sha256: string }) => ({ id: v.id, sha256: v.sha256 })
const preferences = createCoreSelectionService({
  profiles,
  read: () => readCoreSelectionNative(native, context),
  save: (value, revision) => saveCoreSelectionNative(native, context, value, revision)
})
let launches = 0,
  locker: ReturnType<typeof spawn> | undefined
const local = createLocalProxyService({
  read: (v) => profiles.read(v),
  inspect: () => store.inspect(),
  resources: () => verifyCoreResource(resolve('extra/relay/core')),
  portAvailable: probeLocalPort,
  acquire: (runtime, revision) => store.acquire('rule', revision, runtime),
  start: async () => {
    ++launches
    throw new Error('No launch expected')
  },
  confirmStart: async () => false,
  confirmStop: async () => false
})
const backend = () =>
  createClashBackend({
    local,
    profiles,
    notify: () => {},
    readSelection: () => preferences.read(),
    rememberSelection: (v) => preferences.remember(v)
  })
try {
  const empty = await readCoreSelectionNative(native, context)
  let missing = false
  try {
    await lstat(store.directory)
  } catch {
    missing = true
  }
  check(
    'preference read is inert and returns no selection without creating directories',
    !empty.selection && missing
  )
  const a = await profiles.save('A', 'rules: ["MATCH,REJECT"]'),
    b = await profiles.save('B', 'rules: ["DOMAIN,b.invalid,REJECT", "MATCH,REJECT"]')
  const first = backend()
  await first.invoke('changeCurrentProfile', [a.id])
  const saved = await readCoreSelectionNative(native, context)
  check(
    'ordinary profile selection persists only UUID and source digest',
    saved.selection?.id === a.id && saved.selection.sha256 === a.sha256
  )
  const file = join(store.directory, 'selection.json'),
    original = await readFile(file, 'utf8')
  check(
    'selection file has private permissions and no original path or credentials',
    ((await lstat(file)).mode & 0o7777) === 0o600 &&
      !original.includes(home) &&
      Object.keys(JSON.parse(original)).sort().join(',') === 'selection,version'
  )
  const reopened = backend(),
    config = (await reopened.invoke('getProfileConfig', [])) as { current?: string }
  check(
    'a fresh backend restores validated current source identity without launching a core',
    config.current === a.id &&
      launches === 0 &&
      !local.state().owned &&
      (await store.inspect()).lease === 'missing'
  )
  check(
    'stale preference revision cannot overwrite a committed newer choice',
    await (async () => {
      try {
        await saveCoreSelectionNative(native, context, selection(b), empty.revision)
        return false
      } catch {
        return (await readCoreSelectionNative(native, context)).selection?.id === a.id
      }
    })()
  )
  locker = spawn(
    '/usr/bin/python3',
    [
      '-c',
      'import os,sys,fcntl; f=os.open(sys.argv[1],os.O_RDWR); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read(1); os.close(f)',
      join(store.directory, '.selection.lock')
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  await new Promise<void>((yes, no) => {
    locker?.once('error', no)
    locker?.stdout?.once('data', () => yes())
  })
  let locked = false
  try {
    await saveCoreSelectionNative(native, context, selection(b), saved.revision)
  } catch {
    locked = true
  }
  check(
    'kernel advisory lock blocks concurrent writers without truncating the selected record',
    locked && (await readFile(file, 'utf8')) === original
  )
  const released = new Promise<void>((yes, no) => {
    locker?.once('error', no)
    locker?.once('close', () => yes())
  })
  locker.stdin?.end('x')
  await released
  locker = undefined
  await preferences.remember(selection(b))
  check(
    'normal subsequent choice succeeds after lock release',
    (await preferences.read())?.id === b.id
  )
  const bad = '{"version":1,"selection":null,"unknown":"PRIVATE keep"}'
  await writeFile(file, bad, { mode: 0o600 })
  let rejected = false
  try {
    await preferences.read()
  } catch {
    rejected = true
  }
  check(
    'unknown preference data is preserved instead of overwritten or used to start a core',
    rejected && (await readFile(file, 'utf8')) === bad && launches === 0
  )
  const current = { version: 1, selection: selection(a) }
  await writeFile(file, JSON.stringify(current), { mode: 0o600 })
  await writeFile(join(profiles.directory, a.id, 'profile.yaml'), 'changed', { mode: 0o600 })
  let sourceRejected = false
  try {
    await preferences.read()
  } catch {
    sourceRejected = true
  }
  check(
    'source body hash is revalidated on restoration, with no fallback to another profile',
    sourceRejected && launches === 0
  )
} finally {
  locker?.stdin?.end('x')
  await rm(home, { recursive: true, force: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  architectureExecuted: process.arch,
  intelRuntimeVerified: false,
  automaticCoreLaunch: false,
  actualUserNetworkOrSystemConfigurationChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  actualAppGuiVerified: false
}
await writeFile(
  '../evidence/core-selection-verification.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Core selection contract failed.')
