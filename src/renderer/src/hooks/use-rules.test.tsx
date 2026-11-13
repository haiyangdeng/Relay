import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { RulesProvider } from './use-rules'

vi.mock('@renderer/utils/ipc', () => vi.importActual('../utils/ipc'))

vi.mock('swr', () => ({
  default: (key: string, fetcher: (key: string) => Promise<unknown>) => {
    // SWR calls its fetcher with the cache key. Keep the real renderer IPC
    // adapter so this test observes the arguments delivered to preload.
    void fetcher(key)
    return { mutate: vi.fn() }
  }
}))

afterEach(() => vi.unstubAllGlobals())

it('requests startup rules without forwarding the SWR key as an IPC argument', () => {
  const invoke = vi.fn().mockResolvedValue({ rules: [] })
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })

  renderToStaticMarkup(createElement(RulesProvider, null, null))

  expect(invoke.mock.calls).toEqual([['mihomoRules']])
})
