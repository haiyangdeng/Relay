import { createServer } from 'http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestOnce } from '../../resolve/plugin/http-client'
import { generateAgeKeyPair } from '../../utils/age'
import { remoteBackupRequest, remoteBackupEndpoint } from '../../../shared/relay/backup-remote'
import { createRemoteBackupTransport, encodeRemoteArchive, decodeRemoteArchive } from './remote'

const webdav = {
  provider: 'webdav' as const,
  action: 'upload' as const,
  url: 'https://dav.example/Relay/unique.json',
  username: 'fixture-user',
  password: 'fixture-password',
  proxyPort: 17891
}
const signal = (): AbortSignal => new AbortController().signal
const response = (status: number, bytes: Buffer = Buffer.alloc(0)) => ({
  status,
  bytes,
  body: '',
  headers: {}
})
const gist = (envelope: Buffer, overrides: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      id: 'a'.repeat(32),
      public: false,
      truncated: false,
      files: {
        'relay-backup.json': {
          truncated: false,
          content: envelope.toString('utf8'),
          raw_url: 'https://foreign.example/secret'
        }
      },
      ...overrides
    })
  )
afterEach(() => vi.unstubAllEnvs())

describe('Remote backup fixed request and content contract', () => {
  it('drains an already dispatched upload when its submission observer throws', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof response>>(),
      request = vi.fn<typeof requestOnce>(() => pending.promise),
      transport = createRemoteBackupTransport(request)
    let settled = false
    const result = transport
      .upload(webdav, Buffer.from('envelope'), signal(), undefined, {
        assertLive: () => {},
        submitted: () => {
          throw new Error('PRIVATE-observer-failure')
        }
      })
      .then((value) => {
        settled = true
        return value
      })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    pending.resolve(response(201))
    expect(await result).toEqual({ status: 'uncertain', gistId: undefined })
    expect(request.mock.calls.map(([, options]) => options.method)).toEqual(['PUT'])
  })
  it('dispatches conditional deletion while live before its observer can revoke authority', async () => {
    let live = true
    const calls: { method: string; live: boolean }[] = [],
      check = (): void => {
        if (!live) throw new Error('fixture authority revoked')
      },
      transport = createRemoteBackupTransport(async (_url, options) => {
        calls.push({ method: options.method ?? 'GET', live })
        if (options.method === 'PROPFIND')
          return response(
            207,
            Buffer.from(
              `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${webdav.url}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1</d:getcontentlength><d:getetag>"fixture-v1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
            )
          )
        return response(204)
      })
    expect(
      await transport.delete(
        { ...webdav, action: 'delete', etag: '"fixture-v1"' },
        signal(),
        async () => check(),
        {
          assertLive: check,
          submitted: () => {
            live = false
          }
        }
      )
    ).toEqual({ status: 'uncertain' })
    expect(calls).toEqual([
      { method: 'PROPFIND', live: true },
      { method: 'DELETE', live: true }
    ])
  })
  it('checks saved-account authorization at every request boundary without disguising an unsent write as submitted', async () => {
    const request = vi.fn<typeof requestOnce>(async () => response(201)),
      transport = createRemoteBackupTransport(request)
    await expect(
      transport.upload(webdav, Buffer.from('envelope'), signal(), async () => {
        throw new Error('PRIVATE-account-token')
      })
    ).rejects.toThrow('尚未发送')
    expect(request).not.toHaveBeenCalled()
    let active = true
    request.mockImplementationOnce(async () => {
      active = false
      return response(201)
    })
    expect(
      await transport.upload(webdav, Buffer.from('envelope'), signal(), async () => {
        if (!active) throw new Error('PRIVATE-account-token')
      })
    ).toMatchObject({ status: 'uncertain' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][1].method).toBe('PUT')
  })
  it('never sends a readback after account authorization expires while awaiting the guard', async () => {
    const entered = Promise.withResolvers<void>(),
      guard = Promise.withResolvers<void>()
    let checks = 0
    const controller = new AbortController(),
      request = vi.fn<typeof requestOnce>(async () => response(201)),
      transport = createRemoteBackupTransport(request)
    const pending = transport.upload(
      webdav,
      Buffer.from('envelope'),
      controller.signal,
      async () => {
        if (++checks === 2) {
          entered.resolve()
          await guard.promise
        }
      }
    )
    await entered.promise
    controller.abort()
    guard.resolve()
    expect(await pending).toMatchObject({ status: 'uncertain' })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('accepts only a bounded authenticated Gist list request without archive keys or arbitrary endpoints', () => {
    const input = { provider: 'gist', action: 'list', token: 'fixture-token', proxyPort: 17891 }
    expect(remoteBackupRequest(input)).toMatchObject({ ...input, page: 1 })
    expect(remoteBackupEndpoint(remoteBackupRequest(input))).toBe(
      'https://api.github.com/gists?per_page=100&page=1'
    )
    for (const changed of [
      { provider: 'webdav' },
      { page: 0 },
      { page: 1001 },
      { page: '1' },
      { secretKey: 'PRIVATE' },
      { recipient: 'PRIVATE' },
      { gistId: 'abcde' },
      { url: 'https://foreign.invalid' }
    ])
      expect(() => remoteBackupRequest({ ...input, ...changed })).toThrow()
  })
  it('lists one fixed page as unverified metadata without fetching raw URLs or leaking unrelated Gist data', async () => {
    const input = remoteBackupRequest({
      provider: 'gist',
      action: 'list',
      token: 'fixture-token',
      proxyPort: 17891,
      page: 2
    })
    const row = {
      id: 'a'.repeat(32),
      public: false,
      truncated: false,
      updated_at: '2026-10-28T12:00:00Z',
      description: 'PRIVATE_DESCRIPTION',
      files: {
        'relay-backup.json': {
          filename: 'relay-backup.json',
          size: 1024,
          raw_url: 'https://foreign.invalid/PRIVATE'
        }
      }
    }
    const payload = [
      row,
      { ...row, id: 'b'.repeat(32), public: true },
      { ...row, id: 'c'.repeat(32), truncated: true },
      { ...row, id: 'd'.repeat(32), files: { unrelated: { size: 1 } } }
    ]
    const request = vi.fn<typeof requestOnce>().mockResolvedValue({
      ...response(200, Buffer.from(JSON.stringify(payload))),
      headers: { link: '<https://foreign.invalid/never-followed>; rel="next"' }
    })
    const result = await createRemoteBackupTransport(request).list(input, signal())
    expect(result).toEqual({
      page: 2,
      nextPage: 3,
      scanned: 4,
      entries: [{ id: row.id, updatedAt: row.updated_at, envelopeBytes: 1024, verified: false }]
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'https://api.github.com/gists?per_page=100&page=2',
      expect.objectContaining({
        method: 'GET',
        proxy: { host: '127.0.0.1', port: 17891 },
        headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }),
        maxBytes: 2 * 1024 * 1024,
        captureRedirects: true
      })
    )
  })
  it('refuses oversized, duplicate or cancelled list results and never follows redirects', async () => {
    const input = remoteBackupRequest({
      provider: 'gist',
      action: 'list',
      token: 'fixture-token',
      proxyPort: 17891
    })
    const row = {
      id: 'a'.repeat(32),
      public: false,
      updated_at: '2026-10-28T12:00:00Z',
      files: { 'relay-backup.json': { filename: 'relay-backup.json', size: 1 } }
    }
    for (const body of [Array(101).fill({}), [row, row], {}]) {
      const request = vi
        .fn<typeof requestOnce>()
        .mockResolvedValue(response(200, Buffer.from(JSON.stringify(body))))
      await expect(createRemoteBackupTransport(request).list(input, signal())).rejects.toThrow()
      expect(request).toHaveBeenCalledTimes(1)
    }
    const request = vi
      .fn<typeof requestOnce>()
      .mockResolvedValue({ ...response(302), headers: { location: 'https://foreign.invalid' } })
    await expect(createRemoteBackupTransport(request).list(input, signal())).rejects.toThrow(
      '重定向'
    )
    expect(request).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    controller.abort()
    request.mockResolvedValue(response(200, Buffer.from('[]')))
    await expect(
      createRemoteBackupTransport(request).list(input, controller.signal)
    ).rejects.toThrow()
  })
  it('requires a fixed HTTPS file and rejects query credentials, foreign fields and unencrypted Gist uploads', () => {
    expect(remoteBackupRequest(webdav)).toEqual(webdav)
    for (const bad of [
      { ...webdav, url: 'http://dav.example/file' },
      { ...webdav, url: 'https://user:pass@dav.example/file' },
      { ...webdav, url: 'https://dav.example/file?token=secret' },
      { ...webdav, url: 'https://dav.example/folder/' },
      { ...webdav, localPath: '/tmp/file' },
      { ...webdav, proxyPort: 0 },
      { provider: 'gist', action: 'upload', token: 'fixture-token', proxyPort: 17891 }
    ])
      expect(() => remoteBackupRequest(bad)).toThrow()
    const raw = { ...webdav, url: 'https://DAV.example/Relay/file' }
    expect(remoteBackupRequest(raw).url).toBe('https://dav.example/Relay/file')
    expect(raw.url).toBe('https://DAV.example/Relay/file')
  })
  it('round-trips canonical Base64 and real AGE encrypted ZIP bytes with archive and payload digests', async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 7])
    expect(await decodeRemoteArchive(await encodeRemoteArchive(bytes))).toEqual(bytes)
    const keys = await generateAgeKeyPair()
    const encrypted = await encodeRemoteArchive(bytes, keys.recipient)
    expect(encrypted.toString()).not.toContain(bytes.toString('base64'))
    expect(await decodeRemoteArchive(encrypted, keys.secretKey, true)).toEqual(bytes)
    await expect(decodeRemoteArchive(encrypted, undefined, true)).rejects.toThrow('解密失败')
    await expect(
      decodeRemoteArchive(await encodeRemoteArchive(bytes), undefined, true)
    ).rejects.toThrow('元数据')
    const changed = JSON.parse((await encodeRemoteArchive(bytes)).toString())
    changed.archiveSHA256 = '0'.repeat(64)
    await expect(decodeRemoteArchive(Buffer.from(JSON.stringify(changed)))).rejects.toThrow(
      '完整性'
    )
    changed.archiveBytes = 999999999
    await expect(decodeRemoteArchive(Buffer.from(JSON.stringify(changed)))).rejects.toThrow(
      '元数据'
    )
  })
  it('uploads only the exact WebDAV file with new-only precondition and reads the same file back', async () => {
    const envelope = await encodeRemoteArchive(Buffer.from('archive'))
    const request = vi
      .fn<typeof requestOnce>()
      .mockResolvedValueOnce(response(201))
      .mockResolvedValueOnce(response(200, envelope))
    const transport = createRemoteBackupTransport(request)
    expect(await transport.upload(webdav, envelope, signal())).toEqual({
      status: 'uploaded',
      gistId: undefined
    })
    expect(request.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      [webdav.url, 'PUT'],
      [webdav.url, 'GET']
    ])
    expect(request.mock.calls[0][1]).toMatchObject({
      body: envelope,
      headers: { 'If-None-Match': '*', Authorization: expect.stringMatching(/^Basic /u) },
      binary: true,
      captureRedirects: true,
      proxy: { host: '127.0.0.1', port: 17891 }
    })
  })
  it('does not retry a refused or uncertain write and never redirects credentials', async () => {
    const envelope = await encodeRemoteArchive(Buffer.from('archive'))
    for (const status of [412, 204, 302]) {
      const request = vi.fn<typeof requestOnce>().mockResolvedValueOnce({
        ...response(status),
        headers: { location: 'https://foreign.example/file' }
      })
      expect(
        (await createRemoteBackupTransport(request).upload(webdav, envelope, signal())).status
      ).toBe('uncertain')
      expect(request).toHaveBeenCalledTimes(1)
    }
    const request = vi.fn<typeof requestOnce>().mockResolvedValueOnce(response(302))
    await expect(
      createRemoteBackupTransport(request).download({ ...webdav, action: 'download' }, signal())
    ).rejects.toThrow('重定向')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('creates a new non-public Gist containing one encrypted envelope and verifies its fixed API ID', async () => {
    const keys = await generateAgeKeyPair()
    const envelope = await encodeRemoteArchive(Buffer.from('archive'), keys.recipient)
    const request = vi
      .fn<typeof requestOnce>()
      .mockResolvedValueOnce(response(201, gist(envelope)))
      .mockResolvedValueOnce(response(200, gist(envelope)))
    const input = remoteBackupRequest({
      provider: 'gist',
      action: 'upload',
      token: 'fixture-token',
      recipient: keys.recipient,
      proxyPort: 17891
    })
    expect(await createRemoteBackupTransport(request).upload(input, envelope, signal())).toEqual({
      status: 'uploaded',
      gistId: 'a'.repeat(32)
    })
    const post = JSON.parse(String(request.mock.calls[0][1].body))
    expect(post.public).toBe(false)
    expect(Object.keys(post.files)).toEqual(['relay-backup.json'])
    expect(post.files['relay-backup.json'].content).toBe(envelope.toString())
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      'https://api.github.com/gists',
      `https://api.github.com/gists/${'a'.repeat(32)}`
    ])
    expect(request.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer fixture-token'
    })
  })
  it('rejects public/truncated/foreign-ID Gists and never requests raw_url', async () => {
    const keys = await generateAgeKeyPair()
    const envelope = await encodeRemoteArchive(Buffer.from('archive'), keys.recipient)
    const input = remoteBackupRequest({
      provider: 'gist',
      action: 'download',
      token: 'fixture-token',
      gistId: 'a'.repeat(32),
      secretKey: keys.secretKey,
      proxyPort: 17891
    })
    for (const overrides of [
      { public: true },
      { truncated: true },
      { id: 'b'.repeat(32) },
      {
        files: {
          'relay-backup.json': {
            content: envelope.toString(),
            truncated: true,
            raw_url: 'https://foreign.example/'
          }
        }
      }
    ]) {
      const request = vi
        .fn<typeof requestOnce>()
        .mockResolvedValueOnce(response(200, gist(envelope, overrides)))
      await expect(createRemoteBackupTransport(request).download(input, signal())).rejects.toThrow()
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0][0]).toBe(`https://api.github.com/gists/${'a'.repeat(32)}`)
    }
    const request = vi.fn<typeof requestOnce>().mockResolvedValueOnce(response(200, gist(envelope)))
    expect(await createRemoteBackupTransport(request).download(input, signal())).toEqual(
      Buffer.from('archive')
    )
  })
  it('refuses disabled TLS verification before sending any credentials', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    const request = vi.fn<typeof requestOnce>()
    await expect(
      createRemoteBackupTransport(request).download({ ...webdav, action: 'download' }, signal())
    ).rejects.toThrow('TLS')
    expect(request).not.toHaveBeenCalled()
  })
  it('sends PUT binary bytes and an exact Content-Length through the shared low-level transport', async () => {
    const bytes = Buffer.from([0, 255, 128, 10])
    const observed: { method?: string; length?: string; bytes?: Buffer } = {}
    const server = createServer(async (request, reply) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      observed.method = request.method
      observed.length = request.headers['content-length']
      observed.bytes = Buffer.concat(chunks)
      reply.writeHead(201)
      reply.end(bytes)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture listener missing')
      const result = await requestOnce(`http://127.0.0.1:${address.port}/fixed`, {
        method: 'PUT',
        body: bytes,
        timeout: 3000,
        maxBytes: 16,
        binary: true
      })
      expect(result.bytes).toEqual(bytes)
      expect(observed).toEqual({ method: 'PUT', length: '4', bytes })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
