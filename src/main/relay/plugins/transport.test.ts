import { describe, expect, it, vi } from 'vitest'
import type { RelayPluginRecord } from '../../../shared/relay/plugins'
import { codedError, CPX_GUARD_REFUSED } from '../../resolve/plugin/errors'
import type { PluginRequestOptions, PluginResponse } from '../../resolve/plugin/http-client'
import { createRelayPluginContext } from './transport'

function fixture(route: RelayPluginRecord['route'] = 'proxy') {
  const record: RelayPluginRecord = {
    id: '00000000-0000-0000-0000-000000000036',
    route,
    approvedOrigins: ['https://provider.example'],
    status: 'needs-login',
    createdAt: 1,
    updatedAt: 1,
    descriptor: {
      magic: 'CPXF',
      v: 2,
      spec: 'cpx-plugin/2',
      loginUrl: 'https://provider.example/authorize',
      provider: { name: 'Fixture' }
    }
  }
  const controller = new AbortController(),
    request = vi.fn(
      async (_url: string, _options: PluginRequestOptions): Promise<PluginResponse> => ({
        status: 200,
        body: '{}',
        headers: {}
      })
    ),
    proxy = vi.fn(async () => ({ host: '127.0.0.1', port: 18191 })),
    resolveAll = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
  const context = createRelayPluginContext({
    record,
    signal: controller.signal,
    request,
    proxy,
    resolveAll
  })
  return { context, controller, request, proxy, resolveAll }
}
describe('Authorized plugin requests reuse the guarded HTTP client contract', () => {
  it('refuses ungranted origins, private hosts and unsafe protocols before any request', async () => {
    const f = fixture()
    for (const url of [
      'https://other.example/',
      'http://provider.example/',
      'https://127.0.0.1/',
      'https://u:p@provider.example/'
    ])
      await expect(
        f.context.requester.request(url, { method: 'GET', maxBytes: 100 })
      ).rejects.toThrow('未授权')
    expect(f.request).not.toHaveBeenCalled()
    expect(f.proxy).not.toHaveBeenCalled()
  })
  it('uses only the provided owned loopback proxy and never switches an explicit proxy request to direct', async () => {
    const f = fixture()
    await f.context.requester.request('https://provider.example/a', {
      method: 'GET',
      maxBytes: 100
    })
    expect(f.request).toHaveBeenLastCalledWith(
      'https://provider.example/a',
      expect.objectContaining({
        proxy: { host: '127.0.0.1', port: 18191 },
        maxBytes: 100,
        signal: f.controller.signal
      })
    )
    f.request.mockRejectedValueOnce(codedError('connection failed', 'ECONNREFUSED', 'pre-send'))
    await expect(
      f.context.requester.request('https://provider.example/b', { method: 'GET', maxBytes: 100 })
    ).rejects.toThrow('connection failed')
    expect(f.request).toHaveBeenCalledTimes(2)
  })
  it('blocks DNS private-address results before sending through a proxy', async () => {
    const f = fixture()
    f.resolveAll.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    await expect(
      f.context.requester.request('https://provider.example/', { method: 'GET', maxBytes: 100 })
    ).rejects.toMatchObject({ code: CPX_GUARD_REFUSED })
    expect(f.request).not.toHaveBeenCalled()
  })
  it('allows an explicitly selected auto route to retry only its read request and pins subsequent requests', async () => {
    const f = fixture('auto')
    f.request.mockRejectedValueOnce(codedError('unreachable', 'ECONNREFUSED', 'pre-send'))
    await f.context.requester.request('https://provider.example/', { method: 'GET', maxBytes: 100 })
    expect(f.request.mock.calls[0][1].proxy).toBeUndefined()
    expect(f.request.mock.calls[1][1].proxy?.port).toBe(18191)
    await f.context.requester.request('https://provider.example/next', {
      method: 'GET',
      maxBytes: 100
    })
    expect(f.request.mock.calls[2][1].proxy?.port).toBe(18191)
  })
  it('does not replay a potentially consuming POST across routes', async () => {
    const f = fixture('auto')
    f.request.mockRejectedValueOnce(codedError('uncertain', 'ECONNRESET', 'possibly-sent'))
    await expect(
      f.context.requester.request('https://provider.example/enroll', {
        method: 'POST',
        body: '{}',
        maxBytes: 100
      })
    ).rejects.toThrow('uncertain')
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.proxy).not.toHaveBeenCalled()
  })
  it('lets an auto route use its proxy after a POST connection failed before any request was sent', async () => {
    const f = fixture('auto')
    f.request.mockRejectedValueOnce(codedError('not sent', 'ECONNREFUSED', 'pre-send'))
    await f.context.requester.request('https://provider.example/enroll', {
      method: 'POST',
      body: '{}',
      maxBytes: 100
    })
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.request.mock.calls[1][1].proxy?.port).toBe(18191)
  })
  it('aborts while awaiting an owned proxy instead of holding the application exit indefinitely', async () => {
    const f = fixture()
    f.proxy.mockImplementationOnce(() => new Promise(() => {}))
    const reading = f.context.requester.request('https://provider.example/', {
      method: 'GET',
      maxBytes: 100
    })
    const rejected = expect(reading).rejects.toThrow()
    await vi.waitFor(() => expect(f.proxy).toHaveBeenCalled())
    f.controller.abort()
    await rejected
    expect(f.request).not.toHaveBeenCalled()
  })
  it('decodes raw bytes strictly instead of saving a config with silently replaced credentials', async () => {
    const f = fixture('direct')
    f.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: '',
      bytes: Buffer.from([0xc3, 0x28])
    })
    await expect(
      f.context.requester.request('https://provider.example/config', {
        method: 'GET',
        maxBytes: 100
      })
    ).rejects.toThrow()
    expect(f.request.mock.calls[0][1].binary).toBe(true)
  })
})
