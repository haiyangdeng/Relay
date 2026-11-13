import { Resolver } from 'dns/promises'
import { createServer as createPortServer, isIP, type Socket } from 'net'
import { createServer, request as httpRequest, type IncomingMessage } from 'http'
import { networkInterfaces } from 'os'
import { inspectProbeWorkspaces } from '../core/probe-owners'
import type { RelayStateContext } from '../context'
import type { SubStoreAdvancedStart } from '../../../shared/relay/substore'
import { isolatedProbeConfiguration } from '../network-info/probe-configuration'
import { startOwnedCore, type OwnedCoreCleanupRegistration } from '../core/owned-runtime'
import { ownsHttpListener } from '../core/port'
import { resolveAllPublicOrThrow, isPrivateIp } from '../../resolve/plugin/net-guard'
async function reservePort(signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createPortServer((socket) => socket.destroy())
    const fail = (): void => {
      server.close()
      reject(new Error('独立出站端口未取得。'))
    }
    server.once('error', fail)
    signal.addEventListener('abort', fail, { once: true })
    if (signal.aborted) {
      fail()
      return
    }
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      server.close((error) => {
        signal.removeEventListener('abort', fail)
        if (
          error ||
          signal.aborted ||
          !address ||
          typeof address !== 'object' ||
          address.port < 1024
        )
          reject(new Error('独立出站端口未确认。'))
        else resolve(address.port)
      })
    })
  })
}
const stripBrackets = (s: string): string =>
  s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
const addressText = (ip: string): string => (isIP(ip) === 6 ? `[${ip}]` : ip)
export interface SubStoreEgress {
  readonly pid: number
  readonly port: number
  alive(): boolean
  assertCurrent(): Promise<void>
  stop(): Promise<void>
}
// The original Sub-Store backend still uses its normal HTTP proxy transport.
// Only its destination is this owned forwarding gate, never an active Core.
export async function startSubStoreEgress(adapters: {
  context: RelayStateContext
  resourceRoot: string
  text: string
  request: SubStoreAdvancedStart
  signal: AbortSignal
  assertLive(): void
  network(): Promise<string>
  registerCleanup: OwnedCoreCleanupRegistration
  failed(): void
}): Promise<SubStoreEgress> {
  const lifetime = new AbortController(),
    sockets = new Set<Socket>(),
    resolvers = new Set<Resolver>()
  let stopped = false,
    stopping: Promise<void> | undefined,
    closeCore: (() => Promise<void>) | undefined
  const controllerSignal = AbortSignal.any([adapters.signal, lifetime.signal])
  const check = (): void => {
    adapters.assertLive()
    if (stopped || controllerSignal.aborted) throw new Error('Sub-Store独立出站已撤销。')
  }
  check()
  if ((await inspectProbeWorkspaces(adapters.context)).status !== 'clear')
    throw new Error('旧临时核心工作区尚未收尾。')
  check()
  const baseline = await adapters.network()
  check()
  const independent = async (): Promise<void> => {
    check()
    try {
      if ((await adapters.network()) !== baseline) throw new Error('Sub-Store独立出站环境变化。')
      check()
    } catch (error) {
      lifetime.abort()
      adapters.failed()
      throw error
    }
  }
  const publicAddress = async (
    host: string,
    signal: AbortSignal = controllerSignal
  ): Promise<string> => {
    check()
    if (signal.aborted) throw new Error('独立解析已取消。')
    const own = new Set(
      Object.values(networkInterfaces()).flatMap((rows) => rows?.map((row) => row.address) ?? [])
    )
    if (isIP(host)) {
      if (isPrivateIp(host) || own.has(host))
        throw new Error('Sub-Store独立出站拒绝本机或私网目标。')
      return host
    }
    const resolver = new Resolver({ timeout: 2500, tries: 1 }),
      abort = (): void => resolver.cancel()
    resolvers.add(resolver)
    signal.addEventListener('abort', abort, { once: true })
    try {
      const rows = await resolveAllPublicOrThrow(host, async (name) =>
        (await resolver.resolve4(name)).map((address) => ({ address, family: 4 }))
      )
      check()
      if (signal.aborted || rows.some((row) => own.has(row.address)))
        throw new Error('独立解析取消或目标是本机。')
      return rows[0].address
    } finally {
      signal.removeEventListener('abort', abort)
      resolvers.delete(resolver)
      resolver.cancel()
    }
  }
  const template = isolatedProbeConfiguration(
    adapters.text,
    { kind: 'ip', target: adapters.request.target },
    49152
  )
  const hosts: Record<string, string> = {}
  for (const host of template.servers) {
    await independent()
    if (!isIP(host)) hosts[host] = await publicAddress(host)
  }
  const port = await reservePort(controllerSignal)
  check()
  const built = isolatedProbeConfiguration(
    adapters.text,
    { kind: 'ip', target: adapters.request.target },
    port,
    hosts
  )
  const server = createServer()
  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (stopping) return stopping
    stopping = Promise.resolve()
      .then(async () => {
        lifetime.abort()
        for (const socket of sockets) socket.destroy()
        for (const resolver of resolvers) resolver.cancel()
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
        await closeCore?.()
        stopped = true
      })
      .finally(() => {
        stopping = undefined
      })
    return stopping
  }
  adapters.registerCleanup(stop)
  const core = await startOwnedCore(
    adapters.resourceRoot,
    built.configuration,
    'localProxy',
    (close) => {
      closeCore = close
    },
    undefined,
    check,
    undefined,
    { context: adapters.context, purpose: 'isolated-substore-v1', hosts }
  )
  const assertCurrent = async (): Promise<void> => {
    try {
      await independent()
      const configs = await core.read('configs', { assertLive: check })
      check()
      if (
        core.state() !== 'running' ||
        configs.port !== port ||
        configs.mode !== 'rule' ||
        configs.ipv6 !== false ||
        !(await ownsHttpListener(core.pid, port))
      )
        throw new Error('Sub-Store独立核心监听身份未确认。')
      await independent()
    } catch (error) {
      lifetime.abort()
      adapters.failed()
      throw error
    }
  }

  let pending = 0
  const liveRequests = new Set<AbortController>()
  const begin = (): { signal: AbortSignal; finish(): void; settled(): void } => {
    check()
    if (pending >= 8) throw new Error('Sub-Store并行请求超限。')
    ++pending
    const controller = new AbortController(),
      signal = AbortSignal.any([controllerSignal, controller.signal, AbortSignal.timeout(30000)])
    liveRequests.add(controller)
    let closed = false,
      prepared = false,
      released = false
    const release = (): void => {
      if (released || !closed || !prepared) return
      released = true
      --pending
      liveRequests.delete(controller)
      void independent().catch(() => {})
    }
    return {
      signal,
      finish: () => {
        closed = true
        controller.abort()
        release()
      },
      settled: () => {
        prepared = true
        release()
      }
    }
  }

  const destination = async (
    message: IncomingMessage,
    connect: boolean,
    signal: AbortSignal
  ): Promise<{ url: URL; ip: string; port: number }> => {
    if (signal.aborted) throw new Error('Sub-Store代理请求已取消。')
    const value = message.url ?? ''
    if (value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Error('Sub-Store代理目标无效。')
    const url = new URL(connect ? `https://${value}/` : value)
    if (
      url.username ||
      url.password ||
      url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      (connect && (`${url.hostname}:${url.port || '443'}` !== value || url.pathname !== '/'))
    )
      throw new Error('Sub-Store代理目标无效。')
    const host = stripBrackets(url.hostname),
      remotePort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)
      throw new Error('Sub-Store目标端口无效。')
    await assertCurrent()
    const ip = await publicAddress(host, signal)
    await assertCurrent()
    return { url, ip, port: remotePort }
  }
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.setTimeout(30000, () => socket.destroy())
  })
  server.on('connect', (message, socket, head) => {
    let ticket: ReturnType<typeof begin> | undefined
    try {
      ticket = begin()
    } catch {
      socket.destroy()
      return
    }
    const current = ticket
    socket.once('close', () => current.finish())
    void (async () => {
      const target = await destination(message, true, current.signal)
      if (current.signal.aborted) throw new Error('Sub-Store代理请求已取消。')
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: `${addressText(target.ip)}:${target.port}`,
        headers: { host: `${addressText(target.ip)}:${target.port}` },
        agent: false,
        signal: current.signal
      })
      request.once('error', () => socket.destroy())
      request.once('response', (response) => {
        response.destroy()
        socket.destroy()
      })
      request.once('connect', (response, upstream, extra) => {
        sockets.add(upstream)
        upstream.once('close', () => sockets.delete(upstream))
        if (response.statusCode !== 200 || current.signal.aborted) {
          upstream.destroy()
          socket.destroy()
          return
        }
        let bytes = 0
        const budget = (chunk: Buffer): void => {
          bytes += chunk.length
          if (bytes > 16 * 1024 * 1024) {
            socket.destroy()
            upstream.destroy()
          }
        }
        socket.on('data', budget)
        upstream.on('data', budget)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        if (extra.length) socket.write(extra)
        const aborted = (): void => {
          socket.destroy()
          upstream.destroy()
        }
        current.signal.addEventListener('abort', aborted, { once: true })
        socket.once('close', () => current.signal.removeEventListener('abort', aborted))
        socket.pipe(upstream)
        upstream.pipe(socket)
        socket.once('error', () => upstream.destroy())
        upstream.once('error', () => socket.destroy())
        socket.once('close', () => upstream.destroy())
        upstream.once('close', () => socket.destroy())
      })
      request.end()
    })()
      .catch(() => socket.destroy())
      .finally(() => current.settled())
  })
  server.on('request', (message, response) => {
    let ticket: ReturnType<typeof begin> | undefined
    try {
      ticket = begin()
    } catch {
      response.writeHead(503).end()
      return
    }
    const current = ticket
    response.once('close', () => current.finish())
    void (async () => {
      const target = await destination(message, false, current.signal)
      if (target.url.protocol !== 'http:' || current.signal.aborted)
        throw new Error('HTTPS只接受CONNECT。')
      const headers = { ...message.headers, host: target.url.host, connection: 'close' }
      delete headers['proxy-authorization']
      delete headers['proxy-connection']
      const path = `http://${addressText(target.ip)}:${target.port}${target.url.pathname}${target.url.search}`
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: message.method,
          path,
          headers,
          agent: false,
          signal: current.signal
        },
        (remote) => {
          response.writeHead(remote.statusCode ?? 502, remote.headers)
          let bytes = 0
          remote.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > 16 * 1024 * 1024) request.destroy()
          })
          remote.on('error', () => response.destroy())
          remote.pipe(response)
        }
      )
      let bytes = 0
      message.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) request.destroy()
      })
      request.once('error', () => response.destroy())
      message.pipe(request)
    })()
      .catch(() => {
        if (!response.headersSent) response.writeHead(502)
        response.end()
      })
      .finally(() => current.settled())
  })
  const startupAbort = (): void => {
    if (!lifetime.signal.aborted) lifetime.abort()
    for (const resolver of resolvers) resolver.cancel()
    for (const socket of sockets) socket.destroy()
    adapters.failed()
  }
  controllerSignal.addEventListener('abort', startupAbort, { once: true })
  await assertCurrent()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const address = server.address()
  if (!address || typeof address !== 'object' || address.port < 1024)
    throw new Error('Sub-Store出站守门未就绪。')
  await assertCurrent()
  return {
    pid: core.pid,
    port: address.port,
    alive: () =>
      !stopped && !controllerSignal.aborted && core.state() === 'running' && server.listening,
    assertCurrent,
    stop
  }
}
