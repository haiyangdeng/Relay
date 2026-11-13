import { Resolver } from 'dns/promises'
import { isIP, createServer } from 'net'
import { networkInterfaces } from 'os'
import { performance } from 'perf_hooks'
import {
  resolveAllPublicOrThrow,
  isPrivateIp,
  isForbiddenHost
} from '../../resolve/plugin/net-guard'
import {
  probeDelayURL,
  probeEndpoints,
  probeLatencyTargets
} from '../../../shared/relay/isolated-probes'
import { requestOnce } from '../../resolve/plugin/http-client'
import type { RelayStateContext } from '../context'
import { startOwnedCore, type OwnedCoreCleanupRegistration } from '../core/owned-runtime'
import { ownsHttpListener } from '../core/port'
import type { IsolatedProbeRequest } from '../../../shared/relay/isolated-probes'
import { isolatedProbeConfiguration } from './probe-configuration'
async function ephemeralPort(signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy())
    let settled = false
    const failed = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', failed)
      server.close()
      reject(new Error('随机探测端口未取得。'))
    }
    server.once('error', failed)
    signal.addEventListener('abort', failed, { once: true })
    if (signal.aborted) {
      failed()
      return
    }
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      if (!address || typeof address !== 'object' || address.port < 1024) {
        failed()
        return
      }
      server.close((error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', failed)
        if (error || signal.aborted) reject(new Error('随机探测端口已取消。'))
        else resolve(address.port)
      })
    })
  })
}
interface ProbeRuntime {
  nodes: string[]
  failures: Map<string, string>
  configurationSHA256: string
  requestedConfigurationSHA256: string
  request(
    url: string,
    timeout: number,
    maxBytes: number,
    method?: 'GET' | 'HEAD'
  ): Promise<{ body: string; milliseconds: number }>
  delay(node: string, url: string): Promise<number>
  close(): Promise<void>
}
export async function startIsolatedProbe(adapters: {
  context: RelayStateContext
  resourceRoot: string
  text: string
  request: IsolatedProbeRequest
  signal: AbortSignal
  assertCurrent(): void
  registerCleanup: OwnedCoreCleanupRegistration
}): Promise<ProbeRuntime> {
  adapters.assertCurrent()
  const port = await ephemeralPort(adapters.signal)
  adapters.assertCurrent()
  const template = isolatedProbeConfiguration(adapters.text, adapters.request, port)
  const testingDelay =
    adapters.request.kind === 'nodeDelay' || adapters.request.kind === 'groupDelay'
  const destinations: readonly string[] =
    adapters.request.kind === 'ip'
      ? [probeEndpoints[adapters.request.provider]]
      : adapters.request.kind === 'latency'
        ? probeLatencyTargets.map((name) => probeEndpoints[name])
        : [adapters.request.delay?.url ?? probeDelayURL]
  for (const url of destinations) {
    const host = new URL(url).hostname.replace(/^\[|\]$/gu, '')
    if (isForbiddenHost(host)) throw new Error('独立探测目标必须是公网地址。')
  }
  const directOnly =
    testingDelay &&
    template.runnableNodes.every((name) =>
      ['DIRECT', 'REJECT'].includes(template.delayTargets.get(name) ?? '')
    )
  const needsDirect =
    testingDelay &&
    template.runnableNodes.some((name) => template.delayTargets.get(name) === 'DIRECT')
  const hosts: Record<string, string> = {}
  const unavailableServers = new Set<string>()
  const own = new Set(
    Object.values(networkInterfaces()).flatMap((rows) => rows?.map((row) => row.address) ?? [])
  )
  // Pin proxy server addresses while preserving their Server/SNI strings.
  // For node tests, the fixed test hostname is passed through the selected proxy
  // by Mihomo URLTest, as in upstream; local DNS must not rewrite that target.
  const resolver = new Resolver({ timeout: 2500, tries: 1 })
  const cancelDNS = (): void => resolver.cancel()
  adapters.signal.addEventListener('abort', cancelDNS, { once: true })
  try {
    for (const host of [
      ...new Set([
        ...template.servers,
        ...(!testingDelay || (directOnly && needsDirect)
          ? destinations.map((url) => new URL(url).hostname)
          : [])
      ])
    ]) {
      adapters.assertCurrent()
      try {
        if (isIP(host)) {
          if (isPrivateIp(host) || own.has(host)) throw new Error('独立探测拒绝本机或非公网端点。')
          continue
        }
        const addresses = await resolveAllPublicOrThrow(host, async (name) =>
          (await resolver.resolve4(name)).map((address) => ({ address, family: 4 }))
        )
        adapters.assertCurrent()
        if (addresses.some((row) => own.has(row.address))) throw new Error('独立探测拒绝本机端点。')
        hosts[host] = addresses[0].address
      } catch (error) {
        adapters.assertCurrent()
        if (
          adapters.signal.aborted ||
          adapters.request.kind !== 'groupDelay' ||
          (directOnly && needsDirect && destinations.some((url) => new URL(url).hostname === host))
        )
          throw error
        unavailableServers.add(host)
      }
    }
  } finally {
    adapters.signal.removeEventListener('abort', cancelDNS)
    resolver.cancel()
  }
  const built = isolatedProbeConfiguration(
    adapters.text,
    adapters.request,
    port,
    hosts,
    unavailableServers
  )
  if (!built.runnableNodes.length)
    return {
      nodes: built.nodes,
      failures: built.failures,
      configurationSHA256: built.sha256,
      requestedConfigurationSHA256: template.sha256,
      async request(): Promise<never> {
        throw new Error('没有可用于本次探测的节点。')
      },
      async delay(): Promise<never> {
        throw new Error('没有可用于本次探测的节点。')
      },
      close: async () => {}
    }
  let stopCore: (() => Promise<void>) | undefined
  let stopDirect: (() => Promise<void>) | undefined
  let direct: Promise<Awaited<ReturnType<typeof startIsolatedProbe>>> | undefined
  const close = async (): Promise<void> => {
    // Each child has its own ownership record; failed cleanup stays retryable.
    const results = await Promise.allSettled([stopDirect?.(), stopCore?.()])
    const failed = results.find((entry) => entry.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  adapters.registerCleanup(close)
  const core = await startOwnedCore(
    adapters.resourceRoot,
    built.configuration,
    'localProxy',
    (stop) => {
      stopCore = stop
    },
    undefined,
    adapters.assertCurrent,
    undefined,
    { context: adapters.context, purpose: 'isolated-probe-v1', hosts }
  )
  const owned = core
  const check = (): void => {
    adapters.assertCurrent()
    if (adapters.signal.aborted || owned.state() !== 'running')
      throw new Error('独立探测核心所有权已失效。')
  }
  const assertOwner = async (): Promise<void> => {
    check()
    const configs = await owned.read('configs', { assertLive: check })
    check()
    if (
      configs.port !== port ||
      configs.mode !== 'rule' ||
      configs.ipv6 !== false ||
      !(await ownsHttpListener(owned.pid, port))
    )
      throw new Error('独立探测监听身份未确认。')
    check()
  }
  await assertOwner()
  const request = async (
    url: string,
    timeout: number,
    maxBytes: number,
    method: 'GET' | 'HEAD' = 'GET'
  ) => {
    if (
      !destinations.includes(url) ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1000 ||
      timeout > 10000 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 1024 * 1024
    )
      throw new Error('只允许本次固定探测目标及预算。')
    await assertOwner()
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('当前TLS验证未通过。')
    const wall = Date.now(),
      tick = performance.now()
    const response = await requestOnce(url, {
      method,
      headers: { 'user-agent': 'clash.meta/Relay', 'accept-encoding': 'identity' },
      proxy: { host: '127.0.0.1', port },
      signal: adapters.signal,
      timeout,
      maxBytes
    })
    const elapsed = Math.max(Date.now() - wall, performance.now() - tick)
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= timeout)
      throw new Error('独立请求时间未确认。')
    await assertOwner()
    if (response.status !== 200 && response.status !== 204)
      throw new Error('固定探测服务未返回成功状态。')
    return { body: response.body, milliseconds: Math.round(elapsed) }
  }
  return {
    nodes: built.nodes,
    failures: built.failures,
    configurationSHA256: built.sha256,
    requestedConfigurationSHA256: template.sha256,
    request,
    async delay(node: string, url: string): Promise<number> {
      if (!destinations.includes(url) || !built.runnableNodes.includes(node))
        throw new Error('只允许本次固定静态节点及探测目标。')
      await assertOwner()
      // Use Mihomo's mature HEAD/URLTest implementation on this temporary
      // owned instance only. Its delay history is discarded on close; no
      // selection or active automatic-group state is changed.
      if (!owned.testDelay) throw new Error('固定核心未提供节点测速接口。')
      const target = built.delayTargets.get(node)
      if (!target) throw new Error('当前测速路径未确认。')
      if (target === 'DIRECT' && !directOnly) {
        // Pin the direct test site's public address in a separate temporary
        // instance so proxy URLTests keep their original remote DNS behavior.
        direct ??= startIsolatedProbe({
          ...adapters,
          request: { ...adapters.request, target: 'DIRECT', kind: 'nodeDelay' },
          registerCleanup: (stop) => {
            stopDirect = stop
          }
        })
        const runtime = await direct
        check()
        const value = await runtime.delay('DIRECT', url)
        await assertOwner()
        return value
      }
      const milliseconds = await owned.testDelay(
        target,
        url,
        adapters.request.delay?.timeout ?? 5000
      )
      await assertOwner()
      return milliseconds
    },
    close
  }
}
