import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({ getAppConfig: vi.fn(), getPlatform: vi.fn(), getVersion: vi.fn() }))
vi.mock('./utils/ipc', () => ipc)
vi.mock('./components/relay/preview-controls', () => ({ RELAY_PREVIEW_ONLY: true }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  ipc.getPlatform.mockResolvedValue('darwin')
  ipc.getVersion.mockResolvedValue('2.0.0-dev.3')
  ipc.getAppConfig.mockResolvedValue({ language: 'en-US' })
  vi.stubGlobal('document', { documentElement: {} })
  vi.stubGlobal('window', {
    electron: { ipcRenderer: { invoke: vi.fn().mockResolvedValue(undefined) } }
  })
})

afterEach(async () => {
  const { default: i18n } = await import('../../shared/i18n')
  i18n.off('languageChanged')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('language bootstrap using the installed i18next implementation', () => {
  it('does not start a detached config request during module evaluation', async () => {
    await import('./i18n')
    expect(ipc.getAppConfig).not.toHaveBeenCalled()
  })

  it('routes a rejected config read to bootstrap failure and does not retry it', async () => {
    const error = new Error('saved language read failed')
    ipc.getAppConfig.mockRejectedValue(error)
    const { startRenderer } = await import('./utils/init')
    const { initializeI18n } = await import('./i18n')
    const render = vi.fn(),
      failure = vi.fn()
    await startRenderer(render, failure)
    expect(render).not.toHaveBeenCalled()
    expect(failure).toHaveBeenCalledExactlyOnceWith(error)
    await expect(initializeI18n()).rejects.toBe(error)
    expect(ipc.getAppConfig).toHaveBeenCalledOnce()
  })

  it('catches an i18next rejection after a successful config read', async () => {
    const { default: i18n } = await import('../../shared/i18n')
    const error = new Error('resource initialization failed')
    vi.spyOn(i18n, 'init').mockRejectedValueOnce(error)
    const { startRenderer } = await import('./utils/init')
    const render = vi.fn(),
      failure = vi.fn()
    await startRenderer(render, failure)
    expect(render).not.toHaveBeenCalled()
    expect(failure).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('shares initialization and renders a real translation hook with saved resources ready', async () => {
    const { initializeI18n, default: i18n } = await import('./i18n')
    const { useTranslation } = await import('react-i18next')
    const first = initializeI18n()
    expect(initializeI18n()).toBe(first)
    await first
    expect(ipc.getAppConfig).toHaveBeenCalledOnce()
    expect(i18n.language).toBe('en-US')
    const { startRenderer } = await import('./utils/init')
    const failed = vi.fn()
    let rendered = ''
    await startRenderer(() => {
      function Content() {
        const { ready } = useTranslation()
        return createElement('span', null, ready ? 'translated-content-ready' : 'not-ready')
      }
      rendered = renderToStaticMarkup(createElement(Content))
    }, failed)
    expect(rendered).toBe('<span>translated-content-ready</span>')
    expect(failed).not.toHaveBeenCalled()
    expect(ipc.getAppConfig).toHaveBeenCalledOnce()
  })
})
