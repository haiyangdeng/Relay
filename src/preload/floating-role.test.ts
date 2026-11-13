import { afterEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({
  expose: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: io.expose },
  ipcRenderer: io,
  webUtils: {}
}))
const isolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated'),
  argv = process.argv
async function load(role: boolean, contextIsolated = true) {
  vi.resetModules()
  io.expose.mockReset()
  io.on.mockReset()
  io.removeListener.mockReset()
  io.invoke.mockReset()
  io.send.mockReset()
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: contextIsolated })
  process.argv = role ? [...argv, '--relay-floating-readonly-v1'] : argv
  await import('./index')
}
afterEach(() => {
  process.argv = argv
  if (isolated) Object.defineProperty(process, 'contextIsolated', isolated)
  else Reflect.deleteProperty(process, 'contextIsolated')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('exposes only the one-way floating subscription in its isolated role', async () => {
  await load(true)
  expect(io.expose.mock.calls.map((call) => call[0])).toEqual(['relayFloatingTraffic'])
  expect(Object.keys(io.expose.mock.calls[0][1])).toEqual(['onSnapshot'])
  expect(io.on).toHaveBeenCalledOnce()
  expect(io.on.mock.calls[0][0]).toBe('relayFloatingTraffic')
  expect(io.invoke).not.toHaveBeenCalled()
  expect(io.send).not.toHaveBeenCalled()
})
it('does not fall back to the main or DOM API if the floating role is not isolated', async () => {
  await load(true, false)
  expect(io.expose).not.toHaveBeenCalled()
  expect(io.on).not.toHaveBeenCalled()
  expect(io.invoke).not.toHaveBeenCalled()
})
it('removes its subscription if contextBridge exposure fails', async () => {
  vi.resetModules()
  io.expose.mockReset().mockImplementation(() => {
    throw Error('expose failed')
  })
  io.on.mockReset()
  io.removeListener.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  process.argv = [...argv, '--relay-floating-readonly-v1']
  await import('./index')
  expect(io.removeListener).toHaveBeenCalledOnce()
  expect(io.removeListener.mock.calls[0]).toEqual(io.on.mock.calls[0])
  expect(io.expose).toHaveBeenCalledOnce()
  io.expose.mockReset()
})
it('keeps the established main preload API in its original isolated role', async () => {
  vi.stubGlobal('window', { location: { hash: '#relay-floating-readonly-v1' } })
  await load(false)
  expect(io.expose.mock.calls.map((call) => call[0])).toEqual(['electron', 'api'])
  expect(io.expose.mock.calls[0][1].ipcRenderer.invoke).toBeTypeOf('function')
  expect(io.on).not.toHaveBeenCalled()
})
