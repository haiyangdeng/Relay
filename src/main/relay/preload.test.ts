import { readFileSync } from 'fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

interface ExposedApi {
  ipcRenderer: { invoke(channel: string, ...args: unknown[]): Promise<unknown> }
}
const fixture = vi.hoisted(() => ({
  invoke: vi.fn(async () => 'mock IPC result'),
  exposed: new Map<string, unknown>()
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => fixture.exposed.set(name, value)
  },
  ipcRenderer: { invoke: fixture.invoke },
  webUtils: {}
}))
const world: { electron?: ExposedApi } = {}
let api: ExposedApi
beforeAll(async () => {
  vi.stubGlobal('window', world)
  await import('../../preload/index')
  const value = fixture.exposed.get('electron') ?? world.electron
  if (!value || typeof value !== 'object' || !('ipcRenderer' in value))
    throw new Error('Preload did not expose IPC')
  api = value as ExposedApi
})
afterAll(() => vi.unstubAllGlobals())
describe('Real preload dispatch with a mocked IPC transport', () => {
  it('forwards all registered Relay handlers through the actual whitelist', async () => {
    const source = readFileSync('src/main/relay/index.ts', 'utf8')
    const channels = [...source.matchAll(/ipcMain\.handle\('([^']+)'/gu)].map((match) => match[1])
    for (const channel of channels) {
      expect(await api.ipcRenderer.invoke(channel, { evidenceId: 'mock' })).toBe('mock IPC result')
      expect(fixture.invoke).toHaveBeenLastCalledWith(channel, { evidenceId: 'mock' })
    }
  })
  it('rejects unregistered names and prototype-shaped channels without reaching the transport', async () => {
    fixture.invoke.mockClear()
    for (const channel of [
      '__proto__',
      'constructor',
      'relayRunShell',
      'relayNetworkTestWithoutApproval'
    ])
      await expect(api.ipcRenderer.invoke(channel)).rejects.toThrow('Invalid invoke channel')
    expect(fixture.invoke).not.toHaveBeenCalled()
  })
})
