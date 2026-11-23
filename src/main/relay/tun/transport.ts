import { spawn, execFile } from 'child_process'
import { constants } from 'fs'
import { lstat, mkdir, mkdtemp, open, realpath, unlink, rmdir, readdir } from 'fs/promises'
import { dirname, join } from 'path'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { smartToolsDefinition, SMART_TOOLS_CAPABILITY } from '../../../shared/relay/smart-tools'
import { createLogger } from '../../utils/logger'
import { logPath } from '../../utils/dirs'
import {
  tunHelperObservation,
  tunNetworkObservation,
  tunDigest,
  type TunHelperObservation,
  type TunNetworkObservation
} from '../../../shared/relay/tun'
import { readBinaryResource, resourceHash } from '../resources/source'
import coreManifest from '../core/manifest.json'
import geodataManifest from '../core/geodata-manifest.json'
import { validateBoundConfiguration } from '../configuration/checker'
import type { CoreExecutionReceiptV2 } from '../configuration/core-snapshot-prototype'
import type { PreparedSmartState, SmartStateStore } from '../core/smart-state-store'
import { createTunSmartToolsChannel } from './smart-tools-channel'
import smartToolsClient from './runtime-smart-tools-client.json'
import { createTunHostChannel, type TunHostChannel } from './native-host'
import { parseTunHostFrame } from './wire-json'
import { projectTunNetwork } from './projection'
import runtimeCaptureClient from './runtime-capture-client.json'
import runtimeTelemetryClient from './runtime-telemetry-client.json'
import proxyGroupsPin from './proxy-groups-client.json'
import { createProxyGroupChannel } from './proxy-groups'
import runtimeHistoryClient from './runtime-history-client.json'
import { createTunRuntimeReader } from './runtime-channel'
import runtimeRulesClient from './runtime-rules-client.json'
import { createTunRulesChannel, type TunRulesChannel } from './rules-channel'
import runtimeResourcesClient from './runtime-resources-client.json'
import runtimeRuleProvidersClient from './runtime-rule-providers-client.json'
import { createTunRuleProvidersChannel } from './rule-providers-channel'
import type { TunRuleProvidersChannel } from './rule-providers-contract'
import { createTunResourcesChannel, type TunResourcesChannel } from './resources-channel'
import { createTunResourceInbox, type TunResourceInbox } from './resource-inbox'
import type {
  TunSessionBinding,
  TunSessionHost,
  TunSessionLaunchBundle,
  TunHostObservation
} from './service'
import type { TunRuntime, TunCoreRuntime } from './runtime'
import { validateCheckedTunExecutionV2, type CheckedTunExecutionV2 } from './checked-execution'
import {
  decodeExecutionInstallationV2,
  matchesRuntimeWorkDirectoryClient,
  type ExecutionCoreV2
} from './execution-installation'
import { createTunSmartStateStage } from './smart-state-stage'
import { createTunSmartStateChannel } from './smart-state-channel'
import { smartStateCollectsCSV } from './checked-execution'

const execute = promisify(execFile)
const nativeLogger = createLogger('tun-native')
const root = '/Library/Application Support/Relay/Tun'
const client = root + '/RelayTunClient'
const manifestPath = root + '/installation.json'
const managedRoot = '/Library/Application Support/Relay/TunManaged'
// Frozen288's verified signed client supports capture-v1 only. Preserve that
// exact legacy capability when Builder advances the current capture/rules pins.
const legacyCaptureSHA256 = '14949766f12f2ee6db44b14d7b800f112f482639b9c7e181ca6da82045853460'
const legacyRulesSHA256 = 'c1be9951f5f4d092f866c55c058a73d3d64ee28f50d577fb9e00c955fe17b3d4'
const legacyResourcesSHA256 = 'c586cd3ae1497630f63975c5a1b80e33bd8df1986b3eb7fcbe658936fe16e26d'
const legacyResourceCores = {
  arm64: 'a1df3f473ece06215230d1b9d012e4e9a6e6c23f8d51fecc83045dfc8eb9431a',
  x64: 'd7250be4fb4963ebd2fc82aab0177d348f4806da2fa56aa826e10574b8065c4b'
}
interface ResourcesPin {
  version: number
  capability: string
  clientSHA256: string | null
  cores: { arm64: string | null; x64: string | null }
}
type Item = Record<string, unknown>
const object = (value: unknown): value is Item =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export async function prepareTunDiagnostics(sessionId = 'app-start'): Promise<void> {
  try {
    const path = logPath(),
      directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o022 ||
      (await realpath(directory)) !== directory
    )
      throw new Error()
    const file = await open(
      path,
      constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600
    )
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        info.mode & 0o022
      )
        throw new Error()
    } finally {
      await file.close()
    }
    // Logger intentionally swallows write failures and may be disabled. Only
    // this invocation's freshly persisted marker proves startup diagnostics.
    const marker = `session=${sessionId} diagnostic-ready=${randomUUID()}`
    await nativeLogger.info(marker)
    // A midnight rotation may choose the next daily file during the write.
    for (const candidate of new Set([path, logPath()])) {
      if (dirname(candidate) !== directory) continue
      const file = await open(
        candidate,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      try {
        const info = await file.stat()
        if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1) continue
        const tail = Buffer.alloc(Math.min(8192, info.size))
        const { bytesRead } = await file.read(tail, 0, tail.length, info.size - tail.length)
        if (
          tail
            .subarray(0, bytesRead)
            .toString('utf8')
            .includes(marker + '\n')
        )
          return
      } finally {
        await file.close()
      }
    }
  } catch {
    /* No native client or core has been spawned at this point. */
  }
  throw new Error('TUN诊断日志无法写入或已关闭，未启动原生客户端或核心。')
}
export interface TunInstallation {
  execution?: 'core-managed'
  executionCore?: ExecutionCoreV2
  revision: string
  helperSHA256: string
  coreSHA256: string
  clientSHA256: string
}
export interface TunNativeInspection {
  helper: TunHelperObservation
  network: TunNetworkObservation
  baseline: { networkSHA256: string; protectionSHA256: string }
}

// Only fixed native stage codes may reach application logs. Unknown stderr,
// oversized lines and private error descriptions are discarded.
export function createTunStartDiagnostics(
  report: (code: string) => void,
  recoveryReport: (code: string) => void = () => {}
): (bytes: Buffer) => void {
  const recoveryCodes = new Set([
    'stop.state',
    'stop.child',
    'stop.child-exit',
    'restore.state',
    'restore.interface-read',
    'restore.baseline-read',
    'restore.protection',
    'restore.interface-deadline',
    'restore.network-deadline',
    'restore.interface-changed',
    'restore.network-changed',
    'dispose.lock',
    'dispose.bundle',
    'dispose.core',
    'dispose.record',
    'session.recovery',
    'session.stopCore',
    'session.release',
    'session.verifyRestored',
    'session.release.core',
    'session.verifyRestored.core',
    'session.baseline',
    'session.dispose'
  ])
  const allowed = new Set([
    'managed.state',
    'managed.resource',
    'managed.lock',
    'managed.baseline',
    'managed.spawn',
    'managed.readiness',
    'core.tun.stack.unavailable',
    'session.state',
    'session.bundle',
    'session.baseline',
    'host.authorization',
    'host.resource',
    'host.admission',
    'host.descriptor',
    'host.spawn',
    'host.observation',
    'readiness.invalid',
    'readiness.resource',
    'readiness.response',
    'readiness.deadline',
    'readiness.peer',
    ...[
      'version',
      'tun',
      'tun.enable',
      'tun.file-descriptor',
      'tun.device',
      'tun.stack',
      'tun.mtu',
      'tun.auto-route',
      'tun.auto-detect-interface',
      'port',
      'socks-port',
      'mixed-port',
      'redir-port',
      'tproxy-port',
      'mode',
      'allow-lan',
      'ipv6',
      'tun.auto-redirect',
      'tun.gso',
      'tun.recvmsgx',
      'tun.sendmsgx',
      'tun.dns-hijack',
      'tun.dns-mode'
    ].map((field) => `readiness.field.${field}`),
    ...['version', 'configs'].flatMap((endpoint) => [
      `readiness.json.${endpoint}`,
      `readiness.http.${endpoint}`,
      ...['busy', 'socket', 'options', 'poll', 'write', 'receive', 'limit'].map(
        (stage) => `readiness.io.${endpoint}.${stage}`
      )
    ])
  ])
  let line = '',
    discarded = false,
    reported = 0,
    recoveryReported = 0
  return (bytes) => {
    for (const byte of bytes) {
      if (byte === 10) {
        if (!discarded && line.startsWith('RELAY_TUN_START_FAILURE ')) {
          const code = line.slice('RELAY_TUN_START_FAILURE '.length)
          if (allowed.has(code) && reported < 16) {
            reported++
            report(code)
          }
        } else if (!discarded && line.startsWith('RELAY_TUN_RECOVERY_FAILURE ')) {
          const code = line.slice('RELAY_TUN_RECOVERY_FAILURE '.length)
          if (recoveryCodes.has(code) && recoveryReported < 16) {
            recoveryReported++
            recoveryReport(code)
          }
        }
        line = ''
        discarded = false
      } else if (!discarded) {
        if (byte < 32 || byte > 126 || line.length >= 128) {
          line = ''
          discarded = true
        } else line += String.fromCharCode(byte)
      }
    }
  }
}

async function rootPath(path: string, file: boolean): Promise<void> {
  let cursor = path
  while (true) {
    const info = await lstat(cursor)
    if (
      info.uid !== 0 ||
      info.isSymbolicLink() ||
      info.mode & 0o022 ||
      (cursor === path && (file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()))
    )
      throw new Error('TUN辅助程序安装路径的归属、类型或权限未确认。')
    if (cursor === '/') break
    cursor = dirname(cursor)
  }
  if ((await realpath(path)) !== path) throw new Error('TUN安装路径包含别名或符号链接。')
}
export async function readTunInstallation(
  execution?: 'core-managed'
): Promise<TunInstallation | undefined> {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) return undefined
  const installedManifest = execution ? managedRoot + '/installation.json' : manifestPath,
    installedClient = execution ? managedRoot + '/RelayTunClient' : client
  try {
    await rootPath(installedManifest, true)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const bytes = await readBinaryResource(installedManifest)
  if (bytes.length > 16384) throw new Error('TUN安装清单超过上限。')
  const raw: unknown = JSON.parse(bytes.toString('utf8'))
  if (execution && object(raw) && (raw.version === 2 || raw.role === 'core-managed-v2')) {
    const admitted = decodeExecutionInstallationV2(
      bytes,
      process.arch as 'arm64' | 'x64',
      process.getuid?.() ?? 0
    )
    await rootPath(installedClient, true)
    const info = await lstat(installedClient),
      clientBytes = await readBinaryResource(installedClient)
    if (
      (info.mode & 0o7777) !== 0o755 ||
      info.size !== admitted.clientSize ||
      clientBytes.length !== admitted.clientSize ||
      resourceHash(clientBytes) !== admitted.clientSHA256
    )
      throw new Error('execution-v2客户端与root安装清单不符。')
    return {
      execution,
      executionCore: admitted.core,
      revision: admitted.revision,
      helperSHA256: admitted.clientSHA256,
      coreSHA256: admitted.core.sha256,
      clientSHA256: admitted.clientSHA256
    }
  }
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64',
    pin = coreManifest.assets[process.arch as 'arm64' | 'x64'],
    extensions: ResourcesPin[] = [
      {
        version: 1,
        capability: 'runtime-resources-v1',
        clientSHA256: legacyResourcesSHA256,
        cores: legacyResourceCores
      },
      runtimeResourcesClient,
      runtimeRuleProvidersClient
    ],
    extendedPair =
      execution &&
      object(raw) &&
      raw.coreProfile === 'local-geodata-v1' &&
      object(raw.client) &&
      object(raw.cores) &&
      object(raw.cores[architecture]) &&
      extensions.some((extension) => {
        const core = extension.cores[process.arch as 'arm64' | 'x64']
        return (
          extension.version === 1 &&
          ['runtime-resources-v1', 'runtime-rule-providers-v1'].includes(extension.capability) &&
          typeof extension.clientSHA256 === 'string' &&
          tunDigest(extension.clientSHA256) &&
          typeof core === 'string' &&
          tunDigest(core) &&
          // Only the new serialized File Core admits the provider capability.
          (extension.capability !== 'runtime-rule-providers-v1' ||
            core === geodataManifest.assets[process.arch as 'arm64' | 'x64'].sha256) &&
          object(raw.client) &&
          raw.client.sha256 === extension.clientSHA256 &&
          object(raw.cores) &&
          object(raw.cores[architecture]) &&
          raw.cores[architecture].sha256 === core
        )
      })
  if (
    !object(raw) ||
    raw.version !== (execution ? 1 : 2) ||
    raw.role !== (execution ? 'core-managed-v1' : 'network-executor-v1') ||
    (!execution && raw.service !== 'local.relay.network.tun') ||
    raw.clientUID !== process.getuid?.() ||
    (!execution && (!object(raw.helper) || !tunDigest(raw.helper.sha256))) ||
    !object(raw.client) ||
    !tunDigest(raw.client.sha256) ||
    !object(raw.cores) ||
    !object(raw.cores[architecture]) ||
    !tunDigest(raw.cores[architecture].sha256) ||
    (raw.cores[architecture].sha256 === pin.sha256 && 'coreProfile' in raw) ||
    (raw.cores[architecture].sha256 !== pin.sha256 && !extendedPair)
  )
    throw new Error('TUN安装角色、授权用户或固定资源不匹配，请安装本次构建的完整候选。')
  await rootPath(installedClient, true)
  if (
    ((await lstat(installedClient)).mode & 0o7777) !== 0o755 ||
    resourceHash(await readBinaryResource(installedClient)) !== raw.client.sha256
  )
    throw new Error('TUN客户端与root安装清单摘要不符。')
  return {
    revision: resourceHash(bytes),
    ...(execution ? { execution } : {}),
    helperSHA256: execution ? raw.client.sha256 : (raw.helper as { sha256: string }).sha256,
    coreSHA256: raw.cores[architecture].sha256,
    clientSHA256: raw.client.sha256
  }
}
export async function inspectTunNative(
  installation: TunInstallation
): Promise<TunNativeInspection> {
  const current = await readTunInstallation(installation.execution)
  if (!current || JSON.stringify(current) !== JSON.stringify(installation))
    throw new Error('TUN辅助程序安装已变化，请重新准备。')
  const { stdout } = await execute(
    installation.execution ? managedRoot + '/RelayTunClient' : client,
    [
      installation.executionCore
        ? '--managed-inspect-execution-v2'
        : installation.execution
          ? '--managed-inspect'
          : '--inspect'
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 32768,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      windowsHide: true
    }
  )
  const raw = parseTunHostFrame(Buffer.from(stdout.trim()))
  if (
    !object(raw) ||
    !object(raw.baseline) ||
    !tunDigest(raw.baseline.networkSHA256) ||
    !tunDigest(raw.baseline.protectionSHA256)
  )
    throw new Error('TUN原生环境报告未确认。')
  const helper = tunHelperObservation(raw.helper),
    network = tunNetworkObservation(raw.network)
  if (
    helper.revision !== installation.revision ||
    helper.helperSHA256 !== installation.helperSHA256 ||
    helper.coreSHA256 !== installation.coreSHA256
  )
    throw new Error('TUN原生报告的安装身份与固定资源不符。')
  return {
    helper,
    network,
    baseline: {
      networkSHA256: raw.baseline.networkSHA256,
      protectionSHA256: raw.baseline.protectionSHA256
    }
  }
}

// Holds only main-owned private staging. No recursive removal: unknown files,
// changed identities or changed bytes retain evidence instead of being deleted.
type StageRuntime = Pick<TunRuntime, 'configuration' | 'sourceConfigurationSHA256'> & {
  preparation: { bundleSHA256: string }
}
export interface ExecutionStageV2 extends CheckedTunExecutionV2 {
  readonly recheck: () => Promise<void>
  readonly smartState?: {
    prepared: PreparedSmartState
    store: Pick<SmartStateStore, 'commit'>
  }
}
async function stage(
  runtime: StageRuntime,
  launch: TunSessionLaunchBundle,
  execution?: { receipt: CoreExecutionReceiptV2; raw: Buffer; state?: PreparedSmartState }
) {
  validateBoundConfiguration(launch.sourceConfiguration, launch.assets, execution?.receipt)
  const directory = await realpath(await mkdtemp('/private/tmp/relay-tun-main-')),
    identity = await lstat(directory)
  const files: { path: string; sha256: string; dev: number; ino: number }[] = [],
    directories: string[] = []
  const deleted = new Set<string>()
  let removed = false
  let smartState: Awaited<ReturnType<typeof createTunSmartStateStage>> | undefined
  const same = async (): Promise<void> => {
    const info = await lstat(directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== identity.dev ||
      info.ino !== identity.ino ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o700
    )
      throw new Error('本次TUN暂存目录身份已变化。')
  }
  const put = async (name: string, bytes: Buffer): Promise<void> => {
    await same()
    const path = join(directory, name),
      parent = dirname(path)
    if (parent !== directory && !directories.includes(parent)) {
      await mkdir(parent, { mode: 0o700 })
      directories.push(parent)
    }
    const fd = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    )
    try {
      await fd.writeFile(bytes)
      await fd.sync()
    } finally {
      await fd.close()
    }
    const info = await lstat(path),
      sha256 = resourceHash(bytes)
    if (resourceHash(await readBinaryResource(path, true)) !== sha256)
      throw new Error('TUN暂存文件摘要已变化。')
    files.push({ path, sha256, dev: info.dev, ino: info.ino })
  }
  const cleanup = async (): Promise<void> => {
    if (removed) return
    await same()
    const expected = new Set([
      ...files
        .filter((file) => !deleted.has(file.path))
        .map((file) => file.path.slice(directory.length + 1).split('/')[0]),
      ...directories
        .filter((path) => !deleted.has(path))
        .map((path) => path.slice(directory.length + 1)),
      ...(smartState ? ['state-seed', 'state-result'] : [])
    ])
    if ((await readdir(directory)).sort().join(',') !== [...expected].sort().join(','))
      throw new Error('TUN暂存目录含未知内容，保留证据。')
    for (const file of files.filter((file) => !deleted.has(file.path))) {
      const info = await lstat(file.path)
      if (
        info.dev !== file.dev ||
        info.ino !== file.ino ||
        resourceHash(await readBinaryResource(file.path, true)) !== file.sha256
      )
        throw new Error('TUN暂存内容已改变，保留证据。')
    }
    await smartState?.cleanup()
    smartState = undefined
    for (const file of files.filter((file) => !deleted.has(file.path))) {
      await unlink(file.path)
      deleted.add(file.path)
    }
    for (const folder of [...directories].reverse().filter((folder) => !deleted.has(folder))) {
      await rmdir(folder)
      deleted.add(folder)
    }
    await rmdir(directory)
    removed = true
  }
  try {
    const assets = launch.assets.map(({ path, sha256, expectedRules }) => ({
      path,
      sha256,
      ...(expectedRules !== undefined ? { expectedRules } : {})
    }))
    const bundle = JSON.stringify({
      configuration: JSON.parse(launch.sourceConfiguration),
      assets,
      pins: launch.pins,
      unresolved: []
    })
    if (
      resourceHash(Buffer.from(launch.sourceConfiguration)) !== runtime.sourceConfigurationSHA256 ||
      resourceHash(Buffer.from(bundle)) !== runtime.preparation.bundleSHA256
    )
      throw new Error('完整TUN候选来源或资源包摘要不符。')
    await put('source.json', Buffer.from(launch.sourceConfiguration))
    await put('bundle.json', Buffer.from(bundle))
    await put('config.json', Buffer.from(runtime.configuration))
    for (const asset of launch.assets) await put(asset.path, asset.bytes)
    if (execution) await put('execution.json', execution.raw)
    if (execution?.state) smartState = await createTunSmartStateStage(directory, execution.state)
    return {
      directory,
      assets,
      ...(execution
        ? { execution: { path: 'execution.json' as const, sha256: resourceHash(execution.raw) } }
        : {}),
      cleanup,
      smartState,
      async acceptRecovery(bytes: Buffer): Promise<void> {
        await same()
        const path = join(directory, 'recovery.json'),
          info = await lstat(path),
          sha256 = resourceHash(bytes)
        if (resourceHash(await readBinaryResource(path, true)) !== sha256)
          throw new Error('TUN故障恢复记录发生变化。')
        const prior = files.find((file) => file.path === path)
        if (prior && (prior.sha256 !== sha256 || prior.dev !== info.dev || prior.ino !== info.ino))
          throw new Error('TUN故障恢复记录身份不符。')
        if (!prior) files.push({ path, sha256, dev: info.dev, ino: info.ino })
      }
    }
  } catch (error) {
    await cleanup().catch(() => {})
    await smartState?.close()
    throw error
  }
}

// Main-private wire3 preparation. The caller independently admits the fixed v2
// installation before this exact receipt is handed to its separate launch flag.
export async function stageExecutionV2Prototype(
  runtime: TunCoreRuntime,
  launch: TunSessionLaunchBundle,
  execution: ExecutionStageV2
) {
  if (
    runtime.version !== 2 ||
    !runtime.checkedExecution ||
    runtime.checkedExecution.raw !== execution.raw ||
    runtime.checkedExecution.sha256 !== execution.sha256
  )
    throw new Error('execution-v2需要原plan绑定的自管运行回执。')
  const live = async (): Promise<void> => {
    await execution.recheck()
    validateCheckedTunExecutionV2(
      execution,
      launch.sourceConfiguration,
      launch.assets,
      execution.receipt.core.sha256,
      Date.now()
    )
  }
  const receipt = structuredClone(execution.receipt)
  // Copy the exact pre-encoded bytes already bound into plan/device evidence.
  const raw = Buffer.from(execution.raw)
  if (resourceHash(raw) !== execution.sha256) throw new Error('execution-v2原始回执摘要不匹配。')
  if (raw.length > 262144) throw new Error('execution-v2回执超过256KiB。')
  validateBoundConfiguration(launch.sourceConfiguration, launch.assets, receipt)
  // Everything above reads only in-memory bytes. Recheck before the first staging I/O.
  await live()
  if (receipt.profile === 'smart') {
    if (
      !execution.stateSeed ||
      !execution.smartState ||
      JSON.stringify(execution.stateSeed) !== JSON.stringify(execution.smartState.prepared.receipt)
    )
      throw new Error('Smart执行需要与原回执相同的状态种子。')
    await execution.smartState.prepared.recheck()
  } else if (execution.stateSeed || execution.smartState) throw new Error('此核心不接受Smart状态。')
  const staged = await stage(runtime, launch, {
    receipt,
    raw,
    state: execution.smartState?.prepared
  })
  try {
    await live()
    return {
      ...staged,
      async bootstrap(
        binding: TunSessionBinding,
        installationRevision: string,
        baseline: TunNativeInspection['baseline']
      ): Promise<Buffer> {
        await live()
        if (
          !tunDigest(installationRevision) ||
          binding.evidenceSHA256 !== runtime.preparation.evidenceSHA256 ||
          binding.runtimeConfigurationSHA256 !== runtime.runtimeConfigurationSHA256
        )
          throw new Error('execution-v2运行绑定不一致。')
        const frame = Buffer.from(
          JSON.stringify({
            version: 3,
            action: 'bootstrap',
            controlLossPolicy: 'restore-owned-session',
            binding,
            configurationSHA256: runtime.sourceConfigurationSHA256,
            bundleSHA256: runtime.preparation.bundleSHA256,
            configurationPath: 'config.json',
            directory: staged.directory,
            installationRevision,
            executionPath: 'execution.json',
            executionSHA256: resourceHash(raw),
            assets: staged.assets,
            pins: launch.pins,
            baseline
          }) + '\n'
        )
        if (frame.length > 262144) throw new Error('execution-v2启动元数据超过256KiB。')
        await live()
        return frame
      }
    }
  } catch (error) {
    await staged.cleanup()
    throw error
  }
}

export async function openTunNativeHost(
  installation: TunInstallation,
  baseline: TunNativeInspection['baseline'],
  runtime: TunRuntime,
  binding: TunSessionBinding,
  launch: TunSessionLaunchBundle,
  register: (host: TunSessionHost) => void,
  uncertain: () => void,
  adapters: {
    readInstallation?: typeof readTunInstallation
    inspect?: typeof inspectTunNative
    spawn?: typeof spawn
    runtimeCapturePin?: typeof runtimeCaptureClient
    runtimeTelemetryPin?: { version: number; capability: string; clientSHA256: string | null }
    runtimeHistoryPin?: { version: number; capability: string; clientSHA256: string | null }
    runtimeRulesPin?: { capability: string; clientSHA256: string | null }
    runtimeResourcesPin?: ResourcesPin
    runtimeRuleProvidersPin?: ResourcesPin
    runtimeSmartToolsPin?: { version: number; capability: string; clientSHA256: string | null }
    runtimeWorkDirectoryPin?: { version: number; capability: string; clientSHA256: string | null }
    execution?: ExecutionStageV2
  } = {}
): Promise<TunHostChannel> {
  if ((runtime.version === 2) !== (installation.execution === 'core-managed'))
    throw new Error('TUN运行方式与权限安装不匹配。')
  const execution = adapters.execution
  const executionCore = installation.executionCore
  if (
    !!installation.executionCore !== !!execution ||
    !!(runtime.version === 2 && runtime.checkedExecution) !== !!execution ||
    (execution &&
      (runtime.version !== 2 ||
        !executionCore ||
        executionCore.profile !== execution.receipt.profile ||
        executionCore.architecture !== execution.receipt.architecture ||
        executionCore.version !== execution.receipt.core.version ||
        executionCore.sha256 !== execution.receipt.core.sha256 ||
        executionCore.size !== execution.receipt.core.size))
  )
    throw new Error('execution-v2安装、原始回执或固定核心不匹配。')
  const fresh = await (adapters.readInstallation ?? readTunInstallation)(installation.execution)
  if (!fresh || JSON.stringify(fresh) !== JSON.stringify(installation))
    throw new Error('TUN安装变化，未启动。')
  await prepareTunDiagnostics(binding.sessionId)
  const projected =
      runtime.version === 1 ? projectTunNetwork(launch.sourceConfiguration) : undefined,
    wire3Staged =
      execution && runtime.version === 2
        ? await stageExecutionV2Prototype(runtime, launch, execution)
        : undefined,
    staged = wire3Staged ?? (await stage(runtime, launch))
  let executionBootstrap: Buffer | undefined
  try {
    executionBootstrap = await wire3Staged?.bootstrap(binding, installation.revision, baseline)
  } catch (error) {
    await staged.cleanup().catch(() => {})
    await staged.smartState?.close()
    throw error
  }
  const processHandle: { child?: ReturnType<typeof spawn> } = {}
  const rawToolsConfiguration: unknown = JSON.parse(runtime.configuration)
  const declaredToolsGroups =
    rawToolsConfiguration &&
    typeof rawToolsConfiguration === 'object' &&
    !Array.isArray(rawToolsConfiguration)
      ? (rawToolsConfiguration as Record<string, unknown>)['proxy-groups']
      : undefined
  const smartGroups = Array.isArray(declaredToolsGroups)
    ? declaredToolsGroups
        .filter((group) => !!group && typeof group === 'object' && group.type === 'smart')
        .map((group) => group.name)
    : []
  const toolsPin = adapters.runtimeSmartToolsPin ?? smartToolsClient
  const canWorkDirectory =
    !!execution &&
    matchesRuntimeWorkDirectoryClient(installation.clientSHA256, adapters.runtimeWorkDirectoryPin)
  const canSmartTools =
    !!execution?.smartState &&
    executionCore?.profile === 'smart' &&
    smartGroups.length > 0 &&
    toolsPin.version === 1 &&
    toolsPin.capability === SMART_TOOLS_CAPABILITY &&
    typeof toolsPin.clientSHA256 === 'string' &&
    tunDigest(toolsPin.clientSHA256) &&
    (toolsPin.clientSHA256 === installation.clientSHA256 || canWorkDirectory)
  const capturePin = adapters.runtimeCapturePin ?? runtimeCaptureClient,
    rulesPin = adapters.runtimeRulesPin ?? runtimeRulesClient,
    resourcesPin = adapters.runtimeResourcesPin ?? runtimeResourcesClient,
    providersPin = adapters.runtimeRuleProvidersPin ?? runtimeRuleProvidersClient,
    resourceCorePin = resourcesPin.cores[process.arch as 'arm64' | 'x64'],
    providerCorePin = providersPin.cores[process.arch as 'arm64' | 'x64'],
    canProviders =
      !execution &&
      runtime.version === 2 &&
      installation.execution === 'core-managed' &&
      providersPin.version === 1 &&
      providersPin.capability === 'runtime-rule-providers-v1' &&
      typeof providersPin.clientSHA256 === 'string' &&
      tunDigest(providersPin.clientSHA256) &&
      ![legacyCaptureSHA256, legacyRulesSHA256, legacyResourcesSHA256].includes(
        providersPin.clientSHA256
      ) &&
      providersPin.clientSHA256 === installation.clientSHA256 &&
      typeof providerCorePin === 'string' &&
      tunDigest(providerCorePin) &&
      providerCorePin === geodataManifest.assets[process.arch as 'arm64' | 'x64'].sha256 &&
      providerCorePin === installation.coreSHA256,
    canResources =
      !execution &&
      runtime.version === 2 &&
      installation.execution === 'core-managed' &&
      (canProviders ||
        (installation.clientSHA256 === legacyResourcesSHA256 &&
          installation.coreSHA256 === legacyResourceCores[process.arch as 'arm64' | 'x64']) ||
        (resourcesPin.version === 1 &&
          resourcesPin.capability === 'runtime-resources-v1' &&
          typeof resourcesPin.clientSHA256 === 'string' &&
          tunDigest(resourcesPin.clientSHA256) &&
          ![legacyCaptureSHA256, legacyRulesSHA256, legacyResourcesSHA256].includes(
            resourcesPin.clientSHA256
          ) &&
          resourcesPin.clientSHA256 === installation.clientSHA256 &&
          typeof resourceCorePin === 'string' &&
          tunDigest(resourceCorePin) &&
          resourceCorePin === installation.coreSHA256)),
    canRules =
      runtime.version === 2 &&
      installation.execution === 'core-managed' &&
      (!!execution ||
        canResources ||
        installation.clientSHA256 === legacyRulesSHA256 ||
        (rulesPin.capability === 'runtime-rules-v1' &&
          typeof rulesPin.clientSHA256 === 'string' &&
          tunDigest(rulesPin.clientSHA256) &&
          rulesPin.clientSHA256 !== legacyCaptureSHA256 &&
          rulesPin.clientSHA256 === installation.clientSHA256)),
    canCapture =
      runtime.version === 2 &&
      installation.execution === 'core-managed' &&
      (canRules ||
        installation.clientSHA256 === legacyCaptureSHA256 ||
        (capturePin.version === 1 &&
          capturePin.capability === 'runtime-capture-v1' &&
          typeof capturePin.clientSHA256 === 'string' &&
          tunDigest(capturePin.clientSHA256) &&
          capturePin.clientSHA256 === installation.clientSHA256))
  const telemetryPin = adapters.runtimeTelemetryPin ?? runtimeTelemetryClient,
    canTelemetry =
      canCapture &&
      (canProviders || !!execution) &&
      telemetryPin.version === 2 &&
      telemetryPin.capability === 'runtime-telemetry-v2' &&
      typeof telemetryPin.clientSHA256 === 'string' &&
      tunDigest(telemetryPin.clientSHA256) &&
      (telemetryPin.clientSHA256 === installation.clientSHA256 || canWorkDirectory)
  const historyPin = adapters.runtimeHistoryPin ?? runtimeHistoryClient,
    canHistory =
      canCapture &&
      (canProviders || !!execution) &&
      historyPin.version === 3 &&
      historyPin.capability === 'runtime-history-v3' &&
      typeof historyPin.clientSHA256 === 'string' &&
      tunDigest(historyPin.clientSHA256) &&
      historyPin.clientSHA256 === installation.clientSHA256
  const canProxyGroups =
    canCapture &&
    proxyGroupsPin.version === 1 &&
    proxyGroupsPin.capability === 'proxy-groups-v1' &&
    typeof proxyGroupsPin.clientSHA256 === 'string' &&
    tunDigest(proxyGroupsPin.clientSHA256) &&
    proxyGroupsPin.clientSHA256 === installation.clientSHA256
  let resourceInbox: TunResourceInbox | undefined
  try {
    resourceInbox = canResources ? await createTunResourceInbox() : undefined
  } catch (error) {
    await staged.cleanup().catch(() => {})
    throw error
  }
  let data = (_bytes: Buffer): void => {},
    gone = (): void => {},
    fault = (): void => {}
  let exited = false,
    exitCode: number | null = null,
    stateCleanupNonce: string | undefined,
    statePipeFailed = false,
    stateOwnerLive = true
  let diagnosticsWritten = Promise.resolve()
  const recoveryFailure = (code: string): void => {
    diagnosticsWritten = diagnosticsWritten
      .then(() => nativeLogger.warn(`session=${binding.sessionId} recovery-failure=${code}`))
      .catch(() => {})
  }
  const queued: string[] = []
  const channel = createTunHostChannel(
    {
      write: (frame) => {
        if (processHandle.child) processHandle.child.stdin?.write(frame)
        else queued.push(frame)
      },
      end: () => {
        processHandle.child?.stdin?.end()
      },
      onData: (callback) => {
        data = callback
      },
      onGone: (callback) => {
        gone = callback
      },
      onFault: (callback) => {
        fault = callback
      }
    },
    binding,
    uncertain,
    30000,
    installation.execution,
    execution?.smartState ? () => stateCleanupNonce : undefined,
    canWorkDirectory
  )
  let smartToolsData = (_bytes: Buffer): void => {},
    smartToolsGone = (): void => {},
    smartToolsFault = (): void => {},
    smartToolsPipeFailed = false,
    smartToolsChannel: ReturnType<typeof createTunSmartToolsChannel> | undefined
  const initializeSmartToolsChannel = (): void => {
    smartToolsChannel = createTunSmartToolsChannel(
      {
        write: (frame) => {
          const input = processHandle.child?.stdio.at(9)
          if (!input || !('write' in input)) throw new Error('Smart工具管道不可用。')
          input.write(frame)
        },
        onData: (callback) => {
          smartToolsData = callback
        },
        onGone: (callback) => {
          smartToolsGone = callback
        },
        onFault: (callback) => {
          smartToolsFault = callback
        },
        close: () => {
          processHandle.child?.stdio.at(9)?.destroy()
          processHandle.child?.stdio.at(10)?.destroy()
        }
      },
      {
        ...binding,
        launchClientSHA256: installation.clientSHA256,
        installationRevision: installation.revision
      },
      smartToolsDefinition({
        configurationRevision: binding.runtimeConfigurationSHA256,
        groups: smartGroups
      })
    )
    Object.assign(channel, { smartToolsChannel })
    const output = processHandle.child?.stdio.at(10)
    if (!output || smartToolsPipeFailed) smartToolsFault()
    else output.on('data', (bytes: Buffer) => smartToolsData(bytes))
  }
  let stateData = (_bytes: Buffer): void => {},
    stateGone = (): void => {},
    stateFault = (): void => {},
    smartStateChannel: ReturnType<typeof createTunSmartStateChannel> | undefined
  const initializeSmartStateChannel = (): void => {
    if (!execution?.smartState || !execution.stateSeed) throw new Error('Smart状态交接缺失。')
    smartStateChannel = createTunSmartStateChannel(
      {
        write: (frame) => {
          const input = processHandle.child?.stdio.at(7)
          if (!input || !('write' in input)) throw new Error('Smart状态管道不可用。')
          input.write(frame)
        },
        onData: (callback) => {
          stateData = callback
        },
        onGone: (callback) => {
          stateGone = callback
        },
        onFault: (callback) => {
          stateFault = callback
        },
        close: () => {
          statePipeFailed = true
          processHandle.child?.stdio.at(7)?.destroy()
          processHandle.child?.stdio.at(8)?.destroy()
        }
      },
      {
        ...binding,
        launchClientSHA256: installation.clientSHA256,
        installationRevision: installation.revision
      },
      execution.sha256,
      execution.stateSeed,
      smartStateCollectsCSV(launch.sourceConfiguration)
    )
    const output = processHandle.child?.stdio.at(8)
    if (!output || statePipeFailed) stateFault()
    else output.on('data', (bytes: Buffer) => stateData(bytes))
  }
  let stateSave: Promise<boolean> | undefined
  const saveSmartState = (): Promise<boolean> => {
    if (stateSave) return stateSave
    stateSave = (async () => {
      const owner = execution?.smartState,
        staging = staged.smartState,
        lane = smartStateChannel,
        assertOwner = (): void => {
          if (!owner || !lane || !staging || !stateOwnerLive || statePipeFailed || exited)
            throw new Error('Smart状态持有者或通道已变化。')
        }
      try {
        assertOwner()
        if (!owner || !lane || !staging) throw new Error('Smart状态交接不可用。')
        const signal = new AbortController().signal,
          exported = await lane.export(signal, assertOwner)
        if (exported.status !== 'snapshot') throw new Error('Smart状态导出未确认。')
        const bytes = await staging.readResult(exported.snapshot, binding)
        assertOwner()
        const revision = await owner.store.commit(
          owner.prepared.receipt.key,
          owner.prepared.receipt.previousRevision,
          bytes,
          assertOwner
        )
        assertOwner()
        const acknowledged = await lane.acknowledge(revision, signal, assertOwner)
        if (acknowledged.status !== 'updated' || !tunDigest(acknowledged.snapshot.cleanupNonce))
          throw new Error('Smart状态提交确认缺失。')
        assertOwner()
        stateCleanupNonce = acknowledged.snapshot.cleanupNonce
        return true
      } catch {
        await nativeLogger.warn(`session=${binding.sessionId} smart-state=retained`).catch(() => {})
        return false
      }
    })()
    return stateSave
  }
  let runtimeData = (_bytes: Buffer): void => {},
    runtimeGone = (): void => {},
    runtimeFault = (): void => {},
    runtimePipeFailed = false
  const initializeRuntimeReader = (): void => {
    const runtimeReader = createTunRuntimeReader(
      {
        write: (frame) => {
          const input = processHandle.child?.stdio[3]
          if (!input || !('write' in input)) throw new Error('TUN只读管道不可用。')
          input.write(frame)
        },
        onData: (callback) => {
          runtimeData = callback
        },
        onGone: (callback) => {
          runtimeGone = callback
        },
        onFault: (callback) => {
          runtimeFault = callback
        }
      },
      {
        ...binding,
        launchClientSHA256: installation.clientSHA256,
        installationRevision: installation.revision
      },
      3000,
      canHistory
        ? 'runtime-history-v3'
        : canTelemetry
          ? 'runtime-telemetry-v2'
          : 'runtime-capture-v1'
    )
    Object.assign(channel, { runtimeReader })
    const output = processHandle.child?.stdio[4]
    if (!output || runtimePipeFailed) runtimeFault()
    else output.on('data', (bytes: Buffer) => runtimeData(bytes))
  }
  let rulesData = (_bytes: Buffer): void => {},
    rulesGone = (): void => {},
    rulesFault = (): void => {},
    rulesPipeFailed = false,
    rulesChannel: TunRulesChannel | undefined
  const initializeRulesChannel = (): void => {
    rulesChannel = createTunRulesChannel(
      {
        write: (frame) => {
          const input = processHandle.child?.stdio.at(5)
          if (!input || !('write' in input)) throw new Error('TUN规则管道不可用。')
          input.write(frame)
        },
        onData: (callback) => {
          rulesData = callback
        },
        onGone: (callback) => {
          rulesGone = callback
        },
        onFault: (callback) => {
          rulesFault = callback
        },
        close: () => {
          processHandle.child?.stdio.at(5)?.destroy()
          processHandle.child?.stdio.at(6)?.destroy()
        }
      },
      {
        ...binding,
        launchClientSHA256: installation.clientSHA256,
        installationRevision: installation.revision
      }
    )
    Object.assign(channel, { rulesChannel })
    const output = processHandle.child?.stdio.at(6)
    if (!output || rulesPipeFailed) rulesFault()
    else output.on('data', (bytes: Buffer) => rulesData(bytes))
  }
  let resourcesData = (_bytes: Buffer): void => {},
    resourcesGone = (): void => {},
    resourcesFault = (): void => {},
    resourcesPipeFailed = false,
    resourcesChannel: TunResourcesChannel | undefined
  const initializeResourcesChannel = (): void => {
    resourcesChannel = createTunResourcesChannel(
      {
        write: (frame) => {
          const input = processHandle.child?.stdio.at(7)
          if (!input || !('write' in input)) throw new Error('TUN资源管道不可用。')
          input.write(frame)
        },
        onData: (callback) => {
          resourcesData = callback
        },
        onGone: (callback) => {
          resourcesGone = callback
        },
        onFault: (callback) => {
          resourcesFault = callback
        },
        close: () => {
          processHandle.child?.stdio.at(7)?.destroy()
          processHandle.child?.stdio.at(8)?.destroy()
        }
      },
      {
        ...binding,
        launchClientSHA256: installation.clientSHA256,
        installationRevision: installation.revision
      }
    )
    Object.assign(channel, { resourcesChannel, resourceInbox })
    const output = processHandle.child?.stdio.at(8)
    if (!output || resourcesPipeFailed) resourcesFault()
    else output.on('data', (bytes: Buffer) => resourcesData(bytes))
  }
  let providersData = (_bytes: Buffer): void => {},
    providersGone = (): void => {},
    providersFault = (): void => {},
    providersPipeFailed = false,
    ruleProvidersChannel: TunRuleProvidersChannel | undefined
  const initializeProvidersChannel = (): void => {
    ruleProvidersChannel = createTunRuleProvidersChannel(
      {
        write: (frame) => {
          const input = processHandle.child?.stdio.at(9)
          if (!input || !('write' in input)) throw new Error('TUN规则提供者管道不可用。')
          input.write(frame)
        },
        onData: (callback) => {
          providersData = callback
        },
        onGone: (callback) => {
          providersGone = callback
        },
        onFault: (callback) => {
          providersFault = callback
        },
        close: () => {
          processHandle.child?.stdio.at(9)?.destroy()
          processHandle.child?.stdio.at(10)?.destroy()
        }
      },
      {
        ...binding,
        launchClientSHA256: installation.clientSHA256,
        installationRevision: installation.revision
      }
    )
    Object.assign(channel, { ruleProvidersChannel, resourceInbox })
    const output = processHandle.child?.stdio.at(10)
    if (!output || providersPipeFailed) providersFault()
    else output.on('data', (bytes: Buffer) => providersData(bytes))
  }
  const recovered = async (): Promise<boolean> => {
    if (!exited || exitCode !== 0) return false
    const bytes = await readBinaryResource(join(staged.directory, 'recovery.json'), true)
    const raw = parseTunHostFrame(bytes)
    if (
      !object(raw) ||
      Object.keys(raw).sort().join(',') !==
        'baseline,evidenceSHA256,ownedRecoveryRetained,runtimeConfigurationSHA256,sessionId,status,version' ||
      raw.version !== 1 ||
      raw.status !== 'restored' ||
      raw.ownedRecoveryRetained !== false ||
      raw.sessionId !== binding.sessionId ||
      raw.evidenceSHA256 !== binding.evidenceSHA256 ||
      raw.runtimeConfigurationSHA256 !== binding.runtimeConfigurationSHA256 ||
      !object(raw.baseline) ||
      raw.baseline.networkSHA256 !== baseline.networkSHA256 ||
      raw.baseline.protectionSHA256 !== baseline.protectionSHA256
    )
      throw new Error('本次故障恢复记录不完整或身份不符。')
    const now = await (adapters.inspect ?? inspectTunNative)(installation)
    if (JSON.stringify(now.baseline) !== JSON.stringify(baseline))
      throw new Error('故障恢复后环境又有变化；未覆盖或丢弃恢复记录。')
    await staged.acceptRecovery(bytes)
    return true
  }
  for (const action of ['inspect', 'stopCore', 'release', 'verifyRestored'] as const) {
    const original = channel[action].bind(channel)
    channel[action] = async (): Promise<TunHostObservation> => {
      if (action !== 'inspect') smartToolsChannel?.invalidate()
      try {
        if (exited && (await recovered()))
          return {
            version: 1,
            ...binding,
            phase:
              action === 'stopCore'
                ? 'coreStopped'
                : action === 'release'
                  ? 'released'
                  : 'restored',
            core: 'stopped',
            device: 'absent',
            network: 'restored'
          }
        const observation = await original()
        if (action !== 'inspect' && observation.phase === 'unknown')
          recoveryFailure(`channel.${action}.unknown`)
        return observation
      } catch (error) {
        if (action !== 'inspect') recoveryFailure(`channel.${action}.rejected`)
        throw error
      }
    }
  }
  const revoke = channel.revokeActivation.bind(channel)
  channel.revokeActivation = async () => {
    smartToolsChannel?.invalidate()
    if (exited && (await recovered())) return
    await revoke()
  }
  const dispose = channel.dispose.bind(channel),
    disposeReleased = channel.disposeReleased?.bind(channel)
  const closeTransport = async (resourcesOnly = false): Promise<void> => {
    smartToolsChannel?.invalidate()
    let stage = 'channel'
    try {
      const retained = await resourceInbox?.dispose()
      if (ruleProvidersChannel) {
        await ruleProvidersChannel.cancel()
        await ruleProvidersChannel.whenIdle()
      }
      if (resourcesChannel) {
        await resourcesChannel.cancel()
        await resourcesChannel.whenIdle()
      }
      for (const record of retained?.retained ?? []) {
        const discarded =
          'selector' in record.ticket
            ? await resourcesChannel?.discardBlob(record.ticket)
            : await ruleProvidersChannel?.discardBlob(record.ticket)
        if (discarded === 'discarded' || discarded === 'absent')
          resourceInbox?.acknowledgeDiscard(record.ticket)
      }
      ruleProvidersChannel?.invalidate()
      resourcesChannel?.invalidate()
      if (resourceInbox?.retained().retained.length)
        await nativeLogger
          .warn(`session=${binding.sessionId} resource-inbox=retained`)
          .catch(() => {})
      // A rule mutation has its own finite delegation. Revoke and await only
      // that flight before closing the lifecycle capability or staged bundle.
      if (rulesChannel) {
        await rulesChannel.cancel()
        await rulesChannel.whenIdle()
        rulesChannel.invalidate()
      }
      const stateSaved = resourcesOnly
        ? false
        : execution?.smartState
          ? await saveSmartState()
          : true
      if (resourcesOnly) {
        if (!disposeReleased) throw new Error('本次宿主不支持仅释放自有资源。')
        await disposeReleased()
      } else if (!(exited && (await recovered().catch(() => false)))) await dispose()
      stage = 'staging'
      if (stateSaved && (!execution?.smartState || channel.smartStateDisposition() === 'removed')) {
        if (execution?.smartState) {
          // Native disposal and owned process exit are already acknowledged.
          // Retained Main filesystem evidence cannot recreate a system lease.
          await staged.cleanup().catch(async () => {
            await nativeLogger
              .warn(`session=${binding.sessionId} smart-state-staging=retained`)
              .catch(() => {})
          })
        } else await staged.cleanup()
      }
    } catch (error) {
      recoveryFailure(`dispose.${stage}.rejected`)
      throw error
    } finally {
      stateOwnerLive = false
      smartStateChannel?.invalidate()
      await staged.smartState?.close()
      // Flush fixed codes even on failed disposal; logging cannot take away
      // the retained recovery capability or replace the original failure.
      await diagnosticsWritten.catch(() => {})
    }
  }
  channel.dispose = () => closeTransport()
  if (disposeReleased) channel.disposeReleased = () => closeTransport(true)
  register(channel)
  const launchArgument = execution
    ? canSmartTools
      ? '--managed-session-execution-v2-smart-tools-v1'
      : '--managed-session-execution-v2'
    : canProviders
      ? '--managed-session-runtime-rule-providers-v1'
      : canResources
        ? '--managed-session-runtime-resources-v1'
        : canRules
          ? '--managed-session-runtime-rules-v1'
          : canCapture
            ? '--managed-session-runtime-capture-v1'
            : installation.execution
              ? '--managed-session'
              : '--tun-session'
  // Only the three complete managed capability combinations can use v2.
  // A new binary hash alone never silently upgrades a legacy capture launch.
  const pipeCount =
    canSmartTools || canProviders
      ? 11
      : execution?.smartState || canResources
        ? 9
        : canRules
          ? 7
          : canCapture
            ? 5
            : 3
  const stdio: ('pipe' | 'ignore')[] = Array(pipeCount).fill('pipe')
  if (canProxyGroups) {
    while (stdio.length < 11) stdio.push('ignore')
    stdio.push('pipe', 'pipe')
  }
  const child = (adapters.spawn ?? spawn)(
    installation.execution ? managedRoot + '/RelayTunClient' : client,
    [
      canHistory
        ? `${launchArgument}-runtime-history-v3`
        : canTelemetry
          ? `${launchArgument}-runtime-telemetry-v2`
          : launchArgument,
      ...(canProxyGroups ? ['--proxy-groups-v1'] : [])
    ],
    {
      stdio,
      windowsHide: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
    }
  )
  processHandle.child = child
  if (canProxyGroups) {
    const input = child.stdio.at(11),
      output = child.stdio.at(12)
    if (input && 'write' in input && output && 'read' in output)
      Object.assign(channel, {
        proxyGroups: createProxyGroupChannel(
          input,
          output,
          binding,
          installation.clientSHA256,
          installation.revision
        )
      })
  }
  if (canSmartTools) {
    const input = child.stdio.at(9),
      output = child.stdio.at(10)
    if (!input || !output || !('write' in input)) smartToolsPipeFailed = true
    else {
      const failed = (): void => {
        smartToolsPipeFailed = true
        smartToolsFault()
      }
      input.on('error', failed)
      output.on('error', failed)
      output.on('end', () => {
        smartToolsPipeFailed = true
        smartToolsGone()
      })
      child.on('close', () => {
        smartToolsPipeFailed = true
        smartToolsGone()
      })
    }
  }
  if (execution?.smartState) {
    const input = child.stdio.at(7),
      output = child.stdio.at(8)
    if (!input || !output || !('write' in input)) statePipeFailed = true
    else {
      const failed = (): void => {
        statePipeFailed = true
        stateFault()
      }
      input.on('error', failed)
      output.on('end', () => {
        statePipeFailed = true
        stateGone()
      })
      output.on('error', failed)
      child.on('close', () => {
        statePipeFailed = true
        stateGone()
      })
    }
  }
  if (canCapture) {
    const input = child.stdio[3],
      output = child.stdio[4]
    if (!input || !output || !('write' in input)) runtimePipeFailed = true
    else {
      const failed = (): void => {
        runtimePipeFailed = true
        runtimeFault()
      }
      input.on('error', failed)
      output.on('end', () => {
        runtimePipeFailed = true
        runtimeGone()
      })
      output.on('error', failed)
      child.on('close', runtimeGone)
    }
  }
  if (canRules) {
    const input = child.stdio.at(5),
      output = child.stdio.at(6)
    if (!input || !output || !('write' in input)) rulesPipeFailed = true
    else {
      const failed = (): void => {
        rulesPipeFailed = true
        rulesFault()
      }
      input.on('error', failed)
      output.on('end', () => {
        rulesPipeFailed = true
        rulesGone()
      })
      output.on('error', failed)
      child.on('close', () => {
        rulesPipeFailed = true
        rulesGone()
      })
    }
  }
  if (canResources) {
    const input = child.stdio.at(7),
      output = child.stdio.at(8)
    if (!input || !output || !('write' in input)) resourcesPipeFailed = true
    else {
      const failed = (): void => {
        resourcesPipeFailed = true
        resourcesFault()
      }
      input.on('error', failed)
      output.on('end', () => {
        resourcesPipeFailed = true
        resourcesGone()
      })
      output.on('error', failed)
      child.on('close', () => {
        resourcesPipeFailed = true
        resourcesGone()
      })
    }
  }
  if (canProviders) {
    const input = child.stdio.at(9),
      output = child.stdio.at(10)
    if (!input || !output || !('write' in input)) providersPipeFailed = true
    else {
      const failed = (): void => {
        providersPipeFailed = true
        providersFault()
      }
      input.on('error', failed)
      output.on('end', () => {
        providersPipeFailed = true
        providersGone()
      })
      output.on('error', failed)
      child.on('close', () => {
        providersPipeFailed = true
        providersGone()
      })
    }
  }
  child.stderr?.on(
    'data',
    createTunStartDiagnostics((code) => {
      // Reuse the application's persistent, bounded logger. Raw stderr and
      // private configuration never enter it; the session binds the evidence.
      diagnosticsWritten = diagnosticsWritten
        .then(() => nativeLogger.warn(`session=${binding.sessionId} start-failure=${code}`))
        .catch(() => {})
    }, recoveryFailure)
  )
  child.stdout?.on('data', (bytes: Buffer) => data(bytes))
  child.on('close', (code) => {
    exited = true
    exitCode = code
    gone()
  })
  child.on('error', fault)
  child.stdin?.on('error', fault)
  child.stdout?.on('error', fault)
  const bootstrap = {
    version: runtime.version,
    action: 'bootstrap',
    controlLossPolicy: 'restore-owned-session',
    binding,
    configurationSHA256: runtime.sourceConfigurationSHA256,
    bundleSHA256: runtime.preparation.bundleSHA256,
    configurationPath: 'config.json',
    directory: staged.directory,
    ...(canResources && resourceInbox ? { resourceInboxRoot: resourceInbox.directory } : {}),
    ...(projected
      ? { projection: projected.projection, managedMTU: projected.managedMTU }
      : { installationRevision: installation.revision }),
    assets: staged.assets,
    pins: launch.pins,
    baseline
  }
  const frame = JSON.stringify(bootstrap) + '\n'
  if (Buffer.byteLength(frame) > 262144) throw new Error('TUN启动元数据超过256KiB。')
  child.stdin?.write(executionBootstrap ?? frame)
  for (const value of queued.splice(0)) child.stdin?.write(value)
  if ((await channel.ready).phase !== 'idle') throw new Error('原生TUN准备未通过；已保留恢复通道。')
  // Bootstrap may verify large pinned cores/assets. Buffer the one hello in the
  // paused pipe; its independent read deadline starts only after control ready.
  if (canCapture) initializeRuntimeReader()
  if (canRules) initializeRulesChannel()
  if (canResources) initializeResourcesChannel()
  if (canProviders) initializeProvidersChannel()
  if (execution?.smartState) initializeSmartStateChannel()
  if (canSmartTools) initializeSmartToolsChannel()
  return channel
}
