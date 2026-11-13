import { createSocket, type Socket } from 'dgram'
import { describe, expect, it } from 'vitest'
import { ownsUdpListener, probeLocalUdpPort } from './port'

async function reserveLoopback(): Promise<Socket> {
  const socket = createSocket('udp4')
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error)
    socket.once('error', failed)
    socket.bind({ address: '127.0.0.1', port: 0, exclusive: true }, () => {
      socket.removeListener('error', failed)
      resolve()
    })
  })
  return socket
}

const close = (socket: Socket): Promise<void> =>
  new Promise((resolve) => socket.close(() => resolve()))

describe('ordinary UDP listener readiness', () => {
  it('refuses an occupied loopback port and succeeds after the owned fixture releases it', async () => {
    const socket = await reserveLoopback()
    const { port } = socket.address()
    try {
      expect(await probeLocalUdpPort(port)).toBe(false)
    } finally {
      await close(socket)
    }
    expect(await probeLocalUdpPort(port)).toBe(true)
  })

  it.runIf(process.platform === 'darwin')(
    'recognizes only this process while its UDP loopback fixture is listening',
    async () => {
      const socket = await reserveLoopback()
      const { port } = socket.address()
      try {
        expect(await ownsUdpListener(process.pid, port)).toBe(true)
        expect(await ownsUdpListener(2147483647, port)).toBe(false)
      } finally {
        await close(socket)
      }
      expect(await ownsUdpListener(process.pid, port)).toBe(false)
    }
  )

  it.each([0, 1023, 65536, 1024.5, NaN])('rejects invalid UDP port %s', async (port) => {
    await expect(probeLocalUdpPort(port)).rejects.toThrow('端口')
  })
})
