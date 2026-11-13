import { mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestOnce } from '../../resolve/plugin/http-client'
import { downloadBinaryResource, readBinaryResource, RESOURCE_BYTE_LIMIT } from './source'

vi.mock('../../resolve/plugin/http-client', () => ({ requestOnce: vi.fn() }))
const request = vi.mocked(requestOnce),
  url = 'https://resource.invalid/PRIVATE?token=PRIVATE'
afterEach(() => {
  request.mockReset()
  vi.unstubAllEnvs()
})
describe('Bounded binary resource acquisition', () => {
  it('preserves non-UTF8 bytes through one explicit proxy route and private headers', async () => {
    const bytes = Buffer.from([255, 0, 195, 40])
    request.mockResolvedValue({ status: 200, headers: {}, body: '', bytes })
    expect(
      await downloadBinaryResource(url, 18191, new AbortController().signal, {
        Authorization: 'Bearer PRIVATE'
      })
    ).toEqual(bytes)
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        binary: true,
        timeout: 60000,
        maxBytes: RESOURCE_BYTE_LIMIT,
        proxy: { host: '127.0.0.1', port: 18191 },
        headers: expect.objectContaining({ authorization: 'Bearer PRIVATE' })
      })
    )
  })
  it('refuses partial, compressed, redirected or empty responses without a second request', async () => {
    for (const response of [
      { status: 206, headers: {}, body: '', bytes: Buffer.from('x') },
      { status: 200, headers: { 'content-encoding': 'gzip' }, body: '', bytes: Buffer.from('x') },
      { status: 302, headers: { location: 'https://must-not-fetch.invalid' }, body: '' },
      { status: 200, headers: {}, body: '', bytes: Buffer.alloc(0) }
    ]) {
      request.mockClear().mockResolvedValueOnce(response)
      await expect(
        downloadBinaryResource(url, 18191, new AbortController().signal)
      ).rejects.toThrow('不重试')
      expect(request).toHaveBeenCalledOnce()
    }
  })
  it('does not request after cancellation, invalid headers or globally disabled TLS verification', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(downloadBinaryResource(url, 18191, controller.signal)).rejects.toThrow()
    await expect(
      downloadBinaryResource(url, 18191, new AbortController().signal, { Host: 'PRIVATE' })
    ).rejects.toThrow()
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    await expect(downloadBinaryResource(url, 18191, new AbortController().signal)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('Small file readers can lower the resource budget without weakening existing checks', () => {
  it('checks the requested budget before allocating and preserves the existing default', async () => {
    const root = await realpath(await mkdtemp('/private/tmp/relay-css-read-')),
      path = join(root, 'style.css')
    try {
      await writeFile(path, 'a'.repeat(8192), { mode: 0o600 })
      expect((await readBinaryResource(path, false, 8192)).length).toBe(8192)
      await writeFile(path, 'b'.repeat(8193), { mode: 0o600 })
      await expect(readBinaryResource(path, false, 8192)).rejects.toThrow('大小')
      expect((await readBinaryResource(path)).length).toBe(8193)
      for (const limit of [0, -1, NaN, Infinity, 0.5, RESOURCE_BYTE_LIMIT + 1])
        await expect(readBinaryResource('/missing', false, limit)).rejects.toThrow('预算')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
