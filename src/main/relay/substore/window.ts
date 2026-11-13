import { randomUUID } from 'crypto'
import { BrowserWindow, session } from 'electron'

export function subStoreWindowRequest(url: string, origins: readonly string[]): boolean {
  try {
    const target = new URL(url)
    return (
      target.protocol === 'http:' &&
      target.hostname === '127.0.0.1' &&
      !target.username &&
      !target.password &&
      !!target.port &&
      origins.includes(target.origin)
    )
  } catch {
    return false
  }
}

export async function openSubStoreWindow(adapters: {
  frontendURL(): string | undefined
  allowedOrigins(): readonly string[]
}): Promise<BrowserWindow> {
  const url = adapters.frontendURL()
  if (!url || !subStoreWindowRequest(url, adapters.allowedOrigins()))
    throw new Error('本次Sub-Store前端尚未就绪。')
  const isolated = session.fromPartition('relay-substore-' + randomUUID(), { cache: false })
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !subStoreWindowRequest(details.url, adapters.allowedOrigins()) })
  )
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.on('will-download', (event) => event.preventDefault())
  const window = new BrowserWindow({
    title: 'Relay · Sub-Store',
    width: 1060,
    height: 760,
    show: false,
    webPreferences: {
      session: isolated,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const guardNavigation = (event: { preventDefault(): void }, target: string): void => {
    if (!subStoreWindowRequest(target, [new URL(url).origin]) || !adapters.frontendURL())
      event.preventDefault()
  }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)
  try {
    await window.loadURL(url)
    window.show()
    return window
  } catch (error) {
    window.destroy()
    throw error
  }
}
