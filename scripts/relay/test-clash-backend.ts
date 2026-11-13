import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { createConnection } from 'net'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { CoreStore } from '../../src/main/relay/core/store'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { createLocalProxyService } from '../../src/main/relay/core/local-proxy-service'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import { probeLocalPort } from '../../src/main/relay/core/port'
import { createClashBackend } from '../../src/main/relay/clash-backend'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'

const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
const home = await mkdtemp('/private/tmp/relay-clash-backend-'),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
const network = await createLocalNetworkFixture()
const coreRoot = resolve('extra/relay/core'),
  profiles = new ProfileStore(context),
  coreStore = new CoreStore(context)
let cleanup: (() => Promise<void>) | undefined
let held: ReturnType<typeof createConnection> | undefined
let allowMode = false,
  allowProbe = false,
  modeConfirmations = 0,
  notifications = 0
const local = createLocalProxyService({
  read: (selection) => profiles.read(selection),
  inspect: () => coreStore.inspect(),
  resources: () => verifyCoreResource(coreRoot),
  portAvailable: probeLocalPort,
  acquire: (runtime, revision) => coreStore.acquire('rule', revision, runtime),
  start: (source, port, register, mode) =>
    startLocalProxyCore(
      coreRoot,
      source,
      port,
      (stop) => {
        cleanup = stop
        register(stop)
      },
      mode
    ),
  confirmStart: async () => true,
  confirmStop: async () => true,
  confirmMode: async () => {
    ++modeConfirmations
    return allowMode
  },
  confirmTest: async () => allowProbe
})
const backend = createClashBackend({
  local,
  profiles,
  notify: () => {
    ++notifications
  }
})
const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
  backend.invoke(channel, args)
try {
  const a = await profiles.save('Profile A', network.source)
  const next = JSON.parse(network.source)
  next['proxy-providers'] = { P: { type: 'inline', payload: next.proxies } }
  next.proxies = []
  next['proxy-groups'][0].use = ['P']
  delete next['proxy-groups'][0].proxies
  next['proxy-groups'][0]['default-selected'] = 'NodeB'
  const b = await profiles.save('Profile B', JSON.stringify(next))
  const initial = (await call('getControledMihomoConfig')) as Record<string, unknown>
  check(
    'no mode is reported as running before an owned proxy exists',
    initial.mode === undefined && initial.port === 0
  )
  let refused = false
  try {
    await call('patchMihomoConfig', { mode: 'global' })
  } catch {
    refused = true
  }
  check(
    'mode switch without an owned live instance cannot start or modify a core',
    refused && modeConfirmations === 0 && (await coreStore.inspect()).lease === 'missing'
  )
  await call('changeCurrentProfile', a.id)
  const chosen = (await call('getProfileConfig')) as { current?: string; items: { id: string }[] }
  check(
    'original profile channel lists private UUID copies and selects without launching',
    chosen.current === a.id && chosen.items.length === 2 && !local.state().owned
  )
  check(
    'source editor reads only the selected private copy',
    (await call('getProfileStr', a.id)) === network.source
  )
  refused = false
  try {
    await call('getProfileStr', '/PRIVATE')
  } catch {
    refused = true
  }
  check('arbitrary paths cannot be passed as a profile ID', refused)
  const port = await freeFixturePort()
  const prepared = await local.prepare({ profile: { id: a.id, sha256: a.sha256 }, httpPort: port })
  const started = await local.action({ action: 'start', evidenceId: prepared.evidenceId })
  check(
    'real controlled proxy starts with the selected source identity',
    started.status === 'started' && local.state().profileId === a.id
  )
  const config = (await call('getControledMihomoConfig')) as Record<string, unknown>
  check(
    'original config getter reports actual owned rule mode and bound port',
    config.mode === 'rule' && config.port === port
  )
  const groups = (await call('mihomoGroups', false)) as { name: string; all: { name: string }[] }[]
  check(
    'original node channel expands actual member records including GLOBAL',
    groups.some(
      (g) => g.name === network.group && g.all.map((n) => n.name).join(',') === 'NodeA,NodeB'
    ) && groups.some((g) => g.name === 'GLOBAL')
  )
  const body = (await call('getRuntimeConfigStr')) as string
  const runtime = JSON.parse(body)
  check(
    'runtime viewer is bound to generated running bytes rather than user system configuration',
    runtime.port === port && runtime.tun.enable === false && runtime.proxies.length === 2
  )
  await call('patchControledMihomoConfig', { mode: 'global' })
  check(
    'cancelled native mode consent preserves actual mode',
    modeConfirmations === 1 &&
      ((await call('getControledMihomoConfig')) as Record<string, unknown>).mode === 'rule'
  )
  const origin = new URL(network.healthURL)
  held = createConnection({ host: '127.0.0.1', port })
  held.on('error', () => {})
  const socket = held
  await new Promise<void>((resolve, reject) => {
    let bytes = ''
    const receive = (chunk: Buffer): void => {
      bytes += chunk.toString('utf8')
      if (bytes.length > 8192) {
        socket.destroy()
        reject(new Error('fixture CONNECT budget'))
      } else if (bytes.includes('\r\n\r\n')) {
        socket.off('data', receive)
        ;/^HTTP\/1\.[01] 200 /u.test(bytes)
          ? resolve()
          : reject(new Error('fixture CONNECT failed'))
      }
    }
    socket.setTimeout(5000, () => socket.destroy(new Error('fixture held timeout')))
    socket.on('data', receive)
    socket.once('error', reject)
    socket.once('connect', () =>
      socket.write(`CONNECT ${origin.host} HTTP/1.1\r\nHost: ${origin.host}\r\n\r\n`)
    )
  })
  await new Promise<void>((resolve, reject) => {
    let response = ''
    const receive = (chunk: Buffer): void => {
      response += chunk.toString('utf8')
      if (response.includes('\r\n\r\nx')) {
        socket.off('data', receive)
        resolve()
      } else if (response.length > 8192) {
        socket.destroy()
        reject(new Error('fixture warmup budget'))
      }
    }
    socket.on('data', receive)
    socket.once('error', reject)
    socket.write(
      `GET /hold-open HTTP/1.1\r\nHost: ${origin.host}\r\nConnection: keep-alive\r\n\r\n`
    )
  })
  const before = network.stats()
  check('held stream is established through fixture A before mode changes', before.usedA > 0)
  await call('mihomoChangeProxy', 'GLOBAL', 'NodeB')
  allowMode = true
  await call('patchControledMihomoConfig', { mode: 'global' })
  const once = modeConfirmations
  await call('patchMihomoConfig', { mode: 'global' })
  check(
    'idempotent compatibility patch does not reconfirm or issue another logical transition',
    modeConfirmations === once && local.state().mode === 'global'
  )
  const globalGroups = (await call('mihomoGroups')) as { name: string }[]
  check('global mode orders GLOBAL first', globalGroups[0].name === 'GLOBAL')
  const globalResponse = await network.request(port, 'global-B')
  check(
    'new Global request uses the selected real proxy B',
    globalResponse.includes('origin:/global-B') && network.stats().usedB === before.usedB + 1
  )
  const heldBody = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    socket.on('data', (c: Buffer) => chunks.push(c))
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.once('error', reject)
    socket.write(`GET /held-A HTTP/1.1\r\nHost: ${origin.host}\r\nConnection: close\r\n\r\n`)
  })
  check(
    'existing CONNECT stream survives mode switch without a connection close action',
    heldBody.includes('origin:/held-A') && network.stats().usedA === before.usedA
  )
  const previous = network.stats()
  await call('patchControledMihomoConfig', { mode: 'direct' })
  check(
    'Direct mode is confirmed from the real controller',
    ((await call('getControledMihomoConfig')) as Record<string, unknown>).mode === 'direct' &&
      ((await call('mihomoGroups')) as unknown[]).length === 0
  )
  const direct = await network.request(port, 'explicit-direct')
  check(
    'explicit Direct mode reaches only this test origin with no proxy fixture hop',
    direct.includes('origin:/explicit-direct') &&
      network.stats().usedA === previous.usedA &&
      network.stats().usedB === previous.usedB
  )
  await call('patchControledMihomoConfig', { mode: 'rule' })
  await call('mihomoChangeProxy', network.group, 'NodeA')
  const ruleBefore = network.stats().usedA
  check(
    'Rule mode returns to original group routing',
    (await network.request(port, 'rule-A')).includes('origin:/rule-A') &&
      network.stats().usedA === ruleBefore + 1
  )
  refused = false
  try {
    await call('changeCurrentProfile', b.id)
  } catch {
    refused = true
  }
  check(
    'default-cancel profile reload cannot silently stop or restart a running instance',
    !refused && local.state().profileId === a.id
  )
  const count = network.stats().originRequests
  refused = false
  try {
    await call('mihomoProxyDelay', 'NodeB', network.healthURL)
  } catch {
    refused = true
  }
  check(
    'cancelled speed confirmation performs no request',
    refused && network.stats().originRequests === count
  )
  allowProbe = true
  const tests = (await Promise.all([
    call('mihomoProxyDelay', 'NodeA', network.healthURL),
    call('mihomoProxyDelay', 'NodeB', network.healthURL)
  ])) as { delay: number }[]
  check(
    'ordinary parallel UI speed requests serialize into actual successful node probes',
    tests.every((t) => t.delay > 0) && network.stats().originRequests === count + 2
  )
  refused = false
  try {
    await call('patchMihomoConfig', { mode: 'global', tun: { enable: true } })
  } catch {
    refused = true
  }
  check(
    'combined mode and TUN payload is rejected atomically',
    refused && local.state().mode === 'rule'
  )
  refused = false
  try {
    await call('mihomoChangeProxy', network.group, 'Injected')
  } catch {
    refused = true
  }
  check('unknown group member cannot cause a write or fallback', refused)
  check(
    'runtime rules and version come from the pinned actual controller',
    ((await call('mihomoVersion')) as Record<string, unknown>).version === 'v1.19.33' &&
      Array.isArray(((await call('mihomoRules')) as Record<string, unknown>).rules)
  )
  check('successful operations notify original contexts', notifications >= 7)
  check(
    'owned proxy closes and releases its own lease',
    (await local.requestClose()) === 'closed' && (await coreStore.inspect()).lease === 'missing'
  )
  await call('changeCurrentProfile', b.id)
  check(
    'stopped source can change without touching the original copy',
    ((await call('getProfileConfig')) as { current: string }).current === b.id &&
      (await profiles.read({ id: a.id, sha256: a.sha256 })).text === network.source
  )
  const second = await local.prepare({ profile: { id: b.id, sha256: b.sha256 }, httpPort: port })
  const secondStart = await local.action({ action: 'start', evidenceId: second.evidenceId })
  check(
    'selected second profile starts as a new owned instance',
    secondStart.status === 'started' && local.state().profileId === b.id
  )
  const mixed = (await call('mihomoGroups')) as {
    name: string
    now?: string
    all: { name: string; 'provider-name'?: string }[]
  }[]
  const providerGroup = mixed.find((g) => g.name === network.group)
  check(
    'original group view includes complete provider-node objects',
    providerGroup?.all.length === 2 && providerGroup.all.every((n) => n['provider-name'] === 'P')
  )
  check('provider default-selected is actual core state', providerGroup?.now === 'NodeB')
  check(
    'ordinary provider speed channel uses the real provider-specific endpoint',
    ((await call('mihomoProxyDelay', 'NodeA', network.healthURL, 'P')) as { delay: number }).delay >
      0
  )
  check(
    'second owned instance and lease close cleanly',
    (await local.requestClose()) === 'closed' && (await coreStore.inspect()).lease === 'missing'
  )
} finally {
  held?.destroy()
  await cleanup?.()
  await network.close()
  await rm(home, { recursive: true, force: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((r) => r.passed).length,
  rows,
  architectureExecuted: process.arch,
  fakeHomeAndOwnedLoopbackOnly: true,
  actualUserNetworkOrSystemConfigurationChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  realUserClientBrowserOrAccountUsed: false,
  originalGuiAcceptance: false,
  fullNormalBackendComplete: false,
  liveNoDirectGuardVerified: false
}
await writeFile(
  '../evidence/clash-backend-verification.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Owned Clash backend contract failed.')
