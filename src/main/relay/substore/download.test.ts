import { createHash } from 'crypto'
import { createServer } from 'http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestOnce } from '../../resolve/plugin/http-client'
import { downloadSubStoreAsset } from './resources'
vi.mock('../../resolve/plugin/http-client', () => ({ requestOnce: vi.fn() }))
const bytes = Buffer.from('fixture asset'),
  pin = {
    version: 'fixture',
    releaseURL: 'https://github.com/sub-store-org/Sub-Store/releases/tag/fixture',
    url: 'https://github.com/sub-store-org/Sub-Store/releases/download/fixture/sub-store.bundle.js',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})
describe('Fixed Sub-Store asset download routing', () => {
  it('uses the same explicit proxy across official asset redirects and verifies final fixed bytes', async () => {
    vi.mocked(requestOnce)
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/fixture' },
        body: ''
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: '', bytes })
    expect(await downloadSubStoreAsset(pin, 17899, new AbortController().signal)).toEqual(bytes)
    expect(requestOnce).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(requestOnce).mock.calls)
      expect(call[1]).toMatchObject({
        proxy: { host: '127.0.0.1', port: 17899 },
        binary: true,
        captureRedirects: true,
        maxBytes: pin.size
      })
  })
  it('refuses a foreign redirect before contacting it and does not retry a bad asset', async () => {
    vi.mocked(requestOnce).mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://untrusted.invalid/asset' },
      body: ''
    })
    await expect(downloadSubStoreAsset(pin, 17899, new AbortController().signal)).rejects.toThrow(
      '来源无效'
    )
    expect(requestOnce).toHaveBeenCalledTimes(1)
    vi.mocked(requestOnce)
      .mockReset()
      .mockResolvedValueOnce({ status: 200, headers: {}, body: '', bytes: Buffer.from('tampered') })
    await expect(downloadSubStoreAsset(pin, 17899, new AbortController().signal)).rejects.toThrow(
      '固定摘要'
    )
    expect(requestOnce).toHaveBeenCalledTimes(1)
  })
  it('rejects an environment that disables TLS before a request is made', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    await expect(downloadSubStoreAsset(pin, 17899, new AbortController().signal)).rejects.toThrow(
      'TLS'
    )
    expect(requestOnce).not.toHaveBeenCalled()
  })
  it('satisfies the real shared HTTP transport redirect contract through an isolated local proxy', async () => {
    const transport = await vi.importActual<typeof import('../../resolve/plugin/http-client')>(
      '../../resolve/plugin/http-client'
    )
    const observed: string[] = []
    const proxy = createServer((req, res) => {
      observed.push(req.url ?? '')
      if ((req.url ?? '').endsWith('/fixture')) {
        res.writeHead(200)
        res.end(bytes)
      } else {
        res.writeHead(302, { location: 'https://release-assets.githubusercontent.com/fixture' })
        res.end()
      }
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address()
    if (!address || typeof address !== 'object') throw new Error('missing local proxy')
    try {
      vi.mocked(requestOnce).mockImplementation((url, options) =>
        transport.requestOnce('http://asset-fixture.invalid' + new URL(url).pathname, options)
      )
      expect(await downloadSubStoreAsset(pin, address.port, new AbortController().signal)).toEqual(
        bytes
      )
      expect(observed).toHaveLength(2)
      expect(observed[1]).toBe('http://asset-fixture.invalid/fixture')
    } finally {
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve())
        proxy.closeAllConnections()
      })
    }
  })
})
