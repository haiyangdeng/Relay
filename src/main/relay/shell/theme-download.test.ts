import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestOnce } from '../../resolve/plugin/http-client'
import { officialThemeURL } from '../../../shared/relay/shell-themes'
import { downloadOnlineThemes } from './theme-download'

vi.mock('../../resolve/plugin/http-client', () => ({ requestOnce: vi.fn() }))
const request = vi.mocked(requestOnce)
afterEach(() => {
  request.mockReset()
  vi.unstubAllEnvs()
})
const response = (status = 200, headers = {}, bytes = Buffer.from('ZIP')) => ({
  status,
  headers,
  bytes,
  body: ''
})
describe('Fixed official theme download through one explicit own proxy', () => {
  it('retains raw bytes and the same proxy, bounded budget and identity across redirects', async () => {
    request
      .mockResolvedValueOnce(
        response(302, {
          location: 'https://release-assets.githubusercontent.com/asset?signature=opaque'
        })
      )
      .mockResolvedValueOnce(response())
    const signal = new AbortController().signal
    expect(await downloadOnlineThemes(18191, signal)).toEqual(Buffer.from('ZIP'))
    expect(request.mock.calls[0][0]).toBe(officialThemeURL)
    for (const [, options] of request.mock.calls)
      expect(options).toMatchObject({
        proxy: { host: '127.0.0.1', port: 18191 },
        signal,
        binary: true,
        captureRedirects: true,
        maxBytes: 8 * 1024 * 1024,
        headers: { 'user-agent': 'Relay', 'accept-encoding': 'identity' }
      })
    expect(request.mock.calls[1][1].timeout).toBeLessThanOrEqual(request.mock.calls[0][1].timeout)
  })
  it.each([
    'http://github.com/file',
    'https://evil.example/file',
    'https://github.com:444/file',
    'https://user@github.com/file'
  ])('rejects redirect %s without following it', async (location) => {
    request.mockResolvedValueOnce(response(302, { location }))
    await expect(downloadOnlineThemes(18191, new AbortController().signal)).rejects.toThrow('来源')
    expect(request).toHaveBeenCalledOnce()
  })
  it('limits all redirects without retrying or falling back direct', async () => {
    request.mockResolvedValue(response(302, { location: 'https://github.com/again' }))
    await expect(downloadOnlineThemes(18191, new AbortController().signal)).rejects.toThrow('次数')
    expect(request).toHaveBeenCalledTimes(4)
  })
  it('rejects cancelled, TLS-disabled, malformed-port and failed responses before admission', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(downloadOnlineThemes(18191, controller.signal)).rejects.toThrow('取消')
    await expect(downloadOnlineThemes(80, new AbortController().signal)).rejects.toThrow('端口')
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    await expect(downloadOnlineThemes(18191, new AbortController().signal)).rejects.toThrow('TLS')
    expect(request).not.toHaveBeenCalled()
  })
  it.each([
    response(304),
    response(200, { 'content-encoding': 'gzip' }),
    response(200, {}, Buffer.alloc(0)),
    response(200, {}, Buffer.alloc(8 * 1024 * 1024 + 1))
  ])('rejects incomplete or unbounded response %#', async (reply) => {
    request.mockResolvedValueOnce(reply)
    await expect(downloadOnlineThemes(18191, new AbortController().signal)).rejects.toThrow(
      '完整响应'
    )
    expect(request).toHaveBeenCalledOnce()
  })
  it('rejects bytes that arrive after cancellation and makes no retry', async () => {
    const controller = new AbortController()
    request.mockImplementationOnce(async () => {
      controller.abort()
      return response()
    })
    await expect(downloadOnlineThemes(18191, controller.signal)).rejects.toThrow('取消')
    expect(request).toHaveBeenCalledOnce()
  })
})
