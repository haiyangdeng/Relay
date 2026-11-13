import { afterEach, expect, it, vi } from 'vitest'

const { expose, invoke } = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke },
  webUtils: {}
}))
const isolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')
afterEach(() => {
  if (isolated) Object.defineProperty(process, 'contextIsolated', isolated)
  else Reflect.deleteProperty(process, 'contextIsolated')
  vi.unstubAllGlobals()
})

it('allows the Linux application lookup through the renderer and preload bridge', async () => {
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  await import('./index')
  const api = expose.mock.calls.find(([name]) => name === 'electron')?.[1]
  vi.stubGlobal('window', { electron: api })
  const info = { name: 'Browser', icon: 'data:image/png;base64,aWNvbg==' }
  invoke.mockResolvedValue(info)
  const { getAppInfo } = await import('../renderer/src/utils/ipc')
  const metadata = { processPath: '/opt/browser' } as IMihomoConnectionDetail['metadata']
  await expect(getAppInfo(metadata)).resolves.toEqual(info)
  expect(invoke).toHaveBeenCalledWith('getAppInfo', metadata)
})

it('forwards only the fixed Geo origin and dedicated TUN resource IPC names without widening arbitrary access', async () => {
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  await import('./index')
  const api = expose.mock.calls.find(([name]) => name === 'electron')?.[1]
  invoke.mockReset().mockResolvedValue({ pending: false })
  for (const channel of [
    'relayGeoScheduleState',
    'relayGeoScheduleArm',
    'relayGeoScheduleDisarm',
    'relayGeoOriginList',
    'relayGeoOriginRead',
    'relayGeoOriginSave',
    'relayGeoOriginFetch',
    'relayGeoOriginState',
    'relayGeoOriginCancel',
    'relayTunResourcesRead',
    'relayTunResourceReplace',
    'relayTunRuleProvidersRead',
    'relayTunRuleProviderReplace'
  ]) {
    const input = { privateFixture: channel }
    await expect(api.ipcRenderer.invoke(channel, input)).resolves.toEqual({ pending: false })
    expect(invoke).toHaveBeenLastCalledWith(channel, input)
  }
  await expect(
    api.ipcRenderer.invoke('relayGeoOriginArbitraryPath', { path: '/private' })
  ).rejects.toThrow('Invalid invoke channel')
  await expect(
    api.ipcRenderer.invoke('relayTunRuleProviderPath', { path: '/private' })
  ).rejects.toThrow('Invalid invoke channel')
  expect(invoke).toHaveBeenCalledTimes(13)
})

it('forwards the selected rule-cache preview without allowing a new path reader', async () => {
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  await import('./index')
  const api = expose.mock.calls.find(([name]) => name === 'electron')?.[1],
    selection = { id: '00000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64) }
  invoke.mockReset().mockResolvedValue({ text: 'fixture.invalid' })
  await expect(api.ipcRenderer.invoke('relayResourcePreview', selection)).resolves.toEqual({
    text: 'fixture.invalid'
  })
  expect(invoke).toHaveBeenCalledWith('relayResourcePreview', selection)
  await expect(
    api.ipcRenderer.invoke('relayResourcePreviewPath', { path: '/private' })
  ).rejects.toThrow('Invalid invoke channel')
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('forwards the owned Smart tools intents through the actual preload without exposing native operations', async () => {
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  await import('./index')
  const api = expose.mock.calls.find(([name]) => name === 'electron')?.[1]
  invoke.mockReset().mockResolvedValue({ status: 'unsupported' })
  for (const target of ['ordinary', 'tun']) {
    const identity = {
      target,
      instanceId: '11111111-1111-4111-8111-111111111111',
      configurationRevision: 'a'.repeat(64)
    }
    for (const input of [
      { action: 'inspect', target },
      { action: 'weights', ...identity, group: 'Smart' },
      { action: 'clear-cache', ...identity }
    ]) {
      await expect(api.ipcRenderer.invoke('relaySmartTools', input)).resolves.toEqual({
        status: 'unsupported'
      })
      expect(invoke).toHaveBeenLastCalledWith('relaySmartTools', input)
    }
  }
  for (const channel of ['relaySmartToolsExecuteNative', 'relaySmartToolsFlushPath'])
    await expect(api.ipcRenderer.invoke(channel, { path: '/private' })).rejects.toThrow(
      'Invalid invoke channel'
    )
  expect(invoke).toHaveBeenCalledTimes(6)
})
