import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('child_process', () => ({ execFile: execute }))
import { inspectProbeNetwork, probeNetworkObservation } from './network-observer'

const observation = (patch: Record<string, unknown> = {}) => ({
  version: 1,
  role: 'probe-network-observer',
  uid: process.getuid?.(),
  networkSHA256: 'a'.repeat(64),
  protectionSHA256: 'b'.repeat(64),
  existingTunnel: false,
  ...patch
})
const directories: string[] = []
const reply = (error?: Error, value = observation()): void => {
  execute.mockImplementation((_path, _args, _options, callback) =>
    callback(error, JSON.stringify(value))
  )
}
beforeEach(() => {
  execute.mockReset()
  reply()
})
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'relay-observer-fixture-')))
  directories.push(directory)
  const executable = join(directory, 'RelayNetworkObserver')
  await writeFile(executable, 'synthetic inert resource; execution is mocked', { mode: 0o700 })
  return executable
}

describe('Probe network observation contract', () => {
  it('keeps observed tunnel presence instead of treating it as independent', () => {
    expect(probeNetworkObservation(observation({ uid: 501, existingTunnel: true }), 501)).toEqual({
      networkSHA256: 'a'.repeat(64),
      protectionSHA256: 'b'.repeat(64),
      existingTunnel: true
    })
  })
  it.each([
    { version: 2 },
    { role: 'tun-helper' },
    { uid: 0 },
    { uid: '501' },
    { existingTunnel: 'none' },
    { networkSHA256: 'A'.repeat(64) },
    { protectionSHA256: '' },
    { readCompleted: false }
  ])('rejects incomplete or foreign observations %j', (patch) => {
    expect(() => probeNetworkObservation(observation({ uid: 501, ...patch }), 501)).toThrow()
  })
})

describe.runIf(process.platform === 'darwin' && !!process.getuid?.())(
  'Bundled observer transport',
  () => {
    it('runs only the bundled read command without installation lookup or privilege elevation', async () => {
      const executable = await fixture()
      await expect(inspectProbeNetwork(executable)).resolves.toEqual({
        networkSHA256: 'a'.repeat(64),
        protectionSHA256: 'b'.repeat(64),
        existingTunnel: false
      })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledWith(
        executable,
        ['--inspect'],
        expect.objectContaining({
          timeout: 10000,
          maxBuffer: 2048,
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
        }),
        expect.any(Function)
      )
    })
    it('refuses missing, writable or symbolic resources before execution', async () => {
      const executable = await fixture()
      await chmod(executable, 0o722)
      await expect(inspectProbeNetwork(executable)).rejects.toThrow()
      await rm(executable)
      await expect(inspectProbeNetwork(executable)).rejects.toThrow()
      const target = join(directories[0], 'inert')
      await writeFile(target, 'inert', { mode: 0o700 })
      await symlink(target, executable)
      await expect(inspectProbeNetwork(executable)).rejects.toThrow()
      expect(execute).not.toHaveBeenCalled()
    })
    it('fails closed on nonzero exit or a malformed report without retrying', async () => {
      const executable = await fixture()
      reply(new Error('synthetic failure'))
      await expect(inspectProbeNetwork(executable)).rejects.toThrow('未能完整读取')
      reply(undefined, observation({ uid: 0 }))
      await expect(inspectProbeNetwork(executable)).rejects.toThrow('身份或摘要')
      expect(execute).toHaveBeenCalledTimes(2)
    })
    it('rejects a resource replaced during the observation even with a valid report', async () => {
      const executable = await fixture()
      execute.mockImplementation((_path, _args, _options, callback) => {
        void writeFile(executable, 'changed inert resource', { mode: 0o700 }).then(() =>
          callback(null, JSON.stringify(observation()))
        )
      })
      await expect(inspectProbeNetwork(executable)).rejects.toThrow('组件已变化')
    })
  }
)
