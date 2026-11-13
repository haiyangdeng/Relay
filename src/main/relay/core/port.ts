import { createServer } from 'net'
import { createSocket } from 'dgram'
import { execFile } from 'child_process'
import { promisify } from 'util'
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
