import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginRequestOptions, PluginResponse } from '../../resolve/plugin/http-client'
import { descriptorSource, downloadDescriptor } from './descriptor-source'

const source = { url: 'https://provider.example/plugin.cpx?download=1', route: 'proxy' as const }
function fixture() {
  const controller = new AbortController(),
    request = vi.fn(
      async (_url: string, _options: PluginRequestOptions): Promise<PluginResponse> => ({
        status: 200,
        headers: {},
        body: '{}',
        bytes: Buffer.from('{}')
      })
    ),
    proxy = vi.fn(async () => ({ host: '127.0.0.1', port: 18191 })),
    resolveAll = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
  return { controller, request, proxy, resolveAll }
}
afterEach(() => vi.unstubAllEnvs())
describe('Remote CPX public descriptor transport', () => {
  it('rejects arbitrary fields, inline credentials, non-public and non-HTTPS destinations before requesting', () => {
    for (const url of [
      'file:///etc/hosts',
      'http://provider.example/plugin.cpx',
      'https://127.0.0.1/a',
      'https://user:pass@provider.example/a',
      'https://provider.example/a#fragment',
      'https://provider.example/a\n'
    ])
      expect(() => descriptorSource({ ...source, url })).toThrow()
    expect(() => descriptorSource({ ...source, headers: { Authorization: 'secret' } })).toThrow()
    expect(() => descriptorSource({ ...source, route: 'unknown' })).toThrow()
  })
  it('uses a GET through the verified proxy with a bounded response and no credential headers', async () => {
    const f = fixture()
    expect(await downloadDescriptor(source, f.controller.signal, f)).toBe('{}')
    expect(f.proxy).toHaveBeenCalledOnce()
    expect(f.request).toHaveBeenCalledWith(
      source.url,
      expect.objectContaining({
        method: 'GET',
        maxBytes: 1024 * 1024,
        binary: true,
        proxy: { host: '127.0.0.1', port: 18191 },
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' }
      })
    )
    expect(f.request.mock.calls[0][1].captureRedirects).toBeUndefined()
  })
  it('uses guarded DNS for an explicitly direct download, without calling a proxy', async () => {
    const f = fixture()
    await downloadDescriptor({ ...source, route: 'direct' }, f.controller.signal, f)
    expect(f.proxy).not.toHaveBeenCalled()
    expect(f.request.mock.calls[0][1].lookup).toBeTypeOf('function')
    expect(f.request.mock.calls[0][1].proxy).toBeUndefined()
  })
  it('refuses private DNS answers before using the proxy and does not silently fall back to direct', async () => {
    const f = fixture()
    f.resolveAll.mockResolvedValue([{ address: '10.0.0.1', family: 4 }])
    await expect(downloadDescriptor(source, f.controller.signal, f)).rejects.toThrow()
    expect(f.request).not.toHaveBeenCalled()
    expect(f.proxy).not.toHaveBeenCalled()
  })
  it.each([302, 401, 500])('rejects HTTP %s without following any target', async (status) => {
    const f = fixture()
    f.request.mockResolvedValue({
      status,
      headers: { location: 'https://other.example' },
      body: '{}',
      bytes: Buffer.from('{}')
    })
    await expect(downloadDescriptor(source, f.controller.signal, f)).rejects.toThrow('未确认')
    expect(f.request).toHaveBeenCalledOnce()
  })
  it('enforces the size budget and strict UTF-8 even with an injected transport', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: '',
      bytes: Buffer.alloc(1024 * 1024 + 1, 97)
    })
    await expect(downloadDescriptor(source, f.controller.signal, f)).rejects.toThrow('1MiB')
    f.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: '',
      bytes: Buffer.from([0xff])
    })
    await expect(downloadDescriptor(source, f.controller.signal, f)).rejects.toThrow()
  })
  it('refuses disabled TLS verification before any request or proxy lookup', async () => {
    const f = fixture()
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    await expect(downloadDescriptor(source, f.controller.signal, f)).rejects.toThrow('TLS')
    expect(f.request).not.toHaveBeenCalled()
    expect(f.proxy).not.toHaveBeenCalled()
  })
  it('never returns a draft after aborting a pending verified proxy lookup', async () => {
    const f = fixture()
    f.proxy.mockImplementationOnce(() => new Promise(() => {}))
    const pending = downloadDescriptor(source, f.controller.signal, f),
      rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(f.proxy).toHaveBeenCalled())
    f.controller.abort()
    await rejected
    expect(f.request).not.toHaveBeenCalled()
  })
})
