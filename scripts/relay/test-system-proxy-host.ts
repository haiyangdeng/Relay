// NEVER run as an ordinary regression. The caller must first obtain the user's
// consent for this exact real macOS proxy change and its restoration.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { userInfo } from 'os'
import { resolve, join } from 'path'
import { writeFile } from 'fs/promises'
import { inspectEdgeNative, systemProxyNative } from '../../src/main/relay/native'
import {
  defaultSystemBypass,
  type NativeSystemProxySettings,
  type SystemProxyReport
} from '../../src/shared/relay/system-proxy'
import { startPacServer, type OwnedPacServer } from '../../src/main/relay/system-proxy/pac'
import { defaultPacScript } from '../../src/shared/relay/system-proxy'
import { verifyProxyTarget } from '../../src/main/relay/system-proxy/target'
import {
  captureProtectedConfiguration,
  captureSystemRuntime,
  compareProtectedConfiguration,
  hostRestorationAccepted,
  probeClaudeTransport,
  sameClaudeTransport,
  type ProtectedConfigurationSnapshot,
  type SystemRuntimeObservation,
  type ClaudeTransportObservation
} from '../../src/main/relay/system-proxy/acceptance'

const args = process.argv.slice(2)
if (
  args.length !== 7 ||
  args[0] !== '--service-id' ||
  args[2] !== '--interface' ||
  args[4] !== '--proxy-port' ||
  !['--allow-system-proxy-test', '--preflight-only'].includes(args[6])
)
  throw new Error(
    'Requires a specifically approved service/interface/port and --allow-system-proxy-test, or read-only --preflight-only. Do not write system settings without fresh user consent.'
  )
const serviceID = args[1],
  interfaceName = args[3],
  port = Number(args[5]),
  preflightOnly = args[6] === '--preflight-only'
if (
  !/^[A-Fa-f0-9-]{36}$/u.test(serviceID) ||
  !/^en[0-9]{1,3}$/u.test(interfaceName) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Invalid explicit test scope')
const identity = userInfo()
if (identity.uid === 0 || identity.uid !== process.getuid?.())
  throw new Error('Current unprivileged user required')
const context = {
    home: identity.homedir,
    stateRoot: join(identity.homedir, 'Library/Application Support/Relay-Preview')
  },
  native = resolve('extra/relay/RelayNative'),
  exec = promisify(execFile)
const rows: { name: string; passed: boolean }[] = [],
  check = (name: string, passed: boolean): void => {
    rows.push({ name, passed })
  }
let original: SystemProxyReport | undefined,
  last: SystemProxyReport | undefined,
  pac: OwnedPacServer | undefined,
  submitted = false,
  authorizationOrExecutionUnavailable = false,
  restored = false,
  protectionBefore: ProtectedConfigurationSnapshot | undefined,
  protectionAfter: ProtectedConfigurationSnapshot | undefined,
  runtimeBefore: SystemRuntimeObservation | undefined,
  runtimeAfter: SystemRuntimeObservation | undefined,
  transportBefore: ClaudeTransportObservation[] | undefined,
  transportAfter: ClaudeTransportObservation[] | undefined,
  configurationUnchanged = false,
  systemRuntimeRestored = false,
  transportRestored = false,
  temporaryResourcesClosed = true,
  preflightPassed = false,
  executionStage = 'preflight',
  failureStage: string | undefined,
  applicationStatus: SystemProxyReport['status'] | undefined,
  applicationWarnings: string[] = [],
  changedConfigurationLabels: string[] = []
const inspect = async () => (last = await systemProxyNative(native, context, 'inspect'))
const protect = async (): Promise<ProtectedConfigurationSnapshot> =>
  captureProtectedConfiguration(
    identity.homedir,
    (await inspectEdgeNative(native, context)).revision
  )
const inactive = async (): Promise<void> => {
  const { stdout } = await exec('/sbin/ifconfig', [interfaceName], {
    timeout: 3000,
    maxBuffer: 65536
  })
  if (!/status: inactive\b/u.test(stdout) || /^\s+inet6?\s/mu.test(stdout))
    throw new Error('Chosen interface is active or has an IP address; test refused')
}
try {
  await inactive()
  original = await inspect()
  const service = original.services.find((item) => item.id === serviceID)
  if (!service?.enabled || !service.name.endsWith(`(${interfaceName})`) || original.recordID)
    throw new Error(
      'Selected inactive service identity or existing restoration state differs; test refused'
    )
  const settings = {
    mode: 'manual' as const,
    host: '127.0.0.1',
    port,
    socks: false,
    bypass: [...defaultSystemBypass],
    excludeSimple: true,
    serviceIDs: [serviceID],
    pacScript: defaultPacScript
  }
  await verifyProxyTarget(settings)
  protectionBefore = await protect()
  runtimeBefore = await captureSystemRuntime()
  transportBefore = await probeClaudeTransport(port)
  check(
    'preflight verifies exact enabled but physically inactive service, no IP, current user and reachable existing proxy',
    true
  )
  check(
    'known Claude/Code/Clash/browser protection baseline is readable without storing secrets',
    true
  )
  check(
    'existing proxy reaches Claude endpoints with verified TLS and no account credentials',
    transportBefore.length === 2
  )
  preflightPassed = true
  check('effective macOS proxy and DNS baselines are readable without changing settings', true)
  for (const mode of preflightOnly ? [] : (['manual', 'pac'] as const)) {
    executionStage = `${mode}:inactive-interface-check`
    await inactive()
    if (mode === 'pac') {
      pac = await startPacServer({ ...settings, mode })
      temporaryResourcesClosed = false
    }
    const { pacScript: _script, ...fields } = settings
    const candidate: NativeSystemProxySettings = {
      ...fields,
      mode,
      ...(pac ? { pacURL: pac.url } : {})
    }
    executionStage = `${mode}:prepare`
    const plan = await systemProxyNative(native, context, 'prepare', candidate)
    if (!plan.canApply) throw new Error('Native conditions no longer permit application')
    submitted = true
    executionStage = `${mode}:apply`
    last = await systemProxyNative(native, context, 'apply', candidate, plan.revision)
    applicationStatus = last.status
    applicationWarnings = last.warnings
    if (last.status !== 'applied') {
      authorizationOrExecutionUnavailable = true
      throw new Error('Actual system proxy application was not confirmed')
    }
    const applied = last.services.find((item) => item.id === serviceID)
    check(
      `actual macOS ${mode} proxy preferences commit with durable recovery record`,
      !!last.recordID &&
        last.canRestore &&
        (mode === 'manual'
          ? applied?.http === true && applied.https === true && !applied.pac
          : applied?.pac === true && !applied.http && !applied.https)
    )
    check(
      `other network services retain their observed proxy modes after ${mode}`,
      original.services
        .filter((item) => item.id !== serviceID)
        .every(
          (item) =>
            JSON.stringify(last?.services.find((value) => value.id === item.id)) ===
            JSON.stringify(item)
        )
    )
  }
} catch {
  failureStage = executionStage
  check(
    submitted ? 'actual system application completed' : 'preflight completed before any submission',
    false
  )
} finally {
  if (submitted) {
    try {
      const current = await inspect()
      if (current.recordID) {
        const plan = await systemProxyNative(native, context, 'prepareRestore')
        if (plan.canRestore)
          last = await systemProxyNative(native, context, 'restore', undefined, plan.revision)
      }
      const final = await inspect()
      restored = !!original && !final.recordID && final.revision === original.revision
      check(
        'restoration rechecks the exact original full snapshot and removes only its active pointer',
        restored
      )
    } catch {
      restored = false
      check('restoration confirmed without overwriting external changes', false)
    }
  }
  // A possibly referenced PAC stays running if restoration is unconfirmed.
  // No forceful process exit: the user must resolve the preserved record first.
  if ((!submitted || restored) && pac) {
    try {
      await pac.close()
      let stillAccepting = false
      try {
        await verifyProxyTarget({
          mode: 'pac',
          host: '127.0.0.1',
          port: Number(new URL(pac.url).port),
          socks: false,
          bypass: [],
          excludeSimple: true,
          serviceIDs: [serviceID],
          pacScript: defaultPacScript
        })
        stillAccepting = true
      } catch {
        /* No listener is expected after our owned close. */
      }
      temporaryResourcesClosed = !stillAccepting
    } catch {
      temporaryResourcesClosed = false
    }
  }
  if (preflightPassed) {
    check(
      'temporary owned PAC is closed and its port is no longer accepting connections',
      temporaryResourcesClosed
    )
    try {
      if (protectionBefore)
        changedConfigurationLabels = compareProtectedConfiguration(
          protectionBefore,
          (protectionAfter = await protect())
        )
      configurationUnchanged = !!protectionBefore && changedConfigurationLabels.length === 0
      check(
        'known Claude/Code/Clash/browser protection configuration matches its baseline',
        configurationUnchanged
      )
    } catch {
      check('known protection configuration restoration is confirmed', false)
    }
    try {
      transportRestored =
        !!transportBefore &&
        sameClaudeTransport(transportBefore, (transportAfter = await probeClaudeTransport(port)))
      check(
        'existing proxy-to-Claude TLS/HTTP transport matches the baseline after restoration',
        transportRestored
      )
    } catch {
      check('Claude transport restoration is confirmed', false)
    }
    try {
      runtimeAfter = await captureSystemRuntime()
      systemRuntimeRestored =
        !!runtimeBefore &&
        runtimeAfter.effectiveProxyRevision === runtimeBefore.effectiveProxyRevision &&
        runtimeAfter.effectiveDnsRevision === runtimeBefore.effectiveDnsRevision
      check('effective macOS proxy and DNS runtime matches its baseline', systemRuntimeRestored)
    } catch {
      check('effective system proxy/DNS restoration is confirmed', false)
    }
  }
}
const report = {
  scope: { serviceID, interfaceName, port, onlyInitiallyInactiveInterfaceSelected: true },
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  actualSystemSubmissionAttempted: submitted,
  ...(failureStage ? { failureStage, applicationStatus, applicationWarnings } : {}),
  authorizationOrExecutionUnavailable,
  restored,
  preflightOnly,
  preflightAccepted: preflightPassed && rows.every((row) => row.passed),
  configurationUnchanged,
  systemRuntimeRestored,
  changedConfigurationLabels,
  preservationEvidence: {
    protectionBefore,
    protectionAfter,
    runtimeBefore,
    runtimeAfter,
    transportBefore,
    transportAfter
  },
  transportRestored,
  transportScope:
    'unauthenticated TLS/HTTP response through explicit existing proxy; not an account session or no-direct protection acceptance',
  temporaryResourcesClosed,
  hostAccepted: hostRestorationAccepted({
    submitted,
    proxyRestored: restored,
    configurationUnchanged,
    systemRuntimeRestored,
    transportRestored,
    temporaryResourcesClosed,
    checksPassed: rows.every((row) => row.passed)
  }),
  existingClashStoppedReloadedOrRestarted: false,
  dnsTunClientBrowserConfigurationWritten: false,
  intelRuntimeVerified: false,
  evidenceOnlyNoAccountRequests: true
}
await writeFile(
  preflightOnly
    ? '../evidence/system-proxy-host-preflight.json'
    : '../evidence/system-proxy-host-verification.json',
  JSON.stringify(report, null, 2) + '\n',
  { mode: 0o600 }
)
process.stdout.write(
  JSON.stringify({
    passed: report.passed,
    checks: report.checks,
    hostAccepted: report.hostAccepted,
    preflightOnly,
    preflightAccepted: report.preflightAccepted,
    restored
  }) + '\n'
)
if (preflightOnly ? !report.preflightAccepted : !report.hostAccepted) process.exitCode = 1
