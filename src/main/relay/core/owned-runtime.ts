import { isIP } from 'net'
import type { Stats } from 'fs'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'fs/promises'
import { request } from 'http'
import { dirname, join } from 'path'
import { setTimeout as delay } from 'timers/promises'
import { isPrivateIp, isForbiddenHost } from '../../resolve/plugin/net-guard'
import { probeMaxNodes, probeLatencyTargets } from '../../../shared/relay/isolated-probes'
import { SubscriptionFiles } from '../subscriptions/private-files'
import type { RelayStateContext } from '../context'
import {
  coreSmartWeights,
  smartToolsDefinition,
  SMART_TOOLS_PAYLOAD_BYTES,
  SMART_TOOLS_VERSION,
  type SmartToolsDefinition,
  type SmartWeightsSnapshot
} from '../../../shared/relay/smart-tools'
import { validateCoreMode, type RelayCoreMode } from '../../../shared/relay/core'
import { compileProfileResolution } from '../profiles/resolution'
import { compileProfileRuntime } from '../profiles/runtime'
import { healthURL, SMART_MODEL_CONTROLS } from '../profiles/groups'
import {
  resourceCheckDefinition,
  checkResourceJob,
  type ResourceValidationJob
} from '../resources/check-definition'
import { readBinaryResource, resourceHash } from '../resources/source'
import type { DedicatedListenerSummary } from '../../../shared/relay/dedicated-listeners'
import { snifferSettings } from '../../../shared/relay/configuration-edit'
import { localCoreLogLevel } from '../../../shared/relay/local-proxy'
import type { RuntimeLogSnapshot } from '../../../shared/relay/observability'
import type { RuntimeAsset } from '../configuration/bindings'
import {
  enabledLocalProxyPorts,
  localProxyHTTPPort,
  localProxyPorts,
  localProxyPortsCompatible,
  localProxyPortsMatch,
  validateDedicatedPortConflicts,
  type LocalProxyPorts
} from '../../../shared/relay/local-proxy-ports'
import {
  writeProbeOwner,
  registerHeldProbeWorkspace,
  inspectProbeWorkspaces,
  type ProbeOwnerRecord
} from './probe-owners'
import { coreEnvironment, isolatedCoreConfiguration } from './configuration'
import { controlledListeners, validateDedicatedRoute } from './dedicated-listeners'
import { assertDedicatedPinnedNodeUnchanged } from './dedicated-pinned-node'
import { probeLocalPort, probeLocalUdpPort, ownsHttpListener, ownsUdpListener } from './port'
import { localProxyInheritedOptions } from './local-proxy-options'
import {
  localProxyGeography,
  localProxyGeoControls,
  compatibleLocalProxyGeoAssets,
  validateLocalProxyGeoAssets
} from './local-proxy-geo'
import { verifyCoreResource } from './resources'
import { stopOwnedChild } from './shutdown'
import {
  createOwnedTrafficReader,
  assertOwnedTrafficSocket,
  type OwnedTrafficSample
} from './owned-traffic'
import { createCoreLogBuffer } from './log-buffer'
import {
  checkSmartConfiguration,
  stageSmartRuntimeModel,
  verifySmartRuntimeModel
} from './smart-runtime'
import type { TrustedSmartModel } from './smart-models'
import {
  SmartLearningRuntime,
  type SmartLearningContext,
  type SmartLearningBinding,
  type SmartLearningStopResult
} from './smart-state-runtime'

const exec = promisify(execFile)
export interface OwnedCoreRequestGuards {
  assertLive(): void
  // A dispatch attempt, not proof that bytes reached or changed the core.
  submitted?(): void
}
export interface OwnedCoreTrafficGuards extends OwnedCoreRequestGuards {
  readonly instanceId: string
  readonly configurationRevision: string
  readonly signal: AbortSignal
}
export interface OwnedCoreProfileOwner {
  readonly profileUUID: string
  assertLive(): void
  mayPersist(): boolean
}
export type OwnedCoreCleanupRegistration = (
  stop: () => Promise<void>,
  stateResult?: () => SmartLearningStopResult | undefined
) => void
export interface RelayOwnedCore {
  readonly pid: number
  readonly version: string
  readonly directory: string
  readonly socket: string
  readonly smartStateBinding?: Readonly<SmartLearningBinding>
  smartStateStopResult?(): SmartLearningStopResult | undefined
  state(): 'running' | 'stopping' | 'stopped' | 'unexpectedExit'
  read(
    endpoint:
      | 'version'
      | 'configs'
      | 'proxies'
      | 'providers/rules'
      | 'providers/proxies'
      | 'rules'
      | 'connections',
    guards?: OwnedCoreRequestGuards
  ): Promise<Record<string, unknown>>
  readTraffic?(guards: OwnedCoreTrafficGuards): Promise<OwnedTrafficSample>
  smartToolsDefinition?(): SmartToolsDefinition
  smartWeights?(guards: OwnedCoreRequestGuards): Promise<SmartWeightsSnapshot>
  clearSmartCache?(guards: OwnedCoreRequestGuards): Promise<void>
  group(name: string): Promise<Record<string, unknown>>
  select(group: string, member: string): Promise<void>
  automatic?(group: string): Promise<void>
  patchMode?(mode: RelayCoreMode): Promise<void>
  patchRule?(index: number, disabled: boolean, guards: OwnedCoreRequestGuards): Promise<void>
  reload?(
    configuration: string,
    expectedSHA256: string,
    profileUUID?: string,
    runtimeAssets?: readonly RuntimeAsset[]
  ): Promise<{ evidenceId: string; runtimeSHA256: string }>
  testDelay?(member: string, url: string, timeout: number, expected?: string): Promise<number>
  closeConnection?(id: string): Promise<void>
  closeAllConnections?(): Promise<void>
  logs?(): readonly string[]
  logSnapshot?(): RuntimeLogSnapshot
  openWorkDirectory?(open: (path: string) => Promise<void>, assertLive: () => void): Promise<void>
  stop(): Promise<void>
}
// Shared owned-child lifecycle. Callers supply only compiler-generated JSON;
// live traffic has a polite-only stop and never gets the inert SIGKILL fallback.
export function ownedCoreConfiguration(
  configuration: string,
  kind: 'inert' | 'localProxy',
  validation?: ResourceValidationJob,
  probeHosts?: Readonly<Record<string, string>>,
  runtimeAssets: readonly RuntimeAsset[] = []
): {
  parsed: Record<string, unknown>
  port: number
  ports?: LocalProxyPorts
  validationDefinition?: ReturnType<typeof resourceCheckDefinition>
  dedicated?: DedicatedListenerSummary
  runtimeAssets: readonly RuntimeAsset[]
} {
  if (kind !== 'inert' && kind !== 'localProxy') throw new Error('核心实例类型无效。')
  const input: unknown = JSON.parse(configuration)
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Buffer.byteLength(configuration) > 2 * 1024 * 1024
  )
    throw new Error('核心配置无效。')
  const parsed = input as Record<string, unknown>,
    mode = validateCoreMode(parsed.mode)
  if (validation) {
    if (kind !== 'inert') throw new Error('资源检查不承载代理流量。')
    checkResourceJob(validation)
  }
  const validationDefinition = validation
    ? resourceCheckDefinition(validation.descriptor)
    : undefined
  let dedicated: DedicatedListenerSummary | undefined
  const baseline = validationDefinition?.configuration ?? isolatedCoreConfiguration(mode)
  if (runtimeAssets.length && (kind !== 'localProxy' || validation || probeHosts !== undefined))
    throw new Error('地理数据库仅用于普通 HTTP 自有核心。')
  let pinnedHosts: Record<string, string> | undefined
  if (probeHosts !== undefined) {
    if (
      kind !== 'localProxy' ||
      validation ||
      !probeHosts ||
      typeof probeHosts !== 'object' ||
      Array.isArray(probeHosts) ||
      Object.keys(probeHosts).length > probeMaxNodes + probeLatencyTargets.length
    )
      throw new Error('独立探测域名固定表无效。')
    pinnedHosts = {}
    if (
      parsed.mode !== 'rule' ||
      JSON.stringify(parsed.dns) !== JSON.stringify(baseline.dns) ||
      JSON.stringify(parsed.tun) !== JSON.stringify(baseline.tun) ||
      JSON.stringify(parsed.ntp) !== JSON.stringify(baseline.ntp) ||
      JSON.stringify(parsed.sniffer) !== JSON.stringify(baseline.sniffer) ||
      JSON.stringify(parsed.profile) !== JSON.stringify(baseline.profile) ||
      !Array.isArray(parsed['proxy-groups']) ||
      parsed['proxy-groups'].length !== 1 ||
      parsed['proxy-groups'][0]?.name !== '__RELAY_ISOLATED_PROBE__' ||
      parsed['proxy-groups'][0]?.type !== 'select' ||
      !Array.isArray(parsed['proxy-groups'][0]?.proxies) ||
      parsed['proxy-groups'][0].proxies.length < 1 ||
      parsed['proxy-groups'][0].proxies.length > probeMaxNodes ||
      Object.keys(parsed['proxy-groups'][0]).sort().join(',') !== 'name,proxies,type' ||
      JSON.stringify(parsed.rules) !== JSON.stringify(['MATCH,__RELAY_ISOLATED_PROBE__']) ||
      JSON.stringify(parsed['proxy-providers']) !== '{}' ||
      JSON.stringify(parsed['rule-providers']) !== '{}' ||
      JSON.stringify(parsed.listeners) !== '[]'
    )
      throw new Error('独立探测只允许专用静态选择组，不能启动DNS、TUN、自动组、提供者或持久学习。')
    if (
      !Array.isArray(parsed.proxies) ||
      parsed.proxies.length > probeMaxNodes ||
      parsed.proxies.some(
        (node) =>
          !node ||
          typeof node !== 'object' ||
          ![
            'ss',
            'ssr',
            'vmess',
            'vless',
            'trojan',
            'socks5',
            'http',
            'snell',
            'hysteria',
            'hysteria2',
            'tuic',
            'anytls',
            'mieru'
          ].includes(node.type) ||
          typeof node.server !== 'string' ||
          isForbiddenHost(node.server)
      )
    )
      throw new Error('独立探测出站协议或端点不受支持。')
    const probeNodes = parsed.proxies as Record<string, unknown>[]
    const probeGroups = parsed['proxy-groups'] as { proxies: unknown[] }[]
    const delayOnly = probeGroups[0].proxies.length === 1 && probeGroups[0].proxies[0] === 'REJECT'
    if ('unified-delay' in parsed) {
      if (!delayOnly || typeof parsed['unified-delay'] !== 'boolean')
        throw new Error('独立延迟测试设置无效。')
      baseline['unified-delay'] = parsed['unified-delay']
    }
    if (
      probeNodes.some((node) => node.name === '__RELAY_ISOLATED_PROBE__') ||
      probeGroups[0].proxies.some(
        (name) =>
          typeof name !== 'string' || (!delayOnly && !probeNodes.some((node) => node.name === name))
      )
    )
      throw new Error('独立探测静态选择范围无效。')
    for (const [host, ip] of Object.entries(probeHosts).sort(([a], [b]) => a.localeCompare(b))) {
      if (
        host.length > 253 ||
        !host ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) ||
        host.includes('..') ||
        isForbiddenHost(host) ||
        isIP(host) ||
        typeof ip !== 'string' ||
        !isIP(ip) ||
        isPrivateIp(ip)
      )
        throw new Error('独立探测只允许规范域名与已固定公网IP。')
      pinnedHosts[host] = ip
    }
    const requiredHosts = pinnedHosts
    if (
      Object.keys(requiredHosts).length &&
      parsed.proxies.some(
        (node) => !isIP(node.server) && !Object.hasOwn(requiredHosts, node.server)
      )
    )
      throw new Error('独立探测节点域名缺少已固定地址。')
  }

  if (
    Array.isArray(parsed['proxy-groups']) &&
    parsed['proxy-groups'].some((group) => group?.type === 'smart')
  )
    Object.assign(baseline, SMART_MODEL_CONTROLS)
  // HTTP inherits only validated settings from the source. Inert checks and
  // pinned isolated probes retain their original fixed configuration boundary.
  if (kind === 'localProxy' && probeHosts === undefined)
    Object.assign(baseline, localProxyInheritedOptions(parsed))
  if (runtimeAssets.length) Object.assign(baseline, localProxyGeoControls)
  const variable =
    kind === 'inert'
      ? new Set<string>()
      : new Set([
          'port',
          ...(probeHosts === undefined ? ['socks-port', 'mixed-port', 'redir-port'] : []),
          'proxies',
          'proxy-groups',
          'proxy-providers',
          'rule-providers',
          'rules',
          'dns',
          'hosts',
          'ipv6',
          'listeners',
          'sniffer',
          'log-level'
        ])
  if (
    Object.keys(parsed).sort().join(',') !== Object.keys(baseline).sort().join(',') ||
    Object.keys(baseline).some(
      (key) => !variable.has(key) && JSON.stringify(parsed[key]) !== JSON.stringify(baseline[key])
    )
  )
    throw new Error('受控核心配置边界不符。')
  if (kind === 'localProxy') {
    snifferSettings(parsed.sniffer)
    const geography = localProxyGeography(parsed, runtimeAssets)
    validateLocalProxyGeoAssets(parsed, runtimeAssets)
    if (!compileProfileRuntime(configuration, geography).configuration)
      throw new Error('节点或动态组受控边界不符。')
    const dns = parsed.dns as Record<string, unknown> | undefined
    if (dns?.enable === true) {
      const targets = new Set(['DIRECT'])
      for (const key of ['proxies', 'proxy-groups'])
        if (Array.isArray(parsed[key]))
          for (const item of parsed[key])
            if (item && typeof item === 'object' && typeof item.name === 'string')
              targets.add(item.name)
      const checked = compileProfileResolution(parsed, targets, geography)
      if (
        JSON.stringify(checked.dns) !== JSON.stringify(parsed.dns) ||
        JSON.stringify(checked.hosts) !== JSON.stringify(parsed.hosts) ||
        checked.ipv6 !== parsed.ipv6
      )
        throw new Error('受控DNS边界不符。')
    } else if (
      JSON.stringify(parsed.dns) !== JSON.stringify(baseline.dns) ||
      JSON.stringify(parsed.hosts) !== JSON.stringify(pinnedHosts ?? baseline.hosts) ||
      parsed.ipv6 !== false
    )
      throw new Error('未启用DNS时的受控边界不符。')
    // Dedicated listeners: only the exact Relay-owned entries admitted.
    const summary = controlledListeners(parsed.listeners)
    if (summary) {
      validateDedicatedRoute(summary, parsed)
      dedicated = summary
    }
    // The ordinary owned Core may use the explicitly prepared diagnostic level.
    localCoreLogLevel(parsed['log-level'])
  }
  const ports =
    kind === 'localProxy'
      ? localProxyPorts({
          http: parsed.port,
          socks: parsed['socks-port'],
          mixed: parsed['mixed-port'],
          redir: parsed['redir-port']
        })
      : undefined
  if (ports) validateDedicatedPortConflicts(ports, dedicated)
  const port = ports ? localProxyHTTPPort(ports) : 0
  return {
    parsed,
    port,
    ports,
    validationDefinition,
    dedicated,
    runtimeAssets: runtimeAssets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes) }))
  }
}
export async function startOwnedCore(
  resourceRoot: string,
  configuration: string,
  kind: 'inert' | 'localProxy',
  registerCleanup?: OwnedCoreCleanupRegistration,
  validation?: ResourceValidationJob,
  launchGuard?: () => void,
  learningContext?: SmartLearningContext,
  probeWorkspace?: {
    context: RelayStateContext
    purpose: 'isolated-probe-v1' | 'isolated-substore-v1'
    hosts: Readonly<Record<string, string>>
  },
  runtimeAssets: readonly RuntimeAsset[] = []
): Promise<RelayOwnedCore> {
  const admitted = ownedCoreConfiguration(
    configuration,
    kind,
    validation,
    probeWorkspace?.hosts,
    runtimeAssets
  )
  if (
    probeWorkspace &&
    !Object.keys(probeWorkspace.hosts).length &&
    (!Array.isArray(admitted.parsed.proxies) ||
      admitted.parsed.proxies.some((node) => !isIP(node.server)))
  )
    throw new Error('独立出站启动前须固定经校验的公网解析结果。')
  let parsed = admitted.parsed,
    runtimeConfiguration = configuration,
    reloadPending = false,
    reloadUncertain = false
  const { ports, validationDefinition } = admitted
  const ordinaryPorts = ports ? enabledLocalProxyPorts(ports) : []
  const ordinaryUdpPorts = ports ? [ports.socks, ports.mixed].filter(Boolean) : []
  const ownsOrdinaryListeners = async (pid: number): Promise<boolean> =>
    (
      await Promise.all([
        ...ordinaryPorts.map((value) => ownsHttpListener(pid, value)),
        ...ordinaryUdpPorts.map((value) => ownsUdpListener(pid, value))
      ])
    ).every(Boolean)
  const dedicated = admitted.dedicated
  const geoAssets = [...admitted.runtimeAssets]
  const resource = await verifyCoreResource(resourceRoot)
  if (geoAssets.length && resource.capability !== 'local-geodata-v1')
    throw new Error('地理规则需要已配套的本地数据库核心；未自动切换所选核心或下载资源。')
  launchGuard?.()
  const learningRequested =
    kind === 'localProxy' && !!learningContext && checkSmartConfiguration(resource, configuration)
  if (learningRequested && resource.version !== 'alpha-smart-4624551')
    throw new Error('当前Smart学习状态只接入固定4624551核心。')
  let learning: SmartLearningRuntime | undefined,
    learningPreparation: Promise<SmartLearningRuntime> | undefined,
    learningReport: SmartLearningStopResult | undefined,
    parserCompletion: Promise<void> | undefined,
    stopping = false,
    stopped = false,
    closeCode: number | null | undefined,
    closedDuringStop = false
  const assertLaunch = (): void => {
    launchGuard?.()
    if (learningRequested) {
      if (stopping || stopped) throw new Error('本次启动已撤销。')
      learning?.assertOwner()
    }
  }
  let stagedSmartModel: TrustedSmartModel | undefined
  let probeParent: { path: string; dev: number; ino: number } | undefined
  let prefix = `/private/tmp/relay-${kind === 'inert' ? 'core' : 'proxy'}-${process.getuid?.() ?? 'user'}-`
  if (probeWorkspace) {
    if (
      !['isolated-probe-v1', 'isolated-substore-v1'].includes(probeWorkspace.purpose) ||
      kind !== 'localProxy' ||
      validation ||
      learningContext
    )
      throw new Error('独立探测工作区能力无效。')
    if ((await inspectProbeWorkspaces(probeWorkspace.context)).status !== 'clear')
      throw new Error('旧临时核心工作区尚未收尾。')
    assertLaunch()
    const files = new SubscriptionFiles(probeWorkspace.context),
      parent = join(probeWorkspace.context.stateRoot, 'Diagnostics/Probe')
    assertLaunch()
    await files.directory(parent, true)
    assertLaunch()
    const info = await lstat(parent)
    if (
      (info.mode & 0o7777) !== 0o700 ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (await realpath(parent)) !== parent
    )
      throw new Error('独立探测目录未通过私有身份检查。')
    probeParent = { path: parent, dev: info.dev, ino: info.ino }
    prefix = join(parent, 'p-')
    if (Buffer.byteLength(prefix + '123456/api.sock') > 103)
      throw new Error('独立探测目录超过本机Unix接口路径预算。')
  }
  const directory = await realpath(await mkdtemp(prefix))
  const owned = await lstat(directory)
  if (probeParent) {
    const parent = await lstat(probeParent.path)
    if (
      dirname(directory) !== probeParent.path ||
      parent.dev !== probeParent.dev ||
      parent.ino !== probeParent.ino ||
      (parent.mode & 0o7777) !== 0o700 ||
      (await realpath(probeParent.path)) !== probeParent.path
    )
      throw new Error('独立探测父目录在创建期间变化。')
  }
  const socket = join(directory, 'api.sock'),
    config = join(directory, 'config.yaml')
  const assertDirectoryIdentity = (now: typeof owned): void => {
    if (
      !now.isDirectory() ||
      now.isSymbolicLink() ||
      now.dev !== owned.dev ||
      now.ino !== owned.ino ||
      now.uid !== process.getuid?.() ||
      (now.mode & 0o7777) !== 0o700
    )
      throw new Error('隔离核心目录发生改变，未继续操作。')
  }
  const checkDirectory = async (assertLive?: () => void): Promise<void> => {
    assertLive?.()
    if (probeParent) {
      const parent = await lstat(probeParent.path)
      assertLive?.()
      if (
        parent.dev !== probeParent.dev ||
        parent.ino !== probeParent.ino ||
        (parent.mode & 0o7777) !== 0o700 ||
        (await realpath(probeParent.path)) !== probeParent.path
      )
        throw new Error('独立探测父目录已变化。')
    }
    const now = await lstat(directory)
    assertLive?.()
    assertDirectoryIdentity(now)
    const path = await realpath(directory)
    assertLive?.()
    if (path !== directory) throw new Error('隔离核心目录发生改变，未继续操作。')
  }
  const verifyGeoAssets = async (): Promise<void> => {
    for (const asset of geoAssets) {
      const copied = await readBinaryResource(join(directory, asset.path), true)
      if (resourceHash(copied) !== asset.sha256) throw new Error('自有地理数据库已变化。')
    }
  }
  let releaseProbeWorkspace: (() => void) | undefined
  const cleanup = async (): Promise<void> => {
    try {
      await checkDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        releaseProbeWorkspace?.()
        return
      }
      throw error
    }
    await rm(directory, { recursive: true })
    releaseProbeWorkspace?.()
  }
  let probeOwner: ProbeOwnerRecord | undefined
  let child: ReturnType<typeof spawn> | undefined,
    closed = false,
    launchFailed = false
  let closePromise: Promise<void> | undefined, stoppingPromise: Promise<void> | undefined
  const logBuffer = createCoreLogBuffer()
  const logs = (): readonly string[] => logBuffer.snapshot()
  let trafficReader: ReturnType<typeof createOwnedTrafficReader> | undefined
  const stop = (): Promise<void> => {
    if (stoppingPromise) return stoppingPromise
    stopping = true
    // Independent read lane: close only our stats socket; never wait for server EOF.
    trafficReader?.cancel()
    stoppingPromise = (async () => {
      if (learningRequested && learningPreparation) {
        try {
          learning ??= await learningPreparation
        } catch {
          // Failed preparation closes its own FDs. Keep its physical evidence.
        }
      }
      if (learningRequested && parserCompletion) await parserCompletion
      if (child && !closed && closePromise) {
        await stopOwnedChild(child, closePromise, kind)
      }
      if (child && closePromise) await closePromise
      if (learningRequested) {
        learningReport = learning
          ? await learning.finish(!!child && closed && closeCode === 0 && closedDuringStop)
          : { status: 'retained', retainedEvidence: true }
      } else await cleanup()
      stopped = true
    })().catch((error) => {
      stoppingPromise = undefined
      throw error
    })
    return stoppingPromise
  }
  const validName = (name: string): boolean =>
    typeof name === 'string' &&
    !!name.trim() &&
    name.length <= 256 &&
    Array.from(name).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
  let socketIdentity: { dev: number; ino: number } | undefined
  const api = async (
    method: 'GET' | 'PUT' | 'DELETE' | 'PATCH' | 'POST',
    path: string,
    body?: string,
    timeout = 1500,
    guards?: OwnedCoreRequestGuards
  ): Promise<Record<string, unknown>> => {
    const smartClear = method === 'POST' && path === '/cache/smart/flush'
    const smartRead = method === 'GET' && path === '/group/weights'
    if (
      (method === 'POST' && !smartClear) ||
      ((smartRead || smartClear) &&
        (kind !== 'localProxy' || resource.version !== SMART_TOOLS_VERSION || !learning))
    )
      throw new Error('当前固定Core未授予Smart工具。')
    const live = (): void => {
      if (closed || stopping || (guards && (reloadPending || reloadUncertain)))
        throw new Error('本次核心已退出、正在结束或配置未确认。')
      guards?.assertLive()
      if (closed || stopping || (guards && (reloadPending || reloadUncertain)))
        throw new Error('本次核心上下文已变化。')
    }
    live()
    await checkDirectory(guards ? live : undefined)
    live()
    const info = await lstat(socket)
    live()
    if (
      !info.isSocket() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (socketIdentity && (info.dev !== socketIdentity.dev || info.ino !== socketIdentity.ino))
    )
      throw new Error('本次私有接口身份不符。')
    socketIdentity ??= { dev: info.dev, ino: info.ino }
    return new Promise((resolve, reject) => {
      let scopeLost = false
      const observeScope = (): void => {
        if (!guards) return
        try {
          live()
        } catch {
          scopeLost = true
        }
      }
      const notifySubmitted = (): void => {
        if ((method === 'PATCH' && path === '/rules/disable') || smartClear) {
          try {
            guards?.submitted?.()
          } catch {
            // The request was already attempted. Drain it before reporting unknown.
            scopeLost = true
          }
        }
      }
      let req: ReturnType<typeof request>
      let attempted = false
      try {
        // No observer or await may run between the final guard and request().
        live()
        attempted = true
        req = request(
          {
            socketPath: socket,
            path,
            method,
            agent: false,
            headers:
              body === undefined
                ? {}
                : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          },
          (response) => {
            observeScope()
            let bytes = 0
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length
              if (
                bytes >
                (smartRead ? SMART_TOOLS_PAYLOAD_BYTES : kind === 'inert' ? 65536 : 2 * 1024 * 1024)
              )
                req.destroy(new Error('response limit'))
              else chunks.push(chunk)
            })
            response.on('error', () => reject(new Error('本次接口响应未确认。')))
            response.on('end', () => {
              try {
                observeScope()
                if (scopeLost) throw new Error()
                if (smartClear && response.statusCode !== 204) throw new Error()
                if (method !== 'GET' && response.statusCode === 204) {
                  resolve({})
                  return
                }
                if (response.statusCode !== 200) throw new Error()
                const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                if (!result || typeof result !== 'object' || Array.isArray(result))
                  throw new Error()
                resolve(result as Record<string, unknown>)
              } catch {
                reject(new Error('本次接口响应格式或状态异常。'))
              }
            })
          }
        )
      } catch {
        if (attempted) notifySubmitted()
        reject(new Error('本次接口未能确认提交或上下文。'))
        return
      }
      const timer = setTimeout(() => req.destroy(new Error('deadline')), timeout)
      req.once('close', () => clearTimeout(timer))
      req.setTimeout(timeout, () => req.destroy(new Error('timeout')))
      req.on('error', () => reject(new Error('本次接口暂不可读取。')))
      try {
        req.end(body)
      } catch {
        req.destroy(new Error('request end failed'))
      }
      notifySubmitted()
    })
  }
  const toolsDefinition = (): SmartToolsDefinition => {
    if (
      kind !== 'localProxy' ||
      resource.version !== SMART_TOOLS_VERSION ||
      !learning ||
      stopping ||
      stopped ||
      closed ||
      reloadPending ||
      reloadUncertain
    )
      throw new Error('当前Smart实例或配置未确认。')
    const raw: unknown = JSON.parse(runtimeConfiguration)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Smart配置无效。')
    const groups = (raw as Record<string, unknown>)['proxy-groups']
    if (!Array.isArray(groups)) throw new Error('Smart组未声明。')
    return smartToolsDefinition({
      configurationRevision: resourceHash(Buffer.from(runtimeConfiguration)),
      groups: groups
        .filter(
          (group): group is Record<string, unknown> =>
            !!group && typeof group === 'object' && !Array.isArray(group) && group.type === 'smart'
        )
        .map((group) => group.name)
    })
  }
  const smartWeights = async (guards: OwnedCoreRequestGuards): Promise<SmartWeightsSnapshot> => {
    guards.assertLive()
    const definition = toolsDefinition()
    const result = coreSmartWeights(
      await api('GET', '/group/weights', undefined, 1500, guards),
      definition
    )
    guards.assertLive()
    if (toolsDefinition().configurationRevision !== definition.configurationRevision)
      throw new Error('Smart配置已变化。')
    return result
  }
  const clearSmartCache = async (guards: OwnedCoreRequestGuards): Promise<void> => {
    guards.assertLive()
    const definition = toolsDefinition()
    await api('POST', '/cache/smart/flush', undefined, 1500, guards)
    guards.assertLive()
    if (toolsDefinition().configurationRevision !== definition.configurationRevision)
      throw new Error('Smart配置已变化。')
  }
  const read = async (
    endpoint:
      | 'version'
      | 'configs'
      | 'proxies'
      | 'providers/rules'
      | 'providers/proxies'
      | 'rules'
      | 'connections',
    guards?: OwnedCoreRequestGuards
  ): Promise<Record<string, unknown>> => {
    if (
      endpoint !== 'version' &&
      endpoint !== 'configs' &&
      endpoint !== 'connections' &&
      !(
        kind === 'localProxy' &&
        ['proxies', 'providers/proxies', 'providers/rules', 'rules'].includes(endpoint)
      ) &&
      !(validationDefinition && endpoint === 'providers/rules')
    )
      throw new Error('不支持本次接口。')
    return api('GET', '/' + endpoint, undefined, 1500, guards)
  }
  const readTraffic = async (guards: OwnedCoreTrafficGuards): Promise<OwnedTrafficSample> => {
    if (kind !== 'localProxy' || !child?.pid || !socketIdentity)
      throw new Error('本次核心未授予普通流量读取。')
    const uid = process.getuid?.(),
      gid = owned.gid
    if (uid === undefined || gid === undefined || uid === 0)
      throw new Error('普通流量读取只支持本次普通用户实例。')
    const pid = child.pid,
      knownSocket = { ...socketIdentity },
      instanceId = guards.instanceId,
      configurationRevision = guards.configurationRevision,
      signal = guards.signal,
      assertOwner = guards.assertLive
    const live = (): void => {
      const current = (): boolean =>
        !!child &&
        child.pid === pid &&
        child.exitCode === null &&
        child.signalCode === null &&
        !closed &&
        !stopping &&
        !stopped &&
        !reloadPending &&
        !reloadUncertain
      if (!current()) throw new Error('本次核心已结束或配置未确认。')
      assertOwner()
      if (!current() || signal.aborted) throw new Error('本次核心流量所有者已变化。')
    }
    let pin: Stats | undefined
    const recheckOwner = async (): Promise<void> => {
      live()
      await checkDirectory(live)
      const parent = await lstat(directory)
      live()
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        parent.dev !== owned.dev ||
        parent.ino !== owned.ino ||
        parent.uid !== owned.uid ||
        parent.gid !== owned.gid ||
        parent.mode !== owned.mode
      )
        throw new Error('本次核心目录归属发生改变。')
      const before = await lstat(socket)
      live()
      assertOwnedTrafficSocket(before, knownSocket, uid, gid, pin)
      pin ??= before
      const [config, version, owns] = await Promise.all([
        read('configs', { assertLive: live }),
        read('version', { assertLive: live }),
        ownsOrdinaryListeners(pid)
      ])
      live()
      if (
        !ports ||
        !localProxyPortsMatch(config, ports) ||
        version.version !== resource.version ||
        !owns
      )
        throw new Error('本次核心或监听身份未确认。')
      const after = await lstat(socket)
      live()
      assertOwnedTrafficSocket(after, knownSocket, uid, gid, before)
    }
    trafficReader ??= createOwnedTrafficReader({
      createRequest: (receive) =>
        request(
          {
            socketPath: socket,
            path: '/traffic',
            method: 'GET',
            agent: false,
            maxHeaderSize: 4096
          },
          receive
        )
    })
    return trafficReader.read({
      instanceId,
      configurationRevision,
      signal,
      assertLive: live,
      recheckOwner
    })
  }
  const closeConnection = async (id: string): Promise<void> => {
    if (kind !== 'localProxy') throw new Error('本次实例不承接普通代理流量。')
    if (!validName(id) || id.length > 256) throw new Error('连接标识无效。')
    await api('DELETE', '/connections/' + encodeURIComponent(id))
  }
  const closeAllConnections = async (): Promise<void> => {
    if (kind !== 'localProxy') throw new Error('本次实例不承接普通代理流量。')
    await api('DELETE', '/connections')
  }
  const group = async (name: string): Promise<Record<string, unknown>> => {
    if (kind !== 'localProxy' || !validName(name)) throw new Error('组名称或实例类型无效。')
    return api('GET', '/proxies/' + encodeURIComponent(name))
  }
  const select = async (name: string, member: string): Promise<void> => {
    if (
      kind !== 'localProxy' ||
      reloadPending ||
      reloadUncertain ||
      !validName(name) ||
      !validName(member)
    )
      throw new Error('组或成员无效。')
    await api('PUT', '/proxies/' + encodeURIComponent(name), JSON.stringify({ name: member }))
  }
  const automatic = async (name: string): Promise<void> => {
    if (kind !== 'localProxy' || reloadPending || reloadUncertain || !validName(name))
      throw new Error('组名称无效。')
    await api('DELETE', '/proxies/' + encodeURIComponent(name))
  }
  const patchMode = async (mode: RelayCoreMode): Promise<void> => {
    if (kind !== 'localProxy' || reloadPending || reloadUncertain)
      throw new Error('本次实例不承接普通代理流量。')
    await api('PATCH', '/configs', JSON.stringify({ mode: validateCoreMode(mode) }))
    parsed.mode = mode
    runtimeConfiguration = JSON.stringify(parsed)
  }
  const patchRule = async (
    index: number,
    disabled: boolean,
    guards: OwnedCoreRequestGuards
  ): Promise<void> => {
    if (
      kind !== 'localProxy' ||
      reloadPending ||
      reloadUncertain ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= 10000 ||
      typeof disabled !== 'boolean' ||
      typeof guards?.assertLive !== 'function'
    )
      throw new Error('本次规则操作或实例类型无效。')
    await api('PATCH', '/rules/disable', JSON.stringify({ [index]: disabled }), 1500, guards)
  }
  const reload = async (
    next: string,
    expectedSHA256: string,
    profileUUID?: string,
    nextAssets: readonly RuntimeAsset[] = []
  ): Promise<{ evidenceId: string; runtimeSHA256: string }> => {
    if (
      kind !== 'localProxy' ||
      validation ||
      reloadPending ||
      reloadUncertain ||
      resourceHash(Buffer.from(runtimeConfiguration)) !== expectedSHA256 ||
      !child?.pid ||
      closed ||
      stopping
    )
      throw new Error('本次热载来源、实例或状态已变化。')
    if (!compatibleLocalProxyGeoAssets(geoAssets, nextAssets))
      throw new Error('地理数据库已变化，请停用当前代理后重新启动；未热载或替换在用文件。')
    const candidate = ownedCoreConfiguration(next, 'localProxy', undefined, undefined, nextAssets)
    if (candidate.runtimeAssets.length && resource.capability !== 'local-geodata-v1')
      throw new Error('地理规则需要已配套的本地数据库核心；当前实例不能热载此配置。')
    learning?.assertReload(profileUUID, candidate.parsed)
    checkSmartConfiguration(resource, next)
    if (!ports || !candidate.ports || !localProxyPortsCompatible(candidate.ports, ports))
      throw new Error('本次热载不能更换在用监听端口。')
    if (
      candidate.dedicated?.httpPort !== dedicated?.httpPort ||
      candidate.dedicated?.socksPort !== dedicated?.socksPort ||
      candidate.dedicated?.route !== dedicated?.route
    )
      throw new Error('本次热载不能更换在用专用监听端口或路由。')
    if (dedicated)
      assertDedicatedPinnedNodeUnchanged(
        JSON.parse(runtimeConfiguration) as Record<string, unknown>,
        candidate.parsed,
        dedicated.route
      )
    reloadPending = true
    const evidenceId = randomUUID(),
      runtimeSHA256 = resourceHash(Buffer.from(next))
    try {
      await checkDirectory()
      await verifyGeoAssets()
      for (const asset of candidate.runtimeAssets) {
        if (geoAssets.some((existing) => existing.path === asset.path)) continue
        await writeFile(join(directory, asset.path), asset.bytes, { flag: 'wx', mode: 0o600 })
        geoAssets.push(asset)
      }
      await checkDirectory()
      await verifyGeoAssets()
      await verifySmartRuntimeModel(directory, stagedSmartModel)
      if (!(await ownsOrdinaryListeners(child.pid))) throw new Error('本次监听归属未确认。')
      const before = await api('GET', '/configs')
      if (!localProxyPortsMatch(before, ports) || before.mode !== parsed.mode)
        throw new Error('热载前状态已变化。')
      // Keep the previous bytes and exact candidate in this owned directory.
      // Never overwrite config.yaml or send an arbitrary path to the API.
      const evidence = JSON.stringify({
        version: 1,
        evidenceId,
        previousSHA256: expectedSHA256,
        runtimeSHA256,
        previous: runtimeConfiguration,
        candidate: next
      })
      const path = join(directory, 'reload-' + evidenceId + '.json')
      if (learning)
        await learning.writeImmutable('reload-' + evidenceId + '.json', Buffer.from(evidence))
      else {
        const record = await open(path, 'wx', 0o600)
        try {
          await record.writeFile(evidence)
          await record.sync()
        } finally {
          await record.close()
        }
      }
      if (
        (await readBinaryResource(path, true)).toString('utf8') !== evidence ||
        stopped ||
        stopping ||
        closed
      )
        throw new Error('热载证据写入未确认。')
      // The fixed core parses before ApplyConfig. force=false keeps compatible
      // listeners; no restart endpoint, process launch or stop fallback exists.
      reloadUncertain = true
      await verifyGeoAssets()
      await api('PUT', '/configs?force=false', JSON.stringify({ payload: next }), 10000)
      const after = await api('GET', '/configs')
      if (
        !localProxyPortsMatch(after, ports) ||
        after.mode !== candidate.parsed.mode ||
        !child?.pid ||
        !(await ownsOrdinaryListeners(child.pid)) ||
        (candidate.dedicated?.httpPort &&
          !(await ownsHttpListener(child.pid, candidate.dedicated.httpPort))) ||
        (candidate.dedicated?.socksPort &&
          !(await ownsHttpListener(child.pid, candidate.dedicated.socksPort)))
      )
        throw new Error('热载后状态未确认。')
      parsed = candidate.parsed
      runtimeConfiguration = next
      reloadUncertain = false
      return { evidenceId, runtimeSHA256 }
    } catch {
      throw new Error('热载未确认，原配置与候选证据保留；没有自动回滚、停止或重启核心。')
    } finally {
      reloadPending = false
    }
  }
  const testDelay = async (
    name: string,
    url: string,
    timeout: number,
    expected = ''
  ): Promise<number> => {
    if (
      kind !== 'localProxy' ||
      reloadUncertain ||
      reloadPending ||
      !validName(name) ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 30000
    )
      throw new Error('测速参数无效。')
    if (typeof expected !== 'string' || expected.length > 4096 || /[^0-9,/*\s-]/u.test(expected))
      throw new Error('测速状态范围无效。')
    const query = new URLSearchParams({ url: healthURL(url), timeout: String(timeout), expected })
    const providers = parsed['proxy-providers'] as Record<string, { payload: { name: string }[] }>
    const provider = Object.keys(providers).find((p) =>
      providers[p].payload.some((n) => n.name === name)
    )
    const path = provider
      ? '/providers/proxies/' +
        encodeURIComponent(provider) +
        '/' +
        encodeURIComponent(name) +
        '/healthcheck'
      : '/proxies/' + encodeURIComponent(name) + '/delay'
    const result = await api('GET', path + '?' + query, undefined, timeout + 1500)
    if (
      typeof result.delay !== 'number' ||
      !Number.isInteger(result.delay) ||
      result.delay <= 0 ||
      result.delay > 65535
    )
      throw new Error('测速结果无效。')
    return result.delay
  }

  try {
    if (learningRequested) registerCleanup?.(stop, () => learningReport)
    else registerCleanup?.(stop)
    if (probeWorkspace) {
      const identity = await lstat(directory, { bigint: true })
      releaseProbeWorkspace = registerHeldProbeWorkspace(
        directory,
        String(identity.dev),
        String(identity.ino)
      )
      probeOwner = {
        version: 1,
        purpose: probeWorkspace.purpose,
        phase: 'preparing',
        pid: null,
        birth: null,
        createdAt: Date.now(),
        directory: { dev: String(identity.dev), ino: String(identity.ino) },
        resource: { sha256: resource.sha256, executable: resource.executable },
        configurationSHA256: resourceHash(Buffer.from(configuration))
      }
      await writeProbeOwner(directory, probeOwner)
      assertLaunch()
    }
    if (learningRequested && learningContext) {
      assertLaunch()
      learningPreparation = SmartLearningRuntime.prepare(directory, parsed, learningContext)
      learning = await learningPreparation
    }
    assertLaunch()
    await checkDirectory(learningRequested ? assertLaunch : launchGuard)
    if (Buffer.byteLength(socket) >= 100) throw new Error('隔离socket路径过长。')
    if (validation && validationDefinition) {
      checkResourceJob(validation)
      await writeFile(join(directory, validationDefinition.filename), validation.bytes, {
        flag: 'wx',
        mode: 0o600
      })
      assertLaunch()
      await checkDirectory(learningRequested ? assertLaunch : launchGuard)
      const copied = await readBinaryResource(join(directory, validationDefinition.filename), true)
      assertLaunch()
      if (resourceHash(copied) !== validation.sha256) throw new Error('检查资源写入复核失败。')
    }
    for (const asset of geoAssets) {
      await writeFile(join(directory, asset.path), asset.bytes, { flag: 'wx', mode: 0o600 })
      assertLaunch()
      await checkDirectory(learningRequested ? assertLaunch : launchGuard)
    }
    await verifyGeoAssets()
    assertLaunch()
    if (learning) await learning.writeImmutable('config.yaml', Buffer.from(configuration))
    else await writeFile(config, configuration, { flag: 'wx', mode: 0o600 })
    assertLaunch()
    stagedSmartModel = await stageSmartRuntimeModel(
      resourceRoot,
      directory,
      resource,
      configuration,
      learning ? (file, pin) => learning?.registerModel(file, pin) : undefined
    )
    await learning?.verifyBeforeLaunch()
    assertLaunch()
    const parseOptions = {
      timeout: 10000,
      maxBuffer: 65536,
      killSignal: 'SIGKILL' as const,
      env: {
        ...coreEnvironment({ ...process.env, HOME: directory, TMPDIR: directory }),
        ...(resource.capability === 'local-geodata-v1' ? { RELAY_LOCAL_GEODATA_V1: '1' } : {})
      },
      cwd: directory
    }
    assertLaunch()
    const parser = exec(resource.executable, ['-t', '-d', directory, '-f', config], parseOptions)
    if (learningRequested)
      parserCompletion = parser.then(
        () => undefined,
        () => undefined
      )
    await parser
    assertLaunch()
    if (kind === 'localProxy') {
      const listeners = [
        ...ordinaryPorts,
        ...(dedicated?.httpPort ? [dedicated.httpPort] : []),
        ...(dedicated?.socksPort ? [dedicated.socksPort] : [])
      ]
      const available = (
        await Promise.all([
          ...listeners.map(probeLocalPort),
          ...ordinaryUdpPorts.map(probeLocalUdpPort)
        ])
      ).every(Boolean)
      assertLaunch()
      if (!available) throw new Error('端口被占用，未抢占。')
    }
    await checkDirectory(learningRequested ? assertLaunch : launchGuard)
    // Validate the immutable resource again immediately before starting it.
    await verifyCoreResource(resourceRoot)
    assertLaunch()
    await verifySmartRuntimeModel(directory, stagedSmartModel)
    await verifyGeoAssets()
    await learning?.verifyBeforeLaunch()
    assertLaunch()
    if (validation && validationDefinition) {
      const copied = await readBinaryResource(join(directory, validationDefinition.filename), true)
      assertLaunch()
      if (resourceHash(copied) !== validation.sha256) throw new Error('检查资源已变化。')
    }
    const spawnOptions = {
      cwd: directory,
      env: {
        ...coreEnvironment({ ...process.env, HOME: directory, TMPDIR: directory }),
        ...(resource.capability === 'local-geodata-v1' ? { RELAY_LOCAL_GEODATA_V1: '1' } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      detached: false
    }
    assertLaunch()
    const spawned = spawn(
      resource.executable,
      ['-d', directory, '-f', config, '-ext-ctl-unix', socket],
      spawnOptions
    )
    child = spawned
    closePromise = new Promise((resolve) => {
      spawned.once('close', (code: number | null) => {
        closed = true
        closeCode = code
        closedDuringStop = stopping
        resolve()
      })
    })
    child.once('error', () => {
      launchFailed = true
    })
    // Drain into the bounded ring buffer; never retain raw core output in
    // product errors, but keep a capped diagnostic tail for the logs channel.
    child.stdout?.on('data', (chunk: Buffer) => logBuffer.append(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => logBuffer.append(chunk, 'stderr'))
    if (probeOwner) {
      if (!spawned.pid) throw new Error('临时核心进程身份未产生。')
      probeOwner = { ...probeOwner, phase: 'spawned', pid: spawned.pid }
      await writeProbeOwner(directory, probeOwner)
      assertLaunch()
    }
    const deadline = performance.now() + 8000
    let version: Record<string, unknown> | undefined
    while (!closed && !launchFailed && performance.now() < deadline) {
      assertLaunch()
      try {
        version = await read(
          'version',
          learningRequested || launchGuard ? { assertLive: assertLaunch } : undefined
        )
        assertLaunch()
        break
      } catch {
        assertLaunch()
        await delay(50)
        assertLaunch()
      }
    }
    if (!version || version.version !== resource.version || !child.pid)
      throw new Error('隔离核心版本或健康状态未确认。')
    if (kind === 'localProxy' && (!(await ownsOrdinaryListeners(child.pid)) || closed))
      throw new Error('未确认本次普通监听身份。')
    if (dedicated?.httpPort && !(await ownsHttpListener(child.pid, dedicated.httpPort)))
      throw new Error('未确认本次专用HTTP监听身份。')
    if (dedicated?.socksPort && !(await ownsHttpListener(child.pid, dedicated.socksPort)))
      throw new Error('未确认本次专用SOCKS监听身份。')
    assertLaunch()
    learning?.markReady()
    return {
      pid: child.pid,
      directory,
      socket,
      version: resource.version,
      smartStateBinding: learning?.binding,
      smartStateStopResult: () => learningReport,
      state: () =>
        stopped ? 'stopped' : stopping ? 'stopping' : closed ? 'unexpectedExit' : 'running',
      read,
      ...(kind === 'localProxy'
        ? {
            readTraffic,
            async openWorkDirectory(open: (path: string) => Promise<void>, assertLive: () => void) {
              await checkDirectory(assertLive)
              assertDirectoryIdentity(await lstat(directory))
              assertLive()
              await open(directory)
            }
          }
        : {}),
      smartToolsDefinition: toolsDefinition,
      smartWeights,
      clearSmartCache,
      group,
      select,
      automatic,
      patchMode,
      patchRule,
      reload,
      testDelay,
      closeConnection,
      closeAllConnections,
      logs,
      logSnapshot: logBuffer.sequencedSnapshot,
      stop
    }
  } catch {
    try {
      await stop()
    } catch {
      throw new Error('隔离验证失败且退出/清理未确认；没有操作其他核心。')
    }
    throw new Error('隔离核心未就绪，已结束本次实例；未改变系统代理、DNS或TUN。')
  }
}
