import { createServer } from 'net'
import { createSocket } from 'dgram'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { LocalProxyPlan } from '../../../shared/relay/local-proxy-plan'
import { enabledLocalProxyPorts, localProxyPortsFor } from '../../../shared/relay/local-proxy-ports'
import { localProxyPort as localHttpPort } from '../../../shared/relay/local-proxy'

export { localProxyPort as localHttpPort } from '../../../shared/relay/local-proxy'

const exec = promisify(execFile)
export async function probeLocalPort(value: number): Promise<boolean> {
  const port = localHttpPort(value)
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy())
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
      server.close(() => resolve(true))
    )
  })
}
// A just-released older TUN core can leave accepted connections owned by root.
// Only wait for closing loopback sockets. A listener or live connection is a
// conflict; an actual exclusive bind is always required before returning true.
function tunPortReleaseState(table: string, ports: number[]): 'closing' | 'timeWait' | undefined {
  const remaining = new Set(ports)
  let closing = false
  for (const line of table.split('\n')) {
    const [protocol, , , local, peer, state] = line.trim().split(/\s+/)
    if (!/^tcp(?:4|6|46)?$/.test(protocol)) continue
    const match = /^(127\.0\.0\.1|\*|::ffff:127\.0\.0\.1|::|::1)\.(\d+)$/.exec(local ?? '')
    if (!match) continue
    const port = Number(match[2])
    if (!ports.includes(port)) continue
    if (
      match[1] === '*' ||
      match[1] === '::' ||
      !/^(?:127\.0\.0\.1|::ffff:127\.0\.0\.1|::1)\.\d+$/.test(peer ?? '')
    )
      return
    if (state !== 'TIME_WAIT') {
      if (!['FIN_WAIT_1', 'FIN_WAIT_2', 'CLOSING', 'LAST_ACK'].includes(state)) return
      closing = true
    }
    remaining.delete(port)
  }
  if (ports.length && !remaining.size) return closing ? 'closing' : 'timeWait'
  return undefined
}

const darwinPortRecovery = {
  probe: probeLocalPort,
  async table(): Promise<string> {
    return (
      await exec('/usr/sbin/netstat', ['-an', '-p', 'tcp'], {
        timeout: 2500,
        maxBuffer: 8 * 1024 * 1024,
        env: { PATH: '/usr/bin:/bin' }
      })
    ).stdout
  },
  async msl(): Promise<number> {
    return Number(
      (
        await exec('/usr/sbin/sysctl', ['-n', 'net.inet.tcp.msl'], {
          timeout: 2500,
          env: { PATH: '/usr/bin:/bin' }
        })
      ).stdout.trim()
    )
  },
  now: () => performance.now(),
  pause: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function waitForTunPlanPorts(
  plan: LocalProxyPlan,
  current: () => void,
  os = darwinPortRecovery
): Promise<boolean> {
  const ports = enabledLocalProxyPorts(localProxyPortsFor(plan.httpPort, plan.ports))
  if (plan.dedicated?.httpPort) ports.push(plan.dedicated.httpPort)
  if (plan.dedicated?.socksPort) ports.push(plan.dedicated.socksPort)
  return waitForTunPorts(ports, current, os)
}

export async function waitForTunPorts(
  ports: number[],
  assertCurrent: () => void,
  os = darwinPortRecovery
): Promise<boolean> {
  const start = os.now()
  let deadline: number | undefined
  let pending = [...new Set(ports)]
  while (pending.length) {
    assertCurrent()
    const free = await Promise.all(pending.map((port) => os.probe(port)))
    pending = pending.filter((_, i) => !free[i])
    if (!pending.length) break
    try {
      const state = tunPortReleaseState(await os.table(), pending)
      if (!state) break
      if (state === 'closing') {
        // A half-close may precede the final TIME_WAIT interval. Bound the
        // entire handoff even if a client keeps its write side open.
        deadline = start + 120000
      } else if (deadline === undefined) {
        const msl = await os.msl()
        if (!Number.isSafeInteger(msl) || msl <= 0) break
        deadline = start + Math.min(2 * msl + 2000, 120000)
      }
    } catch {
      // The normal prepare step still checks every TCP/UDP port and the lease.
      break
    }
    const remaining = deadline - os.now()
    if (remaining <= 0) break
    await os.pause(Math.min(750, remaining))
  }
  assertCurrent()
  return pending.length === 0
}

export async function ownsHttpListener(pid: number, port: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('进程身份无效。')
  localHttpPort(port)
  try {
    const result = await exec(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(pid), `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fpn'],
      { timeout: 2500, maxBuffer: 32768, env: { PATH: '/usr/bin:/bin' } }
    )
    const fields = result.stdout.trim().split('\n')
    return fields.includes('p' + pid) && fields.includes(`n127.0.0.1:${port}`)
  } catch {
    return false
  }
}

export async function probeLocalUdpPort(value: number): Promise<boolean> {
  const port = localHttpPort(value)
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    socket.once('error', () => {
      socket.close()
      resolve(false)
    })
    socket.bind({ address: '127.0.0.1', port, exclusive: true }, () =>
      socket.close(() => resolve(true))
    )
  })
}

export async function ownsUdpListener(pid: number, port: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('进程身份无效。')
  localHttpPort(port)
  try {
    const result = await exec(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(pid), `-iUDP@127.0.0.1:${port}`, '-Fpn'],
      { timeout: 2500, maxBuffer: 32768, env: { PATH: '/usr/bin:/bin' } }
    )
    const fields = result.stdout.trim().split('\n')
    return fields.includes('p' + pid) && fields.includes(`n127.0.0.1:${port}`)
  } catch {
    return false
  }
}
