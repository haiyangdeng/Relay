import { basename, dirname, join, resolve } from 'path'
import { resourceHash } from '../../src/main/relay/resources/source'
import coreManifest from '../../src/main/relay/core/manifest.json'
import type {
  ProtectedConfigurationSnapshot,
  SystemRuntimeObservation,
  ClaudeTransportObservation
} from '../../src/main/relay/system-proxy/acceptance'

export const service = 'local.relay.network.tun',
  receiptID = service + '.network-executor-v1',
  root = '/Library/Application Support/Relay',
  installRoot = root + '/Tun',
  helperPath = '/Library/PrivilegedHelperTools/' + service,
  clientPath = installRoot + '/RelayTunClient',
  intentPath = helperPath + '.uninstall-intent.json',
  recoveryPath = '/Library/Application Support/RelayTunRecovery',
  lockPath = helperPath + '.operation-lock',
  fencePath = helperPath + '.uninstall-active',
  plistPath = '/Library/LaunchDaemons/' + service + '.plist',
  expectedPaths = [
    helperPath,
    clientPath,
    helperPath + '.uninstall',
    installRoot + '/installation.json',
    installRoot + '/Core/darwin-arm64/mihomo',
    installRoot + '/Core/darwin-x64/mihomo',
    plistPath
  ].sort(),
  parentPaths = [
    '/',
    '/Library',
    '/Library/Application Support',
    '/Library/PrivilegedHelperTools',
    '/Library/LaunchDaemons'
  ].sort(),
  scratchPrefix =
    '/Library/PrivilegedHelperTools/.local.relay.network.tun.network-executor-v1-publish-'
export const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v)
export const digest = (v: unknown): string => resourceHash(Buffer.from(JSON.stringify(v)))
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
export function hostArguments(args: readonly string[]): {
  mode: string
  routeBaselineCandidate: boolean
  metadataName: string
  evidencePrefix: string
} {
  const routeBaselineCandidate = args.includes('--route-baseline-candidate'),
    nativeFixesCandidate = args.includes('--native-fixes-candidate'),
    declaredDeviceCandidate = args.includes('--declared-device-candidate'),
    coreStageCandidate = args.includes('--core-stage-candidate'),
    peerEOFCandidate = args.includes('--peer-eof-candidate'),
    kernelRouteCandidate = args.includes('--kernel-route-candidate'),
    retiredCloseCandidate = args.includes('--retired-close-candidate'),
    dnsProofCandidate = args.includes('--dns-proof-candidate'),
    modes = args.filter(
      (argument) =>
        argument !== '--route-baseline-candidate' &&
        argument !== '--native-fixes-candidate' &&
        argument !== '--declared-device-candidate' &&
        argument !== '--core-stage-candidate' &&
        argument !== '--peer-eof-candidate' &&
        argument !== '--kernel-route-candidate' &&
        argument !== '--retired-close-candidate' &&
        argument !== '--dns-proof-candidate'
    )
  if (
    [
      routeBaselineCandidate,
      nativeFixesCandidate,
      declaredDeviceCandidate,
      coreStageCandidate,
      peerEOFCandidate,
      kernelRouteCandidate,
      retiredCloseCandidate,
      dnsProofCandidate
    ].filter(Boolean).length > 1 ||
    args.length !==
      (routeBaselineCandidate ||
      nativeFixesCandidate ||
      declaredDeviceCandidate ||
      coreStageCandidate ||
      peerEOFCandidate ||
      kernelRouteCandidate ||
      retiredCloseCandidate ||
      dnsProofCandidate
        ? 2
        : 1) ||
    modes.length !== 1 ||
    ![
      '--preflight-only',
      '--verify-installed',
      '--verify-restored',
      '--verify-aborted-before-uninstall',
      '--verify-aborted-restored'
    ].includes(modes[0])
  )
    throw new Error(
      'Use one explicit host verification mode and at most one fixed candidate selector; no other arguments are accepted.'
    )
  return {
    mode: modes[0],
    routeBaselineCandidate,
    metadataName: dnsProofCandidate
      ? 'tun-helper-dns-proof-candidate-20261029.json'
      : retiredCloseCandidate
        ? 'tun-helper-retired-close-candidate-20261029.json'
        : kernelRouteCandidate
          ? 'tun-helper-kernel-route-candidate-20261028.json'
          : peerEOFCandidate
            ? 'tun-helper-peer-eof-candidate-20261028.json'
            : coreStageCandidate
              ? 'tun-helper-core-stage-candidate-20261028.json'
              : declaredDeviceCandidate
                ? 'tun-helper-declared-device-candidate-20261028.json'
                : nativeFixesCandidate
                  ? 'tun-helper-native-fixes-candidate-20261028.json'
                  : routeBaselineCandidate
                    ? 'tun-helper-route-baseline-candidate-v2.json'
                    : 'tun-helper-transport-candidate.json',
    evidencePrefix: dnsProofCandidate
      ? 'tun-dns-proof'
      : retiredCloseCandidate
        ? 'tun-app-retired-close-host-20261029'
        : kernelRouteCandidate
          ? 'tun-app-kernel-route-host-20261028'
          : peerEOFCandidate
            ? 'tun-app-peer-eof-host-20261028'
            : coreStageCandidate
              ? 'tun-app-core-stage-host-20261028'
              : declaredDeviceCandidate
                ? 'tun-app-declared-device-host-20261028'
                : nativeFixesCandidate
                  ? 'tun-app-native-fixes-host-20261028'
                  : routeBaselineCandidate
                    ? 'tun-app-route-baseline-host'
                    : 'tun-app-host'
  }
}
export interface Candidate {
  role: 'network-executor-v1'
  clientUID: number
  packagePath: string
  packageSHA256: string
  manifestSHA256: string
  installedPaths: string[]
  binaryPins: Record<'helper' | 'client' | 'uninstaller', { path: string; sha256: string }>
  sharedParentMetadata: Record<string, { uid: number; gid: number; mode: string }>
}
function assertCandidate(raw: unknown, project: string, uid: number): asserts raw is Candidate {
  if (
    !object(raw) ||
    raw.role !== 'network-executor-v1' ||
    raw.manifestVersion !== 2 ||
    raw.packageVersion !== '0.30.1' ||
    raw.clientUID !== uid ||
    uid <= 0 ||
    raw.service !== service ||
    raw.receiptID !== receiptID ||
    raw.installedOrMachAuthenticated !== false ||
    raw.actualSystemConfigurationChanged !== false ||
    raw.executorAvailable !== true ||
    raw.runAtLoad !== false ||
    raw.keepAlive !== false ||
    raw.protectionVerified !== false ||
    raw.manifestPath !== installRoot + '/installation.json' ||
    raw.launchDaemonPath !== plistPath ||
    raw.transientUninstallIntentPath !== intentPath ||
    raw.knownRetainedAuditNamespace !== recoveryPath ||
    !sha(raw.manifestSHA256) ||
    !sha(raw.packageSHA256) ||
    !sha(raw.launchDaemonSHA256) ||
    typeof raw.packagePath !== 'string' ||
    resolve(raw.packagePath) !== raw.packagePath ||
    basename(raw.packagePath) !== 'RelayTun-NetworkExecutor-v1.pkg' ||
    dirname(dirname(raw.packagePath)) !== join(project, 'app/.relay-build') ||
    !/^tun-network-candidate-\d{8}T\d{6}Z-[a-f0-9]{8}$/u.test(basename(dirname(raw.packagePath))) ||
    !Array.isArray(raw.installedPaths) ||
    !equal([...raw.installedPaths].sort(), expectedPaths) ||
    !equal(raw.temporaryPrefixes, [scratchPrefix]) ||
    !equal(raw.dynamicRuntimePaths, [
      installRoot + '/NetworkJournal',
      installRoot + '/DeviceJournal',
      lockPath,
      fencePath
    ]) ||
    !object(raw.binaryPins) ||
    !object(raw.corePins) ||
    !object(raw.sharedParentMetadata) ||
    !equal(Object.keys(raw.sharedParentMetadata).sort(), parentPaths)
  )
    throw new Error(
      'This exact network-executor-v1 candidate, fixed namespace or intended UID was not confirmed.'
    )
  for (const [key, path] of [
    ['helper', helperPath],
    ['client', clientPath],
    ['uninstaller', helperPath + '.uninstall']
  ]) {
    const pin = raw.binaryPins[key]
    if (!object(pin) || pin.path !== path || !sha(pin.sha256))
      throw new Error('Candidate binary pins differ.')
  }
  for (const [arch, fixed] of [
    ['arm64', coreManifest.assets.arm64],
    ['x86_64', coreManifest.assets.x64]
  ] as const) {
    const pin = raw.corePins[arch]
    if (
      !object(pin) ||
      pin.path !== installRoot + '/Core/' + fixed.path ||
      pin.sha256 !== fixed.sha256
    )
      throw new Error('Fixed core pins differ.')
  }
  for (const entry of Object.values(raw.sharedParentMetadata))
    if (
      !object(entry) ||
      entry.uid !== 0 ||
      !Number.isInteger(entry.gid) ||
      Number(entry.gid) < 0 ||
      typeof entry.mode !== 'string' ||
      !/^[0-7]{3,4}$/u.test(entry.mode) ||
      parseInt(entry.mode, 8) & 0o6022
    )
      throw new Error('Shared parent metadata is unsafe.')
}
export function candidate(raw: unknown, project: string, uid: number): Candidate {
  assertCandidate(raw, project, uid)
  return raw
}
export interface ArchiveInventory {
  exists: boolean
  revision: string
  plans: {
    planID: string
    sessionID: string
    clientUID: number
    installationRevision: string
    phase: string
    acquisition: string
  }[]
  files: { path: string; sha256: string; bytes: number }[]
}
function assertArchive(raw: unknown): asserts raw is ArchiveInventory {
  if (
    !object(raw) ||
    typeof raw.exists !== 'boolean' ||
    !sha(raw.revision) ||
    !Array.isArray(raw.plans) ||
    raw.plans.length > 4096 ||
    !Array.isArray(raw.files) ||
    raw.files.length > 100000 ||
    raw.plans.some(
      (p) =>
        !object(p) ||
        !uuid(p.planID) ||
        !uuid(p.sessionID) ||
        !Number.isSafeInteger(p.clientUID) ||
        Number(p.clientUID) <= 0 ||
        !sha(p.installationRevision) ||
        !['restored', 'closed_external_change', 'acquisition_aborted', 'unacquired'].includes(
          String(p.phase)
        ) ||
        !['acquired', 'aborted', 'none'].includes(String(p.acquisition))
    ) ||
    raw.files.some(
      (f) =>
        !object(f) ||
        typeof f.path !== 'string' ||
        f.path.startsWith('/') ||
        f.path.split('/').some((s) => !s || s === '.' || s === '..') ||
        !sha(f.sha256) ||
        !Number.isSafeInteger(f.bytes) ||
        Number(f.bytes) <= 0
    ) ||
    (!raw.exists && (raw.plans.length || raw.files.length))
  )
    throw new Error('Retained audit inventory is unverified; unreadable never means empty.')
}
export function archive(raw: unknown): ArchiveInventory {
  assertArchive(raw)
  return raw
}
export interface Observation {
  protection: ProtectedConfigurationSnapshot
  runtime: SystemRuntimeObservation
  topology: { interfacesSHA256: string; routesSHA256: string }
  transport: ClaudeTransportObservation[]
}
export interface Baseline {
  version: 1
  role: 'network-executor-v1-app-host'
  candidateSHA256: string
  clientUID: number
  observation: Observation
  archive: ArchiveInventory
}
function assertBaseline(
  raw: unknown,
  candidateSHA256: string,
  uid: number
): asserts raw is Baseline {
  if (
    !object(raw) ||
    raw.version !== 1 ||
    raw.role !== 'network-executor-v1-app-host' ||
    raw.candidateSHA256 !== candidateSHA256 ||
    raw.clientUID !== uid ||
    !object(raw.observation)
  )
    throw new Error('A private baseline from this exact candidate and UID is required.')
  const o = raw.observation
  if (
    !object(o.protection) ||
    !sha(o.protection.revision) ||
    !Array.isArray(o.protection.entries) ||
    o.protection.entries.length > 2048 ||
    o.protection.entries.some(
      (e) =>
        !object(e) ||
        typeof e.label !== 'string' ||
        typeof e.exists !== 'boolean' ||
        !sha(e.revision)
    ) ||
    !object(o.runtime) ||
    !sha(o.runtime.effectiveProxyRevision) ||
    !sha(o.runtime.effectiveDnsRevision) ||
    !object(o.topology) ||
    !sha(o.topology.interfacesSHA256) ||
    !sha(o.topology.routesSHA256) ||
    !Array.isArray(o.transport) ||
    !equal(
      o.transport.map((t) => (object(t) ? t.endpoint : '')),
      ['anthropic-api', 'claude-web']
    ) ||
    o.transport.some(
      (t) =>
        !object(t) ||
        !Number.isInteger(t.status) ||
        Number(t.status) < 200 ||
        Number(t.status) >= 500 ||
        t.tlsResponse !== true
    )
  )
    throw new Error('Baseline protection/runtime/topology/TLS observations are incomplete.')
  archive(raw.archive)
}
export function baseline(raw: unknown, candidateSHA256: string, uid: number): Baseline {
  assertBaseline(raw, candidateSHA256, uid)
  return raw
}
export function terminalCheckpoint(
  before: ArchiveInventory,
  after: ArchiveInventory,
  c: Candidate
): void {
  for (const prior of before.files)
    if (!after.files.some((file) => equal(file, prior)))
      throw new Error('Pre-existing retained audit history changed.')
  const previous = new Set(before.plans.map((plan) => plan.planID)),
    added = after.plans.filter((plan) => !previous.has(plan.planID))
  if (
    !added.length ||
    !added.some((plan) => plan.acquisition === 'acquired' && plan.phase === 'restored') ||
    added.some(
      (plan) =>
        plan.clientUID !== c.clientUID ||
        plan.installationRevision !== c.manifestSHA256 ||
        plan.phase === 'closed_external_change'
    )
  )
    throw new Error(
      'Capture after explicit TUN stop: exact current-candidate terminal restoration is required before uninstall.'
    )
}

// An aborted round cannot manufacture acquired/restored history. Its entire
// retained inventory must equal the original pre-install observation.
export function abortedCheckpoint(before: ArchiveInventory, after: ArchiveInventory): void {
  if (digest(archive(before)) !== digest(archive(after)))
    throw new Error('Aborted cleanup requires the complete original audit inventory unchanged.')
}
