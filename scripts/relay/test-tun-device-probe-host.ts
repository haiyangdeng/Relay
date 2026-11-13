// Read-only baseline/verification only. This never executes the device probe,
// requests administrator privileges or changes network/system configuration.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, realpath, writeFile } from 'fs/promises'
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

const mode = process.argv.slice(2)
const descriptorProbe = mode.length === 2 && mode[1] === '--descriptor-probe'
const coreProbe = mode.length === 2 && mode[1] === '--core-probe'
if (
  (mode.length !== 1 && !descriptorProbe && !coreProbe) ||
  !['--preflight-only', '--verify-restored'].includes(mode[0])
)
  throw new Error(
    'Use read-only --preflight-only or --verify-restored, optionally --descriptor-probe or --core-probe.'
  )
const identity = userInfo(),
  project = resolve('..'),
  evidence = join(project, 'evidence'),
  role = coreProbe
    ? 'fixed-core-fd-probe'
    : descriptorProbe
      ? 'cross-uid-descriptor-probe'
      : 'unconfigured-device-probe',
  builtCandidate = coreProbe
    ? resolve('.relay-build/tun-core-probe/RelayTunCoreProbe')
    : descriptorProbe
      ? resolve('.relay-build/tun-descriptor-probe/RelayTunDescriptorProbe')
      : resolve('.relay-build/tun-device-probe/RelayTunDeviceProbe'),
  baselinePath = join(
    evidence,
    coreProbe
      ? 'tun-core-probe-host-baseline.json'
      : descriptorProbe
        ? 'tun-descriptor-probe-host-baseline.json'
        : 'tun-device-probe-host-baseline.json'
  ),
  exec = promisify(execFile),
  context = {
    home: identity.homedir,
    stateRoot: join(identity.homedir, 'Library/Application Support/Relay-Preview')
  }
if (
  identity.uid <= 0 ||
  process.getuid?.() !== identity.uid ||
  process.geteuid?.() !== identity.uid
)
  throw new Error('Current ordinary user required; never run this harness with sudo.')
async function observe() {
  const interfaces = await exec('/sbin/ifconfig', ['-a'], { timeout: 5000, maxBuffer: 1048576 }),
    routes = await exec('/usr/sbin/netstat', ['-rn'], { timeout: 5000, maxBuffer: 1048576 })
  return {
    protection: await captureProtectedConfiguration(
      identity.homedir,
      (await inspectEdgeNative(resolve('extra/relay/RelayNative'), context)).revision
    ),
    runtime: await captureSystemRuntime(),
    topology: parseTunTopology(interfaces.stdout, routes.stdout),
    transport: await probeClaudeTransport(7890)
  }
}
type Observation = Awaited<ReturnType<typeof observe>>
interface Baseline {
  version: 1
  role: 'unconfigured-device-probe' | 'cross-uid-descriptor-probe' | 'fixed-core-fd-probe'
  createdAt: string
  clientUID: number
  binarySHA256: string
  observation: Observation
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
let candidate = builtCandidate
if (descriptorProbe || coreProbe) {
  const buildDirectory = coreProbe ? 'tun-core-probe' : 'tun-descriptor-probe',
    cacheName = coreProbe ? 'TunCoreProbe' : 'TunDescriptorProbe'
  const bytes = await readBinaryResource(resolve('.relay-build', buildDirectory, 'deployment.json'))
  if (bytes.length > 65536) throw new Error('Oversized descriptor probe deployment manifest.')
  const deployment: unknown = JSON.parse(bytes.toString('utf8')),
    cacheRoot = join(identity.homedir, 'Library/Caches/local.relay.network', cacheName)
  if (
    !object(deployment) ||
    deployment.version !== 1 ||
    deployment.role !==
      (coreProbe ? 'fixed-core-fd-probe-deployment' : 'physical-cross-uid-fd-probe-deployment') ||
    deployment.clientUID !== identity.uid ||
    deployment.clientGID !== identity.gid ||
    deployment.cacheRoot !== cacheRoot ||
    deployment.privilegedBranchExecuted !== false ||
    (coreProbe
      ? deployment.coreStarted !== false
      : deployment.actualDescriptorTransferred !== false)
  )
    throw new Error('Descriptor probe deployment identity differs.')
  const files: { key: string; filename: string; file: unknown; source: string }[] = [
    {
      key: 'client',
      filename: coreProbe ? 'RelayTunCoreProbeClient' : 'RelayTunDescriptorProbeClient',
      file: deployment.client,
      source: resolve(
        '.relay-build',
        buildDirectory,
        coreProbe ? 'RelayTunCoreProbeClient' : 'RelayTunDescriptorProbeClient'
      )
    },
    {
      key: 'probe',
      filename: coreProbe ? 'RelayTunCoreProbe' : 'RelayTunDescriptorProbe',
      file: deployment.probe,
      source: builtCandidate
    }
  ]
  if (coreProbe) {
    if (!object(deployment.cores)) throw new Error('Missing fixed-core deployment.')
    for (const [arch, expectedSHA256] of [
      ['arm64', 'f3e8ae41397c08cbf900ce1f7c8a168285d29954e9bca5d84d69a2b2561adfe9'],
      ['x64', '291f5923c3dd3b8df36eaeccdd59eaf873ee021693cde65eb696f8b86ac99652']
    ]) {
      const file = deployment.cores[arch]
      if (!object(file) || file.sha256 !== expectedSHA256)
        throw new Error('Core resource differs from the pinned v1.19.33 build.')
      files.push({
        key: arch,
        filename: 'mihomo',
        file,
        source: resolve('extra/relay/core', 'darwin-' + arch, 'mihomo')
      })
    }
  }
  for (const { key, filename, file, source } of files) {
    if (
      !object(file) ||
      !digest(file.sha256) ||
      file.path !== join(cacheRoot, file.sha256, filename) ||
      file.sourcePath !== source ||
      file.clientUID !== identity.uid ||
      file.clientGID !== identity.gid ||
      file.sourceAndAncestorAttributesUnchanged !== true ||
      file.cacheAncestorAttributesUnchanged !== true ||
      !digest(file.sourceAttributeSnapshotSHA256)
    )
      throw new Error('Descriptor probe deployment scope or source evidence differs.')
    const path = file.path as string,
      info = await lstat(path)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== identity.uid ||
      info.gid !== identity.gid ||
      info.nlink !== 1 ||
      (info.mode & 0o7777) !== 0o755 ||
      (await realpath(path)) !== path ||
      resourceHash(await readBinaryResource(path)) !== file.sha256 ||
      resourceHash(await readBinaryResource(String(file.sourcePath))) !== file.sha256
    )
      throw new Error('Descriptor probe deployed bytes, permissions or source changed.')
    for (const directory of [
      identity.homedir,
      join(identity.homedir, 'Library'),
      join(identity.homedir, 'Library/Caches'),
      join(identity.homedir, 'Library/Caches/local.relay.network'),
      cacheRoot,
      join(cacheRoot, file.sha256)
    ]) {
      const parent = await lstat(directory)
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        parent.uid !== identity.uid ||
        parent.mode & 0o6022 ||
        (directory.startsWith(cacheRoot) && (parent.mode & 0o7777) !== 0o700) ||
        (await realpath(directory)) !== directory
      )
        throw new Error('Descriptor probe cache ancestry changed.')
    }
    // Client/probe are our signed builds. Upstream core bytes are independently
    // pinned above; the frozen Intel Go artifact has no code signature. Do not
    // re-sign it and silently change the approved upstream resource digest.
    if (key === 'client' || key === 'probe')
      await exec('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', path], {
        timeout: 5000,
        maxBuffer: 65536
      })
    if (key === 'probe') candidate = path
  }
}
function assertBaseline(value: unknown): asserts value is Baseline {
  if (!object(value) || !object(value.observation)) throw new Error('Invalid baseline.')
  const { protection, runtime, topology, transport } = value.observation
  if (
    value.version !== 1 ||
    value.role !== role ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.clientUID !== identity.uid ||
    !digest(value.binarySHA256) ||
    !object(protection) ||
    !digest(protection.revision) ||
    !Array.isArray(protection.entries) ||
    !protection.entries.length ||
    protection.entries.length > 2048 ||
    protection.entries.some(
      (entry) =>
        !object(entry) ||
        typeof entry.label !== 'string' ||
        typeof entry.exists !== 'boolean' ||
        !digest(entry.revision)
    ) ||
    !object(runtime) ||
    !digest(runtime.effectiveProxyRevision) ||
    !digest(runtime.effectiveDnsRevision) ||
    !object(topology) ||
    !digest(topology.interfacesSHA256) ||
    !digest(topology.routesSHA256) ||
    !Array.isArray(transport) ||
    transport.length !== 2 ||
    transport.some(
      (entry) =>
        !object(entry) ||
        !['anthropic-api', 'claude-web'].includes(String(entry.endpoint)) ||
        !Number.isInteger(entry.status) ||
        Number(entry.status) < 200 ||
        Number(entry.status) >= 500 ||
        entry.tlsResponse !== true
    )
  )
    throw new Error('Baseline evidence is incomplete or differs from the intended user.')
}
const binarySHA256 = resourceHash(await readBinaryResource(candidate))
await exec('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', candidate], {
  timeout: 5000,
  maxBuffer: 65536
})
if (mode[0] === '--preflight-only') {
  const baseline: Baseline = {
    version: 1,
    role,
    createdAt: new Date().toISOString(),
    clientUID: identity.uid,
    binarySHA256,
    observation: await observe()
  }
  assertBaseline(baseline)
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx'
  })
  process.stdout.write(
    JSON.stringify({
      passed: true,
      phase: 'read-only-preflight',
      binarySHA256,
      probeExecuted: false
    }) + '\n'
  )
} else {
  const bytes = await readBinaryResource(baselinePath, true)
  if (bytes.length > 1048576) throw new Error('Oversized baseline.')
  const baseline: unknown = JSON.parse(bytes.toString('utf8'))
  assertBaseline(baseline)
  if (baseline.binarySHA256 !== binarySHA256)
    throw new Error('Candidate changed; fresh review required.')
  const after = await observe(),
    before = baseline.observation,
    changedProtectionLabels = compareProtectedConfiguration(before.protection, after.protection),
    protectionUnchanged = changedProtectionLabels.length === 0,
    effectiveProxyUnchanged =
      before.runtime.effectiveProxyRevision === after.runtime.effectiveProxyRevision,
    effectiveDnsUnchanged =
      before.runtime.effectiveDnsRevision === after.runtime.effectiveDnsRevision,
    interfacesUnchanged = before.topology.interfacesSHA256 === after.topology.interfacesSHA256,
    routesUnchanged = before.topology.routesSHA256 === after.topology.routesSHA256,
    transportUnchanged = sameClaudeTransport(before.transport, after.transport),
    passed =
      protectionUnchanged &&
      effectiveProxyUnchanged &&
      effectiveDnsUnchanged &&
      interfacesUnchanged &&
      routesUnchanged &&
      transportUnchanged
  process.stdout.write(
    JSON.stringify(
      {
        passed,
        phase: 'read-only-baseline-comparison',
        binarySHA256,
        protectionUnchanged,
        changedProtectionLabels,
        effectiveProxyUnchanged,
        effectiveDnsUnchanged,
        interfacesUnchanged,
        routesUnchanged,
        transportUnchanged,
        probeExecuted: false,
        actualTunAccepted: false
      },
      null,
      2
    ) + '\n'
  )
  if (!passed) process.exitCode = 1
}
