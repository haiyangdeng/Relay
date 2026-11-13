import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestOnce } from '../../resolve/plugin/http-client'
import {
  codedError,
  CPX_TIMEOUT,
  CPX_REDIRECT_REFUSED,
  CPX_RESPONSE_TOO_LARGE
} from '../../resolve/plugin/errors'
import { downloadSubscription, SubscriptionTransferError } from './transfer'

vi.mock('../../resolve/plugin/http-client', () => ({ requestOnce: vi.fn() }))
const request = vi.mocked(requestOnce),
  url = 'https://sub.invalid/private?token=PRIVATE'
beforeEach(() => {
  request.mockReset().mockResolvedValue({ status: 200, headers: {}, body: '\ufeffproxies: []\n' })
})
afterEach(() => vi.unstubAllEnvs())
describe('Bounded explicit-proxy subscription transfer', () => {
  it('uses only the single-request transport with a fixed local proxy and byte/time bounds', async () => {
    const signal = new AbortController().signal
    expect(await downloadSubscription(url, 18191, signal)).toBe('\ufeffproxies: []\n')
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: 'GET',
        timeout: 15000,
        maxBytes: 2097152,
        proxy: { host: '127.0.0.1', port: 18191 },
        signal,
        headers: { 'User-Agent': 'clash.meta/Relay', 'Accept-Encoding': 'identity' }
      })
    )
  })
  it('maps errors without exposing URL, credentials or trying a second route', async () => {
    for (const [code, reason] of [
      [CPX_TIMEOUT, 'timeout'],
      [CPX_REDIRECT_REFUSED, 'redirect'],
      [CPX_RESPONSE_TOO_LARGE, 'size'],
      ['ECONNREFUSED', 'transport']
    ]) {
      request.mockClear().mockRejectedValue(codedError('PRIVATE URL ' + url, code))
      const error = await downloadSubscription(url, 18191, new AbortController().signal).catch(
        (error: unknown) => error
      )
      expect(error).toBeInstanceOf(SubscriptionTransferError)
      expect(error).toMatchObject({ reason })
      expect(String(error)).not.toContain('PRIVATE')
      expect(request).toHaveBeenCalledOnce()
    }
  })
  it('rejects partial responses, compressed content and ambiguous UTF-8 without saving or conversion', async () => {
    for (const response of [
      { status: 206, headers: {}, body: 'proxies: []' },
      { status: 200, headers: { 'content-encoding': 'gzip' }, body: 'proxies: []' },
      { status: 200, headers: {}, body: 'password: \ufffd' },
      { status: 200, headers: {}, body: 'password: \0' }
    ]) {
      request.mockResolvedValueOnce(response)
      await expect(
        downloadSubscription(url, 18191, new AbortController().signal)
      ).rejects.toBeInstanceOf(SubscriptionTransferError)
    }
  })
  it('refuses invalid port/URL injection and disabled TLS verification before opening a socket', async () => {
    await expect(
      downloadSubscription('file:///PRIVATE', 18191, new AbortController().signal)
    ).rejects.toThrow()
    await expect(downloadSubscription(url, 0, new AbortController().signal)).rejects.toThrow()
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    await expect(
      downloadSubscription(url, 18191, new AbortController().signal)
    ).rejects.toMatchObject({ reason: 'tlsContext' })
    expect(request).not.toHaveBeenCalled()
  })
})
