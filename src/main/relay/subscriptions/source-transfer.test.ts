import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestOnce } from '../../resolve/plugin/http-client'
import { generateAgeKeyPair, encryptAgeContent } from '../../utils/age'
import { profileHash } from '../profiles/source'
import { sourceOptions, sourceRegistration, sourceMetadata } from './source-options'
import { transferSubscriptionSource, responseMetadata } from './source-transfer'

vi.mock('../../resolve/plugin/http-client', () => ({ requestOnce: vi.fn() }))
const request = vi.mocked(requestOnce),
  url = 'https://subscription.invalid/PRIVATE?token=PRIVATE',
  text = 'proxies: [{name: Node, type: http, server: 127.0.0.1, port: 18192}]',
  signal = () => new AbortController().signal
afterEach(() => {
  request.mockReset()
  vi.unstubAllEnvs()
})
describe('Bounded source transfer and compatibility', () => {
  it('supports explicit private headers through a fixed local proxy and returns only whitelisted response metadata', async () => {
    request.mockResolvedValue({
      status: 200,
      body: text,
      headers: {
        etag: '"PRIVATE"',
        'subscription-userinfo': 'upload=1; download=2; total=100; expire=123',
        'profile-update-interval': '2',
        'profile-web-page-url': 'https://billing.invalid/PRIVATE',
        'content-disposition': "attachment; filename*=UTF-8''nodes%20file.yaml",
        'set-cookie': ['PRIVATE']
      }
    })
    const options = { ...sourceOptions(undefined), headers: { authorization: 'Bearer PRIVATE' } },
      r = await transferSubscriptionSource(url, 18191, signal(), options)
    expect(r.text).toBe(text)
    expect(r.metadata).toMatchObject({
      quota: { upload: 1, download: 2, total: 100, expire: 123 },
      intervalMinutes: 120,
      homeOrigin: 'https://billing.invalid',
      filename: 'nodes file.yaml'
    })
    expect(r.metadata).not.toHaveProperty('set-cookie')
    expect(request).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer PRIVATE' }),
        proxy: { host: '127.0.0.1', port: 18191 },
        maxBytes: 2097152,
        captureRedirects: true
      })
    )
  })
  it('sends conditional validators only to the bound resource and refuses unsolicited 304', async () => {
    const cache = {
      checkedAt: new Date().toISOString(),
      status: 200 as const,
      resourceSHA256: profileHash(url),
      etag: '"v1"',
      quota: { total: 100 }
    }
    request.mockResolvedValue({ status: 304, headers: { etag: '"v1"' }, body: '' })
    expect(await transferSubscriptionSource(url, 18191, signal(), undefined, cache)).toMatchObject({
      status: 'notModified',
      metadata: { status: 304, quota: { total: 100 } }
    })
    expect(request.mock.calls[0][1].headers).toHaveProperty('if-none-match', '"v1"')
    await expect(transferSubscriptionSource(url, 18191, signal())).rejects.toThrow('缓存')
    await expect(
      transferSubscriptionSource(url, 18191, signal(), undefined, {
        ...cache,
        resourceSHA256: '0'.repeat(64)
      })
    ).rejects.toThrow()
  })
  it('requires opt-in for redirects and drops all private headers across HTTPS origins', async () => {
    request.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://next.invalid/config' },
      body: ''
    })
    await expect(transferSubscriptionSource(url, 18191, signal())).rejects.toThrow()
    const options = {
      ...sourceOptions(undefined),
      redirects: 'https' as const,
      headers: { authorization: 'Bearer PRIVATE', cookie: 'PRIVATE', 'x-token': 'PRIVATE' }
    }
    request
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'https://next.invalid/config' },
        body: ''
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: text })
    expect((await transferSubscriptionSource(url, 18191, signal(), options)).status).toBe(
      'downloaded'
    )
    expect(request.mock.calls.at(-1)?.[1].headers).toEqual({
      'user-agent': 'clash.meta/Relay',
      'accept-encoding': 'identity'
    })
    expect(request.mock.calls.every(([, opts]) => opts.proxy?.port === 18191)).toBe(true)
  })
  it('rejects same-origin violations, loops, TLS downgrades and excessive chains without fallback', async () => {
    for (const [policy, location] of [
      ['same-origin', 'https://next.invalid/config'],
      ['https', 'http://next.invalid/config'],
      ['https', url]
    ] as const) {
      request.mockReset().mockResolvedValue({ status: 302, headers: { location }, body: '' })
      await expect(
        transferSubscriptionSource(url, 18191, signal(), {
          ...sourceOptions(undefined),
          redirects: policy
        })
      ).rejects.toThrow()
      expect(request).toHaveBeenCalledOnce()
    }
    request
      .mockReset()
      .mockImplementation(async (u) => ({ status: 302, headers: { location: u + 'x' }, body: '' }))
    await expect(
      transferSubscriptionSource(url, 18191, signal(), {
        ...sourceOptions(undefined),
        redirects: 'same-origin'
      })
    ).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(6)
  })
  it('shares the selected total budget and keeps a temporary default User-Agent within origin', async () => {
    const cache = {
      checkedAt: new Date().toISOString(),
      status: 200 as const,
      resourceSHA256: profileHash(url),
      etag: '"prior-agent"'
    }
    let now = 10000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now),
      monotonic = vi.spyOn(performance, 'now').mockReturnValue(100)
    const tuning = { timeoutSeconds: 4, userAgent: 'Selected-Agent/1' },
      options = { ...sourceOptions(undefined), redirects: 'https' as const }
    try {
      request
        .mockImplementationOnce(async () => {
          now += 1300
          return { status: 302, headers: { location: 'https://next.invalid/source' }, body: '' }
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: { etag: '"temporary-agent"', 'last-modified': 'yesterday' },
          body: text
        })
      const result = await transferSubscriptionSource(url, 18191, signal(), options, cache, tuning)
      expect(result.metadata).not.toHaveProperty('etag')
      expect(result.metadata).not.toHaveProperty('lastModified')
      expect(request.mock.calls[0][1]).toMatchObject({
        timeout: 4000,
        proxy: { host: '127.0.0.1', port: 18191 },
        headers: { 'user-agent': tuning.userAgent }
      })
      expect(request.mock.calls[0][1].headers).not.toHaveProperty('if-none-match')
      expect(request.mock.calls[1][1]).toMatchObject({
        timeout: 2700,
        proxy: { host: '127.0.0.1', port: 18191 },
        headers: { 'user-agent': 'clash.meta/Relay' }
      })
      request.mockResolvedValueOnce({ status: 304, body: '', headers: {} })
      await expect(
        transferSubscriptionSource(
          url,
          18191,
          signal(),
          { ...options, headers: { 'User-Agent': 'Saved-Agent/1' } },
          cache,
          tuning
        )
      ).resolves.toMatchObject({ status: 'notModified', metadata: { etag: cache.etag } })
      expect(request.mock.calls[2][1].headers).toMatchObject({
        'user-agent': 'Saved-Agent/1',
        'if-none-match': cache.etag
      })
    } finally {
      clock.mockRestore()
      monotonic.mockRestore()
    }
  })
  it('rejects partial wall-clock rollback and independent monotonic expiry across the chosen budget', async () => {
    let wall = 10000,
      mono = 100
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => wall),
      monoClock = vi.spyOn(performance, 'now').mockImplementation(() => mono)
    const options = { ...sourceOptions(undefined), redirects: 'same-origin' as const },
      tuning = { timeoutSeconds: 4 }
    try {
      request
        .mockImplementationOnce(async () => {
          wall += 1000
          mono += 30
          return { status: 302, headers: { location: '/next' }, body: '' }
        })
        .mockImplementationOnce(async () => {
          wall -= 100
          mono += 20
          return { status: 200, headers: {}, body: text }
        })
      await expect(
        transferSubscriptionSource(url, 18191, signal(), options, undefined, tuning)
      ).rejects.toThrow('未通过')
      expect(request).toHaveBeenCalledTimes(2)
      request.mockReset().mockImplementationOnce(async () => {
        wall += 1
        mono += 4000
        return { status: 302, headers: { location: '/next' }, body: '' }
      })
      await expect(
        transferSubscriptionSource(url, 18191, signal(), options, undefined, tuning)
      ).rejects.toThrow('未通过')
      expect(request).toHaveBeenCalledOnce()
    } finally {
      wallClock.mockRestore()
      monoClock.mockRestore()
    }
  })
  it('decrypts native AGE YAML and refuses wrong or absent identities without exposing keys', async () => {
    const keys = await generateAgeKeyPair(),
      cipher = await encryptAgeContent('\ufeff' + text, keys.recipient)
    request.mockResolvedValue({ status: 200, headers: {}, body: cipher })
    const result = await transferSubscriptionSource(url, 18191, signal(), {
      ...sourceOptions(undefined),
      ageSecretKey: keys.secretKey
    })
    expect(result.text).toBe('\ufeff' + text)
    const err = await transferSubscriptionSource(url, 18191, signal()).catch((e: unknown) => e)
    expect(String(err)).not.toContain(keys.secretKey)
    expect(String(err)).toContain('解密')
  })
  it('refuses malformed metadata, credential header injection and second-based cron schedules', () => {
    for (const options of [
      { ...sourceOptions(undefined), headers: { Host: 'PRIVATE' } },
      { ...sourceOptions(undefined), headers: JSON.parse('{"__proto__":"PRIVATE"}') },
      { ...sourceOptions(undefined), headers: { 'If-None-Match': 'PRIVATE' } },
      { ...sourceOptions(undefined), schedule: { kind: 'cron', expression: '* * * * * *' } },
      { ...sourceOptions(undefined), ageSecretKey: 'not a key' }
    ])
      expect(() => sourceOptions(options)).toThrow()
    expect(
      sourceOptions({
        ...sourceOptions(undefined),
        schedule: { kind: 'cron', expression: '*/5 * * * *' }
      }).schedule.kind
    ).toBe('cron')
    expect(() =>
      sourceRegistration({
        name: 'Fixture',
        url,
        proxyPort: 18191,
        options: sourceOptions(undefined),
        path: '/PRIVATE'
      })
    ).toThrow()
    expect(() => sourceMetadata({ checkedAt: 'now', status: 200, resourceSHA256: 'x' })).toThrow()
    expect(
      responseMetadata(
        { 'subscription-userinfo': 'upload=-1; total=nan', 'profile-update-interval': 'nan' },
        url,
        200
      ).quota
    ).toBeUndefined()
  })
})
