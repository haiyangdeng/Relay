import { createServer } from 'http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isStrongBackupETag, remoteBackupRequest } from '../../../shared/relay/backup-remote'
import { requestOnce } from '../../resolve/plugin/http-client'
import { createRemoteBackupTransport } from './remote'
import { createRemoteBackupService } from './remote-service'
import { parseWebdavListing } from './webdav-list'
import { RelayBackupStore } from './store'

const input = {
  provider: 'webdav' as const,
  action: 'delete' as const,
  url: 'https://dav.example/Relay/a.json',
  username: 'fixture',
  password: 'private-fixture',
  proxyPort: 17891,
  etag: '"version-1"'
}
const metadata = (etag = '&quot;version-1&quot;', type = '<d:resourcetype/>'): Buffer =>
  Buffer.from(
    `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/Relay/a.json</d:href><d:propstat><d:prop>${type}<d:getcontentlength>123</d:getcontentlength><d:getetag>${etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
  )
const response = (status: number, bytes = Buffer.alloc(0)) => ({
  status,
  bytes,
  body: '',
  headers: {}
})
const signal = (): AbortSignal => new AbortController().signal
const store = (): RelayBackupStore =>
  new RelayBackupStore({
    home: '/private/tmp/relay-delete-not-read',
    stateRoot: '/private/tmp/relay-delete-not-read/Library/Application Support/Relay'
  })
afterEach(() => vi.unstubAllEnvs())

describe('Explicit WebDAV file deletion with strong preconditions', () => {
  it('requires exactly one bounded strong tag and a fixed HTTPS JSON or ZIP file, without archive keys', () => {
    expect(remoteBackupRequest(input)).toEqual(input)
    for (const etag of [
      '*',
      'W/"a"',
      '"a", "b"',
      'unquoted',
      '"embedded"quote"',
      '"white space"',
      `"${'x'.repeat(256)}"`
    ]) {
      expect(isStrongBackupETag(etag)).toBe(false)
      expect(() => remoteBackupRequest({ ...input, etag })).toThrow()
    }
    for (const change of [
      { url: 'https://dav.example/Relay/' },
      { url: 'https://dav.example/Relay/file.txt' },
      { provider: 'gist' },
      { secretKey: 'PRIVATE' },
      { recipient: 'PRIVATE' },
      { page: 1 }
    ])
      expect(() => remoteBackupRequest({ ...input, ...change })).toThrow()
  })
  it('returns strong listing tags without permitting weak validators to enable deletion', async () => {
    const strong = await parseWebdavListing(metadata(), 'https://dav.example/Relay/')
    expect(strong.entries[0].etag).toBe(input.etag)
    expect(
      (await parseWebdavListing(metadata('W/&quot;version-1&quot;'), 'https://dav.example/Relay/'))
        .entries[0].etag
    ).toBeUndefined()
  })
  it('verifies ordinary-file metadata, sends one conditional DELETE and confirms absence at the same URL', async () => {
    const send = vi
      .fn<typeof requestOnce>()
      .mockResolvedValueOnce(response(207, metadata()))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(404))
    expect(await createRemoteBackupTransport(send).delete(input, signal())).toEqual({
      status: 'deleted'
    })
    expect(send.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      [input.url, 'PROPFIND'],
      [input.url, 'DELETE'],
      [input.url, 'HEAD']
    ])
    expect(send.mock.calls[0][1].headers).toMatchObject({ Depth: '0' })
    expect(send.mock.calls[1][1]).toMatchObject({
      headers: { 'If-Match': input.etag },
      proxy: { host: '127.0.0.1', port: 17891 },
      captureRedirects: true,
      maxBytes: 65536
    })
    expect(send.mock.calls.every(([, options]) => options.method !== 'GET')).toBe(true)
  })
  it('refuses changed or missing tags, ambiguous metadata and disguised collections before DELETE', async () => {
    for (const before of [
      response(404),
      response(207, metadata('&quot;version-2&quot;')),
      response(207, metadata('')),
      response(207, metadata(undefined, '<d:resourcetype><d:collection/></d:resourcetype>'))
    ]) {
      const send = vi.fn<typeof requestOnce>().mockResolvedValueOnce(before)
      expect(await createRemoteBackupTransport(send).delete(input, signal())).toEqual({
        status: 'conflict'
      })
      expect(send).toHaveBeenCalledTimes(1)
    }
    const send = vi
      .fn<typeof requestOnce>()
      .mockResolvedValueOnce(response(207, Buffer.from('<invalid/>')))
    await expect(createRemoteBackupTransport(send).delete(input, signal())).rejects.toThrow(
      '尚未发送'
    )
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('reports conditional conflicts and uncertain post-submit results without retrying or following redirects', async () => {
    const conflict = vi
      .fn<typeof requestOnce>()
      .mockResolvedValueOnce(response(207, metadata()))
      .mockResolvedValueOnce(response(412))
    expect(await createRemoteBackupTransport(conflict).delete(input, signal())).toEqual({
      status: 'conflict'
    })
    expect(conflict).toHaveBeenCalledTimes(2)
    for (const status of [200, 401, 500]) {
      const send = vi
        .fn<typeof requestOnce>()
        .mockResolvedValueOnce(response(207, metadata()))
        .mockResolvedValueOnce(response(204))
        .mockResolvedValueOnce(response(status))
      expect(await createRemoteBackupTransport(send).delete(input, signal())).toEqual({
        status: 'uncertain'
      })
      expect(send).toHaveBeenCalledTimes(3)
    }
    const failed = vi
      .fn<typeof requestOnce>()
      .mockResolvedValueOnce(response(207, metadata()))
      .mockRejectedValueOnce(new Error('lost response'))
    expect(await createRemoteBackupTransport(failed).delete(input, signal())).toEqual({
      status: 'uncertain'
    })
    expect(failed).toHaveBeenCalledTimes(2)
    const redirected = vi
      .fn<typeof requestOnce>()
      .mockResolvedValueOnce(response(207, metadata()))
      .mockResolvedValueOnce({
        ...response(302),
        headers: { location: 'https://foreign.invalid/' }
      })
    expect(await createRemoteBackupTransport(redirected).delete(input, signal())).toEqual({
      status: 'uncertain'
    })
    expect(redirected).toHaveBeenCalledTimes(2)
  })
  it('cancels before submission, keeps late cancellation uncertain and refuses TLS-disabled transfers', async () => {
    const controller = new AbortController()
    const send = vi.fn<typeof requestOnce>().mockImplementationOnce(async () => {
      controller.abort()
      return response(207, metadata())
    })
    expect(await createRemoteBackupTransport(send).delete(input, controller.signal)).toEqual({
      status: 'cancelled'
    })
    expect(send).toHaveBeenCalledTimes(1)
    const late = new AbortController()
    const submitted = vi
      .fn<typeof requestOnce>()
      .mockResolvedValueOnce(response(207, metadata()))
      .mockImplementationOnce(async () => {
        late.abort()
        throw new Error('aborted after send')
      })
    expect(await createRemoteBackupTransport(submitted).delete(input, late.signal)).toEqual({
      status: 'uncertain'
    })
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    const disabled = vi.fn<typeof requestOnce>()
    await expect(createRemoteBackupTransport(disabled).delete(input, signal())).rejects.toThrow(
      '尚未发送'
    )
    expect(disabled).not.toHaveBeenCalled()
  })
  it('binds consent and expiry to the file and tag without reading an archive or preparing a restore', async () => {
    const source = store(),
      archive = vi.spyOn(source, 'archive'),
      stage = vi.fn()
    const remove = vi.fn(async () => ({ status: 'deleted' as const })),
      confirm = vi.fn(async () => false)
    let clock = 1
    const service = createRemoteBackupService({
      store: source,
      prepareArchive: stage,
      assertIdle: () => {},
      confirmTransfer: confirm,
      now: () => clock,
      transport: { delete: remove, download: vi.fn(), upload: vi.fn() }
    })
    const first = await service.prepare(input)
    expect(first).toMatchObject({
      endpoint: input.url,
      etag: input.etag,
      containsSecrets: false,
      encrypted: false
    })
    expect(JSON.stringify(first)).not.toContain('private-fixture')
    expect(remove).not.toHaveBeenCalled()
    expect(await service.execute({ evidenceId: first.evidenceId })).toEqual({ status: 'cancelled' })
    const second = await service.prepare(input)
    confirm.mockImplementationOnce(async () => {
      clock += 60001
      return true
    })
    await expect(service.execute({ evidenceId: second.evidenceId })).rejects.toThrow('过期')
    expect(remove).not.toHaveBeenCalled()
    const third = await service.prepare(input)
    confirm.mockResolvedValueOnce(true)
    expect(await service.execute({ evidenceId: third.evidenceId })).toEqual({ status: 'deleted' })
    expect(remove).toHaveBeenCalledWith(input, expect.any(AbortSignal))
    expect(archive).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
    await expect(service.execute({ evidenceId: third.evidenceId })).rejects.toThrow('失效')
  })
  it('waits for a cancelled in-flight conditional delete and reports its actual transport result', async () => {
    const submitted = Promise.withResolvers<void>(),
      finished = Promise.withResolvers<void>()
    const service = createRemoteBackupService({
      store: store(),
      prepareArchive: vi.fn(),
      assertIdle: () => {},
      confirmTransfer: async () => true,
      transport: {
        download: vi.fn(),
        upload: vi.fn(),
        delete: async (_input, signal) => {
          submitted.resolve()
          await finished.promise
          expect(signal.aborted).toBe(true)
          return { status: 'uncertain' }
        }
      }
    })
    const plan = await service.prepare(input),
      pending = service.execute({ evidenceId: plan.evidenceId })
    await submitted.promise
    service.cancel()
    expect(service.isBusy()).toBe(true)
    await expect(service.prepare(input)).rejects.toThrow('等待')
    let idle = false
    const waiting = service.whenIdle().then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)
    finished.resolve()
    expect(await pending).toEqual({ status: 'uncertain' })
    await waiting
    expect(idle).toBe(true)
  })
  it('deletes only the versioned fixture resource over actual owned loopback HTTP', async () => {
    const calls: string[] = []
    let exists = true
    const files = new Map([
      ['/Relay/a.json', 'delete-this-fixture'],
      ['/Relay/other.json', 'keep-other-file']
    ])
    const server = createServer((incoming, outgoing) => {
      calls.push(incoming.method ?? '')
      expect(incoming.url).toBe('/Relay/a.json')
      if (incoming.method === 'PROPFIND') {
        expect(incoming.headers.depth).toBe('0')
        outgoing.writeHead(207)
        outgoing.end(metadata())
      } else if (incoming.method === 'DELETE') {
        expect(incoming.headers['if-match']).toBe(input.etag)
        exists = false
        files.delete(incoming.url ?? '')
        outgoing.writeHead(204)
        outgoing.end()
      } else {
        outgoing.writeHead(exists ? 200 : 404)
        outgoing.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture address missing')
    try {
      const transport = createRemoteBackupTransport((_url, options) =>
        requestOnce(`http://127.0.0.1:${address.port}/Relay/a.json`, {
          ...options,
          proxy: undefined
        })
      )
      expect(await transport.delete(input, signal())).toEqual({ status: 'deleted' })
      expect(calls).toEqual(['PROPFIND', 'DELETE', 'HEAD'])
      expect(exists).toBe(false)
      expect([...files.entries()]).toEqual([['/Relay/other.json', 'keep-other-file']])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
