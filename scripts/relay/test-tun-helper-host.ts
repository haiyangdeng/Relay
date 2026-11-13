// Read-only host acceptance around a separately approved administrator install.
// This tool never installs, bootstraps, stops, uninstalls or changes networking.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, readdir, realpath, writeFile } from 'fs/promises'
import { userInfo } from 'os'
import { join, resolve } from 'path'
import { inspectEdgeNative } from '../../src/main/relay/native'
import { readBinaryResource, resourceHash } from '../../src/main/relay/resources/source'
import { parseTunTopology } from '../../src/main/relay/tun/topology'
import {
  captureProtectedConfiguration,
  captureSystemRuntime,
  compareProtectedConfiguration,
  probeClaudeTransport,
  sameClaudeTransport
} from '../../src/main/relay/system-proxy/acceptance'

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
interface Candidate {
  role: 'authentication-only'
  clientUID: number
  service: string
  receiptID: string
  installedOrMachAuthenticated: false
  manifestPath: string
  manifestSHA256: string
  launchDaemonPath: string
  packagePath: string
  packageSHA256: string
  installedPaths: string[]
  binaryPins: Record<'helper' | 'client' | 'uninstaller', { path: string; sha256: string }>
  sharedParentMetadata: Record<string, { uid: number; gid: number; mode: string }>
  temporaryPrefixes: string[]
}
function assertCandidate(value: unknown): asserts value is Candidate {
  if (!object(value)) throw new Error('Candidate metadata must be an object.')
  const pins = value.binaryPins
  if (
    value.role !== 'authentication-only' ||
    !Number.isSafeInteger(value.clientUID) ||
    value.installedOrMachAuthenticated !== false ||
    ['service', 'receiptID', 'manifestPath', 'launchDaemonPath', 'packagePath'].some(
      (key) => typeof value[key] !== 'string'
    ) ||
    !sha(value.manifestSHA256) ||
    !sha(value.packageSHA256) ||
    !Array.isArray(value.installedPaths) ||
    value.installedPaths.length !== 7 ||
    value.installedPaths.some((path) => typeof path !== 'string') ||
    !object(pins)
  )
    throw new Error('Candidate metadata fields are invalid.')
  for (const key of ['helper', 'client', 'uninstaller']) {
    const pin = pins[key]
    if (!object(pin) || typeof pin.path !== 'string' || !sha(pin.sha256))
      throw new Error('Candidate binary pin is invalid.')
  }
  const parents = value.sharedParentMetadata
  const expectedParents = [
    '/',
    '/Library',
    '/Library/Application Support',
    '/Library/PrivilegedHelperTools',
    '/Library/LaunchDaemons'
  ].sort()
  if (
    !object(parents) ||
    JSON.stringify(Object.keys(parents).sort()) !== JSON.stringify(expectedParents)
  )
    throw new Error('Shared parent metadata scope differs.')
  for (const entry of Object.values(parents)) {
    if (
      !object(entry) ||
      entry.uid !== 0 ||
      !Number.isInteger(entry.gid) ||
      Number(entry.gid) < 0 ||
      typeof entry.mode !== 'string' ||
      !/^[0-7]{3,4}$/u.test(entry.mode) ||
      parseInt(entry.mode, 8) & 0o6022
    )
      throw new Error('Unsafe shared parent metadata.')
  }
  if (
    JSON.stringify(value.temporaryPrefixes) !==
    JSON.stringify(['/Library/PrivilegedHelperTools/.local.relay.network.tun.feasibility-publish-'])
  )
    throw new Error('Unexpected temporary-resource scope.')
}

type Observation = Awaited<ReturnType<typeof observe>>
interface Baseline {
  version: 1
  candidateSHA256: string
  clientUID: number
  rootNamespaceOriginallyAbsent: true
  observation: Observation
}
function assertBaseline(value: unknown): asserts value is Baseline {
  if (!object(value) || !object(value.observation)) throw new Error('Baseline is invalid.')
  const observed = value.observation,
    protection = observed.protection,
    runtime = observed.runtime,
    topology = observed.topology
  if (
    value.version !== 1 ||
    !sha(value.candidateSHA256) ||
    !Number.isSafeInteger(value.clientUID) ||
    value.rootNamespaceOriginallyAbsent !== true ||
    !object(protection) ||
    !sha(protection.revision) ||
    !Array.isArray(protection.entries) ||
    protection.entries.length > 2048 ||
    protection.entries.some(
      (entry) =>
        !object(entry) ||
        typeof entry.label !== 'string' ||
        typeof entry.exists !== 'boolean' ||
        !sha(entry.revision)
    ) ||
    !object(runtime) ||
    !sha(runtime.effectiveProxyRevision) ||
    !sha(runtime.effectiveDnsRevision) ||
    !object(topology) ||
    !sha(topology.interfacesSHA256) ||
    !sha(topology.routesSHA256) ||
    !Array.isArray(observed.transport) ||
    observed.transport.length !== 2 ||
    observed.transport.some(
      (entry) =>
        !object(entry) ||
        !['anthropic-api', 'claude-web'].includes(String(entry.endpoint)) ||
        !Number.isInteger(entry.status) ||
        Number(entry.status) < 200 ||
        Number(entry.status) >= 500 ||
        entry.tlsResponse !== true
    )
  )
    throw new Error('Baseline observation fields are invalid.')
}

const mode = process.argv.slice(2).join(' ')
if (
  ![
    '--preflight-only',
    '--verify-installed --allow-authenticated-helper-query',
    '--verify-restored'
  ].includes(mode)
)
  throw new Error(
    'Use explicit read-only preflight, approved installed-helper query, or restore verification.'
  )
const exec = promisify(execFile),
  project = resolve('..'),
  evidence = join(project, 'evidence'),
  baselinePath = join(evidence, 'tun-helper-host-baseline.json'),
  candidatePath = join(evidence, 'tun-helper-transport-candidate.json'),
  identity = userInfo(),
  context = {
    home: identity.homedir,
    stateRoot: join(identity.homedir, 'Library/Application Support/Relay-Preview')
  },
  service = 'local.relay.network.tun',
  receiptID = service + '.feasibility',
  root = '/Library/Application Support/Relay',
  installRoot = root + '/Tun',
  helperPath = '/Library/PrivilegedHelperTools/' + service,
  uninstallPath = helperPath + '.uninstall',
  uninstallIntentPath = helperPath + '.uninstall-intent.json',
  clientPath = installRoot + '/RelayTunClient',
  plistPath = '/Library/LaunchDaemons/' + service + '.plist',
  digest = (value: unknown): string => resourceHash(Buffer.from(JSON.stringify(value)))
if (identity.uid === 0 || identity.uid !== process.getuid?.())
  throw new Error('Run only as the intended ordinary user.')
const candidateBytes = await readBinaryResource(candidatePath)
const parsedCandidate: unknown = JSON.parse(candidateBytes.toString('utf8'))
assertCandidate(parsedCandidate)
const candidate: Candidate = parsedCandidate
if (
  candidate.role !== 'authentication-only' ||
  candidate.clientUID !== identity.uid ||
  candidate.service !== service ||
  candidate.receiptID !== receiptID ||
  candidate.installedOrMachAuthenticated !== false ||
  candidate.manifestPath !== installRoot + '/installation.json' ||
  candidate.launchDaemonPath !== plistPath ||
  candidate.binaryPins?.client?.path !== clientPath ||
  candidate.binaryPins?.helper?.path !== helperPath ||
  candidate.binaryPins.uninstaller.path !== uninstallPath ||
  typeof candidate.packagePath !== 'string' ||
  !candidate.packagePath.startsWith(project + '/') ||
  !/^[a-f0-9]{64}$/u.test(candidate.packageSHA256)
)
  throw new Error('Candidate identity, role or fixed locations differ.')
const expectedPaths = [
  helperPath,
  clientPath,
  uninstallPath,
  installRoot + '/installation.json',
  installRoot + '/Core/darwin-arm64/mihomo',
  installRoot + '/Core/darwin-x64/mihomo',
  plistPath
].sort()
if (
  !Array.isArray(candidate.installedPaths) ||
  JSON.stringify([...candidate.installedPaths].sort()) !== JSON.stringify(expectedPaths) ||
  resourceHash(await readBinaryResource(candidate.packagePath)) !== candidate.packageSHA256
)
  throw new Error('Candidate payload scope or package bytes changed.')

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return true
  }
}
async function noRegistration(): Promise<boolean> {
  const receipt = await exec('/usr/sbin/pkgutil', ['--pkgs'], { timeout: 5000, maxBuffer: 1048576 })
  if (receipt.stdout.split('\n').includes(receiptID)) return false
  try {
    await exec('/bin/launchctl', ['print', 'system/' + service], {
      timeout: 5000,
      maxBuffer: 65536
    })
    return false
  } catch (error) {
    const response = error as { stderr?: string; stdout?: string }
    if (!/Could not find service/u.test(response.stderr ?? '')) throw error
    return true
  }
}
async function noInstallation(): Promise<boolean> {
  const remainingScratch = (await readdir('/Library/PrivilegedHelperTools')).some((name) =>
    name.startsWith('.local.relay.network.tun.feasibility-publish-')
  )
  return (
    (await absent(root)) &&
    (await absent(uninstallIntentPath)) &&
    !remainingScratch &&
    (await Promise.all(expectedPaths.map(absent))).every(Boolean) &&
    (await noRegistration())
  )
}
async function sharedParentsMatch(): Promise<boolean> {
  for (const [path, expected] of Object.entries(candidate.sharedParentMetadata)) {
    const observed = await lstat(path)
    if (
      !observed.isDirectory() ||
      observed.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      observed.uid !== expected.uid ||
      observed.gid !== expected.gid ||
      (observed.mode & 0o7777).toString(8) !== expected.mode
    )
      return false
  }
  return true
}
async function topology(): Promise<{ interfacesSHA256: string; routesSHA256: string }> {
  const interfaces = await exec('/sbin/ifconfig', ['-a'], { timeout: 5000, maxBuffer: 1048576 }),
    routes = await exec('/usr/sbin/netstat', ['-rn'], { timeout: 5000, maxBuffer: 1048576 })
  return parseTunTopology(interfaces.stdout, routes.stdout)
}
async function observe() {
  return {
    protection: await captureProtectedConfiguration(
      identity.homedir,
      (await inspectEdgeNative(resolve('extra/relay/RelayNative'), context)).revision
    ),
    runtime: await captureSystemRuntime(),
    topology: await topology(),
    transport: await probeClaudeTransport(7890)
  }
}
if (mode === '--preflight-only') {
  if (!(await sharedParentsMatch()))
    throw new Error('Shared system parent metadata differs; rebuild rather than changing it.')
  if (!(await noInstallation()))
    throw new Error('An existing installation, receipt or job would be affected; refused.')
  const baseline = {
    version: 1,
    candidateSHA256: resourceHash(candidateBytes),
    clientUID: identity.uid,
    rootNamespaceOriginallyAbsent: true,
    observation: await observe()
  }
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx'
  })
  process.stdout.write('Read-only preflight passed. No installation or helper query performed.\n')
} else {
  const baselineBytes = await readBinaryResource(baselinePath, true)
  if (baselineBytes.length > 1048576) throw new Error('Baseline is oversized.')
  const baseline: unknown = JSON.parse(baselineBytes.toString('utf8'))
  assertBaseline(baseline)
  if (
    baseline.version !== 1 ||
    baseline.candidateSHA256 !== resourceHash(candidateBytes) ||
    baseline.clientUID !== identity.uid ||
    baseline.rootNamespaceOriginallyAbsent !== true
  )
    throw new Error('Baseline does not match this exact candidate and user.')
  let authenticated = false
  if (mode.startsWith('--verify-installed')) {
    const file = await lstat(clientPath)
    if (
      file.uid !== 0 ||
      !file.isFile() ||
      file.nlink !== 1 ||
      file.mode & 0o7022 ||
      !(file.mode & 0o111) ||
      (await realpath(clientPath)) !== clientPath ||
      resourceHash(await readBinaryResource(clientPath)) !== candidate.binaryPins.client.sha256
    )
      throw new Error('Installed fixed client identity differs.')
    // This is the only call that may start the explicitly approved, root-owned,
    // authentication-only daemon. It cannot activate a network executor.
    const query = await exec(clientPath, ['--status'], { timeout: 40000, maxBuffer: 16384 }),
      response = JSON.parse(query.stdout)
    authenticated =
      response.authenticated === true &&
      response.rootOwned === true &&
      response.runningAsRoot === true &&
      response.helperRevision === candidate.manifestSHA256 &&
      response.operation === 'status' &&
      response.clientUID === identity.uid &&
      response.status === 'unavailable' &&
      response.executorAvailable === false &&
      response.ready === false &&
      response.active === false &&
      response.protectionVerified === false
    if (!authenticated)
      throw new Error(
        'Authenticated transport was not confirmed, or unexpected capabilities were reported.'
      )
  }
  const after = await observe(),
    before = baseline.observation,
    configurationUnchanged =
      compareProtectedConfiguration(before.protection, after.protection).length === 0,
    runtimeUnchanged = digest(before.runtime) === digest(after.runtime),
    topologyUnchanged = digest(before.topology) === digest(after.topology),
    transportUnchanged = sameClaudeTransport(before.transport, after.transport),
    sharedParentMetadataUnchanged = await sharedParentsMatch(),
    installationRestored = mode === '--verify-restored' ? await noInstallation() : false,
    passed =
      configurationUnchanged &&
      runtimeUnchanged &&
      topologyUnchanged &&
      transportUnchanged &&
      sharedParentMetadataUnchanged &&
      (mode === '--verify-restored' ? installationRestored : authenticated),
    report = {
      version: 1,
      phase: mode === '--verify-restored' ? 'restored' : 'installed-authentication',
      candidateSHA256: resourceHash(candidateBytes),
      authenticated,
      configurationUnchanged,
      runtimeUnchanged,
      topologyUnchanged,
      transportUnchanged,
      sharedParentMetadataUnchanged,
      installationRestored,
      passed,
      actualTunAccepted: false,
      actualNetworkExecutorEnabled: false,
      before,
      after
    }
  await writeFile(
    join(
      evidence,
      mode === '--verify-restored'
        ? 'tun-helper-host-restored.json'
        : 'tun-helper-host-authenticated.json'
    ),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' }
  )
  process.stdout.write(JSON.stringify({ ...report, before: undefined, after: undefined }) + '\n')
  if (!passed) process.exitCode = 1
}
