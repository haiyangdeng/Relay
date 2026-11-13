import { createServer } from 'http'
import { describe, expect, it, vi } from 'vitest'
import { remoteBackupRequest } from '../../../shared/relay/backup-remote'
import { requestOnce } from '../../resolve/plugin/http-client'
import { createRemoteBackupTransport } from './remote'
import { parseWebdavListing, WEBDAV_LIST_BODY, WEBDAV_LIST_MAX_BYTES } from './webdav-list'
import { createRemoteBackupService } from './remote-service'
import { RelayBackupStore } from './store'

const request = {
  provider: 'webdav' as const,
  action: 'list' as const,
  url: 'https://dav.example/Relay/',
  username: 'fixture-user',
  password: 'fixture-password',
  proxyPort: 17891
}
const controller = (): AbortController => new AbortController()
const row = (
  href: string,
  props = '<d:resourcetype/><d:getcontentlength>123</d:getcontentlength>',
  status = 'HTTP/1.1 200 OK'
): string =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>${status}</d:status></d:propstat></d:response>`
const xml = (...rows: string[]): Buffer =>
  Buffer.from(`<d:multistatus xmlns:d="DAV:">${rows.join('')}</d:multistatus>`)
const response = (bytes: Buffer, status = 207) => ({ status, bytes, body: '', headers: {} })

describe('WebDAV one-level backup candidate listing', () => {
  it('accepts only an explicit HTTPS collection without archive keys, pagination or renderer-selected paths', () => {
    expect(remoteBackupRequest(request)).toEqual(request)
    for (const change of [
      { url: 'https://dav.example/Relay/file.json' },
      { url: 'http://dav.example/Relay/' },
      { url: 'https://dav.example/Relay/?token=secret' },
      { url: 'https://user:pass@dav.example/Relay/' },
      { page: 1 },
      { recipient: 'age1private' },
      { secretKey: 'PRIVATE' },
      { path: '/tmp/file' }
    ])
      expect(() => remoteBackupRequest({ ...request, ...change })).toThrow()
  })
  it('uses a single bounded PROPFIND via the explicit proxy and exposes only unverified child metadata', async () => {
    const payload = xml(
      row('/Relay/', '<d:resourcetype><d:collection/></d:resourcetype>'),
      row(
        '/Relay/backup%20%E4%B8%AD.json',
        '<d:resourcetype/><d:getcontentlength>123</d:getcontentlength><d:getlastmodified>Wed, 28 Oct 2026 12:00:00 GMT</d:getlastmodified><d:displayname>PRIVATE</d:displayname>'
      ),
      row('/Relay/old.zip'),
      row('/Relay/nested/deep.json'),
      row('/Relay/unrelated.txt'),
      row('/Relay/forbidden.json', undefined, 'HTTP/1.1 403 Forbidden')
    )
    const send = vi.fn<typeof requestOnce>().mockResolvedValue(response(payload))
    const result = await createRemoteBackupTransport(send).list(request, controller().signal)
    expect(result).toEqual({
      directoryURL: request.url,
      scanned: 6,
      entries: [
        {
          url: 'https://dav.example/Relay/backup%20%E4%B8%AD.json',
          name: 'backup 中.json',
          envelopeBytes: 123,
          modifiedAt: '2026-10-28T12:00:00.000Z',
          format: 'relay-envelope',
          verified: false
        },
        {
          url: 'https://dav.example/Relay/old.zip',
          name: 'old.zip',
          envelopeBytes: 123,
          format: 'legacy-zip',
          verified: false
        }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(send).toHaveBeenCalledExactlyOnceWith(
      request.url,
      expect.objectContaining({
        method: 'PROPFIND',
        body: WEBDAV_LIST_BODY,
        headers: expect.objectContaining({
          Depth: '1',
          'Content-Type': 'application/xml; charset=utf-8',
          Authorization: expect.stringMatching(/^Basic /)
        }),
        proxy: { host: '127.0.0.1', port: 17891 },
        maxBytes: WEBDAV_LIST_MAX_BYTES,
        captureRedirects: true
      })
    )
  })
  it('handles an empty collection and default DAV namespaces without treating foreign property namespaces as DAV', async () => {
    expect(
      await parseWebdavListing(Buffer.from('<multistatus xmlns="DAV:"/>'), request.url)
    ).toEqual({ directoryURL: request.url, scanned: 0, entries: [] })
    const body = Buffer.from(
      '<multistatus xmlns="DAV:" xmlns:e="urn:foreign"><response><href>/Relay/a.json</href><propstat><prop><resourcetype/><getcontentlength>1</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response><response><href>/Relay/b.json</href><propstat><prop><e:resourcetype/><e:getcontentlength>1</e:getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>'
    )
    expect(
      (await parseWebdavListing(body, request.url)).entries.map((entry) => entry.name)
    ).toEqual(['a.json'])
  })
  it('rejects foreign or escaped paths, credentials, duplicate resources and unsafe decoded names', async () => {
    for (const href of [
      'https://foreign.invalid/Relay/a.json',
      '/outside/a.json',
      '/Relay/%2fsecret.json',
      '/Relay/%255csecret.json',
      '/Relay/a.json?token=secret',
      'https://user:pass@dav.example/Relay/a.json',
      '/Relay/a%00.json'
    ])
      await expect(parseWebdavListing(xml(row(href)), request.url)).rejects.toThrow()
    await expect(
      parseWebdavListing(xml(row('/Relay/a.json'), row('/Relay/a.json')), request.url)
    ).rejects.toThrow('重复')
  })
  it('rejects entities, response limits, malformed UTF-8 and redirects without following or reading bodies', async () => {
    for (const bytes of [
      Buffer.alloc(WEBDAV_LIST_MAX_BYTES + 1),
      Buffer.from([0xff]),
      Buffer.from('<!DOCTYPE root [<!ENTITY x "private">]><multistatus/>'),
      xml(...Array(1001).fill(row('/Relay/a.json')))
    ])
      await expect(parseWebdavListing(bytes, request.url)).rejects.toThrow()
    const send = vi.fn<typeof requestOnce>().mockResolvedValue({
      ...response(Buffer.alloc(0), 302),
      headers: { location: 'https://foreign.invalid/' }
    })
    await expect(
      createRemoteBackupTransport(send).list(request, controller().signal)
    ).rejects.toThrow('重定向')
    expect(send).toHaveBeenCalledTimes(1)
    const aborted = controller()
    aborted.abort()
    send.mockResolvedValue(response(xml()))
    await expect(createRemoteBackupTransport(send).list(request, aborted.signal)).rejects.toThrow(
      '未确认'
    )
  })
  it('keeps listing behind separate confirmation and cancellation without reading archives or preparing a restore', async () => {
    const store = new RelayBackupStore({
      home: '/private/tmp/relay-list-not-read',
      stateRoot: '/private/tmp/relay-list-not-read/Library/Application Support/Relay'
    })
    const archive = vi.spyOn(store, 'archive'),
      stage = vi.fn(async () => ({ status: 'cancelled' as const }))
    const list = vi.fn(async () => ({ directoryURL: request.url, scanned: 0, entries: [] }))
    const confirm = vi.fn(async () => false)
    const service = createRemoteBackupService({
      store,
      prepareArchive: stage,
      assertIdle: () => {},
      confirmTransfer: confirm,
      transport: { list, upload: vi.fn(), download: vi.fn() }
    })
    const first = await service.prepare(request)
    expect(first).toMatchObject({ containsSecrets: false, encrypted: false, endpoint: request.url })
    expect(JSON.stringify(first)).not.toContain('fixture-password')
    expect(list).not.toHaveBeenCalled()
    expect(await service.execute({ evidenceId: first.evidenceId })).toEqual({ status: 'cancelled' })
    expect(list).not.toHaveBeenCalled()
    const next = await service.prepare(request)
    confirm.mockResolvedValueOnce(true)
    expect(await service.execute({ evidenceId: next.evidenceId })).toMatchObject({
      status: 'listed',
      listing: { directoryURL: request.url }
    })
    expect(archive).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
    const pending = await service.prepare(request)
    service.cancel()
    await expect(service.execute({ evidenceId: pending.evidenceId })).rejects.toThrow('失效')
  })
  it('sends the actual PROPFIND method and XML bytes over an owned loopback fixture', async () => {
    let requests = 0
    const server = createServer(async (incoming, outgoing) => {
      requests++
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      expect(incoming.method).toBe('PROPFIND')
      expect(incoming.headers.depth).toBe('1')
      expect(Buffer.concat(chunks)).toEqual(WEBDAV_LIST_BODY)
      outgoing.writeHead(207, { 'Content-Type': 'application/xml' })
      outgoing.end(xml(row('/Relay/owned.json')))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture address missing')
    try {
      const transport = createRemoteBackupTransport((_url, options) =>
        requestOnce(`http://127.0.0.1:${address.port}/Relay/`, { ...options, proxy: undefined })
      )
      const result = await transport.list(request, controller().signal)
      expect(result.entries).toHaveLength(1)
      expect(requests).toBe(1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
