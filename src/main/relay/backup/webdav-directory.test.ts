import { createServer } from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestOnce } from '../../resolve/plugin/http-client'
import { webdavDirectoryEvidence } from '../../../shared/relay/backup-directory'
import { backupAccountsFixture, webdavAccount, gistAccount } from './accounts.test-fixture'
import { createWebdavDirectoryService, parseWebdavCollection } from './webdav-directory'

const collection = (url: string, content = '<d:collection/>', namespace = 'DAV:'): Buffer =>
  Buffer.from(
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${url}</d:href><d:propstat><d:prop><d:resourcetype xmlns:x="${namespace}">${content}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
  )
const response = (status: number, bytes = Buffer.alloc(0)) => ({
  status,
  body: '',
  headers: {},
  bytes
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type AccountsFixture = Parameters<Parameters<typeof backupAccountsFixture>[0]>[0]
async function setup(f: AccountsFixture) {
  const account = await f.store.save({ ...webdavAccount, password: '中文:秘密' })
  if (!account.directoryURL) throw new Error('fixture directory missing')
  const directoryURL = account.directoryURL,
    parentURL = new URL('..', directoryURL).href,
    request = vi.fn<typeof requestOnce>(async (url, options) =>
      options.method === 'MKCOL' ? response(201) : response(207, collection(url))
    ),
    confirm = vi.fn(async () => true),
    assertIdle = vi.fn(),
    service = createWebdavDirectoryService({ accounts: f.store, confirm, assertIdle, request })
  const prepare = (recheck?: () => void) =>
    service.prepare({ id: account.id, revision: account.revision }, recheck)
  const execute = async (recheck?: () => void) =>
    service.execute({ evidenceId: (await prepare(recheck)).evidenceId })
  return {
    account,
    directoryURL,
    parentURL,
    request,
    confirm,
    assertIdle,
    service,
    prepare,
    execute
  }
}
async function fixture(
  run: (f: AccountsFixture & Awaited<ReturnType<typeof setup>>) => Promise<void>
): Promise<void> {
  await backupAccountsFixture(async (f) => {
    const api = await setup(f)
    try {
      await run({ ...f, ...api })
    } finally {
      await api.service.requestClose()
    }
  })
}

describe('Single explicitly confirmed WebDAV last-layer directory creation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  it('prepares only public account-bound scope without decrypting, contacting a server or accepting renderer paths', async () => {
    await fixture(async (f) => {
      f.crypto.decrypt.mockClear()
      const plan = await f.prepare()
      expect(plan).toMatchObject({
        provider: 'webdav',
        action: 'createDirectory',
        id: f.account.id,
        revision: f.account.revision,
        directoryURL: f.directoryURL,
        parentURL: f.parentURL,
        username: '用户',
        proxyPort: 17891,
        usesCredential: true,
        parentMustExist: true,
        recursive: false,
        overwrite: false,
        expiresAt: Date.now() + 60000
      })
      expect(JSON.stringify(plan)).not.toMatch(/password|中文:秘密|secret/u)
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
      await expect(
        f.service.prepare({ id: f.account.id, revision: f.account.revision, url: f.parentURL })
      ).rejects.toThrow()
      expect(() =>
        webdavDirectoryEvidence({ evidenceId: plan.evidenceId, url: f.directoryURL })
      ).toThrow()
      expect(() => webdavDirectoryEvidence({ evidenceId: new String(plan.evidenceId) })).toThrow()
    })
  })
  it('consumes proof with default cancellation and rejects expired consent before decrypting', async () => {
    await fixture(async (f) => {
      f.confirm.mockResolvedValue(false)
      f.crypto.decrypt.mockClear()
      const plan = await f.prepare()
      await expect(f.service.execute({ evidenceId: plan.evidenceId })).resolves.toEqual({
        status: 'cancelled',
        submitted: false
      })
      await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('失效')
      f.confirm.mockResolvedValue(true)
      const expired = await f.prepare()
      vi.setSystemTime(Date.now() + 60000)
      expect(await f.service.execute({ evidenceId: expired.evidenceId })).toMatchObject({
        status: 'rejected'
      })
      expect(f.crypto.decrypt).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('creates only the selected last layer after checking its exact existing parent, with UTF-8 Basic and a single empty MKCOL', async () => {
    await fixture(async (f) => {
      const result = await f.execute()
      expect(result).toEqual({
        status: 'created',
        directoryURL: f.directoryURL,
        verifiedAt: Date.now()
      })
      expect(f.request.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
        [f.parentURL, 'PROPFIND'],
        [f.directoryURL, 'MKCOL'],
        [f.directoryURL, 'PROPFIND']
      ])
      for (const [, options] of f.request.mock.calls) {
        expect(options.proxy).toEqual({ host: '127.0.0.1', port: 17891 })
        expect(options.headers?.Authorization).toBe(
          'Basic ' + Buffer.from('用户:中文:秘密', 'utf8').toString('base64')
        )
        expect(options).toMatchObject({ captureRedirects: true, binary: true, maxBytes: 64 * 1024 })
        if (options.method === 'PROPFIND') expect(options.headers?.Depth).toBe('0')
        else {
          expect(options.body).toBeUndefined()
          expect(options.headers?.Depth).toBeUndefined()
          expect(options.headers?.['Content-Type']).toBeUndefined()
        }
      }
      expect(f.service.isBusy()).toBe(false)
      expect(JSON.stringify(result)).not.toMatch(/secret|password|中文/u)
    })
  })
  it('recognizes DAV collection namespaces, not matching local names or nested foreign markers', () => {
    const endpoint = 'https://backup.example.test/relay/'
    expect(parseWebdavCollection(collection(endpoint), endpoint)).toBe(true)
    expect(parseWebdavCollection(collection(endpoint, '<x:collection/>', 'DAV:'), endpoint)).toBe(
      true
    )
    expect(
      parseWebdavCollection(collection(endpoint, '<x:collection/>', 'urn:foreign'), endpoint)
    ).toBe(false)
    expect(parseWebdavCollection(collection(endpoint, ''), endpoint)).toBe(false)
    expect(
      parseWebdavCollection(
        collection(endpoint, '<x:wrapper><d:collection/></x:wrapper>', 'urn:foreign'),
        endpoint
      )
    ).toBe(false)
    const defaults = collection(endpoint)
      .toString()
      .replaceAll('d:', '')
      .replace('xmlns:d=', 'xmlns=')
    expect(parseWebdavCollection(Buffer.from(defaults), endpoint)).toBe(true)
    for (const bytes of [
      collection('https://foreign.example.test/relay/'),
      collection(endpoint + 'child/'),
      Buffer.from(
        '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///private/fake">]>' + collection(endpoint)
      ),
      Buffer.from([0xff, 0xfe]),
      Buffer.alloc(64 * 1024 + 1),
      Buffer.from(
        collection(endpoint)
          .toString()
          .replace('</d:multistatus>', collection(endpoint).toString() + '</d:multistatus>')
      )
    ])
      expect(() => parseWebdavCollection(bytes, endpoint)).toThrow()
  })
  it('sends real Depth 0 PROPFIND and an empty MKCOL over a private loopback fixture', async () => {
    await fixture(async (f) => {
      const received: Array<{ method?: string; path?: string; depth?: string; bytes: number }> = [],
        server = createServer(async (incoming, outgoing) => {
          const chunks: Buffer[] = []
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
          received.push({
            method: incoming.method,
            path: incoming.url,
            depth: typeof incoming.headers.depth === 'string' ? incoming.headers.depth : undefined,
            bytes: Buffer.concat(chunks).length
          })
          if (incoming.method === 'MKCOL') {
            outgoing.writeHead(201)
            outgoing.end()
          } else {
            outgoing.writeHead(207, { 'Content-Type': 'application/xml' })
            outgoing.end(collection(new URL(incoming.url ?? '/', f.directoryURL).href))
          }
        })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture address missing')
      try {
        // Only this injected fixture maps the already-validated HTTPS scope to
        // its owned loopback server. Production has no direct HTTP fallback.
        f.request.mockImplementation((url, options) =>
          requestOnce(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, {
            ...options,
            proxy: undefined
          })
        )
        expect(await f.execute()).toMatchObject({ status: 'created' })
        expect(received.map(({ method, path, depth }) => ({ method, path, depth }))).toEqual([
          { method: 'PROPFIND', path: '/', depth: '0' },
          { method: 'MKCOL', path: '/relay/', depth: undefined },
          { method: 'PROPFIND', path: '/relay/', depth: '0' }
        ])
        expect(received[1].bytes).toBe(0)
        expect(received[0].bytes).toBeGreaterThan(0)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })
  it.each([
    ['missing', 404, undefined, 'parentMissing'],
    ['forbidden', 403, undefined, 'forbidden'],
    ['file', 207, '', 'parentNotCollection'],
    ['foreign collection', 207, '<x:collection/>', 'parentNotCollection']
  ] as const)('does not send MKCOL when the parent is %s', async (_, status, type, reason) => {
    await fixture(async (f) => {
      f.request.mockImplementation(async (url) =>
        response(status, collection(url, type, 'urn:foreign'))
      )
      expect(await f.execute()).toMatchObject({ status: 'rejected', reason })
      expect(f.request).toHaveBeenCalledTimes(1)
      expect(f.request.mock.calls[0][0]).toBe(f.parentURL)
    })
  })
  it('treats 405 as already existing only after Depth 0 confirms that exact resource is a collection', async () => {
    await fixture(async (f) => {
      f.request.mockImplementation(async (url, options) =>
        options.method === 'MKCOL' ? response(405) : response(207, collection(url))
      )
      expect(await f.execute()).toMatchObject({ status: 'alreadyExists' })
      f.request.mockClear()
      f.request.mockImplementation(async (url, options) =>
        options.method === 'MKCOL'
          ? response(405)
          : response(207, collection(url, url === f.directoryURL ? '' : '<d:collection/>'))
      )
      expect(await f.execute()).toMatchObject({ status: 'conflict', reason: 'targetNotCollection' })
      expect(f.request.mock.calls.filter(([, o]) => o.method === 'MKCOL')).toHaveLength(1)
    })
  })
  it.each([
    [403, 'forbidden'],
    [409, 'parentMissing']
  ] as const)(
    'returns a definite %s rejection without swallowing it, creating parents or retrying',
    async (status, reason) => {
      await fixture(async (f) => {
        f.request.mockImplementation(async (url, options) =>
          options.method === 'MKCOL' ? response(status) : response(207, collection(url))
        )
        expect(await f.execute()).toMatchObject({ status: 'rejected', reason, httpStatus: status })
        expect(f.request).toHaveBeenCalledTimes(2)
      })
    }
  )
  it.each(['server', 'timeout', 'readback', 'malformed readback', 'redirect'] as const)(
    'retains submitted uncertainty after %s without automatic retry or deletion',
    async (failure) => {
      await fixture(async (f) => {
        let submitted = false
        f.request.mockImplementation(async (url, options) => {
          if (options.method === 'MKCOL') {
            submitted = true
            if (failure === 'timeout') throw new Error('untrusted secret response')
            return response(failure === 'server' ? 503 : failure === 'redirect' ? 302 : 201)
          }
          return submitted
            ? failure === 'readback'
              ? response(404)
              : response(207, Buffer.from('<bad/>'))
            : response(207, collection(url))
        })
        const plan = await f.prepare(),
          result = await f.service.execute({ evidenceId: plan.evidenceId })
        expect(result).toMatchObject({ status: 'uncertain', directoryURL: f.directoryURL })
        expect(JSON.stringify(result)).not.toMatch(/secret/u)
        expect(f.request.mock.calls.filter(([, o]) => o.method === 'MKCOL')).toHaveLength(1)
        await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('失效')
        expect(
          f.request.mock.calls.every(([, o]) => o.method === 'PROPFIND' || o.method === 'MKCOL')
        ).toBe(true)
      })
    }
  )
  it('invalidates account changes during native consent before decrypt or wire', async () => {
    await fixture(async (f) => {
      f.confirm.mockImplementation(async () => {
        await f.store.save({
          ...webdavAccount,
          id: f.account.id,
          revision: f.account.revision,
          name: 'changed'
        })
        return true
      })
      f.crypto.decrypt.mockClear()
      expect(await f.execute()).toMatchObject({ status: 'rejected' })
      // Saving can decrypt the old binding. The operation itself never requests a credential.
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('checks private renderer liveness after a held credential without needing a hide event', async () => {
    await fixture(async (f) => {
      let live = true
      const entered = deferred(),
        release = deferred(),
        readCredential = f.store.credential.bind(f.store)
      vi.spyOn(f.store, 'credential').mockImplementation(async (selected) => {
        entered.resolve()
        await release.promise
        return readCredential(selected)
      })
      const result = f.execute(() => {
        if (!live) throw new Error('renderer lost')
      })
      await entered.promise
      live = false
      release.resolve()
      expect(await result).toMatchObject({ status: 'rejected' })
      expect(f.request).not.toHaveBeenCalled()
    })
  })
  it('scopes cancellation to the matching prepared or consumed proof and waits for an entered write before reopening', async () => {
    await fixture(async (f) => {
      const old = await f.prepare(),
        current = await f.prepare()
      expect(f.service.cancel(old.evidenceId)).toBe(false)
      const entered = deferred(),
        release = deferred()
      f.request.mockImplementation(async (url, options) => {
        if (options.method === 'MKCOL') {
          entered.resolve()
          await release.promise
          return response(201)
        }
        return response(207, collection(url))
      })
      const execution = f.service.execute({ evidenceId: current.evidenceId })
      await entered.promise
      expect(f.service.cancel(old.evidenceId)).toBe(false)
      expect(f.service.cancel(current.evidenceId)).toBe(true)
      let idle = false
      const closed = f.service.requestClose().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(idle).toBe(false)
      expect(f.service.isBusy()).toBe(true)
      release.resolve()
      expect(await execution).toMatchObject({ status: 'uncertain' })
      await closed
      expect(idle).toBe(true)
      await expect(f.prepare()).resolves.toMatchObject({ directoryURL: f.directoryURL })
    })
  })
  it('rejects root directories, ambiguous encoded separators and non-WebDAV providers without decrypting', async () => {
    await fixture(async (f) => {
      for (const saved of [
        { ...webdavAccount, directoryURL: 'https://backup.example.test/' },
        { ...webdavAccount, directoryURL: 'https://backup.example.test/encoded%2Fparent/relay/' },
        gistAccount
      ]) {
        const account = await f.store.save(saved)
        f.crypto.decrypt.mockClear()
        await expect(
          f.service.prepare({ id: account.id, revision: account.revision })
        ).rejects.toThrow()
        expect(f.crypto.decrypt).not.toHaveBeenCalled()
      }
      expect(f.request).not.toHaveBeenCalled()
    })
  })
})
