import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startRenderer } from './init'

const ipc = vi.hoisted(() => ({ getPlatform: vi.fn(), getVersion: vi.fn() }))
const language = vi.hoisted(() => ({ initializeI18n: vi.fn() }))
vi.mock('./ipc', () => ipc)
vi.mock('../i18n', () => language)

beforeEach(() => {
  vi.resetAllMocks()
  ipc.getPlatform.mockResolvedValue('darwin')
  ipc.getVersion.mockResolvedValue('2.0.0-dev.3')
  language.initializeI18n.mockResolvedValue(undefined)
})

describe('renderer bootstrap failures', () => {
  it.each(['getPlatform', 'getVersion'] as const)(
    'shows a %s rejection before React mounts',
    async (channel) => {
      const error = new Error(`${channel} unavailable`)
      ipc[channel].mockRejectedValue(error)
      const render = vi.fn()
      const failed = vi.fn()
      await startRenderer(render, failed)
      expect(render).not.toHaveBeenCalled()
      expect(failed).toHaveBeenCalledExactlyOnceWith(error)
    }
  )

  it('waits for both bootstrap replies before mounting', async () => {
    let resolve!: (value: string) => void
    ipc.getVersion.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done
      })
    )
    const render = vi.fn()
    const failed = vi.fn()
    const startup = startRenderer(render, failed)
    await Promise.resolve()
    expect(render).not.toHaveBeenCalled()
    resolve('2.0.0-dev.3')
    await startup
    expect(render).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()
  })

  it('shows a synchronous mount failure rather than losing the rejected promise', async () => {
    const error = new Error('root missing')
    const failed = vi.fn()
    await startRenderer(() => {
      throw error
    }, failed)
    expect(failed).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('waits for language initialization and presents its failure before mounting', async () => {
    let reject!: (error: Error) => void
    language.initializeI18n.mockImplementation(
      () =>
        new Promise<void>((_resolve, failed) => {
          reject = failed
        })
    )
    const render = vi.fn()
    const failed = vi.fn()
    const startup = startRenderer(render, failed)
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    expect(render).not.toHaveBeenCalled()
    const error = new Error('language configuration unavailable')
    reject(error)
    await startup
    expect(render).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledExactlyOnceWith(error)
  })
})
