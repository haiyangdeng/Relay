import { createSocket, type Socket } from 'dgram'
import { describe, expect, it } from 'vitest'
import { ownsUdpListener, probeLocalUdpPort, waitForTunPorts } from './port'

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

describe('returning TCP listeners from the privileged TUN core', () => {
  const row = (port: number, state: string, ip = '127.0.0.1') =>
    `tcp4 0 0 ${ip}.${port} 127.0.0.1.60802 ${state}`
  function fixture() {
    let elapsed = 0
    const os = {
      now: () => elapsed,
      msl: async () => 15000,
      table: async () => row(7892, 'TIME_WAIT'),
      pause: async (ms: number) => {
        elapsed += ms
      },
      probe: async (port: number) => port !== 7892 || elapsed >= 30000
    }
    return os
  }
  it('binds available ports immediately and waits only for actual reuse after a busy session', async () => {
    const os = fixture()
    await waitForTunPorts([7890], () => {}, os)
    expect(os.now()).toBe(0)
    await waitForTunPorts([7890, 7892], () => {}, os)
    expect(os.now()).toBe(30000)
  })
  it('allows an old TUN half-close to drain across the usual TIME_WAIT deadline', async () => {
    const os = fixture()
    const ready = await waitForTunPorts([7892], () => {}, {
      ...os,
      table: async () => row(7892, os.now() < 44000 ? 'FIN_WAIT_2' : 'TIME_WAIT'),
      probe: async () => os.now() >= 75000
    })
    expect(ready).toBe(true)
    expect(os.now()).toBe(75000)
  })
  it('refuses a live listener, a live stream, or an unaccounted-for blocked port', async () => {
    for (const table of [
      row(7892, 'FIN_WAIT_2') + '\n' + row(7892, 'LISTEN', '*'),
      row(7892, 'ESTABLISHED'),
      row(7892, 'TIME_WAIT', '10.0.0.1'),
      row(7892, 'FIN_WAIT_2').replace('127.0.0.1.60802', '10.0.0.1.60802'),
      row(60802, 'TIME_WAIT')
    ]) {
      const os = fixture()
      expect(await waitForTunPorts([7892], () => {}, { ...os, table: async () => table })).toBe(
        false
      )
      expect(os.now()).toBe(0)
    }
  })
  it('hands conflicts and expired waits back to normal guarded prepare', async () => {
    const os = fixture()
    await waitForTunPorts([7892], () => {}, { ...os, table: async () => row(7892, 'LISTEN') })
    expect(os.now()).toBe(0)
    await waitForTunPorts([7892], () => {}, {
      ...os,
      msl: async () => 100,
      probe: async () => false
    })
    expect(os.now()).toBe(2200)
  })
  it('cancels before another bind if quit or an ownership change invalidates the handoff', async () => {
    const os = fixture()
    await expect(
      waitForTunPorts(
        [7892],
        () => {
          if (os.now()) throw new Error('cancelled')
        },
        os
      )
    ).rejects.toThrow('cancelled')
    expect(os.now()).toBe(750)
  })
})
