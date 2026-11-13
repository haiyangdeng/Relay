import { mkdtemp, realpath, readFile, writeFile, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { setTimeout as delay } from 'timers/promises'
import { createCoreLifecycle } from '../../src/main/relay/core/lifecycle'
import { createCoreService } from '../../src/main/relay/core/service'
import {
  startIsolatedCore,
  type RelayIsolatedCore
} from '../../src/main/relay/core/isolated-runtime'
import { createLocalProxyService } from '../../src/main/relay/core/local-proxy-service'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import type { RelayOwnedCore } from '../../src/main/relay/core/owned-runtime'
import { CoreStore } from '../../src/main/relay/core/store'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { probeLocalPort } from '../../src/main/relay/core/port'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'

const home = await realpath(await mkdtemp('/private/tmp/relay-core-lifecycle-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  store = new CoreStore(context),
  profiles = new ProfileStore(context),
  root = resolve('extra/relay/core'),
  network = await createLocalNetworkFixture()
const rows: { name: string; passed: boolean }[] = [],
  check = (name: string, passed: boolean): void => {
    rows.push({ name, passed })
  }
let inert: RelayIsolatedCore | undefined,
  proxy: RelayOwnedCore | undefined,
  inertLaunches = 0,
  proxyLaunches = 0,
  pauses = 0,
  resumes = 0
const cleanup: (() => Promise<void>)[] = []
const coreAdapters = {
  inspect: () => store.inspect(),
  resources: () => verifyCoreResource(root),
  acquire: (mode: 'rule' | 'global' | 'direct', revision: string) => store.acquire(mode, revision),
  start: async (
    mode: 'rule' | 'global' | 'direct',
    register: (stop: () => Promise<void>) => void
  ) => {
    ++inertLaunches
    inert = await startIsolatedCore(root, mode, (stop) => {
      cleanup.push(stop)
      register(stop)
    })
    return inert
  },
  confirm: async () => true
}
const core = createCoreService(coreAdapters)
const local = createLocalProxyService({
  read: (selection) => profiles.read(selection),
  inspect: () => store.inspect(),
  resources: () => verifyCoreResource(root),
  portAvailable: probeLocalPort,
  acquire: (runtime, revision) => store.acquire('rule', revision, runtime),
  start: async (source, port, register, mode) => {
    ++proxyLaunches
    proxy = await startLocalProxyCore(
      root,
      source,
      port,
      (stop) => {
        cleanup.push(stop)
        register(stop)
      },
      mode
    )
    return proxy
  },
  confirmStart: async () => true,
  confirmStop: async () => true
})
const life = createCoreLifecycle({
  invalidate: () => {
    core.invalidatePending()
    local.invalidatePending()
  },
  pauseScheduling: async () => {
    ++pauses
  },
  resumeScheduling: () => {
    ++resumes
  },
  observeCore: () => core.observeOwned(),
  observeProxy: async () => {
    await local.whenIdle()
    const state = local.state()
    if (!state.owned) return 'none'
    if (state.traffic === 'inactive') return 'unexpectedExit'
    return (await local.inspectLive()) ? 'running' : 'unconfirmed'
  },
  notify: () => {}
})
async function waitExit(child: RelayIsolatedCore): Promise<void> {
  for (let n = 0; n < 100 && child.state() !== 'unexpectedExit'; ++n) await delay(25)
  if (child.state() !== 'unexpectedExit') throw new Error('Owned fault child did not exit')
}
try {
  await writeFile(join(home, 'unrelated-development-config'), 'untouched', { mode: 0o600 })
  check(
    'lifecycle constructor does not inspect, launch or schedule work',
    inertLaunches === 0 &&
      proxyLaunches === 0 &&
      pauses === 0 &&
      resumes === 0 &&
      !life.state().observed
  )
  const stale = await core.prepare({ mode: 'rule' })
  await life.suspend()
  let rejected = false
  try {
    await core.action({ action: 'start', evidenceId: stale.evidenceId })
  } catch {
    rejected = true
  }
  check(
    'sleep invalidates an uncommitted isolated start proof without launching',
    rejected && inertLaunches === 0
  )
  await life.resume()
  const plan = await core.prepare({ mode: 'rule' })
  const start = await core.action({ action: 'start', evidenceId: plan.evidenceId })
  if (!inert || start.status !== 'started') throw new Error('Missing inert owned fixture')
  const child = inert as RelayIsolatedCore,
    pid = child.pid
  await life.suspend()
  await life.resume()
  check(
    'wake reads real private core interface without restarting or changing ownership',
    life.state().core === 'running' &&
      child.pid === pid &&
      inertLaunches === 1 &&
      (await store.inspect()).lease !== 'missing'
  )
  // The PID comes only from the live child object created immediately above.
  // Never read, signal, adopt or infer process identity from a disk record.
  process.kill(child.pid, 'SIGTERM')
  await waitExit(child)
  const beforeResumes = resumes
  await life.recheck()
  check(
    'owned unexpected exit is reported and scheduling remains paused without retry',
    core.state().phase === 'failed' &&
      life.state().core === 'unexpectedExit' &&
      life.state().phase === 'attention' &&
      resumes === beforeResumes &&
      inertLaunches === 1
  )
  const reopened = createCoreService(coreAdapters),
    blocked = await reopened.prepare({ mode: 'rule' })
  check(
    'new service does not adopt a stale PID or automatically relaunch',
    !blocked.canStart && !reopened.state().owned && inertLaunches === 1
  )
  check(
    'explicit cleanup releases only the current nonce-owned record',
    (await core.action({ action: 'stop' })).status === 'stopped' &&
      (await store.inspect()).lease === 'missing'
  )
  const saved = await profiles.save('Loopback only', network.source),
    port = await freeFixturePort()
  const localPlan = await local.prepare({
    profile: { id: saved.id, sha256: saved.sha256 },
    httpPort: port
  })
  if (
    (await local.action({ action: 'start', evidenceId: localPlan.evidenceId })).status !==
      'started' ||
    !proxy
  )
    throw new Error('Missing proxy fixture')
  const running = proxy as RelayOwnedCore,
    instanceId = local.state().instanceId
  await network.request(port, 'before-sleep')
  await life.suspend()
  await life.resume()
  await network.request(port, 'after-wake')
  check(
    'live proxy retains the same child, instance, port and actual loopback routing across notifications',
    proxyLaunches === 1 &&
      local.state().instanceId === instanceId &&
      life.state().localProxy === 'running' &&
      network.stats().usedA === 2
  )
  process.kill(running.pid, 'SIGTERM')
  await waitExit(running)
  const resumeCount = resumes,
    stats = JSON.stringify(network.stats())
  await life.recheck()
  let failedRequest = false
  try {
    await network.request(port, 'after-exit')
  } catch {
    failedRequest = true
  }
  check(
    'dead proxy removes confirmed group selection and reports inactive traffic',
    local.state().phase === 'failed' &&
      local.state().traffic === 'inactive' &&
      local.state().groups.every((group) => !group.confirmed && group.now === undefined)
  )
  check(
    'failed proxy does not start a new core or fall back directly to the loopback origin',
    failedRequest &&
      life.state().localProxy === 'unexpectedExit' &&
      resumes === resumeCount &&
      proxyLaunches === 1 &&
      JSON.stringify(network.stats()) === stats
  )
  check(
    'explicit local cleanup preserves immutable source and releases its own record',
    (await local.action({ action: 'stop', instanceId })).status === 'stopped' &&
      (await store.inspect()).lease === 'missing' &&
      (await profiles.read({ id: saved.id, sha256: saved.sha256 })).text === network.source
  )
  await life.recheck()
  check(
    'manual fresh recheck resumes authorized scheduling only after both owned slots are empty',
    life.state().phase === 'awake' &&
      life.state().core === 'none' &&
      life.state().localProxy === 'none' &&
      resumes === resumeCount + 1
  )
  await life.close()
  const closedGeneration = life.state().generation
  await life.suspend()
  await life.resume()
  check(
    'closed lifecycle ignores subsequent notifications and leaves unrelated development data intact',
    life.state().generation === closedGeneration &&
      (await readFile(join(home, 'unrelated-development-config'), 'utf8')) === 'untouched'
  )
} finally {
  await life.close()
  for (const stop of cleanup.reverse()) await stop()
  await network.close()
  await rm(home, { recursive: true, force: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  architectureExecuted: process.arch,
  intelRuntimeVerified: false,
  operatingSystemActuallySlept: false,
  notificationsInvokedThroughLifecycle: true,
  actualUserConfigurationChanged: false,
  onlyOwnedFixtureChildrenSignalled: true
}
await writeFile(
  '../evidence/core-lifecycle-verification.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.passed !== report.checks) process.exitCode = 1
