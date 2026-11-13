import http from 'http'
import { describe, expect, it, vi } from 'vitest'
import { browserLogin } from '../../resolve/plugin/oauth'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
describe('Relay plugin OAuth cancellation owns only its temporary callback listener', () => {
  it('does not open the browser or bind a callback after an already cancelled signal', async () => {
    const controller = new AbortController(),
      open = vi.fn()
    controller.abort()
    await expect(
      browserLogin('https://provider.example/authorize', { open, signal: controller.signal })
    ).rejects.toThrow('cancelled')
    expect(open).not.toHaveBeenCalled()
  })
  it('rejects a pending login and releases the temporary loopback listener on cancellation', async () => {
    const controller = new AbortController(),
      open = vi.fn(async (_url: string) => {})
    const login = browserLogin('https://provider.example/authorize', {
      open,
      signal: controller.signal
    })
    const rejected = expect(login).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(open).toHaveBeenCalled())
    const callback = new URL(open.mock.calls[0][0]).searchParams.get('redirect_uri')
    if (!callback) throw new Error('Missing callback')
    controller.abort()
    await rejected
    await expect(
      new Promise<void>((resolve, reject) => {
        http
          .get(callback, (response) => {
            response.resume()
            resolve()
          })
          .on('error', reject)
      })
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})
