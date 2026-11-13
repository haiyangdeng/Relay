// Read-only acceptance around separately authorized App/install/uninstall steps.
// No mutation command, core launch, installer, bootout or removal exists here.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, readdir, realpath, readFile, writeFile } from 'fs/promises'
import { userInfo } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { inspectEdgeNative } from '../../src/main/relay/native'
import { readBinaryResource, resourceHash } from '../../src/main/relay/resources/source'
import { inspectTunNative, readTunInstallation } from '../../src/main/relay/tun/transport'
import { parseTunTopology } from '../../src/main/relay/tun/topology'
import {
  captureProtectedConfiguration,
  captureSystemRuntime,
  compareProtectedConfiguration,
  probeClaudeTransport,
  sameClaudeTransport
} from '../../src/main/relay/system-proxy/acceptance'
import {
  archive,
  abortedCheckpoint,
  baseline,
  candidate,
  clientPath,
  digest,
  expectedPaths,
  fencePath,
  helperPath,
  hostArguments,
  intentPath,
  lockPath,
  object,
  parentPaths,
  receiptID,
  recoveryPath,
  root,
  scratchPrefix,
  service,
  terminalCheckpoint,
  type ArchiveInventory,
  type Baseline,
  type Observation
} from './tun-app-host-contract'

const selection = hostArguments(process.argv.slice(2)),
  mode = selection.mode
const exec = promisify(execFile),
  app = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  project = dirname(app),
  evidence = join(project, 'evidence'),
  identity = userInfo(),
  baselinePath = join(evidence, selection.evidencePrefix + '-baseline.json'),
  checkpointPath = join(evidence, selection.evidencePrefix + '-installed.json'),
  abortedPath = join(evidence, selection.evidencePrefix + '-aborted-before-uninstall.json'),
  abortedBefore = mode === '--verify-aborted-before-uninstall',
  abortedAfter = mode === '--verify-aborted-restored',
  cleanupOnly = abortedBefore || abortedAfter,
  candidateBytes = await readBinaryResource(join(evidence, selection.metadataName)),
  candidateSHA256 = resourceHash(candidateBytes),
  c = candidate(JSON.parse(candidateBytes.toString('utf8')), project, identity.uid),
  context = {
    home: identity.homedir,
    stateRoot: join(identity.homedir, 'Library/Application Support/Relay-Preview')
  }
if (
  process.platform !== 'darwin' ||
  identity.uid === 0 ||
  identity.uid !== process.getuid?.() ||
  process.getuid?.() !== process.geteuid?.()
)
  throw new Error(
    'Run only as the intended ordinary macOS user; never run this harness under sudo.'
  )
if (resourceHash(await readBinaryResource(c.packagePath)) !== c.packageSHA256)
  throw new Error('Candidate pkg bytes changed.')
const run = async (path: string, args: string[], maxBuffer = 1048576) =>
  exec(path, args, {
    timeout: 45000,
    maxBuffer,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' }
  })
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
  const receipts = await run('/usr/sbin/pkgutil', ['--pkgs'])
  if (receipts.stdout.split('\n').includes(receiptID)) return false
  try {
    await run('/bin/launchctl', ['print', 'system/' + service])
    return false
  } catch (error) {
    const e = error as { code?: number; stderr?: string }
    if (e.code !== 113 || !/Could not find service/u.test(e.stderr ?? '')) throw error
    return true
  }
}
async function noInstallation(): Promise<boolean> {
  const scratch = (await readdir('/Library/PrivilegedHelperTools')).some((name) =>
    name.startsWith(scratchPrefix.slice(scratchPrefix.lastIndexOf('/') + 1))
  )
  return (
    !scratch &&
    (
      await Promise.all([root, intentPath, lockPath, fencePath, ...expectedPaths].map(absent))
    ).every(Boolean) &&
    (await noRegistration())
  )
}
async function parentsMatch(): Promise<boolean> {
  for (const path of parentPaths) {
    const info = await lstat(path),
      expected = c.sharedParentMetadata[path]
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      info.uid !== expected.uid ||
      info.gid !== expected.gid ||
      (info.mode & 0o7777).toString(8) !== expected.mode
    )
      return false
  }
  return true
}
async function retainedArchive(): Promise<ArchiveInventory> {
  if (await absent(recoveryPath))
    return archive({
      exists: false,
      plans: [],
      files: [],
      revision: resourceHash(Buffer.from('[]'))
    })
  if (cleanupOnly)
    throw new Error(
      'Aborted cleanup will not elevate privileges to read an existing protected archive; its complete inventory remains unverified.'
    )
  // This command never prompts. It requires separately approved administrator
  // read credentials, and executes only the fixed, argument-free reader source.
  const source = await readFile(join(app, 'scripts/relay/tun-app-archive-inventory.py'), 'utf8')
  try {
    const result = await run(
      '/usr/bin/sudo',
      ['-n', '/usr/bin/python3', '-I', '-B', '-c', source],
      32 * 1024 * 1024
    )
    return archive(JSON.parse(result.stdout))
  } catch {
    throw new Error(
      'Retained root-0700 audit was not verified. Obtain separately approved administrator read credentials; missing access is never empty history.'
    )
  }
}
async function observe(): Promise<Observation> {
  const interfaces = await run('/sbin/ifconfig', ['-a']),
    routes = await run('/usr/sbin/netstat', ['-rn'])
  return {
    protection: await captureProtectedConfiguration(
      identity.homedir,
      (await inspectEdgeNative(join(app, 'extra/relay/RelayNative'), context)).revision
    ),
    runtime: await captureSystemRuntime(),
    topology: parseTunTopology(interfaces.stdout, routes.stdout),
    transport: await probeClaudeTransport(7890)
  }
}
async function privateJSON(path: string): Promise<unknown> {
  const bytes = await readBinaryResource(path, true)
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Acceptance evidence is oversized.')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
async function save(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}
if (!(await parentsMatch()))
  throw new Error('Shared parent metadata differs; preserve it and rebuild the candidate.')
if (mode === '--preflight-only') {
  if (!(await noInstallation()))
    throw new Error('Existing installation/job/receipt/lock/fence would be affected; refused.')
  const before: Baseline = {
    version: 1,
    role: 'network-executor-v1-app-host',
    candidateSHA256,
    clientUID: identity.uid,
    observation: await observe(),
    archive: await retainedArchive()
  }
  await save(baselinePath, before)
  process.stdout.write(
    'Read-only App preflight recorded privately. No helper query, installation or network mutation performed.\n'
  )
} else {
  const before = baseline(await privateJSON(baselinePath), candidateSHA256, identity.uid)
  let authenticatedInspection = false
  if (mode === '--verify-installed' || abortedBefore) {
    const installed = await readTunInstallation()
    if (
      !installed ||
      installed.revision !== c.manifestSHA256 ||
      installed.clientSHA256 !== c.binaryPins.client.sha256 ||
      installed.helperSHA256 !== c.binaryPins.helper.sha256
    )
      throw new Error('Installed fixed manifest/client/helper pins differ.')
    for (const [key, path] of [
      ['helper', helperPath],
      ['client', clientPath],
      ['uninstaller', helperPath + '.uninstall']
    ] as const) {
      const info = await lstat(path)
      if (
        info.uid !== 0 ||
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.mode & 0o7022 ||
        !(info.mode & 0o111) ||
        (await realpath(path)) !== path ||
        resourceHash(await readBinaryResource(path)) !== c.binaryPins[key].sha256
      )
        throw new Error('Installed fixed executable changed.')
    }
    // Only authenticated status/read-only host inspection. This may demand-
    // launch the approved helper, but never sends prepare/acquire/activate.
    const inspected = await inspectTunNative(installed)
    authenticatedInspection =
      inspected.helper.state === 'ready' &&
      inspected.helper.identity === 'authenticated' &&
      inspected.helper.authorization === 'approved'
    if (!authenticatedInspection)
      throw new Error('Installed helper authentication/executor readiness not confirmed.')
  }
  const after = await observe(),
    retained = await retainedArchive(),
    configurationUnchanged =
      compareProtectedConfiguration(before.observation.protection, after.protection).length === 0,
    runtimeUnchanged = digest(before.observation.runtime) === digest(after.runtime),
    topologyUnchanged = digest(before.observation.topology) === digest(after.topology),
    transportUnchanged = sameClaudeTransport(before.observation.transport, after.transport),
    sharedParentMetadataUnchanged = await parentsMatch()
  let archiveUnchangedSinceTerminalCheckpoint = false,
    archiveUnchangedFromOriginalBaseline = false,
    beforeAbortCheckpointAvailable = false,
    abortEvidenceReferences: { path: string; sha256: string }[] = []
  if (cleanupOnly) {
    abortedCheckpoint(before.archive, retained)
    archiveUnchangedFromOriginalBaseline = true
    if (abortedAfter) {
      if (!(await absent(abortedPath))) {
        const checkpoint = await privateJSON(abortedPath)
        if (
          !object(checkpoint) ||
          checkpoint.candidateSHA256 !== candidateSHA256 ||
          checkpoint.clientUID !== identity.uid ||
          checkpoint.passed !== true ||
          checkpoint.phase !== 'aborted-before-uninstall' ||
          checkpoint.cleanupOnly !== true ||
          checkpoint.networkAcceptance !== false
        )
          throw new Error(
            'The abort checkpoint is invalid; it cannot authorize a successful TUN claim.'
          )
        abortedCheckpoint(before.archive, archive(checkpoint.retainedArchive))
        beforeAbortCheckpointAvailable = true
        archiveUnchangedSinceTerminalCheckpoint = true
      } else {
        // The authorized fixed uninstaller may already have run. Preserve that
        // history honestly rather than inventing a pre-uninstall observation.
        const installedPath = join(
            evidence,
            selection.routeBaselineCandidate
              ? 'tun-app-route-baseline-installation-attempt-01.json'
              : 'tun-app-installation-attempt-01.json'
          ),
          nativePath = join(
            evidence,
            selection.routeBaselineCandidate
              ? 'tun-app-route-baseline-native-before-round1.json'
              : 'tun-app-native-before-round1.json'
          ),
          installed = await privateJSON(installedPath),
          native = await privateJSON(nativePath)
        if (
          !object(installed) ||
          installed.phase !== 'installed' ||
          installed.packageSHA256 !== c.packageSHA256 ||
          installed.manifestSHA256 !== c.manifestSHA256 ||
          installed.installerUIReportedSuccess !== true ||
          installed.installedManifestRootOwned !== true ||
          !object(native) ||
          !object(native.helper) ||
          native.helper.clientUID !== identity.uid ||
          native.helper.revision !== c.manifestSHA256 ||
          native.helper.helperSHA256 !== c.binaryPins.helper.sha256 ||
          native.helper.state !== 'ready' ||
          native.helper.identity !== 'authenticated' ||
          native.helper.rootOwned !== true ||
          native.helper.runningAsRoot !== true
        )
          throw new Error(
            'Exact installation and pre-round authenticated inspection evidence are required for checkpoint-free aborted cleanup.'
          )
        abortEvidenceReferences = await Promise.all(
          [installedPath, nativePath].map(async (path) => ({
            path,
            sha256: resourceHash(await readBinaryResource(path, true))
          }))
        )
      }
    }
  } else if (mode === '--verify-installed') terminalCheckpoint(before.archive, retained, c)
  else {
    const checkpoint = await privateJSON(checkpointPath)
    if (
      !object(checkpoint) ||
      checkpoint.candidateSHA256 !== candidateSHA256 ||
      checkpoint.clientUID !== identity.uid ||
      checkpoint.passed !== true ||
      checkpoint.phase !== 'terminal-before-uninstall'
    )
      throw new Error('The successful post-stop/pre-uninstall checkpoint is required.')
    const prior = archive(checkpoint.retainedArchive)
    terminalCheckpoint(before.archive, prior, c)
    archiveUnchangedSinceTerminalCheckpoint = digest(prior) === digest(retained)
  }
  const installationAbsent =
      mode === '--verify-restored' || abortedAfter ? await noInstallation() : false,
    passed =
      configurationUnchanged &&
      runtimeUnchanged &&
      topologyUnchanged &&
      transportUnchanged &&
      sharedParentMetadataUnchanged &&
      (cleanupOnly
        ? archiveUnchangedFromOriginalBaseline &&
          (abortedBefore ? authenticatedInspection : installationAbsent)
        : mode === '--verify-installed'
          ? authenticatedInspection
          : installationAbsent && archiveUnchangedSinceTerminalCheckpoint),
    report = {
      version: 1,
      role: 'network-executor-v1-app-host',
      phase: abortedBefore
        ? 'aborted-before-uninstall'
        : abortedAfter
          ? 'aborted-restored'
          : mode === '--verify-installed'
            ? 'terminal-before-uninstall'
            : 'restored',
      candidateSHA256,
      clientUID: identity.uid,
      authenticatedInspection,
      configurationUnchanged,
      runtimeUnchanged,
      topologyUnchanged,
      transportUnchanged,
      sharedParentMetadataUnchanged,
      installationAbsent,
      archiveUnchangedSinceTerminalCheckpoint,
      ...(cleanupOnly
        ? {
            cleanupOnly: true,
            networkAcceptance: false,
            beforeAbortCheckpointAvailable,
            archiveUnchangedFromOriginalBaseline,
            abortEvidenceReferences,
            recoveryGate:
              'The fixed root uninstaller independently requires verifyLiveEmpty and the exclusive uninstall fence; this tool invents no terminal chain.'
          }
        : {}),
      retainedArchive: retained,
      passed,
      before: before.observation,
      after,
      actualTunAcceptedByThisTool: false,
      systemMutationRequestedByThisTool: false,
      packageReceiptHistoryErased: false
    }
  await save(
    abortedBefore
      ? abortedPath
      : abortedAfter
        ? join(evidence, selection.evidencePrefix + '-aborted-restored.json')
        : mode === '--verify-installed'
          ? checkpointPath
          : join(evidence, selection.evidencePrefix + '-restored.json'),
    report
  )
  process.stdout.write(
    JSON.stringify({
      ...report,
      before: undefined,
      after: undefined,
      retainedArchive: {
        exists: retained.exists,
        revision: retained.revision,
        terminalPlans: retained.plans.length
      }
    }) + '\n'
  )
  if (!passed) process.exitCode = 1
}
